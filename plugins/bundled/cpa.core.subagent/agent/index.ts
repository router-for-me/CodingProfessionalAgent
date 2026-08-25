import { definePluginEntry } from '@cpa/plugin-sdk'
import {
    AgentRuntimeServiceToken,
    SubAgentServiceToken,
    type PluginContext,
    type ToolFactoryContribution,
} from '@cpa/plugin-api'
import {
    createSendMessageTool,
    createSpawnAgentTool,
    createStopAgentTool,
    createSubAgentTools,
} from './tools.js'

export {
    createSpawnAgentTool,
    createSendMessageTool,
    createStopAgentTool,
    createSubAgentTools,
}

export const subagentAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'spawn_agent',
            value: {
                id: 'spawn_agent',
                name: 'spawn_agent',
                label: 'Spawn Subagent',
                description: 'Spawn an autonomous subagent with a dedicated task and role.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Name of the subagent' },
                        task: { type: 'string', description: 'Task for the subagent to perform' },
                    },
                    required: ['task'],
                },
                order: 60,
                targets: ['main'],
                riskLevel: 'process',
                requiresApproval: false,
                approvalCategory: 'subagent-lifecycle',
                create: (ctx: any) => {
                    const host =
                        ctx?.subAgents ??
                        ctx?.services?.subAgents ??
                        context.getService(AgentRuntimeServiceToken) ??
                        context.getService(SubAgentServiceToken)
                    return createSpawnAgentTool(host, ctx?.models ?? [])
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'send_message',
            value: {
                id: 'send_message',
                name: 'send_message',
                label: 'Send Message to Subagent',
                description: 'Send a message or instruction to an active subagent.',
                parameters: {
                    type: 'object',
                    properties: {
                        target: { type: 'string', description: 'Target subagent ID or name' },
                        message: { type: 'string', description: 'Message content' },
                    },
                    required: ['target', 'message'],
                },
                order: 61,
                targets: ['main'],
                riskLevel: 'process',
                requiresApproval: false,
                approvalCategory: 'subagent-communication',
                aliases: ['send_input'],
                create: (ctx: any) => {
                    const host =
                        ctx?.subAgents ??
                        ctx?.services?.subAgents ??
                        context.getService(AgentRuntimeServiceToken) ??
                        context.getService(SubAgentServiceToken)
                    return createSendMessageTool(host)
                },
            },
        })

        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: 'stop_agent',
            value: {
                id: 'stop_agent',
                name: 'stop_agent',
                label: 'Stop Subagent',
                description: 'Stop a running subagent.',
                parameters: {
                    type: 'object',
                    properties: {
                        target: { type: 'string', description: 'Target subagent ID or name to stop' },
                    },
                    required: ['target'],
                },
                order: 62,
                targets: ['main'],
                riskLevel: 'process',
                requiresApproval: false,
                approvalCategory: 'subagent-lifecycle',
                create: (ctx: any) => {
                    const host =
                        ctx?.subAgents ??
                        ctx?.services?.subAgents ??
                        context.getService(AgentRuntimeServiceToken) ??
                        context.getService(SubAgentServiceToken)
                    return createStopAgentTool(host)
                },
            },
        })
    },
})

export const entry = subagentAgentEntry
export default subagentAgentEntry
