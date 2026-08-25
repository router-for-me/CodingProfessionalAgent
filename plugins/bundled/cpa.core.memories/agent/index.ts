import {
    adaptPluginToolToAgentTool,
    createCapabilityNativeAdapter,
    definePluginEntry,
} from '@cpa/plugin-sdk'
import type {
    PluginContext,
    ResourceProvider,
    ResourceProviderInput,
    ToolFactoryContribution,
    ToolFactoryContext,
} from '@cpa/plugin-api'
import * as localMemoriesBackend from './localMemoriesBackend.js'
import {
    buildMemoryReadPathInstructions,
    loadMemoryReadPathContext,
} from './memoryContext.js'
import {
    createMemoryTools,
    MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION,
    MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS,
    MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
    MEMORIES_LIST_DESCRIPTION,
    MEMORIES_LIST_PARAMETERS,
    MEMORIES_LIST_TOOL_NAME,
    MEMORIES_READ_DESCRIPTION,
    MEMORIES_READ_PARAMETERS,
    MEMORIES_READ_TOOL_NAME,
    MEMORIES_SEARCH_DESCRIPTION,
    MEMORIES_SEARCH_PARAMETERS,
    MEMORIES_SEARCH_TOOL_NAME,
} from './memoryTools.js'

export {
    localMemoriesBackend,
    createMemoryTools,
    buildMemoryReadPathInstructions,
    loadMemoryReadPathContext,
}

export * from './types.js'

export const memoriesAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const client =
            context.capabilityClient ??
            ((context as any).capabilities?.invoke ? (context as any).capabilities : undefined)
        const scopedBridge = client ? createCapabilityNativeAdapter(client) : undefined

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: MEMORIES_LIST_TOOL_NAME,
            value: {
                id: MEMORIES_LIST_TOOL_NAME,
                name: MEMORIES_LIST_TOOL_NAME,
                label: 'List Memories',
                description: MEMORIES_LIST_DESCRIPTION,
                parameters: MEMORIES_LIST_PARAMETERS,
                order: 150,
                targets: ['main', 'all'],
                riskLevel: 'read',
                requiresApproval: false,
                approvalCategory: 'memory-read',
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx?.bridge as any) ?? scopedBridge
                    const memoryTools = createMemoryTools({ bridge })
                    const tool = memoryTools.find((t) => t.name === MEMORIES_LIST_TOOL_NAME)!
                    return adaptPluginToolToAgentTool(tool)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: MEMORIES_READ_TOOL_NAME,
            value: {
                id: MEMORIES_READ_TOOL_NAME,
                name: MEMORIES_READ_TOOL_NAME,
                label: 'Read Memory',
                description: MEMORIES_READ_DESCRIPTION,
                parameters: MEMORIES_READ_PARAMETERS,
                order: 151,
                targets: ['main', 'all'],
                riskLevel: 'read',
                requiresApproval: false,
                approvalCategory: 'memory-read',
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx?.bridge as any) ?? scopedBridge
                    const memoryTools = createMemoryTools({ bridge })
                    const tool = memoryTools.find((t) => t.name === MEMORIES_READ_TOOL_NAME)!
                    return adaptPluginToolToAgentTool(tool)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: MEMORIES_SEARCH_TOOL_NAME,
            value: {
                id: MEMORIES_SEARCH_TOOL_NAME,
                name: MEMORIES_SEARCH_TOOL_NAME,
                label: 'Search Memories',
                description: MEMORIES_SEARCH_DESCRIPTION,
                parameters: MEMORIES_SEARCH_PARAMETERS,
                order: 152,
                targets: ['main', 'all'],
                riskLevel: 'read',
                requiresApproval: false,
                approvalCategory: 'memory-read',
                aliases: ['memory_search'],
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx?.bridge as any) ?? scopedBridge
                    const memoryTools = createMemoryTools({ bridge })
                    const tool = memoryTools.find((t) => t.name === MEMORIES_SEARCH_TOOL_NAME)!
                    return adaptPluginToolToAgentTool(tool)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
            value: {
                id: MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
                name: MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
                label: 'Add Memory Note',
                description: MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION,
                parameters: MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS,
                order: 153,
                targets: ['main', 'all'],
                riskLevel: 'write',
                requiresApproval: false,
                approvalCategory: 'memory-write',
                aliases: ['memory_store'],
                create: async (ctx: ToolFactoryContext) => {
                    const bridge = (ctx?.bridge as any) ?? scopedBridge
                    const memoryTools = createMemoryTools({ bridge })
                    const tool = memoryTools.find((t) => t.name === MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME)!
                    return adaptPluginToolToAgentTool(tool)
                },
            },
        })

        context.register<ResourceProvider>({
            kind: 'resource-provider',
            id: 'cpa.core.memories',
            value: {
                id: 'cpa.core.memories',
                kind: 'system-prompt',
                order: 15,
                targetAgent: 'main',
                load: async (input: ResourceProviderInput) => {
                    const bridge = (input.bridge as any) ?? scopedBridge
                    const memoryContext = await loadMemoryReadPathContext({
                        homeDir: input.homeDir,
                        bridge,
                        localMemoryEnabled: input.localMemoryEnabled !== false,
                    })
                    if (!memoryContext) return []
                    return [
                        {
                            id: 'memory',
                            content: memoryContext,
                            order: 15,
                        },
                    ]
                },
            },
        })
    },
})

export const entry = memoriesAgentEntry
export default memoriesAgentEntry
