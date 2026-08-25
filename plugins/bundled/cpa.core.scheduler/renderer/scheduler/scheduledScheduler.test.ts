import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import {
    parseScheduleRule,
    isTaskDueToRun,
    ScheduledTaskScheduler,
    globalScheduledScheduler,
    initScheduledTaskRunner,
} from './scheduledScheduler.js'
import { useScheduledTasksStore, type ScheduledTask } from '../stores/scheduledTasksStore.js'
import type { HostServices, Project, SessionItem } from '@cpa/plugin-api'

describe('scheduledScheduler', () => {
    let mockSessions: SessionItem[]
    let mockProjects: Project[]
    let mockServices: HostServices
    let sendMock: ReturnType<typeof vi.fn>
    let toastMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        mockSessions = []
        mockProjects = []
        sendMock = vi.fn().mockResolvedValue('session-created-1')
        toastMock = vi.fn()

        mockServices = {
            sessions: {
                getSnapshot: () => mockSessions,
                subscribe: () => () => {},
                list: async () => mockSessions,
                get: async (id) => mockSessions.find((s) => s.id === id),
                create: (input: any) => {
                    const id = input?.id || `sess-${Date.now()}`
                    const newSession: SessionItem = {
                        id,
                        title: input?.title || 'New chat',
                        projectId: input?.projectId,
                        scheduleId: input?.scheduleId,
                        pinned: false,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    }
                    mockSessions.push(newSession)
                    return id
                },
                update: async (id, patch) => {
                    const idx = mockSessions.findIndex((s) => s.id === id)
                    if (idx >= 0) {
                        mockSessions[idx] = { ...mockSessions[idx]!, ...patch }
                    }
                },
                broadcastRunStatus: async () => {},
            } as any,
            projects: {
                getSnapshot: () => mockProjects,
                subscribe: () => () => {},
                list: async () => mockProjects,
                save: async () => {},
                remove: async () => {},
            } as any,
            ui: {
                getPendingSessionContext: () => ({
                    projectId: null,
                    branch: null,
                    workLocation: 'local',
                    environmentId: null,
                }),
                pushToast: toastMock,
            } as any,
            agent: {
                send: sendMock,
            } as any,
        } as unknown as HostServices

        useScheduledTasksStore.setState({ tasks: [] })
        globalScheduledScheduler.stop()
    })

    afterEach(() => {
        globalScheduledScheduler.stop()
        vi.useRealTimers()
    })

    describe('parseScheduleRule', () => {
        it('parses daily schedule with time', () => {
            const parsed = parseScheduleRule('Daily 09:30:15')
            expect(parsed.type).toBe('daily')
            expect(parsed.hour).toBe(9)
            expect(parsed.minute).toBe(30)
            expect(parsed.second).toBe(15)
        })

        it('parses weekdays schedule', () => {
            const parsed = parseScheduleRule('Weekdays 08:00')
            expect(parsed.type).toBe('weekdays')
            expect(parsed.hour).toBe(8)
            expect(parsed.minute).toBe(0)
            expect(parsed.second).toBe(0)
        })

        it('parses weekly schedule with specific day', () => {
            const parsed = parseScheduleRule('Friday 16:00:00')
            expect(parsed.type).toBe('weekly')
            expect(parsed.hour).toBe(16)
            expect(parsed.minute).toBe(0)
            expect(parsed.second).toBe(0)
            expect(parsed.dayOfWeek).toBe(5)
        })

        it('parses hourly schedule', () => {
            const parsed = parseScheduleRule('Hourly 15:30')
            expect(parsed.type).toBe('hourly')
            expect(parsed.minute).toBe(15)
            expect(parsed.second).toBe(30)
        })

        it('parses interval schedule (seconds, minutes, hours)', () => {
            const sec = parseScheduleRule('Every 10 seconds')
            expect(sec.type).toBe('interval')
            expect(sec.intervalMs).toBe(10_000)

            const min = parseScheduleRule('every 5 minutes')
            expect(min.type).toBe('interval')
            expect(min.intervalMs).toBe(300_000)

            const hr = parseScheduleRule('Every 2 hours')
            expect(hr.type).toBe('interval')
            expect(hr.intervalMs).toBe(7_200_000)
        })
    })

    describe('isTaskDueToRun', () => {
        const createTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
            id: 'task-1',
            title: 'Test Task',
            schedule: 'Daily 09:00:00',
            prompt: 'Do something',
            enabled: true,
            status: 'active',
            createdAt: Date.now() - 100_000,
            ...overrides,
        })

        it('returns false if task is disabled or paused or completed', () => {
            const now = new Date(2025, 4, 15, 9, 0, 0)
            expect(isTaskDueToRun(createTask({ enabled: false }), now)).toBe(false)
            expect(isTaskDueToRun(createTask({ status: 'paused' }), now)).toBe(false)
            expect(isTaskDueToRun(createTask({ status: 'completed' }), now)).toBe(false)
        })

        it('returns true when daily task matches exact time', () => {
            const task = createTask({ schedule: 'Daily 09:00:00' })
            const nowMatch = new Date(2025, 4, 15, 9, 0, 0)
            const nowMismatch = new Date(2025, 4, 15, 9, 0, 1)

            expect(isTaskDueToRun(task, nowMatch)).toBe(true)
            expect(isTaskDueToRun(task, nowMismatch)).toBe(false)
        })

        it('handles weekdays tasks on Monday-Friday vs Weekend', () => {
            const task = createTask({ schedule: 'Weekdays 08:30:00' })
            // 2025-05-16 is Friday (day 5)
            const friday = new Date(2025, 4, 16, 8, 30, 0)
            expect(isTaskDueToRun(task, friday)).toBe(true)

            // 2025-05-17 is Saturday (day 6)
            const saturday = new Date(2025, 4, 17, 8, 30, 0)
            expect(isTaskDueToRun(task, saturday)).toBe(false)

            // 2025-05-18 is Sunday (day 0)
            const sunday = new Date(2025, 4, 18, 8, 30, 0)
            expect(isTaskDueToRun(task, sunday)).toBe(false)
        })

        it('prevents double triggering within 55s cooldown', () => {
            const now = new Date(2025, 4, 15, 9, 0, 0)
            const task = createTask({
                schedule: 'Daily 09:00:00',
                lastRunAt: now.getTime() - 10_000, // ran 10s ago
            })
            expect(isTaskDueToRun(task, now)).toBe(false)

            const taskRanYesterday = createTask({
                schedule: 'Daily 09:00:00',
                lastRunAt: now.getTime() - 86_400_000, // ran yesterday
            })
            expect(isTaskDueToRun(taskRanYesterday, now)).toBe(true)
        })

        it('handles interval tasks', () => {
            const now = new Date(2025, 4, 15, 10, 0, 0)
            const task = createTask({
                schedule: 'Every 30 seconds',
                lastRunAt: now.getTime() - 31_000,
            })
            expect(isTaskDueToRun(task, now)).toBe(true)

            const taskNotYet = createTask({
                schedule: 'Every 30 seconds',
                lastRunAt: now.getTime() - 20_000,
            })
            expect(isTaskDueToRun(taskNotYet, now)).toBe(false)
        })
    })

    describe('ScheduledTaskScheduler', () => {
        it('starts 1-second interval and triggers due tasks', async () => {
            vi.useFakeTimers()
            const scheduler = new ScheduledTaskScheduler()
            const executor = vi.fn().mockResolvedValue('session-1')
            scheduler.setExecutor(executor)

            const fixedTime = new Date(2025, 4, 15, 8, 59, 59)
            vi.setSystemTime(fixedTime)

            const task: ScheduledTask = {
                id: 'task-123',
                title: 'Morning Report',
                schedule: 'Daily 09:00:00',
                prompt: 'Generate summary',
                enabled: true,
                status: 'active',
                createdAt: Date.now() - 100_000,
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            scheduler.start(mockServices)
            expect(scheduler.isRunning()).toBe(true)

            await vi.advanceTimersByTimeAsync(1000)

            expect(executor).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'task-123', title: 'Morning Report' }),
            )
            const updated = useScheduledTasksStore.getState().tasks[0]
            expect(updated?.lastRunAt).toBe(new Date(2025, 4, 15, 9, 0, 0).getTime())
            expect(updated?.unread).toBe(true)

            scheduler.stop()
            expect(scheduler.isRunning()).toBe(false)
        })

        it('dispatches to existing session when runIn is existing-chat and session exists', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            const session: SessionItem = {
                id: 'existing-sess-1',
                title: 'Existing Session',
                pinned: false,
                createdAt: 1000,
                updatedAt: 1000,
            }
            mockSessions.push(session)

            const task: ScheduledTask = {
                id: 'task-existing',
                title: 'Task for Existing Chat',
                schedule: 'Daily 09:00:00',
                prompt: 'Run something',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'existing-chat',
                chatSessionId: 'existing-sess-1',
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            const triggered = await scheduler.tick(now)
            expect(triggered).toHaveLength(1)
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBe(now.getTime())
            expect(sendMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: 'existing-sess-1',
                    text: 'Run something',
                }),
            )
        })

        it('creates new session when runIn is new-chat', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)

            const task: ScheduledTask = {
                id: 'task-new',
                title: 'Task for New Chat',
                schedule: 'Daily 09:00:00',
                prompt: 'Run something new',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'new-chat',
                projectId: 'proj-1',
                modelId: 'gpt-5.6-sol',
                reasoningLevel: 'high',
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            const triggered = await scheduler.tick(now)
            expect(triggered).toHaveLength(1)
            expect(mockSessions).toHaveLength(1)
            expect(mockSessions[0]?.title).toBe('Task for New Chat')
            expect(mockSessions[0]?.projectId).toBe('proj-1')
        })

        it('re-associates a recreated project by its unchanged path', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            mockProjects.push({
                id: 'proj-recreated',
                name: 'Recreated Project',
                path: '/workspace/project',
                paths: ['/workspace/project'],
                pinned: false,
                createdAt: 2000,
                updatedAt: 2000,
            })

            const task: ScheduledTask = {
                id: 'task-recreated-project',
                title: 'Task for Recreated Project',
                schedule: 'Daily 09:00:00',
                prompt: 'Run in recreated project',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'new-chat',
                projectId: 'proj-deleted',
                projectPath: '/workspace/project',
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            await scheduler.tick(now)

            expect(mockSessions[0]?.projectId).toBe('proj-recreated')
        })

        it('handles clock jitter and tick boundaries without skipping due tasks or double firing', async () => {
            vi.useFakeTimers()
            const scheduler = new ScheduledTaskScheduler()
            const executor = vi.fn().mockResolvedValue('session-jitter')
            scheduler.setExecutor(executor)

            // System time lands at 08:59:59.850 (150ms before second transition)
            const baseTime = new Date(2025, 4, 15, 8, 59, 59, 850)
            vi.setSystemTime(baseTime)

            const task: ScheduledTask = {
                id: 'task-jitter',
                title: 'Jitter Task',
                schedule: 'Daily 09:00:00',
                prompt: 'Test clock jitter',
                enabled: true,
                status: 'active',
                createdAt: 1000,
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            scheduler.start(mockServices)

            // Tick 1: 150ms later -> 09:00:00.000
            await vi.advanceTimersByTimeAsync(150)
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 0))
            expect(executor).toHaveBeenCalledTimes(1)

            // Tick 2: 500ms later -> 09:00:00.500 (still inside 55s cooldown, should NOT double fire)
            await vi.advanceTimersByTimeAsync(500)
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 0, 500))
            expect(executor).toHaveBeenCalledTimes(1)

            scheduler.stop()
        })

        it('initScheduledTaskRunner starts and cleans up global scheduler', () => {
            const cleanup = initScheduledTaskRunner(mockServices)
            expect(globalScheduledScheduler.isRunning()).toBe(true)
            cleanup()
            expect(globalScheduledScheduler.isRunning()).toBe(false)
        })
    })
})
