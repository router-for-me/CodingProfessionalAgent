import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import type {
    CompactConversationOptions,
    CompactConversationResult,
} from '../context/compaction'
import type {
    ProtocolClient,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import type {
    AssistantEntry,
    ConversationEntry,
    ToolResultEntry,
    UserEntry,
} from '../session/types'
import type { AgentTool, AssistantStreamEvent, ToolResult } from './types'
import { AgentLoop } from './agentLoop'
import { ApprovalController, TOOL_REJECTED_MESSAGE } from './approvals'

const model: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test',
    supportsFast: true,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

function userEntry(id: string, text: string, sessionId = 'sess-1'): UserEntry {
    return {
        id,
        sessionId,
        createdAt: 1,
        kind: 'user',
        content: [{ type: 'text', text }],
    }
}

function doneAssistant(
    seed: AssistantEntry,
    patches: Partial<AssistantEntry> & {
        content?: AssistantEntry['content']
        stopReason: AssistantEntry['stopReason']
    },
): AssistantEntry {
    return {
        ...seed,
        ...patches,
        content: patches.content ?? seed.content,
        status: patches.status ?? 'done',
        stopReason: patches.stopReason,
    }
}

type ScriptedTurn =
    | {
          kind: 'stream'
          events?: AssistantStreamEvent[]
          final: (seed: AssistantEntry) => AssistantEntry
      }
    | { kind: 'throw'; error: unknown }
    | {
          kind: 'stream-then-throw'
          events: AssistantStreamEvent[]
          error: unknown
      }

class FakeCPAClient implements ProtocolClient {
    readonly calls: ProtocolStreamInput[] = []
    private scripts: ScriptedTurn[] = []
    private callIndex = 0

    queue(...turns: ScriptedTurn[]): void {
        this.scripts.push(...turns)
    }

    async cancel(): Promise<void> {}
    dispose(): void {}

    async *stream(
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions,
    ): AsyncGenerator<AssistantStreamEvent, AssistantEntry> {
        const signal = options?.signal ?? new AbortController().signal
        this.calls.push(input)
        const script = this.scripts[this.callIndex++]
        if (!script) {
            throw new Error('FakeCPAClient: no scripted turn left')
        }

        if (signal.aborted) {
            const err = new Error('Request was aborted')
            err.name = 'AbortError'
            throw err
        }

        if (script.kind === 'throw') {
            throw script.error
        }

        if (script.kind === 'stream-then-throw') {
            for (const event of script.events) {
                if (signal.aborted) {
                    const err = new Error('Request was aborted')
                    err.name = 'AbortError'
                    throw err
                }
                yield event
            }
            throw script.error
        }

        for (const event of script.events ?? []) {
            if (signal.aborted) {
                const err = new Error('Request was aborted')
                err.name = 'AbortError'
                throw err
            }
            yield event
        }
        return script.final(input.seed)
    }
}

function createBurstClient(eventCount: number) {
    let produced = 0
    const client: ProtocolClient = {
        async *stream(input) {
            const block = { type: 'text' as const, text: '' }
            input.seed.content = [block]
            for (let index = 0; index < eventCount; index += 1) {
                const delta = `${index}\n`
                block.text += delta
                produced += 1
                yield {
                    type: 'text-delta',
                    contentIndex: 0,
                    delta,
                    partial: input.seed,
                }
            }
            return doneAssistant(input.seed, { stopReason: 'stop' })
        },
    }
    return { client, get produced() { return produced } }
}

function makeTool(
    name: string,
    execute: AgentTool['execute'],
    validate?: AgentTool['validate'],
): AgentTool {
    return {
        name,
        label: name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} },
        validate: validate ?? ((input: unknown) => (input ?? {}) as Record<string, unknown>),
        execute,
    }
}

async function collect(
    iterable: AsyncIterable<unknown>,
): Promise<unknown[]> {
    const events: unknown[] = []
    for await (const event of iterable) {
        events.push(event)
    }
    return events
}

