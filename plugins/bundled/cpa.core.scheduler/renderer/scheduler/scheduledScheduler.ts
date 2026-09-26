import type { ChatSendPayload, HostServices } from '@cpa/plugin-api'
import {
    useScheduledTasksStore,
    type ScheduledTask,
} from '../stores/scheduledTasksStore.js'
import {
    findScheduledTaskProject,
    getPrimaryProjectPath,
} from './scheduledTaskProject.js'
import { STALLED_RUN_CLAIM } from '../../shared/runClaim.js'

export type ScheduleType =
    | 'daily'
    | 'weekdays'
    | 'weekly'
    | 'hourly'
    | 'interval'
    | 'custom'

export interface ParsedSchedule {
    type: ScheduleType
    hour?: number
    minute?: number
    second?: number
    dayOfWeek?: number
    dayOfMonth?: number
    intervalMs?: number
}

const ENGLISH_WEEKDAY_MAP: Record<string, number> = {
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
    sunday: 0,
    sun: 0,
}

export function parseScheduleRule(scheduleStr: string): ParsedSchedule {
    const raw = scheduleStr.trim()
    const lower = raw.toLowerCase()

    // 1. Interval pattern
    const intervalMatchEn = lower.match(/every\s+(\d+)?\s*(second|sec|minute|min|hour|hr|day)s?/)
    if (intervalMatchEn) {
        const count = intervalMatchEn[1] ? parseInt(intervalMatchEn[1], 10) : 1
        const unit = intervalMatchEn[2]
        let intervalMs = 0
        if (unit === 'second' || unit === 'sec') intervalMs = count * 1000
        else if (unit === 'minute' || unit === 'min') intervalMs = count * 60 * 1000
        else if (unit === 'hour' || unit === 'hr') intervalMs = count * 3600 * 1000
        else if (unit === 'day') intervalMs = count * 86400 * 1000
        return { type: 'interval', intervalMs }
    }

    // 2. Time extract
    let hour = 9
    let minute = 0
    let second = 0

    const timeMatch = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
    if (timeMatch) {
        if (lower.includes('hourly')) {
            if (timeMatch[3] !== undefined) {
                minute = parseInt(timeMatch[2] ?? '0', 10)
                second = parseInt(timeMatch[3] ?? '0', 10)
            } else {
                minute = parseInt(timeMatch[1] ?? '0', 10)
                second = parseInt(timeMatch[2] ?? '0', 10)
            }
        } else {
            hour = parseInt(timeMatch[1]!, 10)
            minute = parseInt(timeMatch[2]!, 10)
            second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0
        }
    }

    // 3. Hourly
    if (lower.includes('hourly')) {
        return { type: 'hourly', minute, second }
    }

    // 4. Weekdays
    if (lower.includes('weekday')) {
        return { type: 'weekdays', hour, minute, second }
    }

    // 5. Weekly
    let targetDayOfWeek: number | undefined
    for (const [dayName, day] of Object.entries(ENGLISH_WEEKDAY_MAP)) {
        if (lower.includes(dayName)) {
            targetDayOfWeek = day
            break
        }
    }
    if (lower.includes('weekly') || targetDayOfWeek !== undefined) {
        return {
            type: 'weekly',
            hour,
            minute,
            second,
            dayOfWeek: targetDayOfWeek ?? 1,
        }
    }

    // 6. Daily
    if (lower.includes('daily') || lower.includes('day')) {
        return { type: 'daily', hour, minute, second }
    }

    return { type: 'daily', hour, minute, second }
}

function scheduledTimeForPeriod(rule: ParsedSchedule, now: Date): number {
    return rule.type === 'hourly'
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), rule.minute, rule.second).getTime()
        : new Date(now.getFullYear(), now.getMonth(), now.getDate(), rule.hour, rule.minute, rule.second).getTime()
}

function runPeriod(task: ScheduledTask, now: Date): number {
    const rule = parseScheduleRule(task.schedule)
    return rule.type === 'interval'
        ? Math.max(task.lastRunAt ?? 0, task.createdAt) + (rule.intervalMs ?? 0)
        : scheduledTimeForPeriod(rule, now)
}

type DispatchContext = Pick<ChatSendPayload, 'projectId' | 'branch' | 'workLocation' | 'environmentId'>

interface PendingSession {
    schedule: string
    period: number
    sessionId: string
    context: DispatchContext
}

