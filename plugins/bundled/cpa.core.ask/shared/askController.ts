import type { AskDecision } from './types.js'

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

