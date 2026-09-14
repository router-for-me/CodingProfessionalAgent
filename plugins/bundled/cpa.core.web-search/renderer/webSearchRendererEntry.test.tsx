import { describe, expect, it, vi } from 'vitest'
import type { PluginContext } from '@cpa/plugin-api'
import manifest from '../manifest.json'
import { entry } from './index.js'

describe('Web Search renderer entry', () => {
    it('registers its settings page and attach-menu quick submenu from declared contributions', () => {
        const registrations: Array<{ kind: string; id: string; target?: string; value: any }> = []
        const getService = vi.fn(() => ({ getModels: () => [], getStatus: () => 'ready' }))
        const context = {
            manifest,
            capabilityClient: { invoke: vi.fn(), has: () => true, subscribe: () => () => {} },
            getService,
            register: (registration: typeof registrations[number]) => {
                registrations.push(registration)
                return () => {}
            },
        } as unknown as PluginContext

        entry.activate(context)

        expect(registrations.map(({ kind, id }) => `${kind}/${id}`)).toEqual([
            'settings/web-search',
            'composer/web-search-quick',
        ])
        const quick = registrations[1]
        expect(quick?.target).toBe('attachment')
        expect(quick?.value.submenu).toEqual(expect.any(Function))
        expect(getService).not.toHaveBeenCalled()
        expect(manifest.contributes.composer).toContain('web-search-quick')
    })
})
