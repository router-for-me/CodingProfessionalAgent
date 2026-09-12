import { type CapabilityHandle, type CapabilityInvokeResponse, deserializeCapabilityError } from '@cpa/plugin-api'
import type { ElectronBridgeApi, HostTransportApi, NativeEvent } from './types.js'

export type { HostTransportApi }

export interface RendererCapabilityDescriptor {
    name: string
    method: string
    capability: string
}

/**
 * Single source of truth for renderer-facing capabilities and RPC mappings.
 */
export const RENDERER_CAPABILITY_DESCRIPTORS: readonly RendererCapabilityDescriptor[] = Object.freeze([
    // File & OS
    { name: 'RuntimeInfo', method: 'native:runtimeInfo', capability: 'filesystem.read' },
    { name: 'ReadFile', method: 'native:readFile', capability: 'filesystem.read' },
    { name: 'ReadFileIfExists', method: 'native:readFileIfExists', capability: 'filesystem.read' },
    { name: 'FileExists', method: 'native:fileExists', capability: 'filesystem.read' },
    { name: 'GetProjectEnvironment', method: 'native:getProjectEnvironment', capability: 'environment.read' },
    { name: 'WatchProjectEnvironments', method: 'native:watchProjectEnvironments', capability: 'environment.watch' },
    { name: 'InvalidateEnvironmentCache', method: 'native:invalidateEnvironmentCache', capability: 'environment.manage' },
    { name: 'WriteFile', method: 'native:writeFile', capability: 'filesystem.write' },
    { name: 'MkdirAll', method: 'native:mkdirAll', capability: 'filesystem.write' },
    { name: 'RemoveFile', method: 'native:removeFile', capability: 'filesystem.write' },
    { name: 'RemoveDir', method: 'native:removeDir', capability: 'filesystem.write' },
    { name: 'Stat', method: 'native:stat', capability: 'filesystem.read' },
    { name: 'ReadDir', method: 'native:readDir', capability: 'filesystem.read' },
    { name: 'RealPath', method: 'native:realPath', capability: 'filesystem.read' },
    { name: 'LookPath', method: 'native:lookPath', capability: 'filesystem.read' },

    // Dialog & Reveal & Clipboard
    { name: 'SelectProjectDirectory', method: 'native:selectProjectDirectory', capability: 'dialog.open' },
    { name: 'SelectFilesAndFolders', method: 'native:selectFilesAndFolders', capability: 'dialog.open' },
    { name: 'RevealInFileManager', method: 'native:revealInFileManager', capability: 'dialog.open' },
    { name: 'ClipboardSetText', method: 'native:clipboardSetText', capability: 'clipboard.write' },
    { name: 'ClipboardGetText', method: 'native:clipboardGetText', capability: 'clipboard.read' },

    // Profiling & SaveFile
    { name: 'SaveFile', method: 'dialog:saveFile', capability: 'dialog.save' },
    { name: 'saveFile', method: 'dialog:saveFile', capability: 'dialog.save' },
    { name: 'startProfiling', method: 'profiling:start', capability: 'profiling.manage' },
    { name: 'stopProfiling', method: 'profiling:stop', capability: 'profiling.manage' },
    { name: 'ProfilingGetStatus', method: 'profiling:getStatus', capability: 'profiling.read' },
    { name: 'getProfilingReport', method: 'profiling:getReport', capability: 'profiling.read' },

    // Process & PTY
    { name: 'StartProcess', method: 'native:startProcess', capability: 'process.spawn' },
    { name: 'RunProcess', method: 'native:runProcess', capability: 'process.spawn' },
    { name: 'StartPty', method: 'native:startPty', capability: 'pty.spawn' },
    { name: 'WritePty', method: 'native:writePty', capability: 'pty.write' },
    { name: 'ResizePty', method: 'native:resizePty', capability: 'pty.resize' },
    { name: 'ClosePty', method: 'native:closePty', capability: 'pty.close' },

    // WebSocket
    { name: 'OpenWebSocket', method: 'native:openWebSocket', capability: 'network.websocket' },
    { name: 'SendWebSocket', method: 'native:sendWebSocket', capability: 'network.websocket' },
    { name: 'CancelOperation', method: 'native:cancelOperation', capability: 'process.cancel' },

    // HTTP
    { name: 'HttpRequest', method: 'http:request', capability: 'network.http' },

    // KVStore
    { name: 'KVStoreGet', method: 'kvstore:get', capability: 'storage.kv' },
    { name: 'KVStoreSet', method: 'kvstore:set', capability: 'storage.kv' },
    { name: 'KVStoreSave', method: 'kvstore:save', capability: 'storage.kv' },

    // Schedule
    { name: 'ScheduleList', method: 'schedule:list', capability: 'schedule.read' },
    { name: 'ScheduleSave', method: 'schedule:save', capability: 'schedule.write' },
    { name: 'ScheduleTrigger', method: 'schedule:trigger', capability: 'schedule.manage' },

    // Sessions
    { name: 'SessionGet', method: 'session:get', capability: 'sessions.read' },
    { name: 'SessionSet', method: 'session:set', capability: 'sessions.write' },
    { name: 'SessionDelete', method: 'session:delete', capability: 'sessions.write' },
    { name: 'SessionList', method: 'session:list', capability: 'sessions.read' },
    { name: 'SessionListSessions', method: 'session:listSessions', capability: 'sessions.read' },
    { name: 'SessionListSessionsByScheduleId', method: 'session:listSessionsByScheduleId', capability: 'sessions.read' },
    { name: 'SessionSetMeta', method: 'session:setMeta', capability: 'sessions.write' },
    { name: 'SessionBroadcastRunStatus', method: 'session:broadcastRunStatus', capability: 'sessions.manage' },
    { name: 'SessionBroadcastStreamEvent', method: 'session:broadcastStreamEvent', capability: 'sessions.manage' },
    { name: 'SessionBroadcastSubAgentState', method: 'session:broadcastSubAgentState', capability: 'sessions.manage' },
    { name: 'SessionUpdateSubAgent', method: 'session:updateSubAgent', capability: 'sessions.write' },
    { name: 'SessionAbortRun', method: 'session:abortRun', capability: 'sessions.manage' },
    { name: 'SessionGetActiveRuns', method: 'session:getActiveRuns', capability: 'sessions.read' },
    { name: 'SessionGetResumePromptState', method: 'session:getResumePromptState', capability: 'sessions.read' },
    { name: 'SessionBroadcastResumePromptState', method: 'session:broadcastResumePromptState', capability: 'sessions.manage' },
    { name: 'SessionResumePromptAction', method: 'session:resumePromptAction', capability: 'sessions.manage' },
    { name: 'SessionDelegateRun', method: 'session:delegateRun', capability: 'sessions.manage' },
    { name: 'SessionQueryMetrics', method: 'session:queryMetrics', capability: 'sessions.read' },
    { name: 'SessionSearch', method: 'session:search', capability: 'sessions.read' },


    // Tray
    { name: 'SetTrayEnabled', method: 'tray:setEnabled', capability: 'tray.manage' },
    { name: 'SetTrayLocale', method: 'tray:setLocale', capability: 'tray.manage' },

    // Power / Sleep
    { name: 'SetPreventSleep', method: 'power:setPreventSleep', capability: 'power.manage' },
    { name: 'GetPreventSleep', method: 'power:getPreventSleep', capability: 'power.read' },

    // Web Server
    { name: 'WebServerStart', method: 'webserver:start', capability: 'webserver.manage' },
    { name: 'WebServerStop', method: 'webserver:stop', capability: 'webserver.manage' },
    { name: 'WebServerGetStatus', method: 'webserver:getStatus', capability: 'webserver.read' },

    // Plugins
    { name: 'PluginsList', method: 'plugins:list', capability: 'plugins.read' },
    { name: 'PluginsGetGraph', method: 'plugins:getGraph', capability: 'plugins.read' },
    { name: 'PluginsGetPreparedState', method: 'plugins:getPreparedState', capability: 'plugins.read' },
    { name: 'PluginsPrepareEnable', method: 'plugins:prepareEnable', capability: 'plugins.manage' },
    { name: 'PluginsPrepareDisable', method: 'plugins:prepareDisable', capability: 'plugins.manage' },
    { name: 'PluginsPrepareReload', method: 'plugins:prepareReload', capability: 'plugins.manage' },
    { name: 'PluginsPrepareInstall', method: 'plugins:prepareInstall', capability: 'plugins.install' },
    { name: 'PluginsPrepareUninstall', method: 'plugins:prepareUninstall', capability: 'plugins.manage' },
    { name: 'PluginsPrepareConfig', method: 'plugins:prepareConfig', capability: 'plugins.manage' },
    { name: 'PluginsCommit', method: 'plugins:commit', capability: 'plugins.manage' },
    { name: 'PluginsFinalize', method: 'plugins:finalize', capability: 'plugins.manage' },
    { name: 'PluginsRollback', method: 'plugins:rollback', capability: 'plugins.manage' },
    { name: 'PluginsCommitGeneration', method: 'plugins:commitGeneration', capability: 'plugins.manage' },
    { name: 'PluginsRollbackGeneration', method: 'plugins:rollbackGeneration', capability: 'plugins.manage' },
])

