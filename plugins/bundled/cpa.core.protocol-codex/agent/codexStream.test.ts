import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AssistantEntry, AssistantStreamEvent } from '@cpa/plugin-api'
import { parseCodexEvents } from './codexStream'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadFixture(name: string): unknown[] {
    const raw = readFileSync(join(fixturesDir, name), 'utf8')
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('//'))
        .map((line) => JSON.parse(line) as unknown)
}

async function* asAsync<T>(items: readonly T[]): AsyncGenerator<T> {
    for (const item of items) {
        yield item
    }
}

async function collect(
    gen: AsyncGenerator<AssistantStreamEvent, AssistantEntry>,
): Promise<{ events: AssistantStreamEvent[]; result?: AssistantEntry; error?: unknown }> {
    const events: AssistantStreamEvent[] = []
    try {
        while (true) {
            const next = await gen.next()
            if (next.done) {
                return { events, result: next.value }
            }
            events.push(next.value)
        }
    } catch (error) {
        return { events, error }
    }
}

function seedAssistant(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
    return {
        id: 'asst_seed',
        sessionId: 'session-1',
        createdAt: 1,
        kind: 'assistant',
        model: 'gpt-test',
        content: [],
        status: 'streaming',
        stopReason: 'pending',
        ...overrides,
    }
}