export function isTaskDueToRun(task: ScheduledTask, now: Date = new Date()): boolean {
    if (!task.enabled || task.status === 'paused' || task.status === 'completed') {
        return false
    }

    const rule = parseScheduleRule(task.schedule)
    const nowMs = now.getTime()
    const lastRun = task.lastRunAt ?? 0

    // Retry failed dispatches without creating a new session on every tick.
    if (task.lastRunError && task.lastAttemptAt && nowMs - task.lastAttemptAt < 60_000) {
        return false
    }

    if (rule.type === 'interval') {
        if (!rule.intervalMs || rule.intervalMs <= 0) return false
        return nowMs - Math.max(lastRun, task.createdAt) >= rule.intervalMs
    }

    const dayOfWeek = now.getDay()
    if (rule.type === 'weekdays' && (dayOfWeek === 0 || dayOfWeek === 6)) {
        return false
    }
    if (rule.type === 'weekly' && dayOfWeek !== rule.dayOfWeek) {
        return false
    }

    // Catch up within the current day/hour, but never replay earlier periods.
    const scheduledAt = scheduledTimeForPeriod(rule, now)

    return task.createdAt <= scheduledAt && nowMs >= scheduledAt && lastRun < scheduledAt
}

export type TaskExecutor = (task: ScheduledTask, runTime?: Date) => Promise<string | void>

export class ScheduledTaskScheduler {
    private timerId: ReturnType<typeof setInterval> | null = null
    private isTicking = false
    private customExecutor: TaskExecutor | null = null
    private services: HostServices | null = null
    private pendingSessions = new Map<string, PendingSession>()
    private completedRuns = new Map<string, { schedule: string; createdAt: number; acceptedAt: number }>()

    setServices(services: HostServices | null): void {
        this.services = services
    }

    setExecutor(executor: TaskExecutor | null): void {
        this.customExecutor = executor
    }

    start(services?: HostServices | null): void {
        if (services !== undefined) {
            this.services = services
        }
        if (this.timerId !== null) return
        this.timerId = setInterval(() => {
            void this.tick()
        }, 1000)
    }

    stop(): void {
        if (this.timerId !== null) {
            clearInterval(this.timerId)
            this.timerId = null
        }
        this.pendingSessions.clear()
        this.completedRuns.clear()
    }

    isRunning(): boolean {
        return this.timerId !== null
    }

    async tick(now: Date = new Date()): Promise<ScheduledTask[]> {
        if (this.isTicking) return []
        this.isTicking = true

        try {
            const tasks = useScheduledTasksStore.getState().tasks
            const dueTasks: ScheduledTask[] = []

            for (const task of tasks) {
                const completed = this.completedRuns.get(task.id)
                const effectiveTask = completed?.schedule === task.schedule &&
                    completed.createdAt === task.createdAt && completed.acceptedAt > (task.lastRunAt ?? 0)
                    ? { ...task, lastRunAt: completed.acceptedAt, lastRunError: null }
                    : task
                if (isTaskDueToRun(effectiveTask, now)) {
                    dueTasks.push(effectiveTask)
                }
            }

            for (const task of dueTasks) {
                await this.executeTask(task, now)
            }

            return dueTasks
        } finally {
            this.isTicking = false
        }
    }

