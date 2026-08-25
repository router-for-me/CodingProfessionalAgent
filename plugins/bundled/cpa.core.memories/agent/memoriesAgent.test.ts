import { describe, expect, it } from 'vitest'
import { memoriesAgentEntry } from './index.js'
import type {
    PluginContext,
    ResourceProvider,
    ToolFactoryContribution,
} from '@cpa/plugin-api'

describe('memoriesAgentEntry', () => {
    it('registers all 4 tool factories and 1 resource provider', async () => {
        const tools = new Map<string, ToolFactoryContribution>()
        const resources = new Map<string, ResourceProvider>()

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.memories',
                name: 'Memories',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'Memories plugin',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'agent',
            register: (contribution: any) => {
                if (contribution.kind === 'tool-factory') {
                    tools.set(contribution.id, contribution.value)
                } else if (contribution.kind === 'resource-provider') {
                    resources.set(contribution.id, contribution.value)
                }
            },
            getService: () => undefined,
        } as unknown as PluginContext

        memoriesAgentEntry.activate(mockContext)

        expect(tools.has('memories_list')).toBe(true)
        expect(tools.has('memories_read')).toBe(true)
        expect(tools.has('memories_search')).toBe(true)
        expect(tools.has('memories_add_ad_hoc_note')).toBe(true)

        const searchTool = tools.get('memories_search')!
        expect(searchTool.aliases).toEqual(['memory_search'])
        expect(searchTool.riskLevel).toBe('read')

        const addNoteTool = tools.get('memories_add_ad_hoc_note')!
        expect(addNoteTool.aliases).toEqual(['memory_store'])
        expect(addNoteTool.riskLevel).toBe('write')
        expect(addNoteTool.approvalCategory).toBe('memory-write')

        expect(resources.has('cpa.core.memories')).toBe(true)
        const memoryResource = resources.get('cpa.core.memories')!
        expect(memoryResource.kind).toBe('system-prompt')
        expect(memoryResource.order).toBe(15)
        expect(memoryResource.targetAgent).toBe('main')
    })
})
