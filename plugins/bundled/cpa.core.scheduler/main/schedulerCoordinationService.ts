import type { ScheduledTaskItem } from '@cpa/plugin-api'
import { STALLED_RUN_CLAIM } from '../shared/runClaim.js'

export interface SchedulerCoordinationStore {
    loadTasks(): Promise<readonly ScheduledTaskItem[]>
    saveTasks(tasks: readonly ScheduledTaskItem[]): Promise<void>
}

function mergeProgress(incoming: ScheduledTaskItem, current?: ScheduledTaskItem): ScheduledTaskItem {
    if (!current || incoming.schedule !== current.schedule || incoming.createdAt !== current.createdAt) {
        return incoming
    }

    const lastRunAt = Math.max(incoming.lastRunAt ?? 0, current.lastRunAt ?? 0)
    const lastAttemptAt = Math.max(incoming.lastAttemptAt ?? 0, current.lastAttemptAt ?? 0)
    return {
        ...incoming,
        lastRunAt: lastRunAt || null,
        lastAttemptAt: lastAttemptAt || null,
        lastRunError: lastRunAt >= lastAttemptAt
            ? null
            : (incoming.lastAttemptAt ?? 0) >= (current.lastAttemptAt ?? 0)
                ? (incoming.lastRunError ?? current.lastRunError ?? null)
                : (current.lastRunError ?? null),
    }
}

export class SchedulerCoordinationService {
    private tasks: ScheduledTaskItem[] = []
    private hydrated = false
    private hydrationPromise: Promise<void> | null = null
    private saveQueue: Promise<void> = Promise.resolve()
    private claims = new Map<string, { period: number; token: string; claimedAt: number; retryAfter: number; accepted: boolean }>()
    private claimSequence = 0
    private emitEvent: (event: any, rpcCtx?: any) => void
    private readonly store?: SchedulerCoordinationStore

    constructor(
        emitEvent: (event: any, rpcCtx?: any) => void,
        store?: SchedulerCoordinationStore,
    ) {
        this.emitEvent = emitEvent
        this.store = store
    }

    private async ensureHydrated(): Promise<void> {
        if (this.hydrated || !this.store) return
        this.hydrationPromise ??= (async () => {
            try {
                const loaded = await this.store!.loadTasks()
                if (Array.isArray(loaded)) this.tasks = [...loaded]
            } catch {
                // Keep in-memory tasks when durable store is unavailable (e.g. still staged).
            } finally {
                this.hydrated = true
            }
        })()
        await this.hydrationPromise
    }

    async list(): Promise<readonly ScheduledTaskItem[]> {
        await this.ensureHydrated()
        return this.tasks
    }

    private async persist(rpcCtx?: any): Promise<void> {
        const snapshot = [...this.tasks]
        if (this.store) {
            const queued = this.saveQueue.then(() => this.store!.saveTasks(snapshot))
            this.saveQueue = queued.catch(() => {})
            try {
                await queued
            } catch (err) {
                console.error('[cpa.core.scheduler] Failed to persist scheduled tasks:', err)
                throw err
            }
        }
        this.emitEvent(
            {
                operationId: `schedule-save-${Date.now()}`,
                sequence: Date.now(),
                kind: 'schedule:updated',
                data: JSON.stringify(this.tasks),
            },
            rpcCtx,
        )
    }

    async save(tasks: readonly ScheduledTaskItem[], rpcCtx?: any): Promise<void> {
        await this.ensureHydrated()
        const currentById = new Map(this.tasks.map((task) => [task.id, task]))
        this.tasks = Array.isArray(tasks)
            ? tasks.map((task) => mergeProgress(task, currentById.get(task.id)))
            : []
        await this.persist(rpcCtx)
    }

    async claimRun(taskId: string, schedule: string, period: number): Promise<string | null> {
        await this.ensureHydrated()
        const task = this.tasks.find((item) => item.id === taskId)
        if (!task?.enabled || task.status === 'paused' || task.status === 'completed' ||
            task.schedule !== schedule || !Number.isFinite(period) || (task.lastRunAt ?? 0) >= period) {
            return null
        }

        const current = this.claims.get(taskId)
        // A suspended renderer can resume and send later, so an in-flight claim must not expire.
        if (current?.period === period) {
            if (current.token && !current.accepted && Date.now() - current.claimedAt >= 300_000) {
                throw new Error(STALLED_RUN_CLAIM)
            }
            if (current.accepted || current.token || current.retryAfter > Date.now()) return null
        }
        const claimedAt = Date.now()
        const token = `${claimedAt}-${++this.claimSequence}`
        this.claims.set(taskId, { period, token, claimedAt, retryAfter: 0, accepted: false })
        return token
    }

    async recoverRun(taskId: string): Promise<boolean> {
        const claim = this.claims.get(taskId)
        if (!claim || claim.accepted || !claim.token || Date.now() - claim.claimedAt < 300_000) {
            return false
        }
        this.claims.delete(taskId)
        return true
    }

    async settleRun(taskId: string, period: number, token: string, acceptedAt: number | null): Promise<void> {
        const claim = this.claims.get(taskId)
        if (!claim || claim.period !== period || claim.token !== token) return
        if (acceptedAt === null) {
            claim.token = ''
            claim.retryAfter = Date.now() + 60_000
            return
        }
        if (!Number.isFinite(acceptedAt) || acceptedAt < period) return
        await this.ensureHydrated()
        claim.accepted = true
        if (!this.tasks.some((item) => item.id === taskId)) return
        this.tasks = this.tasks.map((item) => item.id === taskId
            ? { ...item, lastRunAt: acceptedAt, lastAttemptAt: acceptedAt, lastRunError: null, unread: true }
            : item)
        await this.persist()
    }

    async trigger(taskId: string, rpcCtx?: any): Promise<void> {
        this.emitEvent(
            {
                operationId: `schedule-trigger-${taskId}-${Date.now()}`,
                sequence: Date.now(),
                kind: 'schedule:triggered',
                data: JSON.stringify({ taskId }),
            },
            rpcCtx,
        )
    }

    dispose(): void {
        this.tasks = []
        this.hydrated = false
        this.hydrationPromise = null
        this.claims.clear()
    }
}
