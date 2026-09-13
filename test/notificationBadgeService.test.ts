import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { mockApp, MockNotification, state } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events')

  const state = {
    notifications: [] as any[],
    throwOnConstruct: false,
    throwOnShow: false,
  }

  class MockNotificationClass extends EE {
    options: any
    constructor(options: any) {
      super()
      if (state.throwOnConstruct) {
        throw new Error('Notification constructor failed')
      }
      this.options = options
      state.notifications.push(this)
    }
    show = vi.fn(() => {
      if (state.throwOnShow) {
        throw new Error('Notification show failed')
      }
    })
  }

  const mockApp = {
    dock: {
      setBadge: vi.fn(),
      bounce: vi.fn(),
    },
    setBadgeCount: vi.fn(),
    setAppUserModelId: vi.fn(),
  }

  return { mockApp, MockNotification: MockNotificationClass, state }
})

vi.mock('electron', () => ({
  app: mockApp,
  Notification: MockNotification,
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  nativeImage: {
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
    createFromBitmap: vi.fn(() => ({ isEmpty: () => false })),
  },
}))

import {
  NotificationBadgeService,
  registerWin32AppUserModelId,
  APP_USER_MODEL_ID,
} from '../src/main/services/notificationBadgeService.js'
import { attachMainWindowListeners } from '../src/main/ipc/registerIpcHandlers.js'

