import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import type { AssistantStreamEvent } from '../agent/types'
import type {
    ProtocolClient,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import type {
    AssistantEntry,
    ConversationEntry,
    ToolResultEntry,
    Usage,
    UserEntry,
} from '../session/types'
import {
    NO_PRIOR_HISTORY_SUMMARY,
    REQUIRED_SUMMARY_HEADINGS,
    REQUIRED_TURN_PREFIX_HEADINGS,
    SUMMARIZATION_SYSTEM_PROMPT,
    buildCompactedContext,
    buildToolPairing,
    compactConversation,
    computeFileLists,
    createFileOps,
    deepCloneValue,
    escapeXmlListItem,
    extractFileOpsFromEntry,
    findCutPoint,
    formatFileOperations,
    isCutPointEntry,
    isTransientSummaryError,
    isValidCutForToolPairing,
    mergeUsage,
    neutralizeClosingTag,
    neutralizeSummaryTags,
    buildCachedSummaryPrompt,
    canUseCachedCompaction,
    findKeptStart,
    prepareCompaction,
    resolveSummaryMaxTokens,
    resolveSummaryReasoningEffort,
    sanitizeSummaryBody,
    shouldDisableToolsForCachedSummary,
    stripFileOperationTags,
    serializeConversation,
    truncateCodePoints,
    validateSummaryStructure,
    validateTurnPrefixStructure,
} from './compaction'
import {
    DEFAULT_COMPACTION_SETTINGS,
    estimateTokens,
    shouldCompact,
} from './tokenEstimate'

const model: ModelCatalogEntry = {
    id: 'gpt-test',
    label: 'Test',
    supportsFast: false,
    reasoningLevels: [{ id: 'high', requestValue: 'high' }],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 4_096,
}

function usage(totalTokens: number, partial: Partial<Usage> = {}): Usage {
    return {
        input: partial.input ?? totalTokens,
        output: partial.output ?? 0,
        cacheRead: partial.cacheRead ?? 0,
        cacheWrite: partial.cacheWrite ?? 0,
        totalTokens,
        cost: partial.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    }
}

function user(id: string, text: string): UserEntry {
    return {
        id,
        sessionId: 's1',
        createdAt: 1,
        kind: 'user',
        content: [{ type: 'text', text }],
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

function toolResult(
    id: string,
    toolCallId: string,
    text: string,
    toolName = 'read',
): ToolResultEntry {
    return {
        id,
        sessionId: 's1',
        createdAt: 3,
        kind: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
    }
}

function validSummary(extra = ''): string {
    return [
        '## Goal',
        'Ship compaction',
        '## Constraints & Preferences',
        '- none',
        '## Progress',
        '### Done',
        '- [x] setup',
        '### In Progress',
        '- [ ] tests',
        '### Blocked',
        '- none',
        '## Key Decisions',
        '- **Use TDD**: required',
        '## Next Steps',
        '1. finish',
        '## Critical Context',
        '- keep paths',
        extra,
    ].join('\n')
}

function validTurnPrefix(extra = ''): string {
    return [
        '## Original Request',
        'Do the work',
        '## Early Progress',
        '- started',
        '## Context for Suffix',
        '- keep going',
        extra,
    ].join('\n')
}

interface StreamCall {
    input: ProtocolStreamInput
    options?: ProtocolStreamOptions
    signal: AbortSignal
}

function promptTextOf(call: StreamCall): string {
    const entry = call.input.entries[0]
    if (!entry || entry.kind !== 'user') return ''
    return entry.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
}

function makeClient(handler: (call: StreamCall) => AssistantEntry | Promise<AssistantEntry>): {
    client: ProtocolClient
    calls: StreamCall[]
} {
    const calls: StreamCall[] = []
    const client: ProtocolClient = {
        async *stream(input, options) {
            const signal = options?.signal ?? new AbortController().signal
            const call: StreamCall = { input, signal, options }
            calls.push(call)
            if (signal.aborted) {
                throw new Error('Request was aborted')
            }
            const result = await handler(call)
            const done: AssistantStreamEvent = {
                type: 'done',
                reason: 'stop',
                message: result,
            }
            yield done
            return result
        },
    }
    return { client, calls }
}

/** Auto-select valid history vs turn-prefix bodies from the prompt shape. */
function makeSummaryClient(
    overrides?: Partial<AssistantEntry> | ((call: StreamCall, body: string) => AssistantEntry),
): {
    client: ProtocolClient
    calls: StreamCall[]
} {
    return makeClient((call) => {
        const prompt = promptTextOf(call)
        const isPrefix = prompt.includes('PREFIX of a turn')
        const body = isPrefix ? validTurnPrefix() : validSummary()
        if (typeof overrides === 'function') {
            return overrides(call, body)
        }
        return assistant(isPrefix ? 'sum-prefix' : 'sum-history', body, {
            status: 'done',
            stopReason: 'stop',
            usage: usage(10),
            ...overrides,
        })
    })
}

describe('shouldCompact threshold (equality)', () => {
    it('is strict greater-than on window * thresholdRatio', () => {
        expect(
            shouldCompact(121_601, 128_000, {
                enabled: true,
                reserveTokens: 16_384,
                keepRecentTokens: 20_000,
                thresholdRatio: 0.95,
            }),
        ).toBe(true)
        expect(
            shouldCompact(
                128_000 * DEFAULT_COMPACTION_SETTINGS.thresholdRatio,
                128_000,
                DEFAULT_COMPACTION_SETTINGS,
            ),
        ).toBe(false)
    })
})

describe('cut points and prepareCompaction', () => {
    it('never treats ToolResult or error/partial/errorMessage assistant as cut points', () => {
        expect(isCutPointEntry(toolResult('t1', 'c1', 'out'))).toBe(false)
        expect(
            isCutPointEntry(
                assistant('a-err', 'x', { status: 'error', stopReason: 'error' }),
            ),
        ).toBe(false)
        expect(
            isCutPointEntry(
                assistant('a-stream', 'x', {
                    status: 'streaming',
                    stopReason: 'pending',
                }),
            ),
        ).toBe(false)
        expect(
            isCutPointEntry(
                assistant('a-em', 'x', {
                    status: 'done',
                    stopReason: 'stop',
                    errorMessage: 'soft failure',
                }),
            ),
        ).toBe(false)
        expect(isCutPointEntry(user('u1', 'hi'))).toBe(true)
        expect(isCutPointEntry(assistant('a1', 'ok'))).toBe(true)
    })

    it('keeps tool results with their assistant toolCall when cutting at the assistant', () => {
        // Multiple large earlier turns so keepRecent lands on a later assistant with tools.
        const entries: ConversationEntry[] = [
            user('u0', 'x'.repeat(40_000)),
            assistant('a0', 'y'.repeat(40_000)),
            user('u1', 'z'.repeat(40_000)),
            assistant('a1', 'thinking...', {
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                ],
            }),
            toolResult('t1', 'call_1', 'file body'),
            user('u2', 'recent'),
            assistant('a2', 'done recently'),
        ]

        const cut = findCutPoint(entries, 0, entries.length, 50)
        expect(entries[cut.firstKeptEntryIndex]?.kind).not.toBe('toolResult')

        const prep = prepareCompaction(entries, {
            ...DEFAULT_COMPACTION_SETTINGS,
            keepRecentTokens: 50,
        })
        expect(prep).toBeDefined()
        expect(prep!.firstKeptEntryId).not.toBe('t1')
        // History before the kept assistant must not include an orphan tool result
        // without its toolCall assistant also in history / kept.
        if (prep!.firstKeptEntryId === 'a1') {
            expect(prep!.historyEntries.some((e) => e.id === 't1')).toBe(false)
            // Tool result stays with retained tail after a1.
            const builtIds = [
                ...prep!.historyEntries.map((e) => e.id),
                prep!.firstKeptEntryId,
            ]
            expect(builtIds).toContain('a1')
        }
        // Never cut at ToolResult index.
        const firstKeptIndex = entries.findIndex((e) => e.id === prep!.firstKeptEntryId)
        expect(entries[firstKeptIndex]?.kind).not.toBe('toolResult')
    })

    it('records split-turn when cutting mid-turn on a large user turn', () => {
        // One huge user turn with multiple assistants; keep only the latest assistant.
        const bigUser = user('u1', 'U'.repeat(100_000))
        const a1 = assistant('a1', 'A'.repeat(40_000), {
            stopReason: 'toolUse',
            content: [
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'read',
                    arguments: { path: 'big.ts' },
                },
            ],
        })
        const t1 = toolResult('t1', 'c1', 'T'.repeat(40_000))
        const a2 = assistant('a2', 'suffix kept')

        const entries: ConversationEntry[] = [bigUser, a1, t1, a2]
        const prep = prepareCompaction(entries, {
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: estimateTokens(a2) + 1,
        })
        expect(prep).toBeDefined()
        expect(prep!.isSplitTurn).toBe(true)
        expect(prep!.turnStartIndex).toBe(0)
        expect(prep!.firstKeptEntryId).toBe('a2')
        expect(prep!.turnPrefixEntries.map((e) => e.id)).toEqual(['u1', 'a1', 't1'])
        expect(prep!.historyEntries).toEqual([])
    })

    it('returns undefined when last entry is compaction or nothing to summarize', () => {
        const onlyCompaction: ConversationEntry[] = [
            {
                id: 'c1',
                sessionId: 's1',
                createdAt: 0,
                kind: 'compaction',
                summary: 'old',
                firstKeptEntryId: 'u1',
            },
        ]
        expect(prepareCompaction(onlyCompaction)).toBeUndefined()

        // Everything fits in keepRecent and starts at boundary with no history to drop.
        const small: ConversationEntry[] = [user('u1', 'hi'), assistant('a1', 'yo')]
        const prep = prepareCompaction(small, {
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 1_000_000,
        })
        // With huge keepRecent, cut stays at first entry => nothing to summarize.
        expect(prep).toBeUndefined()
    })

    it('uses previous compaction boundary and carries previous summary', () => {
        const entries: ConversationEntry[] = [
            user('u0', 'ancient'),
            {
                id: 'c1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'compaction',
                summary: validSummary(),
                firstKeptEntryId: 'u1',
                readFiles: ['old-read.ts'],
                modifiedFiles: ['old-mod.ts'],
            },
            user('u1', 'H'.repeat(80_000)),
            assistant('a1', 'A'.repeat(40_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const prep = prepareCompaction(entries, {
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 100,
        })
        expect(prep).toBeDefined()
        expect(prep!.previousSummary).toContain('## Goal')
        // Boundary starts at firstKept of previous compaction (u1), not u0.
        expect(prep!.historyEntries.some((e) => e.id === 'u0')).toBe(false)
        expect(prep!.fileOps.read.has('old-read.ts')).toBe(true)
        expect(prep!.fileOps.edited.has('old-mod.ts')).toBe(true)
    })
})

describe('serialization and file lists', () => {
    it('truncates tool results to 2000 code points with marker, includes ids, and placeholders images', () => {
        const long = 'x'.repeat(2500)
        const text = serializeConversation([
            user('u1', 'hello'),
            assistant('a1', 'work', {
                content: [
                    { type: 'thinking', thinking: 'plan' },
                    {
                        type: 'toolCall',
                        id: 'c1',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                ],
            }),
            {
                id: 't1',
                sessionId: 's1',
                createdAt: 3,
                kind: 'toolResult',
                toolCallId: 'c1',
                toolName: 'read',
                content: [
                    { type: 'text', text: long },
                    { type: 'image', data: 'img', mimeType: 'image/png' },
                ],
                isError: false,
            },
        ])
        expect(text).toContain('[Assistant thinking]: plan')
        expect(text).toContain('read(id=c1,')
        expect(text).toContain('[Tool result id=c1]:')
        expect(text).toContain('[... 500 more characters truncated]')
        expect(text).toContain('[image]')
        expect(text).not.toContain(long)
    })

    it('neutralizes XML closing injection in conversation/previous-summary delimiters', () => {
        expect(neutralizeClosingTag('foo </conversation> bar', 'conversation')).toBe(
            'foo </ conversation> bar',
        )
        expect(
            neutralizeClosingTag('x</previous-summary>y', 'previous-summary'),
        ).toBe('x</ previous-summary>y')
    })

    it('accumulates file paths from tool calls with modified wins and codepoint sort', () => {
        const ops = createFileOps()
        extractFileOpsFromEntry(
            assistant('a1', '', {
                content: [
                    {
                        type: 'toolCall',
                        id: '1',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: '2',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: '3',
                        name: 'write',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: '4',
                        name: 'edit',
                        arguments: { path: 'c.ts' },
                    },
                ],
            }),
            ops,
        )
        // ToolResult must not contribute paths.
        extractFileOpsFromEntry(
            toolResult('t1', '1', 'path should not matter: z.ts'),
            ops,
        )
        const { readFiles, modifiedFiles } = computeFileLists(ops)
        expect(readFiles).toEqual(['b.ts'])
        expect(modifiedFiles).toEqual(['a.ts', 'c.ts'])

        const xml = formatFileOperations(['a<b>.ts', 'ok.ts'], ['x.ts'])
        expect(xml).toContain('<read-files>')
        expect(xml).toContain('a&lt;b&gt;.ts')
        expect(xml).toContain('<modified-files>')
        expect(escapeXmlListItem('a\u0000b<c>')).toBe('ab&lt;c&gt;')
    })
})

describe('validateSummaryStructure', () => {
    it('requires nonempty text and all required headings', () => {
        expect(() => validateSummaryStructure('')).toThrow(/empty/i)
        expect(() => validateSummaryStructure('## Goal\nonly')).toThrow(/missing required headings/i)
        expect(() => validateSummaryStructure(validSummary())).not.toThrow()
        for (const heading of REQUIRED_SUMMARY_HEADINGS) {
            expect(validSummary()).toContain(heading)
        }
    })

    it('is line- and fence-aware: ignores fenced pseudo-headings, rejects duplicates and plain-text fakes', () => {
        const fenced = [
            '## Goal',
            'ok',
            '## Constraints & Preferences',
            '- none',
            '## Progress',
            '### Done',
            '- x',
            '### In Progress',
            '- y',
            '### Blocked',
            '- z',
            '## Key Decisions',
            '- d',
            '## Next Steps',
            '1. n',
            '## Critical Context',
            '```',
            '## Goal',
            '```',
            '- keep',
        ].join('\n')
        expect(() => validateSummaryStructure(fenced)).not.toThrow()

        const plainTextFake = validSummary().replace(
            '## Goal\nShip compaction',
            'Mention of ## Goal in prose only',
        )
        expect(() => validateSummaryStructure(plainTextFake)).toThrow(/missing required headings/i)

        const duplicate = `${validSummary()}\n## Goal\nagain`
        expect(() => validateSummaryStructure(duplicate)).toThrow(/duplicate required heading/i)

        const outOfOrder = [
            '## Constraints & Preferences',
            '- none',
            '## Goal',
            'Ship',
            '## Progress',
            '### Done',
            '- x',
            '### In Progress',
            '- y',
            '### Blocked',
            '- z',
            '## Key Decisions',
            '- d',
            '## Next Steps',
            '1. n',
            '## Critical Context',
            '- k',
        ].join('\n')
        expect(() => validateSummaryStructure(outOfOrder)).toThrow(/out of order|missing required headings/i)
    })

    it('validates turn-prefix headings separately', () => {
        expect(() => validateTurnPrefixStructure('')).toThrow(/empty/i)
        expect(() => validateTurnPrefixStructure('## Original Request\nonly')).toThrow(
            /missing required headings/i,
        )
        expect(() => validateTurnPrefixStructure(validTurnPrefix())).not.toThrow()
        for (const heading of REQUIRED_TURN_PREFIX_HEADINGS) {
            expect(validTurnPrefix()).toContain(heading)
        }
    })
})

describe('compactConversation', () => {
    it('creates a single CompactionEntry via isolated stream with empty tools and fresh cache key', async () => {
        // Two large earlier turns so default keepRecent leaves real history to summarize.
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(40_000)),
            assistant('a0', 'A'.repeat(40_000), { usage: usage(30_000) }),
            user('u1', 'H'.repeat(40_000)),
            assistant('a1', 'A'.repeat(40_000), { usage: usage(50_000) }),
            user('u2', 'recent question'),
            assistant('a2', 'recent answer', { usage: usage(1_000) }),
        ]
        const original = structuredClone(entries)

        const { client, calls } = makeClient((call) => {
            expect(call.input.tools).toEqual([])
            expect(call.input.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT)
            expect(call.input.model).toEqual(model)
            expect(call.input.reasoningEffort).toBeUndefined()
            expect(call.options?.connectionMode).toBe('isolated')
            expect(call.options?.promptCacheKey).toBeTruthy()
            expect(call.options?.promptCacheKey).not.toBe('s1')
            const prompt = call.input.entries[0]
            expect(prompt?.kind).toBe('user')
            const text = promptTextOf(call)
            const isPrefix = text.includes('PREFIX of a turn')
            if (!isPrefix) {
                expect(call.options?.maxOutputTokens).toBe(
                    Math.min(Math.floor(16_384 * 0.8), model.maxTokens),
                )
            }
            return assistant(isPrefix ? 'sum-prefix' : 'sum1', isPrefix ? validTurnPrefix() : validSummary(), {
                status: 'done',
                stopReason: 'stop',
                usage: usage(100, { input: 80, output: 20 }),
            })
        })

        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            reasoningEffort: 'high',
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 500 },
            now: () => 42,
            generateId: (() => {
                let n = 0
                return () => `id-${++n}`
            })(),
        })

        expect(calls.length).toBeGreaterThanOrEqual(1)
        expect(result.entry.kind).toBe('compaction')
        expect(result.entry.id).toMatch(/^id-/)
        expect(result.entry.createdAt).toBe(42)
        expect(result.entry.firstKeptEntryId).toBeTruthy()
        expect(result.entry.tokensBefore).toBeGreaterThan(0)
        expect(result.entry.usage?.totalTokens).toBeGreaterThan(0)
        expect(result.entry.summary).toContain('## Goal')
        expect(result.entries).toHaveLength(entries.length + 1)
        expect(result.entries[result.entries.length - 1]).toBe(result.entry)
        // Input not mutated.
        expect(entries).toEqual(original)
    })

    it('caps summary reasoning and completes two consecutive compaction cycles', async () => {
        const summaryModel: ModelCatalogEntry = {
            ...model,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'max', requestValue: 'max' },
            ],
        }
        const settings = {
            ...DEFAULT_COMPACTION_SETTINGS,
            keepRecentTokens: 100,
        }
        const initial: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'R'.repeat(1_000)),
            assistant('a2', 'ok'),
        ]
        const { client, calls } = makeSummaryClient({ usage: usage(5) })

        const first = await compactConversation(initial, {
            client,
            model: summaryModel,
            sessionId: 's1',
            reasoningEffort: 'max',
            fastContextCompaction: true,
            settings,
            summaryRetryDelaysMs: [],
        })
        expect(calls).toHaveLength(1)
        expect(calls[0]!.input.reasoningEffort).toBe('low')

        const secondInput: ConversationEntry[] = [
            ...first.entries,
            user('u3', 'N'.repeat(20_000)),
            assistant('a3', 'B'.repeat(20_000)),
            user('u4', 'S'.repeat(1_000)),
            assistant('a4', 'done'),
        ]
        const second = await compactConversation(secondInput, {
            client,
            model: summaryModel,
            sessionId: 's1',
            reasoningEffort: 'max',
            fastContextCompaction: true,
            settings,
            summaryRetryDelaysMs: [],
        })

        expect(calls).toHaveLength(2)
        expect(calls[1]!.input.reasoningEffort).toBe('low')
        expect(promptTextOf(calls[1]!)).toContain('<previous-summary>')
        expect(second.entry.summary).toContain('## Goal')
        expect(second.entries.filter((entry) => entry.kind === 'compaction')).toHaveLength(2)
    })

    it('inherits the session reasoning level when fast compaction is disabled', async () => {
        const summaryModel: ModelCatalogEntry = {
            ...model,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'max', requestValue: 'max' },
            ],
        }
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const { client, calls } = makeSummaryClient({ usage: usage(5) })

        await compactConversation(entries, {
            client,
            model: summaryModel,
            sessionId: 's1',
            reasoningEffort: 'max',
            fastContextCompaction: false,
            settings: {
                ...DEFAULT_COMPACTION_SETTINGS,
                keepRecentTokens: 100,
            },
            summaryRetryDelaysMs: [],
        })

        expect(calls.length).toBeGreaterThanOrEqual(1)
        expect(calls.every((call) => call.input.reasoningEffort === 'max')).toBe(
            true,
        )
    })

    it('passes fast speed down to summary stream when speed is fast', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'recent'),
            assistant('a1', 'ok'),
        ]
        const { client, calls } = makeSummaryClient({ usage: usage(5) })

        await compactConversation(entries, {
            client,
            model,
            sessionId: 's-fast-compact',
            speed: 'fast',
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 },
            summaryRetryDelaysMs: [],
        })

        expect(calls.length).toBeGreaterThanOrEqual(1)
        expect(calls.every((call) => call.input.speed === 'fast')).toBe(true)
    })

    it('preserves already-cheap summary reasoning and omits disabled reasoning', () => {
        const summaryModel: ModelCatalogEntry = {
            ...model,
            reasoningLevels: [
                { id: 'minimal', requestValue: 'minimal' },
                { id: 'low', requestValue: 'low' },
                { id: 'medium', requestValue: 'medium' },
                { id: 'max', requestValue: 'max' },
                { id: 'custom', requestValue: 'DeepCustom' },
            ],
        }
        expect(resolveSummaryReasoningEffort(summaryModel, 'minimal')).toBe('minimal')
        expect(resolveSummaryReasoningEffort(summaryModel, 'low')).toBe('low')
        expect(resolveSummaryReasoningEffort(summaryModel, 'medium')).toBe('medium')
        expect(resolveSummaryReasoningEffort(summaryModel, 'DeepCustom')).toBe('DeepCustom')
        expect(resolveSummaryReasoningEffort(summaryModel, 'max')).toBe('low')
        expect(
            resolveSummaryReasoningEffort(
                {
                    ...summaryModel,
                    reasoningLevels: [{ id: 'high', requestValue: 'high' }],
                },
                'high',
            ),
        ).toBeUndefined()
        expect(resolveSummaryReasoningEffort(summaryModel, 'off')).toBeUndefined()
        expect(resolveSummaryReasoningEffort(summaryModel, undefined)).toBeUndefined()
    })

    it('includes previous summary update and manual focus in the prompt', async () => {
        // Ensure non-empty history after previous compaction boundary (not only a split prefix).
        const entries: ConversationEntry[] = [
            {
                id: 'c0',
                sessionId: 's1',
                createdAt: 0,
                kind: 'compaction',
                summary: validSummary('prev'),
                firstKeptEntryId: 'u1',
                readFiles: ['prev.ts'],
            },
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u1b', 'H'.repeat(20_000)),
            assistant('a1b', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]

        const { client, calls } = makeSummaryClient()

        await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            customInstructions: 'Focus on file paths',
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 },
        })

        const promptTexts = calls.map((call) => {
            const entry = call.input.entries[0]
            if (!entry || entry.kind !== 'user') return ''
            return entry.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('')
        })
        const combined = promptTexts.join('\n')
        expect(combined).toContain('<previous-summary>')
        expect(combined).toContain('Additional focus: Focus on file paths')
        expect(combined).toContain('<conversation>')
    })

    it('splits huge turns into history + turn-prefix isolated calls and merges usage', async () => {
        // Prior history before the huge turn so split uses two isolated summary calls.
        const priorUser = user('u0', 'P'.repeat(40_000))
        const priorAsst = assistant('a0', 'Q'.repeat(40_000))
        const bigUser = user('u1', 'U'.repeat(100_000))
        const a1 = assistant('a1', 'A'.repeat(40_000), {
            stopReason: 'toolUse',
            content: [
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'write',
                    arguments: { path: 'out.ts' },
                },
            ],
        })
        const t1 = toolResult('t1', 'c1', 'T'.repeat(40_000), 'write')
        const a2 = assistant('a2', 'suffix')
        const entries: ConversationEntry[] = [priorUser, priorAsst, bigUser, a1, t1, a2]

        let callCount = 0
        const { client, calls } = makeClient(() => {
            callCount += 1
            // History call needs full headings; turn-prefix needs its own 3 headings.
            const text =
                callCount === 1 ? validSummary(`n=${callCount}`) : validTurnPrefix(`n=${callCount}`)
            return assistant(`sum-${callCount}`, text, {
                usage: usage(callCount * 10, { input: callCount * 7, output: callCount * 3 }),
            })
        })

        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            settings: {
                enabled: true,
                reserveTokens: 16_384,
                keepRecentTokens: estimateTokens(a2) + 1,
            },
        })

        expect(calls.length).toBe(2)
        for (const call of calls) {
            expect(call.options?.connectionMode).toBe('isolated')
            expect(call.input.tools).toEqual([])
            expect(call.options?.promptCacheKey).toBeTruthy()
        }
        // Distinct fresh cache keys per summary call.
        expect(calls[0]!.options?.promptCacheKey).not.toBe(calls[1]!.options?.promptCacheKey)
        expect(result.entry.summary).toContain('Turn Context (split turn)')
        expect(result.entry.summary).toContain('## Goal')
        expect(result.entry.summary).toContain('## Original Request')
        expect(result.entry.modifiedFiles).toContain('out.ts')
        expect(result.entry.usage?.totalTokens).toBe(10 + 20)
    })

    it('does not mutate entries on abort or malformed summary', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const snapshot = structuredClone(entries)
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }

        const abortCtrl = new AbortController()
        abortCtrl.abort()
        const { client: abortClient } = makeClient(() => {
            throw new Error('should not be called')
        })
        await expect(
            compactConversation(entries, {
                client: abortClient,
                model,
                sessionId: 's1',
                signal: abortCtrl.signal,
                settings,
            }),
        ).rejects.toThrow(/abort/i)
        expect(entries).toEqual(snapshot)

        const { client: badClient } = makeClient(() =>
            assistant('bad', 'not a structured summary'),
        )
        await expect(
            compactConversation(entries, {
                client: badClient,
                model,
                sessionId: 's1',
                settings,
            }),
        ).rejects.toThrow(/missing required headings|Summarization failed|empty/i)
        expect(entries).toEqual(snapshot)
    })

    it('supports forced compact path regardless of shouldCompact', async () => {
        // Context under threshold — shouldCompact is false — force still works when history can drop.
        const entries: ConversationEntry[] = [
            user('u0', 'old history that will be dropped '.repeat(100)),
            assistant('a0', 'old answer '.repeat(100)),
            user('u1', 'more old history '.repeat(100)),
            assistant('a1', 'more old answer '.repeat(100)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const tokens = entries.reduce((s, e) => s + estimateTokens(e), 0)
        expect(shouldCompact(tokens, 128_000, DEFAULT_COMPACTION_SETTINGS)).toBe(false)

        const { client } = makeSummaryClient({ usage: usage(5) })
        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            force: true,
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 50 },
        })
        expect(result.entry.kind).toBe('compaction')
    })
})

