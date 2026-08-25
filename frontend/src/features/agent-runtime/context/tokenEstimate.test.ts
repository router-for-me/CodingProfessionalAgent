import { describe, expect, it } from 'vitest'
import type {
    AssistantEntry,
    CompactionEntry,
    ConversationEntry,
    ToolResultEntry,
    Usage,
    UserEntry,
} from '../session/types'
import {
    DEFAULT_COMPACTION_SETTINGS,
    DEFAULT_CONTEXT_WINDOW,
    ESTIMATED_IMAGE_CHARS,
    calculateContextTokens,
    estimateContextTokens,
    estimateTokens,
    isTrustedAssistantUsage,
    normalizeCompactionSettings,
    resolveContextWindow,
    safeJsonStringify,
    shouldCompact,
} from './tokenEstimate'

function usage(partial: Partial<Usage> & { totalTokens: number }): Usage {
    return {
        input: partial.input ?? 0,
        output: partial.output ?? 0,
        cacheRead: partial.cacheRead ?? 0,
        cacheWrite: partial.cacheWrite ?? 0,
        totalTokens: partial.totalTokens,
        cost: partial.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
        ...(partial.reasoning !== undefined ? { reasoning: partial.reasoning } : {}),
    }
}

function user(id: string, text: string, extras: Partial<UserEntry> = {}): UserEntry {
    return {
        id,
        sessionId: 's1',
        createdAt: 1,
        kind: 'user',
        content: [{ type: 'text', text }],
        ...extras,
    }
}

function assistant(
    id: string,
    text: string,
    overrides: Partial<AssistantEntry> = {},
): AssistantEntry {
    return {
        id,
        sessionId: 's1',
        createdAt: 2,
        kind: 'assistant',
        content: text ? [{ type: 'text', text }] : [],
        status: 'done',
        stopReason: 'stop',
        ...overrides,
    }
}

describe('safeJsonStringify', () => {
    it('stringifies plain objects and falls back for cycles and BigInt without throwing', () => {
        expect(safeJsonStringify({ a: 1 })).toBe('{"a":1}')
        expect(safeJsonStringify(10n)).toBe('"10n"')

        const cyclic: Record<string, unknown> = { a: 1 }
        cyclic.self = cyclic
        expect(() => safeJsonStringify(cyclic)).not.toThrow()
        expect(safeJsonStringify(cyclic)).toContain('[Circular]')
    })
})

describe('estimateTokens', () => {
    it('estimates user text and images at 4800 chars each', () => {
        const textOnly = user('u1', 'abcd') // 4 chars -> 1 token
        expect(estimateTokens(textOnly)).toBe(1)

        const withImage: UserEntry = {
            ...user('u2', 'hi'),
            content: [
                { type: 'text', text: 'hi' },
                { type: 'image', data: 'abc', mimeType: 'image/png' },
            ],
        }
        expect(estimateTokens(withImage)).toBe(Math.ceil((2 + ESTIMATED_IMAGE_CHARS) / 4))
    })

    it('counts assistant text, thinking, and safe tool name+args JSON', () => {
        const entry = assistant('a1', '', {
            content: [
                { type: 'text', text: 'hello' },
                { type: 'thinking', thinking: 'hmm' },
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'read',
                    arguments: { path: 'a.ts' },
                },
            ],
        })
        const expectedChars =
            'hello'.length +
            'hmm'.length +
            'read'.length +
            safeJsonStringify({ path: 'a.ts' }).length
        expect(estimateTokens(entry)).toBe(Math.ceil(expectedChars / 4))
    })

    it('does not throw on cyclic or BigInt tool args', () => {
        const cyclic: Record<string, unknown> = { path: 'x' }
        cyclic.self = cyclic
        const entry = assistant('a1', '', {
            content: [
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'write',
                    arguments: cyclic,
                },
            ],
        })
        expect(() => estimateTokens(entry)).not.toThrow()
        expect(estimateTokens(entry)).toBeGreaterThan(0)

        const bigIntEntry = assistant('a2', '', {
            content: [
                {
                    type: 'toolCall',
                    id: 'c2',
                    name: 'bash',
                    arguments: { n: 1n as unknown as number },
                },
            ],
        })
        expect(() => estimateTokens(bigIntEntry)).not.toThrow()
    })

    it('estimates tool results (text+image) and compaction summaries', () => {
        const tool: ToolResultEntry = {
            id: 't1',
            sessionId: 's1',
            createdAt: 3,
            kind: 'toolResult',
            toolCallId: 'c1',
            toolName: 'read',
            content: [
                { type: 'text', text: '12345678' },
                { type: 'image', data: 'x', mimeType: 'image/png' },
            ],
            isError: false,
        }
        expect(estimateTokens(tool)).toBe(Math.ceil((8 + ESTIMATED_IMAGE_CHARS) / 4))

        const compaction: CompactionEntry = {
            id: 'c1',
            sessionId: 's1',
            createdAt: 0,
            kind: 'compaction',
            summary: 'abcdefgh',
            firstKeptEntryId: 'u1',
        }
        expect(estimateTokens(compaction)).toBe(2)
    })
})