    private async executeTask(task: ScheduledTask, runTime: Date): Promise<void> {
        const period = runPeriod(task, runTime)
        let claimToken: string | null = null
        let attemptRecorded = false

        try {
            const claimRun = this.services?.schedule?.claimRun
            if (claimRun) {
                if (!this.services?.schedule?.settleRun) {
                    throw new Error('Schedule settlement service is unavailable')
                }
                claimToken = await claimRun(task.id, task.schedule, period)
                if (!claimToken) return
            }

            const projects = this.services?.projects?.getSnapshot?.() ?? []
            const pendingContext = this.services?.ui?.getPendingSessionContext?.() ?? {
                projectId: null,
                branch: null,
                workLocation: 'local',
                environmentId: null,
            }
            const resolvedProject = findScheduledTaskProject(task, projects)
            const resolvedProjectPath = getPrimaryProjectPath(resolvedProject)
            const targetProjectId =
                resolvedProject?.id ?? task.projectId ?? pendingContext.projectId

            useScheduledTasksStore.getState().updateTask(task.id, {
                lastAttemptAt: runTime.getTime(),
                ...(resolvedProject
                    ? {
                          projectId: resolvedProject.id,
                          projectName: resolvedProject.name,
                          ...(resolvedProjectPath ? { projectPath: resolvedProjectPath } : {}),
                      }
                    : {}),
            })
            attemptRecorded = true

            if (this.customExecutor) {
                await this.customExecutor(task)
            } else {
                const sendFn = this.services?.agentRun?.send ?? this.services?.chatMessages?.send
                if (!sendFn) throw new Error('Agent send service is unavailable')

                const isExistingChat =
                    task.runIn === 'existing-chat' &&
                    task.chatSessionId &&
                    task.chatSessionId !== 'new-chat'
                const currentSessions = this.services?.sessions?.getSnapshot?.() ?? []
                const foregroundSessionId =
                    this.services?.sessions?.getCurrentSessionId?.() ?? null
                const existingSession = isExistingChat
                    ? currentSessions.find((session) => session.id === task.chatSessionId)
                    : null
                let sessionId = existingSession?.id ?? null
                let context: DispatchContext = {
                    projectId: targetProjectId ?? undefined,
                    branch: existingSession ? undefined : (pendingContext.branch ?? undefined),
                    workLocation: existingSession ? undefined : (pendingContext.workLocation ?? 'local'),
                    environmentId: existingSession ? undefined : (pendingContext.environmentId ?? null),
                }

                if (!sessionId) {
                    const pending = this.pendingSessions.get(task.id)
                    if (pending?.schedule === task.schedule && pending.period === period &&
                        currentSessions.some((session) => session.id === pending.sessionId)) {
                        sessionId = pending.sessionId
                        context = pending.context
                    } else {
                        if (!this.services?.sessions?.create) {
                            throw new Error('Session creation service is unavailable')
                        }
                        sessionId = await this.services.sessions.create({
                            title: task.title,
                            projectId: targetProjectId ?? undefined,
                            scheduleId: task.id,
                            branch: context.branch ?? undefined,
                            workLocation: context.workLocation,
                            environmentId: context.environmentId,
                            modelId: task.modelId,
                            reasoningEffort: task.reasoningLevel,
                        })
                        if (!sessionId) throw new Error('Scheduled session could not be created')
                        this.pendingSessions.set(task.id, { schedule: task.schedule, period, sessionId, context })
                        if (this.services.sessions.getCurrentSessionId?.() === sessionId) {
                            this.services.sessions.setCurrentSessionId?.(foregroundSessionId)
                        }
                    }
                }

                const acceptedSessionId = await sendFn({ text: task.prompt, sessionId, ...context })
                if (!acceptedSessionId) throw new Error('Agent did not accept the scheduled task')
            }

            this.completedRuns.set(task.id, {
                schedule: task.schedule,
                createdAt: task.createdAt,
                acceptedAt: runTime.getTime(),
            })
            this.pendingSessions.delete(task.id)
            useScheduledTasksStore.getState().updateTask(task.id, {
                lastRunAt: runTime.getTime(),
                lastRunError: null,
                unread: true,
            })
            if (claimToken) {
                try {
                    await this.services?.schedule?.settleRun?.(task.id, period, claimToken, runTime.getTime())
                } catch (err) {
                    console.error(`Failed to persist scheduled task [${task.id}] completion:`, err)
                }
            }
            this.services?.ui?.pushToast?.(`Scheduled task [${task.title}] started as planned`)
        } catch (err) {
            if (claimToken) {
                try {
                    await this.services?.schedule?.settleRun?.(task.id, period, claimToken, null)
                } catch (settleError) {
                    console.error(`Failed to release scheduled task [${task.id}] claim:`, settleError)
                }
            }
            console.error(`Failed to dispatch scheduled task [${task.id}]:`, err)
            const rawMessage = err instanceof Error ? err.message : String(err)
            const message = rawMessage.includes(STALLED_RUN_CLAIM) ? STALLED_RUN_CLAIM : rawMessage
            if (!attemptRecorded) {
                useScheduledTasksStore.getState().updateTask(task.id, { lastAttemptAt: runTime.getTime() })
            }
            useScheduledTasksStore.getState().updateTask(task.id, { lastRunError: message })
            if (task.lastRunError !== message) {
                this.services?.ui?.pushToast?.(`Scheduled task [${task.title}] failed to start: ${message}`, 'error')
            }
        }
    }
}

export const globalScheduledScheduler = new ScheduledTaskScheduler()

export function initScheduledTaskRunner(services?: HostServices | null): () => void {
    globalScheduledScheduler.start(services)
    return () => {
        globalScheduledScheduler.stop()
    }
}
