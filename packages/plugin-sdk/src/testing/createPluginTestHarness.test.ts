import type { PluginEntryDefinition } from '@cpa/plugin-api'
import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from './createPluginTestHarness.js'
import { definePluginEntry } from '../definePluginEntry.js'

describe('createPluginTestHarness', () => {
    it('activates plugin entry and records contribution registrations', async () => {
        let activated = false
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate(context) {
                activated = true
                context.register({
                    kind: 'action',
                    id: 'do-something',
                    value: { title: 'Do Something' },
                })
            },
        })

        const harness = createPluginTestHarness(entry)
        await harness.activate()

        expect(activated).toBe(true)
        expect(harness.registrations).toHaveLength(1)
        expect(harness.getRegistered('action', 'do-something')).toHaveLength(1)
        expect(harness.getRegistered('action', 'do-something')[0].value).toEqual({ title: 'Do Something' })
    })

    it('supports unregistering contributions via the returned disposer', async () => {
        let disposeFn: (() => void) | undefined
        const entry = definePluginEntry({
            runtime: 'main',
            activate(context) {
                disposeFn = context.register({
                    kind: 'service',
                    id: 'sample-service',
                    value: { ok: true },
                })
            },
        })

        const harness = createPluginTestHarness(entry)
        await harness.activate()
        expect(harness.getRegistered('service')).toHaveLength(1)

        disposeFn?.()
        expect(harness.getRegistered('service')).toHaveLength(0)
    })

    it('provides services and throws when missing', async () => {
        const dummyService = { count: 42 }
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate(context) {
                const s = context.getService<{ count: number }>('my-service')
                expect(s.count).toBe(42)
            },
        })

        const harness = createPluginTestHarness(entry, {
            services: {
                'my-service': dummyService,
            },
        })
        await harness.activate()

        expect(() => harness.getService('missing-service')).toThrow('not found')
    })

    it('emits and listens to events via PluginEventBus', async () => {
        const listener = vi.fn()
        const entry = definePluginEntry({
            runtime: 'agent',
            activate(context) {
                context.events.on('custom-event', listener)
            },
        })

        const harness = createPluginTestHarness(entry)
        await harness.activate()

        await harness.events.emit('custom-event', { message: 'hello' })
        expect(listener).toHaveBeenCalledWith({ message: 'hello' })
    })

    it('calls deactivate lifecycle if provided', async () => {
        let deactivated = false
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate() {},
            deactivate() {
                deactivated = true
            },
        })

        const harness = createPluginTestHarness(entry)
        await harness.activate()
        await harness.deactivate()

        expect(deactivated).toBe(true)
    })
})
