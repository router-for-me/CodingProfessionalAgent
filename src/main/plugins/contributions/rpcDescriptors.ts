import type { BrowserWindow } from 'electron'
import type {
    HttpRequest,
    NativeEvent,
    ProcessStartRequest,
    PtyStartRequest,
    WebServerSettings,
    WebSocketOpenRequest,
} from '../../../shared/types.js'
import type { RpcDescriptor, RpcInvocationContext } from '@cpa/plugin-api'
import type { FileService } from '../../services/fileService.js'
import type { ProcessService } from '../../services/processService.js'
import type { PtyService } from '../../services/ptyService.js'
import type { WebSocketService } from '../../services/websocketService.js'
import type { HttpService } from '../../services/httpService.js'
import type { DialogService } from '../../services/dialogService.js'
import type { TrayService, TrayLocale } from '../../services/trayService.js'
import type { PowerSaveService } from '../../services/powerSaveService.js'
import type { WebServerService } from '../../services/webServerService.js'
import type { NotificationBadgeService } from '../../services/notificationBadgeService.js'
import type { EnvironmentWatcherService } from '../../services/environmentWatcherService.js'
import type { ProfilingService } from '../../services/profilingService.js'
import type { UpdateService } from '../../services/update/updateService.js'
import type { GatewayDiscoveryService } from '../../services/gatewayDiscoveryService.js'
import { getRequiredCapabilityForMethod } from '../../../shared/capabilityDescriptors.js'

export interface PlatformRpcDescriptorOptions {
    getService?: <T>(serviceId: string) => T
    getMainWindow?: () => BrowserWindow | null
    emitEvent?: (event: NativeEvent) => void
}

export type CoreRpcDescriptorOptions = PlatformRpcDescriptorOptions

/**
 * Creates the complete list of platform RpcDescriptors with IPC channel bindings and RPC aliases.
 */
