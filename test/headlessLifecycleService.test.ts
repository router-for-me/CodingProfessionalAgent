import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HeadlessLifecycleService } from '../src/main/services/headlessLifecycleService.js'

describe('HeadlessLifecycleService', () => {
    let mockWindow: any
    let mockTrayService: any
    let mockDock: any
    let mockGetSettings: any

    beforeEach(() => {
        mockWindow = {
            isDestroyed: vi.fn(() => false),
            isVisible: vi.fn(() => false),
            isMinimized: vi.fn(() => false),
            show: vi.fn(),
            hide: vi.fn(),
            restore: vi.fn(),
            focus: vi.fn(),
        }
        mockTrayService = {
            setEnabled: vi.fn(),
            isEnabled: vi.fn(() => false),
        }
        mockDock = {
            show: vi.fn(),
            hide: vi.fn(),
            setIcon: vi.fn(),
        }
        mockGetSettings = vi.fn().mockResolvedValue({
            headlessCloseAction: 'continue_headless',
            showInMenuBar: true,
        })
    })

    it('initializes in HEADLESS mode when isHeadlessInitially is true and hides dock on applyInitialPlatformState', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            cliPort: 18888,
            cliHost: '0.0.0.0',
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        expect(service.isHeadless()).toBe(true)
        expect(service.getCliPort()).toBe(18888)
        expect(service.getCliHost()).toBe('0.0.0.0')

        service.applyInitialPlatformState()
        expect(mockDock.hide).toHaveBeenCalled()
    })

    it('initializes in FOREGROUND mode and applyInitialPlatformState does not trigger dock hide', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        expect(service.isHeadless()).toBe(false)
        service.applyInitialPlatformState()
        expect(mockDock.hide).not.toHaveBeenCalled()
    })

    it('transitions to foreground and restores window and tray', async () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        await service.transitionToForeground()
        expect(service.isHeadless()).toBe(false)
        expect(mockDock.show).toHaveBeenCalled()
        expect(mockWindow.show).toHaveBeenCalled()
        expect(mockWindow.focus).toHaveBeenCalled()
        expect(mockTrayService.setEnabled).toHaveBeenCalledWith(true)
    })

    it('creates main window lazily on transitionToForeground if window does not exist', async () => {
        let currentWindow: any = null
        const createSpy = vi.fn(() => {
            currentWindow = mockWindow
            return mockWindow
        })

        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => currentWindow,
            createMainWindow: createSpy,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        await service.transitionToForeground()
        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(mockDock.show).toHaveBeenCalled()
    })

    it('transitions back to headless, hides window and dock, but displays tray if showInMenuBar is true', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        service.transitionToHeadless()
        expect(service.isHeadless()).toBe(true)
        expect(mockWindow.hide).toHaveBeenCalled()
        expect(mockDock.hide).toHaveBeenCalled()
        expect(mockTrayService.setEnabled).toHaveBeenCalledWith(true)
    })

    it('transitions back to headless and hides tray when showInMenuBar is false', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: () => Promise.resolve({
                headlessCloseAction: 'continue_headless',
                showInMenuBar: false,
            }),
            getSettingsSync: () => ({
                headlessCloseAction: 'continue_headless',
                showInMenuBar: false,
            }),
            dock: mockDock,
        })

        service.transitionToHeadless()
        expect(service.isHeadless()).toBe(true)
        expect(mockWindow.hide).toHaveBeenCalled()
        expect(mockDock.hide).toHaveBeenCalled()
        expect(mockTrayService.setEnabled).toHaveBeenCalledWith(false)
    })

    it('updates tray visibility in headless mode when showInMenuBar changes', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        expect(service.isHeadless()).toBe(true)
        service.setCachedShowInMenuBar(false)
        expect(mockTrayService.setEnabled).toHaveBeenCalledWith(false)

        service.setCachedShowInMenuBar(true)
        expect(mockTrayService.setEnabled).toHaveBeenCalledWith(true)
    })

    it('intercepts window close to return to headless when headlessCloseAction is continue_headless', async () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        const event = { preventDefault: vi.fn() }
        const intercepted = await service.handleWindowClose(event, false)

        expect(intercepted).toBe(true)
        expect(event.preventDefault).toHaveBeenCalled()
        expect(service.isHeadless()).toBe(true)
        expect(mockWindow.hide).toHaveBeenCalled()
        expect(mockDock.hide).toHaveBeenCalled()
    })

    it('allows window close without interception when isQuitting is true', async () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        const event = { preventDefault: vi.fn() }
        const intercepted = await service.handleWindowClose(event, true)

        expect(intercepted).toBe(false)
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('allows window close when headlessCloseAction is quit even if tray is enabled', async () => {
        mockGetSettings.mockResolvedValue({
            headlessCloseAction: 'quit',
            showInMenuBar: true,
        })
        mockTrayService.isEnabled.mockReturnValue(true)

        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })
        await service.refreshSettings()

        const event = { preventDefault: vi.fn() }
        const intercepted = service.handleWindowClose(event, false)

        expect(intercepted).toBe(false)
        expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('invokes ensureWebServerRunning when transitioning to headless', () => {
        const mockEnsureWebServer = vi.fn().mockResolvedValue(undefined)
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            ensureWebServerRunning: mockEnsureWebServer,
            dock: mockDock,
        })

        service.transitionToHeadless()
        expect(mockEnsureWebServer).toHaveBeenCalled()
    })

    it('updates close action synchronously via setCachedCloseAction and getSettingsSync', () => {
        let currentCloseAction: 'continue_headless' | 'quit' = 'continue_headless'
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            getSettingsSync: () => ({ headlessCloseAction: currentCloseAction }),
            dock: mockDock,
        })

        const event1 = { preventDefault: vi.fn() }
        expect(service.handleWindowClose(event1, false)).toBe(true)

        // Setting changed synchronously in store/kvStore
        currentCloseAction = 'quit'
        const event2 = { preventDefault: vi.fn() }
        expect(service.handleWindowClose(event2, false)).toBe(false)
        expect(event2.preventDefault).not.toHaveBeenCalled()
    })

    it('directly updates close behavior via setCachedCloseAction', () => {
        const service = new HeadlessLifecycleService({
            isHeadlessInitially: false,
            getMainWindow: () => mockWindow,
            createMainWindow: () => mockWindow,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        // Default continue_headless
        const event1 = { preventDefault: vi.fn() }
        expect(service.handleWindowClose(event1, false)).toBe(true)
        expect(event1.preventDefault).toHaveBeenCalled()

        // Directly updated via setCachedCloseAction('quit')
        service.setCachedCloseAction('quit')
        const event2 = { preventDefault: vi.fn() }
        expect(service.handleWindowClose(event2, false)).toBe(false)
        expect(event2.preventDefault).not.toHaveBeenCalled()
    })

    it('restores and focuses existing window idempotently without creating a new one', async () => {
        const createSpy = vi.fn(() => mockWindow)
        mockWindow.isVisible.mockReturnValue(false)
        mockWindow.isMinimized.mockReturnValue(true)

        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => mockWindow,
            createMainWindow: createSpy,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        await service.transitionToForeground()
        expect(createSpy).not.toHaveBeenCalled()
        expect(mockWindow.restore).toHaveBeenCalled()
        expect(mockWindow.show).toHaveBeenCalled()
        expect(mockWindow.focus).toHaveBeenCalled()
    })

    it('does not create duplicate windows across multiple consecutive or concurrent foreground transitions', async () => {
        let currentWindow: any = null
        const createSpy = vi.fn(() => {
            currentWindow = mockWindow
            return mockWindow
        })

        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => currentWindow,
            createMainWindow: createSpy,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        // Simulate concurrent or consecutive activations during initialization
        await Promise.all([
            service.transitionToForeground(),
            service.transitionToForeground(),
        ])
        await service.transitionToForeground()

        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(mockWindow.focus).toHaveBeenCalled()
    })

    it('simulates startup readiness gating where early second-instance is deferred until ready', async () => {
        let isReadyForWindows = false
        let pendingActivation = false
        let currentWindow: any = null
        const createSpy = vi.fn(() => {
            currentWindow = mockWindow
            return mockWindow
        })

        const service = new HeadlessLifecycleService({
            isHeadlessInitially: true,
            getMainWindow: () => currentWindow,
            createMainWindow: createSpy,
            getAppIcon: () => undefined,
            getTrayService: () => mockTrayService,
            getSettings: mockGetSettings,
            dock: mockDock,
        })

        // Simulate second-instance firing while readiness gate is false
        const onSecondInstance = () => {
            if (isReadyForWindows) {
                void service.transitionToForeground()
            } else {
                pendingActivation = true
            }
        }

        onSecondInstance()
        expect(pendingActivation).toBe(true)
        expect(createSpy).not.toHaveBeenCalled()

        // When startup completes and readiness gate opens
        isReadyForWindows = true
        if (pendingActivation) {
            pendingActivation = false
            await service.transitionToForeground()
        }

        expect(createSpy).toHaveBeenCalledTimes(1)
        expect(service.isHeadless()).toBe(false)
        expect(mockDock.show).toHaveBeenCalled()
    })
})
