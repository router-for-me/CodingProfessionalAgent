import { app, type BrowserWindow, type NativeImage } from 'electron'

export type AppLifecycleMode = 'HEADLESS' | 'FOREGROUND'

export interface DockAdapter {
    show: () => void
    hide: () => void
    setIcon?: (image: NativeImage) => void
}

export interface HeadlessLifecycleOptions {
    isHeadlessInitially: boolean
    cliPort?: number
    cliHost?: string
    getMainWindow: () => BrowserWindow | null
    createMainWindow: () => BrowserWindow
    getAppIcon: () => NativeImage | undefined
    getTrayService: () => { setEnabled(enabled: boolean): void; isEnabled(): boolean } | undefined
    getSettings: () => Promise<{
        headlessCloseAction?: 'continue_headless' | 'quit'
        showInMenuBar?: boolean
    } | undefined>
    getSettingsSync?: () => {
        headlessCloseAction?: 'continue_headless' | 'quit'
        showInMenuBar?: boolean
    } | undefined
    ensureWebServerRunning?: () => Promise<void>
    dock?: DockAdapter | null
}

/**
 * HeadlessLifecycleService orchestrates silent background execution,
 * lazy window instantiation, platform dock/tray state transitions,
 * and foreground re-activation upon single-instance second launch.
 */
export class HeadlessLifecycleService {
    private mode: AppLifecycleMode
    private cachedCloseAction: 'continue_headless' | 'quit' = 'continue_headless'
    private readonly cliPort?: number
    private readonly cliHost?: string
    private readonly getMainWindow: () => BrowserWindow | null
    private readonly createMainWindow: () => BrowserWindow
    private readonly getAppIcon: () => NativeImage | undefined
    private readonly getTrayService: () => { setEnabled(enabled: boolean): void; isEnabled(): boolean } | undefined
    private readonly getSettings: () => Promise<{
        headlessCloseAction?: 'continue_headless' | 'quit'
        showInMenuBar?: boolean
    } | undefined>
    private readonly getSettingsSync?: () => {
        headlessCloseAction?: 'continue_headless' | 'quit'
        showInMenuBar?: boolean
    } | undefined
    readonly ensureWebServerRunning?: () => Promise<void>
    private readonly dock: DockAdapter | null

    constructor(options: HeadlessLifecycleOptions) {
        this.mode = options.isHeadlessInitially ? 'HEADLESS' : 'FOREGROUND'
        this.cliPort = options.cliPort
        this.cliHost = options.cliHost
        this.getMainWindow = options.getMainWindow
        this.createMainWindow = options.createMainWindow
        this.getAppIcon = options.getAppIcon
        this.getTrayService = options.getTrayService
        this.getSettings = options.getSettings
        this.getSettingsSync = options.getSettingsSync
        this.ensureWebServerRunning = options.ensureWebServerRunning
        this.dock = options.dock !== undefined ? options.dock : ((process.platform === 'darwin' && app.dock) ? app.dock : null)
        void this.refreshSettings()
    }

    /** Directly updates the cached close action preference. */
    setCachedCloseAction(action: 'continue_headless' | 'quit'): void {
        this.cachedCloseAction = action
    }

    /** Updates cached close action preference from settings. */
    async refreshSettings(): Promise<void> {
        try {
            const settings = await this.getSettings()
            if (settings?.headlessCloseAction) {
                this.cachedCloseAction = settings.headlessCloseAction
            }
        } catch {
            // Ignore settings fetch errors
        }
    }

    /** Returns whether the application is currently running in headless background mode. */
    isHeadless(): boolean {
        return this.mode === 'HEADLESS'
    }

    /** Returns the optional port passed via command line. */
    getCliPort(): number | undefined {
        return this.cliPort
    }

    /** Returns the optional host passed via command line. */
    getCliHost(): string | undefined {
        return this.cliHost
    }

    /**
     * Applies initial platform visibility states at startup.
     * In headless mode on macOS, completely hides the Dock icon.
     */
    applyInitialPlatformState(): void {
        if (this.mode === 'HEADLESS') {
            this.dock?.hide?.()
        }
    }

    /**
     * Transitions from headless mode to interactive foreground mode.
     * Shows macOS dock icon, instantiates or activates main window, and restores tray.
     */
    async transitionToForeground(): Promise<void> {
        this.mode = 'FOREGROUND'

        // 1. Show macOS Dock icon
        if (this.dock) {
            this.dock.show()
            const appIcon = this.getAppIcon()
            if (appIcon && this.dock.setIcon) {
                this.dock.setIcon(appIcon)
            }
        }

        // 2. Instantiate or restore/focus main window
        let win = this.getMainWindow()
        if (!win || win.isDestroyed()) {
            win = this.createMainWindow()
        } else {
            if (win.isMinimized()) {
                win.restore()
            }
            if (!win.isVisible()) {
                win.show()
            }
            win.focus()
        }

        // 3. Restore menu bar / tray icon if configured
        try {
            const settings = await this.getSettings()
            if (settings?.headlessCloseAction) {
                this.cachedCloseAction = settings.headlessCloseAction
            }
            if (settings?.showInMenuBar) {
                this.getTrayService()?.setEnabled(true)
            }
        } catch {
            // Ignore settings retrieval errors during transition
        }
    }

    /**
     * Transitions from foreground mode back to silent headless background mode.
     * Hides main window, macOS dock icon, and system tray, and ensures web server is running.
     */
    transitionToHeadless(): void {
        this.mode = 'HEADLESS'

        const win = this.getMainWindow()
        if (win && !win.isDestroyed()) {
            win.hide()
        }

        this.dock?.hide?.()
        this.getTrayService()?.setEnabled(false)

        void this.ensureWebServerRunning?.()
    }

    /**
     * Handles window close events synchronously to ensure preventDefault() takes effect.
     * Determines whether to prevent close and transition back to headless mode based on user configuration.
     *
     * @param event - Electron close event with preventDefault()
     * @param isQuitting - Flag indicating if application is shutting down
     * @returns True if close was prevented (switched to headless), false otherwise
     */
    handleWindowClose(event: { preventDefault: () => void }, isQuitting: boolean): boolean {
        if (isQuitting) {
            return false
        }

        const syncSettings = this.getSettingsSync?.()
        const closeAction = syncSettings?.headlessCloseAction ?? this.cachedCloseAction

        // Explicit user choice to quit always takes precedence over tray fallback
        if (closeAction === 'quit') {
            return false
        }

        if (closeAction === 'continue_headless') {
            event.preventDefault()
            this.transitionToHeadless()
            return true
        }

        // Fallback: If no explicit headless action but tray is enabled, hide to tray
        const tray = this.getTrayService()
        if (tray?.isEnabled()) {
            event.preventDefault()
            this.transitionToHeadless()
            return true
        }

        return false
    }
}
