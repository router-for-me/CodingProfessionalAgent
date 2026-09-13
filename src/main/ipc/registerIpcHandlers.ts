import { BrowserWindow, ipcMain, app } from 'electron'
import type {
  NativeEvent,
} from '../../shared/types.js'
import {
  PluginCapabilityError,
  type CapabilityHandle,
  type CapabilityInvocationContext,
  type RpcInvocationContext,
} from '@cpa/plugin-api'
import { FileService } from '../services/fileService.js'
import { ProcessService } from '../services/processService.js'
import { PtyService } from '../services/ptyService.js'
import { WebSocketService } from '../services/websocketService.js'
import { HttpService } from '../services/httpService.js'
import { DialogService } from '../services/dialogService.js'
import { WindowStateService } from '../services/windowStateService.js'
import { TrayService } from '../services/trayService.js'
import { WebServerService } from '../services/webServerService.js'
import { BinaryService } from '../services/binaryService.js'
import { EnvironmentWatcherService } from '../services/environmentWatcherService.js'
import { ProfilingService } from '../services/profilingService.js'
import { PowerSaveService } from '../services/powerSaveService.js'
import { UpdateService } from '../services/update/updateService.js'
import { NotificationBadgeService } from '../services/notificationBadgeService.js'
import { PluginResourceService } from '../plugins/resources/PluginResourceService.js'
import { MainContributionRegistry } from '../plugins/contributions/MainContributionRegistry.js'
import { createPlatformServiceDescriptors } from '../plugins/contributions/serviceDescriptors.js'
import { createPlatformRpcDescriptors } from '../plugins/contributions/rpcDescriptors.js'
import {
  registerCapabilityTransport,
  type RegisterCapabilityTransportOptions,
} from './registerCapabilityTransport.js'
import { extractTrustedInvocationContext } from './extractTrustedContext.js'
import { RENDERER_CAPABILITY_DESCRIPTORS } from '../../shared/capabilityDescriptors.js'

import type { MainPluginRuntimeHost } from '../plugins/runtime/MainPluginRuntimeHost.js'
import type { MainPluginActivationCoordinator } from '../plugins/runtime/MainPluginActivationCoordinator.js'
import type { PluginGraphManagementService } from '../plugins/management/PluginGraphManagementService.js'

export interface CreateServicesOptions {
  isDebug?: boolean
  homeDir?: string
  cpaVersion?: string
  sessionsDir?: string
  sessionDatabaseOptions?: any
  sessionService?: any
  pluginRuntimeHost?: MainPluginRuntimeHost
  pluginActivationCoordinator?: MainPluginActivationCoordinator
  pluginResourceService?: PluginResourceService
  pluginGraphManagementService?: PluginGraphManagementService
  updateService?: UpdateService
  notificationBadgeService?: NotificationBadgeService
}

export interface AppServices {
  fileService: FileService
  processService: ProcessService
  ptyService: PtyService
  websocketService: WebSocketService
  httpService: HttpService
  kvStoreService?: any
  sessionService?: any
  sessionRunRegistry?: any
  dialogService: DialogService
  windowStateService: WindowStateService
  notificationBadgeService: NotificationBadgeService
  trayService: TrayService
  webServerService: WebServerService
  pluginResourceService: PluginResourceService
  binaryService: BinaryService
  environmentWatcherService: EnvironmentWatcherService
  profilingService: ProfilingService
  powerSaveService: PowerSaveService
  updateService: UpdateService
  registry: MainContributionRegistry
  pluginRuntimeHost?: MainPluginRuntimeHost
  pluginActivationCoordinator?: MainPluginActivationCoordinator
  pluginGraphManagementService?: PluginGraphManagementService
  handleMethod(method: string, args: unknown[], context?: RpcInvocationContext): Promise<unknown>
  disposeAll(): Promise<void> | void
}