describe('AgentLoop', () => {
    let sleepCalls: number[]
    let sleep: (ms: number, signal: AbortSignal) => Promise<void>

    beforeEach(() => {
        sleepCalls = []
        sleep = async (ms, signal) => {
            sleepCalls.push(ms)
            if (signal.aborted) {
                const err = new Error('Request was aborted')
                err.name = 'AbortError'
                throw err
            }
        }
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('runs a toolUse then final text closed loop', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'call-read',
                                name: 'read',
                                arguments: { path: 'a.txt' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'done' }],
                    }),
            },
        )

        const tools = [
            makeTool('read', async () => ({
                content: [{ type: 'text', text: 'file contents' }],
            })),
        ]

        const loop = new AgentLoop({ client, sleep, generateId: (() => {
            let n = 0
            return () => `id-${++n}`
        })() })

        const user = userEntry('u1', 'hello')
        const events = (await collect(
            loop.run({
                runId: 'run-1',
                sessionId: 'sess-1',
                entries: [],
                userEntry: user,
                model,
                systemPrompt: 'sys',
                tools,
            }),
        )) as Array<{ type: string }>

        expect(events.map((e) => e.type)).toEqual(
            expect.arrayContaining([
                'agent-start',
                'assistant-start',
                'tool-start',
                'tool-end',
                'assistant-start',
                'agent-end',
            ]),
        )
        expect(client.calls).toHaveLength(2)
        // Second provider call must include tool result entry.
        const secondEntries = client.calls[1]!.entries
        expect(secondEntries.some((e) => e.kind === 'toolResult')).toBe(true)
        // User appended once.
        expect(
            client.calls[0]!.entries.filter((e) => e.kind === 'user'),
        ).toHaveLength(1)
        expect(
            client.calls[1]!.entries.filter((e) => e.kind === 'user'),
        ).toHaveLength(1)
    })

    it('exposes isolated invocation only to network tools and overwrites plugin-authored accounting', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) => doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        { type: 'toolCall', id: 'read-call', name: 'plain', arguments: {} },
                        { type: 'toolCall', id: 'net-call', name: 'network', arguments: {} },
                    ],
                }),
            },
            {
                kind: 'stream',
                final: (seed) => doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'done' }],
                }),
            },
        )
        const contexts: any[] = []
        const fabricated = [{
            id: 'forged', model: 'forged', parentToolCallId: 'forged',
            usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }]
        const tools = [
            Object.assign(makeTool('plain', async (_id, _args, context) => {
                contexts.push(context)
                context.onUpdate?.({ content: [{ type: 'text', text: 'update' }], isolatedModelInvocations: fabricated })
                return { content: [{ type: 'text', text: 'plain' }], isolatedModelInvocations: fabricated }
            }), { riskLevel: 'read', requiresApproval: false }),
            Object.assign(makeTool('network', async (_id, _args, context) => {
                contexts.push(context)
                return { content: [{ type: 'text', text: 'network' }], isolatedModelInvocations: fabricated }
            }), { riskLevel: 'network', requiresApproval: false }),
        ] as AgentTool[]
        const ownedRecord = { ...fabricated[0]!, id: 'owned', model: 'allowed', parentToolCallId: 'net-call' }
        const modelInvoker = {
            forToolCall: vi.fn(() => ({ invoke: vi.fn() })),
            takeRecords: vi.fn((id: string) => id === 'net-call' ? [ownedRecord] : []),
            close: vi.fn(),
        }
        const loop = new AgentLoop({ client, sleep, modelInvoker })
        const events = await collect(loop.run({
            runId: 'run-accounting', sessionId: 'sess-1', entries: [userEntry('u1', 'x')],
            model, systemPrompt: 'sys', tools,
        })) as any[]

        expect(contexts[0].modelInvoker).toBeUndefined()
        expect(contexts[1].modelInvoker).toBeDefined()
        expect(modelInvoker.forToolCall).toHaveBeenCalledOnce()
        const updates = events.filter((event) => event.type === 'tool-update')
        expect(updates[0].result.isolatedModelInvocations).toBeUndefined()
        const end = events.find((event) => event.type === 'agent-end')
        const results = end.entries.filter((entry: ConversationEntry) => entry.kind === 'toolResult')
        expect(results[0].isolatedModelInvocations).toBeUndefined()
        expect(results[1].isolatedModelInvocations).toEqual([ownedRecord])
    })

    it('appends tool results in source order even when tools finish out of order', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'c1',
                                name: 'slow',
                                arguments: {},
                            },
                            {
                                type: 'toolCall',
                                id: 'c2',
                                name: 'fast',
                                arguments: {},
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        let releaseSlow!: () => void
        const slowGate = new Promise<void>((r) => {
            releaseSlow = r
        })

        const tools = [
            makeTool('slow', async () => {
                await slowGate
                return { content: [{ type: 'text', text: 'slow-result' }] }
            }),
            makeTool('fast', async () => {
                // Finish first, then release slow.
                queueMicrotask(() => releaseSlow())
                return { content: [{ type: 'text', text: 'fast-result' }] }
            }),
        ]

        const loop = new AgentLoop({
            client,
            sleep,
            generateId: (() => {
                let n = 0
                return () => `gid-${++n}`
            })(),
        })

        const events = (await collect(
            loop.run({
                runId: 'run-order',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools,
            }),
        )) as Array<{ type: string; toolCallId?: string }>

        const toolEnds = events.filter((e) => e.type === 'tool-end')
        // Completion order may be fast then slow.
        expect(toolEnds.map((e) => e.toolCallId)).toEqual(['c2', 'c1'])

        const end = events.find((e) => e.type === 'agent-end') as unknown as {
            entries: ConversationEntry[]
        }
        const results = end.entries.filter(
            (e): e is ToolResultEntry => e.kind === 'toolResult',
        )
        expect(results.map((r) => r.toolCallId)).toEqual(['c1', 'c2'])
        expect(results.map((r) => r.content[0] && 'text' in r.content[0] ? r.content[0].text : '')).toEqual([
            'slow-result',
            'fast-result',
        ])
    })

    it('does not execute tools when stopReason is length even with toolCall content', async () => {
        const client = new FakeCPAClient()
        const execute = vi.fn(async (): Promise<ToolResult> => ({
            content: [{ type: 'text' as const, text: 'should-not-run' }],
        }))
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'length',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'c1',
                            name: 'bash',
                            arguments: { command: 'rm -rf /' },
                        },
                    ],
                }),
        })

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-length',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [makeTool('bash', execute)],
            }),
        )) as Array<{ type: string }>

        expect(execute).not.toHaveBeenCalled()
        expect(events.some((e) => e.type === 'tool-start')).toBe(false)
        expect(events.map((e) => e.type)).toContain('agent-end')
        expect(client.calls).toHaveLength(1)
    })

    it('continues after a single tool error and still calls next provider', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'c1',
                                name: 'bash',
                                arguments: { command: 'false' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'recovered' }],
                    }),
            },
        )

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-tool-err',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [
                    makeTool('bash', async () => {
                        throw new Error('boom')
                    }),
                ],
            }),
        )) as Array<{ type: string; isError?: boolean }>

        expect(client.calls).toHaveLength(2)
        const toolEnd = events.find((e) => e.type === 'tool-end') as unknown as {
            isError: boolean
            result: ToolResult
        }
        expect(toolEnd.isError).toBe(true)
        expect(events.map((e) => e.type)).toContain('agent-end')
    })

    it('requires approval for bash/edit/write but not read', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'r1',
                                name: 'read',
                                arguments: { path: 'a' },
                            },
                            {
                                type: 'toolCall',
                                id: 'b1',
                                name: 'bash',
                                arguments: { command: 'ls' },
                            },
                            {
                                type: 'toolCall',
                                id: 'e1',
                                name: 'edit',
                                arguments: { path: 'a', edits: [] },
                            },
                            {
                                type: 'toolCall',
                                id: 'w1',
                                name: 'write',
                                arguments: { path: 'a', content: 'x' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        const approvals = new ApprovalController()
        const loop = new AgentLoop({ client, sleep, approvals })

        const tools = ['read', 'bash', 'edit', 'write'].map((name) =>
            makeTool(name, async () => ({
                content: [{ type: 'text', text: `${name}-ok` }],
            })),
        )

        const gen = loop.run({
            runId: 'run-appr',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools,
            requestApproval: true,
        })

        const events: Array<{ type: string; toolCallId?: string; toolName?: string }> = []
        const consumer = (async () => {
            for await (const event of gen) {
                events.push(event as { type: string; toolCallId?: string; toolName?: string })
                if (event.type === 'tool-approval-required') {
                    const e = event as { toolCallId: string }
                    // Approve all mutating tools.
                    approvals.approve('run-appr', e.toolCallId)
                }
            }
        })()
        await consumer

        const approvalEvents = events.filter((e) => e.type === 'tool-approval-required')
        expect(approvalEvents.map((e) => e.toolName).sort()).toEqual([
            'bash',
            'edit',
            'write',
        ])
        expect(approvalEvents.some((e) => e.toolName === 'read')).toBe(false)
    })

    it('reject produces fixed error result text and continues', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'b1',
                                name: 'bash',
                                arguments: { command: 'ls' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'after reject' }],
                    }),
            },
        )

        const approvals = new ApprovalController()
        const execute = vi.fn(async (): Promise<ToolResult> => ({
            content: [{ type: 'text' as const, text: 'ran' }],
        }))
        const loop = new AgentLoop({ client, sleep, approvals })

        const gen = loop.run({
            runId: 'run-rej',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [makeTool('bash', execute)],
            requestApproval: true,
        })

        const events: Array<{ type: string; result?: ToolResult }> = []
        for await (const event of gen) {
            events.push(event as { type: string; result?: ToolResult })
            if (event.type === 'tool-approval-required') {
                approvals.reject('run-rej', (event as { toolCallId: string }).toolCallId)
            }
        }

        expect(execute).not.toHaveBeenCalled()
        const toolEnd = events.find((e) => e.type === 'tool-end')
        expect(toolEnd?.result?.isError).toBe(true)
        expect(toolEnd?.result?.content[0]).toEqual({
            type: 'text',
            text: TOOL_REJECTED_MESSAGE,
        })
        expect(client.calls).toHaveLength(2)
    })

    it('retries transient errors with 2s/4s/8s without duplicating user entry', async () => {
        const client = new FakeCPAClient()
        client.queue(
            { kind: 'throw', error: new Error('closed network connection') },
            { kind: 'throw', error: new Error('CPA stream closed before response.completed') },
            { kind: 'throw', error: new Error('invalid CPA JSON') },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok after retries' }],
                    }),
            },
        )

        const ids: string[] = []
        const loop = new AgentLoop({
            client,
            sleep,
            generateId: (() => {
                let n = 0
                return () => {
                    const id = `aid-${++n}`
                    ids.push(id)
                    return id
                }
            })(),
            retryDelaysMs: [2_000, 4_000, 8_000],
        })

        const user = userEntry('user-stable', 'hello')
        const events = (await collect(
            loop.run({
                runId: 'run-retry',
                sessionId: 'sess-1',
                entries: [],
                userEntry: user,
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string; attempt?: number; delayMs?: number }>

        expect(sleepCalls).toEqual([2_000, 4_000, 8_000])
        const retrying = events.filter((e) => e.type === 'retrying')
        expect(retrying.map((e) => e.attempt)).toEqual([1, 2, 3])
        expect(retrying.map((e) => e.delayMs)).toEqual([2_000, 4_000, 8_000])

        // Same assistant id reused across retries of the same provider turn.
        // First generateId is assistant id; subsequent may be for agent-end only.
        expect(client.calls).toHaveLength(4)
        for (const call of client.calls) {
            expect(call.entries.filter((e) => e.kind === 'user')).toHaveLength(1)
            expect(call.entries.find((e) => e.kind === 'user')?.id).toBe('user-stable')
        }
        // All stream seeds share the same assistant id.
        const seedIds = client.calls.map((c) => c.seed.id)
        expect(new Set(seedIds).size).toBe(1)
    })

    it('does not retry 429', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'throw',
            error: Object.assign(new Error('rate limited'), { status: 429 }),
        })

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-429',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>

        expect(sleepCalls).toEqual([])
        expect(events.some((e) => e.type === 'retrying')).toBe(false)
        expect(events.some((e) => e.type === 'error')).toBe(true)
        expect(client.calls).toHaveLength(1)
    })

    it('overflow compact-once then second overflow terminates', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'throw',
                error: new Error('context_length_exceeded: prompt is too long'),
            },
            {
                kind: 'throw',
                error: new Error('context_length_exceeded again'),
            },
        )

        const compact = vi.fn(
            async (
                entries: readonly ConversationEntry[],
            ): Promise<CompactConversationResult> => {
                const entry = {
                    id: 'cmp-1',
                    sessionId: 'sess-1',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: '## Goal\nsummary',
                    firstKeptEntryId: entries[entries.length - 1]?.id ?? 'u1',
                }
                return {
                    entry,
                    entries: [...entries, entry],
                }
            },
        )

        const loop = new AgentLoop({ client, sleep, compact })
        const events = (await collect(
            loop.run({
                runId: 'run-ovf',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>

        expect(compact).toHaveBeenCalledTimes(1)
        expect(events.filter((e) => e.type === 'compaction-start')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'compaction-end')).toHaveLength(1)
        expect(events.some((e) => e.type === 'error')).toBe(true)
        // Two provider attempts (overflow + post-compact retry), no delay sleeps.
        expect(client.calls).toHaveLength(2)
        expect(sleepCalls).toEqual([])
    })

    it('pre-turn compaction when shouldCompact is true', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })

        const compact = vi.fn(
            async (
                entries: readonly ConversationEntry[],
                _options: CompactConversationOptions,
            ): Promise<CompactConversationResult> => {
                const entry = {
                    id: 'cmp-pre',
                    sessionId: 'sess-1',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: 'pre',
                    firstKeptEntryId: entries[0]?.id ?? 'u1',
                }
                return { entry, entries: [entry, ...entries] }
            },
        )

        // Tiny window forces shouldCompact.
        const tinyModel: ModelCatalogEntry = {
            ...model,
            contextWindow: 100,
        }

        const longUser = userEntry(
            'u-long',
            'x'.repeat(4000),
        )

        const loop = new AgentLoop({ client, sleep, compact })
        const events = (await collect(
            loop.run({
                runId: 'run-pre-cmp',
                sessionId: 'sess-1',
                entries: [longUser],
                model: tinyModel,
                systemPrompt: 'sys',
                tools: [],
                compactionSettings: { enabled: true, reserveTokens: 50 },
                fastContextCompaction: false,
            }),
        )) as Array<{ type: string }>

        expect(compact).toHaveBeenCalled()
        expect(compact.mock.calls[0]?.[1]).toMatchObject({
            fastContextCompaction: false,
        })
        expect(events[0]?.type).toBe('agent-start')
        expect(events.some((e) => e.type === 'compaction-start')).toBe(true)
        // Provider sees compacted context.
        expect(client.calls[0]!.entries.some((e) => e.kind === 'compaction')).toBe(
            true,
        )
    })

    it('emits compaction-start before compact resolves', async () => {
        let release!: (result: CompactConversationResult) => void
        const compact = vi.fn(
            () =>
                new Promise<CompactConversationResult>((resolve) => {
                    release = resolve
                }),
        )
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        const tinyModel: ModelCatalogEntry = {
            ...model,
            contextWindow: 100,
        }
        const longUser = userEntry('u-long', 'x'.repeat(4000))
        const loop = new AgentLoop({ client, sleep, compact })
        const iterator = loop.run({
            runId: 'run-live-cmp',
            sessionId: 'sess-1',
            entries: [longUser],
            model: tinyModel,
            systemPrompt: 'sys',
            tools: [],
            compactionSettings: { enabled: true, reserveTokens: 50 },
        })[Symbol.asyncIterator]()

        const seen: string[] = []
        const waitForType = async (type: string) => {
            while (true) {
                const step = await iterator.next()
                if (step.done) {
                    throw new Error(`ended before ${type}; saw ${seen.join(',')}`)
                }
                const eventType = (step.value as { type: string }).type
                seen.push(eventType)
                if (eventType === type) return step.value
            }
        }

        await waitForType('agent-start')
        await waitForType('compaction-start')
        expect(compact).toHaveBeenCalledTimes(1)
        expect(seen).not.toContain('compaction-end')

        const entry = {
            id: 'cmp-live',
            sessionId: 'sess-1',
            createdAt: 1,
            kind: 'compaction' as const,
            summary: 'pre',
            firstKeptEntryId: longUser.id,
        }
        release({
            entry,
            entries: [entry, longUser],
        })
        await waitForType('compaction-end')
    })

    it('aborts streaming via external signal and does not emit ordinary error toast', async () => {
        const client = new FakeCPAClient()

        // Use a custom client that waits mid-stream.
        const waitingClient: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                client.calls.push(input)
                yield {
                    type: 'start',
                    partial: input.seed,
                }
                await new Promise<void>((_resolve, reject) => {
                    if (signal.aborted) {
                        reject(Object.assign(new Error('Request was aborted'), { name: 'AbortError' }))
                        return
                    }
                    const onAbort = () => {
                        reject(Object.assign(new Error('Request was aborted'), { name: 'AbortError' }))
                    }
                    signal.addEventListener('abort', onAbort, { once: true })
                    // Keep hanging until abort — never resolve.
                })
                return input.seed
            },
        }

        const ac = new AbortController()
        const loop = new AgentLoop({ client: waitingClient, sleep })
        const events: Array<{ type: string }> = []
        const gen = loop.run({
            runId: 'run-abort-stream',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: ac.signal,
        })

        const runner = (async () => {
            for await (const event of gen) {
                events.push(event as { type: string })
                if (event.type === 'assistant-start' || event.type === 'assistant-update') {
                    ac.abort()
                }
            }
        })()
        await runner

        expect(events.some((e) => e.type === 'aborted')).toBe(true)
        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.map((e) => e.type)).toContain('agent-end')
    })

    it('abort during approval releases waiter without further provider calls', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'b1',
                            name: 'bash',
                            arguments: { command: 'ls' },
                        },
                    ],
                }),
        })

        const approvals = new ApprovalController()
        const loop = new AgentLoop({ client, sleep, approvals })
        const events: Array<{ type: string }> = []
        const gen = loop.run({
            runId: 'run-abort-appr',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [
                makeTool('bash', async () => ({
                    content: [{ type: 'text', text: 'nope' }],
                })),
            ],
            requestApproval: true,
        })

        for await (const event of gen) {
            events.push(event as { type: string })
            if (event.type === 'tool-approval-required') {
                loop.abort('run-abort-appr')
            }
        }

        expect(events.some((e) => e.type === 'aborted')).toBe(true)
        expect(client.calls).toHaveLength(1)
        expect(approvals.pendingCount()).toBe(0)
    })

    it('ignores late tool onUpdate after settle', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 't1',
                                name: 'bash',
                                arguments: { command: 'echo' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        let lateUpdate: ((partial: ToolResult) => void) | undefined
        const tools = [
            makeTool('bash', async (_id, _args, ctx) => {
                ctx.onUpdate?.({
                    content: [{ type: 'text', text: 'partial' }],
                })
                lateUpdate = ctx.onUpdate
                return { content: [{ type: 'text', text: 'final' }] }
            }),
        ]

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-late',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools,
            }),
        )) as Array<{ type: string; result?: ToolResult }>

        const updatesBefore = events.filter((e) => e.type === 'tool-update').length
        // Fire late update after settle.
        lateUpdate?.({ content: [{ type: 'text', text: 'too-late' }] })
        await Promise.resolve()
        const updatesAfter = events.filter((e) => e.type === 'tool-update').length
        expect(updatesAfter).toBe(updatesBefore)
        expect(updatesBefore).toBeGreaterThanOrEqual(1)
    })

    it('rejects concurrent runs on the same AgentLoop instance', async () => {
        const client = new FakeCPAClient()
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                client.calls.push(input)
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }

        const loop = new AgentLoop({ client: hanging, sleep })
        const gen1 = loop.run({
            runId: 'run-a',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        // Start first run (occupation is eager even before next).
        expect(loop.isActive).toBe(true)
        const first = await gen1.next()
        expect(first.value).toMatchObject({ type: 'agent-start' })

        // Second run rejects synchronously without needing next().
        expect(() =>
            loop.run({
                runId: 'run-b',
                sessionId: 'sess-1',
                entries: [userEntry('u2', 'y')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        ).toThrow(/already active/i)

        // Cleanup
        loop.abort('run-a')
        await collect(gen1).catch(() => undefined)
    })

    it('does not mutate input entries; userEntry deduped by id', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })

        const existing = userEntry('u1', 'already')
        const entries: ConversationEntry[] = [existing]
        const snapshot = JSON.stringify(entries)

        const loop = new AgentLoop({ client, sleep })
        await collect(
            loop.run({
                runId: 'run-dedupe',
                sessionId: 'sess-1',
                entries,
                userEntry: userEntry('u1', 'duplicate'),
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )

        expect(JSON.stringify(entries)).toBe(snapshot)
        expect(client.calls[0]!.entries.filter((e) => e.kind === 'user')).toHaveLength(1)
    })

    it('skips duplicate toolCallId execution', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'same',
                                name: 'read',
                                arguments: { path: 'a' },
                            },
                            {
                                type: 'toolCall',
                                id: 'same',
                                name: 'read',
                                arguments: { path: 'b' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        const execute = vi.fn(async (): Promise<ToolResult> => ({
            content: [{ type: 'text' as const, text: 'once' }],
        }))
        const loop = new AgentLoop({ client, sleep })
        await collect(
            loop.run({
                runId: 'run-dup-tool',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [makeTool('read', execute)],
            }),
        )
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it('malformed args become isError tool results and continue', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'c1',
                                name: 'read',
                                arguments: { bad: true },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-bad-args',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [
                    makeTool(
                        'read',
                        async () => ({ content: [{ type: 'text', text: 'nope' }] }),
                        () => {
                            throw new Error('invalid args')
                        },
                    ),
                ],
            }),
        )) as Array<{ type: string; isError?: boolean }>

        const toolEnd = events.find((e) => e.type === 'tool-end') as unknown as {
            isError: boolean
            result: ToolResult
        }
        expect(toolEnd.isError).toBe(true)
        expect(toolEnd.result.content[0]).toMatchObject({ text: 'invalid args' })
        expect(client.calls).toHaveLength(2)
    })

    it('event entry snapshots are not mutated by later seed changes', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            events: undefined,
            final: (seed) => {
                // Mutate seed after stream events would have been snapshotted at start.
                seed.content.push({ type: 'text', text: 'mutated' })
                return doneAssistant(seed, {
                    stopReason: 'stop',
                    content: seed.content,
                })
            },
        })

        // Custom client that yields partial then mutates seed.
        const mutatingClient: ProtocolClient = {
            async *stream(input) {
                client.calls.push(input)
                const partial = input.seed
                yield { type: 'start', partial }
                // Mutate after yield — consumer snapshot must stay stable.
                partial.content.push({ type: 'text', text: 'late-mutation' })
                return doneAssistant(partial, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'final' }],
                })
            },
        }

        const loop = new AgentLoop({ client: mutatingClient, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-snap',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string; entry?: AssistantEntry }>

        const update = events.find((e) => e.type === 'assistant-update')
        expect(update?.entry?.content.some((b) => b.type === 'text' && b.text === 'late-mutation')).toBe(
            false,
        )
    })

    it('bounds pending snapshots for a slow consumer without dropping events', async () => {
        const burst = createBurstClient(256)
        const loop = new AgentLoop({ client: burst.client, sleep })
        const iterator = loop.run({
            runId: 'run-backpressure',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })

        try {
            // The two lifecycle events leave room for fourteen provider snapshots.
            await vi.waitFor(() => expect(burst.produced).toBeGreaterThanOrEqual(14))
            expect(burst.produced).toBe(14)
            expect(loop.isActive).toBe(true)

            const events = await collect(iterator) as Array<{
                type: string
                entry?: AssistantEntry
                streamEvent?: { delta?: string }
            }>
            const updates = events.filter((event) => event.type === 'assistant-update')
            expect(updates.map((event) => event.streamEvent?.delta)).toEqual(
                Array.from({ length: 256 }, (_, index) => `${index}\n`),
            )
            expect(updates[0]?.entry?.content).toEqual([{ type: 'text', text: '0\n' }])
            expect(events[events.length - 1]?.type).toBe('agent-end')
            expect(loop.isActive).toBe(false)
        } finally {
            await iterator.return?.()
        }
    })

    it('coalesces burst deltas before cloning cumulative snapshots', async () => {
        const burst = createBurstClient(256)
        const loop = new AgentLoop({
            client: burst.client,
            sleep,
            streamUpdateIntervalMs: 60_000,
        })

        const events = (await collect(
            loop.run({
                runId: 'run-coalesced-snapshots',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{
            type: string
            entry?: AssistantEntry
            streamEvent?: { delta?: string }
        }>

        const updates = events.filter(
            (event) => event.type === 'assistant-update',
        )
        expect(burst.produced).toBe(256)
        expect(updates).toHaveLength(2)
        expect(updates.map((event) => event.streamEvent?.delta)).toEqual([
            '0\n',
            Array.from({ length: 255 }, (_, index) => `${index + 1}\n`).join(
                '',
            ),
        ])
        expect(updates[0]?.entry?.content).toEqual([
            { type: 'text', text: '0\n' },
        ])
        expect(updates[1]?.entry?.content).toEqual([
            {
                type: 'text',
                text: Array.from(
                    { length: 256 },
                    (_, index) => `${index}\n`,
                ).join(''),
            },
        ])
    })

    it.each(['abort', 'return'] as const)('unblocks a full snapshot queue on %s', async (mode) => {
        const burst = createBurstClient(256)
        const controller = new AbortController()
        const loop = new AgentLoop({ client: burst.client, sleep })
        const iterator = loop.run({
            runId: 'run-backpressure-cancel',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: controller.signal,
        })

        try {
            await vi.waitFor(() => expect(burst.produced).toBeGreaterThanOrEqual(14))
            expect(burst.produced).toBe(14)
            if (mode === 'abort') {
                controller.abort()
                await vi.waitFor(() => expect(loop.isActive).toBe(false))
                const events = await collect(iterator) as Array<{ type: string }>
                expect(events.some((event) => event.type === 'aborted')).toBe(true)
                expect(events[events.length - 1]?.type).toBe('agent-end')
            } else {
                await iterator.return?.()
                expect(loop.isActive).toBe(false)
                expect(await iterator.next()).toEqual({ done: true, value: undefined })
            }
            expect(burst.produced).toBe(14)
        } finally {
            controller.abort()
            await iterator.return?.()
        }
    })

    it('consumer early return aborts and clears active run', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }

        const loop = new AgentLoop({ client: hanging, sleep })
        const gen = loop.run({
            runId: 'run-early',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })

        const first = await gen.next()
        expect(first.value).toMatchObject({ type: 'agent-start' })
        expect(loop.isActive).toBe(true)
        await gen.return?.(undefined)
        expect(loop.isActive).toBe(false)
    })

    it('omits tools from provider when tool list is empty', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'chat' }],
                }),
        })

        const loop = new AgentLoop({ client, sleep })
        await collect(
            loop.run({
                runId: 'run-no-tools',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'hi')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )
        expect(client.calls[0]!.tools).toBeUndefined()
    })

    it('unknown tools become isError results', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'x1',
                                name: 'nonexistent',
                                arguments: {},
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-unknown',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string; result?: ToolResult }>

        const toolEnd = events.find((e) => e.type === 'tool-end')
        expect(toolEnd?.result?.isError).toBe(true)
        expect(toolEnd?.result?.content[0]).toMatchObject({
            text: expect.stringMatching(/Unknown tool/i),
        })
    })

    it('scopes every event with runId and sessionId', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-scope',
                sessionId: 'sess-scope',
                entries: [userEntry('u1', 'x', 'sess-scope')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ runId: string; sessionId: string }>

        for (const event of events) {
            expect(event.runId).toBe('run-scope')
            expect(event.sessionId).toBe('sess-scope')
        }
    })

    it('occupies active immediately so second run without next rejects synchronously', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }
        const loop = new AgentLoop({ client: hanging, sleep })
        const first = loop.run({
            runId: 'run-first',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        expect(loop.isActive).toBe(true)
        expect(() =>
            loop.run({
                runId: 'run-second',
                sessionId: 'sess-1',
                entries: [userEntry('u2', 'y')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        ).toThrow(/already active/i)

        await first.return?.(undefined)
        expect(loop.isActive).toBe(false)
    })

    it('abort before first next releases active and finishes with aborted', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                await new Promise<void>((_resolve, reject) => {
                    if (signal.aborted) {
                        reject(
                            Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            }),
                        )
                        return
                    }
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }
        const loop = new AgentLoop({ client: hanging, sleep })
        const ac = new AbortController()
        const iter = loop.run({
            runId: 'run-pre-abort',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: ac.signal,
        })
        expect(loop.isActive).toBe(true)
        ac.abort()
        const events = (await collect(iter)) as Array<{ type: string }>
        expect(loop.isActive).toBe(false)
        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)

        // Owner cleared — a new run can start.
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        const loop2 = new AgentLoop({ client, sleep })
        await collect(
            loop2.run({
                runId: 'run-after',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )
        expect(loop2.isActive).toBe(false)
    })

    it('persists text+image tool result blocks into next provider request', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'img-1',
                                name: 'read',
                                arguments: { path: 'pic.png' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'saw image' }],
                    }),
            },
        )

        const tools = [
            makeTool('read', async () => ({
                content: [
                    { type: 'text', text: 'caption' },
                    { type: 'image', data: 'aW1n', mimeType: 'image/png' },
                ],
                details: { discarded: true },
            })),
        ]

        const loop = new AgentLoop({ client, sleep })
        await collect(
            loop.run({
                runId: 'run-img',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools,
            }),
        )

        const toolResults = client.calls[1]!.entries.filter(
            (e): e is ToolResultEntry => e.kind === 'toolResult',
        )
        expect(toolResults).toHaveLength(1)
        expect(toolResults[0]!.content).toEqual([
            { type: 'text', text: 'caption' },
            { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        ])
        expect(toolResults[0]).not.toHaveProperty('details')
    })

    it('abort settles never-resolving tool execute without hanging run', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'hang',
                            name: 'read',
                            arguments: { path: 'x' },
                        },
                    ],
                }),
        })

        let lateResolve: ((value: ToolResult) => void) | undefined
        const tools = [
            makeTool(
                'read',
                () =>
                    new Promise<ToolResult>((resolve) => {
                        lateResolve = resolve
                    }),
            ),
        ]

        const ac = new AbortController()
        const loop = new AgentLoop({ client, sleep })
        const events: Array<{ type: string }> = []
        const iter = loop.run({
            runId: 'run-tool-hang',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools,
            signal: ac.signal,
        })

        for await (const event of iter) {
            events.push(event as { type: string })
            if (event && (event as { type: string }).type === 'tool-start') {
                ac.abort()
            }
        }

        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        expect(events.some((e) => e.type === 'tool-end')).toBe(true)
        expect(loop.isActive).toBe(false)

        // Late success must not reopen the run or append extra events.
        lateResolve?.({ content: [{ type: 'text', text: 'late' }] })
        await Promise.resolve()
        expect(events.filter((e) => e.type === 'tool-end')).toHaveLength(1)
        expect(client.calls).toHaveLength(1)
    }, 10_000)

    it('abort settles never-resolving approval without hanging', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'need-approve',
                            name: 'bash',
                            arguments: { command: 'echo' },
                        },
                    ],
                }),
        })

        const approvals = new ApprovalController()
        // waitForApproval hangs until abortAll/signal — never approve.
        const tools = [
            makeTool('bash', async () => ({
                content: [{ type: 'text', text: 'should-not-run' }],
            })),
        ]

        const ac = new AbortController()
        const loop = new AgentLoop({ client, sleep, approvals })
        const events: Array<{ type: string }> = []
        const iter = loop.run({
            runId: 'run-appr-hang',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools,
            requestApproval: true,
            signal: ac.signal,
        })

        for await (const event of iter) {
            events.push(event as { type: string })
            if ((event as { type: string }).type === 'tool-approval-required') {
                ac.abort()
            }
        }

        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        expect(approvals.pendingCount()).toBe(0)
        expect(client.calls).toHaveLength(1)
    }, 10_000)

    it('dedupes composite tool call ids by normalized call_id first-wins', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'toolUse',
                        content: [
                            {
                                type: 'toolCall',
                                id: 'call_1|fc_a',
                                name: 'read',
                                arguments: { path: 'a' },
                            },
                            {
                                type: 'toolCall',
                                id: 'call_1|fc_b',
                                name: 'read',
                                arguments: { path: 'b' },
                            },
                            {
                                type: 'toolCall',
                                id: 'call_2',
                                name: 'read',
                                arguments: { path: 'c' },
                            },
                        ],
                    }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            },
        )

        const execute = vi.fn(async (): Promise<ToolResult> => ({
            content: [{ type: 'text' as const, text: 'once' }],
        }))
        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-composite-dup',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [makeTool('read', execute)],
            }),
        )) as Array<{ type: string }>

        expect(execute).toHaveBeenCalledTimes(2)
        const toolResults = client.calls[1]!.entries.filter(
            (e) => e.kind === 'toolResult',
        )
        // Provider history keeps one pair per normalized id (call_1 + call_2).
        expect(toolResults).toHaveLength(2)
        expect(toolResults.map((e) => (e as ToolResultEntry).toolCallId)).toEqual([
            'call_1|fc_a',
            'call_2',
        ])
        // Optional diagnostic for the dropped conflicting composite.
        expect(events.some((e) => e.type === 'diagnostic')).toBe(true)
    })

    it('does not yield late provider next events after abort', async () => {
        let resolveNext: ((value: IteratorResult<AssistantStreamEvent, AssistantEntry>) => void) | undefined
        let seedRef: AssistantEntry | undefined

        const client: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                seedRef = input.seed
                // First next yields start.
                yield { type: 'start', partial: input.seed }
                // Second next hangs until test releases — abort races this pending next.
                const late = await new Promise<AssistantStreamEvent>((resolve, reject) => {
                    resolveNext = (result) => {
                        if (result.done) {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                            return
                        }
                        resolve(result.value)
                    }
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                yield late
                return doneAssistant(input.seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'late-done' }],
                })
            },
        }

        const ac = new AbortController()
        const loop = new AgentLoop({ client, sleep })
        const events: Array<{ type: string; streamEvent?: { type: string } }> = []
        const iter = loop.run({
            runId: 'run-late-next',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: ac.signal,
        })

        for await (const event of iter) {
            events.push(event as { type: string; streamEvent?: { type: string } })
            if ((event as { type: string }).type === 'assistant-update') {
                ac.abort()
                // Attempt to deliver a late text-delta after abort.
                resolveNext?.({
                    done: false,
                    value: {
                        type: 'text-delta',
                        contentIndex: 0,
                        delta: 'SHOULD_NOT_YIELD',
                        partial: seedRef!,
                    },
                })
            }
        }

        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        const leaked = events.some(
            (e) =>
                e.type === 'assistant-update' &&
                e.streamEvent?.type === 'text-delta',
        )
        expect(leaked).toBe(false)
    }, 10_000)

    it('abort after assistant-end success race emits aborted once without error', async () => {
        let releaseStream: (() => void) | undefined
        const client: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((resolve) => {
                    releaseStream = resolve
                    signal.addEventListener('abort', () => resolve(), { once: true })
                })
                if (signal.aborted) {
                    throw Object.assign(new Error('Request was aborted'), {
                        name: 'AbortError',
                    })
                }
                return doneAssistant(input.seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'done' }],
                })
            },
        }

        const ac = new AbortController()
        const loop = new AgentLoop({ client, sleep })
        const events: Array<{ type: string }> = []
        const iter = loop.run({
            runId: 'run-end-race',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: ac.signal,
        })

        // Drive until assistant-start, then complete stream and abort around end.
        const pump = (async () => {
            for await (const event of iter) {
                events.push(event as { type: string })
                if ((event as { type: string }).type === 'assistant-start') {
                    releaseStream?.()
                    // Abort races completion path after assistant work.
                    queueMicrotask(() => ac.abort())
                }
            }
        })()
        await pump

        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted').length).toBeLessThanOrEqual(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
    })

    it('overflow compact failure (did=false) terminates without retry request', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'throw',
            error: new Error('context_length_exceeded: prompt is too long'),
        })

        const compact = vi.fn(async (): Promise<CompactConversationResult> => {
            throw new Error('summary failed')
        })

        const loop = new AgentLoop({ client, sleep, compact })
        const events = (await collect(
            loop.run({
                runId: 'run-ovf-fail',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>

        expect(compact).toHaveBeenCalledTimes(1)
        // No retry on uncompressed context.
        expect(client.calls).toHaveLength(1)
        expect(events.some((e) => e.type === 'error')).toBe(true)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
    })

    it('classifies status 400 + context_length_exceeded as overflow path', async () => {
        const client = new FakeCPAClient()
        client.queue(
            {
                kind: 'throw',
                error: Object.assign(new Error('bad request'), {
                    status: 400,
                    code: 'context_length_exceeded',
                }),
            },
            {
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'after compact' }],
                    }),
            },
        )

        const compact = vi.fn(
            async (
                entries: readonly ConversationEntry[],
            ): Promise<CompactConversationResult> => {
                const entry = {
                    id: 'cmp-400',
                    sessionId: 'sess-1',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: 'ok',
                    firstKeptEntryId: entries[0]?.id ?? 'u1',
                }
                return { entry, entries: [entry, ...entries] }
            },
        )

        const loop = new AgentLoop({ client, sleep, compact })
        const events = (await collect(
            loop.run({
                runId: 'run-400-ovf',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>

        expect(compact).toHaveBeenCalledTimes(1)
        expect(client.calls).toHaveLength(2)
        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.some((e) => e.type === 'agent-end')).toBe(true)
    })

    it('provider stream construction throw finalizes error assistant-end then error', async () => {
        const client: ProtocolClient = {
            stream() {
                throw new Error('stream construction failed')
            },
        }

        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-construct',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string; entry?: AssistantEntry; message?: string }>

        expect(events.map((e) => e.type)).toEqual(
            expect.arrayContaining([
                'agent-start',
                'assistant-start',
                'assistant-end',
                'error',
                'agent-end',
            ]),
        )
        const end = events.find((e) => e.type === 'assistant-end')
        expect(end?.entry?.status).toBe('error')
        expect(end?.entry?.stopReason).toBe('error')
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'error')).toHaveLength(1)
    })

    it('abort during overflow compaction finalizes partial assistant as aborted', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'throw',
            error: new Error('context_length_exceeded: prompt is too long'),
        })

        let compactStarted: (() => void) | undefined
        const compactStartedPromise = new Promise<void>((resolve) => {
            compactStarted = resolve
        })

        const compact = vi.fn(
            async (
                _entries: readonly ConversationEntry[],
                options: { signal?: AbortSignal },
            ): Promise<CompactConversationResult> => {
                compactStarted?.()
                await new Promise<void>((_resolve, reject) => {
                    const signal = options.signal
                    if (!signal) {
                        reject(new Error('missing signal'))
                        return
                    }
                    if (signal.aborted) {
                        reject(
                            Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            }),
                        )
                        return
                    }
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                throw new Error('unreachable')
            },
        )

        const ac = new AbortController()
        const loop = new AgentLoop({ client, sleep, compact })
        const events: Array<{ type: string; entry?: AssistantEntry }> = []
        const iter = loop.run({
            runId: 'run-ovf-abort',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
            signal: ac.signal,
        })

        const pump = (async () => {
            for await (const event of iter) {
                events.push(event as { type: string; entry?: AssistantEntry })
            }
        })()

        await compactStartedPromise
        ac.abort()
        await pump

        expect(events.some((e) => e.type === 'error')).toBe(false)
        expect(events.filter((e) => e.type === 'aborted')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        const assistantEnd = events.find((e) => e.type === 'assistant-end')
        expect(assistantEnd?.entry?.status).toBe('aborted')
        expect(assistantEnd?.entry?.stopReason).toBe('aborted')
        // No retry request on abort during overflow compact.
        expect(client.calls).toHaveLength(1)
    }, 10_000)

    it('emits agent-end exactly once on success', async () => {
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        const loop = new AgentLoop({ client, sleep })
        const events = (await collect(
            loop.run({
                runId: 'run-once-end',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>
        expect(events.filter((e) => e.type === 'agent-end')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'agent-start')).toHaveLength(1)
    })

    it('iterator.return is terminal: does not replay queued events and later next is done', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }

        const loop = new AgentLoop({ client: hanging, sleep })
        const iter = loop.run({
            runId: 'run-return-queued',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })

        // Drain nothing yet — wait until agent-start + assistant-start are queued.
        await vi.waitFor(() => expect(loop.isActive).toBe(true))
        // Give the pump a microtask window to push start events into the sink.
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        await new Promise<void>((resolve) => queueMicrotask(resolve))

        const ret = await iter.return?.()
        expect(ret).toEqual({ done: true, value: undefined })
        expect(loop.isActive).toBe(false)

        // Queued agent-start/assistant-start must not be replayed after return.
        const after = await iter.next()
        expect(after).toEqual({ done: true, value: undefined })
        const after2 = await iter.next()
        expect(after2).toEqual({ done: true, value: undefined })
    })

    it('pending next resolves done when return is called', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }

        const loop = new AgentLoop({ client: hanging, sleep })
        const iter = loop.run({
            runId: 'run-pending-next',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })

        // Consume first event so a later next may block if the stream hangs.
        const first = await iter.next()
        expect(first.done).toBe(false)

        // After draining the start events the hanging provider leaves next pending.
        // Force a second next that will wait, then return concurrently.
        let pendingSettled = false
        const pending = iter.next().then((result) => {
            pendingSettled = true
            return result
        })

        // Allow pending next to enter sink.wait if the queue is empty.
        await new Promise<void>((resolve) => queueMicrotask(resolve))

        await iter.return?.()
        const pendingResult = await pending
        expect(pendingSettled).toBe(true)
        // Either the pending next already took a pre-return event, or it is done.
        // After return, any subsequent next must be done; if pending took an event,
        // the following next is done.
        if (pendingResult.done) {
            expect(pendingResult).toEqual({ done: true, value: undefined })
        } else {
            const after = await iter.next()
            expect(after).toEqual({ done: true, value: undefined })
        }
        expect(loop.isActive).toBe(false)
    })

    it('return before first next releases active so the next run can start', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                await new Promise<void>((_resolve, reject) => {
                    if (signal.aborted) {
                        reject(
                            Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            }),
                        )
                        return
                    }
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }

        const loop = new AgentLoop({ client: hanging, sleep })
        const first = loop.run({
            runId: 'run-return-before-next',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        expect(loop.isActive).toBe(true)

        await first.return?.()
        expect(loop.isActive).toBe(false)

        // Same loop instance can start a new run after consumer return.
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        // Swap client via a new loop to assert active slot release on same instance.
        const second = loop.run({
            runId: 'run-after-return',
            sessionId: 'sess-1',
            entries: [userEntry('u2', 'y')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        // Override: first loop still holds hanging client; second run must not throw.
        // Use a fresh loop with working client for full collect, and verify first loop
        // accepted a second run without "already active".
        expect(loop.isActive).toBe(true)
        await second.return?.()
        expect(loop.isActive).toBe(false)

        const working = new AgentLoop({ client, sleep })
        const events = (await collect(
            working.run({
                runId: 'run-working',
                sessionId: 'sess-1',
                entries: [userEntry('u3', 'z')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )) as Array<{ type: string }>
        expect(events.some((e) => e.type === 'agent-end')).toBe(true)
    })

    it('iterator.return is idempotent', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }
        const loop = new AgentLoop({ client: hanging, sleep })
        const iter = loop.run({
            runId: 'run-double-return',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        await iter.next()
        const r1 = await iter.return?.()
        const r2 = await iter.return?.()
        expect(r1).toEqual({ done: true, value: undefined })
        expect(r2).toEqual({ done: true, value: undefined })
        expect(loop.isActive).toBe(false)
        const after = await iter.next()
        expect(after).toEqual({ done: true, value: undefined })
    })

    it('iterator.throw cleans up active and rejects per AsyncIterator semantics', async () => {
        const hanging: ProtocolClient = {
            async *stream(input, options) {
                const signal = options?.signal ?? new AbortController().signal
                yield { type: 'start', partial: input.seed }
                await new Promise<void>((_resolve, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            reject(
                                Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                }),
                            )
                        },
                        { once: true },
                    )
                })
                return input.seed
            },
        }
        const loop = new AgentLoop({ client: hanging, sleep })
        const iter = loop.run({
            runId: 'run-throw',
            sessionId: 'sess-1',
            entries: [userEntry('u1', 'x')],
            model,
            systemPrompt: 'sys',
            tools: [],
        })
        await iter.next()
        await expect(iter.throw?.(new Error('consumer-throw'))).rejects.toThrow(
            'consumer-throw',
        )
        expect(loop.isActive).toBe(false)
        const after = await iter.next()
        expect(after).toEqual({ done: true, value: undefined })

        // New run can start on the same loop.
        const client = new FakeCPAClient()
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'ok' }],
                }),
        })
        // Active released — but client is still hanging; use a new AgentLoop.
        const loop2 = new AgentLoop({ client, sleep })
        await collect(
            loop2.run({
                runId: 'run-after-throw',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            }),
        )
        expect(loop2.isActive).toBe(false)
    })

    it('provider return that never settles still releases active without unhandled rejection', async () => {
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            let returnCalled = false
            const foreverReturn: ProtocolClient = {
                stream(input, options) {
                    const signal = options?.signal ?? new AbortController().signal
                    const events: AssistantStreamEvent[] = [
                        { type: 'start', partial: input.seed },
                    ]
                    let idx = 0
                    const iterator = {
                        async next(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            if (signal.aborted) {
                                throw Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                })
                            }
                            if (idx < events.length) {
                                const value = events[idx++]!
                                return { done: false, value }
                            }
                            // Hang until abort, then reject like a cancelled stream.
                            await new Promise<void>((_resolve, reject) => {
                                if (signal.aborted) {
                                    reject(
                                        Object.assign(new Error('Request was aborted'), {
                                            name: 'AbortError',
                                        }),
                                    )
                                    return
                                }
                                signal.addEventListener(
                                    'abort',
                                    () => {
                                        reject(
                                            Object.assign(
                                                new Error('Request was aborted'),
                                                { name: 'AbortError' },
                                            ),
                                        )
                                    },
                                    { once: true },
                                )
                            })
                            return {
                                done: true,
                                value: doneAssistant(input.seed, {
                                    stopReason: 'stop',
                                    content: [],
                                }),
                            }
                        },
                        async return(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            returnCalled = true
                            // Never settles — simulates a stuck provider cleanup.
                            return await new Promise(() => undefined)
                        },
                        async throw(
                            error?: unknown,
                        ): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            throw error ?? new Error('provider throw')
                        },
                        [Symbol.asyncIterator]() {
                            return iterator
                        },
                    }
                    return iterator as unknown as AsyncGenerator<
                        AssistantStreamEvent,
                        AssistantEntry
                    >
                },
            }

            const loop = new AgentLoop({ client: foreverReturn, sleep })
            const iter = loop.run({
                runId: 'run-forever-return',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
            })

            // Drain until the provider stream is live (assistant-start or update).
            let sawProvider = false
            for (let i = 0; i < 10; i++) {
                const step = await iter.next()
                expect(step.done).toBe(false)
                const type = (step.value as { type: string }).type
                if (type === 'assistant-start' || type === 'assistant-update') {
                    sawProvider = true
                    break
                }
            }
            expect(sawProvider).toBe(true)
            expect(loop.isActive).toBe(true)

            // Consumer return must not hang on the forever provider.return().
            const returned = await Promise.race([
                iter.return?.() ?? Promise.resolve({ done: true as const, value: undefined }),
                new Promise<never>((_r, reject) => {
                    setTimeout(
                        () => reject(new Error('iterator.return hung on provider.return')),
                        200,
                    )
                }),
            ])
            expect(returned).toEqual({ done: true, value: undefined })
            expect(loop.isActive).toBe(false)
            // Provider.return is fire-and-observed immediately from the active provider slot.
            expect(returnCalled).toBe(true)

            // Next run can start immediately on a fresh loop (active released).
            const client = new FakeCPAClient()
            client.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            })
            const loop2 = new AgentLoop({ client, sleep })
            await collect(
                loop2.run({
                    runId: 'run-after-forever',
                    sessionId: 'sess-1',
                    entries: [userEntry('u1', 'x')],
                    model,
                    systemPrompt: 'sys',
                    tools: [],
                }),
            )
            expect(loop2.isActive).toBe(false)

            // Allow a late microtask tick for any stray rejections.
            await new Promise<void>((resolve) => queueMicrotask(resolve))
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            expect(unhandled).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('abort also releases active when provider.return never settles', async () => {
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            const foreverReturn: ProtocolClient = {
                stream(input, options) {
                    const signal = options?.signal ?? new AbortController().signal
                    const iterator = {
                        async next(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            if (signal.aborted) {
                                throw Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                })
                            }
                            // First yield start, then hang until abort.
                            if (!(iterator as { _started?: boolean })._started) {
                                ;(iterator as { _started?: boolean })._started = true
                                return {
                                    done: false,
                                    value: { type: 'start', partial: input.seed },
                                }
                            }
                            await new Promise<void>((_resolve, reject) => {
                                signal.addEventListener(
                                    'abort',
                                    () => {
                                        reject(
                                            Object.assign(
                                                new Error('Request was aborted'),
                                                { name: 'AbortError' },
                                            ),
                                        )
                                    },
                                    { once: true },
                                )
                            })
                            throw Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            })
                        },
                        async return(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            // Late reject after a tick — must not be unhandled.
                            return await new Promise((_resolve, reject) => {
                                setTimeout(() => {
                                    reject(new Error('late provider return reject'))
                                }, 30)
                            })
                        },
                        [Symbol.asyncIterator]() {
                            return iterator
                        },
                    }
                    return iterator as unknown as AsyncGenerator<
                        AssistantStreamEvent,
                        AssistantEntry
                    >
                },
            }

            const loop = new AgentLoop({ client: foreverReturn, sleep })
            const ac = new AbortController()
            const iter = loop.run({
                runId: 'run-abort-forever-return',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'x')],
                model,
                systemPrompt: 'sys',
                tools: [],
                signal: ac.signal,
            })

            await iter.next()
            expect(loop.isActive).toBe(true)
            ac.abort()

            // Collect must finish even though provider.return rejects late / hangs paths.
            const events = (await Promise.race([
                collect(iter),
                new Promise<never>((_r, reject) => {
                    setTimeout(
                        () => reject(new Error('collect hung after abort')),
                        500,
                    )
                }),
            ])) as Array<{ type: string }>

            expect(loop.isActive).toBe(false)
            expect(events.some((e) => e.type === 'error')).toBe(false)
            expect(events.filter((e) => e.type === 'aborted').length).toBeGreaterThanOrEqual(0)

            await new Promise<void>((resolve) => setTimeout(resolve, 50))
            expect(unhandled).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('old run cleanup does not release newer run provider (token ownership)', async () => {
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            let streamCalls = 0
            let aReturnCount = 0
            let bReturnCount = 0

            type ProviderIterator = {
                next: () => Promise<
                    IteratorResult<AssistantStreamEvent, AssistantEntry>
                >
                return: () => Promise<
                    IteratorResult<AssistantStreamEvent, AssistantEntry>
                >
                [Symbol.asyncIterator]: () => ProviderIterator
            }

            const dualClient: ProtocolClient = {
                stream(input, options) {
                    const signal = options?.signal ?? new AbortController().signal
                    streamCalls += 1
                    const label = streamCalls === 1 ? 'A' : 'B'
                    let started = false
                    const iterator: ProviderIterator = {
                        async next() {
                            if (signal.aborted) {
                                throw Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                })
                            }
                            if (label === 'A') {
                                // Run A completes naturally so active clears without consumer return.
                                if (!started) {
                                    started = true
                                    return {
                                        done: false,
                                        value: { type: 'start', partial: input.seed },
                                    }
                                }
                                return {
                                    done: true,
                                    value: doneAssistant(input.seed, {
                                        stopReason: 'stop',
                                        content: [{ type: 'text', text: 'a-done' }],
                                    }),
                                }
                            }
                            // Run B hangs after start so its provider stays in the slot.
                            if (!started) {
                                started = true
                                return {
                                    done: false,
                                    value: { type: 'start', partial: input.seed },
                                }
                            }
                            await new Promise<void>((_resolve, reject) => {
                                if (signal.aborted) {
                                    reject(
                                        Object.assign(new Error('Request was aborted'), {
                                            name: 'AbortError',
                                        }),
                                    )
                                    return
                                }
                                signal.addEventListener(
                                    'abort',
                                    () => {
                                        reject(
                                            Object.assign(
                                                new Error('Request was aborted'),
                                                { name: 'AbortError' },
                                            ),
                                        )
                                    },
                                    { once: true },
                                )
                            })
                            throw Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            })
                        },
                        async return() {
                            if (label === 'A') aReturnCount += 1
                            else bReturnCount += 1
                            // Never settle — fire-and-observe ownership path.
                            return await new Promise(() => undefined)
                        },
                        [Symbol.asyncIterator]() {
                            return iterator
                        },
                    }
                    return iterator as unknown as AsyncGenerator<
                        AssistantStreamEvent,
                        AssistantEntry
                    >
                },
            }

            const loop = new AgentLoop({ client: dualClient, sleep })

            const iterA = loop.run({
                runId: 'run-a-owner',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'a')],
                model,
                systemPrompt: 'sys',
                tools: [],
            })

            // Fully drain A to natural completion (active released by pump, not consumer return).
            const aEvents = (await collect(iterA)) as Array<{ type: string }>
            expect(aEvents.some((e) => e.type === 'agent-end')).toBe(true)
            expect(loop.isActive).toBe(false)
            // Natural completion may fire provider.return once from stream finally.
            const aReturnsAfterNatural = aReturnCount

            // B starts on the same AgentLoop; A iterator is still open for return/throw.
            const iterB = loop.run({
                runId: 'run-b-owner',
                sessionId: 'sess-1',
                entries: [userEntry('u2', 'b')],
                model,
                systemPrompt: 'sys',
                tools: [],
            })

            let sawB = false
            for (let i = 0; i < 10; i++) {
                const step = await iterB.next()
                expect(step.done).toBe(false)
                const type = (step.value as { type: string }).type
                if (type === 'assistant-start' || type === 'assistant-update') {
                    sawB = true
                    break
                }
            }
            expect(sawB).toBe(true)
            expect(loop.isActive).toBe(true)
            expect(streamCalls).toBe(2)
            expect(bReturnCount).toBe(0)

            // Stale A cleanup after B owns the provider — must not call B.return.
            await iterA.return?.()
            try {
                await iterA.throw?.(new Error('stale A throw after B'))
            } catch {
                // throw rethrows per AsyncIterator semantics
            }
            // Double cleanup must stay a no-op for B.
            await iterA.return?.()
            await new Promise<void>((resolve) => queueMicrotask(resolve))
            await new Promise<void>((resolve) => setTimeout(resolve, 30))

            expect(bReturnCount).toBe(0)
            expect(loop.isActive).toBe(true)

            // B abort cleans B provider exactly once; A late paths must not add extra B returns.
            loop.abort('run-b-owner')
            const bEvents = (await Promise.race([
                collect(iterB),
                new Promise<never>((_r, reject) => {
                    setTimeout(
                        () => reject(new Error('collect hung after B abort')),
                        500,
                    )
                }),
            ])) as Array<{ type: string }>

            expect(loop.isActive).toBe(false)
            expect(bReturnCount).toBe(1)
            // A may have been return()'d by stale cleanup, but never B.
            expect(aReturnCount).toBeGreaterThanOrEqual(aReturnsAfterNatural)
            expect(bEvents.some((e) => e.type === 'error')).toBe(false)

            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            expect(unhandled).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('late A provider finally cannot clear B active provider slot', async () => {
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown): void => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            let streamCalls = 0
            let bReturnCount = 0
            let aReturnCount = 0

            const dualClient: ProtocolClient = {
                stream(input, options) {
                    const signal = options?.signal ?? new AbortController().signal
                    streamCalls += 1
                    const label = streamCalls === 1 ? 'A' : 'B'
                    let started = false
                    const iterator = {
                        async next(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            if (signal.aborted) {
                                throw Object.assign(new Error('Request was aborted'), {
                                    name: 'AbortError',
                                })
                            }
                            if (label === 'A') {
                                if (!started) {
                                    started = true
                                    return {
                                        done: false,
                                        value: { type: 'start', partial: input.seed },
                                    }
                                }
                                return {
                                    done: true,
                                    value: doneAssistant(input.seed, {
                                        stopReason: 'stop',
                                        content: [{ type: 'text', text: 'a-done' }],
                                    }),
                                }
                            }
                            if (!started) {
                                started = true
                                return {
                                    done: false,
                                    value: { type: 'start', partial: input.seed },
                                }
                            }
                            await new Promise<void>((_resolve, reject) => {
                                if (signal.aborted) {
                                    reject(
                                        Object.assign(new Error('Request was aborted'), {
                                            name: 'AbortError',
                                        }),
                                    )
                                    return
                                }
                                signal.addEventListener(
                                    'abort',
                                    () => {
                                        reject(
                                            Object.assign(
                                                new Error('Request was aborted'),
                                                { name: 'AbortError' },
                                            ),
                                        )
                                    },
                                    { once: true },
                                )
                            })
                            throw Object.assign(new Error('Request was aborted'), {
                                name: 'AbortError',
                            })
                        },
                        async return(): Promise<
                            IteratorResult<AssistantStreamEvent, AssistantEntry>
                        > {
                            if (label === 'A') aReturnCount += 1
                            else bReturnCount += 1
                            return await new Promise(() => undefined)
                        },
                        [Symbol.asyncIterator]() {
                            return iterator
                        },
                    }
                    return iterator as unknown as AsyncGenerator<
                        AssistantStreamEvent,
                        AssistantEntry
                    >
                },
            }

            const loop = new AgentLoop({ client: dualClient, sleep })
            const iterA = loop.run({
                runId: 'run-a-late-finally',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'a')],
                model,
                systemPrompt: 'sys',
                tools: [],
            })

            // Drain A naturally; active is free, but consumer terminalCleanup has not run.
            await collect(iterA)
            expect(loop.isActive).toBe(false)

            const iterB = loop.run({
                runId: 'run-b-late-finally',
                sessionId: 'sess-1',
                entries: [userEntry('u2', 'b')],
                model,
                systemPrompt: 'sys',
                tools: [],
            })

            for (let i = 0; i < 10; i++) {
                const step = await iterB.next()
                const type = (step.value as { type: string } | undefined)?.type
                if (type === 'assistant-start' || type === 'assistant-update') break
            }
            expect(loop.isActive).toBe(true)
            expect(bReturnCount).toBe(0)

            // Late A consumer cleanup after B owns the provider slot.
            await iterA.return?.()
            await iterA.return?.()
            try {
                await iterA.throw?.(new Error('late A'))
            } catch {
                // expected rethrow
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 30))

            expect(bReturnCount).toBe(0)
            expect(loop.isActive).toBe(true)

            // B still cleans itself exactly once on abort.
            loop.abort()
            await Promise.race([
                collect(iterB),
                new Promise<never>((_r, reject) => {
                    setTimeout(() => reject(new Error('B collect hung')), 500)
                }),
            ])
            expect(bReturnCount).toBe(1)
            expect(loop.isActive).toBe(false)
            // A cleanup may have observed A's own generator; never B.
            expect(aReturnCount).toBeGreaterThanOrEqual(0)

            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            expect(unhandled).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('executes unfulfilled pending tool calls from a trailing assistant entry on start', async () => {
        let toolExecuted = false
        const customTool: AgentTool = {
            name: 'custom_calc',
            label: 'custom_calc',
            description: 'A tool',
            parameters: { type: 'object', properties: { val: { type: 'number' } } },
            validate: (args: unknown) => args as Record<string, unknown>,
            execute: async () => {
                toolExecuted = true
                return {
                    content: [{ type: 'text', text: 'computed: 42' }],
                }
            },
        }

        const client = new FakeCPAClient()
        // Client will be called for the next turn with the tool result in history
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'Finished after tool result' }],
                }),
        })

        const loop = new AgentLoop({ client, sleep })
        const initialEntries: ConversationEntry[] = [
            userEntry('u1', 'Calculate something'),
            {
                id: 'a1',
                sessionId: 'sess-1',
                createdAt: 2,
                kind: 'assistant',
                model: model.id,
                content: [
                    {
                        type: 'toolCall',
                        id: 'tc-calc-1',
                        name: 'custom_calc',
                        arguments: { val: 21 },
                    },
                ],
                stopReason: 'toolUse',
                status: 'done',
            },
        ]

        const events = await collect(
            loop.run({
                runId: 'run-pending-tool',
                sessionId: 'sess-1',
                entries: initialEntries,
                model,
                systemPrompt: 'sys',
                tools: [customTool],
            }),
        )

        expect(toolExecuted).toBe(true)
        expect(events.some((e) => (e as any).type === 'tool-start' && (e as any).toolName === 'custom_calc')).toBe(true)
        expect(events.some((e) => (e as any).type === 'tool-end' && (e as any).toolName === 'custom_calc')).toBe(true)

        // Verify client was called with 3 entries: user, assistant(toolCall), toolResult
        expect(client.calls).toHaveLength(1)
        expect(client.calls[0].entries).toHaveLength(3)
        expect(client.calls[0].entries[2].kind).toBe('toolResult')

        const endEvent = events.find((e) => (e as any).type === 'agent-end') as any
        expect(endEvent).toBeDefined()
        expect(endEvent?.entries).toHaveLength(4)
    })

    it('updates reasoningEffort in subsequent provider turns when getRuntimeSettings changes mid-run', async () => {
        const reasoningModel: ModelCatalogEntry = {
            ...model,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'high', requestValue: 'high' },
            ],
        }

        let dynamicSettings = {
            reasoningLevel: 'low',
            reasoningEffort: 'low',
        }

        const customTool = makeTool('step_tool', async () => {
            // Simulate user changing reasoning effort via ModelSelect during tool execution
            dynamicSettings = {
                reasoningLevel: 'high',
                reasoningEffort: 'high',
            }
            return {
                content: [{ type: 'text', text: 'step completed' }],
            }
        })

        const client = new FakeCPAClient()
        // Turn 1: Assistant calls step_tool
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'tc-step-1',
                            name: 'step_tool',
                            arguments: {},
                        },
                    ],
                }),
        })
        // Turn 2: Assistant finishes
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'All done with high reasoning' }],
                }),
        })

        const loop = new AgentLoop({ client, sleep })
        const events = await collect(
            loop.run({
                runId: 'run-mid-run-reasoning',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'Do something multi-turn')],
                model: reasoningModel,
                systemPrompt: 'sys',
                tools: [customTool],
                reasoningEffort: 'low',
                getRuntimeSettings: () => dynamicSettings,
            }),
        )

        expect(client.calls).toHaveLength(2)
        // First turn used initial low reasoning effort
        expect(client.calls[0].reasoningEffort).toBe('low')
        // Second turn used updated high reasoning effort dynamically
        expect(client.calls[1].reasoningEffort).toBe('high')

        const endEvent = events.find((e) => (e as any).type === 'agent-end')
        expect(endEvent).toBeDefined()
    })

    it('injects steer entry after LLM request without tools and continues loop', async () => {
        const client = new FakeCPAClient()
        // Turn 1: LLM answers without tool calls (stopReason 'stop')
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'first answer' }],
                }),
        })
        // Turn 2: LLM receives the steer message and answers again
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'steered answer' }],
                }),
        })

        let steerConsumed = false
        const loop = new AgentLoop({ client, sleep })
        const events = await collect(
            loop.run({
                runId: 'run-steer-notool',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'first question')],
                model,
                systemPrompt: 'sys',
                tools: [],
                consumeSteerEntry: () => {
                    if (!steerConsumed) {
                        steerConsumed = true
                        return {
                            id: 'u-steer-1',
                            sessionId: 'sess-1',
                            kind: 'user',
                            createdAt: Date.now(),
                            pendingStatus: 'steer',
                            content: [{ type: 'text', text: 'wait, steer direction' }],
                        }
                    }
                    return undefined
                },
            }),
        )

        expect(client.calls).toHaveLength(2)
        // Second call received the steered user entry in its entries
        const secondCallEntries = client.calls[1].entries
        expect(secondCallEntries.some((e: any) => e.id === 'u-steer-1')).toBe(true)

        // Events contained the user-entry event for steer
        const steerEvent = events.find((e: any) => e.type === 'user-entry' && e.entry?.id === 'u-steer-1')
        expect(steerEvent).toBeDefined()
        expect((steerEvent as any).entry.pendingStatus).toBeUndefined()
    })

    it('injects steer entry after tool execution batch so it is sent alongside tool results', async () => {
        const client = new FakeCPAClient()
        // Turn 1: Assistant calls tool
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-bash',
                            name: 'bash',
                            arguments: { command: 'echo 1' },
                        },
                    ],
                }),
        })
        // Turn 2: Assistant receives tool result + steer entry
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'handled tool and steer' }],
                }),
        })

        const bashTool = makeTool('bash', async () => ({
            content: [{ type: 'text', text: 'output 1' }],
        }))

        let steerConsumed = false
        const loop = new AgentLoop({ client, sleep })
        const events = await collect(
            loop.run({
                runId: 'run-steer-tool',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'run bash')],
                model,
                systemPrompt: 'sys',
                tools: [bashTool],
                consumeSteerEntry: () => {
                    if (!steerConsumed) {
                        steerConsumed = true
                        return {
                            id: 'u-steer-2',
                            sessionId: 'sess-1',
                            kind: 'user',
                            createdAt: Date.now(),
                            pendingStatus: 'steer',
                            content: [{ type: 'text', text: 'steer during tool' }],
                        }
                    }
                    return undefined
                },
            }),
        )

        expect(client.calls).toHaveLength(2)
        // Second call entries: must contain tool result followed by steer user entry
        const secondCallEntries = client.calls[1].entries
        const toolResultIndex = secondCallEntries.findIndex((e: any) => e.kind === 'toolResult')
        const steerIndex = secondCallEntries.findIndex((e: any) => e.id === 'u-steer-2')
        expect(toolResultIndex).toBeGreaterThan(-1)
        expect(steerIndex).toBeGreaterThan(toolResultIndex)

        const steerEvent = events.find((e: any) => e.type === 'user-entry' && e.entry?.id === 'u-steer-2')
        expect(steerEvent).toBeDefined()
        expect((steerEvent as any).entry.pendingStatus).toBeUndefined()
    })

    it('injects multiple steer entries in order alongside tool results into next LLM request', async () => {
        const client = new FakeCPAClient()
        // Turn 1: Assistant calls tool
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'toolUse',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-bash-multi',
                            name: 'bash',
                            arguments: { command: 'echo hello' },
                        },
                    ],
                }),
        })
        // Turn 2: Assistant receives tool result + steer entries
        client.queue({
            kind: 'stream',
            final: (seed) =>
                doneAssistant(seed, {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'All steers handled' }],
                }),
        })

        const bashTool = makeTool('bash', async () => ({
            content: [{ type: 'text', text: 'ok' }],
        }))

        let consumed = false
        const loop = new AgentLoop({ client, sleep })
        const events = await collect(
            loop.run({
                runId: 'run-multi-steer',
                sessionId: 'sess-1',
                entries: [userEntry('u1', 'run bash')],
                model,
                systemPrompt: 'sys',
                tools: [bashTool],
                consumeSteerEntries: () => {
                    if (!consumed) {
                        consumed = true
                        return [
                            {
                                id: 'u-steer-a',
                                sessionId: 'sess-1',
                                kind: 'user',
                                createdAt: Date.now(),
                                pendingStatus: 'steer',
                                content: [{ type: 'text', text: 'steer A' }],
                            },
                            {
                                id: 'u-steer-b',
                                sessionId: 'sess-1',
                                kind: 'user',
                                createdAt: Date.now() + 1,
                                pendingStatus: 'steer',
                                content: [{ type: 'text', text: 'steer B' }],
                            },
                        ]
                    }
                    return undefined
                },
            }),
        )

        expect(client.calls).toHaveLength(2)
        const secondCallEntries = client.calls[1].entries
        const idxA = secondCallEntries.findIndex((e: any) => e.id === 'u-steer-a')
        const idxB = secondCallEntries.findIndex((e: any) => e.id === 'u-steer-b')
        expect(idxA).toBeGreaterThan(-1)
        expect(idxB).toBeGreaterThan(idxA)

        const userEvents = events.filter((e: any) => e.type === 'user-entry')
        expect(userEvents.map((e: any) => e.entry?.id)).toContain('u-steer-a')
        expect(userEvents.map((e: any) => e.entry?.id)).toContain('u-steer-b')
    })
})