export function createPlatformRpcDescriptors(
    options: PlatformRpcDescriptorOptions = {},
): readonly RpcDescriptor[] {
    const getService = <T>(serviceId: string, context?: RpcInvocationContext): T => {
        if (options.getService) {
            return options.getService<T>(serviceId)
        }
        if ((context as any)?.getService) {
            return (context as any).getService(serviceId) as T
        }
        throw new Error(`Cannot resolve service "${serviceId}"`)
    }

    const getServiceOptional = <T>(serviceId: string, context?: RpcInvocationContext): T | null => {
        try {
            return getService<T>(serviceId, context)
        } catch {
            return null
        }
    }

    const emitEvent = (event: NativeEvent, context?: RpcInvocationContext): void => {
        if (options.emitEvent) {
            options.emitEvent(event)
        } else if (typeof (context as any)?.emitEvent === 'function') {
            (context as any).emitEvent(event)
        }
    }

    const getMainWindow = (): BrowserWindow | null => {
        if (options.getMainWindow) {
            return options.getMainWindow()
        }
        return null
    }

    const cap = (method: string, fallback: string = 'system.general'): string =>
        getRequiredCapabilityForMethod(method) ?? fallback

    const descriptors: RpcDescriptor[] = [
        // File & OS
        {
            method: 'native:runtimeInfo',
            aliases: ['RuntimeInfo'],
            ipcChannel: 'native:runtimeInfo',
            capability: cap('native:runtimeInfo', 'filesystem.read'),
            invoke: async (context) => getService<FileService>('fileService', context).getRuntimeInfo(),
        },
        {
            method: 'native:readFile',
            aliases: ['ReadFile'],
            ipcChannel: 'native:readFile',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).readFile(args[0] as string),
        },
        {
            method: 'native:readFileIfExists',
            aliases: ['ReadFileIfExists'],
            ipcChannel: 'native:readFileIfExists',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).readFileIfExists(args[0] as string),
        },
        {
            method: 'native:fileExists',
            aliases: ['FileExists'],
            ipcChannel: 'native:fileExists',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).fileExists(args[0] as string),
        },
        {
            method: 'native:getProjectEnvironment',
            aliases: ['GetProjectEnvironment'],
            ipcChannel: 'native:getProjectEnvironment',
            capability: 'environment.read',
            invoke: async (context, args) =>
                getService<EnvironmentWatcherService>(
                    'environmentWatcherService',
                    context,
                ).getProjectEnvironment(args[0] as string),
        },
        {
            method: 'native:watchProjectEnvironments',
            aliases: ['WatchProjectEnvironments'],
            ipcChannel: 'native:watchProjectEnvironments',
            capability: 'environment.watch',
            invoke: async (context, args) =>
                getService<EnvironmentWatcherService>(
                    'environmentWatcherService',
                    context,
                ).watchProjects(args[0] as string[]),
        },
        {
            method: 'native:invalidateEnvironmentCache',
            aliases: ['InvalidateEnvironmentCache'],
            ipcChannel: 'native:invalidateEnvironmentCache',
            capability: 'environment.manage',
            invoke: async (context, args) => {
                getService<EnvironmentWatcherService>(
                    'environmentWatcherService',
                    context,
                ).invalidateCache(args[0] as string | undefined)
            },
        },
        {
            method: 'native:writeFile',
            aliases: ['WriteFile'],
            ipcChannel: 'native:writeFile',
            capability: 'filesystem.write',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).writeFile(
                    args[0] as string,
                    args[1] as string,
                ),
        },
        {
            method: 'native:mkdirAll',
            aliases: ['MkdirAll'],
            ipcChannel: 'native:mkdirAll',
            capability: 'filesystem.write',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).mkdirAll(args[0] as string),
        },
        {
            method: 'native:removeFile',
            aliases: ['RemoveFile'],
            ipcChannel: 'native:removeFile',
            capability: 'filesystem.write',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).removeFile(args[0] as string),
        },
        {
            method: 'native:removeDir',
            aliases: ['RemoveDir'],
            ipcChannel: 'native:removeDir',
            capability: 'filesystem.write',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).removeDir(args[0] as string),
        },
        {
            method: 'native:stat',
            aliases: ['Stat'],
            ipcChannel: 'native:stat',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).stat(args[0] as string),
        },
        {
            method: 'native:readDir',
            aliases: ['ReadDir'],
            ipcChannel: 'native:readDir',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).readDir(args[0] as string),
        },
        {
            method: 'native:realPath',
            aliases: ['RealPath'],
            ipcChannel: 'native:realPath',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).realPath(args[0] as string),
        },
        {
            method: 'native:lookPath',
            aliases: ['LookPath'],
            ipcChannel: 'native:lookPath',
            capability: 'filesystem.read',
            invoke: async (context, args) =>
                getService<FileService>('fileService', context).lookPath(args[0] as string),
        },

        // Dialog & Reveal & Clipboard
        {
            method: 'native:selectProjectDirectory',
            aliases: ['SelectProjectDirectory'],
            ipcChannel: 'native:selectProjectDirectory',
            capability: 'dialog.open',
            invoke: async (context, args) =>
                getService<DialogService>('dialogService', context).selectProjectDirectory(
                    args[0] as string,
                    getMainWindow(),
                ),
        },
        {
            method: 'native:selectFilesAndFolders',
            aliases: ['SelectFilesAndFolders'],
            ipcChannel: 'native:selectFilesAndFolders',
            capability: 'dialog.open',
            invoke: async (context, args) =>
                getService<DialogService>('dialogService', context).selectFilesAndFolders(
                    args[0] as string,
                    getMainWindow(),
                ),
        },
        {
            method: 'native:revealInFileManager',
            aliases: ['RevealInFileManager'],
            ipcChannel: 'native:revealInFileManager',
            capability: 'dialog.open',
            invoke: async (context, args) =>
                getService<DialogService>('dialogService', context).revealInFileManager(
                    args[0] as string,
                ),
        },
        {
            method: 'native:clipboardSetText',
            aliases: ['ClipboardSetText'],
            ipcChannel: 'native:clipboardSetText',
            capability: 'clipboard.write',
            invoke: async (context, args) =>
                getService<DialogService>('dialogService', context).clipboardSetText(
                    args[0] as string,
                ),
        },
        {
            method: 'native:clipboardGetText',
            aliases: ['ClipboardGetText'],
            ipcChannel: 'native:clipboardGetText',
            capability: 'clipboard.read',
            invoke: async (context) =>
                getService<DialogService>('dialogService', context).clipboardGetText(),
        },
        {
            method: 'dialog:saveFile',
            aliases: ['DialogSaveFile', 'SaveFile'],
            ipcChannel: 'dialog:saveFile',
            capability: 'dialog.save',
            invoke: async (context, args) =>
                getService<DialogService>('dialogService', context).saveFile(
                    args[0] as {
                        defaultPath?: string
                        title?: string
                        content: string
                        filters?: Array<{ name: string; extensions: string[] }>
                    },
                    getMainWindow(),
                ),
        },

        // Profiling
        {
            method: 'profiling:start',
            aliases: ['ProfilingStart'],
            ipcChannel: 'profiling:start',
            capability: 'profiling.manage',
            invoke: async (context, args) =>
                getService<ProfilingService>('profilingService', context).start(
                    args[0] as Parameters<ProfilingService['start']>[0],
                ),
        },
        {
            method: 'profiling:stop',
            aliases: ['ProfilingStop'],
            ipcChannel: 'profiling:stop',
            capability: 'profiling.manage',
            invoke: async (context) =>
                getService<ProfilingService>('profilingService', context).stop(),
        },
        {
            method: 'profiling:getStatus',
            aliases: ['ProfilingGetStatus'],
            ipcChannel: 'profiling:getStatus',
            capability: 'profiling.read',
            invoke: async (context) =>
                getService<ProfilingService>('profilingService', context).getStatus(),
        },
        {
            method: 'profiling:getReport',
            aliases: ['ProfilingGetReport'],
            ipcChannel: 'profiling:getReport',
            capability: 'profiling.read',
            invoke: async (context) =>
                getService<ProfilingService>('profilingService', context).getLastReport(),
        },

        // Process & PTY
        {
            method: 'native:startProcess',
            aliases: ['StartProcess'],
            ipcChannel: 'native:startProcess',
            capability: 'process.spawn',
            invoke: async (context, args) =>
                getService<ProcessService>('processService', context).startProcess(
                    args[0] as ProcessStartRequest,
                ),
        },
        {
            method: 'native:runProcess',
            aliases: ['RunProcess'],
            ipcChannel: 'native:runProcess',
            capability: 'process.spawn',
            invoke: async (context, args) =>
                getService<ProcessService>('processService', context).runProcess(
                    args[0] as ProcessStartRequest,
                ),
        },
        {
            method: 'native:startPty',
            aliases: ['StartPty'],
            ipcChannel: 'native:startPty',
            capability: 'pty.spawn',
            invoke: async (context, args) =>
                getService<PtyService>('ptyService', context).startPty(args[0] as PtyStartRequest),
        },
        {
            method: 'native:writePty',
            aliases: ['WritePty'],
            ipcChannel: 'native:writePty',
            capability: 'pty.write',
            invoke: async (context, args) =>
                getService<PtyService>('ptyService', context).writePty(
                    args[0] as string,
                    args[1] as string,
                ),
        },
        {
            method: 'native:resizePty',
            aliases: ['ResizePty'],
            ipcChannel: 'native:resizePty',
            capability: 'pty.resize',
            invoke: async (context, args) =>
                getService<PtyService>('ptyService', context).resizePty(
                    args[0] as string,
                    args[1] as number,
                    args[2] as number,
                ),
        },
        {
            method: 'native:closePty',
            aliases: ['ClosePty'],
            ipcChannel: 'native:closePty',
            capability: 'pty.close',
            invoke: async (context, args) =>
                getService<PtyService>('ptyService', context).closePty(args[0] as string),
        },

        // WebSocket
        {
            method: 'native:openWebSocket',
            aliases: ['OpenWebSocket'],
            ipcChannel: 'native:openWebSocket',
            capability: 'network.websocket',
            invoke: async (context, args) =>
                getService<WebSocketService>('websocketService', context).openWebSocket(
                    args[0] as WebSocketOpenRequest,
                ),
        },
        {
            method: 'native:sendWebSocket',
            aliases: ['SendWebSocket'],
            ipcChannel: 'native:sendWebSocket',
            capability: 'network.websocket',
            invoke: async (context, args) =>
                getService<WebSocketService>('websocketService', context).sendWebSocket(
                    args[0] as string,
                    args[1] as string,
                ),
        },
        {
            method: 'native:cancelOperation',
            aliases: ['CancelOperation'],
            ipcChannel: 'native:cancelOperation',
            capability: 'process.cancel',
            invoke: async (context, args) => {
                getService<ProcessService>('processService', context).cancelOperation(
                    args[0] as string,
                )
                getService<WebSocketService>('websocketService', context).cancelOperation(
                    args[0] as string,
                )
            },
        },

        // HTTP
        {
            method: 'http:request',
            aliases: ['HttpRequest'],
            ipcChannel: 'http:request',
            capability: 'network.http',
            invoke: async (context, args) =>
                getService<HttpService>('httpService', context).request(args[0] as HttpRequest),
        },

        // Tray
        {
            method: 'tray:setEnabled',
            aliases: ['SetTrayEnabled'],
            ipcChannel: 'tray:setEnabled',
            capability: 'tray.manage',
            invoke: async (context, args) =>
                getService<TrayService>('trayService', context).setEnabled(
                    args[0] as boolean,
                    args[1] as TrayLocale | undefined,
                ),
        },
        {
            method: 'tray:setLocale',
            aliases: ['SetTrayLocale'],
            ipcChannel: 'tray:setLocale',
            capability: 'tray.manage',
            invoke: async (context, args) =>
                getService<TrayService>('trayService', context).setLocale(args[0] as TrayLocale),
        },

        // Notification & Badge
        {
            method: 'notification:taskCompleted',
            aliases: ['NotificationTaskCompleted'],
            ipcChannel: 'notification:taskCompleted',
            capability: cap('notification:taskCompleted', 'notification.show'),
            invoke: async (context, args) => {
                const payload = args[0] as { sessionId: string; sessionTitle?: string }
                getService<NotificationBadgeService>('notificationBadgeService', context).notifyTaskCompleted(payload)
            },
        },
        {
            method: 'notification:clearBadge',
            aliases: ['NotificationClearBadge'],
            ipcChannel: 'notification:clearBadge',
            capability: cap('notification:clearBadge', 'notification.manage'),
            invoke: async (context) => {
                getService<NotificationBadgeService>('notificationBadgeService', context).clearBadge()
            },
        },

        // Power / Sleep
        {
            method: 'power:setPreventSleep',
            aliases: ['SetPreventSleep'],
            ipcChannel: 'power:setPreventSleep',
            capability: 'power.manage',
            invoke: async (context, args) => {
                const raw = args[0]
                const enabled = typeof raw === 'boolean' ? raw : raw !== 'false' && Boolean(raw)
                getService<PowerSaveService>('powerSaveService', context).setPreventSleepEnabled(enabled)
            },
        },
        {
            method: 'power:getPreventSleep',
            aliases: ['GetPreventSleep'],
            ipcChannel: 'power:getPreventSleep',
            capability: 'power.read',
            invoke: async (context) =>
                getService<PowerSaveService>('powerSaveService', context).isPreventSleepEnabled(),
        },

        // WebServer
        {
            method: 'webserver:start',
            aliases: ['WebServerStart'],
            ipcChannel: 'webserver:start',
            capability: 'webserver.manage',
            invoke: async (context, args) =>
                getService<WebServerService>('webServerService', context).start(
                    args[0] as Partial<WebServerSettings> | undefined,
                ),
        },
        {
            method: 'webserver:stop',
            aliases: ['WebServerStop'],
            ipcChannel: 'webserver:stop',
            capability: 'webserver.manage',
            invoke: async (context) =>
                getService<WebServerService>('webServerService', context).stop(),
        },
        {
            method: 'webserver:getStatus',
            aliases: ['WebServerGetStatus'],
            ipcChannel: 'webserver:getStatus',
            capability: 'webserver.read',
            invoke: async (context) =>
                getService<WebServerService>('webServerService', context).getStatus(),
        },

        // Plugins
        {
            method: 'plugins:list',
            aliases: ['PluginsList'],
            ipcChannel: 'plugins:list',
            capability: 'plugins.read',
            invoke: async (context) => {
                try {
                    const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                    if (managementService?.list) {
                        return managementService.list()
                    }
                    const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                    return {
                        plugins: [],
                        activeRevision: coordinator?.getRevision?.() ?? '',
                        generation: coordinator?.getGeneration?.() ?? 0,
                    }
                } catch (err: any) {
                    return { plugins: [], activeRevision: '', generation: 0, error: err.message }
                }
            },
        },
        {
            method: 'plugins:getGraph',
            aliases: ['PluginsGetGraph'],
            ipcChannel: 'plugins:getGraph',
            capability: 'plugins.read',
            invoke: async (context) => {
                try {
                    const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                    if (coordinator?.getGraphDTO) {
                        return coordinator.getGraphDTO() ?? null
                    }
                    const host = getServiceOptional<any>('pluginRuntimeHost', context)
                    return host?.getGraphDTO?.() ?? null
                } catch {
                    return null
                }
            },
        },
        {
            method: 'plugins:getPreparedState',
            aliases: ['PluginsGetPreparedState'],
            ipcChannel: 'plugins:getPreparedState',
            capability: 'plugins.read',
            invoke: async (context) => {
                const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                if (!coordinator) {
                    return null
                }
                if (typeof coordinator.ensurePrepared === 'function') {
                    await coordinator.ensurePrepared()
                }
                return coordinator.getPreparedState?.(context) ?? null
            },
        },
        {
            method: 'plugins:prepareEnable',
            aliases: ['PluginsPrepareEnable'],
            ipcChannel: 'plugins:prepareEnable',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (!managementService) {
                    throw new Error('pluginGraphManagementService is unavailable')
                }
                return managementService.prepareEnable(
                    args[0] as string,
                    args[1] as Record<string, unknown> | undefined,
                    context,
                )
            },
        },
        {
            method: 'plugins:prepareDisable',
            aliases: ['PluginsPrepareDisable'],
            ipcChannel: 'plugins:prepareDisable',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (!managementService) {
                    throw new Error('pluginGraphManagementService is unavailable')
                }
                return managementService.prepareDisable(
                    args[0] as string,
                    args[1] as Record<string, unknown> | undefined,
                    context,
                )
            },
        },
        {
            method: 'plugins:prepareReload',
            aliases: ['PluginsPrepareReload'],
            ipcChannel: 'plugins:prepareReload',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (!managementService) {
                    throw new Error('pluginGraphManagementService is unavailable')
                }
                return managementService.prepareReload(
                    args[0] as string,
                    args[1] as Record<string, unknown> | undefined,
                    context,
                )
            },
        },
        {
            method: 'plugins:prepareInstall',
            aliases: ['PluginsPrepareInstall'],
            ipcChannel: 'plugins:prepareInstall',
            capability: 'plugins.install',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (!managementService) {
                    throw new Error('pluginGraphManagementService is unavailable')
                }
                return managementService.prepareInstall(
                    args[0] as string,
                    args[1] as Record<string, unknown> | undefined,
                    context,
                )
            },
        },
        {
            method: 'plugins:prepareUninstall',
            aliases: ['PluginsPrepareUninstall'],
            ipcChannel: 'plugins:prepareUninstall',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (!managementService) {
                    throw new Error('pluginGraphManagementService is unavailable')
                }
                return managementService.prepareUninstall(
                    args[0] as string,
                    args[1] as Record<string, unknown> | undefined,
                    context,
                )
            },
        },
        {
            method: 'plugins:prepareConfig',
            aliases: ['PluginsPrepareConfig'],
            ipcChannel: 'plugins:prepareConfig',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (managementService?.prepareDurableConfig) {
                    await managementService.prepareDurableConfig(args[0] as string | undefined)
                    return { ok: true }
                }
                return { ok: true }
            },
        },
        {
            method: 'plugins:commit',
            aliases: ['PluginsCommit'],
            ipcChannel: 'plugins:commit',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                try {
                    const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                    if (managementService?.commitRuntime) {
                        await managementService.commitRuntime(args[0] as string, args[1] as number | undefined)
                        return { ok: true }
                    }
                    if (managementService?.commitTransaction) {
                        await managementService.commitTransaction(args[0] as string)
                        return { ok: true }
                    }
                } catch {
                    // Fall back to coordinator
                }
                const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                if (coordinator) {
                    await coordinator.commitPrepared(args[0] as string, args[1] as number)
                    return { ok: true }
                }
                throw new Error('pluginActivationCoordinator is unavailable')
            },
        },
        {
            method: 'plugins:finalize',
            aliases: ['PluginsFinalize'],
            ipcChannel: 'plugins:finalize',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                if (managementService?.finalizeTransaction) {
                    await managementService.finalizeTransaction(args[0] as string)
                    return { ok: true }
                }
                return { ok: true }
            },
        },
        {
            method: 'plugins:rollback',
            aliases: ['PluginsRollback'],
            ipcChannel: 'plugins:rollback',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                try {
                    const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                    if (managementService?.rollbackTransaction) {
                        await managementService.rollbackTransaction(args[0] as string | undefined)
                        return { ok: true }
                    }
                } catch {
                    // Fall back to coordinator
                }
                const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                if (coordinator) {
                    await coordinator.rollbackPrepared(
                        args[0] as string | undefined,
                        args[1] as number | undefined,
                    )
                }
                return { ok: true }
            },
        },
        {
            method: 'plugins:commitGeneration',
            aliases: ['PluginsCommitGeneration'],
            ipcChannel: 'plugins:commitGeneration',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                if (!coordinator) {
                    throw new Error('pluginActivationCoordinator is unavailable')
                }
                if (typeof coordinator.ensurePrepared === 'function') {
                    await coordinator.ensurePrepared()
                }
                await coordinator.commitPrepared(args[0] as string, args[1] as number)
                return { ok: true }
            },
        },
        {
            method: 'plugins:rollbackGeneration',
            aliases: ['PluginsRollbackGeneration'],
            ipcChannel: 'plugins:rollbackGeneration',
            capability: 'plugins.manage',
            invoke: async (context, args) => {
                try {
                    const managementService = getServiceOptional<any>('pluginGraphManagementService', context)
                    if (managementService?.rollbackTransaction) {
                        await managementService.rollbackTransaction(args[0] as string | undefined)
                        return { ok: true }
                    }
                } catch {
                    // Fall back to coordinator
                }
                const coordinator = getServiceOptional<any>('pluginActivationCoordinator', context)
                if (!coordinator) {
                    return { ok: true }
                }
                await coordinator.rollbackPrepared(
                    args[0] as string | undefined,
                    args[1] as number | undefined,
                )
                return { ok: true }
            },
        },

        // Update
        {
            method: 'update:check',
            aliases: ['CheckForUpdates', 'UpdateCheck'],
            ipcChannel: 'update:check',
            capability: cap('update:check', 'system.update'),
            invoke: async (context) => getService<UpdateService>('updateService', context).checkForUpdates(),
        },
        {
            method: 'update:download',
            aliases: ['DownloadUpdate', 'UpdateDownload'],
            ipcChannel: 'update:download',
            capability: cap('update:download', 'system.update'),
            invoke: async (context) => getService<UpdateService>('updateService', context).startDownload(),
        },
        {
            method: 'update:cancel',
            aliases: ['CancelUpdate', 'UpdateCancel'],
            ipcChannel: 'update:cancel',
            capability: cap('update:cancel', 'system.update'),
            invoke: async (context) => getService<UpdateService>('updateService', context).cancelDownload(),
        },
        {
            method: 'update:apply',
            aliases: ['QuitAndInstallUpdate', 'UpdateApply'],
            ipcChannel: 'update:apply',
            capability: cap('update:apply', 'system.update'),
            invoke: async (context) => getService<UpdateService>('updateService', context).quitAndInstall(),
        },
        {
            method: 'update:getState',
            aliases: ['GetUpdateState', 'UpdateGetState'],
            ipcChannel: 'update:getState',
            capability: cap('update:getState', 'system.update'),
            invoke: async (context) => getService<UpdateService>('updateService', context).getStatusSnapshot(),
        },
        // AI Gateway Discovery
        {
            method: 'gateway:discover',
            aliases: ['GatewayDiscover'],
            ipcChannel: 'gateway:discover',
            capability: cap('gateway:discover', 'gateway.discover'),
            invoke: async (context, args) => {
                const timeoutMs = typeof args[0] === 'number' ? args[0] : 3000
                return getService<GatewayDiscoveryService>(
                    'gatewayDiscoveryService',
                    context,
                ).discover(timeoutMs)
            },
        },
    ]

    return Object.freeze(descriptors)
}

export const rpcDescriptors: readonly RpcDescriptor[] = createPlatformRpcDescriptors()
