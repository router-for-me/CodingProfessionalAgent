import type { HostServices } from '@cpa/plugin-api'
import {
    useScheduledTasksStore,
    type ScheduledTask,
} from '../stores/scheduledTasksStore.js'
import {
    findScheduledTaskProject,
    getPrimaryProjectPath,
} from './scheduledTaskProject.js'

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

export function isTaskDueToRun(task: ScheduledTask, now: Date = new Date()): boolean {
    if (!task.enabled || task.status === 'paused' || task.status === 'completed') {
        return false
    }

    const rule = parseScheduleRule(task.schedule)
    const nowMs = now.getTime()
    const lastRun = task.lastRunAt ?? 0

    if (rule.type === 'interval') {
        if (!rule.intervalMs || rule.intervalMs <= 0) return false
        return nowMs - lastRun >= rule.intervalMs
    }

    const currentHour = now.getHours()
    const currentMinute = now.getMinutes()
    const currentSecond = now.getSeconds()
    const currentDayOfWeek = now.getDay()

    // 1. Day of week constraint
    if (rule.type === 'weekdays') {
        if (currentDayOfWeek === 0 || currentDayOfWeek === 6) {
            return false
        }
    } else if (rule.type === 'weekly') {
        if (rule.dayOfWeek !== undefined && currentDayOfWeek !== rule.dayOfWeek) {
            return false
        }
    }

    // 2. Time constraint
    if (rule.type === 'hourly') {
        if (currentMinute !== rule.minute || currentSecond !== rule.second) {
            return false
        }
    } else {
        if (
            currentHour !== rule.hour ||
            currentMinute !== rule.minute ||
            currentSecond !== rule.second
        ) {
            return false
        }
    }

    // 3. Prevent duplicate run in the same window (55s cooldown)
    if (nowMs - lastRun < 55_000) {
        return false
    }

    return true
}

export type TaskExecutor = (task: ScheduledTask, runTime?: Date) => Promise<string | void>

export class ScheduledTaskScheduler {
    private timerId: ReturnType<typeof setInterval> | null = null
    private isTicking = false
    private customExecutor: TaskExecutor | null = null
    private services: HostServices | null = null

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
                if (isTaskDueToRun(task, now)) {
                    dueTasks.push(task)
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
            lastRunAt: runTime.getTime(),
            unread: true,
            ...(resolvedProject
                ? {
                      projectId: resolvedProject.id,
                      projectName: resolvedProject.name,
                      ...(resolvedProjectPath ? { projectPath: resolvedProjectPath } : {}),
                  }
                : {}),
        })

        if (this.customExecutor) {
            try {
                await this.customExecutor(task)
            } catch (err) {
                console.error(`Scheduled task [${task.id}] custom executor failed:`, err)
            }
            return
        }

        try {
            let sessionId: string | null = null
            const isExistingChat =
                task.runIn === 'existing-chat' &&
                task.chatSessionId &&
                task.chatSessionId !== 'new-chat'

            const currentSessions = this.services?.sessions?.getSnapshot?.() ?? []
            const existingSession = isExistingChat
                ? currentSessions.find((s) => s.id === task.chatSessionId)
                : null

            const isUsingExistingSession = Boolean(existingSession)
            if (existingSession) {
                sessionId = existingSession.id
            } else if (this.services?.sessions?.create) {
                const createdId = await this.services.sessions.create({
                    title: task.title,
                    projectId: targetProjectId ?? undefined,
                    scheduleId: task.id,
                    branch: pendingContext.branch ?? undefined,
                    workLocation: pendingContext.workLocation ?? 'local',
                    environmentId: pendingContext.environmentId ?? null,
                    modelId: task.modelId,
                    reasoningEffort: task.reasoningLevel,
                })
                sessionId = typeof createdId === 'string' ? createdId : String(createdId)
            }

            this.services?.ui?.pushToast?.(`Scheduled task [${task.title}] started as planned`)

            const sendFn = this.services?.agentRun?.send ?? this.services?.chatMessages?.send

            if (sendFn && sessionId) {
                await sendFn({
                    text: task.prompt,
                    projectId: targetProjectId ?? undefined,
                    branch: isUsingExistingSession ? undefined : (pendingContext.branch ?? undefined),
                    workLocation: isUsingExistingSession ? undefined : (pendingContext.workLocation ?? 'local'),
                    environmentId: isUsingExistingSession ? undefined : (pendingContext.environmentId ?? null),
                    sessionId,
                })
            }
        } catch (err) {
            console.error(`Failed to dispatch scheduled task [${task.id}]:`, err)
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
