import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, ToolFactoryContribution } from '@cpa/plugin-api'
import {
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_NAME,
    ASK_TOOL_PARAMETERS,
    createAskTool,
    parseAskOptions,
} from './askTool.js'
import { defaultAskController, useAskStore } from '../shared/askStore.js'

export {
    ASK_TOOL_NAME,
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_PARAMETERS,
    createAskTool,
    parseAskOptions,
}

export const askAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        context.register<ToolFactoryContribution>({
            kind: 'tool-factory',
            id: ASK_TOOL_NAME,
            value: {
                id: ASK_TOOL_NAME,
                name: ASK_TOOL_NAME,
                label: ASK_TOOL_NAME,
                description: ASK_TOOL_DESCRIPTION,
                parameters: ASK_TOOL_PARAMETERS,
                order: 130,
                targets: ['main'],
                riskLevel: 'read',
                requiresApproval: false,
                approvalCategory: 'user-interaction',
                create: () => createAskTool(),
            },
        })
    },
    deactivate() {
        defaultAskController.abortAll()
        useAskStore.getState().clearAll()
    },
})

export const entry = askAgentEntry
export default askAgentEntry
