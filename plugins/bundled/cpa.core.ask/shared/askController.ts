import type { PluginCapabilityClient } from '@cpa/plugin-api'
import type { AskDecision } from './types.js'

let askCapabilityClient: PluginCapabilityClient | undefined
const contextCapabilityClients = new Map<object, PluginCapabilityClient | undefined>()
const remotelyClearedRequestIds = new Set<string>()

export function setAskCapabilityClient(client: PluginCapabilityClient | undefined): void {
    askCapabilityClient = client
    if (!client && contextCapabilityClients.size === 0) {
        remotelyClearedRequestIds.clear()
    }
}

export function registerAskContextClient(
    context: object | undefined,
    client: PluginCapabilityClient | undefined,
): void {
    if (context && typeof context === 'object') {
        contextCapabilityClients.delete(context)
        contextCapabilityClients.set(context, client)
    }
    askCapabilityClient = client
}

export function unregisterAskContextClient(context?: object): void {
    if (!context || typeof context !== 'object') {
        contextCapabilityClients.clear()
        setAskCapabilityClient(undefined)
        return
    }
    contextCapabilityClients.delete(context)
    const remaining = Array.from(contextCapabilityClients.values())
    let restored: PluginCapabilityClient | undefined
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (remaining[i] !== undefined) {
            restored = remaining[i]
            break
        }
    }
    setAskCapabilityClient(restored)
}

export function getAskCapabilityClient(): PluginCapabilityClient | undefined {
    return askCapabilityClient
}

export function markAskRequestRemotelyCleared(requestId?: string): void {
    if (!requestId) return
    remotelyClearedRequestIds.add(requestId)
    if (remotelyClearedRequestIds.size > 256) {
        const oldest = remotelyClearedRequestIds.values().next().value
        if (oldest) remotelyClearedRequestIds.delete(oldest)
    }
}

export function isAskRequestRemotelyCleared(requestId: string): boolean {
    return remotelyClearedRequestIds.has(requestId)
}

function getCandidateCapabilityClients(
    clientOverride?: PluginCapabilityClient,
): PluginCapabilityClient[] {
    const candidates: PluginCapabilityClient[] = []
    const addCandidate = (client: PluginCapabilityClient | undefined) => {
        if (
            client &&
            typeof client.invoke === 'function' &&
            !candidates.includes(client)
        ) {
            candidates.push(client)
        }
    }
    addCandidate(clientOverride)
    addCandidate(askCapabilityClient)
    const registered = Array.from(contextCapabilityClients.values())
    for (let i = registered.length - 1; i >= 0; i -= 1) {
        addCandidate(registered[i])
    }
    return candidates
}

export async function invokeAskRpc<T = unknown>(
    method: string,
    args: unknown[] = [],
    clientOverride?: PluginCapabilityClient,
): Promise<T | undefined> {
    const candidates = getCandidateCapabilityClients(clientOverride)
    for (const client of candidates) {
        try {
            return await client.invoke<T>(method, args)
        } catch {
            // Try next available capability client if current one fails
        }
    }
    return undefined
}

export async function invokeAskRpcStrict<T = unknown>(
    method: string,
    args: unknown[] = [],
    clientOverride?: PluginCapabilityClient,
): Promise<{ ok: true; value: T } | { ok: false; transportError: boolean }> {
    const candidates = getCandidateCapabilityClients(clientOverride)
    if (candidates.length === 0) {
        return { ok: false, transportError: false }
    }
    for (const client of candidates) {
        try {
            const value = await client.invoke<T>(method, args)
            return { ok: true, value }
        } catch {
            // Try next available capability client if current one fails
        }
    }
    return { ok: false, transportError: true }
}

export function parseAskEventPayload<T = Record<string, unknown>>(raw: unknown): T | null {
    if (!raw || typeof raw !== 'object') return null
    const record = raw as Record<string, unknown>
    if (typeof record.data === 'string') {
        try {
            return JSON.parse(record.data) as T
        } catch {
            return null
        }
    }
    return raw as T
}

type Waiter = {
    sessionId: string
    toolCallId: string
    resolve: (decision: AskDecision) => void
    abortListener?: () => void
    signal?: AbortSignal
    countdownTimer?: ReturnType<typeof setTimeout>
}

