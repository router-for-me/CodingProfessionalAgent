import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, ToolFactoryContribution } from '@cpa/plugin-api'
import {
    MANAGE_TODO_LIST_DESCRIPTION,
    MANAGE_TODO_LIST_PARAMETERS,
    MANAGE_TODO_LIST_TOOL_NAME,
    createManageTodoListTool,
    formatTodoListOutput,
} from './todoTool.js'
import { useTodoListStore } from '../shared/todoStore.js'

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
                create: () => createManageTodoListTool(),
            },
        })
    },
    deactivate() {
        useTodoListStore.getState().clearAll()
    },
})

export const entry = manageTodoListAgentEntry
export default manageTodoListAgentEntry