describe('buildCompactedContext', () => {
    it('returns defensive copy when no compaction exists', () => {
        const entries: ConversationEntry[] = [user('u1', 'hi'), assistant('a1', 'yo')]
        const built = buildCompactedContext(entries)
        expect(built).toEqual(entries)
        expect(built).not.toBe(entries)
    })

    it('returns latest compaction + tail from firstKeptEntryId and filters older compaction', () => {
        const clean: ConversationEntry[] = [
            user('u0', 'ancient'),
            {
                id: 'c-old',
                sessionId: 's1',
                createdAt: 1,
                kind: 'compaction',
                summary: 'old',
                firstKeptEntryId: 'u1',
            },
            user('u1', 'between'),
            assistant('a1', 'between a'),
            {
                id: 'c-new',
                sessionId: 's1',
                createdAt: 2,
                kind: 'compaction',
                summary: 'new summary',
                firstKeptEntryId: 'u2',
            },
            user('u2', 'tail user'),
            assistant('a2', 'tail asst'),
        ]

        const built = buildCompactedContext(clean)
        expect(built[0]).toMatchObject({ id: 'c-new', kind: 'compaction' })
        expect(built.map((e) => e.id)).toEqual(['c-new', 'u2', 'a2'])
        expect(built.some((e) => e.id === 'c-old')).toBe(false)
        expect(built.some((e) => e.id === 'u0')).toBe(false)
    })

    it('falls back safely when firstKeptEntryId is missing', () => {
        const entries: ConversationEntry[] = [
            user('u0', 'old'),
            {
                id: 'c1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'compaction',
                summary: 'sum',
                firstKeptEntryId: 'missing-id',
            },
            user('u1', 'after'),
            assistant('a1', 'after a'),
        ]
        const built = buildCompactedContext(entries)
        expect(built.map((e) => e.id)).toEqual(['c1', 'u1', 'a1'])
    })
})

