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
import { STALLED_RUN_CLAIM } from '../../shared/runClaim.js'

describe('scheduledScheduler', () => {
    let mockSessions: SessionItem[]
    let mockProjects: Project[]
    let mockServices: HostServices
    let sendMock: ReturnType<typeof vi.fn>
    let toastMock: ReturnType<typeof vi.fn>
    let mockCurrentSessionId: string | null

    beforeEach(() => {
        mockSessions = []
        mockProjects = []
        mockCurrentSessionId = 'foreground-session'
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
                    mockCurrentSessionId = id
                    return id
                },
                getCurrentSessionId: () => mockCurrentSessionId,
                setCurrentSessionId: (id) => {
                    mockCurrentSessionId = id
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
            agentRun: {
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
            createdAt: 1000,
            ...overrides,
        })

        it('returns false if task is disabled or paused or completed', () => {
            const now = new Date(2025, 4, 15, 9, 0, 0)
            expect(isTaskDueToRun(createTask({ enabled: false }), now)).toBe(false)
            expect(isTaskDueToRun(createTask({ status: 'paused' }), now)).toBe(false)
            expect(isTaskDueToRun(createTask({ status: 'completed' }), now)).toBe(false)
        })

        it('catches up a daily task later the same day without replaying older days', () => {
            const task = createTask({ schedule: 'Daily 09:00:00' })
            const scheduledAt = new Date(2025, 4, 15, 9, 0, 0)

            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 8, 59, 59))).toBe(false)
            expect(isTaskDueToRun(task, scheduledAt)).toBe(true)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 9, 0, 1))).toBe(true)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 21, 0, 0))).toBe(true)
            expect(isTaskDueToRun(createTask({ lastRunAt: scheduledAt.getTime() }), new Date(2025, 4, 15, 21, 0, 0))).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 16, 8, 59, 59))).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 16, 9, 0, 1))).toBe(true)
        })

        it('does not immediately run a task created after its scheduled time', () => {
            const scheduledAt = new Date(2025, 4, 15, 9, 0, 0).getTime()
            const task = createTask({ createdAt: scheduledAt + 1000 })
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 10, 0, 0))).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 16, 9, 0, 1))).toBe(true)
        })

        it('handles weekdays tasks on Monday-Friday vs Weekend', () => {
            const task = createTask({ schedule: 'Weekdays 08:30:00' })
            // 2025-05-16 is Friday (day 5)
            const friday = new Date(2025, 4, 16, 8, 30, 0)
            expect(isTaskDueToRun(task, friday)).toBe(true)

            // 2025-05-17 is Saturday (day 6)
            const saturday = new Date(2025, 4, 17, 8, 30, 0)
            expect(isTaskDueToRun(task, saturday)).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 17, 12, 0, 0))).toBe(false)

            // 2025-05-18 is Sunday (day 0)
            const sunday = new Date(2025, 4, 18, 8, 30, 0)
            expect(isTaskDueToRun(task, sunday)).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 19, 8, 30, 1))).toBe(true)
        })

        it('catches up hourly runs only within their hour', () => {
            const task = createTask({ schedule: 'Hourly 15:30' })
            const now = new Date(2025, 4, 15, 9, 16, 0)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 9, 15, 29))).toBe(false)
            expect(isTaskDueToRun(task, now)).toBe(true)
            expect(isTaskDueToRun(createTask({ ...task, lastRunAt: now.getTime() }), new Date(2025, 4, 15, 9, 59, 0))).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 10, 0, 0))).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 10, 15, 31))).toBe(true)
        })

        it('catches up weekly runs only on the scheduled weekday', () => {
            const task = createTask({ schedule: 'Friday 16:00:00' })
            expect(isTaskDueToRun(task, new Date(2025, 4, 16, 17, 30, 0))).toBe(true)
            expect(isTaskDueToRun(task, new Date(2025, 4, 17, 17, 30, 0))).toBe(false)
        })

        it('prevents duplicate runs in the same scheduled period', () => {
            const now = new Date(2025, 4, 15, 9, 0, 0)
            const task = createTask({
                schedule: 'Daily 09:00:00',
                lastRunAt: now.getTime(),
            })
            expect(isTaskDueToRun(task, now)).toBe(false)

            const taskRanYesterday = createTask({
                schedule: 'Daily 09:00:00',
                lastRunAt: now.getTime() - 86_400_000, // ran yesterday
            })
            expect(isTaskDueToRun(taskRanYesterday, now)).toBe(true)
        })

        it('retries failed dispatches after a one-minute cooldown', () => {
            const now = new Date(2025, 4, 15, 9, 0, 30)
            const task = createTask({ lastAttemptAt: now.getTime() - 30_000, lastRunError: 'Unavailable' })
            expect(isTaskDueToRun(task, now)).toBe(false)
            expect(isTaskDueToRun(task, new Date(2025, 4, 15, 9, 1, 0))).toBe(true)
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

            const createdAt = now.getTime() - 10_000
            expect(isTaskDueToRun(createTask({ schedule: 'Every 30 seconds', createdAt }), now)).toBe(false)
            expect(isTaskDueToRun(createTask({
                schedule: 'Every 10 seconds',
                lastRunAt: now.getTime() - 11_000,
                lastAttemptAt: now.getTime() - 11_000,
                lastRunError: null,
            }), now)).toBe(true)
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
                    workLocation: undefined,
                    environmentId: undefined,
                }),
            )
        })

        it('creates a new session and sends prompt to the new session when existing-chat session is missing', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)

            const task: ScheduledTask = {
                id: 'task-missing-existing',
                title: 'Task for Missing Chat',
                schedule: 'Daily 09:00:00',
                prompt: 'Run something after deletion',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'existing-chat',
                chatSessionId: 'deleted-session-999',
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            const triggered = await scheduler.tick(now)
            expect(triggered).toHaveLength(1)
            expect(mockSessions).toHaveLength(1)
            const createdSessionId = mockSessions[0]?.id
            expect(createdSessionId).toBeDefined()
            expect(createdSessionId).not.toBe('deleted-session-999')
            expect(sendMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: createdSessionId,
                    text: 'Run something after deletion',
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
            expect(sendMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: mockSessions[0]?.id,
                    text: 'Run something new',
                    projectId: 'proj-1',
                }),
            )
        })

        it('preserves the foreground session when creating a background scheduled session', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)

            useScheduledTasksStore.setState({
                tasks: [
                    {
                        id: 'task-background',
                        title: 'Background Task',
                        schedule: 'Daily 09:00:00',
                        prompt: 'Run in the background',
                        enabled: true,
                        status: 'active',
                        createdAt: 1000,
                        runIn: 'new-chat',
                    },
                ],
            })

            await scheduler.tick(now)

            expect(mockSessions).toHaveLength(1)
            expect(mockCurrentSessionId).toBe('foreground-session')
            expect(sendMock).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId: mockSessions[0]?.id }),
            )
        })

        it('falls back to chatMessages.send when agentRun is undefined', async () => {
            const fallbackSend = vi.fn().mockResolvedValue('session-chatmessages-1')
            const servicesWithChatMessages = {
                ...mockServices,
                agentRun: undefined,
                chatMessages: {
                    send: fallbackSend,
                } as any,
            } as unknown as HostServices

            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(servicesWithChatMessages)
            const now = new Date(2025, 4, 15, 9, 0, 0)

            const task: ScheduledTask = {
                id: 'task-fallback',
                title: 'Task Fallback ChatMessages',
                schedule: 'Daily 09:00:00',
                prompt: 'Fallback prompt',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'new-chat',
            }
            useScheduledTasksStore.setState({ tasks: [task] })

            await scheduler.tick(now)

            expect(fallbackSend).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: mockSessions[0]?.id,
                    text: 'Fallback prompt',
                }),
            )
        })

        it('does not mark an unavailable agent as a successful run and retries later', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices({ ...mockServices, agentRun: undefined } as HostServices)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-agent-unavailable',
                title: 'No Agent',
                schedule: 'Daily 09:00:00',
                prompt: 'Run later',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'new-chat',
            }] })

            await scheduler.tick(now)
            expect(mockSessions).toHaveLength(0)
            expect(useScheduledTasksStore.getState().tasks[0]).toMatchObject({
                lastAttemptAt: now.getTime(),
                lastRunError: 'Agent send service is unavailable',
            })
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBeUndefined()
            expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('failed to start'), 'error')

            scheduler.setServices(mockServices)
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 30))
            expect(sendMock).not.toHaveBeenCalled()
            const retryAt = new Date(2025, 4, 15, 9, 1, 0)
            await scheduler.tick(retryAt)
            expect(sendMock).toHaveBeenCalledTimes(1)
            expect(useScheduledTasksStore.getState().tasks[0]).toMatchObject({
                lastRunAt: retryAt.getTime(),
                lastRunError: null,
            })
        })

        it('reuses a pending session when the agent does not accept the first dispatch', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            sendMock.mockResolvedValueOnce(undefined)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-retry',
                title: 'Retry Task',
                schedule: 'Daily 09:00:00',
                prompt: 'Retry prompt',
                enabled: true,
                status: 'active',
                createdAt: 1000,
                runIn: 'new-chat',
            }] })

            await scheduler.tick(now)
            expect(mockSessions).toHaveLength(1)
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBeUndefined()
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunError).toBe('Agent did not accept the scheduled task')

            await scheduler.tick(new Date(2025, 4, 15, 9, 1, 0))
            expect(mockSessions).toHaveLength(1)
            expect(sendMock).toHaveBeenCalledTimes(2)
            expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: mockSessions[0]?.id }))
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBe(new Date(2025, 4, 15, 9, 1, 0).getTime())
        })

        it('does not dispatch when another renderer already claimed the period', async () => {
            const claimRun = vi.fn().mockResolvedValue(null)
            const services = { ...mockServices, schedule: { claimRun, settleRun: vi.fn() } } as unknown as HostServices
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(services)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-claimed', title: 'Claimed task', schedule: 'Daily 09:00:00',
                prompt: 'Only once', enabled: true, createdAt: 1000,
            }] })

            await scheduler.tick(now)
            expect(claimRun).toHaveBeenCalledWith('task-claimed', 'Daily 09:00:00', now.getTime())
            expect(sendMock).not.toHaveBeenCalled()
            expect(mockSessions).toHaveLength(0)
            expect(useScheduledTasksStore.getState().tasks[0]?.lastAttemptAt).toBeUndefined()
        })

        it('records a stalled claim for explicit recovery', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices({
                ...mockServices,
                schedule: { claimRun: vi.fn().mockRejectedValue(new Error(STALLED_RUN_CLAIM)), settleRun: vi.fn() },
            } as unknown as HostServices)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-stalled', title: 'Stalled task', schedule: 'Daily 09:00:00',
                prompt: 'Do not send', enabled: true, createdAt: 1000,
            }] })
            await scheduler.tick(new Date(2025, 4, 15, 9, 6, 0))
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunError).toBe(STALLED_RUN_CLAIM)
            expect(sendMock).not.toHaveBeenCalled()
        })

        it('settles a claimed period only after the Agent accepts the dispatch', async () => {
            const settleRun = vi.fn().mockResolvedValue(undefined)
            const services = {
                ...mockServices,
                schedule: { claimRun: vi.fn().mockResolvedValue('claim-1'), settleRun },
            } as unknown as HostServices
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(services)
            const now = new Date(2025, 4, 15, 9, 0, 0)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-settle', title: 'Settle task', schedule: 'Daily 09:00:00',
                prompt: 'Finish', enabled: true, createdAt: 1000, runIn: 'new-chat',
            }] })

            await scheduler.tick(now)
            expect(sendMock).toHaveBeenCalledTimes(1)
            expect(settleRun).toHaveBeenCalledWith('task-settle', now.getTime(), 'claim-1', now.getTime())
        })

        it('keeps a completed period from running again after an older hydration event', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const task: ScheduledTask = {
                id: 'task-old-snapshot', title: 'Old snapshot', schedule: 'Daily 09:00:00',
                prompt: 'Do not repeat', enabled: true, createdAt: 1000,
            }
            useScheduledTasksStore.setState({ tasks: [task] })
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 0))
            useScheduledTasksStore.getState().hydrate([task])
            await scheduler.tick(new Date(2025, 4, 15, 9, 2, 0))
            expect(sendMock).toHaveBeenCalledTimes(1)
            await scheduler.tick(new Date(2025, 4, 16, 9, 0, 0))
            expect(sendMock).toHaveBeenCalledTimes(2)
        })

        it('keeps interval tasks running after an older hydration event', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(mockServices)
            const task: ScheduledTask = {
                id: 'task-interval-watermark', title: 'Interval task', schedule: 'Every 10 seconds',
                prompt: 'Run every interval', enabled: true,
                createdAt: new Date(2025, 4, 15, 9, 0, 0).getTime(), runIn: 'new-chat',
            }
            useScheduledTasksStore.setState({ tasks: [task] })
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 10))
            useScheduledTasksStore.getState().hydrate([task])
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 21))
            expect(sendMock).toHaveBeenCalledTimes(2)
            useScheduledTasksStore.getState().hydrate([task])
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 32))
            expect(sendMock).toHaveBeenCalledTimes(3)
        })

        it('retries a pending session with its original project and environment context', async () => {
            let projectId = 'project-a'
            let branch = 'branch-a'
            let environmentId = 'environment-a'
            const services = {
                ...mockServices,
                ui: {
                    ...mockServices.ui,
                    getPendingSessionContext: () => ({ projectId, branch, environmentId, workLocation: 'local' }),
                },
            } as HostServices
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setServices(services)
            sendMock.mockResolvedValueOnce(undefined)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-context', title: 'Original context', schedule: 'Daily 09:00:00',
                prompt: 'Same context', enabled: true, createdAt: 1000, runIn: 'new-chat',
            }] })
            await scheduler.tick(new Date(2025, 4, 15, 9, 0, 0))

            projectId = 'project-b'
            branch = 'branch-b'
            environmentId = 'environment-b'
            await scheduler.tick(new Date(2025, 4, 15, 9, 1, 0))
            expect(mockSessions).toHaveLength(1)
            expect(sendMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                sessionId: mockSessions[0]?.id,
                projectId: 'project-a', branch: 'branch-a', environmentId: 'environment-a',
            }))
        })

        it('does not mark a rejected custom execution as successful', async () => {
            const scheduler = new ScheduledTaskScheduler()
            scheduler.setExecutor(vi.fn().mockRejectedValueOnce(new Error('Executor unavailable')).mockResolvedValue(undefined))
            const now = new Date(2025, 4, 15, 9, 0, 0)
            useScheduledTasksStore.setState({ tasks: [{
                id: 'task-custom-failure',
                title: 'Custom Task',
                schedule: 'Daily 09:00:00',
                prompt: 'Run custom',
                enabled: true,
                status: 'active',
                createdAt: 1000,
            }] })

            await scheduler.tick(now)
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunError).toBe('Executor unavailable')
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBeUndefined()
            await scheduler.tick(new Date(2025, 4, 15, 9, 1, 0))
            expect(useScheduledTasksStore.getState().tasks[0]?.lastRunAt).toBe(new Date(2025, 4, 15, 9, 1, 0).getTime())
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