describe('estimateContextTokens', () => {
    it('uses the latest trusted done assistant usage baseline and estimates trailing entries', () => {
        const entries: ConversationEntry[] = [
            user('u1', 'hello world'),
            assistant('a1', 'reply', {
                usage: usage({ input: 100, output: 20, totalTokens: 1000 }),
            }),
            user('u2', 'abcd'), // 1 token trailing
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 4,
                kind: 'toolResult',
                toolCallId: 'c1',
                toolName: 'read',
                content: [{ type: 'text', text: 'wxyz' }], // 1 token
                isError: false,
            },
        ]

        const result = estimateContextTokens(entries)
        expect(result.index).toBe(1)
        expect(result.usage).toBe(1000)
        expect(result.trailing).toBe(estimateTokens(entries[2]!) + estimateTokens(entries[3]!))
        expect(result.tokens).toBe(1000 + result.trailing)
    })

    it('ignores error, aborted, streaming, pending, all-zero, and NaN usage baselines', () => {
        const entries: ConversationEntry[] = [
            assistant('a-error', 'x', {
                status: 'error',
                stopReason: 'error',
                usage: usage({ totalTokens: 9999 }),
            }),
            assistant('a-aborted', 'x', {
                status: 'aborted',
                stopReason: 'aborted',
                usage: usage({ totalTokens: 8888 }),
            }),
            assistant('a-stream', 'x', {
                status: 'streaming',
                stopReason: 'pending',
                usage: usage({ totalTokens: 7777 }),
            }),
            assistant('a-zero', 'x', {
                usage: usage({ totalTokens: 0, input: 0, output: 0 }),
            }),
            assistant('a-nan', 'x', {
                usage: usage({
                    totalTokens: Number.NaN,
                    input: Number.NaN,
                    output: 10,
                }),
            }),
            user('u1', 'abcd'),
        ]

        const result = estimateContextTokens(entries)
        expect(result.index).toBeNull()
        expect(result.usage).toBe(0)
        expect(result.tokens).toBe(result.trailing)
        expect(result.tokens).toBe(
            entries.reduce((sum, entry) => sum + estimateTokens(entry), 0),
        )
    })

    it('prefers the most recent trusted baseline when older ones exist', () => {
        const entries: ConversationEntry[] = [
            assistant('a1', 'old', {
                usage: usage({ totalTokens: 100 }),
            }),
            user('u1', 'mid'),
            assistant('a2', 'new', {
                usage: usage({ totalTokens: 500 }),
            }),
            user('u2', 'ab'), // 1 token
        ]
        const result = estimateContextTokens(entries)
        expect(result.index).toBe(2)
        expect(result.usage).toBe(500)
        expect(result.trailing).toBe(1)
        expect(result.tokens).toBe(501)
    })

    it('uses totalTokens when positive even if component sum differs', () => {
        const u = usage({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 42 })
        expect(calculateContextTokens(u)).toBe(42)
    })

    it('does not trust totalTokens=0 even when components are non-zero', () => {
        const entry = assistant('a-zero-total', 'x', {
            usage: usage({ totalTokens: 0, input: 100, output: 50 }),
        })
        expect(isTrustedAssistantUsage(entry)).toBe(false)
        const result = estimateContextTokens([entry, user('u1', 'abcd')])
        expect(result.index).toBeNull()
        expect(result.usage).toBe(0)
    })

    it('after latest compaction only trusts post-marker assistants; otherwise full-estimates summary+tail', () => {
        const retained = assistant('a-retained', 'old', {
            usage: usage({ totalTokens: 9_999 }),
        })
        const marker: CompactionEntry = {
            id: 'c1',
            sessionId: 's1',
            createdAt: 1,
            kind: 'compaction',
            summary: 'S'.repeat(40),
            firstKeptEntryId: 'a-retained',
        }
        // Cycle 1: marker + retained only, no post-marker assistant → full estimate of summary+tail.
        const cycle1: ConversationEntry[] = [user('u0', 'ancient'), retained, marker]
        const est1 = estimateContextTokens(cycle1)
        expect(est1.index).toBeNull()
        expect(est1.usage).toBe(0)
        expect(est1.tokens).toBe(
            estimateTokens(marker) + estimateTokens(retained),
        )

        // Cycle 2: post-marker assistant usage is trusted and covers compacted context.
        const post = assistant('a-post', 'new', {
            usage: usage({ totalTokens: 500 }),
        })
        const trailing = user('u-trail', 'ab') // 1 token
        const cycle2: ConversationEntry[] = [
            user('u0', 'ancient'),
            retained,
            marker,
            post,
            trailing,
        ]
        const est2 = estimateContextTokens(cycle2)
        expect(est2.index).toBe(3)
        expect(est2.usage).toBe(500)
        expect(est2.trailing).toBe(1)
        expect(est2.tokens).toBe(501)
    })
})