describe('mergeUsage', () => {
    it('merges two usage objects field-wise', () => {
        const merged = mergeUsage(usage(10, { input: 7, output: 3 }), usage(5, { input: 2, output: 3 }))
        expect(merged?.totalTokens).toBe(15)
        expect(merged?.input).toBe(9)
        expect(merged?.output).toBe(6)
    })
})

// Keep a light spy so accidental Pi imports fail fast in this suite.
describe('isolation', () => {
    it('does not import Pi runtime modules', async () => {
        // Structural check: our modules export the CPA symbols only.
        const mod = await import('./compaction')
        expect(mod.SUMMARIZATION_SYSTEM_PROMPT).toBe(
            'You are a context summarization assistant. Do not continue the conversation. Only output the requested structured summary.',
        )
        expect(vi.isMockFunction(mod.compactConversation)).toBe(false)
    })
})

describe('tool pairing cut validation (Fix Round 1)', () => {
    it('rejects cuts that keep a nonadjacent/orphan tool result without its call and advances', () => {
        // Nonadjacent: call, user, result — cutting at user would orphan the result.
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(40_000)),
            assistant('a0', 'A'.repeat(40_000)),
            assistant('a-call', 'calling', {
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_1|fc_1',
                        name: 'read',
                        arguments: { path: 'x.ts' },
                    },
                ],
            }),
            user('u-mid', 'mid'),
            toolResult('t1', 'call_1|fc_1', 'body'),
            assistant('a-end', 'done recently'),
        ]

        const pairing = buildToolPairing(entries)
        // Cutting at u-mid keeps t1 without a-call → invalid.
        const uMid = entries.findIndex((e) => e.id === 'u-mid')
        expect(isValidCutForToolPairing(uMid, entries.length, pairing, entries)).toBe(false)
        // Cutting at a-call keeps call + later result → valid.
        const aCall = entries.findIndex((e) => e.id === 'a-call')
        expect(isValidCutForToolPairing(aCall, entries.length, pairing, entries)).toBe(true)

        const cut = findCutPoint(entries, 0, entries.length, 20)
        expect(entries[cut.firstKeptEntryIndex]?.id).not.toBe('u-mid')
        expect(entries[cut.firstKeptEntryIndex]?.kind).not.toBe('toolResult')

        const prep = prepareCompaction(entries, {
            ...DEFAULT_COMPACTION_SETTINGS,
            keepRecentTokens: 20,
        })
        expect(prep).toBeDefined()
        // Retained region must not contain orphan result without call.
        if (prep!.firstKeptEntryId === 'u-mid') {
            throw new Error('invalid cut at u-mid kept orphan result')
        }
        // Duplicate/malformed ids stay deterministic (first-wins).
        const multi: ConversationEntry[] = [
            assistant('a1', '', {
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_x|fc_a',
                        name: 'read',
                        arguments: { path: 'a.ts' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_x|fc_b',
                        name: 'read',
                        arguments: { path: 'b.ts' },
                    },
                ],
            }),
            toolResult('t-legacy', 'call_x', 'legacy match'),
            toolResult('t-conflicting', 'call_x|fc_b', 'should not reassign'),
            toolResult('t-malformed', '', 'ignored empty'),
        ]
        const plan = buildToolPairing(multi)
        expect(plan.resultToAssistant.get(1)).toBe(0) // legacy raw === normalized
        expect(plan.resultToAssistant.has(2)).toBe(false) // conflicting composite skipped
    })
})

