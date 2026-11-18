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
        expect(guidance).toEqual([expect.objectContaining({ id: 'code-mode-batch-guidance', content: expect.stringContaining('Prefer `exec` whenever you need 2 or more eligible tool calls') })])
        await entry.deactivate?.(context)
    })

    it('emits code-only batch guidance when toolMode is code-only and stays silent in direct or without exec', async () => {
        const codeOnlySnapshot = { toolMode: 'code-only' } as AppSettings
        const codeOnlySettings = { get: async () => codeOnlySnapshot, getSnapshot: () => codeOnlySnapshot, subscribe: () => () => {} }
        const registeredCodeOnly: Array<ToolFactoryContribution | ResourceProvider> = []
        const contextCodeOnly = {
            generation: 2,
            capabilityClient: { has: () => true, invoke: vi.fn(async () => undefined), subscribe: () => () => {} },
            register(contribution: { value: ToolFactoryContribution | ResourceProvider }) {
                registeredCodeOnly.push(contribution.value)
            },
            getService() { return codeOnlySettings },
        } as unknown as PluginContext
        await entry.activate(contextCodeOnly)
        const providerCodeOnly = registeredCodeOnly.find((item) => 'load' in item) as ResourceProvider | undefined
        expect(await providerCodeOnly?.load({ agentTarget: 'all' })).toEqual([
            expect.objectContaining({
                id: 'code-mode-batch-guidance',
                content: expect.stringContaining('await tools.<name>(input)'),
            }),
        ])
        expect(await providerCodeOnly?.load({ agentTarget: 'main', tools: [{ name: 'read', description: 'Read' }] })).toEqual([])
        await entry.deactivate?.(contextCodeOnly)

        const directSnapshot = { toolMode: 'direct' } as AppSettings
        const directSettings = { get: async () => directSnapshot, getSnapshot: () => directSnapshot, subscribe: () => () => {} }
        const registeredDirect: Array<ToolFactoryContribution | ResourceProvider> = []
        const contextDirect = {
            generation: 3,
            capabilityClient: { has: () => true, invoke: vi.fn(async () => undefined), subscribe: () => () => {} },
            register(contribution: { value: ToolFactoryContribution | ResourceProvider }) {
                registeredDirect.push(contribution.value)
            },
            getService() { return directSettings },
        } as unknown as PluginContext
        await entry.activate(contextDirect)
        const providerDirect = registeredDirect.find((item) => 'load' in item) as ResourceProvider | undefined
        expect(await providerDirect?.load({ agentTarget: 'all' })).toEqual([])
        await entry.deactivate?.(contextDirect)
    })
})
