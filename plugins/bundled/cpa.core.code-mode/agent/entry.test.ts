import { describe, expect, it, vi } from 'vitest'
import { SettingsServiceToken, type AppSettings, type PluginContext, type ResourceProvider, type ToolFactoryContribution } from '@cpa/plugin-api'
import { entry } from './index'

describe('Code Mode agent tool factories', () => {
    it('reads settings from the plugin service when the tool factory context has none', async () => {
        const snapshot = { toolMode: 'code' } as AppSettings
        const settings = { get: async () => snapshot, getSnapshot: () => snapshot, subscribe: () => () => {} }
        const registered: ToolFactoryContribution[] = []
        const context = {
            generation: 1,
            capabilityClient: { has: () => true, invoke: vi.fn(async () => undefined), subscribe: () => () => {} },
            register(contribution: { value: ToolFactoryContribution }) {
                registered.push(contribution.value)
            },
            getService(token: { id?: string } | string) {
                const id = typeof token === 'string' ? token : token.id
                if (id === SettingsServiceToken.id) return settings
                throw new Error(`Service "${id}" not found`)
            },
        } as unknown as PluginContext

        await entry.activate(context)
        const exec = registered.find((factory) => factory.id === 'exec')
        const tool = await exec?.create({ platform: 'darwin', services: {} as never })
        expect(tool?.name).toBe('exec')
        const resources = registered.filter((item) => 'kind' in item && item.kind === 'system-prompt') as unknown as ResourceProvider[]
        const guidance = await resources[0]?.load({ agentTarget: 'main' })
        expect(guidance).toEqual([expect.objectContaining({ id: 'code-mode-batch-guidance', content: expect.stringContaining('Reserve `code mode` strictly') })])
        await entry.deactivate?.(context)
    })

    it.each(['direct', 'code-only'] as const)('does not add batch guidance in %s mode', async (toolMode) => {
        const snapshot = { toolMode } as AppSettings
        const settings = { get: async () => snapshot, getSnapshot: () => snapshot, subscribe: () => () => {} }
        const registered: Array<ToolFactoryContribution | ResourceProvider> = []
        const context = {
            generation: 2,
            capabilityClient: { has: () => true, invoke: vi.fn(async () => undefined), subscribe: () => () => {} },
            register(contribution: { value: ToolFactoryContribution | ResourceProvider }) {
                registered.push(contribution.value)
            },
            getService() { return settings },
        } as unknown as PluginContext
        await entry.activate(context)
        const provider = registered.find((item) => 'load' in item) as ResourceProvider | undefined
        expect(await provider?.load({ agentTarget: 'all' })).toEqual([])
        await entry.deactivate?.(context)
    })
})