describe('logical active tail / multi-cycle (Fix Round 1)', () => {
    it('builds next cut on logical non-marker records and maps original ids', () => {
        const entries: ConversationEntry[] = [
            user('u0', 'ancient'),
            assistant('a0', 'ancient a'),
            user('u1', 'H'.repeat(40_000)),
            assistant('a1', 'A'.repeat(40_000)),
            {
                id: 'c1',
                sessionId: 's1',
                createdAt: 1,
                kind: 'compaction',
                summary: validSummary('cycle1'),
                firstKeptEntryId: 'u1',
                readFiles: ['seed.ts'],
            },
            user('u2', 'H'.repeat(40_000)),
            assistant('a2', 'A'.repeat(40_000)),
            user('u3', 'recent'),
            assistant('a3', 'ok'),
        ]
        const prep = prepareCompaction(entries, {
            ...DEFAULT_COMPACTION_SETTINGS,
            keepRecentTokens: 50,
        })
        expect(prep).toBeDefined()
        expect(prep!.previousSummary).toContain('cycle1')
        // History must not re-include raw marker or pre-firstKept ancient entries.
        expect(prep!.historyEntries.some((e) => e.kind === 'compaction')).toBe(false)
        expect(prep!.historyEntries.some((e) => e.id === 'u0')).toBe(false)
        expect(prep!.fileOps.read.has('seed.ts')).toBe(true)

        // Last entry is marker with no new → undefined.
        expect(
            prepareCompaction([
                ...entries.slice(0, 5),
                {
                    id: 'c-last',
                    sessionId: 's1',
                    createdAt: 2,
                    kind: 'compaction',
                    summary: 'x',
                    firstKeptEntryId: 'u1',
                },
            ]),
        ).toBeUndefined()
    })
})

