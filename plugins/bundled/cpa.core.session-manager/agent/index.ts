import { adaptPluginToolToAgentTool, definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, ToolFactoryContribution } from '@cpa/plugin-api'
import {
    createSetSessionTitleTool,
    SET_SESSION_TITLE_TOOL_NAME,
} from './sessionTitle.js'
import {
    createSessionSearchTool,
    createSessionCreateTool,
    resolveSessionScheduleId,
    SESSION_SEARCH_TOOL_NAME,
    SESSION_CREATE_TOOL_NAME,
    CREATE_SESSION_TOOL_NAME,
} from './sessionTools.js'

export {
    SET_SESSION_TITLE_TOOL_NAME,
    SESSION_SEARCH_TOOL_NAME,
    SESSION_CREATE_TOOL_NAME,
    CREATE_SESSION_TOOL_NAME,
    createSetSessionTitleTool,
    createSessionSearchTool,
    createSessionCreateTool,
    resolveSessionScheduleId,
}

export const sessionManagerAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: SET_SESSION_TITLE_TOOL_NAME,
            value: {
                id: SET_SESSION_TITLE_TOOL_NAME,
                name: SET_SESSION_TITLE_TOOL_NAME,
                label: 'Title',
                description: 'Set the session title. Call on first turn before other actions.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Session title (2-6 words).' },
                    },
                    required: ['title'],
                },
                order: 100,
                targets: ['main', 'all'],
                riskLevel: 'session',
                requiresApproval: false,
                approvalCategory: 'session-metadata',
                create: (ctx: any) =>
                    createSetSessionTitleTool({
                        onRename: ctx?.onRename,
                        services: ctx?.services,
                        capabilityClient: context.capabilityClient,
                    }),
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: SESSION_SEARCH_TOOL_NAME,
            value: {
                id: SESSION_SEARCH_TOOL_NAME,
                name: SESSION_SEARCH_TOOL_NAME,
                label: 'Search Sessions',
                description: 'Search historical conversation sessions by keyword or title.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Search keyword' },
                    },
                    required: ['query'],
                },
                order: 110,
                targets: ['main', 'all'],
                requiresScheduledSession: true,
                riskLevel: 'session',
                requiresApproval: false,
                approvalCategory: 'session-query',
                create: (ctx: any) => {
                    const sid = resolveSessionScheduleId(ctx, {
                        services: ctx?.services,
                        capabilityClient: context.capabilityClient,
                    })
                    if (!sid) {
                        return undefined
                    }
                    return adaptPluginToolToAgentTool(
                        createSessionSearchTool({
                            services: ctx?.services,
                            capabilityClient: context.capabilityClient,
                        }),
                    )
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: SESSION_CREATE_TOOL_NAME,
            value: {
                id: SESSION_CREATE_TOOL_NAME,
                name: SESSION_CREATE_TOOL_NAME,
                label: 'Create Session',
                description: 'Create a new conversation session.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Optional initial title' },
                    },
                },
                order: 111,
                targets: ['main', 'all'],
                requiresScheduledSession: true,
                riskLevel: 'session',
                requiresApproval: false,
                approvalCategory: 'session-lifecycle',
                create: (ctx: any) => {
                    const sid = resolveSessionScheduleId(ctx, {
                        services: ctx?.services,
                        capabilityClient: context.capabilityClient,
                    })
                    if (!sid) {
                        return undefined
                    }
                    return adaptPluginToolToAgentTool(
                        createSessionCreateTool({
                            services: ctx?.services,
                            capabilityClient: context.capabilityClient,
                        }),
                    )
                },
            },
        })
    },
})

export const entry = sessionManagerAgentEntry
export default sessionManagerAgentEntry
