import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ModelCatalogEntry } from '@cpa/plugin-api'
import type { CodexToolDefinition } from './types'
import { buildCodexRequest } from './codexRequest'

const visionModel: ModelCatalogEntry = {
    id: 'vision-model',
    label: 'Vision Model',
    supportsFast: true,
    reasoningLevels: [
        { id: 'high', requestValue: 'high' },
        { id: 'off', requestValue: 'off' },
    ],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
}

const textOnlyModel: ModelCatalogEntry = {
    id: 'text-model',
    label: 'Text Model',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 64_000,
    maxTokens: 8_192,
}

const readToolDefinition: CodexToolDefinition = {
    name: 'read',
    description: 'Read a file from disk',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
    },
}

const canonicalFixture: ConversationEntry[] = [
    {
        id: 'u1',
        sessionId: 'session-1',
        createdAt: 1,
        kind: 'user',
        content: [
            { type: 'text', text: 'hello' },
            { type: 'image', data: 'xyz', mimeType: 'image/png' },
        ],
    },
    {
        id: 'a1',
        sessionId: 'session-1',
        createdAt: 2,
        kind: 'assistant',
        model: 'vision-model',
        content: [
            {
                type: 'toolCall',
                id: 'call_1|fc_1',
                name: 'read',
                arguments: { path: 'a.ts' },
            },
        ],
        status: 'done',
        stopReason: 'toolUse',
    },
    {
        id: 't1',
        sessionId: 'session-1',
        createdAt: 3,
        kind: 'toolResult',
        toolCallId: 'call_1|fc_1',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
    },
    {
        id: 'c1',
        sessionId: 'session-1',
        createdAt: 0,
        kind: 'compaction',
        summary: 'Earlier context summary',
        firstKeptEntryId: 'u1',
    },
]