describe('summary sanitization / response validation (Fix Round 1)', () => {
    it('neutralizes summary tags and illegal controls without breaking file-list XML', () => {
        expect(neutralizeSummaryTags('before <summary>x</summary> after')).toBe(
            'before < summary>x</ summary> after',
        )
        expect(neutralizeSummaryTags('<summary id="1">body</summary>')).toBe(
            '< summary id="1">body</ summary>',
        )
        const dirty = `## Goal\n<script>\u0000</summary>evil`
        const clean = sanitizeSummaryBody(dirty)
        expect(clean).not.toContain('\u0000')
        expect(clean).toContain('</ summary>')
        expect(clean).not.toMatch(/<\/?summary/i)

        // File list markup is appended after sanitize and must remain intact.
        const xml = formatFileOperations(['a.ts'], ['b.ts'])
        expect(xml).toContain('<read-files>')
        expect(xml).toContain('<modified-files>')
    })

    it('fails summary responses with toolCall / toolUse / non-completed semantics', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }

        const { client: toolClient } = makeClient(() =>
            assistant('bad', validSummary(), {
                stopReason: 'toolUse',
                content: [
                    { type: 'text', text: validSummary() },
                    {
                        type: 'toolCall',
                        id: 'x',
                        name: 'read',
                        arguments: { path: 'nope.ts' },
                    },
                ],
            }),
        )
        await expect(
            compactConversation(entries, {
                client: toolClient,
                model,
                sessionId: 's1',
                settings,
            }),
        ).rejects.toThrow(/toolCall|stopReason|Summarization failed/i)
    })

    it('empty-history split uses deterministic checkpoint + independent prefix call', async () => {
        const bigUser = user('u1', 'U'.repeat(100_000))
        const a1 = assistant('a1', 'A'.repeat(40_000), {
            stopReason: 'toolUse',
            content: [
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'read',
                    arguments: { path: 'p.ts' },
                },
            ],
        })
        const t1 = toolResult('t1', 'c1', 'T'.repeat(40_000))
        const a2 = assistant('a2', 'suffix kept')
        const entries: ConversationEntry[] = [bigUser, a1, t1, a2]

        const { client, calls } = makeClient(() =>
            assistant('prefix', validTurnPrefix(), {
                usage: usage(7, { input: 5, output: 2 }),
            }),
        )

        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            settings: {
                enabled: true,
                reserveTokens: 16_384,
                keepRecentTokens: estimateTokens(a2) + 1,
            },
            summaryRetryDelaysMs: [],
        })

        // Only the turn-prefix call (history is deterministic NO_PRIOR_HISTORY).
        expect(calls.length).toBe(1)
        expect(calls[0]!.input.tools).toEqual([])
        expect(calls[0]!.options?.connectionMode).toBe('isolated')
        expect(result.entry.summary).toContain('No prior history.')
        expect(result.entry.summary).toContain(NO_PRIOR_HISTORY_SUMMARY.slice(0, 20))
        expect(result.entry.summary).toContain('Turn Context (split turn)')
        expect(result.entry.summary).toContain('## Original Request')
        expect(result.entry.usage?.totalTokens).toBe(7)
    })
})

describe('unicode tool result cap (Fix Round 1)', () => {
    it('caps at 2000 code points without splitting surrogate pairs', () => {
        const emoji = '😀' // one code point, two UTF-16 code units
        const text = emoji.repeat(2005)
        const out = truncateCodePoints(text, 2000)
        expect(Array.from(out.split('\n\n[...')[0]!).length).toBe(2000)
        expect(out).toContain('[... 5 more characters truncated]')
        // No lone surrogates: every char is a full code point.
        for (const ch of Array.from(out.split('\n\n[...')[0]!)) {
            expect(ch.codePointAt(0)! > 0xffff || ch.length === 1).toBe(true)
        }

        const serialized = serializeConversation([
            toolResult('t1', 'c1', emoji.repeat(2005)),
        ])
        expect(serialized).toContain('[... 5 more characters truncated]')
    })
})

describe('summary-level transient retry (Fix Round 1)', () => {
    it('retries transient post-stream errors with fresh ids, respects abort, and skips 4xx', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }

        expect(isTransientSummaryError(new Error('CPA stream closed before response.completed'))).toBe(
            true,
        )
        expect(isTransientSummaryError(new Error('network socket hang up'))).toBe(true)
        expect(isTransientSummaryError(new Error('Request was aborted'))).toBe(false)
        expect(isTransientSummaryError(new Error('HTTP 401 unauthorized'))).toBe(false)
        expect(
            isTransientSummaryError(
                new Error('Summarization failed: missing required headings: ## Goal'),
            ),
        ).toBe(false)

        let historyAttempts = 0
        const sleeps: number[] = []
        const { client, calls } = makeClient((call) => {
            const isPrefix = promptTextOf(call).includes('PREFIX of a turn')
            if (!isPrefix) {
                historyAttempts += 1
                if (historyAttempts < 3) {
                    throw new Error('CPA stream closed before response.completed')
                }
            }
            return assistant('sum-ok', isPrefix ? validTurnPrefix() : validSummary(), {
                usage: usage(3),
            })
        })

        let idSeq = 0
        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            settings,
            summaryRetryDelaysMs: [1, 1, 1],
            sleep: async (ms) => {
                sleeps.push(ms)
            },
            generateId: () => `rid-${++idSeq}`,
        })
        expect(result.entry.kind).toBe('compaction')
        // History call: 2 transient failures + 1 success.
        expect(historyAttempts).toBe(3)
        expect(sleeps.length).toBe(2)
        // Fresh cache keys / ids across attempts.
        const cacheKeys = calls.map((c) => c.options?.promptCacheKey)
        expect(new Set(cacheKeys).size).toBe(calls.length)

        // 4xx is not retried.
        let fourAttempts = 0
        const { client: fourClient } = makeClient(() => {
            fourAttempts += 1
            throw new Error('HTTP 403 forbidden')
        })
        await expect(
            compactConversation(entries, {
                client: fourClient,
                model,
                sessionId: 's1',
                settings,
                summaryRetryDelaysMs: [1, 1],
                sleep: async () => {
                    throw new Error('sleep should not run')
                },
            }),
        ).rejects.toThrow(/403|forbidden/i)
        expect(fourAttempts).toBe(1)

        // Abort interrupts retry sleep.
        const abort = new AbortController()
        let sleepHits = 0
        let transientAttempts = 0
        const { client: abortClient } = makeClient(() => {
            transientAttempts += 1
            throw new Error('network connection reset')
        })
        await expect(
            compactConversation(entries, {
                client: abortClient,
                model,
                sessionId: 's1',
                settings,
                signal: abort.signal,
                summaryRetryDelaysMs: [50_000],
                sleep: async (_ms, signal) => {
                    sleepHits += 1
                    abort.abort()
                    if (signal.aborted) throw new Error('Request was aborted')
                },
            }),
        ).rejects.toThrow(/abort/i)
        expect(transientAttempts).toBe(1)
        expect(sleepHits).toBe(1)
    })
})

