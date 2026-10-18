import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, ToolFactoryContribution } from '@cpa/plugin-api'
import {
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_NAME,
    ASK_TOOL_PARAMETERS,
    createAskTool,
    parseAskOptions,
} from './askTool.js'
import {
    defaultAskController,
    parseAskEventPayload,
    registerAskContextClient,
    unregisterAskContextClient,
    useAskStore,
} from '../shared/askStore.js'
import type { AskDecision } from '../shared/types.js'

export {
    ASK_TOOL_NAME,
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_PARAMETERS,
    createAskTool,
    parseAskOptions,
}

const agentContextDisposers = new Map<object, () => void>()
const activeAgentContexts = new Set<object>()

export const askAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        let isDisposed = false
        if (context && typeof context === 'object') {
            agentContextDisposers.get(context)?.()
            activeAgentContexts.add(context)
        }
        registerAskContextClient(context, context.capabilityClient)

        let unsubAction: (() => void) | undefined
        if (typeof context.capabilityClient?.subscribe === 'function') {
            try {
                unsubAction = context.capabilityClient.subscribe('ask:action', (raw) => {
                    if (isDisposed) return
                    const payload = parseAskEventPayload<{
                        action?: string
                        sessionId?: string
                        toolCallId?: string
                        decision?: AskDecision
                    }>(raw)
                    if (!payload || !payload.sessionId) return
                    if (payload.action === 'submitAnswer' && payload.toolCallId && payload.decision) {
                        useAskStore
                            .getState()
                            .submitAnswer(payload.sessionId, payload.toolCallId, payload.decision)
                    } else if (payload.action === 'cancelCountdown' && payload.toolCallId) {
                        useAskStore
                            .getState()
                            .cancelCountdown(payload.sessionId, payload.toolCallId)
                    } else if (payload.action === 'cancel') {
                        useAskStore.getState().cancel(payload.sessionId, payload.toolCallId)
                    }
                })
            } catch {
                // Ignore subscription error when capability handle is not bound in isolated unit tests
            }
        }

        const cleanup = () => {
            isDisposed = true
            unsubAction?.()
        }
        if (context && typeof context === 'object') {
            agentContextDisposers.set(context, cleanup)
        }

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
                create: (ctx: any) =>
                    createAskTool({
                        capabilityClient: ctx?.capabilityClient ?? context.capabilityClient,
                    }),
            },
        })
    },
    deactivate(context?: PluginContext) {
        if (context && typeof context === 'object') {
            agentContextDisposers.get(context)?.()
            agentContextDisposers.delete(context)
            activeAgentContexts.delete(context)
            unregisterAskContextClient(context)
            if (activeAgentContexts.size === 0) {
                defaultAskController.abortAll()
                useAskStore.getState().clearAll()
            }
            return
        }
        for (const dispose of agentContextDisposers.values()) {
            dispose()
        }
        agentContextDisposers.clear()
        activeAgentContexts.clear()
        unregisterAskContextClient()
        defaultAskController.abortAll()
        useAskStore.getState().clearAll()
    },
})

export const entry = askAgentEntry
export default askAgentEntry
