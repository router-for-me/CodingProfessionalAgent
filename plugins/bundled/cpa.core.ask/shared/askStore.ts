import { create } from 'zustand'
import type { AskDecision, AskRequest, AskState } from './types.js'

type Waiter = {
    sessionId: string
    toolCallId: string
    resolve: (decision: AskDecision) => void
    abortListener?: () => void
    signal?: AbortSignal
}

export class AskController {
    private readonly waiters = new Map<string, Map<string, Waiter>>()

    waitForAnswer(
        sessionId: string,
        toolCallId: string,
        signal?: AbortSignal,
    ): Promise<AskDecision> {
        if (!sessionId || !toolCallId) {
            return Promise.resolve({ type: 'cancelled' })
        }

        const sessionMap = this.ensureSessionMap(sessionId)
        if (sessionMap.has(toolCallId)) {
            // Existing waiter resolves as cancelled if replaced
            const old = sessionMap.get(toolCallId)
            old?.resolve({ type: 'cancelled' })
            sessionMap.delete(toolCallId)
        }

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

            sessionMap.set(toolCallId, waiter)
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

export const useAskStore = create<AskState>((set, get) => ({
    requestsBySession: {},

    setRequest: (sessionId: string, request: AskRequest | null) => {
        if (!sessionId) return
        set((state) => {
            if (!request) {
                if (!(sessionId in state.requestsBySession)) return state
                const next = { ...state.requestsBySession }
                delete next[sessionId]
                return { requestsBySession: next }
            }
            return {
                requestsBySession: {
                    ...state.requestsBySession,
                    [sessionId]: request,
                },
            }
        })
    },

    getRequest: (sessionId: string) => {
        if (!sessionId) return undefined
        return get().requestsBySession[sessionId]
    },

    submitAnswer: (sessionId: string, toolCallId: string, decision: AskDecision) => {
        defaultAskController.submitAnswer(sessionId, toolCallId, decision)
        get().setRequest(sessionId, null)
    },

    cancel: (sessionId: string, toolCallId?: string) => {
        defaultAskController.cancel(sessionId, toolCallId)
        get().setRequest(sessionId, null)
    },

    clearSession: (sessionId: string) => {
        defaultAskController.abortSession(sessionId)
        get().setRequest(sessionId, null)
    },

    clearAll: () => {
        defaultAskController.abortAll()
        set({ requestsBySession: {} })
    },
}))

export function __resetAskStoreForTests(): void {
    useAskStore.getState().clearAll()
}