describe('buildCodexRequest', () => {
    it('builds fast reasoning requests without duplicating the system prompt', () => {
        const body = buildCodexRequest({
            model: visionModel,
            sessionId: 'session-1',
            systemPrompt: 'system text',
            entries: canonicalFixture,
            tools: [readToolDefinition],
            reasoningEffort: 'high',
            speed: 'fast',
        })

        expect(body).toMatchObject({
            type: 'response.create',
            model: 'vision-model',
            store: false,
            stream: true,
            instructions: 'system text',
            prompt_cache_key: 'session-1',
            tool_choice: 'auto',
            parallel_tool_calls: true,
            service_tier: 'priority',
            reasoning: { effort: 'high', summary: 'auto' },
        })
        expect(body.text).toEqual({ verbosity: 'low' })
        expect(body.include).toEqual(['reasoning.encrypted_content'])
        expect(body.input).not.toContainEqual(expect.objectContaining({ role: 'system' }))
        expect(body).not.toHaveProperty('maxTokens')
        expect(body).not.toHaveProperty('max_tokens')
        expect(body).not.toHaveProperty('max_output_tokens')

        expect(body.tools).toEqual([
            {
                type: 'function',
                name: 'read',
                description: 'Read a file from disk',
                parameters: readToolDefinition.parameters,
                strict: null,
            },
        ])
        // Must not mutate the input tool schema object.
        expect(body.tools?.[0]?.parameters).toBe(readToolDefinition.parameters)
    })

    it('omits service_tier for standard speed and omits tools when none are provided', () => {
        const withToolsStandard = buildCodexRequest({
            model: visionModel,
            sessionId: 's-std',
            systemPrompt: 'sys',
            entries: canonicalFixture,
            tools: [readToolDefinition],
            reasoningEffort: 'high',
            speed: 'standard',
        })
        expect(withToolsStandard).not.toHaveProperty('service_tier')
        expect(withToolsStandard.tools).toHaveLength(1)
        expect(withToolsStandard.tool_choice).toBe('auto')
        expect(withToolsStandard.parallel_tool_calls).toBe(true)

        const noTools = buildCodexRequest({
            model: textOnlyModel,
            sessionId: 's-no-tools',
            systemPrompt: 'sys',
            entries: [{
                id: 'u1',
                sessionId: 's-no-tools',
                createdAt: 1,
                kind: 'user',
                content: [{ type: 'text', text: 'hi' }],
            }],
            tools: [],
            speed: 'fast',
        })
        expect(noTools).not.toHaveProperty('tools')
        expect(noTools).not.toHaveProperty('tool_choice')
        expect(noTools).not.toHaveProperty('parallel_tool_calls')
        // Fast requested but model does not support Fast.
        expect(noTools).not.toHaveProperty('service_tier')
    })

    it('omits reasoning when effort is off and keeps the original request value otherwise', () => {
        const off = buildCodexRequest({
            model: visionModel,
            sessionId: 's-off',
            systemPrompt: 'sys',
            entries: [],
            reasoningEffort: 'off',
        })
        expect(off).not.toHaveProperty('reasoning')

        const none = buildCodexRequest({
            model: visionModel,
            sessionId: 's-none',
            systemPrompt: 'sys',
            entries: [],
            reasoningEffort: 'none',
        })
        expect(none).not.toHaveProperty('reasoning')

        const custom = buildCodexRequest({
            model: visionModel,
            sessionId: 's-custom',
            systemPrompt: 'sys',
            entries: [],
            // Preserve raw request value from model catalog (not remapped).
            reasoningEffort: 'xhigh',
        })
        expect(custom.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
    })

    it('embeds image data URLs, compaction summary context, and normalized tool call ids', () => {
        const body = buildCodexRequest({
            model: visionModel,
            sessionId: 'session-1',
            systemPrompt: 'system text',
            entries: canonicalFixture,
            tools: [readToolDefinition],
            reasoningEffort: 'high',
            speed: 'fast',
        })

        expect(body.input).toContainEqual({
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: expect.stringContaining('Earlier context summary'),
                },
            ],
        })
        expect(body.input).toContainEqual({
            role: 'user',
            content: [
                { type: 'input_text', text: 'hello' },
                {
                    type: 'input_image',
                    detail: 'auto',
                    image_url: 'data:image/png;base64,xyz',
                },
            ],
        })
        expect(body.input).toContainEqual({
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read',
            arguments: JSON.stringify({ path: 'a.ts' }),
        })
        expect(body.input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'ok',
        })
        expect(body.instructions).toBe('system text')
        expect(body.input).not.toContainEqual(expect.objectContaining({ role: 'system' }))
    })

    it('sets max_output_tokens only when maxOutputTokens is a positive number (summary-only)', () => {
        const normal = buildCodexRequest({
            model: visionModel,
            sessionId: 's-normal',
            systemPrompt: 'sys',
            entries: [],
        })
        expect(normal).not.toHaveProperty('max_output_tokens')
        expect(normal).not.toHaveProperty('maxTokens')
        expect(normal).not.toHaveProperty('max_tokens')

        const summary = buildCodexRequest({
            model: visionModel,
            sessionId: 's-summary-fresh',
            systemPrompt: 'You are a context summarization assistant.',
            entries: [],
            tools: [],
            maxOutputTokens: 8192.9,
        })
        expect(summary.max_output_tokens).toBe(8192)
        expect(summary.prompt_cache_key).toBe('s-summary-fresh')
        expect(summary).not.toHaveProperty('tools')

        const invalid = buildCodexRequest({
            model: visionModel,
            sessionId: 's-invalid',
            systemPrompt: 'sys',
            entries: [],
            maxOutputTokens: 0,
        })
        expect(invalid).not.toHaveProperty('max_output_tokens')
    })

    it('injects developerPrompt as a role: developer message at the head of input', () => {
        const body = buildCodexRequest({
            model: visionModel,
            sessionId: 's-developer',
            systemPrompt: 'Base system instructions.',
            developerPrompt: 'Role: Reviewer\nStrict review rules.',
            entries: [],
        })
        expect(body.input[0]).toEqual({
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Role: Reviewer\nStrict review rules.' }],
        })
        expect(body.instructions).toBe('Base system instructions.')
    })
})