export const rendererFacingDescriptorNames: readonly string[] = Object.freeze(
    RENDERER_CAPABILITY_DESCRIPTORS.map((d) => d.name),
)

export const METHOD_CAPABILITY_MAP: ReadonlyMap<string, string> = Object.freeze(
    new Map(RENDERER_CAPABILITY_DESCRIPTORS.map((d) => [d.method, d.capability])),
)

export function getRequiredCapabilityForMethod(method: string): string | undefined {
    return METHOD_CAPABILITY_MAP.get(method)
}

export type CapabilityHandleProvider =
    | CapabilityHandle
    | string
    | Promise<CapabilityHandle | string>
    | (() => CapabilityHandle | string | Promise<CapabilityHandle | string>)

/**
 * Creates a typed ElectronBridgeApi facade from a HostTransportApi.
 * Requires an explicit handle or handle provider; static default handles are prohibited.
 */
export interface HostCapabilityFacadeOptions {
    /**
     * Invoked before a one-shot retry when the broker reports an expired handle.
     * Callers should clear any cached handle so the next resolve claims a fresh one.
     */
    onExpiredHandle?: () => void
}

function isExpiredCapabilityHandleError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const message = 'message' in error ? String((error as { message?: unknown }).message ?? '') : ''
    return /Invalid or expired capability handle/i.test(message)
}

