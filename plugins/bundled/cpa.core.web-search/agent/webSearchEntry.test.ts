import { describe, expect, it, vi } from 'vitest'
import type { PluginContext, ToolFactoryContribution, ToolFactoryContext } from '@cpa/plugin-api'
import { entry } from './index.js'
import manifest from '../manifest.json'
import { SETTINGS_KEY } from '../shared/types.js'

function activate(enabled: boolean) {
    let factory!: ToolFactoryContribution
    const invoke = vi.fn().mockResolvedValue({ enabled, modelId: 'search-B' })
    const context = {
        manifest, generation: 1, capabilities: new Set(['storage.kv']),
        capabilityClient: { invoke, has: () => true, subscribe: () => () => {} },
        register: (registration: { kind: string; id: string; value: ToolFactoryContribution }) => {
            expect(manifest.contributes['tool-factory']).toContain(registration.id)
            expect(registration.kind).toBe('tool-factory')
            factory = registration.value
            return () => {}
        },
        getService: () => ({ getModels: () => [], getStatus: () => 'ready' }),
    } as unknown as PluginContext
    entry.activate(context)
    return { factory, invoke }
}

describe('Web Search plugin entry', () => {
    it('registers one ordinary network tool using declared contributions and storage capability', async () => {
        const { factory, invoke } = activate(true)
        expect(factory).toMatchObject({ id: 'web_search', riskLevel: 'network', requiresApproval: true, approvalCategory: 'network' })
        const tool = await factory.create({} as ToolFactoryContext)
        expect(tool?.name).toBe('web_search')
        expect(invoke).toHaveBeenCalledWith('kvstore:get', [SETTINGS_KEY])
        expect(manifest.capabilities).toContain('storage.kv')
    })
    it('does not expose the tool when disabled', async () => {
        const { factory } = activate(false)
        expect(await factory.create({} as ToolFactoryContext)).toBeNull()
    })
})
