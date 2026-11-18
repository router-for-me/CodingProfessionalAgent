import type { AgentTool, ToolSetPreparation } from '@cpa/plugin-api'
import type { SystemPromptTool } from '../context/systemPrompt'

/**
 * Resolve a side-effect-free preview of how the active tool-set policy
 * partitions tools into top-level tools and nested tools for prompt building.
 */
export async function previewToolSetForPrompt(
    tools: readonly AgentTool[],
    context?: { sessionId?: string | null },
): Promise<ToolSetPreparation> {
    const preparers = tools.filter((tool) => typeof tool.prepareToolSet === 'function')
    if (preparers.length === 1 && typeof preparers[0]?.previewToolSet === 'function') {
        return await preparers[0].previewToolSet(tools, context)
    }
    return {
        tools,
        nestedTools: [],
    }
}

/**
 * Project AgentTools into concise system-prompt descriptors, preferring
 * `promptDescription` over the full tool-schema `description` when supplied.
 */
export function toSystemPromptToolDescriptors(
    tools: readonly AgentTool[],
): SystemPromptTool[] {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.promptDescription ?? tool.description,
        ...(tool.promptDescription !== undefined ? { promptDescription: tool.promptDescription } : {}),
    }))
}
