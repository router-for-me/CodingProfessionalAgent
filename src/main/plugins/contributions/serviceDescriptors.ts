import type { BrowserWindow } from 'electron'
import * as electron from 'electron'
import type { NativeEvent } from '../../../shared/types.js'
import type { ServiceDescriptor } from '@cpa/plugin-api'
import { FileService } from '../../services/fileService.js'
import { ProcessService } from '../../services/processService.js'
import { PtyService } from '../../services/ptyService.js'
import { WebSocketService } from '../../services/websocketService.js'
import { HttpService } from '../../services/httpService.js'
import { DialogService } from '../../services/dialogService.js'
import { WindowStateService } from '../../services/windowStateService.js'
import { TrayService } from '../../services/trayService.js'
import { WebServerService } from '../../services/webServerService.js'
import { BinaryService } from '../../services/binaryService.js'
import { EnvironmentWatcherService } from '../../services/environmentWatcherService.js'
import { ProfilingService } from '../../services/profilingService.js'
import { PowerSaveService } from '../../services/powerSaveService.js'
import { UpdateService } from '../../services/update/updateService.js'
import { NotificationBadgeService } from '../../services/notificationBadgeService.js'
import { GatewayDiscoveryService } from '../../services/gatewayDiscoveryService.js'
import { PluginResourceService } from '../resources/PluginResourceService.js'
import { PluginGraphManagementService } from '../management/PluginGraphManagementService.js'
import { getAppVersion } from '../../utils/version.js'

import type { MainPluginRuntimeHost } from '../runtime/MainPluginRuntimeHost.js'
import type { MainPluginActivationCoordinator } from '../runtime/MainPluginActivationCoordinator.js'
import type { PluginMetric } from '../../services/profilingAnalyzer.js'

export interface PlatformServiceDescriptorOptions {
    isDebug?: boolean
    sessionsDir?: string
    sessionDatabaseOptions?: any
    sessionService?: any
    getMainWindow?: () => BrowserWindow | null
    emitEvent?: (event: NativeEvent) => void
    pluginRuntimeHost?: MainPluginRuntimeHost
    pluginActivationCoordinator?: MainPluginActivationCoordinator
    pluginGraphManagementService?: PluginGraphManagementService
    homeDir?: string
    cpaVersion?: string
    getPluginMetrics?: () => Promise<PluginMetric[]> | PluginMetric[]
    pluginResourceService?: PluginResourceService
    updateService?: UpdateService
    notificationBadgeService?: NotificationBadgeService
    gatewayDiscoveryService?: GatewayDiscoveryService
    trayService?: TrayService
    isHeadless?: () => boolean
    onShowWindow?: () => void
}

export type CoreServiceDescriptorOptions = PlatformServiceDescriptorOptions

/**
 * Creates platform ServiceDescriptors with explicit dependency declarations and lifecycle hooks.
 */
