import { describe, expect, it } from 'vitest'
import { migrateLegacyMessages } from './migration'
import type { ConversationEntry } from './types'

describe('migrateLegacyMessages', () => {
    it('migrates a legacy tool result into a separate canonical entry', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: '',
                parts: [{
                    type: 'tool_call',
                    id: 'call_1|fc_1',
                    name: 'read',
                    args: { path: 'a.ts' },
                    status: 'done',
                    result: 'file text',
                }],
                createdAt: 1,
            },
        ])

        expect(entries.map((entry) => entry.kind)).toEqual(['assistant', 'toolResult'])
        expect(entries[1]).toMatchObject({
            toolCallId: 'call_1|fc_1',
            toolName: 'read',
            isError: false,
        })
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            id: 'a1',
            sessionId: 's1',
            content: [{
                type: 'toolCall',
                id: 'call_1|fc_1',
                name: 'read',
                arguments: { path: 'a.ts' },
            }],
        })
        expect(entries[1]).toMatchObject({
            id: 'tool-result:s1:call_1',
            content: [{ type: 'text', text: 'file text' }],
        })
    })

    it('normalizes streaming and running states to aborted', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'partial',
                status: 'streaming',
                parts: [
                    { type: 'text', text: 'partial' },
                    {
                        type: 'tool_call',
                        id: 't1',
                        name: 'bash',
                        args: { command: 'ls' },
                        status: 'running',
                    },
                    {
                        type: 'tool_call',
                        id: 't2',
                        name: 'read',
                        args: { path: 'x' },
                        status: 'awaiting_approval',
                    },
                ],
                createdAt: 10,
            },
        ])

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            status: 'aborted',
            stopReason: 'aborted',
        })
        const assistant = entries[0]
        if (assistant.kind !== 'assistant') {
            throw new Error('expected assistant entry')
        }
        expect(assistant.content).toEqual([
            { type: 'text', text: 'partial' },
            {
                type: 'toolCall',
                id: 't1',
                name: 'bash',
                arguments: { command: 'ls' },
            },
            {
                type: 'toolCall',
                id: 't2',
                name: 'read',
                arguments: { path: 'x' },
            },
        ])
    })

    it('returns an empty array for unknown or invalid input', () => {
        expect(migrateLegacyMessages('s1', null)).toEqual([])
        expect(migrateLegacyMessages('s1', undefined)).toEqual([])
        expect(migrateLegacyMessages('s1', 'not-an-array')).toEqual([])
        expect(migrateLegacyMessages('s1', { role: 'user' })).toEqual([])
        expect(migrateLegacyMessages('s1', [null, 42, 'x', { foo: 'bar' }])).toEqual([])
    })

    it('is idempotent for migrated and already-canonical entries', () => {
        const legacy = [
            {
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                content: 'hello',
                createdAt: 1,
            },
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: '',
                status: 'done',
                parts: [{
                    type: 'tool_call',
                    id: 'call_1',
                    name: 'read',
                    args: { path: 'a.ts' },
                    status: 'done',
                    result: 'file text',
                }],
                createdAt: 2,
            },
            {
                id: 'sys1',
                sessionId: 's1',
                role: 'system',
                content: 'you are helpful',
                createdAt: 0,
            },
        ]

        const once = migrateLegacyMessages('s1', legacy)
        const twice = migrateLegacyMessages('s1', once)
        expect(twice).toEqual(once)

        const canonical: ConversationEntry[] = [
            {
                id: 'u2',
                sessionId: 's1',
                createdAt: 3,
                kind: 'user',
                version: 1,
                content: [{ type: 'text', text: 'again' }],
            },
        ]
        expect(migrateLegacyMessages('s1', canonical)).toEqual(canonical)
    })

    it('converts legacy system messages into prefixed user entries', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'sys1',
                sessionId: 's1',
                role: 'system',
                content: 'remember the project root',
                createdAt: 5,
            },
        ])

        expect(entries).toEqual([
            {
                id: 'sys1',
                sessionId: 's1',
                createdAt: 5,
                kind: 'user',
                version: 1,
                content: [{
                    type: 'text',
                    text: '[Legacy system context]\nremember the project root',
                }],
            },
        ])
    })

    it('does not duplicate tool results already present as separate entries', () => {
        const assistantWithInlineResult = {
            id: 'a1',
            sessionId: 's1',
            role: 'assistant' as const,
            content: '',
            parts: [{
                type: 'tool_call' as const,
                id: 'call_1',
                name: 'read',
                args: { path: 'a.ts' },
                status: 'done' as const,
                result: 'file text',
            }],
            createdAt: 1,
        }

        const first = migrateLegacyMessages('s1', [assistantWithInlineResult])
        const second = migrateLegacyMessages('s1', first)
        const toolResults = second.filter((entry) => entry.kind === 'toolResult')
        expect(toolResults).toHaveLength(1)
        expect(toolResults[0]).toMatchObject({
            id: 'tool-result:s1:call_1',
            toolCallId: 'call_1',
        })
    })

    it('preserves valid usage from legacy assistant messages', () => {
        const usage = {
            input: 10,
            output: 20,
            cacheRead: 1,
            cacheWrite: 2,
            totalTokens: 33,
            cost: {
                input: 0.01,
                output: 0.02,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0.03,
            },
        }

        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'hello',
                status: 'done',
                usage,
                createdAt: 1,
            },
        ])

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            usage,
        })
    })

    it('aborts recovery when a tool part is still running even if assistant status is done', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: '',
                status: 'done',
                stopReason: 'pending',
                parts: [{
                    type: 'tool_call',
                    id: 't1',
                    name: 'bash',
                    args: { command: 'sleep 10' },
                    status: 'running',
                }],
                createdAt: 1,
            },
        ])

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            status: 'aborted',
            stopReason: 'aborted',
        })
    })

    it('aborts recovery when a tool part is awaiting approval and assistant has no status', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: '',
                stopReason: 'pending',
                parts: [{
                    type: 'tool_call',
                    id: 't2',
                    name: 'write',
                    args: { path: 'x' },
                    status: 'awaiting_approval',
                }],
                createdAt: 2,
            },
        ])

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            status: 'aborted',
            stopReason: 'aborted',
        })
    })

    it('keeps top-level assistant text when parts only contain tool calls', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'I will read the file',
                status: 'done',
                parts: [{
                    type: 'tool_call',
                    id: 'call_1',
                    name: 'read',
                    args: { path: 'a.ts' },
                    status: 'done',
                    result: 'file text',
                }],
                createdAt: 1,
            },
        ])

        const assistant = entries[0]
        if (assistant.kind !== 'assistant') {
            throw new Error('expected assistant entry')
        }
        expect(assistant.content).toEqual([
            { type: 'text', text: 'I will read the file' },
            {
                type: 'toolCall',
                id: 'call_1',
                name: 'read',
                arguments: { path: 'a.ts' },
            },
        ])
    })

    it('produces stable deterministic ids for missing message and tool ids', () => {
        const payload = [
            {
                role: 'user',
                content: 'hello from stable migration',
                createdAt: 11,
            },
            {
                role: 'assistant',
                content: '',
                createdAt: 12,
                parts: [{
                    type: 'tool_call',
                    name: 'read',
                    args: { path: 'stable.ts' },
                    status: 'done',
                    result: 'ok',
                }],
            },
        ]

        const first = migrateLegacyMessages('session-stable', payload)
        const second = migrateLegacyMessages('session-stable', payload)

        expect(first).toEqual(second)
        expect(first.map((entry) => entry.id)).toEqual(
            second.map((entry) => entry.id),
        )
        for (const entry of first) {
            expect(entry.id).toMatch(/^[a-z0-9:-]+$/i)
            expect(entry.id.includes('undefined')).toBe(false)
            expect(entry.id.length).toBeGreaterThan(0)
        }
        const assistant = first.find((entry) => entry.kind === 'assistant')
        if (!assistant || assistant.kind !== 'assistant') {
            throw new Error('expected assistant entry')
        }
        const toolCall = assistant.content.find((block) => block.type === 'toolCall')
        if (!toolCall || toolCall.type !== 'toolCall') {
            throw new Error('expected toolCall block')
        }
        expect(toolCall.id).toBeTruthy()
        const toolResult = first.find((entry) => entry.kind === 'toolResult')
        expect(toolResult).toMatchObject({
            toolCallId: toolCall.id,
            id: `tool-result:session-stable:${toolCall.id}`,
        })
    })

    it('does not throw and yields stable ids for cyclic legacy payloads without ids', () => {
        const cyclic: Record<string, unknown> = {
            role: 'user',
            content: 'cyclic payload',
            createdAt: 42,
        }
        cyclic.self = cyclic

        let first: ConversationEntry[] = []
        let second: ConversationEntry[] = []
        expect(() => {
            first = migrateLegacyMessages('session-cycle', [cyclic])
        }).not.toThrow()
        expect(() => {
            second = migrateLegacyMessages('session-cycle', [cyclic])
        }).not.toThrow()

        expect(first).toHaveLength(1)
        expect(first).toEqual(second)
        expect(first[0]).toMatchObject({
            kind: 'user',
            sessionId: 'session-cycle',
            content: [{ type: 'text', text: 'cyclic payload' }],
        })
        expect(first[0].id).toMatch(/^[a-z0-9:-]+$/i)
        expect(first[0].id.includes('undefined')).toBe(false)
    })

    it('does not throw and yields stable ids for extremely nested legacy payloads without ids', () => {
        // Build a chain deep enough to blow naive recursion without depth bounds.
        let nested: Record<string, unknown> = { leaf: 'end' }
        for (let i = 0; i < 5000; i += 1) {
            nested = { child: nested }
        }
        const payload = {
            role: 'user',
            content: 'deep payload',
            createdAt: 7,
            meta: nested,
        }

        let first: ConversationEntry[] = []
        let second: ConversationEntry[] = []
        expect(() => {
            first = migrateLegacyMessages('session-deep', [payload])
        }).not.toThrow()
        expect(() => {
            second = migrateLegacyMessages('session-deep', [payload])
        }).not.toThrow()

        expect(first).toHaveLength(1)
        expect(first).toEqual(second)
        expect(first[0]).toMatchObject({
            kind: 'user',
            sessionId: 'session-deep',
            content: [{ type: 'text', text: 'deep payload' }],
        })
        expect(first[0].id).toMatch(/^[a-z0-9:-]+$/i)
        expect(first[0].id.includes('undefined')).toBe(false)
    })

    it('preserves responseId and forces aborted stopReason/errorMessage on restart streaming', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'a1',
                sessionId: 's1',
                kind: 'assistant',
                version: 1,
                createdAt: 1,
                content: [{ type: 'text', text: 'partial' }],
                status: 'streaming',
                stopReason: 'pending',
                responseId: 'resp-keep',
            },
        ])
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            status: 'aborted',
            stopReason: 'aborted',
            responseId: 'resp-keep',
            errorMessage: 'Interrupted by session restart',
        })
    })

    it('live mode preserves streaming and does not abort', () => {
        const entries = migrateLegacyMessages(
            's1',
            [
                {
                    id: 'a1',
                    sessionId: 's1',
                    role: 'assistant',
                    content: 'partial',
                    status: 'streaming',
                    createdAt: 1,
                },
            ],
            { mode: 'live' },
        )
        expect(entries[0]).toMatchObject({
            kind: 'assistant',
            status: 'streaming',
            stopReason: 'pending',
        })
    })

    it('normalizes tool result ids and dedupes by normalized call_id first-wins', () => {
        const entries = migrateLegacyMessages('s1', [
            {
                id: 'old-1',
                sessionId: 's1',
                kind: 'toolResult',
                version: 1,
                createdAt: 1,
                toolCallId: 'call_1|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'first' }],
                isError: false,
            },
            {
                id: 'old-2',
                sessionId: 's1',
                kind: 'toolResult',
                version: 1,
                createdAt: 2,
                toolCallId: 'call_1|fc_b',
                toolName: 'read',
                content: [{ type: 'text', text: 'second' }],
                isError: false,
            },
        ])
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
            id: 'tool-result:s1:call_1',
            toolCallId: 'call_1|fc_a',
            content: [{ type: 'text', text: 'first' }],
        })
    })

    it('deep-clones canonical input so caller mutation cannot affect output', () => {
        const args = { path: 'a.ts' }
        const input = [
            {
                id: 'a1',
                sessionId: 's1',
                kind: 'assistant',
                version: 1,
                createdAt: 1,
                status: 'done',
                stopReason: 'stop',
                content: [
                    {
                        type: 'toolCall',
                        id: 't1',
                        name: 'read',
                        arguments: args,
                    },
                ],
            },
        ]
        const entries = migrateLegacyMessages('s1', input)
        args.path = 'mutated'
        const block = (entries[0] as { content: Array<{ arguments?: { path: string } }> })
            .content[0]
        expect(block.arguments?.path).toBe('a.ts')
    })
})
