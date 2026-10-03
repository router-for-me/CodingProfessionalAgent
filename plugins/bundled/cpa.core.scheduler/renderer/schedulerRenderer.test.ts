import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { schedulerRendererEntry } from './index.js'
import { globalScheduledScheduler } from './scheduler/scheduledScheduler.js'
import manifest from '../manifest.json' with { type: 'json' }
import { useScheduledTasksStore, type ScheduledTask } from './stores/scheduledTasksStore.js'
import type { HostServices, ScheduleService, ScheduledTaskItem } from '@cpa/plugin-api'

describe('cpa.core.scheduler renderer entry', () => {
    let savedTasks: ScheduledTaskItem[]
    let listMock: ReturnType<typeof vi.fn>
    let saveMock: ReturnType<typeof vi.fn>
    let toastMock: ReturnType<typeof vi.fn>
    let mockScheduleService: ScheduleService
    let mockServices: HostServices

    beforeEach(() => {
        savedTasks = [
            {
                id: 'sched-1',
                title: 'Hydrated Task',
                schedule: 'Daily 09:00:00',
                prompt: 'Echo status',
                enabled: true,
                createdAt: 1000,
            },
        ]
        listMock = vi.fn().mockResolvedValue(savedTasks)
        saveMock = vi.fn().mockResolvedValue(undefined)
        toastMock = vi.fn()

        mockScheduleService = {
            list: listMock,
            save: saveMock,
        }

        mockServices = {
            schedule: mockScheduleService,
            sessions: {
                getSnapshot: () => [],
                subscribe: () => () => {},
                list: async () => [],
                get: async () => undefined,
                update: async () => {},
                broadcastRunStatus: async () => {},
            } as any,
            projects: {
                getSnapshot: () => [],
                subscribe: () => () => {},
                list: async () => [],
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
            notifications: {
                show: toastMock,
            } as any,
        } as unknown as HostServices

        useScheduledTasksStore.setState({ tasks: [] })
    })

    afterEach(() => {
        globalScheduledScheduler.stop()
        globalScheduledScheduler.setExecutor(null)
        vi.useRealTimers()
    })

    it('retries staged RPC failures without opening a view and executes only once after repeated hydration', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 8, 10, 10))
        listMock.mockRejectedValueOnce(new Error('RPC still staged'))
        const execute = vi.fn().mockResolvedValue('session-1')
        globalScheduledScheduler.setExecutor(execute)
        const harness = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        await harness.activate()
        await vi.advanceTimersByTimeAsync(0)
        expect(listMock).toHaveBeenCalledTimes(1)
        expect(globalScheduledScheduler.isRunning()).toBe(false)
        await vi.advanceTimersByTimeAsync(2000)
        expect(listMock).toHaveBeenCalledTimes(2)
        expect(execute).toHaveBeenCalledTimes(1)
        useScheduledTasksStore.getState().hydrate(savedTasks as ScheduledTask[])
        await vi.advanceTimersByTimeAsync(5000)
        expect(execute).toHaveBeenCalledTimes(1)
        await harness.deactivate()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps the new generation running when the old generation deactivates', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 8, 10, 8, 59, 58))
        const execute = vi.fn().mockResolvedValue('session-1')
        globalScheduledScheduler.setExecutor(execute)
        const nextToast = vi.fn()
        const nextServices = { ...mockServices, ui: { ...mockServices.ui, pushToast: nextToast } }
        const first = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        const second = createPluginTestHarness(schedulerRendererEntry, { manifest, services: nextServices })
        Object.assign(first.context, { services: mockServices })
        Object.assign(second.context, { services: nextServices })
        await first.activate()
        await vi.advanceTimersByTimeAsync(0)
        await second.activate()
        await vi.advanceTimersByTimeAsync(0)
        expect(listMock).toHaveBeenCalledTimes(2)
        expect(vi.getTimerCount()).toBe(1)
        await first.deactivate()
        expect(globalScheduledScheduler.isRunning()).toBe(true)
        await vi.advanceTimersByTimeAsync(3000)
        expect(execute).toHaveBeenCalledTimes(1)
        expect(nextToast).toHaveBeenCalledTimes(1)
        expect(toastMock).not.toHaveBeenCalled()
        useScheduledTasksStore.getState().hydrate(savedTasks as ScheduledTask[])
        await vi.advanceTimersByTimeAsync(2000)
        expect(execute).toHaveBeenCalledTimes(1)
        await second.deactivate()
        expect(globalScheduledScheduler.isRunning()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each([false, true])('drains accepted saves before deactivation (first save rejects: %s)', async (rejectFirst) => {
        vi.useFakeTimers()
        const harness = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        await harness.activate()
        await vi.advanceTimersByTimeAsync(0)
        let finishFirst!: () => void
        saveMock.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
            finishFirst = () => rejectFirst ? reject(new Error('First save failed')) : resolve()
        }))
        useScheduledTasksStore.getState().updateTask('sched-1', { enabled: false, status: 'paused' })
        await vi.advanceTimersByTimeAsync(0)
        expect(saveMock).toHaveBeenCalledTimes(1)
        useScheduledTasksStore.getState().deleteTask('sched-1')
        let deactivated = false
        const pending = harness.deactivate().then(() => { deactivated = true })
        await vi.advanceTimersByTimeAsync(0)
        expect(deactivated).toBe(false)
        expect(globalScheduledScheduler.isRunning()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        // Unloading stops new writes, but must preserve the already queued deletion.
        useScheduledTasksStore.getState().hydrate(savedTasks as ScheduledTask[])
        finishFirst()
        await pending
        expect(saveMock).toHaveBeenCalledTimes(2)
        expect(saveMock).toHaveBeenNthCalledWith(1, [expect.objectContaining({ enabled: false, status: 'paused' })])
        expect(saveMock).toHaveBeenNthCalledWith(2, [])
        expect(deactivated).toBe(true)
    })

    it('coalesces reloads and rejects a stale response after an update event', async () => {
        vi.useFakeTimers()
        let resolve!: (tasks: ScheduledTaskItem[]) => void
        listMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
        const harness = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        await harness.activate()
        await vi.advanceTimersByTimeAsync(0)
        await harness.events.emit('schedule:updated', {})
        await harness.events.emit('schedule:updated', {})
        expect(listMock).toHaveBeenCalledTimes(1)
        const newer = [{ ...savedTasks[0], title: 'Updated', enabled: false }]
        await harness.events.emit('schedule:updated', { data: newer })
        resolve(savedTasks)
        await vi.advanceTimersByTimeAsync(0)
        expect(useScheduledTasksStore.getState().tasks[0].title).toBe('Updated')
        expect(saveMock).not.toHaveBeenCalled()
        listMock.mockResolvedValue(newer)
        await vi.advanceTimersByTimeAsync(1000)
        expect(listMock).toHaveBeenCalledTimes(2)
        expect(globalScheduledScheduler.isRunning()).toBe(true)
        await harness.deactivate()
    })

    it('ignores a pending load after deactivation and cancels retries', async () => {
        vi.useFakeTimers()
        let resolve!: (tasks: ScheduledTaskItem[]) => void
        listMock.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
        const harness = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        await harness.activate()
        await vi.advanceTimersByTimeAsync(0)
        await harness.deactivate()
        resolve(savedTasks)
        await vi.advanceTimersByTimeAsync(5000)
        expect(useScheduledTasksStore.getState().tasks).toEqual([])
        expect(globalScheduledScheduler.isRunning()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('cancels a scheduled hydration retry on deactivation', async () => {
        vi.useFakeTimers()
        listMock.mockRejectedValue(new Error('RPC still staged'))
        const harness = createPluginTestHarness(schedulerRendererEntry, { manifest, services: mockServices })
        await harness.activate()
        await vi.advanceTimersByTimeAsync(0)
        await harness.deactivate()
        await vi.advanceTimersByTimeAsync(5000)
        expect(listMock).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it('activates, hydrates from ScheduleService, registers view/nav/action, and serializes updates to schedule.json', async () => {
        const harness = createPluginTestHarness(schedulerRendererEntry, {
            manifest,
            services: mockServices,
        })

        await harness.activate()

        // 1. Verify contributions
        expect(harness.registrations.filter((r) => r.kind === 'view')).toHaveLength(1)
        expect(harness.registrations.filter((r) => r.kind === 'navigation')).toHaveLength(1)
        expect(harness.registrations.filter((r) => r.kind === 'action')).toHaveLength(1)

        // 2. Verify deferred hydration (runs after platform commit / next macrotask)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(listMock).toHaveBeenCalled()
        expect(useScheduledTasksStore.getState().tasks).toHaveLength(1)
        expect(useScheduledTasksStore.getState().tasks[0]?.title).toBe('Hydrated Task')

        // 3. Trigger store change and verify serial saving
        useScheduledTasksStore.getState().addTask({
            title: 'New Dynamic Task',
            schedule: 'Weekdays 09:00:00',
            prompt: 'Test prompt',
        })

        // Allow microtasks for serialized saving
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(saveMock).toHaveBeenCalled()
        expect(saveMock).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ title: 'New Dynamic Task' }),
            ]),
        )

        // 4. Deactivate and verify cleanup
        await harness.deactivate()
    })

    it('handles save error and reports notification toast', async () => {
        saveMock.mockRejectedValueOnce(new Error('Persistence failed'))

        const harness = createPluginTestHarness(schedulerRendererEntry, {
            manifest,
            services: mockServices,
        })

        await harness.activate()
        // Wait for deferred hydration before mutating tasks
        await new Promise((resolve) => setTimeout(resolve, 20))

        useScheduledTasksStore.getState().addTask({
            title: 'Fail Task',
            schedule: 'Daily 10:00:00',
            prompt: 'Should fail save',
        })

        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(saveMock).toHaveBeenCalled()
        expect(toastMock).toHaveBeenCalled()

        await harness.deactivate()
    })
})