describe('parseCodexEvents', () => {
    it('streams text deltas and writes usage/responseId/signatures', async () => {
        const { events, result, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('text-complete.jsonl')), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(events[0]).toMatchObject({ type: 'start' })
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'text-delta',
                delta: 'Hello',
            }),
        )
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'text-end',
                content: 'Hello world',
            }),
        )
        expect(events[events.length - 1]).toMatchObject({
            type: 'done',
            reason: 'stop',
        })
        expect(result?.responseId).toBe('resp_text_1')
        expect(result?.status).toBe('done')
        expect(result?.stopReason).toBe('stop')
        expect(result?.usage).toEqual({
            input: 8,
            output: 4,
            cacheRead: 2,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 14,
            costKnown: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        })
        const text = result?.content.find((b) => b.type === 'text')
        expect(text).toMatchObject({
            type: 'text',
            text: 'Hello world',
            signature: JSON.stringify({ v: 1, id: 'msg_1', phase: 'final_answer' }),
        })
        // Scratch partialJson must never remain on content blocks.
        for (const block of result?.content ?? []) {
            expect(block).not.toHaveProperty('partialJson')
        }
    })

    it('streams thinking summary deltas and persists reasoning signature', async () => {
        const { events, result, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('thinking-complete.jsonl')), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'thinking-delta', delta: 'Step one' }),
        )
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'thinking-delta', delta: '\n\n' }),
        )
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'thinking-end', content: 'Step one\n\nStep two' }),
        )
        const thinking = result?.content.find((b) => b.type === 'thinking')
        expect(thinking?.type).toBe('thinking')
        if (thinking?.type === 'thinking') {
            expect(thinking.thinking).toBe('Step one\n\nStep two')
            expect(thinking.signature).toContain('"type":"reasoning"')
            expect(thinking.signature).toContain('"id":"rs_1"')
            expect(thinking.signature).toContain('"encrypted_content":"enc-1"')
        }
        expect(result?.usage?.reasoning).toBe(5)
        expect(result?.stopReason).toBe('stop')
    })

    it('streams fragmented tool arguments and finalizes call ids', async () => {
        const { events, result, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('tool-call.jsonl')), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'toolcall-delta',
                delta: '{"path":',
            }),
        )
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'toolcall-end',
                toolCall: {
                    type: 'toolCall',
                    id: 'call_1|fc_1',
                    name: 'read',
                    arguments: { path: 'src/main.ts' },
                },
            }),
        )
        expect(result?.stopReason).toBe('toolUse')
        const tool = result?.content.find((b) => b.type === 'toolCall')
        expect(tool).toEqual({
            type: 'toolCall',
            id: 'call_1|fc_1',
            name: 'read',
            arguments: { path: 'src/main.ts' },
        })
        expect(tool).not.toHaveProperty('partialJson')
    })

    it('streams two tool calls with distinct composite ids', async () => {
        const { result, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('two-tools.jsonl')), seedAssistant()),
        )
        expect(error).toBeUndefined()
        const tools = (result?.content ?? []).filter((b) => b.type === 'toolCall')
        expect(tools).toEqual([
            {
                type: 'toolCall',
                id: 'call_a|fc_a',
                name: 'read',
                arguments: { path: 'a.ts' },
            },
            {
                type: 'toolCall',
                id: 'call_b|fc_b',
                name: 'write',
                arguments: { path: 'b.ts', content: 'x' },
            },
        ])
        expect(result?.stopReason).toBe('toolUse')
        expect(result?.usage?.cacheRead).toBe(1)
        expect(result?.usage?.input).toBe(14)
    })

    it('maps incomplete terminal to length stop reason', async () => {
        const { events, result, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('incomplete.jsonl')), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'length' })
        expect(result?.stopReason).toBe('length')
        expect(result?.status).toBe('done')
        expect(result?.responseId).toBe('resp_inc_1')
    })

    it('throws on failed terminal and cleans partial state', async () => {
        const seed = seedAssistant()
        const { events, error } = await collect(
            parseCodexEvents(asAsync(loadFixture('failed.jsonl')), seed),
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toMatch(/upstream failed|server_error/)
        expect(events.some((e) => e.type === 'done')).toBe(false)
        for (const block of seed.content) {
            expect(block).not.toHaveProperty('partialJson')
        }
        expect(seed.status).toBe('error')
        expect(seed.stopReason).toBe('error')
    })

    it('throws on protocol error events', async () => {
        const { error } = await collect(
            parseCodexEvents(asAsync(loadFixture('error-event.jsonl')), seedAssistant()),
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toMatch(/bad payload|invalid_request/)
    })

    it('rejects non-object final tool arguments', async () => {
        const seed = seedAssistant()
        const { error } = await collect(
            parseCodexEvents(asAsync(loadFixture('invalid-json-tool.jsonl')), seed),
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toMatch(/strict JSON object|Invalid tool call arguments/i)
        for (const block of seed.content) {
            expect(block).not.toHaveProperty('partialJson')
        }
    })

    it('throws when stream ends before response.completed', async () => {
        const { error } = await collect(
            parseCodexEvents(
                asAsync(loadFixture('close-before-completion.jsonl')),
                seedAssistant(),
            ),
        )
        expect(error).toBeInstanceOf(Error)
        expect(String(error)).toContain('Codex stream closed before response.completed')
    })

    it('falls back to accumulated partialJson when final item.arguments is empty string', async () => {
        const events = [
            {
                type: 'response.created',
                response: { id: 'resp_empty_args', status: 'in_progress' },
            },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    type: 'function_call',
                    id: 'fc_empty',
                    call_id: 'call_empty',
                    name: 'read',
                    arguments: '',
                },
            },
            {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                delta: '{"path":"via-partial"}',
            },
            {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'function_call',
                    id: 'fc_empty',
                    call_id: 'call_empty',
                    name: 'read',
                    arguments: '',
                },
            },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_empty_args',
                    status: 'completed',
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                    },
                },
            },
        ]
        const { events: streamEvents, result, error } = await collect(
            parseCodexEvents(asAsync(events), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(streamEvents).toContainEqual(
            expect.objectContaining({
                type: 'toolcall-end',
                toolCall: {
                    type: 'toolCall',
                    id: 'call_empty|fc_empty',
                    name: 'read',
                    arguments: { path: 'via-partial' },
                },
            }),
        )
        expect(result?.stopReason).toBe('toolUse')
    })

    it('collects terminal response.output wire items with output_item.done fallback', async () => {
        const doneItem = {
            type: 'message',
            id: 'msg_wire',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'from-done', annotations: [] }],
        }
        const withoutOutput = [
            { type: 'response.created', response: { id: 'resp_no_out', status: 'in_progress' } },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'message', id: 'msg_wire', role: 'assistant', status: 'in_progress', content: [] },
            },
            { type: 'response.output_text.delta', output_index: 0, delta: 'from-done' },
            { type: 'response.output_item.done', output_index: 0, item: doneItem },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_no_out',
                    status: 'completed',
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
        let collected: unknown[] | undefined
        const first = await collect(
            parseCodexEvents(asAsync(withoutOutput), seedAssistant(), {
                onTerminal: (meta) => {
                    collected = meta.responseOutput
                },
            }),
        )
        expect(first.error).toBeUndefined()
        expect(collected).toEqual([doneItem])

        const wireOutput = [
            {
                type: 'message',
                id: 'msg_out',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'from-output', annotations: [] }],
            },
        ]
        collected = undefined
        const withOutput = [
            { type: 'response.created', response: { id: 'resp_out', status: 'in_progress' } },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: { type: 'message', id: 'msg_out', role: 'assistant', status: 'in_progress', content: [] },
            },
            { type: 'response.output_text.delta', output_index: 0, delta: 'from-output' },
            {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'message',
                    id: 'msg_out',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'from-output', annotations: [] }],
                },
            },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_out',
                    status: 'completed',
                    output: wireOutput,
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
        const second = await collect(
            parseCodexEvents(asAsync(withOutput), seedAssistant(), {
                onTerminal: (meta) => {
                    collected = meta.responseOutput
                },
            }),
        )
        expect(second.error).toBeUndefined()
        expect(collected).toEqual(wireOutput)
        // Collector receives a copy; mutating source must not alter captured baseline.
        wireOutput.push({
            type: 'message',
            id: 'msg_mut',
            role: 'assistant',
            status: 'completed',
            content: [],
        })
        expect(collected).toHaveLength(1)
    })

    it('preserves native web search items and citations from done and completed outputs', async () => {
        const doneSearch = {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'in_progress',
            action: { type: 'search', query: 'news' },
        }
        const finalSearch = {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: { type: 'search', query: 'news', sources: [{ url: 'https://example.test' }] },
            results: [{ title: 'Claude result', url: 'https://example.test' }],
        }
        const citation = {
            type: 'url_citation',
            url: 'https://example.test',
            title: 'Example',
        }
        const claudeCitation = {
            type: 'web_search_result_location',
            url: 'https://claude.test',
        }
        const wireEvents = [
            { type: 'response.created', response: { id: 'resp_search', status: 'in_progress' } },
            { type: 'response.output_item.done', output_index: 0, item: doneSearch },
            { type: 'response.output_text.annotation.added', annotation: claudeCitation },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_search',
                    status: 'completed',
                    output: [
                        finalSearch,
                        {
                            type: 'message',
                            id: 'msg_search',
                            role: 'assistant',
                            status: 'completed',
                            content: [{ type: 'output_text', text: 'answer', annotations: [citation] }],
                        },
                    ],
                    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
                },
            },
        ]

        const { result, error } = await collect(
            parseCodexEvents(asAsync(wireEvents), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(result?.nativeToolCalls).toEqual([finalSearch])
        expect(result?.annotations).toEqual([claudeCitation, citation])
        expect(result?.content.some((block) => block.type === 'toolCall')).toBe(false)
    })

    it('preserves accumulated text when message output_item.done omits content', async () => {
        const events = [
            {
                type: 'response.created',
                response: { id: 'resp_missing_content', status: 'in_progress' },
            },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    type: 'message',
                    id: 'msg_acc',
                    role: 'assistant',
                    status: 'in_progress',
                    content: [],
                },
            },
            {
                type: 'response.output_text.delta',
                output_index: 0,
                delta: 'accumulated',
            },
            {
                type: 'response.output_text.delta',
                output_index: 0,
                delta: ' text',
            },
            {
                type: 'response.output_item.done',
                output_index: 0,
                // content intentionally omitted — must not wipe deltas with ''.
                item: {
                    type: 'message',
                    id: 'msg_acc',
                    role: 'assistant',
                    status: 'completed',
                    phase: 'final_answer',
                },
            },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_missing_content',
                    status: 'completed',
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
        const { events: streamEvents, result, error } = await collect(
            parseCodexEvents(asAsync(events), seedAssistant()),
        )
        expect(error).toBeUndefined()
        expect(streamEvents).toContainEqual(
            expect.objectContaining({
                type: 'text-end',
                content: 'accumulated text',
            }),
        )
        const text = result?.content.find((b) => b.type === 'text')
        expect(text).toMatchObject({
            type: 'text',
            text: 'accumulated text',
        })
    })

    it('hydrates terminal-only findings and does not duplicate finalized text', async () => {
        const message = { id: 'msg-B', type: 'message', content: [{ type: 'output_text', text: 'Final findings' }] }
        const search = { id: 'ws-B', type: 'web_search_call', status: 'completed' }
        for (const streamed of [false, true]) {
            const wire = [
                ...(streamed ? [{ type: 'response.output_item.done', output_index: 1, item: message }] : []),
                { type: 'response.completed', response: { status: 'completed', output: [search, message] } },
            ]
            const { result, error } = await collect(parseCodexEvents(asAsync(wire), seedAssistant()))
            expect(error).toBeUndefined()
            expect(result?.content.filter((block) => block.type === 'text')).toEqual([expect.objectContaining({ text: 'Final findings' })])
            expect(result?.nativeToolCalls).toEqual([search])
        }
    })

    it('retains native evidence without an output index and preserves failed-response usage', async () => {
        const seed = seedAssistant()
        const search = { id: 'ws-B', type: 'web_search_call', status: 'failed' }
        await collect(parseCodexEvents(asAsync([
            { type: 'response.output_item.done', item: search },
            { type: 'response.failed', response: { status: 'failed', error: { message: 'failed' }, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
        ]), seed))
        expect(seed.nativeToolCalls).toEqual([search])
        expect(seed.usage?.totalTokens).toBe(5)
    })

    it('rejects excessive response metadata rather than unbounded citation processing', async () => {
        const annotations = Array.from({ length: 257 }, (_, i) => ({ type: 'url_citation', url: `https://example.org/${i}` }))
        const seed = seedAssistant()
        await collect(parseCodexEvents(asAsync([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'text', annotations }] }] } }]), seed))
        expect(seed.status).toBe('error')
        expect(seed.errorMessage).toContain('annotation limit')
    })

    it('preserves reasoning deltas when output_item.done omits summary/content fields', async () => {
        const events = [
            {
                type: 'response.created',
                response: { id: 'resp_rs_missing', status: 'in_progress' },
            },
            {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                    type: 'reasoning',
                    id: 'rs_1',
                    summary: [],
                },
            },
            {
                type: 'response.reasoning_summary_text.delta',
                output_index: 0,
                delta: 'think-delta',
            },
            {
                type: 'response.output_item.done',
                output_index: 0,
                item: {
                    type: 'reasoning',
                    id: 'rs_1',
                    // summary/content omitted — keep accumulated thinking
                },
            },
            {
                type: 'response.completed',
                response: {
                    id: 'resp_rs_missing',
                    status: 'completed',
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            },
        ]
        const { result, error } = await collect(
            parseCodexEvents(asAsync(events), seedAssistant()),
        )
        expect(error).toBeUndefined()
        const thinking = result?.content.find((b) => b.type === 'thinking')
        expect(thinking).toMatchObject({
            type: 'thinking',
            thinking: 'think-delta',
        })
    })
})
