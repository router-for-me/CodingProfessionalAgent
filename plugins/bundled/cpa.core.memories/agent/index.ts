import { adaptPluginToolToAgentTool, definePluginEntry } from '@cpa/plugin-sdk'
import type {
    PluginCapabilityClient,
    PluginContext,
    ResourceProvider,
    ResourceProviderInput,
    ToolFactoryContribution,
    ToolFactoryContext,
} from '@cpa/plugin-api'
import { buildMemoryInstructions, loadMemoryContext } from './memoryContext.js'
import { createMemoryTools, MEMORIES_ADD_TOOL_NAME } from './memoryTools.js'

export { createMemoryTools, buildMemoryInstructions, loadMemoryContext }
export * from '../shared/types.js'

export const memoriesAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const labels = ['Search Memories', 'Read Memory', 'Add Memory Note']
        for (const [index, tool] of createMemoryTools().entries()) {
            const isWrite = tool.name === MEMORIES_ADD_TOOL_NAME
            context.register<ToolFactoryContribution>({
                kind: 'tool-factory',
                id: tool.name,
                value: {
                    id: tool.name,
                    name: tool.name,
                    label: labels[index],
                    description: tool.description,
                    parameters: tool.parameters,
                    order: 150 + index,
                    targets: ['main', 'all'],
                    riskLevel: isWrite ? 'write' : 'read',
                    requiresApproval: false,
                    approvalCategory: isWrite ? 'memory-write' : 'memory-read',
                    create: async (ctx: ToolFactoryContext) => {
                        const client = (ctx?.capabilityClient as PluginCapabilityClient | undefined) ?? context.capabilityClient
                        const memoryTool = createMemoryTools({ client })[index]
                        return adaptPluginToolToAgentTool(memoryTool)
                    },
                },
            })
        }

        context.register<ResourceProvider>({
            kind: 'resource-provider',
            id: 'cpa.core.memories',
            value: {
                id: 'cpa.core.memories',
                kind: 'system-prompt',
                order: 15,
                targetAgent: 'main',
                load: (input: ResourceProviderInput) => {
                    const memoryContext = loadMemoryContext({ localMemoryEnabled: input.localMemoryEnabled })
                    return memoryContext === null ? [] : [{ id: 'memory', content: memoryContext, order: 15 }]
                },
            },
        })
    },
})

export const entry = memoriesAgentEntry
export default memoriesAgentEntry
