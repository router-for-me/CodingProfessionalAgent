import type { ScheduledTaskItem } from '@cpa/plugin-api'

export interface SchedulerCoordinationStore {
    loadTasks(): Promise<readonly ScheduledTaskItem[]>
    saveTasks(tasks: readonly ScheduledTaskItem[]): Promise<void>
}

export class SchedulerCoordinationService {
    private tasks: ScheduledTaskItem[] = []
    private hydrated = false
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
        this.hydrated = true
        try {
            const loaded = await this.store.loadTasks()
            if (Array.isArray(loaded)) {
                this.tasks = [...loaded]
            }
        } catch {
            // Keep in-memory tasks when durable store is unavailable (e.g. still staged).
        }
    }

    async list(): Promise<readonly ScheduledTaskItem[]> {
        await this.ensureHydrated()
        return this.tasks
    }

    async save(tasks: readonly ScheduledTaskItem[], rpcCtx?: any): Promise<void> {
        this.tasks = Array.isArray(tasks) ? [...tasks] : []
        this.hydrated = true
        if (this.store) {
            try {
                await this.store.saveTasks(this.tasks)
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
    }
}
