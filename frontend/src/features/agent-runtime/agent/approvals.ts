/**
 * Per-run tool approval waiters keyed by nested Map(runId → toolCallId).
 * Nested maps avoid NUL-concat key collisions when ids contain "\0".
 * Approve/reject settle once; abortAll releases waiters without listener leaks.
 */

export const TOOL_REJECTED_MESSAGE = 'Tool execution rejected by user'

export type ApprovalDecision = 'approved' | 'rejected' | 'aborted'

type Waiter = {
    runId: string
    toolCallId: string
    resolve: (decision: ApprovalDecision) => void
    abortListener?: () => void
    signal?: AbortSignal
}

export class ApprovalController {
    private readonly waiters = new Map<string, Map<string, Waiter>>()

    /**
     * Wait for approve/reject/abort of one tool call.
     * Duplicate waiters for the same (runId, toolCallId) are rejected.
     */
    waitForApproval(
        runId: string,
        toolCallId: string,
        signal?: AbortSignal,
    ): Promise<ApprovalDecision> {
        if (!runId || !toolCallId) {
            return Promise.reject(new Error('runId and toolCallId are required'))
        }

        const runMap = this.ensureRunMap(runId)
        if (runMap.has(toolCallId)) {
            return Promise.reject(
                new Error(
                    `Duplicate approval waiter for runId=${runId} toolCallId=${toolCallId}`,
                ),
            )
        }

        if (signal?.aborted) {
            return Promise.resolve('aborted')
        }

        return new Promise<ApprovalDecision>((resolve) => {
            const waiter: Waiter = {
                runId,
                toolCallId,
                resolve: (decision) => {
                    this.cleanupWaiter(runId, toolCallId, waiter)
                    resolve(decision)
                },
                signal,
            }

            if (signal) {
                const onAbort = (): void => {
                    const current = this.waiters.get(runId)?.get(toolCallId)
                    if (current !== waiter) return
                    waiter.resolve('aborted')
                }
                waiter.abortListener = onAbort
                signal.addEventListener('abort', onAbort, { once: true })
            }

            runMap.set(toolCallId, waiter)
        })
    }

    /** Approve a pending waiter. Unknown keys are no-ops and return false. */
    approve(runId: string, toolCallId: string): boolean {
        return this.resolve(runId, toolCallId, 'approved')
    }

    /** Reject a pending waiter. Unknown keys are no-ops and return false. */
    reject(runId: string, toolCallId: string): boolean {
        return this.resolve(runId, toolCallId, 'rejected')
    }

    /**
     * Abort pending waiters.
     * - abortAll() — all runs
     * - abortAll(runId) — only that run
     */
    abortAll(runId?: string): void {
        const targets: Waiter[] = []
        if (runId !== undefined) {
            const runMap = this.waiters.get(runId)
            if (runMap) {
                for (const waiter of runMap.values()) {
                    targets.push(waiter)
                }
            }
        } else {
            for (const runMap of this.waiters.values()) {
                for (const waiter of runMap.values()) {
                    targets.push(waiter)
                }
            }
        }
        for (const waiter of targets) {
            waiter.resolve('aborted')
        }
    }

    hasPending(runId: string, toolCallId: string): boolean {
        return this.waiters.get(runId)?.has(toolCallId) === true
    }

    /** Test/debug helper: number of pending waiters (optionally for one run). */
    pendingCount(runId?: string): number {
        if (runId === undefined) {
            let count = 0
            for (const runMap of this.waiters.values()) {
                count += runMap.size
            }
            return count
        }
        return this.waiters.get(runId)?.size ?? 0
    }

    private ensureRunMap(runId: string): Map<string, Waiter> {
        let runMap = this.waiters.get(runId)
        if (!runMap) {
            runMap = new Map()
            this.waiters.set(runId, runMap)
        }
        return runMap
    }

    private resolve(
        runId: string,
        toolCallId: string,
        decision: ApprovalDecision,
    ): boolean {
        const waiter = this.waiters.get(runId)?.get(toolCallId)
        if (!waiter) return false
        waiter.resolve(decision)
        return true
    }

    private cleanupWaiter(runId: string, toolCallId: string, waiter: Waiter): void {
        const runMap = this.waiters.get(runId)
        if (!runMap) return
        if (runMap.get(toolCallId) !== waiter) return
        runMap.delete(toolCallId)
        if (runMap.size === 0) {
            this.waiters.delete(runId)
        }
        if (waiter.signal && waiter.abortListener) {
            waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        waiter.abortListener = undefined
        waiter.signal = undefined
    }
}
