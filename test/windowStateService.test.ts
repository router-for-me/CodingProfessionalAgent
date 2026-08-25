import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { EventEmitter } from 'node:events'
import {
  WindowStateService,
  isPositionVisible,
  type DisplayBounds,
} from '../src/main/services/windowStateService.js'

class MockBrowserWindow extends EventEmitter {
  private bounds = { x: 100, y: 100, width: 1400, height: 900 }
  private normalBounds = { x: 100, y: 100, width: 1400, height: 900 }
  private maximized = false
  private fullScreen = false
  private destroyed = false

  getBounds() {
    return { ...this.bounds }
  }

  getNormalBounds() {
    return { ...this.normalBounds }
  }

  setBounds(newBounds: Partial<{ x: number; y: number; width: number; height: number }>) {
    this.bounds = { ...this.bounds, ...newBounds }
    if (!this.maximized && !this.fullScreen) {
      this.normalBounds = { ...this.bounds }
    }
  }

  isMaximized() {
    return this.maximized
  }

  isFullScreen() {
    return this.fullScreen
  }

  isDestroyed() {
    return this.destroyed
  }

  maximize() {
    this.maximized = true
    this.bounds = { x: 0, y: 0, width: 1920, height: 1080 }
    this.emit('maximize')
  }

  unmaximize() {
    this.maximized = false
    this.bounds = { ...this.normalBounds }
    this.emit('unmaximize')
  }

  setFullScreen(val: boolean) {
    this.fullScreen = val
    if (val) {
      this.emit('enter-full-screen')
    } else {
      this.emit('leave-full-screen')
    }
  }

  destroy() {
    this.destroyed = true
  }
}