describe('summary completion gate (Fix Round 2)', () => {
    const longEntries = (): ConversationEntry[] => [
        user('u0', 'H'.repeat(20_000)),
        assistant('a0', 'A'.repeat(20_000)),
        user('u1', 'H'.repeat(20_000)),
        assistant('a1', 'A'.repeat(20_000)),
        user('u2', 'recent'),
        assistant('a2', 'ok'),
    ]
    const tightSettings = {
        ...DEFAULT_COMPACTION_SETTINGS,
        keepRecentTokens: 100,
    }

    /** Isolated summary body selector shared by Fix Round 2 fixtures. */
    function summaryBodyFor(call: StreamCall): string {
        return promptTextOf(call).includes('PREFIX of a turn')
            ? validTurnPrefix()
            : validSummary()
    }

    it('accepts only status done + stopReason stop with valid headings',
        async () => {
            const entries = longEntries()
            const snapshot = structuredClone(entries)
            const { client, calls } = makeSummaryClient({ usage: usage(11) })
            const result = await compactConversation(entries, {
                client,
                model,
                sessionId: 's1',
                settings: tightSettings,
                summaryRetryDelaysMs: [],
            })
            expect(result.entry.kind).toBe('compaction')
            expect(result.entry.summary).toContain('## Goal')
            expect(result.entries).toHaveLength(entries.length + 1)
            expect(calls.length).toBeGreaterThanOrEqual(1)
            expect(calls.every((c) => (c.input.tools ?? []).length === 0)).toBe(true)
            // Source untouched on success path (return is a new array).
            expect(entries).toEqual(snapshot)
        },
    )

    it('rejects done+length even when headings look complete: no retry, no CompactionEntry',
        async () => {
            const entries = longEntries()
            const snapshot = structuredClone(entries)
            let attempts = 0
            const sleeps: number[] = []
            const { client } = makeClient((call) => {
                attempts += 1
                return assistant('sum-len', summaryBodyFor(call), {
                    status: 'done',
                    stopReason: 'length',
                    usage: usage(9),
                })
            })
            await expect(
                compactConversation(entries, {
                    client,
                    model,
                    sessionId: 's1',
                    settings: tightSettings,
                    summaryRetryDelaysMs: [1, 1, 1],
                    sleep: async (ms) => {
                        sleeps.push(ms)
                    },
                }),
            ).rejects.toThrow(/length|incomplete|stopReason/i)
            // History-side fails first; length is deterministic so no retry/sleep.
            expect(attempts).toBe(1)
            expect(sleeps).toEqual([])
            expect(entries).toEqual(snapshot)
            expect(entries.some((e) => e.kind === 'compaction')).toBe(false)

            // length failures are deterministic output limits — never transient.
            expect(
                isTransientSummaryError(
                    new Error(
                        'Summarization failed: incomplete summary (stopReason length / response.incomplete)',
                    ),
                ),
            ).toBe(false)
            expect(
                isTransientSummaryError(
                    new Error('Summarization failed: unexpected stopReason length, expected stop'),
                ),
            ).toBe(false)
        },
    )

    it('rejects prefix done+length; history success + prefix length does not land an entry',
        async () => {
            // Force a split-turn: huge user turn with early assistants discarded.
            const bigUser = user('u1', 'U'.repeat(100_000))
            const a1 = assistant('a1', 'A'.repeat(40_000), {
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'toolCall',
                        id: 'c1',
                        name: 'read',
                        arguments: { path: 'p.ts' },
                    },
                ],
            })
            const t1 = toolResult('t1', 'c1', 'T'.repeat(40_000))
            const a2 = assistant('a2', 'suffix kept')
            // Add prior history so history call is a real model summary.
            const prior: ConversationEntry[] = [
                user('u0', 'H'.repeat(20_000)),
                assistant('a0', 'A'.repeat(20_000)),
                bigUser,
                a1,
                t1,
                a2,
            ]
            const snapshot = structuredClone(prior)
            const prep = prepareCompaction(prior, {
                enabled: true,
                reserveTokens: 16_384,
                keepRecentTokens: estimateTokens(a2) + 1,
            })
            expect(prep?.isSplitTurn).toBe(true)
            expect((prep?.historyEntries.length ?? 0) > 0).toBe(true)
            expect((prep?.turnPrefixEntries.length ?? 0) > 0).toBe(true)

            let historyCalls = 0
            let prefixCalls = 0
            const sleeps: number[] = []
            const { client } = makeClient((call) => {
                const isPrefix = promptTextOf(call).includes('PREFIX of a turn')
                if (isPrefix) {
                    prefixCalls += 1
                    return assistant('prefix-len', validTurnPrefix(), {
                        status: 'done',
                        stopReason: 'length',
                        usage: usage(4),
                    })
                }
                historyCalls += 1
                return assistant('hist-ok', validSummary(), {
                    status: 'done',
                    stopReason: 'stop',
                    usage: usage(8),
                })
            })

            await expect(
                compactConversation(prior, {
                    client,
                    model,
                    sessionId: 's1',
                    settings: {
                        enabled: true,
                        reserveTokens: 16_384,
                        keepRecentTokens: estimateTokens(a2) + 1,
                    },
                    summaryRetryDelaysMs: [1, 1],
                    sleep: async (ms) => {
                        sleeps.push(ms)
                    },
                }),
            ).rejects.toThrow(/length|incomplete|stopReason|Turn prefix/i)

            expect(historyCalls).toBe(1)
            expect(prefixCalls).toBe(1)
            expect(sleeps).toEqual([])
            expect(prior).toEqual(snapshot)
            expect(prior.some((e) => e.kind === 'compaction')).toBe(false)
        },
    )

    it('rejects done+error / done+aborted / done+stop with errorMessage edges',
        async () => {
            const entries = longEntries()
            const snapshot = structuredClone(entries)

            const cases: Array<{
                name: string
                overrides: Partial<AssistantEntry>
                pattern: RegExp
            }> = [
                {
                    name: 'done+error',
                    overrides: {
                        status: 'done',
                        stopReason: 'error',
                        errorMessage: 'provider boom',
                    },
                    pattern: /error|provider boom|Summarization failed/i,
                },
                {
                    name: 'done+aborted',
                    overrides: {
                        status: 'done',
                        stopReason: 'aborted',
                    },
                    pattern: /abort/i,
                },
                {
                    name: 'done+stop with errorMessage',
                    overrides: {
                        status: 'done',
                        stopReason: 'stop',
                        errorMessage: 'leaked failure',
                    },
                    pattern: /errorMessage|leaked failure|Summarization failed/i,
                },
                {
                    name: 'error status + stop reason',
                    overrides: {
                        status: 'error',
                        stopReason: 'stop',
                        errorMessage: 'status error',
                    },
                    pattern: /error|status error|Summarization failed/i,
                },
                {
                    name: 'aborted status + stop reason',
                    overrides: {
                        status: 'aborted',
                        stopReason: 'stop',
                    },
                    pattern: /abort/i,
                },
            ]

            for (const c of cases) {
                let attempts = 0
                const { client } = makeClient((call) => {
                    attempts += 1
                    return assistant('edge', summaryBodyFor(call), c.overrides)
                })
                await expect(
                    compactConversation(entries, {
                        client,
                        model,
                        sessionId: 's1',
                        settings: tightSettings,
                        summaryRetryDelaysMs: [1, 1],
                        sleep: async () => {
                            throw new Error('sleep should not run for ' + c.name)
                        },
                    }),
                    c.name,
                ).rejects.toThrow(c.pattern)
                // History-side fails first on every edge; never retry / never prefix.
                expect(attempts, c.name).toBe(1)
                expect(entries).toEqual(snapshot)
                expect(entries.some((e) => e.kind === 'compaction')).toBe(false)
            }
        },
    )
})

describe('defensive deep clones (Fix Round 1)', () => {
    it('buildCompactedContext and compact success return clones that tolerate mutation/cycles', async () => {
        const cyclicArgs: Record<string, unknown> = { path: 'a.ts' }
        cyclicArgs.self = cyclicArgs
        const asst = assistant('a1', 'hi', {
            content: [
                {
                    type: 'toolCall',
                    id: 'c1',
                    name: 'read',
                    arguments: cyclicArgs as unknown as Record<string, unknown>,
                },
            ],
            usage: usage(10),
        })
        const entries: ConversationEntry[] = [
            user('u1', 'hello'),
            asst,
            {
                id: 'c-new',
                sessionId: 's1',
                createdAt: 2,
                kind: 'compaction',
                summary: 'sum',
                firstKeptEntryId: 'u1',
            },
        ]

        const built = buildCompactedContext(entries)
        expect(built[0]).not.toBe(entries[2])
        ;(built[0] as { summary: string }).summary = 'mutated'
        expect((entries[2] as { summary: string }).summary).toBe('sum')

        // deepCloneValue handles cycles + BigInt.
        const cyclic: Record<string, unknown> = { n: 1n }
        cyclic.self = cyclic
        const cloned = deepCloneValue(cyclic)
        expect(cloned).not.toBe(cyclic)
        expect(cloned.self).toBe(cloned)
        expect(cloned.n).toBe(1n)

        const longEntries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000)),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000)),
            user('u2', 'recent'),
            assistant('a2', 'ok'),
        ]
        const snapshot = structuredClone(longEntries)
        const { client: summaryClient } = makeSummaryClient({ usage: usage(5) })
        const result = await compactConversation(longEntries, {
            client: summaryClient,
            model,
            sessionId: 's1',
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 },
            summaryRetryDelaysMs: [],
        })
        const last = result.entries[result.entries.length - 1]!
        expect(last).toEqual(result.entry)
        // Mutating the returned compaction must not affect the caller's source array.
        ;(result.entry as { summary: string }).summary = 'mutated-entry'
        expect(longEntries).toEqual(snapshot)
        expect(result.entries[0]).not.toBe(longEntries[0])
        const firstUser = result.entries[0] as UserEntry
        if (firstUser.kind === 'user' && firstUser.content[0]?.type === 'text') {
            firstUser.content[0].text = 'mutated-source'
        }
        expect((longEntries[0] as UserEntry).content[0]).toMatchObject({ text: expect.not.stringMatching(/^mutated/) })
    })
})

