import { definePluginEntry } from '@cpa/plugin-sdk'
import type { FloatingContribution, PluginContext } from '@cpa/plugin-api'
import { getDefaultHostServices } from '@cpa/plugin-ui'
import { AskOverlay } from './AskOverlay.js'
import {
    defaultAskController,
    markAskRequestRemotelyCleared,
    parseAskEventPayload,
    registerAskContextClient,
    unregisterAskContextClient,
    useAskStore,
} from '../shared/askStore.js'
import type { AskDecision, AskRequest } from '../shared/types.js'

export { AskOverlay }

const rendererContextDisposers = new Map<object, () => void>()
const activeRendererContexts = new Set<object>()

function getLatestActiveRendererContext(): object | undefined {
    let latest: object | undefined
    for (const ctx of activeRendererContexts) {
        latest = ctx
    }
    return latest
}

export const askRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        let isContextDisposed = false
        if (context && typeof context === 'object') {
            rendererContextDisposers.get(context)?.()
            activeRendererContexts.delete(context)
            activeRendererContexts.add(context)
        }
        registerAskContextClient(context, context.capabilityClient)

        const sessionSyncEpochs = new Map<string, number>()
        let syncRequestSeq = 0
        const bumpSessionEpoch = (sessionId: string) => {
            sessionSyncEpochs.set(sessionId, (sessionSyncEpochs.get(sessionId) ?? 0) + 1)
        }

        const unsubStore = useAskStore.subscribe(() => {
            if (isContextDisposed) return
            void context.events?.emit?.('floating:refresh')
        })

        const capClient = context.capabilityClient

        const syncRemoteRequests = async () => {
            if (isContextDisposed || !capClient || typeof capClient.invoke !== 'function') return
            const myRequestSeq = ++syncRequestSeq
            const epochsAtStart = new Map(sessionSyncEpochs)
            let remote: Record<string, AskRequest> | undefined
            try {
                remote = await capClient.invoke<Record<string, AskRequest>>('ask:getRequests', [])
            } catch {
                return
            }
            if (
                isContextDisposed ||
                myRequestSeq !== syncRequestSeq ||
                (context && typeof context === 'object' && getLatestActiveRendererContext() !== context) ||
                !remote ||
                typeof remote !== 'object' ||
                Array.isArray(remote)
            ) {
                return
            }

            const remoteKeys = new Set<string>()
            for (const [sid, req] of Object.entries(remote)) {
                if (sid && req && typeof req === 'object') {
                    remoteKeys.add(sid)
                    if ((sessionSyncEpochs.get(sid) ?? 0) !== (epochsAtStart.get(sid) ?? 0)) {
                        continue
                    }
                    useAskStore.getState().setRequest(sid, req)
                }
            }

            const currentRequests = useAskStore.getState().requestsBySession
            for (const sid of Object.keys(currentRequests)) {
                if ((sessionSyncEpochs.get(sid) ?? 0) !== (epochsAtStart.get(sid) ?? 0)) {
                    continue
                }
                if (!remoteKeys.has(sid) && !defaultAskController.hasWaiter(sid)) {
                    useAskStore.getState().setRequest(sid, null)
                }
            }
        }
        let unsubState: (() => void) | undefined
        let unsubAction: (() => void) | undefined
        if (typeof capClient?.subscribe === 'function') {
            try {
                unsubState = capClient.subscribe('ask:state-changed', (raw) => {
                    if (isContextDisposed) return
                    const payload = parseAskEventPayload<{
                        sessionId?: string
                        request?: AskRequest | null
                        requestId?: string
                    }>(raw)
                    if (!payload || !payload.sessionId) return
                    bumpSessionEpoch(payload.sessionId)
                    if (payload.request) {
                        useAskStore.getState().setRequest(payload.sessionId, payload.request)
                    } else if (payload.requestId) {
                        markAskRequestRemotelyCleared(payload.requestId)
                        useAskStore.getState().clearRequest(payload.sessionId, payload.requestId)
                    } else {
                        const existing = useAskStore.getState().getRequest(payload.sessionId)
                        if (existing) markAskRequestRemotelyCleared(existing.id)
                        useAskStore.getState().setRequest(payload.sessionId, null)
                    }
                })
            } catch {
                // Ignore subscription error when capability handle is not bound in isolated unit tests
            }

            try {
                unsubAction = capClient.subscribe('ask:action', (raw) => {
                    if (isContextDisposed) return
                    const payload = parseAskEventPayload<{
                        action?: string
                        sessionId?: string
                        toolCallId?: string
                        decision?: AskDecision
                    }>(raw)
                    if (!payload || !payload.sessionId) return
                    bumpSessionEpoch(payload.sessionId)
                    if (payload.action === 'submitAnswer' && payload.toolCallId && payload.decision) {
                        useAskStore
                            .getState()
                            .submitAnswer(payload.sessionId, payload.toolCallId, payload.decision)
                    } else if (payload.action === 'cancelCountdown' && payload.toolCallId) {
                        useAskStore
                            .getState()
                            .cancelCountdown(payload.sessionId, payload.toolCallId)
                    } else if (payload.action === 'cancel') {
                        useAskStore.getState().cancel(payload.sessionId, payload.toolCallId)
                    }
                })
            } catch {
                // Ignore subscription error when capability handle is not bound in isolated unit tests
            }
        }

        // Subscribe before fetching initial snapshot so no ask:state-changed event is missed in between
        void syncRemoteRequests()

        const hasRemoteInvoke = typeof capClient?.invoke === 'function'
        const onVisibilityChange = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                void syncRemoteRequests()
            }
        }
        const onWindowWake = () => {
            void syncRemoteRequests()
        }
        const unsubReconnect = hasRemoteInvoke
            ? context.events?.on?.('host:reconnected', () => syncRemoteRequests())
            : undefined
        const unsubCommitted = hasRemoteInvoke
            ? context.events?.on?.('platform:generation-committed', () => syncRemoteRequests())
            : undefined
        if (hasRemoteInvoke && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibilityChange)
        }
        if (hasRemoteInvoke && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('focus', onWindowWake)
            window.addEventListener('online', onWindowWake)
        }

        const cleanup = () => {
            isContextDisposed = true
            unsubStore()
            unsubState?.()
            unsubAction?.()
            unsubReconnect?.()
            unsubCommitted?.()
            if (hasRemoteInvoke && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                document.removeEventListener('visibilitychange', onVisibilityChange)
            }
            if (hasRemoteInvoke && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('focus', onWindowWake)
                window.removeEventListener('online', onWindowWake)
            }
        }
        if (context && typeof context === 'object') {
            rendererContextDisposers.set(context, cleanup)
        }

        context.register<FloatingContribution>({
            kind: 'floating',
            id: 'ask-overlay',
            value: {
                id: 'ask-overlay',
                pluginId: 'cpa.core.ask',
                anchor: '[data-element="composer-container"]',
                placement: 'cover-bottom',
                offset: { y: 0 },
                // Above the default floating layer (z-index 50), including the todo progress bar.
                zIndex: 60,
                visible: (ctx: any) => {
                    const hostServices = (context as any).services ?? getDefaultHostServices()
                    const sid =
                        ctx && typeof ctx === 'object' && 'sessionId' in ctx
                            ? String((ctx as { sessionId: unknown }).sessionId || '')
                            : hostServices?.sessions?.getCurrentSessionId?.() || ''
                    if (!sid) return false
                    return Boolean(useAskStore.getState().requestsBySession[sid])
                },
                component: AskOverlay,
            },
        })
    },
    deactivate(context?: PluginContext) {
        if (context && typeof context === 'object') {
            rendererContextDisposers.get(context)?.()
            rendererContextDisposers.delete(context)
            activeRendererContexts.delete(context)
            unregisterAskContextClient(context)
            if (activeRendererContexts.size === 0) {
                useAskStore.getState().clearAll()
            }
            return
        }
        for (const dispose of rendererContextDisposers.values()) {
            dispose()
        }
        rendererContextDisposers.clear()
        activeRendererContexts.clear()
        unregisterAskContextClient()
        useAskStore.getState().clearAll()
    },
})

export const entry = askRendererEntry
export default askRendererEntry