function unwrapInvokeResult(raw: unknown): unknown {
    if (raw && typeof raw === 'object' && 'ok' in raw) {
        const res = raw as CapabilityInvokeResponse
        if (res.ok === true && 'value' in res) {
            return res.value
        }
        if (res.ok === false && 'error' in res) {
            throw deserializeCapabilityError(res.error)
        }
    }
    return raw
}

export function createHostCapabilityFacade(
    transport: HostTransportApi,
    handleProvider: CapabilityHandleProvider,
    options?: HostCapabilityFacadeOptions,
): ElectronBridgeApi {
    if (!handleProvider) {
        throw new Error('A capability handle or handle provider is required to create a host capability facade')
    }

    const isSyncHandle = typeof handleProvider === 'string'
    const syncHandle = isSyncHandle ? (handleProvider as string) : null

    const resolveHandle = async (): Promise<string> => {
        if (syncHandle) return syncHandle
        const resolved = typeof handleProvider === 'function' ? await handleProvider() : await handleProvider
        if (!resolved || typeof resolved !== 'string') {
            throw new Error('Valid capability handle is required for host facade invocation')
        }
        return resolved
    }

    const facade: Record<string, unknown> = {}

    for (const descriptor of RENDERER_CAPABILITY_DESCRIPTORS) {
        facade[descriptor.name] = async (...args: unknown[]) => {
            const handle = syncHandle ?? (await resolveHandle())
            try {
                return unwrapInvokeResult(await transport.invoke(handle, descriptor.method, args))
            } catch (err) {
                if (
                    syncHandle ||
                    typeof handleProvider !== 'function' ||
                    !options?.onExpiredHandle ||
                    !isExpiredCapabilityHandleError(err)
                ) {
                    throw err
                }

                // Clear cached handle and re-claim once, then retry the invoke.
                options.onExpiredHandle()
                const freshHandle = await resolveHandle()
                if (!freshHandle || freshHandle === handle) {
                    throw err
                }
                return unwrapInvokeResult(await transport.invoke(freshHandle, descriptor.method, args))
            }
        }
    }

    facade.onNativeEvent = (callback: (event: NativeEvent) => void) => {
        return transport.subscribeNativeEvents(callback)
    }

    return facade as unknown as ElectronBridgeApi
}