describe('dynamic model-native summary output limits (Pi 1.4+ semantics)', () => {
    it('uses model.maxTokens instead of capping at reserveTokens * 0.8 for reasoning models', () => {
        const reasoningModel: ModelCatalogEntry = {
            ...model,
            id: 'gpt-6.1-sol',
            contextWindow: 200_000,
            maxTokens: 64_000,
        }
        expect(resolveSummaryMaxTokens(reasoningModel, 40_000, 16_384)).toBe(64_000)
    })

    it('dynamically shrinks output budget when remaining contextWindow is smaller than model.maxTokens', () => {
        const reasoningModel: ModelCatalogEntry = {
            ...model,
            id: 'gpt-6.1-sol',
            contextWindow: 128_000,
            maxTokens: 64_000,
        }
        // 128,000 - 100,000 = 28,000 remaining in context window (< 64,000).
        expect(resolveSummaryMaxTokens(reasoningModel, 100_000, 16_384)).toBe(28_000)
        // Strictly respects remaining contextWindow when 0 < remaining < 1024 so input + output never exceed contextWindow.
        expect(resolveSummaryMaxTokens(reasoningModel, 127_500, 16_384)).toBe(500)
        // When remaining <= 0, falls back to MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS (1024).
        expect(resolveSummaryMaxTokens(reasoningModel, 128_000, 16_384)).toBe(1_024)
        expect(resolveSummaryMaxTokens(reasoningModel, 130_000, 16_384)).toBe(1_024)
    })

    it('falls back to isolated compaction and trims prompt when cached input leaves < 1024 tokens in contextWindow', async () => {
        const tightModel: ModelCatalogEntry = {
            ...model,
            contextWindow: 4_000,
            maxTokens: 2_048,
        }
        const entries: ConversationEntry[] = [
            user('u1', 'first topic ' + 'A'.repeat(8_000)),
            assistant('a1', 'response ' + 'B'.repeat(8_000), {
                model: tightModel.id,
                usage: usage(3_700, {
                    input: 3_500,
                    output: 200,
                    cacheRead: 0,
                    cacheWrite: 0,
                }),
            }),
            user('u2', 'recent prompt '.repeat(5)),
        ]
        const { client, calls } = makeClient(() =>
            assistant('sum', validSummary(), { model: tightModel.id }),
        )
        const result = await compactConversation(entries, {
            client,
            model: tightModel,
            sessionId: 'sess-tight',
            fastContextCompaction: false,
            force: true,
            trigger: 'auto',
            now: () => 1_000,
            cachedContext: {
                systemPrompt: 'sys',
                modelId: tightModel.id,
                requestEntries: entries,
                lastCachedAt: 900,
                cacheExpiresAt: 5_000,
            },
            settings: {
                enabled: true,
                reserveTokens: 500,
                keepRecentTokens: 10,
            },
        })
        expect(result.entry).toBeDefined()
        // Cached path skipped due to < 1024 remaining tokens, so only the isolated request was sent
        // and its input + maxOutputTokens stayed within tightModel.contextWindow (4000).
        expect(calls).toHaveLength(1)
        expect(calls[0]?.options?.promptCacheKey).not.toBe('sess-tight')
        expect(calls[0]?.options?.maxOutputTokens).toBeGreaterThanOrEqual(1_024)
        expect(calls[0]?.options?.maxOutputTokens).toBeLessThanOrEqual(2_048)

        // Also verify small contextWindows (1600, 1700, 1800, 1900) where fixed overhead + template
        // leave < 1024 tokens: each must preserve non-empty <conversation> and <previous-summary>
        // bodies as well as the trailing format instructions while keeping input + output <= contextWindow.
        const entriesWithPrevCompaction: ConversationEntry[] = [
            user('u0', 'initial'),
            {
                id: 'cmp-prev',
                sessionId: 'sess-very-small',
                createdAt: 1,
                kind: 'compaction',
                summary: 'Previous summary ' + 'P'.repeat(1_500),
                firstKeptEntryId: 'u1',
            },
            ...entries,
        ]
        for (const win of [1_600, 1_700, 1_800, 1_900]) {
            const verySmallModel: ModelCatalogEntry = {
                ...model,
                contextWindow: win,
                maxTokens: 2_048,
            }
            const { client: smallClient, calls: smallCalls } = makeClient(() =>
                assistant('sum2', validSummary(), { model: verySmallModel.id }),
            )
            await compactConversation(entriesWithPrevCompaction, {
                client: smallClient,
                model: verySmallModel,
                sessionId: 'sess-very-small',
                fastContextCompaction: false,
                force: true,
                trigger: 'auto',
                now: () => 1_000,
                settings: {
                    enabled: true,
                    reserveTokens: 500,
                    keepRecentTokens: 10,
                },
            })
            expect(smallCalls).toHaveLength(1)
            const smallPromptText = promptTextOf(smallCalls[0]!)
            const convMatch = smallPromptText.match(
                /<conversation>\n([\s\S]*?)\n<\/conversation>/,
            )
            const prevMatch = smallPromptText.match(
                /<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/,
            )
            expect(convMatch?.[1]?.trim().length ?? 0).toBeGreaterThan(0)
            expect(prevMatch?.[1]?.trim().length ?? 0).toBeGreaterThan(0)
            expect(smallPromptText).toContain('Use this EXACT format:')
            expect(smallPromptText).toContain('## Critical Context')
            const smallEstimatedInput =
                Math.ceil((SUMMARIZATION_SYSTEM_PROMPT.length + smallPromptText.length) / 4) +
                512
            const smallMaxOutput = smallCalls[0]?.options?.maxOutputTokens ?? 0
            expect(smallEstimatedInput).toBeLessThan(win)
            expect(smallMaxOutput).toBeGreaterThan(0)
            expect(smallEstimatedInput + smallMaxOutput).toBeLessThanOrEqual(win)
        }
    })

    it('falls back to reserveTokens * 0.8 when model.maxTokens is missing or non-positive', () => {
        const noMaxModel: ModelCatalogEntry = {
            ...model,
            maxTokens: 0,
        }
        expect(resolveSummaryMaxTokens(noMaxModel, 10_000, 16_384)).toBe(
            Math.floor(16_384 * 0.8),
        )
    })
})

