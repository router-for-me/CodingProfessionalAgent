import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { BrowserWindow } from 'electron'

export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

export interface WindowState extends WindowBounds {
  isMaximized?: boolean
  isFullScreen?: boolean
}

export interface DisplayBounds {
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
}

export interface WindowStateServiceOptions {
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  customPath?: string
  debounceMs?: number
  getHomeDir?: () => string
}

/**
 * Check if the window bounds overlap reasonably with at least one display.
 */
export function isPositionVisible(
  bounds: { x: number; y: number; width: number; height: number },
  displays: DisplayBounds[],
): boolean {
  if (!displays || displays.length === 0) return true
  const minVisibleOverlap = 100

  return displays.some((display) => {
    const d = display.bounds
    const horizontalOverlap =
      bounds.x + bounds.width > d.x + minVisibleOverlap &&
      bounds.x < d.x + d.width - minVisibleOverlap
    const verticalOverlap =
      bounds.y + bounds.height > d.y + minVisibleOverlap &&
      bounds.y < d.y + d.height - minVisibleOverlap
    return horizontalOverlap && verticalOverlap
  })
}

export class WindowStateService {
  private storePath: string
  private isCustomPath = false
  private defaultWidth: number
  private defaultHeight: number
  private minWidth: number
  private minHeight: number
  private debounceMs: number
  private readonly getHomeDir: () => string
  private state: WindowState
  private managedWindow: BrowserWindow | null = null
  private eventListeners: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
  private debounceTimer: NodeJS.Timeout | null = null
  private savePromise: Promise<void> | null = null
  private dirty = false

  constructor(options: WindowStateServiceOptions = {}) {
    this.defaultWidth = options.defaultWidth ?? 1280
    this.defaultHeight = options.defaultHeight ?? 800
    this.minWidth = options.minWidth ?? 960
    this.minHeight = options.minHeight ?? 640
    this.debounceMs = options.debounceMs ?? 300
    this.getHomeDir = options.getHomeDir ?? (() => os.homedir())

    if (options.customPath) {
      this.storePath = options.customPath
      this.isCustomPath = true
    } else {
      const homeDir = this.getHomeDir()
      const appDir = path.join(homeDir, '.coding-professional-agent')
      this.storePath = path.join(appDir, 'ui.json')
      this.isCustomPath = false
    }

    this.state = this.loadStateSync()
  }

  private getLegacyStorePath(): string | null {
    if (this.isCustomPath) return null
    const homeDir = this.getHomeDir()
    const appDir = path.join(homeDir, '.coding-professional-agent')
    const localLegacy = path.join(appDir, 'window-state.json')
    if (fsSync.existsSync(localLegacy)) {
      return localLegacy
    }

    let userConfigDir: string
    if (process.platform === 'win32') {
      userConfigDir = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    } else if (process.platform === 'darwin') {
      userConfigDir = path.join(homeDir, 'Library', 'Application Support')
    } else {
      userConfigDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config')
    }
    const legacyUiPath = path.join(userConfigDir, 'coding-professional-agent', 'ui.json')
    if (fsSync.existsSync(legacyUiPath)) {
      return legacyUiPath
    }
    return path.join(userConfigDir, 'coding-professional-agent', 'window-state.json')
  }

  /**
   * Synchronously load state from disk or fallback to default values.
   */
  loadStateSync(): WindowState {
    try {
      let pathToRead = this.storePath
      if (!fsSync.existsSync(pathToRead)) {
        const legacyPath = this.getLegacyStorePath()
        if (legacyPath && legacyPath !== pathToRead && fsSync.existsSync(legacyPath)) {
          pathToRead = legacyPath
        }
      }

      if (fsSync.existsSync(pathToRead)) {
        const raw = fsSync.readFileSync(pathToRead, 'utf8')
        const parsed = JSON.parse(raw) as Partial<WindowState>
        const width =
          typeof parsed.width === 'number' && Number.isFinite(parsed.width) && parsed.width >= this.minWidth
            ? parsed.width
            : this.defaultWidth
        const height =
          typeof parsed.height === 'number' && Number.isFinite(parsed.height) && parsed.height >= this.minHeight
            ? parsed.height
            : this.defaultHeight
        const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : undefined
        const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : undefined
        const isMaximized = typeof parsed.isMaximized === 'boolean' ? parsed.isMaximized : false
        const isFullScreen = typeof parsed.isFullScreen === 'boolean' ? parsed.isFullScreen : false

        return {
          width,
          height,
          x,
          y,
          isMaximized,
          isFullScreen,
        }
      }
    } catch {
      // Ignore read or parse errors and fallback to defaults
    }

    return {
      width: this.defaultWidth,
      height: this.defaultHeight,
      isMaximized: false,
      isFullScreen: false,
    }
  }

