import { app, BrowserWindow, nativeImage, screen, shell } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveMainEntry } from './bootstrapper.js'
import {
  createServices,
  registerIpcHandlers,
  attachMainWindowListeners,
  type AppServices,
} from './ipc/registerIpcHandlers.js'
import {
  resolveWebServerStartupPlan,
  resolveWebServerFallbackPlan,
} from './utils/webServerStartup.js'
import {
  registerPluginSchemesAsPrivileged,
  registerPluginProtocol,
} from './plugins/resources/registerPluginProtocol.js'
import { bootstrapPluginGraph } from './plugins/catalog/bootstrapPluginGraph.js'
import { MainPluginRuntimeHost } from './plugins/runtime/MainPluginRuntimeHost.js'
import { MainPluginActivationCoordinator } from './plugins/runtime/MainPluginActivationCoordinator.js'
import { rotateNativeImage45 } from './utils/imageRotate.js'
import { registerWin32AppUserModelId } from './services/notificationBadgeService.js'
import { getAppVersion } from './utils/version.js'
import { syncUserShellEnvironment } from './services/shellEnvironment.js'
import { parseCommandLineArgs } from './utils/cliArgs.js'
import { HeadlessLifecycleService } from './services/headlessLifecycleService.js'

// Synchronize user shell environment (PATH, toolchains, homebrew, go) on app startup
syncUserShellEnvironment()

// Prevent unhandled EPIPE errors when stdout/stderr or IPC pipes close abruptly
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return
})
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return
})

process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') {
    // Ignore EPIPE errors when writing to a closed pipe/socket/stream
    return
  }
  console.error('Uncaught Exception:', err)
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let services: AppServices | null = null
let pluginRuntimeHost: MainPluginRuntimeHost | null = null
let lifecycleService: HeadlessLifecycleService | null = null
let isQuitting = false
let healthCheckTimer: NodeJS.Timeout | null = null

const cliArgs = parseCommandLineArgs(process.argv)

// In headless mode on macOS, hide Dock as early as possible
if (cliArgs.isHeadless && process.platform === 'darwin') {
  app.dock?.hide?.()
}

function clearHealthTimer(): void {
  if (healthCheckTimer) {
    clearTimeout(healthCheckTimer)
    healthCheckTimer = null
  }
}

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development'
if (isDev) {
  process.env.CPA_DEV = '1'
  process.env.CPA_CONFIG_DIR_NAME = '.coding-professional-agent-dev'
} else {
  process.env.CPA_CONFIG_DIR_NAME = '.coding-professional-agent'
}

function getAppIcon(isDevMode: boolean = isDev): Electron.NativeImage | undefined {
  if (isDevMode) {
    const devCandidates = [
      path.resolve(__dirname, '../../../build/appicon-dev.png'),
      path.resolve(__dirname, '../../build/appicon-dev.png'),
      path.resolve(process.cwd(), 'build/appicon-dev.png'),
      path.resolve(app.getAppPath?.() || '', 'build/appicon-dev.png'),
      path.resolve(process.resourcesPath || '', 'build/appicon-dev.png'),
    ]
    for (const devPath of devCandidates) {
      try {
        if (fs.existsSync(devPath)) {
          const img = nativeImage.createFromPath(devPath)
          if (!img.isEmpty()) {
            return img
          }
        }
      } catch {}
    }
  }

  const candidates = [
    path.resolve(__dirname, '../../../build/appicon.png'),
    path.resolve(__dirname, '../../build/appicon.png'),
    path.resolve(process.cwd(), 'build/appicon.png'),
    path.resolve(app.getAppPath?.() || '', 'build/appicon.png'),
    path.resolve(process.resourcesPath || '', 'build/appicon.png'),
    path.resolve(__dirname, '../../../../frontend/dist/appicon.png'),
    path.resolve(__dirname, '../../../frontend/dist/appicon.png'),
    path.resolve(__dirname, '../../frontend/dist/appicon.png'),
    path.resolve(process.cwd(), 'frontend/dist/appicon.png'),
    path.resolve(app.getAppPath?.() || '', 'frontend/dist/appicon.png'),
    path.resolve(__dirname, '../../../frontend/public/appicon.png'),
    path.resolve(__dirname, '../../frontend/public/appicon.png'),
    path.resolve(process.cwd(), 'frontend/public/appicon.png'),
    path.resolve(app.getAppPath?.() || '', 'frontend/public/appicon.png'),
  ]
  for (const iconPath of candidates) {
    try {
      if (fs.existsSync(iconPath)) {
        const img = nativeImage.createFromPath(iconPath)
        if (!img.isEmpty()) {
          return isDevMode ? rotateNativeImage45(img) : img
        }
      }
    } catch {}
  }
  return undefined
}

function getRendererHtmlPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../frontend/dist/index.html'),
    path.resolve(__dirname, '../../../frontend/dist/index.html'),
    path.resolve(__dirname, '../../frontend/dist/index.html'),
    path.resolve(process.cwd(), 'frontend/dist/index.html'),
    path.resolve(app.getAppPath?.() || '', 'frontend/dist/index.html'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return candidates[0]
}

function createWindow(services: AppServices): BrowserWindow {
  const displays = screen.getAllDisplays()
  const state = services.windowStateService.getState(displays)
  const appIcon = getAppIcon()

  const win = new BrowserWindow({
    title: 'Coding Professional Agent',
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#06070f',
    icon: appIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  attachMainWindowListeners(win, services)

  services.windowStateService.manage(win)
  services.windowStateService.restore(win)

  // Prevent external navigation in main window
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[Renderer L${level}] ${message} (${sourceId}:${line})`)
    })
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) {
    win.loadURL(devUrl)
  } else {
    // In production or built renderer
    win.loadFile(getRendererHtmlPath())
  }

  win.on('close', (event) => {
    if (isQuitting) return
    if (lifecycleService) {
      const handled = lifecycleService.handleWindowClose(event, isQuitting)
      if (handled) return
      // User explicitly requested quit; do not fall back to hiding in tray
      return
    }
    if (services.trayService.isEnabled()) {
      event.preventDefault()
      const hideWindow = () => {
        win.hide()
        if (process.platform === 'darwin') {
          app.dock?.hide?.()
        }
      }
      if (win.isFullScreen()) {
        win.once('leave-full-screen', hideWindow)
        win.setFullScreen(false)
      } else {
        hideWindow()
      }
    }
  })

  win.on('closed', () => {
    clearHealthTimer()
    mainWindow = null
  })

  return win
}

async function bootstrap(): Promise<void> {
  if (app.isPackaged && !process.env.CPA_HOT_PATCH_ACTIVE) {
    const activeEntry = resolveMainEntry(import.meta.url)
    if (activeEntry && path.resolve(activeEntry) !== path.resolve(__filename)) {
      try {
        process.env.CPA_HOT_PATCH_ACTIVE = '1'
        await import(pathToFileURL(activeEntry).href)
        return
      } catch (err) {
        delete process.env.CPA_HOT_PATCH_ACTIVE
        console.error('[Bootstrapper] Failed to load active updated asar entry, falling back to base entry:', err)
      }
    }
  }

  // Register privileged schemes before app ready
  registerPluginSchemesAsPrivileged()

  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    if (cliArgs.isHeadless) {
      console.log('[CPA] Another instance is already running.')
    }
    app.quit()
    return
  }

  let pendingForegroundActivation = false
  let pendingHeadlessActivation = false
  let isAppReadyForWindows = false

  app.on('second-instance', (_event, commandLine) => {
    // Explicitly pass empty env so primary instance's CPA_HEADLESS does not taint second instance
    const secondArgs = parseCommandLineArgs(commandLine, {})
    if (secondArgs.isHeadless) {
      console.log('[CPA] Second instance invoked with --headless; primary instance remains running in background.')
      if (isAppReadyForWindows && lifecycleService) {
        void lifecycleService.ensureWebServerRunning?.()
      } else {
        pendingHeadlessActivation = true
      }
      return
    }
    if (isAppReadyForWindows && lifecycleService) {
      void lifecycleService.transitionToForeground()
    } else {
      pendingForegroundActivation = true
    }
  })

  app.whenReady().then(async () => {
    if (!cliArgs.isHeadless) {
      registerWin32AppUserModelId(app)
      if (process.platform === 'darwin' && app.dock) {
        const appIcon = getAppIcon()
        if (appIcon) {
          app.dock.setIcon(appIcon)
        }
      }
    }

    const cpaVersion = getAppVersion()
    if (typeof (app as any).setVersion === 'function') {
      try {
        ;(app as any).setVersion(cpaVersion)
      } catch {}
    }
    const homeDir = typeof app.getPath === 'function' ? app.getPath('home') : ''

    const bootstrapResult = await bootstrapPluginGraph({
      cpaVersion,
      homeDir,
    })

    pluginRuntimeHost = new MainPluginRuntimeHost({
      cpaVersion,
      catalog: bootstrapResult.catalog,
      graphDTO: bootstrapResult.graph,
    })
    const coordinator = new MainPluginActivationCoordinator({
      host: pluginRuntimeHost,
      graph: bootstrapResult.graph,
    })
    try {
      await coordinator.stage()
    } catch (err) {
      console.error('Failed to stage plugin runtime host:', err)
    }

    services = createServices(() => mainWindow, {
      isDebug: isDev,
      homeDir,
      cpaVersion,
      pluginRuntimeHost,
      pluginActivationCoordinator: coordinator,
      pluginResourceService: bootstrapResult.resourceService,
      isHeadless: () => lifecycleService?.isHeadless() ?? false,
    })

    lifecycleService = new HeadlessLifecycleService({
      isHeadlessInitially: cliArgs.isHeadless,
      cliPort: cliArgs.port,
      cliHost: cliArgs.host,
      getMainWindow: () => mainWindow,
      createMainWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          mainWindow = createWindow(services!)
          services?.updateService?.confirmHealthy()
        }
        return mainWindow
      },
      getAppIcon,
      getTrayService: () => services?.trayService,
      getSettings: async () => {
        try {
          const appState = await services?.kvStoreService?.get('app-state')
          return {
            headlessCloseAction: appState?.settings?.headlessCloseAction,
            showInMenuBar: appState?.settings?.showInMenuBar,
          }
        } catch {
          return undefined
        }
      },
      getSettingsSync: () => {
        try {
          const appState = services?.kvStoreService?.getSync?.('app-state') as any
          return {
            headlessCloseAction: appState?.settings?.headlessCloseAction,
            showInMenuBar: appState?.settings?.showInMenuBar,
          }
        } catch {
          return undefined
        }
      },
      ensureWebServerRunning: async () => {
        if (!services) return
        try {
          const currentStatus = services.webServerService.getStatus()
          if (!currentStatus.running) {
            await coordinator.whenCommitted()
            const appState =
              services.kvStoreService?.getSync?.('app-state') ??
              (await services.kvStoreService?.get?.('app-state'))
            const loadError = (services.kvStoreService as any)?.getLoadError?.()
            if (loadError) {
              console.error('[Headless] Refusing to start Web Server because settings failed to load:', loadError)
              return
            }
            const plan = resolveWebServerStartupPlan(appState, isDev, {
              isHeadless: true,
              cliPort: cliArgs.port,
              cliHost: cliArgs.host,
            })
            if (plan.startConfig) {
              const status = await services.webServerService.start(plan.startConfig)
              if (status.running) {
                console.log(`[Headless] Web server listening at http://${status.host}:${status.port}`)
              } else {
                console.error(`[Headless] Web server failed to start: ${status.error ?? 'Unknown error'}`)
              }
            }
          }
        } catch (err) {
          console.error('[Headless] Failed to ensure web server running:', err)
        }
      },
    })
    lifecycleService.applyInitialPlatformState()

    // Subscribe to live settings updates to keep lifecycle closeAction cache synchronized in real-time
    services.kvStoreService?.subscribe?.('app-state', (appState: any) => {
      if (appState?.settings?.headlessCloseAction) {
        lifecycleService?.setCachedCloseAction(appState.settings.headlessCloseAction)
      }
    })

    // Retry staging after host services exist. The first attempt can fail after a
    // hot update (native bridges / plugin activate) and is otherwise swallowed,
    // leaving generation 0 with nothing to commit.
    if (!coordinator.getPendingGeneration() && coordinator.getGeneration() <= 0) {
      try {
        await coordinator.ensurePrepared()
      } catch (err) {
        console.error('Failed to restage plugin runtime host after services initialized:', err)
      }
    }

    const devUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL
    const rendererPath = getRendererHtmlPath()
    const trustedUrls: string[] = []
    if (isDev && devUrl) {
      try {
        trustedUrls.push(devUrl)
      } catch {}
    }

    registerIpcHandlers(services, () => mainWindow, {
      trustedUrls,
      trustedFilePaths: [rendererPath],
    })
    registerPluginProtocol(services.pluginResourceService)

    isAppReadyForWindows = true

    if (!lifecycleService.isHeadless()) {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow(services)

        // Confirm healthy immediately when main window is ready
        mainWindow.once('ready-to-show', () => {
          try {
            services?.updateService?.confirmHealthy()
          } catch {}
        })
      }
    } else {
      // In headless mode, there is no renderer window to trigger the 3-runtime handshake.
      // Directly commit the prepared main process plugin generation so services, RPCs, and WebServer start.
      const pending = coordinator.getPendingGeneration()
      if (pending) {
        try {
          await coordinator.commitPrepared(pending.revision, pending.generation)
        } catch (err) {
          console.error('[Headless] Failed to commit initial plugin generation:', err)
        }
      }
    }

    // Process any second-instance activations queued during early startup
    if (pendingForegroundActivation) {
      pendingForegroundActivation = false
      void lifecycleService.transitionToForeground()
    }
    if (pendingHeadlessActivation) {
      pendingHeadlessActivation = false
      void lifecycleService.ensureWebServerRunning?.()
    }

    // Schedule 5-second health confirmation heartbeat fallback
    clearHealthTimer()
    healthCheckTimer = setTimeout(() => {
      healthCheckTimer = null
      try {
        services?.updateService?.confirmHealthy()
      } catch (err) {
        console.warn('[Main] Failed to confirm update health:', err)
      }
    }, 5000)
    healthCheckTimer.unref?.()

    // Auto-start Web Server after Main generation is committed (or immediately if active)
    const initWebServer = async () => {
      if (!services) return
      try {
        const kv = services.kvStoreService
        const appState = kv ? await kv.get('app-state') : undefined
        const loadError = (services.kvStoreService as any)?.getLoadError?.()
        if (loadError) {
          console.error('[WebServer] Refusing to start Web Server because settings failed to load:', loadError)
          return
        }
        if (appState?.settings && typeof appState.settings.preventSleep === 'boolean') {
          services.powerSaveService.setPreventSleepEnabled(appState.settings.preventSleep, true)
        }
        const plan = resolveWebServerStartupPlan(appState, isDev, {
          isHeadless: lifecycleService?.isHeadless(),
          cliPort: cliArgs.port,
          cliHost: cliArgs.host,
        })
        if (plan.configureConfig) {
          services.webServerService.configure(plan.configureConfig)
        }
        if (plan.startConfig) {
          void services.webServerService.start(plan.startConfig).then((status) => {
            if (status.running) {
              if (lifecycleService?.isHeadless()) {
                console.log(`[Headless] Web server listening at http://${status.host}:${status.port}`)
              }
            } else {
              console.error(`[Headless] Web server failed to start on port ${status.port}: ${status.error ?? 'Unknown error'}`)
            }
          }).catch((err) => {
            console.error('[Headless] Web server start error:', err)
          })
        }
      } catch (err) {
        console.error('[WebServer] Failed to initialize Web Server configuration:', err)
        if (!services) return
        if (isDev) {
          const fallbackConfig = resolveWebServerFallbackPlan(isDev)
          if (fallbackConfig) {
            void services.webServerService.start(fallbackConfig).then((status) => {
              if (status.running && lifecycleService?.isHeadless()) {
                console.log(`[Headless] Web server dev fallback listening at http://${status.host}:${status.port}`)
              }
            }).catch((fallbackErr) => {
              console.error('[Headless] Web server dev fallback start error:', fallbackErr)
            })
          }
        }
      }
    }

    if (coordinator.getGeneration() > 0 && !coordinator.getPendingGeneration()) {
      void initWebServer()
    } else {
      coordinator.onCommit(() => {
        void initWebServer()
      })
    }

    app.on('activate', () => {
      if (lifecycleService) {
        void lifecycleService.transitionToForeground()
        return
      }
      if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
        const appIcon = getAppIcon()
        if (appIcon) {
          app.dock.setIcon(appIcon)
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        if (!mainWindow.isVisible()) mainWindow.show()
        mainWindow.focus()
      } else if (services) {
        mainWindow = createWindow(services)
        clearHealthTimer()
        healthCheckTimer = setTimeout(() => {
          healthCheckTimer = null
          try {
            services?.updateService?.confirmHealthy()
          } catch (err) {
            console.warn('[Main] Failed to confirm update health:', err)
          }
        }, 5000)
        healthCheckTimer.unref?.()
      }
    })
  })

  let isShuttingDown = false
  let isShutdownComplete = false

  async function gracefulShutdown(code = 0): Promise<void> {
    if (isShuttingDown) return
    isShuttingDown = true
    isQuitting = true
    clearHealthTimer()

    try {
      await Promise.race([
        Promise.allSettled([
          services?.disposeAll?.(),
          pluginRuntimeHost?.dispose?.(),
        ]),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
    } catch (err) {
      console.error('[Main] Error during graceful shutdown:', err)
    } finally {
      isShutdownComplete = true
      app.exit(code)
    }
  }

  app.on('window-all-closed', () => {
    if (lifecycleService?.isHeadless()) {
      return // Keep running in headless background
    }
    void gracefulShutdown(0)
  })

  app.on('before-quit', (event) => {
    if (!isShutdownComplete) {
      event.preventDefault()
      void gracefulShutdown(0)
    }
  })

  // Handle termination signals for clean, bounded shutdown in background mode
  process.on('SIGINT', () => {
    void gracefulShutdown(0)
  })

  process.on('SIGTERM', () => {
    void gracefulShutdown(0)
  })
}

void bootstrap()
