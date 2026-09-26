import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTaskItem } from '@cpa/plugin-api'
import { SchedulerCoordinationService } from './schedulerCoordinationService.js'
import { STALLED_RUN_CLAIM } from '../shared/runClaim.js'

const task: ScheduledTaskItem = {
    id: 'task-1',
    title: 'Morning task',
    schedule: 'Daily 06:00:00',
    prompt: 'Run the morning task',
    enabled: true,
    createdAt: 1000,
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('SchedulerCoordinationService run claims', () => {
    it('allows only one renderer to dispatch a period and preserves completion across stale saves', async () => {
        const saveTasks = vi.fn().mockResolvedValue(undefined)
        const service = new SchedulerCoordinationService(vi.fn(), {
            loadTasks: async () => [task],
            saveTasks,
        })
        const [first, second] = await Promise.all([
            service.claimRun(task.id, task.schedule, 6000),
            service.claimRun(task.id, task.schedule, 6000),
        ])
        expect(first).toEqual(expect.any(String))
        expect(second).toBeNull()

        await service.settleRun(task.id, 6000, first!, 7000)
        expect((await service.list())[0]?.lastRunAt).toBe(7000)
        expect(await service.claimRun(task.id, task.schedule, 6000)).toBeNull()

        await service.save([{ ...task, lastAttemptAt: 6500 }])
        expect((await service.list())[0]?.lastRunAt).toBe(7000)
        expect(saveTasks.mock.lastCall?.[0][0].lastRunAt).toBe(7000)
    })

    it('does not expire an in-flight claim while its renderer may still send', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        const service = new SchedulerCoordinationService(vi.fn(), {
            loadTasks: async () => [task],
            saveTasks: async () => {},
        })
        expect(await service.claimRun(task.id, task.schedule, 6000)).toEqual(expect.any(String))
        clock.mockReturnValue(301_000)
        await expect(service.claimRun(task.id, task.schedule, 6000)).rejects.toThrow(STALLED_RUN_CLAIM)
        expect(await service.recoverRun(task.id)).toBe(true)
        expect(await service.claimRun(task.id, task.schedule, 6000)).toEqual(expect.any(String))
    })

    it('does not restore a concurrently deleted task when its claim settles', async () => {
        const service = new SchedulerCoordinationService(vi.fn(), {
            loadTasks: async () => [task],
            saveTasks: async () => {},
        })
        const claim = await service.claimRun(task.id, task.schedule, 6000)
        await Promise.all([
            service.save([]),
            service.settleRun(task.id, 6000, claim!, 7000),
        ])
        expect(await service.list()).toEqual([])
    })

    it('releases a failed claim after the retry cooldown', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
        const service = new SchedulerCoordinationService(vi.fn(), {
            loadTasks: async () => [task],
            saveTasks: async () => {},
        })
        const claim = await service.claimRun(task.id, task.schedule, 6000)
        expect(claim).toEqual(expect.any(String))
        await service.settleRun(task.id, 6000, claim!, null)
        clock.mockReturnValue(60_999)
        expect(await service.claimRun(task.id, task.schedule, 6000)).toBeNull()
        clock.mockReturnValue(61_000)
        expect(await service.claimRun(task.id, task.schedule, 6000)).toEqual(expect.any(String))
    })

    it('serializes saves and never broadcasts an older snapshot over newer local progress', async () => {
        let resolveFirst!: () => void
        const firstSave = new Promise<void>((resolve) => { resolveFirst = resolve })
        const saveTasks = vi.fn()
            .mockImplementationOnce(() => firstSave)
            .mockResolvedValue(undefined)
        const emitEvent = vi.fn()
        const service = new SchedulerCoordinationService(emitEvent, {
            loadTasks: async () => [task],
            saveTasks,
        })
        await service.list()
        const pending = service.save([{ ...task, lastAttemptAt: 6000 }])
        const completed = service.save([{ ...task, lastRunAt: 7000, lastAttemptAt: 7000 }])
        await Promise.resolve()
        await Promise.resolve()
        expect(saveTasks).toHaveBeenCalledTimes(1)

        resolveFirst()
        await Promise.all([pending, completed])
        expect(saveTasks).toHaveBeenCalledTimes(2)
        expect(saveTasks.mock.lastCall?.[0][0].lastRunAt).toBe(7000)
        for (const [event] of emitEvent.mock.calls) {
            expect(JSON.parse(event.data)[0].lastRunAt).toBe(7000)
        }
    })
})
