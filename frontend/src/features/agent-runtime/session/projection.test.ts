import { describe, expect, it } from 'vitest'
import { projectConversation } from './projection'
import type { AssistantEntry, ConversationEntry } from './types'

describe('projectConversation', () => {
    it('projects user and assistant text into UI-consumable messages', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'u1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'user',
                content: [{ type: 'text', text: 'hello' }],
            },
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'assistant',
                content: [{ type: 'text', text: 'world' }],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        expect(projectConversation(entries)).toEqual([
            {
                kind: 'message',
                id: 'u1',
                sessionId: 's1',
                role: 'user',
                content: 'hello',
                parts: [{ type: 'text', text: 'hello' }],
                createdAt: 1,
            },
            {
                kind: 'message',
                id: 'a1',
                sessionId: 's1',
                role: 'assistant',
                content: 'world',
                parts: [{ type: 'text', text: 'world' }],
                status: 'done',
                createdAt: 2,
            },
        ])
    })

    it('associates adjacent tool results onto tool call cards', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    { type: 'text', text: 'reading' },
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
                id: 'a1:tool:call_1|fc_1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_1',
                toolName: 'read',
                content: [{ type: 'text', text: 'file text' }],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({
            kind: 'message',
            id: 'a1',
            role: 'assistant',
            content: 'reading',
            status: 'done',
            parts: [
                { type: 'text', text: 'reading' },
                {
                    type: 'tool_call',
                    id: 'call_1|fc_1',
                    name: 'read',
                    args: { path: 'a.ts' },
                    status: 'done',
                    result: 'file text',
                },
            ],
        })
    })

    it('does not emit standalone tool result bubbles', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'tr1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'toolResult',
                toolCallId: 'orphan',
                toolName: 'read',
                content: [{ type: 'text', text: 'should not bubble' }],
                isError: false,
            },
        ]

        expect(projectConversation(entries)).toEqual([])
    })

    it('projects compaction entries as separator items without copying summary text', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'c1',
                sessionId: 's1',
                createdAt: 3,
                kind: 'compaction',
                summary: 'long summary that must not become assistant text',
                firstKeptEntryId: 'a9',
                tokensBefore: 12000,
            },
            {
                id: 'a9',
                sessionId: 's1',
                createdAt: 4,
                kind: 'assistant',
                content: [{ type: 'text', text: 'after compact' }],
                status: 'done',
                stopReason: 'stop',
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toEqual([
            {
                kind: 'compaction',
                id: 'c1',
                sessionId: 's1',
                createdAt: 3,
                firstKeptEntryId: 'a9',
            },
            {
                kind: 'message',
                id: 'a9',
                sessionId: 's1',
                role: 'assistant',
                content: 'after compact',
                parts: [{ type: 'text', text: 'after compact' }],
                status: 'done',
                createdAt: 4,
            },
        ])
        expect(JSON.stringify(projected)).not.toContain(
            'long summary that must not become assistant text',
        )
    })

    it('marks errored tool results on the associated tool card', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [{
                    type: 'toolCall',
                    id: 't1',
                    name: 'bash',
                    arguments: { command: 'nope' },
                }],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'a1:tool:t1',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 't1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'permission denied' }],
                isError: true,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected[0]).toMatchObject({
            kind: 'message',
            parts: [{
                type: 'tool_call',
                id: 't1',
                status: 'error',
                result: 'permission denied',
                isError: true,
            }],
        })
    })

    it('deep-clones tool args so display mutation cannot touch source entries', () => {
        const args = { path: 'src/a.ts' }
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 't1',
                        name: 'read',
                        arguments: args,
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            } satisfies AssistantEntry,
        ]
        const projected = projectConversation(entries)
        const part = projected[0]
        if (part.kind !== 'message') throw new Error('expected message')
        const tool = part.parts?.find((p) => p.type === 'tool_call')
        if (!tool || tool.type !== 'tool_call') throw new Error('expected tool')
        tool.args.path = 'mutated'
        expect(args.path).toBe('src/a.ts')
        expect(
            (entries[0] as AssistantEntry).content.find((b) => b.type === 'toolCall')
                ?.arguments,
        ).toEqual({ path: 'src/a.ts' })
    })

    it('associates tool results by normalized call_id first-wins on conflicting raw ids', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'tr-first',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_first',
                toolName: 'read',
                content: [{ type: 'text', text: 'first-wins' }],
                isError: false,
            },
            {
                id: 'tr-second',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_second',
                toolName: 'read',
                content: [{ type: 'text', text: 'should-not-overwrite' }],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({
            kind: 'message',
            parts: [
                {
                    type: 'tool_call',
                    id: 'call_1|fc_a',
                    result: 'first-wins',
                },
            ],
        })
    })

    it('normalized first-wins: first raw call_1 beats later call_1|fc_a for assistant call_1|fc_a', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'tr-first',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1',
                toolName: 'read',
                content: [{ type: 'text', text: 'first-raw' }],
                isError: false,
            },
            {
                id: 'tr-later',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'later-suffix' }],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({
            kind: 'message',
            parts: [
                {
                    type: 'tool_call',
                    id: 'call_1|fc_a',
                    result: 'first-raw',
                },
            ],
        })
    })

    it('normalized first-wins: first call_1|fc_a beats later raw call_1 for assistant call_1', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'tr-first',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_1|fc_a',
                toolName: 'read',
                content: [{ type: 'text', text: 'first-suffix' }],
                isError: false,
            },
            {
                id: 'tr-later',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'call_1',
                toolName: 'read',
                content: [{ type: 'text', text: 'later-raw' }],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({
            kind: 'message',
            parts: [
                {
                    type: 'tool_call',
                    id: 'call_1',
                    result: 'first-suffix',
                },
            ],
        })
    })

    it('projects ToolResult image blocks onto tool_call.resultImages (defensive copy)', () => {
        const imageBlock = { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' }
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_img|fc',
                        name: 'read',
                        arguments: { path: 'diagram.png' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'tr-img',
                sessionId: 's1',
                createdAt: 2,
                kind: 'toolResult',
                toolCallId: 'call_img|fc',
                toolName: 'read',
                content: [
                    { type: 'text', text: 'diagram' },
                    imageBlock,
                ],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        const part = (projected[0] as { parts?: Array<Record<string, unknown>> }).parts?.[0]
        expect(part).toMatchObject({
            type: 'tool_call',
            result: 'diagram',
            resultImages: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
        })
        const images = part?.resultImages as Array<{ data: string }>
        images[0].data = 'mutated'
        expect(imageBlock.data).toBe('iVBORw0KGgo=')
    })

    it('marks tool calls without results as queued when assistant is stable', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'pending',
                        name: 'bash',
                        arguments: { command: 'ls' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
        ]
        const projected = projectConversation(entries)
        expect(projected[0]).toMatchObject({
            parts: [{ type: 'tool_call', status: 'queued' }],
        })
    })

    it('projects errorMessage from assistant entry into display message', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a-err',
                sessionId: 's1',
                createdAt: 1,
                kind: 'assistant',
                content: [],
                status: 'error',
                stopReason: 'error',
                errorMessage: 'Network connection lost',
            },
        ]
        const projected = projectConversation(entries)
        expect(projected).toEqual([
            {
                kind: 'message',
                id: 'a-err',
                sessionId: 's1',
                role: 'assistant',
                content: '',
                parts: [],
                status: 'error',
                errorMessage: 'Network connection lost',
                createdAt: 1,
            },
        ])
    })

    it('projects pausedMs from user and assistant entries into display messages', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'u-paused',
                sessionId: 's1',
                createdAt: 1000,
                kind: 'user',
                content: [{ type: 'text', text: 'Hello' }],
                pausedMs: 5000,
            },
            {
                id: 'a-paused',
                sessionId: 's1',
                createdAt: 1000,
                completedAt: 9000,
                kind: 'assistant',
                content: [{ type: 'text', text: 'Hi' }],
                status: 'done',
                stopReason: 'stop',
                pausedMs: 5000,
            },
        ]
        const projected = projectConversation(entries)
        expect(projected[0]).toMatchObject({
            id: 'u-paused',
            pausedMs: 5000,
        })
        expect(projected[1]).toMatchObject({
            id: 'a-paused',
            pausedMs: 5000,
        })
    })

    it('includes tool result completion times in projected assistant completedAt', () => {
        const entries: ConversationEntry[] = [
            {
                id: 'a-tool',
                sessionId: 's1',
                createdAt: 1000,
                completedAt: 3000, // LLM request completed in 2s
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call-bash',
                        name: 'bash',
                        arguments: { command: 'sleep 60' },
                    },
                ],
                status: 'done',
                stopReason: 'toolUse',
            },
            {
                id: 'tr-bash',
                sessionId: 's1',
                createdAt: 63000, // Tool completed 60s later at t=63000
                kind: 'toolResult',
                toolCallId: 'call-bash',
                toolName: 'bash',
                content: [{ type: 'text', text: 'done' }],
                isError: false,
            },
        ]

        const projected = projectConversation(entries)
        expect(projected).toHaveLength(1)
        // completedAt must be 63000 (incorporating tool duration), not 3000!
        expect((projected[0] as any).completedAt).toBe(63000)
    })
})
