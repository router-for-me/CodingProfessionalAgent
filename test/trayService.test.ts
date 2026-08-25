import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const { mockApp, mockMenu, mockNativeImage, MockTray, state } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events')

  const state: { lastTrayInstance: any } = { lastTrayInstance: null }

  class MockTrayClass extends EE {
    toolTip = ''
    destroyed = false
    popUpContextMenu = vi.fn()

    constructor() {
      super()
      state.lastTrayInstance = this
    }

    setToolTip(tip: string) {
      this.toolTip = tip
    }

    destroy() {
      this.destroyed = true
      this.removeAllListeners()
    }
  }

  const mockApp = {
    quit: vi.fn(),
    dock: {
      show: vi.fn(),
      hide: vi.fn(),
    },
  }
  const mockMenu = {
    buildFromTemplate: vi.fn((template) => ({ template })),
  }
  const mockNativeImage = {
    createEmpty: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
      addRepresentation: vi.fn(),
      getSize: () => ({ width: 18, height: 18 }),
      resize: vi.fn(function () {
        return this
      }),
    })),
    createFromBitmap: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 18, height: 18 }),
      resize: vi.fn(function () {
        return this
      }),
    })),
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 18, height: 18 }),
      resize: vi.fn(function () {
        return this
      }),
    })),
    createFromDataURL: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 18, height: 18 }),
      resize: vi.fn(function () {
        return this
      }),
    })),
  }
  return { mockApp, mockMenu, mockNativeImage, MockTray: MockTrayClass, state }
})

vi.mock('electron', () => ({
  app: mockApp,
  Tray: MockTray,
  Menu: mockMenu,
  nativeImage: mockNativeImage,
}))

import { TrayService, createTrayIcon } from '../src/main/services/trayService.js'

class MockWindow {
  minimized = false
  visible = false
  focused = false
  destroyed = false
  fullScreen = false

  isMinimized() {
    return this.minimized
  }

  isVisible() {
    return this.visible
  }

  isDestroyed() {
    return this.destroyed
  }

  isFullScreen() {
    return this.fullScreen
  }

  restore() {
    this.minimized = false
    this.visible = true
  }

  show() {
    this.visible = true
  }

  hide() {
    this.visible = false
    this.focused = false
  }

  focus() {
    this.focused = true
  }

  setFullScreen(val: boolean) {
    this.fullScreen = val
  }
}

describe('TrayService', () => {
  let mockWindow: MockWindow
  let service: TrayService

  beforeEach(() => {
    vi.clearAllMocks()
    mockWindow = new MockWindow()
    state.lastTrayInstance = null
    service = new TrayService(() => mockWindow as any)
  })

  afterEach(() => {
    service.dispose()
  })

  it('starts disabled with no tray icon', () => {
    expect(service.isEnabled()).toBe(false)
    expect(state.lastTrayInstance).toBeNull()
  })

  it('creates a tray icon when enabled and destroys it when disabled', () => {
    service.setEnabled(true, 'zh-CN')
    expect(service.isEnabled()).toBe(true)
    expect(state.lastTrayInstance).not.toBeNull()
    expect(state.lastTrayInstance.toolTip).toBe('Coding Professional Agent')
    expect(state.lastTrayInstance.destroyed).toBe(false)

    service.setEnabled(false)
    expect(service.isEnabled()).toBe(false)
    expect(state.lastTrayInstance.destroyed).toBe(true)
    if (process.platform === 'darwin') {
      expect(mockApp.dock.show).toHaveBeenCalled()
    }
  })

  it('restores, shows, and focuses window on showWindow, and shows dock on macOS', () => {
    mockWindow.minimized = true
    mockWindow.visible = false
    mockWindow.focused = false

    service.showWindow()

    expect(mockWindow.minimized).toBe(false)
    expect(mockWindow.visible).toBe(true)
    expect(mockWindow.focused).toBe(true)
    if (process.platform === 'darwin') {
      expect(mockApp.dock.show).toHaveBeenCalled()
    }
  })

  it('hides window and dock on hideWindow', () => {
    mockWindow.visible = true
    mockWindow.focused = true

    service.hideWindow()

    expect(mockWindow.visible).toBe(false)
    expect(mockWindow.focused).toBe(false)
    if (process.platform === 'darwin') {
      expect(mockApp.dock.hide).toHaveBeenCalled()
    }
  })

  it('toggles window and dock visibility on tray click and double-click', () => {
    service.setEnabled(true, 'zh-CN')
    mockWindow.visible = false

    // Click when hidden -> shows window
    state.lastTrayInstance.emit('click')
    expect(mockWindow.visible).toBe(true)
    expect(mockWindow.focused).toBe(true)
    if (process.platform === 'darwin') {
      expect(mockApp.dock.show).toHaveBeenCalled()
    }

    // Click when visible -> hides window
    state.lastTrayInstance.emit('click')
    expect(mockWindow.visible).toBe(false)
    if (process.platform === 'darwin') {
      expect(mockApp.dock.hide).toHaveBeenCalled()
    }

    // Double-click when hidden -> shows window
    state.lastTrayInstance.emit('double-click')
    expect(mockWindow.visible).toBe(true)
  })

  it('pops up localized context menu with quit item on right-click', () => {
    service.setEnabled(true, 'zh-CN')

    state.lastTrayInstance.emit('right-click')
    expect(state.lastTrayInstance.popUpContextMenu).toHaveBeenCalledTimes(1)
    const callArgZh = mockMenu.buildFromTemplate.mock.results[0].value
    expect(callArgZh.template).toHaveLength(1)
    expect(callArgZh.template[0].label).toBe('Quit CPA')

    // Test quit callback
    callArgZh.template[0].click()
    expect(mockApp.quit).toHaveBeenCalledTimes(1)

    // Switch to English and test
    service.setLocale('en')
    state.lastTrayInstance.emit('right-click')
    const callArgEn = mockMenu.buildFromTemplate.mock.results[1].value
    expect(callArgEn.template).toHaveLength(1)
    expect(callArgEn.template[0].label).toBe('Quit CPA')
  })

  it('creates a tray icon from file or falls back cleanly to embedded template representations', () => {
    const icon = createTrayIcon()
    expect(icon).toBeDefined()
    expect(icon.isEmpty()).toBe(false)
    if (process.platform === 'darwin') {
      expect(icon.setTemplateImage).toHaveBeenCalledWith(true)
    }

    // Force createFromPath to return empty (simulating missing files in packaged app)
    mockNativeImage.createFromPath.mockReturnValueOnce({
      isEmpty: () => true,
      setTemplateImage: vi.fn(),
      getSize: () => ({ width: 0, height: 0 }),
      resize: vi.fn(),
    } as any)

    const fallbackIcon = createTrayIcon()
    expect(fallbackIcon).toBeDefined()
    expect(fallbackIcon.isEmpty()).toBe(false)
    if (process.platform === 'darwin') {
      expect(fallbackIcon.setTemplateImage).toHaveBeenCalledWith(true)
    }
  })
})
