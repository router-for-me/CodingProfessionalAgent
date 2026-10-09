import { describe, expect, it, vi } from 'vitest'
import { memoriesAgentEntry, buildMemoryInstructions } from './index.js'
import type {
    PluginContext,
    ResourceProvider,
    ToolFactoryContribution,
    ToolFactoryContext,
} from '@cpa/plugin-api'

function activate() {
    const tools = new Map<string, ToolFactoryContribution>()
    const resources = new Map<string, ResourceProvider>()
    const client = { invoke: vi.fn() }
    const context = {
        capabilityClient: client,
        register: (contribution: { kind: string; id: string; value: unknown }) => {
            if (contribution.kind === 'tool-factory') {
                tools.set(contribution.id, contribution.value as ToolFactoryContribution)
            } else if (contribution.kind === 'resource-provider') {
                resources.set(contribution.id, contribution.value as ResourceProvider)
            }
        },
    } as unknown as PluginContext
    memoriesAgentEntry.activate(context)
    return { tools, resources, client }
}

describe('memoriesAgentEntry', () => {
    it('registers exactly three factories without aliases and with memory risk metadata', () => {
        const { tools } = activate()
        expect([...tools.keys()]).toEqual(['memories_search', 'memories_read', 'memories_add'])
        for (const [id, tool] of tools) {
            expect(tool.id).toBe(id)
            expect(tool.name).toBe(id)
            expect(tool.aliases).toBeUndefined()
            expect(tool.requiresApproval).toBe(false)
            expect(tool.targets).toEqual(['main', 'all'])
            expect(tool.riskLevel).toBe(id === 'memories_add' ? 'write' : 'read')
            expect(tool.approvalCategory).toBe(id === 'memories_add' ? 'memory-write' : 'memory-read')
        }
    })

    it('injects the slim prompt without requiring a filesystem bridge', async () => {
        const { resources } = activate()
        expect([...resources.keys()]).toEqual(['cpa.core.memories'])
        const resource = resources.get('cpa.core.memories')!
        expect(resource.kind).toBe('system-prompt')
        expect(resource.order).toBe(15)
        expect(resource.targetAgent).toBe('main')
        const expected = [{ id: 'memory', content: buildMemoryInstructions(), order: 15 }]
        expect(await resource.load({ agentTarget: 'main', localMemoryEnabled: true })).toEqual(expected)
        expect(await resource.load({ agentTarget: 'main' })).toEqual(expected)
        expect(await resource.load({ agentTarget: 'main', localMemoryEnabled: false })).toEqual([])
    })

    it.each([
        ['memories_search', { queries: ['a'] }, 'memories:search'],
        ['memories_read', { ids: [1] }, 'memories:read'],
        ['memories_add', { title: 'pref', note: 'note' }, 'memories:add'],
    ] as const)('uses the activation client as fallback for %s', async (name, args, method) => {
        const { tools, client } = activate()
        client.invoke.mockResolvedValue({ success: true })
        const tool = (await tools.get(name)!.create({} as ToolFactoryContext))!
        await tool.execute('call', args, {} as Parameters<typeof tool.execute>[2])
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith(method, [args])
    })

    it('prefers the factory context capability client over the activation client', async () => {
        const { tools, client } = activate()
        const scopedClient = { invoke: vi.fn().mockResolvedValue({ memories: [], missingIds: [1] }) }
        const tool = (await tools.get('memories_read')!.create({ capabilityClient: scopedClient } as unknown as ToolFactoryContext))!
        await tool.execute('call', { ids: [1] }, {} as Parameters<typeof tool.execute>[2])
        expect(scopedClient.invoke).toHaveBeenCalledExactlyOnceWith('memories:read', [{ ids: [1] }])
        expect(client.invoke).not.toHaveBeenCalled()
    })
})
