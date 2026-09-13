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
let isQuitting = false
let healthCheckTimer: NodeJS.Timeout | null = null

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
    if (!isQuitting && services.trayService.isEnabled()) {
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
  if (app.isPackaged) {
    const activeEntry = resolveMainEntry(import.meta.url)
    if (activeEntry && path.resolve(activeEntry) !== path.resolve(__filename)) {
      try {
        await import(pathToFileURL(activeEntry).href)
        return
      } catch (err) {
        console.error('[Bootstrapper] Failed to load active updated asar entry, falling back to base entry:', err)
      }
    }
  }

  // Register privileged schemes before app ready
  registerPluginSchemesAsPrivileged()

  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    app.quit()
    return
  }

  app.on('second-instance', () => {
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
    }
  })

  app.whenReady().then(async () => {
    registerWin32AppUserModelId(app)
    if (process.platform === 'darwin' && app.dock) {
      const appIcon = getAppIcon()
      if (appIcon) {
        app.dock.setIcon(appIcon)
      }
    }

    const cpaVersion = typeof app.getVersion === 'function' ? app.getVersion() : '1.0.0'
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
    })

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

    mainWindow = createWindow(services)

    // Schedule 5-second health confirmation heartbeat
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
        if (appState?.settings && typeof appState.settings.preventSleep === 'boolean') {
          services.powerSaveService.setPreventSleepEnabled(appState.settings.preventSleep, true)
        }
        const plan = resolveWebServerStartupPlan(appState, isDev)
        if (plan.configureConfig) {
          services.webServerService.configure(plan.configureConfig)
        }
        if (plan.startConfig) {
          void services.webServerService.start(plan.startConfig)
        }
      } catch {
        if (!services) return
        const fallbackConfig = resolveWebServerFallbackPlan(isDev)
        if (fallbackConfig) {
          void services.webServerService.start(fallbackConfig)
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

  app.on('window-all-closed', () => {
    clearHealthTimer()
    if (services) {
      void services.disposeAll()
    }
    if (pluginRuntimeHost) {
      void pluginRuntimeHost.dispose()
    }
    app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    clearHealthTimer()
    if (services) {
      void services.disposeAll()
    }
    if (pluginRuntimeHost) {
      void pluginRuntimeHost.dispose()
    }
  })
}

void bootstrap()
