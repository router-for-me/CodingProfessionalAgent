import { definePluginEntry } from '@cpa/plugin-sdk'
import type { CapabilityEventContribution, PluginContext, RpcDescriptor, ToolResult, UtilityExecutorContribution, UtilityExecutorHandle } from '@cpa/plugin-api'
import { CELL_CAPABILITY, CELL_EVENT, CELL_RPC, type ObserveCell, type StartCell } from '../shared/messages.js'
import { CellSessionHost } from './session.js'

const generations = new Map<number, { host: CellSessionHost; disposeDeletion: () => void }>()

export const entry = definePluginEntry({
    runtime: 'main',
    activate(context: PluginContext) {
        context.register<UtilityExecutorContribution>({ kind: 'background-job', id: 'code-cell-executor', value: { moduleUrl: new URL('./executor.js', import.meta.url).href } })
        const host = new CellSessionHost(
            (payload) => { void context.events.emit(CELL_EVENT, payload) },
            async () => {
                if (!context.capabilityClient) throw new Error('Utility executor capability unavailable')
                return context.capabilityClient.invoke<UtilityExecutorHandle>('runtime.utility.fork', ['code-cell-executor'])
            },
        )
        context.register<CapabilityEventContribution>({ kind: 'native-event', id: CELL_EVENT, value: { event: CELL_EVENT, capability: CELL_CAPABILITY } })
        context.register<RpcDescriptor>({
            kind: 'rpc', id: CELL_RPC,
            value: {
                method: CELL_RPC, capability: CELL_CAPABILITY,
                async invoke(rpcContext, args) {
                    if (rpcContext.pluginId !== context.manifest.id) throw new Error('Code cell capability belongs to its plugin')
                    const executorHost = generations.get(rpcContext.generation ?? context.generation)?.host
                    if (!executorHost) throw new Error('Code cell generation is unavailable')
                    const command = args[0] as Record<string, unknown>
                    if (!command || typeof command !== 'object') throw new Error('Cell command required')
                    const owner = `${rpcContext.transport}:${rpcContext.senderId}:${rpcContext.clientId ?? ''}:${rpcContext.documentId ?? ''}`
                    const requestId = String(command.requestId ?? '')
                    if (command.type === 'prepare') return executorHost.prepare()
                    if (command.type === 'cancel') {
                        if (typeof command.sessionId !== 'string') throw new Error('sessionId required')
                        executorHost.cancel(command.sessionId)
                        return
                    }
                    if (!requestId || requestId.length > 200) throw new Error('Valid observation id required')
                    if (command.type === 'deliver') return executorHost.deliver(requestId, owner, String(command.invocationId), command.result as ToolResult)
                    if (command.type === 'heartbeat') return executorHost.heartbeat(requestId, owner)
                    if (command.type === 'detach') return executorHost.detach(requestId, owner)
                    const input = command.input as StartCell & ObserveCell
                    if (!input || typeof input.sessionId !== 'string' || input.sessionId.length > 200) throw new Error('Valid sessionId required')
                    for (const key of ['yieldTimeMs', 'maxOutputTokens'] as const) {
                        if (!Number.isSafeInteger(input[key]) || input[key] < 0) throw new Error(`${key} must be a nonnegative safe integer`)
                    }
                    if (command.type === 'start') {
                        if (typeof input.source !== 'string' || input.source.length > 1024 * 1024 || !Array.isArray(input.tools)) throw new Error('Valid source and tool specifications required')
                        for (const tool of input.tools) {
                            if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tool.identifier)) throw new Error('Invalid nested tool specification')
                            if (['exec', 'wait'].includes(tool.name)) throw new Error('Recursive orchestration tools are forbidden')
                        }
                        return executorHost.start(requestId, input, owner)
                    }
                    if (command.type === 'observe') {
                        if (typeof input.cellId !== 'string') throw new Error('cellId required')
                        return executorHost.observe(requestId, input, owner)
                    }
                    throw new Error('Unknown cell command')
                },
            },
        })
        const disposeDeletion = context.events.on<any>('session:deleted', (event) => {
            const payload = typeof event?.data === 'string' ? JSON.parse(event.data) : event?.data ?? event
            const sessionId = payload?.sessionId ?? payload?.id
            if (typeof sessionId === 'string') host.cancel(sessionId)
        })
        const disposeSettings = context.events.on<any>('kvstore:updated', (change) => {
            if (change?.key === 'app-state' && (change.value?.settings?.toolMode ?? 'direct') === 'direct') host.cancelAll()
        })
        generations.set(context.generation, { host, disposeDeletion: () => { disposeDeletion(); disposeSettings() } })
    },
    deactivate(context) {
        const generation = generations.get(context.generation)
        generation?.disposeDeletion()
        generation?.host.dispose()
        generations.delete(context.generation)
    },
})

export default entry
