import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, ToolFactoryContribution } from '@cpa/plugin-api'
import {
    MANAGE_TODO_LIST_DESCRIPTION,
    MANAGE_TODO_LIST_PARAMETERS,
    MANAGE_TODO_LIST_TOOL_NAME,
    createManageTodoListTool,
    formatTodoListOutput,
} from './todoTool.js'
import { resetTodoOrchestration } from '../shared/todoOrchestration.js'

export {
    MANAGE_TODO_LIST_DESCRIPTION,
    MANAGE_TODO_LIST_PARAMETERS,
    MANAGE_TODO_LIST_TOOL_NAME,
    createManageTodoListTool,
    formatTodoListOutput,
}

export const MANAGE_TODO_LIST_NAME = MANAGE_TODO_LIST_TOOL_NAME

export const manageTodoListAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const { capabilityClient } = context
        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: MANAGE_TODO_LIST_TOOL_NAME,
            value: {
                id: MANAGE_TODO_LIST_TOOL_NAME,
                name: MANAGE_TODO_LIST_TOOL_NAME,
                label: MANAGE_TODO_LIST_TOOL_NAME,
                description: MANAGE_TODO_LIST_DESCRIPTION,
                parameters: MANAGE_TODO_LIST_PARAMETERS,
                order: 120,
                targets: ['main'],
                riskLevel: 'session',
                requiresApproval: false,
                approvalCategory: 'task-management',
                create: () => createManageTodoListTool({
                    loadSessionEntries: async (sessionId) => {
                        if (!capabilityClient) {
                            throw new Error(`Session history capability is unavailable; cannot safely load existing todos for session "${sessionId}". Please retry.`)
                        }
                        const session = await capabilityClient.invoke('session:get', [sessionId])
                        if (session === null || session === undefined) return []
                        const entries = typeof session === 'object' && (session as Record<string, unknown>).entries
                        if (!Array.isArray(entries)) throw new Error(`Invalid session payload returned for session "${sessionId}".`)
                        return entries as readonly Record<string, unknown>[]
                    },
                }),
            },
        })
    },
    deactivate() {
        resetTodoOrchestration()
    },
})

export const entry = manageTodoListAgentEntry
export default manageTodoListAgentEntry
