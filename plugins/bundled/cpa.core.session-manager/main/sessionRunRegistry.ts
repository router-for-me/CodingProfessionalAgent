import type { ActiveRunInfo, NativeEvent, ResumePromptSyncState, SessionDelegateRunRequest } from '../../../../src/shared/types.js'

let delegateSeq = 0
const MAX_PENDING_DELEGATE_RUNS = 256

export class SessionRunRegistry {
    private readonly runs = new Map<string, ActiveRunInfo>()
    private readonly pendingDelegateRuns = new Map<string, SessionDelegateRunRequest>()
    private readonly deletedSessionIds = new Set<string>()
    private readonly emitEvent: (event: NativeEvent) => void
    private resumePromptState: ResumePromptSyncState = {
        isOpen: false,
        totalCount: 0,
        countdown: 0,
        unfinishedSessionIds: [],
        unfinishedSubAgentIds: [],
    }

    constructor(emitEvent: (event: NativeEvent) => void) {
        this.emitEvent = emitEvent
    }

    getResumePromptState(): ResumePromptSyncState {
        return {
            isOpen: this.resumePromptState.isOpen,
            totalCount: this.resumePromptState.totalCount,
            countdown: this.resumePromptState.countdown,
            unfinishedSessionIds: [...this.resumePromptState.unfinishedSessionIds],
            unfinishedSubAgentIds: [...this.resumePromptState.unfinishedSubAgentIds],
        }
    }

    broadcastResumePromptState(state: ResumePromptSyncState): void {
        this.resumePromptState = {
            isOpen: Boolean(state.isOpen),
            totalCount: typeof state.totalCount === 'number' ? state.totalCount : 0,
            countdown: typeof state.countdown === 'number' ? state.countdown : 0,
            unfinishedSessionIds: Array.isArray(state.unfinishedSessionIds) ? [...state.unfinishedSessionIds] : [],
            unfinishedSubAgentIds: Array.isArray(state.unfinishedSubAgentIds) ? [...state.unfinishedSubAgentIds] : [],
        }
        this.emitEvent({
            operationId: `resume-prompt-state-${Date.now()}`,
            sequence: Date.now(),
            kind: 'session:resume-prompt-state',
            data: JSON.stringify(this.resumePromptState),
        })
    }

    dispatchResumePromptAction(action: 'continue' | 'abort'): void {
        this.emitEvent({
            operationId: `resume-prompt-action-${Date.now()}`,
            sequence: Date.now(),
            kind: 'session:resume-prompt-action',
            data: JSON.stringify({ action }),
        })
    }

    addPendingDelegateRun(req: SessionDelegateRunRequest): string {
        if (req.sessionId && this.deletedSessionIds.has(req.sessionId)) {
            throw new Error(`Cannot delegate run to deleted session: ${req.sessionId}`)
        }
        // If userEntryId is provided and we already have a pending request for the same userEntryId,
        // reuse that request's id to guarantee idempotency even if caller didn't supply requestId
        if (req.userEntryId && !req.editMessageId && req.sessionId) {
            for (const [existingId, existingReq] of this.pendingDelegateRuns) {
                if (
                    existingReq.userEntryId === req.userEntryId &&
                    existingReq.sessionId === req.sessionId
                ) {
                    req.requestId = existingId
                    this.pendingDelegateRuns.set(existingId, req)
                    return existingId
                }
            }
        }
        const requestId =
            req.requestId ||
            (req.userEntryId ? `req-${req.userEntryId}` : `delegate-${Date.now()}${++delegateSeq}`)
        req.requestId = requestId
        if (this.pendingDelegateRuns.has(requestId)) {
            this.pendingDelegateRuns.set(requestId, req)
            return requestId
        }
        if (this.pendingDelegateRuns.size >= MAX_PENDING_DELEGATE_RUNS) {
            throw new Error(
                `Delegate queue is full (${MAX_PENDING_DELEGATE_RUNS} pending runs). Please wait for the host to process existing tasks.`,
            )
        }
        this.pendingDelegateRuns.set(requestId, req)
        return requestId
    }

    claimPendingDelegateRuns(): SessionDelegateRunRequest[] {
        return Array.from(this.pendingDelegateRuns.values())
    }

    removePendingDelegateRunsForSession(sessionId: string): number {
        if (!sessionId) return 0
        this.deletedSessionIds.add(sessionId)
        if (this.deletedSessionIds.size > 1000) {
            const oldest = this.deletedSessionIds.values().next().value
            if (oldest) this.deletedSessionIds.delete(oldest)
        }
        let removed = 0
        for (const [id, req] of this.pendingDelegateRuns) {
            if (req.sessionId === sessionId) {
                this.pendingDelegateRuns.delete(id)
                removed++
            }
        }
        return removed
    }

    ackDelegateRun(id: string): void {
        if (!id) return
        if (this.pendingDelegateRuns.delete(id)) {
            return
        }
        for (const [key, req] of this.pendingDelegateRuns.entries()) {
            if (req.requestId === id || (req.userEntryId && req.userEntryId === id)) {
                this.pendingDelegateRuns.delete(key)
                return
            }
        }
    }

    registerOrUpdate(info: Omit<ActiveRunInfo, 'updatedAt'>): void {
        const current = this.runs.get(info.sessionId)
        const now = Date.now()
        if (info.status === 'idle') {
            if (current && current.runId !== info.runId) {
                return // Stale idle from a replaced run, ignore
            }
            this.runs.delete(info.sessionId)
        } else {
            this.runs.set(info.sessionId, {
                ...info,
                updatedAt: now,
            })
        }
        this.broadcastStatus(info.sessionId, info.status, info.runId, info.clientId, now)
    }

    getActiveRuns(): ActiveRunInfo[] {
        return Array.from(this.runs.values()).map((run) => ({ ...run }))
    }

    cleanupClientRuns(clientId: string): void {
        for (const [sessionId, run] of this.runs.entries()) {
            if (run.clientId === clientId) {
                this.runs.delete(sessionId)
                this.broadcastStatus(sessionId, 'idle', run.runId, clientId)
            }
        }
    }

    unregister(sessionId: string): void {
        const run = this.runs.get(sessionId)
        if (!run) {
            return // Idempotent, ignore if not found
        }
        this.runs.delete(sessionId)
        this.broadcastStatus(sessionId, 'idle', run.runId, run.clientId)
    }

    private broadcastStatus(
        sessionId: string,
        status: ActiveRunInfo['status'],
        runId: string,
        clientId: string,
        updatedAt: number = Date.now(),
    ): void {
        this.emitEvent({
            operationId: `run-status-${sessionId}`,
            sequence: updatedAt,
            kind: 'session:run-status',
            data: JSON.stringify({
                sessionId,
                status,
                runId,
                clientId,
                updatedAt,
            }),
        })
    }
}

