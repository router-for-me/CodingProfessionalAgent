/**
 * Build Codex Responses `response.create` request bodies.
 */

import type { ConversationEntry, ModelCatalogEntry } from '@cpa/plugin-api'
import { convertConversationToCodexInput } from './codexMessages'
import type {
    CodexFunctionTool,
    CodexResponseCreate,
    CodexToolDefinition,
} from './types'

export type CodexRequestSpeed = 'standard' | 'fast'

export interface BuildCodexRequestInput {
    model: ModelCatalogEntry
    sessionId: string
    systemPrompt: string
    developerPrompt?: string
    entries: readonly ConversationEntry[]
    tools?: readonly CodexToolDefinition[]
    /** Original catalog request value (not remapped). */
    reasoningEffort?: string
    speed?: CodexRequestSpeed
    previousResponseId?: string
    /**
     * Summary-only output budget. When positive, sets wire `max_output_tokens`.
     * Normal agent turns must leave this unset so the field is omitted.
     */
    maxOutputTokens?: number
}

function convertTools(tools: readonly CodexToolDefinition[]): CodexFunctionTool[] {
    return tools.map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        // Reuse the original schema object; do not clone/mutate.
        parameters: tool.parameters,
        strict: null,
    }))
}

function shouldIncludeReasoning(effort: string | undefined): effort is string {
    if (effort === undefined) return false
    const normalized = effort.trim().toLowerCase()
    if (!normalized) return false
    return normalized !== 'off' && normalized !== 'none'
}

/**
 * Construct a WebSocket `response.create` payload.
 *
 * Rules:
 * - system prompt only in `instructions`
 * - no maxTokens / max_tokens on normal turns; max_output_tokens only when
 *   maxOutputTokens is explicitly provided (summary-only)
 * - service_tier only when speed=fast and model.supportsFast
 * - tools / tool_choice / parallel_tool_calls only when tools are present
 * - reasoning uses the raw request value; off/none omits the field
 */
export function buildCodexRequest(input: BuildCodexRequestInput): CodexResponseCreate {
    const {
        model,
        sessionId,
        systemPrompt,
        developerPrompt,
        entries,
        tools,
        reasoningEffort,
        speed,
        previousResponseId,
        maxOutputTokens,
    } = input

    const rawInstructions = systemPrompt || 'You are a helpful assistant.'
    const effectiveInstructions =
        developerPrompt && !rawInstructions.includes(developerPrompt)
            ? `${developerPrompt}\n\n${rawInstructions}`
            : rawInstructions

    const body: CodexResponseCreate = {
        type: 'response.create',
        model: model.id,
        store: false,
        stream: true,
        instructions: effectiveInstructions,
        input: convertConversationToCodexInput(entries, model),
        text: { verbosity: 'low' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: sessionId,
    }

    if (tools && tools.length > 0) {
        body.tools = convertTools(tools)
        body.tool_choice = 'auto'
        body.parallel_tool_calls = true
    }

    if (shouldIncludeReasoning(reasoningEffort)) {
        body.reasoning = {
            effort: reasoningEffort,
            summary: 'auto',
        }
    }

    if (speed === 'fast' && model.supportsFast) {
        body.service_tier = 'priority'
    }

    if (previousResponseId) {
        body.previous_response_id = previousResponseId
    }

    // Summary-only optional budget. Never set for ordinary agent turns.
    if (
        typeof maxOutputTokens === 'number' &&
        Number.isFinite(maxOutputTokens) &&
        maxOutputTokens > 0
    ) {
        body.max_output_tokens = Math.floor(maxOutputTokens)
    }

    return body
}
