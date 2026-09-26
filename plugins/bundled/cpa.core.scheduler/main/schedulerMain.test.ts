import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { schedulerMainEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.scheduler main entry', () => {
    it('registers schedule CRUD, trigger, and run-claim RPC endpoints', async () => {
        const harness = createPluginTestHarness(schedulerMainEntry, {
            manifest,
        })

        await harness.activate()

        const services = harness.registrations.filter((r) => r.kind === 'service')
        expect(services.some((s) => s.id === 'schedulerCoordinationService')).toBe(true)

        const rpcs = harness.registrations.filter((r) => r.kind === 'rpc')
        expect(rpcs.some((r) => r.id === 'schedule:list')).toBe(true)
        expect(rpcs.some((r) => r.id === 'schedule:save')).toBe(true)
        expect(rpcs.some((r) => r.id === 'schedule:trigger')).toBe(true)
        expect(rpcs.some((r) => r.id === 'schedule:claimRun')).toBe(true)
        expect(rpcs.some((r) => r.id === 'schedule:settleRun')).toBe(true)
        expect(rpcs.some((r) => r.id === 'schedule:recoverRun')).toBe(true)

        // Test RPC invocations
        const listRpc = rpcs.find((r) => r.id === 'schedule:list')?.value as any
        const saveRpc = rpcs.find((r) => r.id === 'schedule:save')?.value as any
        const triggerRpc = rpcs.find((r) => r.id === 'schedule:trigger')?.value as any
        const claimRpc = rpcs.find((r) => r.id === 'schedule:claimRun')?.value as any
        const settleRpc = rpcs.find((r) => r.id === 'schedule:settleRun')?.value as any
        const recoverRpc = rpcs.find((r) => r.id === 'schedule:recoverRun')?.value as any

        expect(listRpc).toBeDefined()
        const initialList = await listRpc.invoke({}, [])
        expect(Array.isArray(initialList)).toBe(true)

        const sampleTask = {
            id: 'task-main-1',
            title: 'Main Scheduled Task',
            schedule: 'Daily 08:00:00',
            prompt: 'Test prompt from main',
            enabled: true,
            createdAt: Date.now(),
        }

        const emitMock = vi.fn()
        await saveRpc.invoke({ emitEvent: emitMock }, [[sampleTask]])

        const updatedList = await listRpc.invoke({}, [])
        expect(updatedList).toHaveLength(1)
        expect(updatedList[0].title).toBe('Main Scheduled Task')

        await triggerRpc.invoke({ emitEvent: emitMock }, ['task-main-1'])
        expect(emitMock).toHaveBeenCalled()

        const claim = await claimRpc.invoke({}, ['task-main-1', 'Daily 08:00:00', 1000])
        expect(claim).toEqual(expect.any(String))
        expect(await claimRpc.invoke({}, ['task-main-1', 'Daily 08:00:00', 1000])).toBeNull()
        await settleRpc.invoke({}, ['task-main-1', 1000, claim, 2000])
        expect((await listRpc.invoke({}, []))[0].lastRunAt).toBe(2000)
        expect(await recoverRpc.invoke({}, ['task-main-1'])).toBe(false)

        await harness.deactivate()
    })
})
