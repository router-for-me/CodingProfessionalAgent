import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ModelCatalogEntry } from '@cpa/plugin-api'
import { convertConversationToCodexInput } from './codexMessages'

const visionModel: ModelCatalogEntry = {
    id: 'vision-model',
    label: 'Vision Model',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 16_384,
}

const textModel: ModelCatalogEntry = {
    id: 'text-model',
    label: 'Text Model',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
}

const reasoningItem = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'thinking out loud' }],
    encrypted_content: 'enc-payload',
}

const textSignature = JSON.stringify({ v: 1, id: 'msg_original_1', phase: 'final_answer' })

const canonicalFixture: ConversationEntry[] = [
    {
        id: 'c1',
        sessionId: 'session-1',
        createdAt: 1,
        kind: 'compaction',
        summary: 'Prior work on auth module.',
        firstKeptEntryId: 'u1',
    },
    {
        id: 'u1',
        sessionId: 'session-1',
        createdAt: 2,
        kind: 'user',
        content: [
            { type: 'text', text: 'Look at this screenshot' },
            { type: 'image', data: 'abc123base64', mimeType: 'image/png' },
        ],
    },
    {
        id: 'a1',
        sessionId: 'session-1',
        createdAt: 3,
        kind: 'assistant',
        model: 'vision-model',
        content: [
            {
                type: 'thinking',
                thinking: 'thinking out loud',
                signature: JSON.stringify(reasoningItem),
            },
            {
                type: 'text',
                text: 'I will read the file',
                signature: textSignature,
            },
            {
                type: 'toolCall',
                id: 'call_1|fc_1',
                name: 'read',
                arguments: { path: 'src/main.ts' },
            },
        ],
        status: 'done',
        stopReason: 'toolUse',
    },
    {
        id: 't1',
        sessionId: 'session-1',
        createdAt: 4,
        kind: 'toolResult',
        toolCallId: 'call_1|fc_1',
        toolName: 'read',
        content: [{ type: 'text', text: 'export const x = 1' }],
        isError: false,
    },
]

