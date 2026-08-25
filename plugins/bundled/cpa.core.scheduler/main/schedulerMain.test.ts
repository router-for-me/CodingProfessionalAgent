import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { schedulerMainEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.scheduler main entry', () => {
    it('activates, registers coordination service and RPC endpoints for schedule:list, schedule:save, schedule:trigger', async () => {
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

        // Test RPC invocations
        const listRpc = rpcs.find((r) => r.id === 'schedule:list')?.value as any
        const saveRpc = rpcs.find((r) => r.id === 'schedule:save')?.value as any
        const triggerRpc = rpcs.find((r) => r.id === 'schedule:trigger')?.value as any

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

        await harness.deactivate()
    })
})
