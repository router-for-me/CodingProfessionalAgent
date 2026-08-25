import type { ActiveRunInfo, NativeEvent, ResumePromptSyncState } from '../../../../src/shared/types.js'

export class SessionRunRegistry {
    private readonly runs = new Map<string, ActiveRunInfo>()
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