export function sendNativeEventToWindow(
  win: BrowserWindow | null,
  event: NativeEvent,
): void {
  if (!win || win.isDestroyed?.()) return

  const webContents = win.webContents
  if (!webContents || webContents.isDestroyed?.()) return

  try {
    // WebContents can survive a renderer crash or a detached main frame.
    // Electron logs disposed-frame send errors internally instead of throwing.
    if (webContents.isCrashed?.() || webContents.mainFrame?.detached) return
    webContents.send('cpa:native', event)
  } catch {
    // Renderer teardown can race with WebContents.send after lifecycle checks.
  }
}

export function createServices(
  getMainWindow: () => BrowserWindow | null,
  options?: CreateServicesOptions,
): AppServices {
  const isDebug =
    options?.isDebug ??
    (typeof app !== 'undefined' && app?.isPackaged !== undefined
      ? !app.isPackaged || process.env.NODE_ENV === 'development'
      : process.env.NODE_ENV === 'development')

  const registry = new MainContributionRegistry({
    contributionRegistry: options?.pluginRuntimeHost?.contributionRegistry,
    capabilityBroker: options?.pluginRuntimeHost?.capabilityBroker,
  })

  const emitEvent = (event: NativeEvent) => {
    if (event.sourceClientId !== 'desktop-main') {
      sendNativeEventToWindow(getMainWindow(), event)
    }
    options?.pluginRuntimeHost?.capabilityBroker?.emit('native-event', event)
    if (event.kind === 'update:status-changed') {
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        options?.pluginRuntimeHost?.capabilityBroker?.emit('update:status-changed', payload)
      } catch {
        options?.pluginRuntimeHost?.capabilityBroker?.emit('update:status-changed', event.data)
      }
    }
    if (registry.hasService('webServerService')) {
      const webServer = registry.getService<WebServerService>('webServerService')
      webServer.broadcastEvent(event, event.sourceClientId)
    }
    if (event.kind === 'session:run-status' && event.data) {
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (payload?.sessionId && payload?.status && registry.hasService('powerSaveService')) {
          registry.getService<PowerSaveService>('powerSaveService').handleRunStatus(
            payload.sessionId,
            payload.status,
            payload.clientId,
          )
        }
      } catch {}
    }
    if (event.kind === 'session:subagent-state' && event.data) {
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (Array.isArray(payload?.agents) && registry.hasService('powerSaveService')) {
          const powerService = registry.getService<PowerSaveService>('powerSaveService')
          for (const agent of payload.agents) {
            if (agent?.id && agent?.status) {
              powerService.handleSubAgentStatus(agent.id, agent.status)
            }
          }
        }
      } catch {}
    }
  }

  const SESSION_EVENT_NAMES = [
    'session:created',
    'session:updated',
    'session:deleted',
    'session:meta-updated',
    'session:entries-updated',
    'session:run-status',
    'session:stream-event',
    'session:subagent-state',
    'session:active-runs',
    'session:resume-prompt-state',
    'session:resume-prompt-action',
    'session:resume-prompt-sync',
    'session:abort-run',
    'session:delegate-run',
    'projects:updated',
  ]
  if (options?.pluginRuntimeHost?.eventBus) {
    for (const name of SESSION_EVENT_NAMES) {
      options.pluginRuntimeHost.eventBus.on(name, (event: any) => {
        if (event && typeof event === 'object' && typeof event.kind === 'string') {
          emitEvent(event)
        }
      })
    }
  }

  const serviceDescriptors = createPlatformServiceDescriptors({
    isDebug,
    homeDir: options?.homeDir,
    cpaVersion: options?.cpaVersion,
    sessionsDir: options?.sessionsDir,
    sessionDatabaseOptions: options?.sessionDatabaseOptions,
    sessionService: options?.sessionService,
    getMainWindow,
    emitEvent,
    pluginRuntimeHost: options?.pluginRuntimeHost,
    pluginActivationCoordinator: options?.pluginActivationCoordinator,
    pluginResourceService: options?.pluginResourceService,
    pluginGraphManagementService: options?.pluginGraphManagementService,
    updateService: options?.updateService,
    notificationBadgeService: options?.notificationBadgeService,
  })

  for (const descriptor of serviceDescriptors) {
    registry.registerService(descriptor)
  }

  registry.createServicesSync()

  const rpcDescriptors = createPlatformRpcDescriptors({
    getService: <T>(serviceId: string) => registry.getService<T>(serviceId),
    getMainWindow,
    emitEvent,
  })

  for (const descriptor of rpcDescriptors) {
    registry.registerRpc(descriptor)
  }

  const webServerService = registry.getService<WebServerService>('webServerService')
  const capabilityBroker = options?.pluginRuntimeHost?.capabilityBroker

  const toWebCapabilityContext = (
    context?: RpcInvocationContext,
  ): CapabilityInvocationContext => {
    const clientId = context?.clientId
    return {
      // pluginId is resolved from the bound handle during broker invoke/redeem
      pluginId: '',
      senderId: context?.senderId ?? 0,
      frameUrl: context?.frameUrl ?? '',
      transport: 'web',
      runtime: context?.runtime ?? 'renderer',
      processId: context?.processId,
      routingId: context?.routingId,
      documentId: context?.documentId ?? (clientId ? `web:${clientId}` : undefined),
      clientId,
    }
  }

  webServerService.setRpcDispatcher(async (method: string, args: unknown[], context?: RpcInvocationContext) => {
    if (capabilityBroker && method === 'capability:grant') {
      const ticket =
        typeof args[0] === 'string'
          ? args[0]
          : typeof args[0] === 'object' && args[0] !== null && 'ticket' in (args[0] as object)
            ? String((args[0] as { ticket: unknown }).ticket ?? '')
            : ''
      if (!ticket.trim()) {
        throw new PluginCapabilityError('Invalid capability grant request: ticket is required')
      }
      const handle = capabilityBroker.redeemGrantTicket(ticket, toWebCapabilityContext(context))
      return { ok: true, value: handle as string }
    }

    if (capabilityBroker && method === 'capability:invoke') {
      const payload = args[0] as
        | { handle?: unknown; method?: unknown; args?: unknown }
        | undefined
      const handle =
        typeof payload?.handle === 'string'
          ? payload.handle
          : typeof args[0] === 'string'
            ? args[0]
            : ''
      const invokeMethod =
        typeof payload?.method === 'string'
          ? payload.method
          : typeof args[1] === 'string'
            ? args[1]
            : ''
      const invokeArgs = Array.isArray(payload?.args)
        ? payload.args
        : Array.isArray(args[2])
          ? args[2]
          : []

      if (!handle.trim() || !invokeMethod.trim()) {
        throw new PluginCapabilityError('Invalid capability invoke request payload')
      }

      return capabilityBroker.invoke(
        handle as CapabilityHandle,
        invokeMethod,
        invokeArgs,
        toWebCapabilityContext(context),
      )
    }

    return registry.dispatchRpc(method, args, context)
  })

  webServerService.setOnClientDisconnect((clientId: string) => {
    try {
      if (registry.hasService('sessionRunRegistry')) {
        registry.getService<any>('sessionRunRegistry')?.cleanupClientRuns?.(clientId)
      }
      if (registry.hasService('powerSaveService')) {
        registry.getService<PowerSaveService>('powerSaveService')?.cleanupClient?.(clientId)
      }
    } catch {
      // Session run registry may be unavailable during early startup/shutdown.
    }
    const docKey = `web:${clientId}`
    options?.pluginActivationCoordinator?.clearDocumentIssuance?.(docKey)
    capabilityBroker?.revokeClient?.(clientId)
  })

  const services: AppServices = {
    fileService: registry.getService<FileService>('fileService'),
    processService: registry.getService<ProcessService>('processService'),
    ptyService: registry.getService<PtyService>('ptyService'),
    websocketService: registry.getService<WebSocketService>('websocketService'),
    httpService: registry.getService<HttpService>('httpService'),
    get kvStoreService() {
      if (registry.hasService('kvStoreService')) {
        return registry.getService<any>('kvStoreService')
      }
      return (options as any)?.kvStoreService
    },
    get sessionService() {
      if (registry.hasService('sessionService')) {
        return registry.getService<any>('sessionService')
      }
      return options?.sessionService
    },
    get sessionRunRegistry() {
      if (registry.hasService('sessionRunRegistry')) {
        return registry.getService<any>('sessionRunRegistry')
      }
      return undefined
    },
    dialogService: registry.getService<DialogService>('dialogService'),
    pluginResourceService: registry.getService<PluginResourceService>('pluginResourceService'),
    windowStateService: registry.getService<WindowStateService>('windowStateService'),
    notificationBadgeService: registry.getService<NotificationBadgeService>('notificationBadgeService'),
    trayService: registry.getService<TrayService>('trayService'),
    webServerService,
    binaryService: registry.getService<BinaryService>('binaryService'),
    environmentWatcherService: registry.getService<EnvironmentWatcherService>('environmentWatcherService'),
    profilingService: registry.getService<ProfilingService>('profilingService'),
    powerSaveService: registry.getService<PowerSaveService>('powerSaveService'),
    updateService: registry.getService<UpdateService>('updateService'),
    registry,
    pluginRuntimeHost: options?.pluginRuntimeHost,
    pluginActivationCoordinator: options?.pluginActivationCoordinator,
    get pluginGraphManagementService() {
      if (registry.hasService('pluginGraphManagementService')) {
        return registry.getService<PluginGraphManagementService>('pluginGraphManagementService')
      }
      return undefined
    },
    handleMethod(method: string, args: unknown[], context?: RpcInvocationContext): Promise<unknown> {
      return registry.dispatchRpc(method, args, context)
    },
    disposeAll() {
      if (options?.pluginActivationCoordinator) {
        void options.pluginActivationCoordinator.dispose()
      } else if (options?.pluginRuntimeHost) {
        void options.pluginRuntimeHost.dispose()
      }
      return registry.disposeAll()
    },
  }

  return services
}