export class AskController {
    private readonly waiters = new Map<string, Map<string, Waiter>>()

    waitForAnswer(
        sessionId: string,
        toolCallId: string,
        signal?: AbortSignal,
        countdown?: { timeoutMs: number; decision: AskDecision },
    ): Promise<AskDecision> {
        if (!sessionId || !toolCallId) {
            return Promise.resolve({ type: 'cancelled' })
        }

        // The UI shows one request per session; release all previous waiters and timers.
        this.cancel(sessionId)

        if (signal?.aborted) {
            return Promise.resolve({ type: 'aborted' })
        }

        return new Promise<AskDecision>((resolve) => {
            const waiter: Waiter = {
                sessionId,
                toolCallId,
                resolve: (decision) => {
                    this.cleanupWaiter(sessionId, toolCallId, waiter)
                    resolve(decision)
                },
                signal,
            }

            if (signal) {
                const onAbort = (): void => {
                    const current = this.waiters.get(sessionId)?.get(toolCallId)
                    if (current !== waiter) return
                    waiter.resolve({ type: 'aborted' })
                }
                waiter.abortListener = onAbort
                signal.addEventListener('abort', onAbort, { once: true })
            }

            this.ensureSessionMap(sessionId).set(toolCallId, waiter)
            if (countdown) {
                waiter.countdownTimer = setTimeout(() => {
                    waiter.resolve(countdown.decision)
                }, countdown.timeoutMs)
            }
        })
    }

    submitAnswer(
        sessionId: string,
        toolCallId: string,
        decision: AskDecision,
    ): boolean {
        const waiter = this.waiters.get(sessionId)?.get(toolCallId)
        if (!waiter) return false
        waiter.resolve(decision)
        return true
    }

    hasWaiter(sessionId: string, toolCallId?: string): boolean {
        const sessionMap = this.waiters.get(sessionId)
        if (!sessionMap || sessionMap.size === 0) return false
        if (toolCallId) {
            return sessionMap.has(toolCallId)
        }
        return true
    }

    cancelCountdown(sessionId: string, toolCallId: string): boolean {
        const waiter = this.waiters.get(sessionId)?.get(toolCallId)
        if (!waiter || waiter.countdownTimer === undefined) return false
        clearTimeout(waiter.countdownTimer)
        waiter.countdownTimer = undefined
        return true
    }

    cancel(sessionId: string, toolCallId?: string): boolean {
        if (toolCallId) {
            const waiter = this.waiters.get(sessionId)?.get(toolCallId)
            if (!waiter) return false
            waiter.resolve({ type: 'cancelled' })
            return true
        }
        const sessionMap = this.waiters.get(sessionId)
        if (!sessionMap || sessionMap.size === 0) return false
        for (const waiter of sessionMap.values()) {
            waiter.resolve({ type: 'cancelled' })
        }
        return true
    }

    abortSession(sessionId: string): void {
        const sessionMap = this.waiters.get(sessionId)
        if (!sessionMap) return
        for (const waiter of sessionMap.values()) {
            waiter.resolve({ type: 'aborted' })
        }
    }

    abortAll(): void {
        for (const sessionMap of this.waiters.values()) {
            for (const waiter of sessionMap.values()) {
                waiter.resolve({ type: 'aborted' })
            }
        }
    }

    private ensureSessionMap(sessionId: string): Map<string, Waiter> {
        let map = this.waiters.get(sessionId)
        if (!map) {
            map = new Map()
            this.waiters.set(sessionId, map)
        }
        return map
    }

    private cleanupWaiter(
        sessionId: string,
        toolCallId: string,
        waiter: Waiter,
    ): void {
        const sessionMap = this.waiters.get(sessionId)
        if (!sessionMap) return
        if (sessionMap.get(toolCallId) !== waiter) return
        if (waiter.countdownTimer !== undefined) {
            clearTimeout(waiter.countdownTimer)
            waiter.countdownTimer = undefined
        }
        sessionMap.delete(toolCallId)
        if (sessionMap.size === 0) {
            this.waiters.delete(sessionId)
        }
        if (waiter.signal && waiter.abortListener) {
            waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        waiter.abortListener = undefined
        waiter.signal = undefined
    }
}

export const defaultAskController = new AskController()

