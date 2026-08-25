import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { schedulerRendererEntry } from './index.js'
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