  /**
   * Get the current state. If display bounds are provided, validate coordinates.
   */
  getState(displays?: DisplayBounds[]): WindowState {
    const width = Math.max(this.minWidth, this.state.width || this.defaultWidth)
    const height = Math.max(this.minHeight, this.state.height || this.defaultHeight)

    let x = this.state.x
    let y = this.state.y

    if (x !== undefined && y !== undefined && displays && displays.length > 0) {
      const visible = isPositionVisible({ x, y, width, height }, displays)
      if (!visible) {
        x = undefined
        y = undefined
      }
    }

    return {
      width,
      height,
      x,
      y,
      isMaximized: this.state.isMaximized,
      isFullScreen: this.state.isFullScreen,
    }
  }

  /**
   * Update internal state and schedule debounced save.
   */
  private updateStateFromWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return

    const isMaximized = win.isMaximized()
    const isFullScreen = win.isFullScreen()

    if (!isMaximized && !isFullScreen) {
      const bounds =
        typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds()
      if (bounds && bounds.width >= this.minWidth && bounds.height >= this.minHeight) {
        this.state.width = bounds.width
        this.state.height = bounds.height
        this.state.x = bounds.x
        this.state.y = bounds.y
      }
    }

    this.state.isMaximized = isMaximized
    this.state.isFullScreen = isFullScreen
    this.dirty = true
    this.scheduleSave()
  }

  /**
   * Attach event listeners to the browser window.
   */
  manage(win: BrowserWindow): void {
    this.unmanage()
    this.managedWindow = win

    const onStateChange = () => {
      this.updateStateFromWindow(win)
    }

    const onClose = () => {
      this.updateStateFromWindow(win)
      this.saveStateSync()
    }

    const events = [
      { event: 'resize', listener: onStateChange },
      { event: 'move', listener: onStateChange },
      { event: 'maximize', listener: onStateChange },
      { event: 'unmaximize', listener: onStateChange },
      { event: 'enter-full-screen', listener: onStateChange },
      { event: 'leave-full-screen', listener: onStateChange },
      { event: 'close', listener: onClose },
    ]

    for (const { event, listener } of events) {
      win.on(event as any, listener)
      this.eventListeners.push({ event, listener })
    }
  }

  /**
   * Restore maximized or fullscreen states if saved.
   */
  restore(win: BrowserWindow): void {
    if (win.isDestroyed()) return
    if (this.state.isMaximized) {
      win.maximize()
    } else if (this.state.isFullScreen) {
      win.setFullScreen(true)
    }
  }

  /**
   * Unbind all listeners from the managed window.
   */
  unmanage(): void {
    if (this.managedWindow && !this.managedWindow.isDestroyed()) {
      for (const { event, listener } of this.eventListeners) {
        this.managedWindow.removeListener(event as any, listener)
      }
    }
    this.eventListeners = []
    this.managedWindow = null
  }

  private scheduleSave(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.saveState()
    }, this.debounceMs)
  }

  /**
   * Asynchronously save state to disk while preserving non-window UI properties.
   */
  async saveState(): Promise<void> {
    if (!this.dirty) return
    if (this.savePromise) return this.savePromise

    this.savePromise = (async () => {
      try {
        const dir = path.dirname(this.storePath)
        await fs.mkdir(dir, { recursive: true })

        let existing: Record<string, unknown> = {}
        try {
          if (fsSync.existsSync(this.storePath)) {
            const raw = await fs.readFile(this.storePath, 'utf8')
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              existing = parsed as Record<string, unknown>
            }
          }
        } catch {
          // Ignore read error
        }

        const payload = {
          ...existing,
          ...this.state,
        }

        const tempPath = `${this.storePath}.tmp-${Date.now()}`
        await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf8')
        await fs.rename(tempPath, this.storePath)
        this.dirty = false
      } catch {
        // Ignore file save failures
      } finally {
        this.savePromise = null
      }
    })()

    return this.savePromise
  }

  /**
   * Synchronously save state to disk (for exit/close handlers) while preserving non-window UI properties.
   */
  saveStateSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    try {
      const dir = path.dirname(this.storePath)
      fsSync.mkdirSync(dir, { recursive: true })

      let existing: Record<string, unknown> = {}
      try {
        if (fsSync.existsSync(this.storePath)) {
          const raw = fsSync.readFileSync(this.storePath, 'utf8')
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing = parsed as Record<string, unknown>
          }
        }
      } catch {
        // Ignore read error
      }

      const payload = {
        ...existing,
        ...this.state,
      }

      const tempPath = `${this.storePath}.tmp-${Date.now()}`
      fsSync.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8')
      fsSync.renameSync(tempPath, this.storePath)
      this.dirty = false
    } catch {
      // Ignore file save failures
    }
  }

  /**
   * Clean up resources and ensure pending state is saved.
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.dirty) {
      this.saveStateSync()
    }
    this.unmanage()
  }
}
