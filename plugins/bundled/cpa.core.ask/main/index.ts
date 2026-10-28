import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    CapabilityEventContribution,
    PluginContext,
    RpcDescriptor,
} from '@cpa/plugin-api'
import type { AskDecision, AskRequest } from '../shared/types.js'

interface ResolvedAskAction {
    sessionId: string
    toolCallId: string
    action: 'submitAnswer' | 'cancel'
    decision?: AskDecision
    updatedAt: number
}

const requestsBySession = new Map<string, AskRequest>()
const resolvedByCallKey = new Map<string, ResolvedAskAction>()
const activeMainContexts = new Set<object>()

function recordResolvedAction(entry: ResolvedAskAction): void {
    const key = `${entry.sessionId}:${entry.toolCallId}`
    resolvedByCallKey.delete(key)
    resolvedByCallKey.set(key, entry)
    if (resolvedByCallKey.size > 256) {
        const oldestKey = resolvedByCallKey.keys().next().value
        if (oldestKey) {
            resolvedByCallKey.delete(oldestKey)
        }
    }
}

export const askMainEntry = definePluginEntry({
    runtime: 'main',
    activate(context: PluginContext) {
        if (context && typeof context === 'object') {
            activeMainContexts.add(context)
        }
        const emitEvent = (kind: string, payload: unknown, rpcCtx?: any) => {
            const event = {
                operationId: `${kind}-${Date.now()}`,
                sequence: Date.now(),
                kind,
                data: JSON.stringify(payload),
            }
            if (typeof rpcCtx?.emitEvent === 'function') {
                rpcCtx.emitEvent(event)
            } else if (typeof rpcCtx?.emitNativeEvent === 'function') {
                rpcCtx.emitNativeEvent(event)
            } else if (typeof (context as any)?.emitEvent === 'function') {
                ;(context as any).emitEvent(event)
            }
            void context.events?.emit?.(kind, event)
        }

        const eventList: CapabilityEventContribution[] = [
            {
                event: 'ask:state-changed',
                capability: 'ui.overlay',
            },
            {
                event: 'ask:action',
                capability: 'ui.overlay',
            },
        ]

        for (const evt of eventList) {
            context.register<CapabilityEventContribution>({
                kind: 'native-event',
                id: evt.event,
                value: evt,
            })
        }

        const rpcList: RpcDescriptor[] = [
            {
                method: 'ask:setRequest',
                ipcChannel: 'ask:setRequest',
                capability: 'ui.overlay',
                invoke: async (rpcCtx, args) => {
                    const sessionId = typeof args[0] === 'string' ? args[0] : ''
                    const request = (args[1] as AskRequest | null | undefined) ?? null
                    if (!sessionId) return false
                    if (request) {
                        requestsBySession.set(sessionId, request)
                        if (request.toolCallId) {
                            resolvedByCallKey.delete(`${sessionId}:${request.toolCallId}`)
                        }
                    } else {
                        requestsBySession.delete(sessionId)
                    }
                    emitEvent(
                        'ask:state-changed',
                        { sessionId, request },
                        rpcCtx,
                    )
                    return true
                },
            },
            {
                method: 'ask:clearRequest',
                ipcChannel: 'ask:clearRequest',
                capability: 'ui.overlay',
                invoke: async (rpcCtx, args) => {
                    const sessionId = typeof args[0] === 'string' ? args[0] : ''
                    const requestId = typeof args[1] === 'string' ? args[1] : ''
                    if (!sessionId) return false
                    const current = requestsBySession.get(sessionId)
                    if (current && (!requestId || current.id === requestId)) {
                        requestsBySession.delete(sessionId)
                        emitEvent(
                            'ask:state-changed',
                            { sessionId, request: null, requestId: requestId || current.id },
                            rpcCtx,
                        )
                        return true
                    }
                    return false
                },
            },
            {
                method: 'ask:getRequests',
                ipcChannel: 'ask:getRequests',
                capability: 'ui.overlay',
                invoke: async (_rpcCtx, args) => {
                    const query = args?.[0]
                    if (
                        query &&
                        typeof query === 'object' &&
                        !Array.isArray(query) &&
                        typeof (query as { sessionId?: unknown }).sessionId === 'string'
                    ) {
                        const sessionId = (query as { sessionId: string }).sessionId
                        const toolCallId =
                            typeof (query as { toolCallId?: unknown }).toolCallId === 'string'
                                ? (query as { toolCallId: string }).toolCallId
                                : ''
                        return {
                            request: requestsBySession.get(sessionId) ?? null,
                            resolved: toolCallId
                                ? (resolvedByCallKey.get(`${sessionId}:${toolCallId}`) ?? null)
                                : null,
                        }
                    }
                    return Object.fromEntries(requestsBySession.entries())
                },
            },
            {
                method: 'ask:submitAnswer',
                ipcChannel: 'ask:submitAnswer',
                capability: 'ui.overlay',
                invoke: async (rpcCtx, args) => {
                    const sessionId = typeof args[0] === 'string' ? args[0] : ''
                    const toolCallId = typeof args[1] === 'string' ? args[1] : ''
                    const decision = args[2] as AskDecision | undefined
                    if (!sessionId || !toolCallId || !decision) return false
                    const current = requestsBySession.get(sessionId)
                    if (current && current.toolCallId !== toolCallId) {
                        return false
                    }
                    recordResolvedAction({
                        sessionId,
                        toolCallId,
                        action: 'submitAnswer',
                        decision,
                        updatedAt: Date.now(),
                    })
                    if (current) {
                        requestsBySession.delete(sessionId)
                    }
                    emitEvent(
                        'ask:action',
                        {
                            action: 'submitAnswer',
                            sessionId,
                            toolCallId,
                            decision,
                        },
                        rpcCtx,
                    )
                    if (current) {
                        emitEvent(
                            'ask:state-changed',
                            {
                                sessionId,
                                request: null,
                                requestId: current.id,
                            },
                            rpcCtx,
                        )
                    }
                    return true
                },
            },
            {
                method: 'ask:cancelCountdown',
                ipcChannel: 'ask:cancelCountdown',
                capability: 'ui.overlay',
                invoke: async (rpcCtx, args) => {
                    const sessionId = typeof args[0] === 'string' ? args[0] : ''
                    const toolCallId = typeof args[1] === 'string' ? args[1] : ''
                    if (!sessionId || !toolCallId) return false
                    const current = requestsBySession.get(sessionId)
                    if (!current || current.toolCallId !== toolCallId) {
                        return false
                    }
                    if (current.countdownDeadline !== undefined) {
                        const updated: AskRequest = {
                            ...current,
                            countdownDeadline: undefined,
                        }
                        requestsBySession.set(sessionId, updated)
                        emitEvent(
                            'ask:state-changed',
                            {
                                sessionId,
                                request: updated,
                            },
                            rpcCtx,
                        )
                    }
                    emitEvent(
                        'ask:action',
                        {
                            action: 'cancelCountdown',
                            sessionId,
                            toolCallId,
                        },
                        rpcCtx,
                    )
                    return true
                },
            },
            {
                method: 'ask:cancel',
                ipcChannel: 'ask:cancel',
                capability: 'ui.overlay',
                invoke: async (rpcCtx, args) => {
                    const sessionId = typeof args[0] === 'string' ? args[0] : ''
                    const toolCallId = typeof args[1] === 'string' ? args[1] : undefined
                    if (!sessionId) return false
                    const current = requestsBySession.get(sessionId)
                    if (!current || (toolCallId && current.toolCallId !== toolCallId)) {
                        return false
                    }
                    recordResolvedAction({
                        sessionId,
                        toolCallId: current.toolCallId,
                        action: 'cancel',
                        updatedAt: Date.now(),
                    })
                    requestsBySession.delete(sessionId)
                    emitEvent(
                        'ask:action',
                        {
                            action: 'cancel',
                            sessionId,
                            toolCallId: current.toolCallId,
                        },
                        rpcCtx,
                    )
                    emitEvent(
                        'ask:state-changed',
                        {
                            sessionId,
                            request: null,
                            requestId: current.id,
                        },
                        rpcCtx,
                    )
                    return true
                },
            },
        ]

        for (const rpc of rpcList) {
            context.register<RpcDescriptor>({
                kind: 'rpc',
                id: rpc.method,
                value: rpc,
            })
        }
    },
    deactivate(context?: PluginContext) {
        if (context && typeof context === 'object') {
            activeMainContexts.delete(context)
            if (activeMainContexts.size === 0) {
                requestsBySession.clear()
                resolvedByCallKey.clear()
            }
            return
        }
        activeMainContexts.clear()
        requestsBySession.clear()
        resolvedByCallKey.clear()
    },
})

export const entry = askMainEntry
export default askMainEntry