describe('isTrustedAssistantUsage / shouldCompact', () => {
    it('rejects non-done or bad stop reasons', () => {
        expect(
            isTrustedAssistantUsage(
                assistant('a', 'x', {
                    status: 'done',
                    stopReason: 'stop',
                    usage: usage({ totalTokens: 10 }),
                }),
            ),
        ).toBe(true)
        expect(
            isTrustedAssistantUsage(
                assistant('a', 'x', {
                    status: 'done',
                    stopReason: 'error',
                    usage: usage({ totalTokens: 10 }),
                }),
            ),
        ).toBe(false)
    })

    it('triggers only when contextTokens strictly exceeds window * thresholdRatio', () => {
        expect(
            shouldCompact(121_601, 128_000, {
                enabled: true,
                reserveTokens: 16_384,
                keepRecentTokens: 20_000,
                thresholdRatio: 0.95,
            }),
        ).toBe(true)

        // Equality must not trigger (strict >).
        const threshold = 128_000 * DEFAULT_COMPACTION_SETTINGS.thresholdRatio
        expect(
            shouldCompact(threshold, 128_000, DEFAULT_COMPACTION_SETTINGS),
        ).toBe(false)
        expect(
            shouldCompact(threshold + 1, 128_000, DEFAULT_COMPACTION_SETTINGS),
        ).toBe(true)
    })

    it('falls back contextWindow and respects enabled=false / insane settings', () => {
        expect(resolveContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW)
        expect(resolveContextWindow(0)).toBe(DEFAULT_CONTEXT_WINDOW)
        expect(resolveContextWindow(-1)).toBe(DEFAULT_CONTEXT_WINDOW)
        expect(resolveContextWindow(Number.NaN)).toBe(DEFAULT_CONTEXT_WINDOW)
        expect(resolveContextWindow(64_000)).toBe(64_000)

        expect(
            shouldCompact(200_000, undefined, { enabled: false, reserveTokens: 1 }),
        ).toBe(false)

        // Non-positive reserve falls back to default reserve.
        const normalized = normalizeCompactionSettings({
            enabled: true,
            reserveTokens: -5,
            keepRecentTokens: 0,
        })
        expect(normalized.reserveTokens).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens)
        expect(normalized.keepRecentTokens).toBe(
            DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
        )
        expect(normalized.thresholdRatio).toBe(
            DEFAULT_COMPACTION_SETTINGS.thresholdRatio,
        )

        // Missing window uses 128000 with default 95% threshold.
        expect(
            shouldCompact(128_000 * 0.95 + 1, null, { enabled: true }),
        ).toBe(true)
        expect(shouldCompact(128_000 * 0.95, null, { enabled: true })).toBe(false)
    })
})