describe('convertConversationToCodexInput', () => {
    it('converts compaction, user images, assistant signatures, and tool call ids', () => {
        const input = convertConversationToCodexInput(canonicalFixture, visionModel)

        expect(input).not.toContainEqual(expect.objectContaining({ role: 'system' }))

        expect(input[0]).toEqual({
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: expect.stringContaining('Prior work on auth module.'),
                },
            ],
        })
        expect((input[0] as { content: Array<{ text: string }> }).content[0].text).toContain(
            '<summary>',
        )
        expect((input[0] as { content: Array<{ text: string }> }).content[0].text).not.toMatch(
            /^system/i,
        )

        expect(input).toContainEqual({
            role: 'user',
            content: [
                { type: 'input_text', text: 'Look at this screenshot' },
                {
                    type: 'input_image',
                    detail: 'auto',
                    image_url: 'data:image/png;base64,abc123base64',
                },
            ],
        })

        expect(input).toContainEqual(reasoningItem)

        expect(input).toContainEqual({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will read the file', annotations: [] }],
            status: 'completed',
            id: 'msg_original_1',
            phase: 'final_answer',
        })

        expect(input).toContainEqual({
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read',
            arguments: JSON.stringify({ path: 'src/main.ts' }),
        })

        expect(input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'export const x = 1',
        })
    })

    it('normalizes tool result call_id with split limit semantics and supports image outputs', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_x|fc_x|extra',
                        name: 'read',
                        arguments: { path: 'img.png' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_x|fc_x|extra',
                toolName: 'read',
                content: [
                    { type: 'text', text: 'preview' },
                    { type: 'image', data: 'imgdata', mimeType: 'image/jpeg' },
                ],
                isError: false,
            },
        ]

        // JS String#split(separator, limit) caps returned segments; limit 1 yields [head].
        expect('call_x|fc_x|extra'.split('|', 1)[0]).toBe('call_x')

        const input = convertConversationToCodexInput(entries, visionModel)
        // Multi-pipe item id is illegal: omit id, keep call_id.
        expect(input).toContainEqual({
            type: 'function_call',
            call_id: 'call_x',
            name: 'read',
            arguments: JSON.stringify({ path: 'img.png' }),
        })
        expect(input.find((item) => (item as { type?: string }).type === 'function_call')).not.toHaveProperty(
            'id',
        )
        expect(input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_x',
            output: [
                { type: 'input_text', text: 'preview' },
                {
                    type: 'input_image',
                    detail: 'auto',
                    image_url: 'data:image/jpeg;base64,imgdata',
                },
            ],
        })
    })

    it('degrades unsupported user and tool images to explicit text placeholders', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'u1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'user',
                content: [
                    { type: 'text', text: 'see image' },
                    { type: 'image', data: 'aaa', mimeType: 'image/png' },
                    { type: 'image', data: 'bbb', mimeType: 'image/png' },
                ],
            },
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_2|fc_2',
                        name: 'read',
                        arguments: { path: 'a.png' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_2|fc_2',
                toolName: 'read',
                content: [{ type: 'image', data: 'ccc', mimeType: 'image/png' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)

        expect(input).toContainEqual({
            role: 'user',
            content: [
                { type: 'input_text', text: 'see image' },
                {
                    type: 'input_text',
                    text: '(image omitted: model does not support images)',
                },
            ],
        })
        expect(JSON.stringify(input)).not.toContain('input_image')
        expect(JSON.stringify(input)).not.toContain('data:image')
        expect(input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_2',
            output: '(tool image omitted: model does not support images)',
        })
    })

    it('restores text/thinking signatures without throwing on unparsable payloads', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'opaque thoughts',
                        signature: '{not-json',
                    },
                    {
                        type: 'text',
                        text: 'hello',
                        signature: 'msg_plain_legacy',
                    },
                    {
                        type: 'text',
                        text: 'no signature text',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        expect(() => convertConversationToCodexInput(entries, textModel)).not.toThrow()
        const input = convertConversationToCodexInput(entries, textModel)

        // Unparsable thinking signature falls back without throwing; no forged reasoning item.
        expect(input).not.toContainEqual(expect.objectContaining({ type: 'reasoning' }))

        expect(input).toContainEqual({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hello', annotations: [] }],
            status: 'completed',
            id: 'msg_plain_legacy',
        })

        expect(input).toContainEqual(
            expect.objectContaining({
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'no signature text', annotations: [] }],
                status: 'completed',
                id: expect.stringMatching(/^msg_/),
            }),
        )
    })

    it('rejects malicious or incomplete reasoning signatures without throwing', () => {
        const maliciousSignatures = [
            JSON.stringify({ type: 'reasoning' }), // missing id/summary
            JSON.stringify({ type: 'reasoning', id: 123, summary: [] }), // id not string
            JSON.stringify({
                type: 'reasoning',
                id: 'msg_not_rs',
                summary: [{ type: 'summary_text', text: 'x' }],
            }),
            JSON.stringify({
                type: 'reasoning',
                id: 'rs_ok',
                summary: 'not-array',
                encrypted_content: 'enc',
            }),
            JSON.stringify({
                type: 'reasoning',
                id: 'rs_ok',
                summary: [{ type: 'summary_text', text: 'x' }],
                encrypted_content: { nested: true },
            }),
            JSON.stringify({
                type: 'reasoning',
                id: 'rs_ok',
                summary: [{ type: 'summary_text', text: 'x' }],
                status: 'error',
            }),
            JSON.stringify({
                type: 'reasoning',
                id: 'rs_ok',
                summary: [{ type: 'summary_text', text: 'x' }],
                error: { message: 'boom' },
            }),
            JSON.stringify([{ type: 'reasoning', id: 'rs_1' }]), // array shape
            'just-a-string',
        ]

        const entries: ConversationEntry[] = maliciousSignatures.map((signature, index) => ({
            id: `a${index}`,
            sessionId: 's1',
            createdAt: index + 1,
            kind: 'assistant',
            model: 'text-model',
            content: [
                {
                    type: 'thinking',
                    thinking: 'should not become user text',
                    signature,
                },
                {
                    type: 'text',
                    text: `reply-${index}`,
                    signature: `msg_safe_${index}`,
                },
            ],
            status: 'done',
            stopReason: 'stop',
        }))

        expect(() => convertConversationToCodexInput(entries, textModel)).not.toThrow()
        const input = convertConversationToCodexInput(entries, textModel)

        expect(input).not.toContainEqual(expect.objectContaining({ type: 'reasoning' }))
        expect(JSON.stringify(input)).not.toContain('should not become user text')
        expect(JSON.stringify(input)).not.toContain('enc-payload')
        for (let index = 0; index < maliciousSignatures.length; index += 1) {
            expect(input).toContainEqual(
                expect.objectContaining({
                    type: 'message',
                    id: `msg_safe_${index}`,
                    content: [{ type: 'output_text', text: `reply-${index}`, annotations: [] }],
                }),
            )
        }
    })

    it('uses stable fallback message ids for illegal JSON/legacy text signatures', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'text',
                        text: 'id number',
                        signature: JSON.stringify({ v: 1, id: 42, phase: 'final_answer' }),
                    },
                    {
                        type: 'text',
                        text: 'missing id',
                        signature: JSON.stringify({ v: 1, phase: 'commentary' }),
                    },
                    {
                        type: 'text',
                        text: 'illegal legacy',
                        signature: 'not_a_msg_id',
                    },
                    {
                        type: 'text',
                        text: 'json junk',
                        signature: '{"v":1,"id":null}',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const messageIds = input
            .filter((item) => (item as { type?: string }).type === 'message')
            .map((item) => (item as { id: string }).id)

        expect(messageIds).toHaveLength(4)
        for (const id of messageIds) {
            expect(id).toMatch(/^msg_/)
            expect(id).not.toContain('{')
            expect(id).not.toBe('not_a_msg_id')
            expect(id).not.toBe('42')
        }
    })

    it('omits illegal or cross-model function_call item ids while keeping call_id', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_ok|fc_ok',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_bad|rs_not_fc',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_pipe|fc_a|fc_b',
                        name: 'read',
                        arguments: { path: 'c.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'a2',
                sessionId: 's1',
                createdAt: 2,
                kind: 'assistant',
                model: 'other-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_cross|fc_cross',
                        name: 'read',
                        arguments: { path: 'd.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_ok|fc_ok',
                toolName: 'read',
                content: [{ type: 'text', text: 'ok' }],
                isError: false,
            },
            {
                id: 't2',
                sessionId: 's1',
                createdAt: 4,
                kind: 'toolResult',
                toolCallId: 'call_bad|rs_not_fc',
                toolName: 'read',
                content: [{ type: 'text', text: 'bad' }],
                isError: false,
            },
            {
                id: 't3',
                sessionId: 's1',
                createdAt: 5,
                kind: 'toolResult',
                toolCallId: 'call_pipe|fc_a|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'pipe' }],
                isError: false,
            },
            {
                id: 't4',
                sessionId: 's1',
                createdAt: 6,
                kind: 'toolResult',
                toolCallId: 'call_cross|fc_cross',
                toolName: 'read',
                content: [{ type: 'text', text: 'cross' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const calls = input.filter((item) => (item as { type?: string }).type === 'function_call') as Array<{
            call_id: string
            id?: string
        }>

        expect(calls).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ call_id: 'call_ok', id: 'fc_ok' }),
                expect.objectContaining({ call_id: 'call_bad' }),
                expect.objectContaining({ call_id: 'call_pipe' }),
                expect.objectContaining({ call_id: 'call_cross' }),
            ]),
        )

        const byCallId = Object.fromEntries(calls.map((call) => [call.call_id, call]))
        expect(byCallId.call_ok?.id).toBe('fc_ok')
        expect(byCallId.call_bad).not.toHaveProperty('id')
        expect(byCallId.call_pipe).not.toHaveProperty('id')
        expect(byCallId.call_cross).not.toHaveProperty('id')
    })

    it('skips aborted/error/pending assistant partials and their orphan tool results', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a-abort',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'partial thinking',
                        signature: JSON.stringify({
                            type: 'reasoning',
                            id: 'rs_partial',
                            summary: [{ type: 'summary_text', text: 'partial' }],
                            encrypted_content: 'enc-partial',
                        }),
                    },
                    {
                        type: 'toolCall',
                        id: 'call_abort|fc_abort',
                        name: 'read',
                        arguments: { path: 'x.ts' },
                    },
                ],
                status: 'aborted',
                stopReason: 'aborted',
            },
            {
                id: 't-orphan',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_abort|fc_abort',
                toolName: 'read',
                content: [{ type: 'text', text: 'should not appear' }],
                isError: false,
            },
            {
                id: 'a-error',
                sessionId: 's1',
                createdAt: 3,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'text',
                        text: 'failed partial',
                        signature: 'msg_failed',
                    },
                    {
                        type: 'toolCall',
                        id: 'call_error|fc_error',
                        name: 'read',
                        arguments: { path: 'y.ts' },
                    },
                ],
                status: 'error',
                stopReason: 'error',
            },
            {
                id: 'a-stream',
                sessionId: 's1',
                createdAt: 4,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_stream|fc_stream',
                        name: 'read',
                        arguments: { path: 'z.ts' },
                    },
                ],
                status: 'streaming',
                stopReason: 'pending',
            },
            {
                id: 'a-ok',
                sessionId: 's1',
                createdAt: 5,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'text',
                        text: 'final',
                        signature: 'msg_final',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)

        expect(input).not.toContainEqual(expect.objectContaining({ type: 'reasoning' }))
        expect(input).not.toContainEqual(expect.objectContaining({ type: 'function_call' }))
        expect(input).not.toContainEqual(expect.objectContaining({ type: 'function_call_output' }))
        expect(JSON.stringify(input)).not.toContain('should not appear')
        expect(JSON.stringify(input)).not.toContain('failed partial')
        expect(input).toContainEqual({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'final', annotations: [] }],
            status: 'completed',
            id: 'msg_final',
        })
    })

    it('synthesizes missing tool outputs and skips orphan or duplicate tool results', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_missing|fc_missing',
                        name: 'read',
                        arguments: { path: 'missing.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_matched|fc_matched',
                        name: 'read',
                        arguments: { path: 'matched.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-orphan',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_never|fc_never',
                toolName: 'read',
                content: [{ type: 'text', text: 'orphan output' }],
                isError: false,
            },
            {
                id: 't-matched',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_matched|fc_matched',
                toolName: 'read',
                content: [{ type: 'text', text: 'matched output' }],
                isError: false,
            },
            {
                id: 't-dup',
                sessionId: 's1',
                createdAt: 4,
                kind: 'toolResult',
                toolCallId: 'call_matched|fc_matched',
                toolName: 'read',
                content: [{ type: 'text', text: 'duplicate output' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const callIds = input
            .filter((item) => (item as { type?: string }).type === 'function_call')
            .map((item) => (item as { call_id: string }).call_id)
        const outputs = input.filter(
            (item) => (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ call_id: string; output: string }>

        expect(callIds).toEqual(['call_missing', 'call_matched'])
        expect(outputs).toHaveLength(2)

        const missingIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_missing',
        )
        const matchedCallIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_matched',
        )
        const syntheticIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                (item as { call_id?: string }).call_id === 'call_missing',
        )
        const matchedOutputIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                (item as { call_id?: string }).call_id === 'call_matched',
        )
        expect(missingIndex).toBeGreaterThanOrEqual(0)
        // All assistant calls first, then missing synthetic, then later real result entry.
        expect(missingIndex).toBeLessThan(matchedCallIndex)
        expect(syntheticIndex).toBe(matchedCallIndex + 1)
        expect(matchedOutputIndex).toBe(syntheticIndex + 1)
        expect(outputs.find((item) => item.call_id === 'call_missing')?.output).toMatch(/error|missing|no matching/i)

        expect(outputs.find((item) => item.call_id === 'call_matched')?.output).toBe('matched output')
        expect(JSON.stringify(input)).not.toContain('orphan output')
        expect(JSON.stringify(input)).not.toContain('duplicate output')
    })

    it('omits encrypted reasoning when entry model differs or is unknown', () => {
        const validReasoning = {
            type: 'reasoning',
            id: 'rs_bound',
            summary: [{ type: 'summary_text', text: 'bound thinking' }],
            encrypted_content: 'enc-bound',
        }

        const entries: ConversationEntry[] = [
            {
                id: 'a-diff',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'other-model',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'do not fake to user',
                        signature: JSON.stringify(validReasoning),
                    },
                    {
                        type: 'text',
                        text: 'from other model',
                        signature: 'msg_other',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
            {
                id: 'a-unknown',
                sessionId: 's1',
                createdAt: 2,
                kind: 'assistant',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'unknown model thinking',
                        signature: JSON.stringify({
                            ...validReasoning,
                            id: 'rs_unknown',
                        }),
                    },
                    {
                        type: 'text',
                        text: 'from unknown model',
                        signature: 'msg_unknown',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
            {
                id: 'a-same',
                sessionId: 's1',
                createdAt: 3,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'same model thinking',
                        signature: JSON.stringify({
                            ...validReasoning,
                            id: 'rs_same',
                        }),
                    },
                    {
                        type: 'text',
                        text: 'from same model',
                        signature: 'msg_same',
                    },
                ],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const reasoningItems = input.filter((item) => (item as { type?: string }).type === 'reasoning')

        expect(reasoningItems).toHaveLength(1)
        expect(reasoningItems[0]).toEqual({
            type: 'reasoning',
            id: 'rs_same',
            summary: [{ type: 'summary_text', text: 'bound thinking' }],
            encrypted_content: 'enc-bound',
        })
        expect(JSON.stringify(input)).not.toContain('do not fake to user')
        expect(JSON.stringify(input)).not.toContain('unknown model thinking')
        expect(JSON.stringify(input)).not.toContain('rs_bound')
        expect(JSON.stringify(input)).not.toContain('rs_unknown')
    })

    it('appends explicit placeholders for each non-vision tool image even when text exists', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_mix|fc_mix',
                        name: 'read',
                        arguments: { path: 'mix.png' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_mix|fc_mix',
                toolName: 'read',
                content: [
                    { type: 'text', text: 'caption' },
                    { type: 'image', data: 'img1', mimeType: 'image/png' },
                    { type: 'image', data: 'img2', mimeType: 'image/png' },
                ],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const output = input.find(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                (item as { call_id?: string }).call_id === 'call_mix',
        ) as { output: string } | undefined

        expect(output?.output).toContain('caption')
        expect(output?.output).toContain('(tool image omitted: model does not support images)')
        const placeholderCount = (output?.output.match(/\(tool image omitted: model does not support images\)/g) ?? [])
            .length
        expect(placeholderCount).toBe(2)
        expect(JSON.stringify(input)).not.toContain('input_image')
        expect(JSON.stringify(input)).not.toContain('img1')
        expect(JSON.stringify(input)).not.toContain('img2')
    })

    it('distinguishes empty error tool results from empty success outputs', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_err|fc_err',
                        name: 'read',
                        arguments: { path: 'err.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_ok|fc_ok_empty',
                        name: 'read',
                        arguments: { path: 'ok.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_err_text|fc_err_text',
                        name: 'read',
                        arguments: { path: 'err2.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_err|fc_err',
                toolName: 'read',
                content: [],
                isError: true,
            },
            {
                id: 't2',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_ok|fc_ok_empty',
                toolName: 'read',
                content: [],
                isError: false,
            },
            {
                id: 't3',
                sessionId: 's1',
                createdAt: 4,
                kind: 'toolResult',
                toolCallId: 'call_err_text|fc_err_text',
                toolName: 'read',
                content: [{ type: 'text', text: 'permission denied' }],
                isError: true,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const outputs = Object.fromEntries(
            input
                .filter((item) => (item as { type?: string }).type === 'function_call_output')
                .map((item) => [
                    (item as { call_id: string }).call_id,
                    (item as { output: string }).output,
                ]),
        )

        expect(outputs.call_err).toMatch(/error/i)
        expect(outputs.call_ok).toBe('(no tool output)')
        expect(outputs.call_err).not.toBe(outputs.call_ok)
        expect(outputs.call_err_text).toContain('permission denied')
    })

    it('dedupes conflicting normalized call ids and keeps first-call result pairing', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_b',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-a',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'result-for-fc-a' }],
                isError: false,
            },
            {
                id: 't-b',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'result-for-fc-b' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const calls = input.filter((item) => (item as { type?: string }).type === 'function_call') as Array<{
            call_id: string
            id?: string
            arguments: string
        }>
        const outputs = input.filter(
            (item) => (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ call_id: string; output: string }>

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
            type: 'function_call',
            id: 'fc_a',
            call_id: 'call_1',
            name: 'read',
            arguments: JSON.stringify({ path: 'a.ts' }),
        })
        expect(outputs).toHaveLength(1)
        expect(outputs[0]).toEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'result-for-fc-a',
        })
        expect(JSON.stringify(input)).not.toContain('result-for-fc-b')
        expect(JSON.stringify(input)).not.toContain('"path":"b.ts"')
    })

    it('keeps first exact duplicate call/result and ignores later duplicates', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_dup|fc_dup',
                        name: 'read',
                        arguments: { path: 'first.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_dup|fc_dup',
                        name: 'read',
                        arguments: { path: 'second.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_dup|fc_dup',
                toolName: 'read',
                content: [{ type: 'text', text: 'first-result' }],
                isError: false,
            },
            {
                id: 't2',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_dup|fc_dup',
                toolName: 'read',
                content: [{ type: 'text', text: 'second-result' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const calls = input.filter((item) => (item as { type?: string }).type === 'function_call') as Array<{
            call_id: string
            arguments: string
        }>
        const outputs = input.filter(
            (item) => (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ call_id: string; output: string }>

        expect(calls).toHaveLength(1)
        expect(calls[0]?.arguments).toBe(JSON.stringify({ path: 'first.ts' }))
        expect(outputs).toHaveLength(1)
        expect(outputs[0]?.output).toBe('first-result')
        expect(JSON.stringify(input)).not.toContain('second-result')
        expect(JSON.stringify(input)).not.toContain('"path":"second.ts"')
    })

    it('skips result-before-call and uses later valid result or synthetic output', () => {
        const entries: ConversationEntry[] = [
            {
                id: 't-early',
                sessionId: 's1',
                createdAt: 1,
                kind: 'toolResult',
                toolCallId: 'call_order|fc_order',
                toolName: 'read',
                content: [{ type: 'text', text: 'early-result' }],
                isError: false,
            },
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_order|fc_order',
                        name: 'read',
                        arguments: { path: 'order.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_synth|fc_synth',
                        name: 'read',
                        arguments: { path: 'synth.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-later',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_order|fc_order',
                toolName: 'read',
                content: [{ type: 'text', text: 'later-result' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const callOrderIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_order',
        )
        const callSynthIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_synth',
        )
        const orderOutputs = input
            .map((item, index) => ({ item, index }))
            .filter(
                ({ item }) =>
                    (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                    (item as { call_id?: string }).call_id === 'call_order',
            )
        const synthOutputs = input
            .map((item, index) => ({ item, index }))
            .filter(
                ({ item }) =>
                    (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                    (item as { call_id?: string }).call_id === 'call_synth',
            )

        expect(orderOutputs).toHaveLength(1)
        expect(synthOutputs).toHaveLength(1)
        expect((orderOutputs[0]?.item as { output: string }).output).toBe('later-result')
        expect((orderOutputs[0]?.index ?? -1)).toBeGreaterThan(callOrderIndex)
        expect((synthOutputs[0]?.item as { output: string }).output).toMatch(
            /error|missing|no matching/i,
        )
        expect(synthOutputs[0]?.index).toBe(callSynthIndex + 1)
        expect(JSON.stringify(input)).not.toContain('early-result')
    })

    it('pairs multiple distinct call ids in order and keeps first valid result only', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_a|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_b|fc_b',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-a1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_a|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'a-first' }],
                isError: false,
            },
            {
                id: 't-b1',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_b|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'b-first' }],
                isError: false,
            },
            {
                id: 't-a2',
                sessionId: 's1',
                createdAt: 4,
                kind: 'toolResult',
                toolCallId: 'call_a|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'a-second' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const callIds = input
            .filter((item) => (item as { type?: string }).type === 'function_call')
            .map((item) => (item as { call_id: string }).call_id)
        const outputs = input.filter(
            (item) => (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ call_id: string; output: string }>

        expect(callIds).toEqual(['call_a', 'call_b'])
        expect(outputs.map((item) => item.call_id)).toEqual(['call_a', 'call_b'])
        expect(outputs.find((item) => item.call_id === 'call_a')?.output).toBe('a-first')
        expect(outputs.find((item) => item.call_id === 'call_b')?.output).toBe('b-first')
        expect(JSON.stringify(input)).not.toContain('a-second')

        const callAIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_a',
        )
        const outAIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                (item as { call_id?: string }).call_id === 'call_a',
        )
        const callBIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call' &&
                (item as { call_id?: string }).call_id === 'call_b',
        )
        const outBIndex = input.findIndex(
            (item) =>
                (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                (item as { call_id?: string }).call_id === 'call_b',
        )
        expect(callAIndex).toBeLessThan(callBIndex)
        expect(outAIndex).toBeGreaterThan(callAIndex)
        expect(outBIndex).toBeGreaterThan(callBIndex)
    })

    it('does not assign skipped conflicting raw result via normalized fallback', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_b',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-b-only',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'only-for-fc-b' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const calls = input.filter((item) => (item as { type?: string }).type === 'function_call') as Array<{
            call_id: string
            id?: string
        }>
        const outputs = input.filter(
            (item) => (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ call_id: string; output: string }>

        expect(calls).toHaveLength(1)
        expect(calls[0]?.call_id).toBe('call_1')
        expect(calls[0]?.id).toBe('fc_a')
        expect(outputs).toHaveLength(1)
        expect(outputs[0]?.output).toMatch(/error|missing|no matching/i)
        expect(JSON.stringify(input)).not.toContain('only-for-fc-b')
    })

    it('matches legacy normalized-only tool results to the selected call', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_legacy|fc_legacy',
                        name: 'read',
                        arguments: { path: 'legacy.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                // Legacy result stores only the normalized call id.
                toolCallId: 'call_legacy',
                toolName: 'read',
                content: [{ type: 'text', text: 'legacy-result' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        expect(input).toContainEqual({
            type: 'function_call',
            id: 'fc_legacy',
            call_id: 'call_legacy',
            name: 'read',
            arguments: JSON.stringify({ path: 'legacy.ts' }),
        })
        expect(input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_legacy',
            output: 'legacy-result',
        })
    })

    it('keeps all assistant function_calls contiguous when A is missing and B has a later result', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'text',
                        text: 'calling tools',
                        signature: 'msg_pre',
                    },
                    {
                        type: 'toolCall',
                        id: 'call_a|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_b|fc_b',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-b',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_b|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'b-result' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const types = input.map((item) => {
            const typed = item as { type?: string; role?: string; call_id?: string }
            if (typed.type === 'function_call') return `call:${typed.call_id}`
            if (typed.type === 'function_call_output') return `out:${typed.call_id}`
            if (typed.type === 'message' && typed.role === 'assistant') return 'assistant-text'
            return typed.type ?? 'unknown'
        })

        // Outputs of one assistant stay contiguous; synthetic A is after all calls.
        expect(types).toEqual([
            'assistant-text',
            'call:call_a',
            'call:call_b',
            'out:call_a',
            'out:call_b',
        ])
        expect(
            (input.find(
                (item) =>
                    (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                    (item as { call_id?: string }).call_id === 'call_a',
            ) as { output?: string } | undefined)?.output,
        ).toMatch(/error|missing|no matching/i)
        expect(
            (input.find(
                (item) =>
                    (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                    (item as { call_id?: string }).call_id === 'call_b',
            ) as { output?: string } | undefined)?.output,
        ).toBe('b-result')
    })

    it('appends multiple missing synthetic outputs after all assistant calls in call order', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                model: 'text-model',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_m1|fc_m1',
                        name: 'read',
                        arguments: { path: 'm1.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_m2|fc_m2',
                        name: 'read',
                        arguments: { path: 'm2.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_ok|fc_ok',
                        name: 'read',
                        arguments: { path: 'ok.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 't-ok',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_ok|fc_ok',
                toolName: 'read',
                content: [{ type: 'text', text: 'ok-result' }],
                isError: false,
            },
        ]

        const input = convertConversationToCodexInput(entries, textModel)
        const sequence = input.map((item) => {
            const typed = item as { type?: string; call_id?: string }
            if (typed.type === 'function_call') return `call:${typed.call_id}`
            if (typed.type === 'function_call_output') return `out:${typed.call_id}`
            return typed.type ?? 'unknown'
        })

        expect(sequence).toEqual([
            'call:call_m1',
            'call:call_m2',
            'call:call_ok',
            'out:call_m1',
            'out:call_m2',
            'out:call_ok',
        ])

        const syntheticOutputs = input.filter(
            (item) =>
                (item as { type?: string }).type === 'function_call_output' &&
                ((item as { call_id?: string }).call_id === 'call_m1' ||
                    (item as { call_id?: string }).call_id === 'call_m2'),
        ) as Array<{ call_id: string; output: string }>

        expect(syntheticOutputs.map((item) => item.call_id)).toEqual(['call_m1', 'call_m2'])
        for (const item of syntheticOutputs) {
            expect(item.output).toMatch(/error|missing|no matching/i)
        }
        expect(
            (input.find(
                (item) =>
                    (item as { type?: string; call_id?: string }).type === 'function_call_output' &&
                    (item as { call_id?: string }).call_id === 'call_ok',
            ) as { output?: string } | undefined)?.output,
        ).toBe('ok-result')
    })

    describe('mid-conversation reasoning effort configuration updates', () => {
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

        it('does not emit configuration_update when reasoning effort remains constant', () => {
            const entries: ConversationEntry[] = [
                {
                    id: 'u1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'user',
                    reasoningEffort: 'low',
                    content: [{ type: 'text', text: 'Hello' }],
                },
                {
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 2,
                    kind: 'assistant',
                    reasoningEffort: 'low',
                    model: 'gpt-6-astra',
                    stopReason: 'stop',
                    status: 'done',
                    content: [{ type: 'text', text: 'Hi there!' }],
                },
                {
                    id: 'u2',
                    sessionId: 's1',
                    createdAt: 3,
                    kind: 'user',
                    reasoningEffort: 'low',
                    content: [{ type: 'text', text: 'How are you?' }],
                },
            ]

            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'low',
            })

            const configUpdates = input.filter(
                (item) => (item as { type?: string }).type === 'configuration_update',
            )
            expect(configUpdates).toHaveLength(0)
        })

        it('emits configuration_update before user message when effort changes mid-conversation', () => {
            const entries: ConversationEntry[] = [
                {
                    id: 'u1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'user',
                    reasoningEffort: 'low',
                    content: [{ type: 'text', text: 'Turn 1 prompt' }],
                },
                {
                    id: 'a1',
                    sessionId: 's1',
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
                    sessionId: 's1',
                    createdAt: 3,
                    kind: 'user',
                    reasoningEffort: 'high',
                    content: [{ type: 'text', text: 'Turn 2 deep analysis prompt' }],
                },
            ]

            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'high',
            })

            // Expected sequence: user(u1) -> assistant(a1) -> configuration_update(high) -> user(u2)
            expect(input).toHaveLength(4)
            expect((input[0] as { role?: string }).role).toBe('user')
            expect((input[1] as { role?: string }).role).toBe('assistant')
            expect(input[2]).toEqual({
                type: 'configuration_update',
                reasoning: { effort: 'high' },
            })
            expect((input[3] as { role?: string }).role).toBe('user')
        })

        it('applies a running effort change before a stale last user and replays it consistently', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'Second' }] },
            ]
            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })

            expect(input).toEqual([
                expect.objectContaining({ role: 'user' }),
                { type: 'configuration_update', reasoning: { effort: 'high' } },
                expect.objectContaining({ role: 'user' }),
            ])
            const replay = convertConversationToCodexInput([
                ...entries,
                { id: 'a2', sessionId: 's1', createdAt: 3, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Answer' }] },
            ], reasoningModel, { baseReasoningEffort: 'low', targetReasoningEffort: 'high' })
            expect(replay.slice(0, input.length)).toEqual(input)
            expect(replay.at(-1)).toMatchObject({ role: 'assistant' })
        })

        it('does not emit two adjacent configuration_update items and collapses them', () => {
            const entries: ConversationEntry[] = [
                {
                    id: 'u1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'user',
                    reasoningEffort: 'low',
                    content: [{ type: 'text', text: 'First prompt' }],
                },
                {
                    id: 'u2',
                    sessionId: 's1',
                    createdAt: 2,
                    kind: 'user',
                    reasoningEffort: 'high',
                    content: [{ type: 'text', text: 'Second prompt' }],
                },
            ]

            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'high',
            })

            const types = input.map((item) => (item as { type?: string; role?: string }).type ?? (item as { role?: string }).role)
            for (let i = 0; i < types.length - 1; i++) {
                if (types[i] === 'configuration_update') {
                    expect(types[i + 1]).not.toBe('configuration_update')
                }
            }
        })

        it('does not emit configuration_update for models without reasoning support', () => {
            const entries: ConversationEntry[] = [
                {
                    id: 'u1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'user',
                    reasoningEffort: 'low',
                    content: [{ type: 'text', text: 'Prompt 1' }],
                },
                {
                    id: 'u2',
                    sessionId: 's1',
                    createdAt: 2,
                    kind: 'user',
                    reasoningEffort: 'high',
                    content: [{ type: 'text', text: 'Prompt 2' }],
                },
            ]

            const input = convertConversationToCodexInput(entries, textModel, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'high',
            })

            const configUpdates = input.filter(
                (item) => (item as { type?: string }).type === 'configuration_update',
            )
            expect(configUpdates).toHaveLength(0)
        })

        it('supports configuration update across all models as long as reasoning levels are present', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
            ]
            const input = convertConversationToCodexInput(entries, { ...reasoningModel, id: 'claude-3-7-sonnet' }, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'high',
            })
            expect(input).toContainEqual({
                type: 'configuration_update',
                reasoning: { effort: 'high' },
            })
        })

        it('tracks off/none explicitly and maps historical level IDs to request values', () => {
            const model = {
                ...reasoningModel,
                reasoningLevels: [
                    { id: 'off', requestValue: 'none' },
                    { id: 'high', requestValue: 'high-effort' },
                ],
            }
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'off', content: [{ type: 'text', text: 'First' }] },
                { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
                { id: 'u3', sessionId: 's1', createdAt: 3, kind: 'user', reasoningEffort: 'off', content: [{ type: 'text', text: 'Third' }] },
            ]
            const input = convertConversationToCodexInput(entries, model, {
                baseReasoningEffort: 'off',
                targetReasoningEffort: 'off',
            })
            expect(input).toEqual([
                expect.objectContaining({ role: 'user' }),
                { type: 'configuration_update', reasoning: { effort: 'high-effort' } },
                expect.objectContaining({ role: 'user' }),
                { type: 'configuration_update', reasoning: { effort: 'none' } },
                expect.objectContaining({ role: 'user' }),
            ])
        })

        it('updates the next tool continuation and replays the update before its assistant response', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low', model: reasoningModel.id, stopReason: 'tool_use', status: 'done', content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: {} }] },
                { id: 't1', sessionId: 's1', createdAt: 3, kind: 'toolResult', toolCallId: 'call_1|fc_1', content: [{ type: 'text', text: 'Result' }], isError: false },
                { id: 'a2', sessionId: 's1', createdAt: 4, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, stopReason: 'stop', status: 'done', content: [{ type: 'text', text: 'After tool' }] },
            ]
            const continuation = convertConversationToCodexInput(entries.slice(0, 3), reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            expect(continuation.map((item) => 'role' in item ? item.role : item.type)).toEqual([
                'user', 'function_call', 'function_call_output', 'configuration_update',
            ])
            expect(continuation.at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })

            const replay = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            expect(replay.slice(0, -1)).toEqual(continuation)
            expect(replay.at(-1)).toMatchObject({ role: 'assistant' })
        })

        it.each([
            { label: 'regular', pendingStatus: undefined },
            { label: 'steer', pendingStatus: 'steer' as const },
            { label: 'queue', pendingStatus: 'queue' as const },
        ])(
            'keeps the tool-continuation update when a $label user message follows',
            ({ pendingStatus }) => {
                const entries: ConversationEntry[] = [
                    { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                    { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low', model: reasoningModel.id, stopReason: 'tool_use', status: 'done', content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: {} }] },
                    { id: 't1', sessionId: 's1', createdAt: 3, kind: 'toolResult', toolCallId: 'call_1|fc_1', content: [{ type: 'text', text: 'Result' }], isError: false },
                    { id: 'a2', sessionId: 's1', createdAt: 4, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, stopReason: 'stop', status: 'done', content: [{ type: 'text', text: 'After tool' }] },
                    { id: 'u2', sessionId: 's1', createdAt: 5, kind: 'user', pendingStatus, reasoningEffort: 'high', content: [{ type: 'text', text: 'Next turn' }] },
                ]

                for (const history of [[...entries.slice(0, 3), entries[4]!], entries]) {
                    const input = convertConversationToCodexInput(history, reasoningModel, {
                        baseReasoningEffort: 'low', targetReasoningEffort: 'high',
                    })
                    const types = input.map((item) => 'role' in item ? item.role : item.type)
                    expect(types).toEqual([
                        'user', 'function_call', 'function_call_output', 'configuration_update',
                        ...(history.length === 5 ? ['assistant'] : []),
                        'user',
                    ])
                    expect(input[3]).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })
                    expect(input.at(-1)).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Next turn' }] })
                    expect(input.filter((item) => 'type' in item && item.type === 'configuration_update')).toHaveLength(1)
                }
            },
        )

        it('uses the assistant snapshot instead of a stale user snapshot without redundant updates', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, stopReason: 'stop', status: 'done', content: [{ type: 'text', text: 'Answer' }] },
                { id: 'u2', sessionId: 's1', createdAt: 3, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'Next turn' }] },
            ]
            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })

            expect(input.map((item) => 'role' in item ? item.role : item.type)).toEqual([
                'configuration_update', 'user', 'assistant', 'user',
            ])
            expect(input[0]).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })
        })

        it('does not undo a tool-continuation update for a stale queued user snapshot', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low', model: reasoningModel.id, status: 'done', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: {} }] },
                { id: 't1', sessionId: 's1', createdAt: 3, kind: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'read', content: [{ type: 'text', text: 'Result' }], isError: false },
                { id: 'a2', sessionId: 's1', createdAt: 4, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'After tool' }] },
                { id: 'u2', sessionId: 's1', createdAt: 5, kind: 'user', pendingStatus: 'queue', reasoningEffort: 'low', content: [{ type: 'text', text: 'Queued' }] },
            ]
            const toolRequest = convertConversationToCodexInput(entries.slice(0, 3), reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            const queuedRequest = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            expect(queuedRequest.slice(0, toolRequest.length)).toEqual(toolRequest)
            expect(queuedRequest.filter((item) => 'type' in item && item.type === 'configuration_update')).toEqual([
                { type: 'configuration_update', reasoning: { effort: 'high' } },
            ])
            expect(queuedRequest.at(-1)).toMatchObject({ role: 'user' })

            const replay = convertConversationToCodexInput([
                ...entries,
                { id: 'a3', sessionId: 's1', createdAt: 6, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Next' }] },
            ], reasoningModel, { baseReasoningEffort: 'low', targetReasoningEffort: 'high' })
            expect(replay.slice(0, queuedRequest.length)).toEqual(queuedRequest)
        })

        it('applies one effort to a batch of stale steers in the next model request', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'a1', sessionId: 's1', createdAt: 2, kind: 'assistant', reasoningEffort: 'low', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'First answer' }] },
                { id: 'u2', sessionId: 's1', createdAt: 3, kind: 'user', pendingStatus: 'steer', reasoningEffort: 'low', content: [{ type: 'text', text: 'Steer one' }] },
                { id: 'u3', sessionId: 's1', createdAt: 4, kind: 'user', pendingStatus: 'steer', reasoningEffort: 'low', content: [{ type: 'text', text: 'Steer two' }] },
            ]
            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            expect(input.map((item) => 'role' in item ? item.role : item.type)).toEqual([
                'user', 'assistant', 'configuration_update', 'user', 'user',
            ])
            expect(input[2]).toEqual({ type: 'configuration_update', reasoning: { effort: 'high' } })

            const replay = convertConversationToCodexInput([
                ...entries,
                { id: 'a2', sessionId: 's1', createdAt: 5, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'After steers' }] },
            ], reasoningModel, { baseReasoningEffort: 'low', targetReasoningEffort: 'high' })
            expect(replay.slice(0, input.length)).toEqual(input)
        })

        it('preserves the catalog requestValue case and avoids duplicate updates at the last user turn', () => {
            const model = { ...reasoningModel, reasoningLevels: [
                { id: 'low', requestValue: 'LowEffort' },
                { id: 'high', requestValue: 'HighEffort' },
            ] }
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
            ]
            const input = convertConversationToCodexInput(entries, model, {
                baseReasoningEffort: 'LowEffort', targetReasoningEffort: 'higheffort',
            })
            expect(input).toEqual([
                expect.objectContaining({ role: 'user' }),
                { type: 'configuration_update', reasoning: { effort: 'HighEffort' } },
                expect.objectContaining({ role: 'user' }),
            ])
        })

        it('refreshes the current effort on a request immediately after compaction without a new user', () => {
            const entries: ConversationEntry[] = [
                { id: 'u1', sessionId: 's1', createdAt: 1, kind: 'user', reasoningEffort: 'low', content: [{ type: 'text', text: 'First' }] },
                { id: 'u2', sessionId: 's1', createdAt: 2, kind: 'user', reasoningEffort: 'high', content: [{ type: 'text', text: 'Second' }] },
                { id: 'c1', sessionId: 's1', createdAt: 3, kind: 'compaction', summary: 'Earlier turns', firstKeptEntryId: 'u2' },
            ]
            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low', targetReasoningEffort: 'high',
            })
            expect(input.map((item) => 'role' in item ? item.role : item.type)).toEqual([
                'user', 'configuration_update', 'user', 'user', 'configuration_update',
            ])
            const replay = convertConversationToCodexInput([
                ...entries,
                { id: 'a1', sessionId: 's1', createdAt: 4, kind: 'assistant', reasoningEffort: 'high', model: reasoningModel.id, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] },
            ], reasoningModel, { baseReasoningEffort: 'low', targetReasoningEffort: 'high' })
            expect(replay.slice(0, input.length)).toEqual(input)
        })

        it('re-emits configuration_update after compaction if effort differs from base', () => {
            const entries: ConversationEntry[] = [
                {
                    id: 'c1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'compaction',
                    summary: 'Compacted history',
                    firstKeptEntryId: 'u2',
                },
                {
                    id: 'u2',
                    sessionId: 's1',
                    createdAt: 2,
                    kind: 'user',
                    reasoningEffort: 'high',
                    content: [{ type: 'text', text: 'Post-compaction prompt' }],
                },
            ]

            const input = convertConversationToCodexInput(entries, reasoningModel, {
                baseReasoningEffort: 'low',
                targetReasoningEffort: 'high',
            })

            const configUpdates = input.filter(
                (item) => (item as { type?: string }).type === 'configuration_update',
            )
            expect(configUpdates).toHaveLength(1)
            expect(configUpdates[0]).toEqual({
                type: 'configuration_update',
                reasoning: { effort: 'high' },
            })
        })
    })
})
