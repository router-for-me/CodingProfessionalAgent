import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    CapabilityEventContribution,
    PluginContext,
    RpcDescriptor,
} from '@cpa/plugin-api'
import type { AskDecision, AskRequest } from '../shared/types.js'

const requestsBySession = new Map<string, AskRequest>()
const activeMainContexts = new Set<object>()

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
                invoke: async () => {
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
                    if (!current || current.toolCallId !== toolCallId) {
                        return false
                    }
                    requestsBySession.delete(sessionId)
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
            }
            return
        }
        activeMainContexts.clear()
        requestsBySession.clear()
    },
})

export const entry = askMainEntry
export default askMainEntry