export function createPlatformServiceDescriptors(
    options: PlatformServiceDescriptorOptions = {},
): readonly ServiceDescriptor<any>[] {
    const isDebug = options.isDebug ?? process.env.NODE_ENV === 'development'
    const getMainWindow = options.getMainWindow ?? (() => null)
    const emitEvent = options.emitEvent ?? (() => {})

    const descriptors: ServiceDescriptor<any>[] = [
        {
            id: 'fileService',
            dependencies: [],
            create: () => new FileService({ isDebug }),
        },
        {
            id: 'dialogService',
            dependencies: [],
            create: () => new DialogService(),
        },
        {
            id: 'binaryService',
            dependencies: [],
            create: () => {
                const binaryService = new BinaryService()
                binaryService.ensureBinaries()
                return binaryService
            },
        },
        {
            id: 'environmentWatcherService',
            dependencies: [],
            create: () => new EnvironmentWatcherService(emitEvent),
            dispose: (service: EnvironmentWatcherService) => {
                service.dispose()
            },
        },
        {
            id: 'profilingService',
            dependencies: [],
            create: () =>
                new ProfilingService({
                    isDebug,
                    getMainWindow,
                    getPluginMetrics:
                        options.getPluginMetrics ??
                        (options.pluginRuntimeHost ? () => options.pluginRuntimeHost!.getPluginMetrics() : undefined),
                }),
            dispose: (service: ProfilingService) => {
                service.dispose()
            },
        },
        {
            id: 'processService',
            dependencies: [],
            create: () => new ProcessService(emitEvent),
            dispose: (service: ProcessService) => {
                service.disposeAll()
            },
        },
        {
            id: 'ptyService',
            dependencies: [],
            create: () => new PtyService(emitEvent),
            dispose: (service: PtyService) => {
                service.disposeAll()
            },
        },
        {
            id: 'websocketService',
            dependencies: [],
            create: () => new WebSocketService(emitEvent),
            dispose: (service: WebSocketService) => {
                service.disposeAll()
            },
        },
        {
            id: 'httpService',
            dependencies: [],
            create: () => new HttpService(),
        },
        {
            id: 'pluginResourceService',
            dependencies: [],
            create: () => options.pluginResourceService ?? new PluginResourceService(),
        },
        {
            id: 'pluginActivationCoordinator',
            dependencies: [],
            create: () => options.pluginActivationCoordinator,
            dispose: (service: MainPluginActivationCoordinator | undefined) => {
                if (service) {
                    void service.dispose()
                }
            },
        },
        {
            id: 'pluginGraphManagementService',
            dependencies: ['pluginActivationCoordinator', 'pluginResourceService'],
            create: (ctx) => {
                if (options.pluginGraphManagementService) {
                    return options.pluginGraphManagementService
                }
                const coordinator =
                    options.pluginActivationCoordinator ??
                    ctx.get<MainPluginActivationCoordinator | undefined>('pluginActivationCoordinator')
                if (!coordinator) {
                    return null
                }
                const resourceService =
                    options.pluginResourceService ??
                    ctx.get<PluginResourceService>('pluginResourceService')

                let fallbackHomeDir = ''
                try {
                    const electronApp = Reflect.get(electron, 'app')
                    if (electronApp && typeof electronApp.getPath === 'function') {
                        fallbackHomeDir = electronApp.getPath('home')
                    }
                } catch {}
                if (!fallbackHomeDir) {
                    fallbackHomeDir = process.env.HOME || ''
                }

                let fallbackVersion = '1.0.0'
                try {
                    fallbackVersion = getAppVersion()
                } catch {}

                const homeDir = options.homeDir || fallbackHomeDir
                const cpaVersion = options.cpaVersion || fallbackVersion

                const service = new PluginGraphManagementService({
                    homeDir,
                    cpaVersion,
                    coordinator,
                    resourceService,
                })
                if (options.emitEvent) {
                    service.subscribe(() => {
                        options.emitEvent?.({
                            operationId: `evt-${Date.now()}`,
                            sequence: Date.now(),
                            kind: 'plugins:updated',
                        })
                    })
                }
                return service
            },
        },
        {
            id: 'windowStateService',
            dependencies: [],
            create: () => new WindowStateService(),
            dispose: (service: WindowStateService) => {
                service.dispose()
            },
        },
        {
            id: 'notificationBadgeService',
            dependencies: [],
            create: () => options.notificationBadgeService ?? new NotificationBadgeService(getMainWindow, emitEvent),
            dispose: (service: NotificationBadgeService) => {
                service.clearBadge()
            },
        },
        {
            id: 'trayService',
            dependencies: [],
            create: () => options.trayService ?? new TrayService(getMainWindow, isDebug, options.isHeadless, options.onShowWindow),
            dispose: (service: TrayService) => {
                service.dispose()
            },
        },
        {
            id: 'webServerService',
            dependencies: ['profilingService', 'pluginResourceService'],
            create: (ctx) => {
                const server = new WebServerService({ isDebug })
                const profiling = ctx.get<ProfilingService>('profilingService')
                const pluginResources = ctx.get<PluginResourceService>('pluginResourceService')

                server.setProfilingService(profiling)
                server.setPluginResourceService(pluginResources)

                // Client disconnect cleanup (session runs + capability grants) is wired in
                // registerIpcHandlers after the activation coordinator/broker are available.

                return server
            },
            dispose: (service: WebServerService) => {
                service.dispose()
            },
        },
        {
            id: 'gatewayDiscoveryService',
            dependencies: [],
            create: () => options.gatewayDiscoveryService ?? new GatewayDiscoveryService(),
        },
        {
            id: 'powerSaveService',
            dependencies: [],
            create: () => new PowerSaveService(),
            dispose: (service: PowerSaveService) => {
                service.dispose()
            },
        },
        {
            id: 'updateService',
            dependencies: [],
            create: () =>
                options.updateService ??
                new UpdateService({
                    currentVersion: options.cpaVersion,
                    emitEvent,
                }),
            dispose: (service: UpdateService) => {
                service.dispose()
            },
        },
    ]

    return Object.freeze(descriptors)
}