describe('WindowStateService', () => {
  let tempDir: string
  let storeFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-window-state-test-'))
    storeFile = path.join(tempDir, 'ui.json')
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  describe('isPositionVisible', () => {
    const displays: DisplayBounds[] = [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
    ]

    it('returns true when inside primary display', () => {
      const result = isPositionVisible({ x: 100, y: 100, width: 1280, height: 800 }, displays)
      expect(result).toBe(true)
    })

    it('returns true when inside secondary display', () => {
      const result = isPositionVisible({ x: 2000, y: 100, width: 1280, height: 800 }, displays)
      expect(result).toBe(true)
    })

    it('returns false when completely outside all displays', () => {
      const result = isPositionVisible({ x: 5000, y: 5000, width: 1280, height: 800 }, displays)
      expect(result).toBe(false)
    })

    it('returns true when display list is empty (fallback)', () => {
      const result = isPositionVisible({ x: 5000, y: 5000, width: 1280, height: 800 }, [])
      expect(result).toBe(true)
    })
  })

  describe('State loading and defaults', () => {
    it('returns default bounds when state file does not exist', () => {
      const service = new WindowStateService({
        customPath: storeFile,
        defaultWidth: 1280,
        defaultHeight: 800,
        minWidth: 960,
        minHeight: 640,
      })

      const state = service.getState()
      expect(state).toEqual({
        width: 1280,
        height: 800,
        x: undefined,
        y: undefined,
        isMaximized: false,
        isFullScreen: false,
      })
    })

    it('enforces minWidth and minHeight constraints', async () => {
      await fs.writeFile(
        storeFile,
        JSON.stringify({ width: 400, height: 300, x: 50, y: 50 }),
        'utf8',
      )

      const service = new WindowStateService({
        customPath: storeFile,
        defaultWidth: 1280,
        defaultHeight: 800,
        minWidth: 960,
        minHeight: 640,
      })

      const state = service.getState()
      expect(state.width).toBe(1280) // Falls back to default if less than minWidth
      expect(state.height).toBe(800)
    })

    it('clears x and y if position is not visible on current displays', async () => {
      await fs.writeFile(
        storeFile,
        JSON.stringify({ width: 1280, height: 800, x: 4000, y: 4000 }),
        'utf8',
      )

      const service = new WindowStateService({
        customPath: storeFile,
      })

      const singleDisplay: DisplayBounds[] = [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      ]

      const state = service.getState(singleDisplay)
      expect(state.x).toBeUndefined()
      expect(state.y).toBeUndefined()
      expect(state.width).toBe(1280)
      expect(state.height).toBe(800)
    })
  })

  describe('Window management and persistence', () => {
    it('saves updated bounds on resize and move', async () => {
      const service = new WindowStateService({
        customPath: storeFile,
        debounceMs: 10,
      })

      const mockWin = new MockBrowserWindow() as any
      service.manage(mockWin)

      mockWin.setBounds({ x: 200, y: 150, width: 1440, height: 900 })
      mockWin.emit('resize')

      // Wait for debounced save
      await new Promise((resolve) => setTimeout(resolve, 50))

      const reloaded = new WindowStateService({ customPath: storeFile })
      const state = reloaded.getState()
      expect(state.width).toBe(1440)
      expect(state.height).toBe(900)
      expect(state.x).toBe(200)
      expect(state.y).toBe(150)
      expect(state.isMaximized).toBe(false)
    })

    it('preserves normal bounds when window is maximized', async () => {
      const service = new WindowStateService({
        customPath: storeFile,
        debounceMs: 10,
      })

      const mockWin = new MockBrowserWindow() as any
      service.manage(mockWin)

      mockWin.setBounds({ x: 120, y: 80, width: 1300, height: 850 })
      mockWin.emit('resize')

      // Now maximize
      mockWin.maximize()

      // Wait for debounced save
      await new Promise((resolve) => setTimeout(resolve, 50))

      const reloaded = new WindowStateService({ customPath: storeFile })
      const state = reloaded.getState()
      expect(state.width).toBe(1300)
      expect(state.height).toBe(850)
      expect(state.x).toBe(120)
      expect(state.y).toBe(80)
      expect(state.isMaximized).toBe(true)
    })

    it('saves synchronously on close event', async () => {
      const service = new WindowStateService({
        customPath: storeFile,
        debounceMs: 5000, // Long debounce
      })

      const mockWin = new MockBrowserWindow() as any
      service.manage(mockWin)

      mockWin.setBounds({ x: 300, y: 200, width: 1500, height: 950 })
      mockWin.emit('close')

      // Verify file exists immediately without waiting for debounce
      const raw = await fs.readFile(storeFile, 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.width).toBe(1500)
      expect(parsed.height).toBe(950)
      expect(parsed.x).toBe(300)
      expect(parsed.y).toBe(200)
    })

    it('restores maximized state with restore()', async () => {
      await fs.writeFile(
        storeFile,
        JSON.stringify({ width: 1280, height: 800, isMaximized: true }),
        'utf8',
      )

      const service = new WindowStateService({ customPath: storeFile })
      const mockWin = new MockBrowserWindow() as any
      const maximizeSpy = vi.spyOn(mockWin, 'maximize')

      service.restore(mockWin)
      expect(maximizeSpy).toHaveBeenCalled()
    })

    it('disposes and unbinds listeners', () => {
      const service = new WindowStateService({ customPath: storeFile })
      const mockWin = new MockBrowserWindow() as any
      service.manage(mockWin)

      expect(mockWin.listenerCount('resize')).toBeGreaterThan(0)
      service.dispose()
      expect(mockWin.listenerCount('resize')).toBe(0)
    })

    it('defaults store path to ~/.coding-professional-agent/ui.json', () => {
      const service = new WindowStateService({ getHomeDir: () => '/mock-home' })
      const expectedPath = path.join('/mock-home', '.coding-professional-agent', 'ui.json')
      expect((service as unknown as { storePath: string }).storePath).toBe(expectedPath)
    })

    it('preserves non-window UI properties in ui.json when saving window state', async () => {
      await fs.writeFile(
        storeFile,
        JSON.stringify({
          width: 1280,
          height: 800,
          theme: 'light',
          accentColor: '#123456',
          sidebarWidth: 320,
        }),
        'utf8',
      )

      const service = new WindowStateService({
        customPath: storeFile,
        debounceMs: 10,
      })
      const mockWin = new MockBrowserWindow() as any
      service.manage(mockWin)

      mockWin.setBounds({ x: 150, y: 120, width: 1400, height: 900 })
      mockWin.emit('resize')

      await new Promise((resolve) => setTimeout(resolve, 100))

      const raw = await fs.readFile(storeFile, 'utf8')
      const parsed = JSON.parse(raw)
      expect(parsed.width).toBe(1400)
      expect(parsed.height).toBe(900)
      expect(parsed.x).toBe(150)
      expect(parsed.y).toBe(120)
      expect(parsed.theme).toBe('light')
      expect(parsed.accentColor).toBe('#123456')
      expect(parsed.sidebarWidth).toBe(320)
    })

    it('loads legacy window-state when target file does not exist', async () => {
      const legacyDir = path.join(tempDir, 'legacy')
      await fs.mkdir(legacyDir, { recursive: true })
      const legacyFile = path.join(legacyDir, 'window-state.json')
      await fs.writeFile(
        legacyFile,
        JSON.stringify({ width: 1600, height: 1000, x: 50, y: 50 }),
        'utf8',
      )

      const service = new WindowStateService({ getHomeDir: () => tempDir })
      vi.spyOn(
        service as unknown as { getLegacyStorePath: () => string },
        'getLegacyStorePath',
      ).mockReturnValue(legacyFile)
      const reloadedState = service.loadStateSync()

      expect(reloadedState.width).toBe(1600)
      expect(reloadedState.height).toBe(1000)
      expect(reloadedState.x).toBe(50)
      expect(reloadedState.y).toBe(50)
    })
  })
})