describe('cached compaction (pi-cached-compaction semantics)', () => {
    const sampleTool = {
        name: 'bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
    }

    it('extracts <kept-start> boundary, tracks duplicate previews from end, and neutralizes closing tags', () => {
        const entries: ConversationEntry[] = [
            user('u0', 'Earlier task request'),
            assistant('a0', 'Earlier response', { model: model.id }),
            user('u1', 'Keep this </kept-start> message'),
            assistant('a1', 'Kept assistant reply', { model: model.id }),
            user('u2', 'Keep this </kept-start> message'),
        ]
        const kept = findKeptStart(entries, 'u1')
        expect(kept).toEqual({
            text: 'Keep this </kept-start> message',
            fromEnd: 2,
            count: 3,
        })
        const prompt = buildCachedSummaryPrompt(kept!, 'Focus on test errors')
        expect(prompt).toContain('<kept-start>\nKeep this </ kept-start> message\n</kept-start>')
        expect(prompt).toContain('number 2 of them, counting back from the end')
        expect(prompt).toContain('last 3 messages')
        expect(prompt).toContain('Additional focus: Focus on test errors')

        // Rejects when the exact firstKeptEntryId entry has no text/toolCall preview (never drifts to a later entry).
        const thinkingOnlyKeptEntries: ConversationEntry[] = [
            user('u0', 'Earlier task request'),
            assistant('a0', 'Earlier response', { model: model.id }),
            assistant('a1_thinking_only', '', {
                model: model.id,
                content: [{ type: 'thinking', thinking: 'internal thought only' }],
            }),
            assistant('a2_text', 'Later text that must not become kept-start', { model: model.id }),
        ]
        expect(findKeptStart(thinkingOnlyKeptEntries, 'a1_thinking_only')).toBeUndefined()
    })

    it('validates the four preconditions in canUseCachedCompaction', () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000), { model: model.id }),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000), { model: model.id }),
            user('u2', 'recent question'),
            assistant('a2', 'recent answer', { model: model.id }),
        ]
        const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }
        const prep = prepareCompaction(entries, settings)!
        expect(prep).toBeDefined()

        const baseCachedContext = {
            systemPrompt: 'Main system prompt',
            developerPrompt: 'Developer role prompt',
            tools: [sampleTool],
            modelId: model.id,
            baseReasoningEffort: 'high',
            requestEntries: entries.slice(0, 4),
            lastCachedAt: 1_000,
            cacheExpiresAt: 10_000,
        }

        // Precondition 0: When fastContextCompaction is enabled (true or default undefined), cached compaction is disabled!
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: true,
                    cachedContext: baseCachedContext,
                },
                5_000,
            ),
        ).toBeUndefined()
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    cachedContext: baseCachedContext,
                },
                5_000,
            ),
        ).toBeUndefined()

        // Valid when fastContextCompaction is disabled (false) and all 4 preconditions hold.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: baseCachedContext,
                },
                5_000,
            ),
        ).toBeDefined()

        // Precondition 1: Overflow trigger rejects cached path.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    trigger: 'overflow',
                    cachedContext: baseCachedContext,
                },
                5_000,
            ),
        ).toBeUndefined()

        // Precondition 2: Model switch rejects cached path.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: { ...baseCachedContext, modelId: 'other-model' },
                },
                5_000,
            ),
        ).toBeUndefined()

        // Precondition 3: Expired cache rejects cached path.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: baseCachedContext,
                },
                10_000,
            ),
        ).toBeUndefined()

        // Precondition 3b: Default TTL expiry via lastCachedAt when cacheExpiresAt is omitted.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: {
                        ...baseCachedContext,
                        cacheExpiresAt: undefined,
                        lastCachedAt: 1_000,
                    },
                },
                1_000 + 300_000,
            ),
        ).toBeUndefined()

        // Precondition 4: Non-matching prefix (conversation edited/recalled or content modified with same id) rejects cached path.
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: {
                        ...baseCachedContext,
                        requestEntries: [user('u-different', 'different prefix')],
                    },
                },
                5_000,
            ),
        ).toBeUndefined()
        expect(
            canUseCachedCompaction(
                entries,
                prep,
                {
                    client: {} as ProtocolClient,
                    model,
                    sessionId: 's1',
                    fastContextCompaction: false,
                    cachedContext: {
                        ...baseCachedContext,
                        requestEntries: [
                            user('u0', 'modified content with same id u0'),
                            ...entries.slice(1, 4),
                        ],
                    },
                },
                5_000,
            ),
        ).toBeUndefined()
    })

    it('reuses systemPrompt, tools, sessionId promptCacheKey, and full tool results on cached path', async () => {
        const longToolTailError = 'log line '.repeat(400) + '\nFAIL: assertion failed at line 999'
        expect(longToolTailError.length).toBeGreaterThan(2_500)

        const entries: ConversationEntry[] = [
            user('u0', 'Run tests'),
            assistant('a0', 'Running bash', {
                model: model.id,
                stopReason: 'toolUse',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call_bash_1',
                        name: 'bash',
                        arguments: { command: 'pnpm test' },
                    },
                    {
                        type: 'toolCall',
                        id: 'call_edit_1',
                        name: 'edit',
                        arguments: { path: 'src/app.ts' },
                    },
                ],
            }),
            toolResult('t0_bash', 'call_bash_1', longToolTailError, 'bash'),
            toolResult('t0_edit', 'call_edit_1', 'edited src/app.ts', 'edit'),
            assistant('a1', 'I see the failure', { model: model.id }),
            user('u2', 'Now fix the issue in src/app.ts'),
            assistant('a2', 'Working on fix', { model: model.id }),
        ]

        const { client, calls } = makeClient((call) => {
            // Cached path keeps the session's systemPrompt, developerPrompt, tools, and sessionId cache key!
            expect(call.input.systemPrompt).toBe('Session system prompt')
            expect(call.input.developerPrompt).toBe('Session dev prompt')
            expect(call.input.tools).toEqual([sampleTool])
            expect(call.input.toolChoice).toBe('none')
            expect(call.options?.connectionMode).toBe('isolated')
            expect(call.options?.promptCacheKey).toBe('s1')

            // Full tool result (>2000 chars) is preserved in the structured entries without truncation!
            const bashResultEntry = call.input.entries.find(
                (e) => e.kind === 'toolResult' && e.id === 't0_bash',
            ) as ToolResultEntry | undefined
            expect(bashResultEntry).toBeDefined()
            expect(
                bashResultEntry!.content[0]?.type === 'text'
                    ? bashResultEntry!.content[0].text
                    : '',
            ).toContain('FAIL: assertion failed at line 999')

            // Last entry is the synthetic user summary instruction with <kept-start>.
            const lastEntry = call.input.entries[call.input.entries.length - 1]
            expect(lastEntry?.kind).toBe('user')
            const instructionText =
                lastEntry?.kind === 'user' && lastEntry.content[0]?.type === 'text'
                    ? lastEntry.content[0].text
                    : ''
            expect(instructionText).toContain('<kept-start>')
            expect(instructionText).toContain('Now fix the issue in src/app.ts')

            // Even if the model echoes an old <read-files> tag, sanitizeSummaryBody strips it before appending authoritative lists.
            return assistant(
                'cached-sum',
                validSummary() + '\n\n<read-files>\nstale.ts\n</read-files>',
                {
                    model: model.id,
                    usage: usage(500, { input: 10, cacheRead: 470, output: 20 }),
                },
            )
        })

        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            fastContextCompaction: false,
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 },
            cachedContext: {
                systemPrompt: 'Session system prompt',
                developerPrompt: 'Session dev prompt',
                tools: [sampleTool],
                modelId: model.id,
                requestEntries: entries.slice(0, 5),
                lastCachedAt: 100,
                cacheExpiresAt: 60_000,
            },
            now: () => 1_000,
        })

        expect(calls).toHaveLength(1)
        expect(result.entry.usage?.cacheRead).toBe(470)
        expect(result.entry.modifiedFiles).toEqual(['src/app.ts'])
        expect(result.entry.summary).not.toContain('stale.ts')
        expect(result.entry.summary).toContain('<modified-files>\nsrc/app.ts\n</modified-files>')
        expect(stripFileOperationTags('hello\n\n<read-files>\na.ts\n</read-files>')).toBe('hello')
    })

    it('omits toolChoice on Claude/Anthropic models to preserve Anthropic tool cache prefix', () => {
        expect(shouldDisableToolsForCachedSummary('gpt-6.1-sol', [sampleTool])).toBe(true)
        expect(shouldDisableToolsForCachedSummary('claude-opus-4-6', [sampleTool])).toBe(false)
        expect(shouldDisableToolsForCachedSummary('gpt-6.1-sol', [])).toBe(false)
    })

    it('falls back cleanly to isolated compaction when cached summary calls a tool or fails validation', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000), { model: model.id }),
            user('u1', 'H'.repeat(20_000)),
            assistant('a1', 'A'.repeat(20_000), { model: model.id }),
            user('u2', 'recent question'),
            assistant('a2', 'recent answer', { model: model.id }),
        ]

        const { client, calls } = makeClient((call) => {
            if (call.options?.promptCacheKey === 's1') {
                // First call is cached path -> simulate model attempting to call a tool.
                return assistant('bad-cached', '', {
                    model: model.id,
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'tc_1',
                            name: 'bash',
                            arguments: { command: 'ls' },
                        },
                    ],
                })
            }
            // Subsequent call(s) use the isolated fallback path!
            expect(call.input.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT)
            expect(call.input.tools).toEqual([])
            expect(call.options?.promptCacheKey).not.toBe('s1')
            const isPrefix = promptTextOf(call).includes('PREFIX of a turn')
            return assistant(
                isPrefix ? 'isolated-prefix-ok' : 'isolated-ok',
                isPrefix ? validTurnPrefix('from-fallback') : validSummary('from-fallback'),
                {
                    model: model.id,
                    usage: usage(42),
                },
            )
        })

        const result = await compactConversation(entries, {
            client,
            model,
            sessionId: 's1',
            fastContextCompaction: false,
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 },
            cachedContext: {
                systemPrompt: 'Session system prompt',
                tools: [sampleTool],
                modelId: model.id,
                requestEntries: entries.slice(0, 4),
                lastCachedAt: 100,
                cacheExpiresAt: 60_000,
            },
            now: () => 1_000,
            summaryRetryDelaysMs: [],
        })

        expect(calls).toHaveLength(2)
        expect(calls[0]!.options?.promptCacheKey).toBe('s1')
        expect(calls[1]!.options?.promptCacheKey).not.toBe('s1')
        expect(result.entry.summary).toContain('from-fallback')
    })

    it('uses legacy isolated compaction directly when fastContextCompaction is enabled even with valid cachedContext', async () => {
        const entries: ConversationEntry[] = [
            user('u0', 'H'.repeat(20_000)),
            assistant('a0', 'A'.repeat(20_000), { model: model.id }),
            user('u1', 'recent question'),
            assistant('a1', 'recent answer', { model: model.id }),
        ]

        const { client, calls } = makeClient((call) => {
            expect(call.input.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT)
            expect(call.input.tools).toEqual([])
            expect(call.options?.promptCacheKey).not.toBe('s1')
            expect(call.input.reasoningEffort).toBe('low')
            const isPrefix = promptTextOf(call).includes('PREFIX of a turn')
            return assistant(
                isPrefix ? 'legacy-prefix' : 'legacy-isolated',
                isPrefix ? validTurnPrefix('from-legacy-fast') : validSummary('from-legacy-fast'),
                {
                    model: model.id,
                    usage: usage(50),
                },
            )
        })

        const result = await compactConversation(entries, {
            client,
            model: {
                ...model,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low' },
                    { id: 'xhigh', requestValue: 'xhigh' },
                ],
            },
            sessionId: 's1',
            reasoningEffort: 'xhigh',
            fastContextCompaction: true,
            settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 5 },
            cachedContext: {
                systemPrompt: 'Session system prompt',
                developerPrompt: 'Session dev prompt',
                tools: [sampleTool],
                modelId: model.id,
                requestEntries: entries.slice(0, 2),
                lastCachedAt: 100,
                cacheExpiresAt: 60_000,
            },
            now: () => 1_000,
        })

        expect(calls.length).toBeGreaterThanOrEqual(1)
        expect(result.entry.summary).toContain('from-legacy-fast')
    })
})