export function attachMainWindowListeners(win: BrowserWindow, services: AppServices): void {
  if (!win || win.isDestroyed?.()) return
  const webContents = win.webContents
  if (!webContents || webContents.isDestroyed?.()) return

  if (typeof win.on === 'function') {
    services.notificationBadgeService?.attachWindow?.(win)
  }

  const cleanup = () => {
    try {
      const runRegistry = services.sessionRunRegistry
      if (runRegistry && typeof runRegistry.cleanupClientRuns === 'function') {
        runRegistry.cleanupClientRuns('desktop-main')
      }
      services.powerSaveService?.cleanupClient?.('desktop-main')
    } catch (err) {
      console.warn('Warning: failed to cleanup client runs:', err)
    }
    services.pluginActivationCoordinator?.clearSenderIssuance(webContents.id)
    services.pluginRuntimeHost?.capabilityBroker?.revokeSender(webContents.id)
  }
  const handleRenderProcessGone = (
    _event: unknown,
    details: { reason?: string },
  ) => {
    cleanup()
    if (
      details.reason === 'clean-exit' ||
      win.isDestroyed?.() ||
      webContents.isDestroyed?.()
    ) {
      return
    }
    try {
      webContents.reload()
    } catch {
      // Window teardown can race with renderer recovery.
    }
  }

  webContents.once('destroyed', cleanup)
  webContents.on('render-process-gone', handleRenderProcessGone)
}

export function registerIpcHandlers(
  services: AppServices,
  getMainWindow: () => BrowserWindow | null,
  options?: Partial<RegisterCapabilityTransportOptions>,
): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed?.()) {
    attachMainWindowListeners(win, services)
  }

  const broker = services.pluginRuntimeHost?.capabilityBroker ?? services.registry?.capabilityBroker
  if (broker) {
    registerCapabilityTransport({
      broker,
      services,
      getMainWindow,
      ...options,
    })
  }
}
