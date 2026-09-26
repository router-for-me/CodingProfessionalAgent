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

    it('omits reasoning for off or unsupported effort', () => {
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
            reasoningEffort: 'xhigh',
        })
        expect(custom).not.toHaveProperty('reasoning')
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

    it('serializes a standalone required native web search without function tools', () => {
        const body = buildCodexRequest({
            model: textOnlyModel,
            sessionId: 'isolated-search',
            systemPrompt: 'Search the web.',
            entries: [],
            nativeTools: [{ type: 'web_search' }],
            toolChoice: 'required',
        })

        expect(body.store).toBe(false)
        expect(body.stream).toBe(true)
        expect(body.tools).toEqual([{ type: 'web_search' }])
        expect(body.tool_choice).toBe('required')
        expect(body.parallel_tool_calls).toBe(true)
        expect(body).not.toHaveProperty('previous_response_id')
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

    it('pins top-level reasoning.effort to baseReasoningEffort and injects configuration_update for mid-conversation changes', () => {
        const reasoningModel: ModelCatalogEntry = {
            id: 'gpt-6-astra',
            label: 'GPT-6 Astra',
            supportsFast: true,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'medium', requestValue: 'medium' },
                { id: 'high', requestValue: 'high' },
            ],
            input: ['text', 'image'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        }

        const entries: ConversationEntry[] = [
            {
                id: 'u1',
                sessionId: 's-multi',
                createdAt: 1,
                kind: 'user',
                reasoningEffort: 'low',
                content: [{ type: 'text', text: 'Turn 1 prompt' }],
            },
            {
                id: 'a1',
                sessionId: 's-multi',
                createdAt: 2,
                kind: 'assistant',
                reasoningEffort: 'low',
                model: 'gpt-6-astra',
                stopReason: 'stop',
                status: 'done',
                content: [{ type: 'text', text: 'Turn 1 answer' }],
            },
            {
                id: 'u2',
                sessionId: 's-multi',
                createdAt: 3,
                kind: 'user',
                reasoningEffort: 'high',
                content: [{ type: 'text', text: 'Turn 2 prompt with high effort' }],
            },
        ]

        const body = buildCodexRequest({
            model: reasoningModel,
            sessionId: 's-multi',
            systemPrompt: 'System instructions',
            entries,
            reasoningEffort: 'high',
            baseReasoningEffort: 'low',
        })

        // Request-level reasoning.effort MUST be 'low' to preserve prompt caching
        expect(body.reasoning).toEqual({
            effort: 'low',
            summary: 'auto',
        })

        // The input array MUST contain the configuration_update before u2
        const configUpdate = body.input.find(
            (item) => (item as { type?: string }).type === 'configuration_update',
        )
        expect(configUpdate).toEqual({
            type: 'configuration_update',
            reasoning: { effort: 'high' },
        })
    })

    it('switches on the next tool request and keeps the reconstructed prefix stable across further tool calls', () => {
        const model = { ...visionModel, id: 'gpt-6-astra', reasoningLevels: [
            { id: 'low', requestValue: 'low' },
            { id: 'high', requestValue: 'high' },
        ] }
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
            { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low', model: model.id, status: 'done', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: {} }] },
            { id: 't1', sessionId: 's1', createdAt: 3, kind: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'read', content: [{ type: 'text', text: 'Result 1' }], isError: false },
            { id: 'a2', sessionId: 's1', createdAt: 4, kind: 'assistant', reasoningEffort: 'high', model: model.id, status: 'done', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_2|fc_2', name: 'read', arguments: {} }] },
            { id: 't2', sessionId: 's1', createdAt: 5, kind: 'toolResult', toolCallId: 'call_2|fc_2', toolName: 'read', content: [{ type: 'text', text: 'Result 2' }], isError: false },
            { id: 'a3', sessionId: 's1', createdAt: 6, kind: 'assistant', reasoningEffort: 'low', model: model.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] },
        ]
        const request = (count: number, effort: string) => buildCodexRequest({
            model, sessionId: 's1', systemPrompt: 'System', entries: entries.slice(0, count),
            reasoningEffort: effort, baseReasoningEffort: 'low',
        })

        const high = request(3, 'high')
        expect(high.reasoning?.effort).toBe('low')
        expect(high.input.at(-2)).toMatchObject({ type: 'function_call_output' })
        expect(high.input.at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })
        const highReplay = request(4, 'high')
        expect(highReplay.input.slice(0, high.input.length)).toEqual(high.input)

        const low = request(5, 'low')
        expect(low.input.slice(0, high.input.length)).toEqual(high.input)
        expect(low.input.at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: 'low' } })
        const lowReplay = request(6, 'low')
        expect(lowReplay.input.slice(0, -1)).toEqual(low.input)
        expect(lowReplay.input.filter((item) => 'type' in item && item.type === 'configuration_update')).toEqual([
            { type: 'configuration_update', reasoning: { effort: 'high' } },
            { type: 'configuration_update', reasoning: { effort: 'low' } },
        ])
    })

    it('supports configuration updates and base reasoning effort pinning across non-GPT-6 models with reasoning levels', () => {
        const model = {
            ...visionModel,
            id: 'claude-3-7-sonnet',
            reasoningLevels: [
                { id: 'low', requestValue: 'low-effort' },
                { id: 'high', requestValue: 'high-effort' },
            ],
        }
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
            { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
        ]
        const body = buildCodexRequest({
            model,
            sessionId: 's1',
            systemPrompt: 'System instructions',
            entries,
            reasoningEffort: 'high',
            baseReasoningEffort: 'low',
        })
        expect(body.reasoning).toEqual({ effort: 'low-effort', summary: 'auto' })
        expect(body.input).toContainEqual({
            type: 'configuration_update',
            reasoning: { effort: 'high-effort' },
        })
    })

    it('maps historical and current level IDs before constructing GPT-6 requests', () => {
        const model = {
            ...visionModel,
            id: 'gpt-6-astra',
            reasoningLevels: [
                { id: 'off', requestValue: 'none' },
                { id: 'high', requestValue: 'high-effort' },
            ],
        }
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'off', content: [{ type: 'text', text: 'First' }] },
            { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
        ]
        const body = buildCodexRequest({
            model,
            sessionId: 's1',
            systemPrompt: 'System instructions',
            entries,
            reasoningEffort: 'high',
        })
        expect(body).not.toHaveProperty('reasoning')
        expect(body.input[1]).toEqual({ type: 'configuration_update', reasoning: { effort: 'high-effort' } })
    })

    it('honors an explicit base across separate requests even when earlier entries have another effort', () => {
        const model = { ...visionModel, reasoningLevels: [
            { id: 'low', requestValue: 'LowEffort' },
            { id: 'high', requestValue: 'HighEffort' },
        ] }
        const firstUser: ConversationEntry = {
            id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user',
            reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }],
        }
        const secondUser: ConversationEntry = {
            id: 'u2', sessionId: 's1', createdAt: 3, kind: 'user',
            reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }],
        }
        const assistant: ConversationEntry = {
            id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant',
            reasoningEffort: 'low', model: model.id, status: 'done', stopReason: 'stop',
            content: [{ type: 'text', text: 'Answer' }],
        }
        const first = buildCodexRequest({
            model, sessionId: 's1', systemPrompt: 'System', entries: [firstUser], reasoningEffort: 'low',
        })
        const second = buildCodexRequest({
            model, sessionId: 's1', systemPrompt: 'System', entries: [firstUser, assistant, secondUser],
            reasoningEffort: 'high', baseReasoningEffort: 'high',
        })
        expect(first.reasoning?.effort).toBe('LowEffort')
        expect(second.reasoning?.effort).toBe('HighEffort')
        expect(second.input[0]).toEqual({
            type: 'configuration_update', reasoning: { effort: 'LowEffort' },
        })
        expect(second.input).toContainEqual({
            type: 'configuration_update', reasoning: { effort: 'HighEffort' },
        })
    })

    it('replays an assistant effort change and applies the current effort at the request boundary', () => {
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', content: [{ type: 'text', text: 'First' }] },
            { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'high', model: visionModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }] },
        ]
        const body = buildCodexRequest({
            model: visionModel, sessionId: 's1', systemPrompt: 'System', entries,
            reasoningEffort: 'off', baseReasoningEffort: 'off',
        })
        expect(body.reasoning).toBeUndefined()
        expect(body.input.map((item) => 'role' in item ? item.role : item.type)).toEqual([
            'configuration_update', 'user', 'assistant', 'configuration_update',
        ])
        expect(body.input[0]).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })
        expect(body.input.at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: 'off' } })
    })

    it('keeps the explicit base after truncation when the first retained turn uses a higher effort', () => {
        const model = { ...visionModel, reasoningLevels: [
            { id: 'low', requestValue: 'LowEffort' },
            { id: 'high', requestValue: 'HighEffort' },
        ] }
        const entries: ConversationEntry[] = [
            { id: 'c1', sessionId: 's1', createdAt: 1, kind: 'compaction', summary: 'Earlier turns', firstKeptEntryId: 'u2' },
            { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Continue' }] },
        ]
        const body = buildCodexRequest({
            model, sessionId: 's1', systemPrompt: 'System', entries,
            reasoningEffort: 'high', baseReasoningEffort: 'low',
        })

        expect(body.reasoning).toEqual({ effort: 'LowEffort', summary: 'auto' })
        expect(body.input[1]).toEqual({ type: 'configuration_update', reasoning: { effort: 'HighEffort' } })
    })

    it('ignores unsupported efforts from a previous model when pinning and replaying a new model', () => {
        const model = { ...visionModel, reasoningLevels: [
            { id: 'low', requestValue: 'low-effort' },
            { id: 'high', requestValue: 'high-effort' },
        ] }
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'xhigh', content: [{ type: 'text', text: 'Old model' }] },
            { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', model: 'old-model', reasoningEffort: 'xhigh', status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }] },
            { id: 'u2', sessionId: 's1', createdAt: 3, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'New model' }] },
        ]
        for (const baseReasoningEffort of [undefined, 'xhigh']) {
            const body = buildCodexRequest({
                model, sessionId: 's1', systemPrompt: 'System', entries,
                reasoningEffort: 'high', baseReasoningEffort,
            })
            expect(body.reasoning).toEqual({ effort: 'high-effort', summary: 'auto' })
            expect(body.input.filter((item) => 'type' in item && item.type === 'configuration_update')).toEqual([])
            expect(JSON.stringify(body)).not.toContain('xhigh')
        }
    })

    it('infers the first supported historical effort after a model switch', () => {
        const model = { ...visionModel, reasoningLevels: [
            { id: 'low', requestValue: 'low-effort' },
            { id: 'high', requestValue: 'high-effort' },
        ] }
        const entries: ConversationEntry[] = [
            { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'xhigh', content: [{ type: 'text', text: 'Old model' }] },
            { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'New model' }] },
            { id: 'u3', sessionId: 's1', createdAt: 3, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Continue' }] },
        ]
        const body = buildCodexRequest({ model, sessionId: 's1', systemPrompt: 'System', entries, reasoningEffort: 'high' })
        expect(body.reasoning).toEqual({ effort: 'low-effort', summary: 'auto' })
        expect(body.input).toContainEqual({ type: 'configuration_update', reasoning: { effort: 'high-effort' } })
        expect(JSON.stringify(body)).not.toContain('xhigh')
    })

    it('infers baseReasoningEffort from entries history when not explicitly supplied', () => {
        const reasoningModel: ModelCatalogEntry = {
            id: 'gpt-6-astra',
            label: 'GPT-6 Astra',
            supportsFast: true,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'medium', requestValue: 'medium' },
                { id: 'high', requestValue: 'high' },
            ],
            input: ['text', 'image'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        }

        const entries: ConversationEntry[] = [
            {
                id: 'u1',
                sessionId: 's-inferred',
                createdAt: 1,
                kind: 'user',
                reasoningEffort: 'low',
                content: [{ type: 'text', text: 'First user prompt' }],
            },
            {
                id: 'u2',
                sessionId: 's-inferred',
                createdAt: 2,
                kind: 'user',
                reasoningEffort: 'high',
                content: [{ type: 'text', text: 'Second user prompt' }],
            },
        ]

        const body = buildCodexRequest({
            model: reasoningModel,
            sessionId: 's-inferred',
            systemPrompt: 'System instructions',
            entries,
            reasoningEffort: 'high',
        })

        // Should automatically infer 'low' from u1
        expect(body.reasoning?.effort).toBe('low')
    })
})
