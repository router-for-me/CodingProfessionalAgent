import { describe, expect, it } from 'vitest'
import { definePluginEntry } from './definePluginEntry.js'

describe('definePluginEntry', () => {
    it('defines an entry without embedding a manifest', () => {
        const entry = definePluginEntry({
            runtime: 'renderer',
            activate: () => undefined,
        })
        expect(entry.runtime).toBe('renderer')
        expect('manifest' in entry).toBe(false)
    })

    it('accepts valid entries for all supported runtimes', () => {
        const runtimes = ['main', 'renderer', 'agent'] as const
        for (const runtime of runtimes) {
            const activate = () => undefined
            const deactivate = () => undefined
            const entry = definePluginEntry({ runtime, activate, deactivate })
            expect(entry.runtime).toBe(runtime)
            expect(entry.activate).toBe(activate)
            expect(entry.deactivate).toBe(deactivate)
        }
    })

    it('rejects invalid or non-object definitions', () => {
        // @ts-expect-error invalid input
        expect(() => definePluginEntry(null)).toThrow('Plugin entry definition must be an object')
        // @ts-expect-error invalid input
        expect(() => definePluginEntry(undefined)).toThrow('Plugin entry definition must be an object')
    })

    it('rejects invalid runtime kind', () => {
        expect(() =>
            definePluginEntry({
                // @ts-expect-error invalid runtime
                runtime: 'worker',
                activate: () => undefined,
            }),
        ).toThrow('Invalid plugin entry runtime: "worker"')
    })

    it('rejects missing or non-function activate', () => {
        expect(() =>
            definePluginEntry({
                runtime: 'main',
                // @ts-expect-error missing activate
                activate: undefined,
            }),
        ).toThrow('Plugin entry definition must provide an activate function')
    })

    it('rejects non-function deactivate when provided', () => {
        expect(() =>
            definePluginEntry({
                runtime: 'main',
                activate: () => undefined,
                // @ts-expect-error invalid deactivate
                deactivate: 'not a function',
            }),
        ).toThrow('Plugin entry deactivate must be a function if provided')
    })
})