describe('NotificationBadgeService', () => {
  let mockWin: any
  let service: NotificationBadgeService
  let originalPlatform: string

  beforeEach(() => {
    originalPlatform = process.platform
    state.notifications = []
    state.throwOnConstruct = false
    state.throwOnShow = false
    vi.clearAllMocks()

    mockWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      show: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      flashFrame: vi.fn(),
      setOverlayIcon: vi.fn(),
      webContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    })

    service = new NotificationBadgeService(() => mockWin)
    service.attachWindow(mockWin)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('ignores completion if window is focused and not minimized', () => {
    mockWin.isFocused.mockReturnValue(true)
    mockWin.isMinimized.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Test Task' })

    expect(service.getStatus().badgeCount).toBe(0)
    expect(state.notifications.length).toBe(0)
  })

  it('increments badge and fires notification when window is unfocused', () => {
    mockWin.isFocused.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Refactor Code' })

    expect(service.getStatus().badgeCount).toBe(1)
    expect(state.notifications.length).toBe(1)
    expect(state.notifications[0].options.title).toBe('Coding Professional Agent')
    expect(state.notifications[0].options.body).toBe('Refactor Code 任务已经完成')
    expect(state.notifications[0].show).toHaveBeenCalled()
  })

  it('sets dock badge on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mockWin.isFocused.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })

    expect(mockApp.dock.setBadge).toHaveBeenCalledWith('1')
    expect(mockApp.dock.bounce).toHaveBeenCalledWith('informational')
  })

  it('sets overlay icon and flashFrame on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWin.isFocused.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })

    expect(mockWin.setOverlayIcon).toHaveBeenCalled()
    expect(mockWin.flashFrame).toHaveBeenCalledWith(true)
  })

  it('sets badge count and flashFrame on Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockWin.isFocused.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })

    expect(mockWin.flashFrame).toHaveBeenCalledWith(true)
    expect(mockApp.setBadgeCount).toHaveBeenCalledWith(1)

    service.clearBadge()
    expect(mockWin.flashFrame).toHaveBeenCalledWith(false)
    expect(mockApp.setBadgeCount).toHaveBeenCalledWith(0)
  })

  it('clears badge and stops flashFrame when clearBadge is called', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    mockWin.isFocused.mockReturnValue(false)

    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    expect(service.getStatus().badgeCount).toBe(1)

    service.clearBadge()
    expect(service.getStatus().badgeCount).toBe(0)
    expect(mockWin.setOverlayIcon).toHaveBeenCalledWith(null, '')
    expect(mockWin.flashFrame).toHaveBeenCalledWith(false)
  })

  it('clears badge automatically when window emits focus', () => {
    mockWin.isFocused.mockReturnValue(false)
    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    expect(service.getStatus().badgeCount).toBe(1)

    mockWin.emit('focus')
    expect(service.getStatus().badgeCount).toBe(0)
  })

  it('activates window and clears badge when notification is clicked', () => {
    mockWin.isFocused.mockReturnValue(false)
    mockWin.isMinimized.mockReturnValue(true)
    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })

    const notif = state.notifications[0]
    notif.emit('click')

    expect(mockWin.restore).toHaveBeenCalled()
    expect(mockWin.show).toHaveBeenCalled()
    expect(mockWin.focus).toHaveBeenCalled()
    expect(mockWin.webContents.send).toHaveBeenCalledWith('notification:navigate-session', 'session-1')
    expect(service.getStatus().badgeCount).toBe(0)
  })

  it('emits notification:navigate-session native event when notification is clicked', () => {
    const emitEventMock = vi.fn()
    const customService = new NotificationBadgeService(() => mockWin, emitEventMock)
    mockWin.isFocused.mockReturnValue(false)
    customService.notifyTaskCompleted({ sessionId: 'session-123', sessionTitle: 'Task Title' })

    const notif = state.notifications[0]
    notif.emit('click')

    expect(emitEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'notification:navigate-session',
        data: JSON.stringify({ sessionId: 'session-123' }),
      })
    )
    expect(customService.getStatus().badgeCount).toBe(0)
  })

  it('updates badge even if Notification constructor throws', () => {
    mockWin.isFocused.mockReturnValue(false)
    state.throwOnConstruct = true

    expect(() => {
      service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    }).not.toThrow()

    expect(service.getStatus().badgeCount).toBe(1)
    expect(state.notifications.length).toBe(0)
  })

  it('updates badge even if notification.show() throws', () => {
    mockWin.isFocused.mockReturnValue(false)
    state.throwOnShow = true

    expect(() => {
      service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    }).not.toThrow()

    expect(service.getStatus().badgeCount).toBe(1)
    expect(state.notifications.length).toBe(1)
    expect(state.notifications[0].show).toHaveBeenCalled()
  })

  it('does not send IPC when webContents is destroyed on notification click, but still clears badge', () => {
    mockWin.isFocused.mockReturnValue(false)
    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    expect(service.getStatus().badgeCount).toBe(1)

    mockWin.webContents.isDestroyed.mockReturnValue(true)

    const notif = state.notifications[0]
    notif.emit('click')

    expect(mockWin.webContents.send).not.toHaveBeenCalled()
    expect(service.getStatus().badgeCount).toBe(0)
  })

  it('clears badge even if window operations or webContents throws during click handling', () => {
    mockWin.isFocused.mockReturnValue(false)
    mockWin.focus.mockImplementation(() => {
      throw new Error('Window focus crashed')
    })
    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    expect(service.getStatus().badgeCount).toBe(1)

    const notif = state.notifications[0]
    expect(() => notif.emit('click')).not.toThrow()

    expect(service.getStatus().badgeCount).toBe(0)
  })

  it('clears badge even if webContents.send throws during click handling', () => {
    mockWin.isFocused.mockReturnValue(false)
    mockWin.webContents.send.mockImplementation(() => {
      throw new Error('IPC send failed')
    })
    service.notifyTaskCompleted({ sessionId: 'session-1', sessionTitle: 'Task 1' })
    expect(service.getStatus().badgeCount).toBe(1)

    const notif = state.notifications[0]
    expect(() => notif.emit('click')).not.toThrow()

    expect(service.getStatus().badgeCount).toBe(0)
  })

  it('formats notification body correctly with empty title or long title', () => {
    mockWin.isFocused.mockReturnValue(false)

    // Empty title
    service.notifyTaskCompleted({ sessionId: 'session-1' })
    expect(state.notifications[0].options.body).toBe('任务已经完成')

    // Long title (> 40 characters)
    const longTitle = 'A'.repeat(50)
    service.notifyTaskCompleted({ sessionId: 'session-2', sessionTitle: longTitle })
    expect(state.notifications[1].options.body).toBe(`${'A'.repeat(40)}... 任务已经完成`)
  })

  it('handles attachWindow and getStatus gracefully when window is null or destroyed', () => {
    const standaloneService = new NotificationBadgeService()
    expect(standaloneService.getStatus()).toEqual({ badgeCount: 0, isWindowFocused: false })

    standaloneService.attachWindow(null as any)
    expect(standaloneService.getStatus().isWindowFocused).toBe(false)

    const destroyedWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
    })
    standaloneService.attachWindow(destroyedWin as any)
    expect(standaloneService.getStatus().isWindowFocused).toBe(false)
  })

  it('attachMainWindowListeners calls notificationBadgeService.attachWindow with win', () => {
    const attachWindowSpy = vi.fn()
    const mockServices: any = {
      notificationBadgeService: {
        attachWindow: attachWindowSpy,
      },
    }

    const testWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        id: 1,
      }),
    })

    attachMainWindowListeners(testWin as any, mockServices)
    expect(attachWindowSpy).toHaveBeenCalledTimes(1)
    expect(attachWindowSpy).toHaveBeenCalledWith(testWin)
  })

  it('attachMainWindowListeners handles missing notificationBadgeService or attachWindow gracefully', () => {
    const testWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        id: 2,
      }),
    })

    expect(() => {
      attachMainWindowListeners(testWin as any, {} as any)
    }).not.toThrow()

    expect(() => {
      attachMainWindowListeners(testWin as any, { notificationBadgeService: {} } as any)
    }).not.toThrow()
  })

  it('attachMainWindowListeners does not attach when win or webContents is destroyed', () => {
    const attachWindowSpy = vi.fn()
    const mockServices: any = {
      notificationBadgeService: {
        attachWindow: attachWindowSpy,
      },
    }

    const destroyedWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => true),
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => false),
        id: 3,
      }),
    })
    attachMainWindowListeners(destroyedWin as any, mockServices)
    expect(attachWindowSpy).not.toHaveBeenCalled()

    const destroyedWebContentsWin = Object.assign(new EventEmitter(), {
      isDestroyed: vi.fn(() => false),
      webContents: Object.assign(new EventEmitter(), {
        isDestroyed: vi.fn(() => true),
        id: 4,
      }),
    })
    attachMainWindowListeners(destroyedWebContentsWin as any, mockServices)
    expect(attachWindowSpy).not.toHaveBeenCalled()
  })

  describe('registerWin32AppUserModelId', () => {
    it('sets appUserModelId to com.earendil.coding-professional-agent on win32 platform', () => {
      const result = registerWin32AppUserModelId(mockApp as any, 'win32')
      expect(result).toBe(true)
      expect(mockApp.setAppUserModelId).toHaveBeenCalledWith(APP_USER_MODEL_ID)
      expect(APP_USER_MODEL_ID).toBe('com.earendil.coding-professional-agent')
    })

    it('does not set appUserModelId on non-win32 platforms', () => {
      const resultDarwin = registerWin32AppUserModelId(mockApp as any, 'darwin')
      expect(resultDarwin).toBe(false)
      expect(mockApp.setAppUserModelId).not.toHaveBeenCalled()

      const resultLinux = registerWin32AppUserModelId(mockApp as any, 'linux')
      expect(resultLinux).toBe(false)
      expect(mockApp.setAppUserModelId).not.toHaveBeenCalled()
    })

    it('uses process.platform when platform argument is omitted', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const winResult = registerWin32AppUserModelId(mockApp as any)
      expect(winResult).toBe(true)
      expect(mockApp.setAppUserModelId).toHaveBeenCalledWith('com.earendil.coding-professional-agent')

      vi.clearAllMocks()
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const darwinResult = registerWin32AppUserModelId(mockApp as any)
      expect(darwinResult).toBe(false)
      expect(mockApp.setAppUserModelId).not.toHaveBeenCalled()
    })

    it('handles app instance without setAppUserModelId gracefully', () => {
      const result = registerWin32AppUserModelId({} as any, 'win32')
      expect(result).toBe(false)
    })
  })
})


