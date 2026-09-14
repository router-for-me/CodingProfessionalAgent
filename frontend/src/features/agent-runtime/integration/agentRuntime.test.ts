/**
 * End-to-end agent runtime integration:
 * FakeNativeBridge + real CodexConnectionManager/CodexClient + CLIProxyAPIAgentService
 * + AgentLoop + real read/edit/bash/write tools.
 *
 * Protocol responses are driven per sendWebSocket (no real network/timers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import type { AgentRunEvent } from '../agent/types'
import { AgentLoop } from '../agent/agentLoop'
import { CLIProxyAPIAgentService } from '../CLIProxyAPIAgentService'
import {
    FakeNativeBridge,
    type FakeWebSocketFrame,
} from '../native/fakeNativeBridge'
import {
    buildWebSocketHeaders,
    CodexClient,
    CodexConnectionManager,
    type CodexResponseCreate,
} from '../../../../../plugins/bundled/cpa.core.protocol-codex/agent/index'
import { createToolsFromProviders } from '../providers/ToolFactoryProvider'
import { createBrowserImageProcessor, type ImageProcessor } from '@cpa/plugin-sdk'
import { compactConversation } from '../context/compaction'
import { rendererRegistry as defaultExtensionRegistry, RendererRegistry as ExtensionRegistry } from '@/plugins/platform/rendererRegistry'
import { subagentAgentEntry } from '../../../../../plugins/bundled/cpa.core.subagent/agent/index'
import { toolsAgentEntry } from '../../../../../plugins/bundled/cpa.core.tools/agent/index'
import { resourcesAgentEntry } from '../../../../../plugins/bundled/cpa.core.resources/agent/index'
import { entry as webSearchAgentEntry } from '../../../../../plugins/bundled/cpa.core.web-search/agent/index'
import type { ProtocolMiddleware } from '@cpa/plugin-api'
import type {
    AssistantEntry,
    ConversationEntry,
    UserEntry,
} from '../session/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = 'test-api-key-secret'
const BASE_URL = 'http://127.0.0.1:8317/backend-api'
const PROJECT = '/workspace/project'
const CONFIG_ROOT = '/tmp/cpa-config'
const AGENT_DIR = `${CONFIG_ROOT}/coding-professional-agent/agent`
const TARGET_FILE = 'notes.txt'
const TARGET_ABS = `${PROJECT}/${TARGET_FILE}`
const IMAGE_REL = 'shot.png'

const visionModel: ModelCatalogEntry = {
    id: 'gpt-vision',
    label: 'Vision',
    supportsFast: true,
    reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

const textOnlyModel: ModelCatalogEntry = {
    ...visionModel,
    id: 'gpt-text',
    supportsFast: false,
    input: ['text'],
}

const tinyWindowModel: ModelCatalogEntry = {
    ...textOnlyModel,
    id: 'gpt-tiny',
    contextWindow: 200,
    maxTokens: 256,
}

function pngBytes(): Uint8Array {
    return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ])
}

const identityImageProcessor: ImageProcessor = createBrowserImageProcessor()

function userEntry(
    id: string,
    text: string,
    sessionId = 'sess-e2e',
    extra?: Partial<UserEntry>,
): UserEntry {
    return {
        id,
        sessionId,
        createdAt: 1,
        kind: 'user',
        content: [{ type: 'text', text }],
        ...extra,
    }
}

function assistantDone(
    id: string,
    text: string,
    sessionId = 'sess-e2e',
    usageTotal?: number,
): AssistantEntry {
    return {
        id,
        sessionId,
        createdAt: 2,
        kind: 'assistant',
        model: visionModel.id,
        content: [{ type: 'text', text }],
        status: 'done',
        stopReason: 'stop',
        usage:
            usageTotal === undefined
                ? undefined
                : {
                      input: usageTotal,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: usageTotal,
                      cost: {
                          input: 0,
                          output: 0,
                          cacheRead: 0,
                          cacheWrite: 0,
                          total: 0,
                      },
                  },
    }
}

function validSummary(): string {
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
    ].join('\n')
}

function validTurnPrefix(): string {
    return [
        '## Original Request',
        'Do the work',
        '## Early Progress',
        '- started',
        '## Context for Suffix',
        '- keep going',
    ].join('\n')
}

function textFrames(responseId: string, text: string, usage = 7): FakeWebSocketFrame[] {
    const events = [
        { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
                type: 'message',
                id: `msg_${responseId}`,
                role: 'assistant',
                status: 'in_progress',
                content: [],
            },
        },
        { type: 'response.output_text.delta', output_index: 0, delta: text },
        {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                type: 'message',
                id: `msg_${responseId}`,
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
            },
        },
        {
            type: 'response.completed',
            response: {
                id: responseId,
                status: 'completed',
                usage: {
                    input_tokens: usage,
                    output_tokens: 2,
                    total_tokens: usage + 2,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                },
                output: [
                    {
                        type: 'message',
                        id: `msg_${responseId}`,
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text, annotations: [] }],
                    },
                ],
            },
        },
    ]
    return events.map((event) => ({
        kind: 'websocket-text',
        data: JSON.stringify(event),
    }))
}

function functionCallFrames(
    responseId: string,
    calls: Array<{
        callId: string
        itemId: string
        name: string
        args: Record<string, unknown>
        outputIndex: number
    }>,
    usage = 18,
): FakeWebSocketFrame[] {
    const frames: FakeWebSocketFrame[] = [
        {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: responseId, status: 'in_progress' },
            }),
        },
    ]

    const outputItems: unknown[] = []
    for (const call of calls) {
        const argsJson = JSON.stringify(call.args)
        frames.push(
            {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.output_item.added',
                    output_index: call.outputIndex,
                    item: {
                        type: 'function_call',
                        id: call.itemId,
                        call_id: call.callId,
                        name: call.name,
                        arguments: '',
                    },
                }),
            },
            {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.function_call_arguments.delta',
                    output_index: call.outputIndex,
                    delta: argsJson,
                }),
            },
            {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.function_call_arguments.done',
                    output_index: call.outputIndex,
                    arguments: argsJson,
                }),
            },
            {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.output_item.done',
                    output_index: call.outputIndex,
                    item: {
                        type: 'function_call',
                        id: call.itemId,
                        call_id: call.callId,
                        name: call.name,
                        arguments: argsJson,
                    },
                }),
            },
        )
        outputItems.push({
            type: 'function_call',
            id: call.itemId,
            call_id: call.callId,
            name: call.name,
            arguments: argsJson,
        })
    }

    frames.push({
        kind: 'websocket-text',
        data: JSON.stringify({
            type: 'response.completed',
            response: {
                id: responseId,
                status: 'completed',
                usage: {
                    input_tokens: usage,
                    output_tokens: 6,
                    total_tokens: usage + 6,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                },
                output: outputItems,
            },
        }),
    })
    return frames
}

function overflowFailedFrames(responseId: string): FakeWebSocketFrame[] {
    return [
        {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: responseId, status: 'in_progress' },
            }),
        },
        {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.failed',
                response: {
                    id: responseId,
                    status: 'failed',
                    error: {
                        code: 'context_length_exceeded',
                        message: 'prompt is too long',
                    },
                },
            }),
        },
    ]
}

function parseSentBodies(bridge: FakeNativeBridge): CodexResponseCreate[] {
    return bridge.calls
        .filter((call) => call.method === 'sendWebSocket')
        .map((call) => JSON.parse(String(call.args[1])) as CodexResponseCreate)
}

function openCalls(bridge: FakeNativeBridge) {
    return bridge.calls.filter((call) => call.method === 'openWebSocket')
}

function hasHttpOrSseSurface(bridge: FakeNativeBridge): boolean {
    // Integration must never touch fetch/EventSource; bridge only has WS/process/files.
    return bridge.calls.some((call) =>
        /fetch|eventsource|http|sse/i.test(call.method),
    )
}

async function collect(
    iterable: AsyncIterable<AgentRunEvent>,
): Promise<AgentRunEvent[]> {
    const out: AgentRunEvent[] = []
    for await (const event of iterable) {
        out.push(event)
    }
    return out
}

function createInstantSleep() {
    const delays: number[] = []
    const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
        delays.push(ms)
        if (signal.aborted) {
            const err = new Error('Request was aborted')
            err.name = 'AbortError'
            throw err
        }
    }
    return { sleep, delays }
}

interface CompactionSettingsOverride {
    enabled?: boolean
    reserveTokens?: number
    keepRecentTokens?: number
}

interface HarnessOptions {
    bridge?: FakeNativeBridge
    extensionRegistry?: ExtensionRegistry
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    generateId?: () => string
    now?: () => number
    /** Per-run AgentLoop threshold settings. */
    compactionSettings?: CompactionSettingsOverride
    /**
     * Settings for real compactConversation (manual/overflow/auto summaries).
     * Default keepRecentTokens is large; tests shrink it for deterministic cuts.
     */
    compactSettings?: CompactionSettingsOverride
    imageProcessor?: ImageProcessor
}

function createHarness(opts: HarnessOptions = {}) {
    const bridge = opts.bridge ?? new FakeNativeBridge()
    bridge.setRuntimeInfo({
        platform: 'linux',
        userConfigDir: CONFIG_ROOT,
        tempDir: '/tmp',
        homeDir: '/home/test',
    })
    // Unix bash resolution prefers /bin/bash when present as a file.
    bridge.setFile('/bin/bash', '')
    // Project + agent dirs so tools and resource loader succeed.
    bridge.setFile(`${PROJECT}/.gitkeep`, '')
    // Ensure project is a directory via descendant file.
    bridge.setFile(`${AGENT_DIR}/AGENTS.md`, '# agent\n')

    const { sleep, delays } =
        opts.sleep !== undefined
            ? { sleep: opts.sleep, delays: [] as number[] }
            : createInstantSleep()

    let idSeq = 0
    const generateId =
        opts.generateId ??
        (() => {
            idSeq += 1
            return `id-${idSeq}`
        })

    const now = opts.now ?? (() => 1_700_000_000_000)

    const compactSettings = opts.compactSettings ?? {
        enabled: true,
        reserveTokens: 128,
        keepRecentTokens: 50,
    }

    const service = new CLIProxyAPIAgentService({
        bridge,
        extensionRegistry: opts.extensionRegistry,
        // Real client + shared connection manager (composition default paths).
        createClient: (clientOpts) => new CodexClient(clientOpts),
        createConnectionManager: (b) =>
            new CodexConnectionManager(b, {
                now,
                generateRequestId: generateId,
            }),
        createTools: async (cwd, native, model, options) =>
            createToolsFromProviders({
                cwd: cwd ?? undefined,
                bridge: native,
                model,
                imageProcessor: opts.imageProcessor ?? identityImageProcessor,
                ...options,
            }),
        compact: async (entries, options) =>
            compactConversation(entries, {
                ...options,
                settings: {
                    ...compactSettings,
                    ...(options.settings ?? {}),
                },
                sleep,
                summaryRetryDelaysMs: [],
            }),
        createLoop: (deps) => {
            const loop = new AgentLoop({
                ...deps,
                sleep,
                generateId,
                now,
                compact: async (entries, options) =>
                    compactConversation(entries, {
                        ...options,
                        settings: {
                            ...compactSettings,
                            ...(options.settings ?? {}),
                        },
                        sleep,
                        summaryRetryDelaysMs: [],
                    }),
            })
            if (!opts.compactionSettings) {
                return loop
            }
            const original = loop.run.bind(loop)
            loop.run = (input) =>
                original({
                    ...input,
                    compactionSettings: opts.compactionSettings,
                })
            return loop
        },
        generateId,
        now,
        // Dispose waits should not use wall clock.
        delay: async (ms, signal) => {
            if (signal?.aborted) {
                const err = new Error('Request was aborted')
                err.name = 'AbortError'
                throw err
            }
            if (ms > 0) {
                // Immediate for tests.
            }
        },
        disposeTimeoutMs: 1,
    })

    return { service, bridge, delays, generateId, now }
}

function seedOpenSocket(bridge: FakeNativeBridge): void {
    // Keep the socket open (no terminal) so session reuse + request-driven frames work.
    bridge.queueWebSocket({
        frames: [{ kind: 'websocket-open' }],
    })
}

/**
 * Queue isolated summary connections for history + optional turn-prefix pairs.
 * Compaction may open 1–2 summary streams per attempt.
 */
function seedIsolatedSummaries(
    bridge: FakeNativeBridge,
    pairs = 2,
    responseIdPrefix = 'resp_sum',
): void {
    for (let i = 0; i < pairs; i += 1) {
        bridge.queueWebSocket({ frames: [{ kind: 'websocket-open' }] })
        bridge.queueWebSocketSendResponse(
            textFrames(`${responseIdPrefix}_h_${i}`, validSummary(), 5),
        )
        bridge.queueWebSocket({ frames: [{ kind: 'websocket-open' }] })
        bridge.queueWebSocketSendResponse(
            textFrames(`${responseIdPrefix}_p_${i}`, validTurnPrefix(), 5),
        )
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent runtime end-to-end integration', () => {
    beforeEach(() => {
        defaultExtensionRegistry.clear()
        toolsAgentEntry.activate({
            register: (c: any) => {
                if (c.kind === 'tool-factory') {
                    defaultExtensionRegistry.registerToolFactory(c.value ?? c)
                }
            },
        } as any)
        resourcesAgentEntry.activate({
            register: (c: any) => {
                if (c.kind === 'resource-provider') {
                    defaultExtensionRegistry.registerResourceProvider(c.value ?? c)
                }
            },
        } as any)
        subagentAgentEntry.activate({
            register: (c: any) => {
                if (c.kind === 'tool-factory') {
                    defaultExtensionRegistry.registerToolFactory(c.value ?? c)
                }
            },
        } as any)
        defaultExtensionRegistry.registerToolFactory({
            id: 'title',
            order: 100,
            targets: ['main', 'all'],
            riskLevel: 'session',
            requiresApproval: false,
            approvalCategory: 'session-metadata',
            create: () => ({
                name: 'title',
                label: 'title',
                description: 'Set session title',
                parameters: { type: 'object' },
                validate: (i: any) => i ?? {},
                execute: async () => ({ content: [], isError: false }),
            }),
        })
    })

    afterEach(() => {
        defaultExtensionRegistry.clear()
        vi.useRealTimers()
    })

    it('delegates A function call to isolated native-search B and returns findings with A call ID', async () => {
        const searchModel = { ...textOnlyModel, id: 'native-search-B', cpaCapabilities: { webSearch: true } }
        webSearchAgentEntry.activate({
            capabilityClient: { invoke: async () => ({ enabled: true, modelId: searchModel.id }) },
            getService: () => ({ getModels: () => [textOnlyModel, searchModel], getStatus: () => 'ready' }),
            register: (contribution: any) => defaultExtensionRegistry.registerToolFactory(contribution.value),
        } as any)
        const { service, bridge } = createHarness()
        seedOpenSocket(bridge)
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(functionCallFrames('response-A', [{ callId: 'call_A', itemId: 'fc_A', name: 'web_search', args: { query: 'latest release' }, outputIndex: 0 }]))
        bridge.queueWebSocketSendResponse([{ kind: 'websocket-text', data: JSON.stringify({ type: 'response.completed', response: {
            id: 'response-B', status: 'completed', usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
            output: [
                { id: 'ws_B', type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ url: 'https://example.org/releases', title: 'Release notes' }] } },
                { id: 'msg_B', type: 'message', content: [{ type: 'output_text', text: 'The new release is available.' }] },
            ],
        } }) }])
        bridge.queueWebSocketSendResponse(textFrames('response-A-final', 'Here is the latest release.', 7))
        const prepared = await service.prepare({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: textOnlyModel.id, models: [textOnlyModel, searchModel], reasoningLevel: 'medium', speed: 'standard', projectPath: PROJECT, requestApproval: false })
        const events = await collect(service.streamChat({ prepared, runId: 'search-run', sessionId: 'search-session', entries: [], userEntry: userEntry('search-user', 'PRIVATE conversation context; get the latest release.', 'search-session') }))
        const bodies = parseSentBodies(bridge)
        expect(bodies).toHaveLength(3)
        const [first, isolated, last] = bodies
        expect(first.model).toBe(textOnlyModel.id)
        expect(isolated.model).toBe(searchModel.id)
        expect(isolated.tools).toEqual([{ type: 'web_search' }])
        expect(isolated.tool_choice).toBe('required')
        expect(isolated.store).toBe(false)
        expect(isolated.previous_response_id).toBeUndefined()
        expect(isolated.prompt_cache_key).not.toBe(first.prompt_cache_key)
        expect(isolated.input).toHaveLength(1)
        expect(JSON.stringify(isolated.input)).toContain('latest release')
        expect(JSON.stringify(isolated)).not.toContain('PRIVATE')
        expect(JSON.stringify(isolated)).not.toContain(PROJECT)
        expect(last.model).toBe(textOnlyModel.id)
        const output = last.input.find((item: any) => item.type === 'function_call_output') as any
        expect(output.call_id).toBe('call_A')
        expect(output.output).toContain('The new release is available.')
        expect(output.output).not.toContain('ws_B')
        const ended = events.find((event) => event.type === 'tool-end' && event.toolName === 'web_search')
        expect(ended?.type).toBe('tool-end')
        if (ended?.type === 'tool-end') {
            expect(ended.result.isError).toBe(false)
            expect(ended.entry?.isolatedModelInvocations).toEqual([expect.objectContaining({ model: searchModel.id, parentToolCallId: ended.toolCallId, usage: expect.objectContaining({ totalTokens: 11 }) })])
        }
        const final = events.filter((event) => event.type === 'assistant-end').slice(-1)[0]
        expect(final?.type === 'assistant-end' && final.entry.content).toEqual([expect.objectContaining({ type: 'text', text: 'Here is the latest release.' })])
        await service.dispose()
    })

    it('happy path: read → edit+bash with approval → ordered outputs → final text/usage', async () => {
        const { service, bridge } = createHarness()
        const original = 'alpha line\nbeta line\n'
        bridge.setFile(TARGET_ABS, original)
        bridge.queueProcess({
            chunks: ['bash-ok\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/cpa-e2e-bash.log',
        })
        bridge.setFile('/tmp/cpa-e2e-bash.log', 'bash-ok\n')

        // One session socket; three request-driven turns.
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(
            functionCallFrames('resp_read', [
                {
                    callId: 'call_read',
                    itemId: 'fc_read',
                    name: 'read',
                    args: { path: TARGET_FILE },
                    outputIndex: 0,
                },
            ]),
        )
        bridge.queueWebSocketSendResponse(
            functionCallFrames('resp_mutate', [
                {
                    callId: 'call_edit',
                    itemId: 'fc_edit',
                    name: 'edit',
                    args: {
                        path: TARGET_FILE,
                        edits: [{ oldText: 'alpha line', newText: 'alpha edited' }],
                    },
                    outputIndex: 0,
                },
                {
                    callId: 'call_bash',
                    itemId: 'fc_bash',
                    name: 'bash',
                    args: { command: 'echo bash-ok' },
                    outputIndex: 1,
                },
            ]),
        )
        bridge.queueWebSocketSendResponse(
            textFrames('resp_final', 'All tools finished cleanly.', 42),
        )

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'fast',
            requestApproval: true,
            projectPath: PROJECT,
        })
        expect(prepared.tools.map((t) => t.name)).toEqual([
            'read',
            'bash',
            'edit',
            'write',
            'spawn_agent',
            'send_message',
            'stop_agent',
            'title',
        ])

        const runId = 'run-happy'
        const sessionId = 'sess-e2e'
        const user = userEntry('user-1', 'Please inspect notes.txt then edit and run bash')

        const eventsPromise = collect(
            service.streamChat({
                prepared,
                sessionId,
                runId,
                entries: [],
                userEntry: user,
            }),
        )

        // Approve mutating tools as soon as waiters appear (event-driven, no sleep).
        const approveLoop = (async () => {
            const deadline = Date.now() + 5_000
            const approved = new Set<string>()
            while (Date.now() < deadline && approved.size < 2) {
                for (const toolCallId of ['call_edit|fc_edit', 'call_bash|fc_bash', 'call_edit', 'call_bash']) {
                    if (approved.has(toolCallId)) continue
                    if (service.approve(runId, toolCallId)) {
                        approved.add(toolCallId)
                    }
                }
                // Yield to the agent loop microtask queue without wall-clock sleep.
                await Promise.resolve()
                await Promise.resolve()
            }
            return approved
        })()

        const events = await eventsPromise
        const approved = await approveLoop
        expect(approved.size).toBeGreaterThanOrEqual(1)

        // Tool order: read auto, then edit + bash after approval.
        const toolStarts = events.filter((e) => e.type === 'tool-start') as Array<{
            type: 'tool-start'
            toolName: string
            toolCallId: string
        }>
        expect(toolStarts.map((t) => t.toolName)).toEqual(['read', 'edit', 'bash'])

        const toolEnds = events.filter((e) => e.type === 'tool-end') as Array<{
            type: 'tool-end'
            toolName: string
            toolCallId: string
            result: { content: Array<{ type: string; text?: string }>; isError?: boolean }
        }>
        expect(toolEnds.map((t) => t.toolName)).toEqual(['read', 'edit', 'bash'])
        expect(toolEnds[0]!.result.isError).not.toBe(true)
        expect(
            toolEnds[0]!.result.content.some(
                (c) => c.type === 'text' && typeof c.text === 'string' && c.text.includes('alpha line'),
            ),
        ).toBe(true)

        // Edit actually mutated the FakeNativeBridge virtual file.
        const edited = new TextDecoder().decode(await bridge.readFile(TARGET_ABS))
        expect(edited).toContain('alpha edited')
        expect(edited).not.toContain('alpha line')

        // Bash process was started and temporary log cleaned on success.
        expect(bridge.calls.some((c) => c.method === 'startProcess')).toBe(true)
        expect(bridge.calls.some((c) => c.method === 'removeFile')).toBe(true)

        // Final assistant text + usage.
        const assistantEnds = events.filter((e) => e.type === 'assistant-end') as Array<{
            type: 'assistant-end'
            entry: AssistantEntry
        }>
        const finalAssistant = assistantEnds[assistantEnds.length - 1]!.entry
        expect(finalAssistant.stopReason).toBe('stop')
        expect(
            finalAssistant.content.some(
                (b) => b.type === 'text' && b.text.includes('All tools finished cleanly.'),
            ),
        ).toBe(true)
        expect(finalAssistant.usage?.totalTokens).toBe(44)

        // Request bodies: second+ turns include function_call_output; fast has priority.
        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(3)
        // First turn (or any tool-bearing turn) uses priority for speed=fast.
        expect(bodies.some((b) => b.service_tier === 'priority')).toBe(true)

        const secondWithOutput = bodies.find((b) =>
            (b.input ?? []).some(
                (item) =>
                    typeof item === 'object' &&
                    item !== null &&
                    (item as { type?: string }).type === 'function_call_output',
            ),
        )
        expect(secondWithOutput).toBeDefined()
        const outputs = (secondWithOutput!.input ?? []).filter(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                (item as { type?: string }).type === 'function_call_output',
        ) as Array<{ type: string; call_id: string }>
        // Source order: read first, then later edit/bash outputs appear on subsequent turns.
        expect(outputs[0]!.call_id).toBe('call_read')

        // Strict WS headers on open.
        const opens = openCalls(bridge)
        expect(opens.length).toBeGreaterThanOrEqual(1)
        const headers = (opens[0]!.args[0] as { headers: Record<string, string> }).headers
        expect(headers).toEqual(buildWebSocketHeaders(API_KEY, sessionId))
        expect(headers['OpenAI-Beta']).toBe('responses_websockets=2026-02-06')
        expect(headers.originator).toBe('cpa')
        expect(hasHttpOrSseSurface(bridge)).toBe(false)

        // Terminal run.
        expect(events[0]?.type).toBe('agent-start')
        expect(events[events.length - 1]?.type).toBe('agent-end')

        service.dispose()
    })

    it('standard speed omits service_tier priority', async () => {
        const { service, bridge } = createHarness()
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(textFrames('resp_std', 'hello standard'))

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-std',
                runId: 'run-std',
                entries: [],
                userEntry: userEntry('u-std', 'hi', 'sess-std'),
            }),
        )

        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(1)
        expect(bodies[0]!.service_tier).toBeUndefined()
        service.dispose()
    })

    it('no project path yields tools=[] and pure chat still works', async () => {
        const { service, bridge } = createHarness()
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(textFrames('resp_chat', 'pure chat ok'))

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: null,
        })
        expect(prepared.tools).toEqual([])
        expect(prepared.projectCwd).toBeUndefined()

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-chat',
                runId: 'run-chat',
                entries: [],
                userEntry: userEntry('u-chat', 'hello', 'sess-chat'),
            }),
        )

        const bodies = parseSentBodies(bridge)
        expect(
            bodies[0]!.tools
                ?.filter((tool): tool is Extract<typeof tool, { name: string }> => 'name' in tool)
                .map((tool) => tool.name),
        ).toEqual(['title'])
        expect(events.some((e) => e.type === 'assistant-end')).toBe(true)
        service.dispose()
    })

    it('connect failures retry then error without HTTP/SSE fallback', async () => {
        const { service, bridge } = createHarness()
        // Three failed opens (MAX_CONNECT_RETRIES=3): error before open.
        for (let i = 0; i < 3; i += 1) {
            bridge.queueWebSocket({
                frames: [
                    {
                        kind: 'error',
                        error: `dial refused ${i}`,
                    },
                ],
            })
        }

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-fail',
                runId: 'run-fail',
                entries: [],
                userEntry: userEntry('u-fail', 'hi', 'sess-fail'),
            }),
        )

        expect(openCalls(bridge).length).toBe(3)
        expect(bridge.calls.filter((c) => c.method === 'sendWebSocket')).toHaveLength(0)
        expect(hasHttpOrSseSurface(bridge)).toBe(false)
        expect(events.some((e) => e.type === 'error')).toBe(true)
        expect(events[events.length - 1]?.type).toBe('agent-end')
        service.dispose()
    })

    it('stop cancels websocket, process, approval waiters, and retries', async () => {
        const { service, bridge } = createHarness()
        bridge.setFile(TARGET_ABS, 'x')

        // Hold open + hold process so cancel is observable.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }],
            hold: true,
        })
        // First request: bash tool call that will wait for approval then process hold.
        bridge.queueWebSocketSendResponse(
            functionCallFrames('resp_stop', [
                {
                    callId: 'call_bash_stop',
                    itemId: 'fc_bash_stop',
                    name: 'bash',
                    args: { command: 'sleep 999' },
                    outputIndex: 0,
                },
            ]),
        )
        bridge.queueProcess({
            chunks: [],
            exitCode: 0,
            fullOutputPath: '/tmp/cpa-stop.log',
            hold: true,
        })

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: true,
            projectPath: PROJECT,
        })

        const runId = 'run-stop'
        const gen = service.streamChat({
            prepared,
            sessionId: 'sess-stop',
            runId,
            entries: [],
            userEntry: userEntry('u-stop', 'run long bash', 'sess-stop'),
        })

        const events: AgentRunEvent[] = []
        let sawApproval = false
        const consume = (async () => {
            for await (const event of gen) {
                events.push(event)
                if (event.type === 'tool-approval-required' && !sawApproval) {
                    sawApproval = true
                    // Approve so process starts, then abort mid-process.
                    service.approve(runId, event.toolCallId)
                    // Yield until process starts.
                    for (let i = 0; i < 20; i += 1) {
                        if (bridge.calls.some((c) => c.method === 'startProcess')) break
                        await Promise.resolve()
                    }
                    service.abort(runId)
                }
            }
        })()

        await consume

        expect(sawApproval).toBe(true)
        expect(bridge.calls.some((c) => c.method === 'cancel')).toBe(true)
        expect(
            events.some((e) => e.type === 'aborted' || e.type === 'agent-end'),
        ).toBe(true)
        // No leftover approval waiters.
        expect(service.getApprovalController().pendingCount(runId)).toBe(0)
        service.dispose()
    })

    it('auto compaction triggers when context exceeds threshold', async () => {
        const { service, bridge } = createHarness({
            compactionSettings: {
                enabled: true,
                reserveTokens: 10,
                keepRecentTokens: 40,
            },
        })

        // Isolated summary socket(s) + session turn socket.
        seedIsolatedSummaries(bridge, 2, 'resp_auto_sum')
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(textFrames('resp_after_compact', 'after compact'))

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: tinyWindowModel.id,
            models: [tinyWindowModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const history: ConversationEntry[] = [
            userEntry('u-old-1', 'old history padding '.repeat(80), 'sess-ac'),
            assistantDone('a-old-1', 'old answer padding '.repeat(80), 'sess-ac', 5000),
            userEntry('u-old-2', 'more history padding '.repeat(80), 'sess-ac'),
            assistantDone('a-old-2', 'more answer padding '.repeat(80), 'sess-ac', 8000),
            userEntry('u-recent', 'recent turn', 'sess-ac'),
            // Trusted usage baseline must exceed contextWindow * 0.95 (200 * 0.95).
            assistantDone('a-recent', 'ok', 'sess-ac', 5_000),
        ]

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-ac',
                runId: 'run-ac',
                entries: history,
                userEntry: userEntry('u-new', 'continue', 'sess-ac'),
            }),
        )

        expect(events.some((e) => e.type === 'compaction-start')).toBe(true)
        expect(events.some((e) => e.type === 'compaction-end')).toBe(true)
        expect(events.some((e) => e.type === 'assistant-end')).toBe(true)
        service.dispose()
    })

    it('manual compact is isolated, force path, and does not append a user entry', async () => {
        const { service, bridge } = createHarness()

        seedIsolatedSummaries(bridge, 2, 'resp_manual_sum')

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const entries: ConversationEntry[] = [
            userEntry('u0', 'old history that will be dropped '.repeat(100), 'sess-mc'),
            assistantDone('a0', 'old answer '.repeat(100), 'sess-mc'),
            userEntry('u1', 'more old history '.repeat(100), 'sess-mc'),
            assistantDone('a1', 'more old answer '.repeat(100), 'sess-mc'),
            userEntry('u2', 'recent', 'sess-mc'),
            assistantDone('a2', 'ok', 'sess-mc'),
        ]

        const result = await service.compact({
            prepared,
            sessionId: 'sess-mc',
            runId: 'run-mc',
            entries,
            customInstructions: 'focus on next steps',
        })
        expect(result.ok, result.ok ? undefined : result.message).toBe(true)
        if (!result.ok) return
        expect(result.entry.kind).toBe('compaction')
        expect(result.entry.summary).toContain('## Goal')
        // No user entry was fabricated for compact.
        expect(result.events.some((e) => e.type === 'agent-start')).toBe(true)
        expect(result.events.some((e) => e.type === 'compaction-start')).toBe(true)
        expect(result.events.some((e) => e.type === 'compaction-end')).toBe(true)

        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(1)
        // Isolated summary must not include tools.
        expect(bodies[0]!.tools).toBeUndefined()
        // Custom focus instructions surface in the summary request input/instructions.
        const serialized = JSON.stringify(bodies[0])
        expect(serialized).toMatch(/focus on next steps|Next Steps|Goal/i)
        service.dispose()
    })

    it('manual compact with fast speed sends service_tier priority', async () => {
        const { service, bridge } = createHarness()

        seedIsolatedSummaries(bridge, 2, 'resp_manual_sum_fast')

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'fast',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const entries: ConversationEntry[] = [
            userEntry('u0', 'old history that will be dropped '.repeat(100), 'sess-mc-fast'),
            assistantDone('a0', 'old answer '.repeat(100), 'sess-mc-fast'),
            userEntry('u1', 'more old history '.repeat(100), 'sess-mc-fast'),
            assistantDone('a1', 'more old answer '.repeat(100), 'sess-mc-fast'),
            userEntry('u2', 'recent', 'sess-mc-fast'),
            assistantDone('a2', 'ok', 'sess-mc-fast'),
        ]

        const result = await service.compact({
            prepared,
            sessionId: 'sess-mc-fast',
            runId: 'run-mc-fast',
            entries,
        })
        expect(result.ok, result.ok ? undefined : result.message).toBe(true)

        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(1)
        expect(bodies.every((b) => b.service_tier === 'priority')).toBe(true)
        service.dispose()
    })

    it('user image attachment and read image enter the vision request', async () => {
        const { service, bridge } = createHarness()
        bridge.setFile(`${PROJECT}/${IMAGE_REL}`, pngBytes())

        seedOpenSocket(bridge)
        // First turn: model reads the image file.
        bridge.queueWebSocketSendResponse(
            functionCallFrames('resp_img_read', [
                {
                    callId: 'call_img',
                    itemId: 'fc_img',
                    name: 'read',
                    args: { path: IMAGE_REL },
                    outputIndex: 0,
                },
            ]),
        )
        bridge.queueWebSocketSendResponse(textFrames('resp_img_final', 'I see the image'))

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })
        expect(prepared.supportsImages).toBe(true)

        // Tiny valid PNG as user attachment (base64).
        let binary = ''
        const bytes = pngBytes()
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]!)
        }
        const userImageB64 = btoa(binary)

        const user: UserEntry = {
            id: 'u-img',
            sessionId: 'sess-img',
            createdAt: 1,
            kind: 'user',
            content: [
                { type: 'text', text: 'look at this' },
                {
                    type: 'image',
                    data: userImageB64,
                    mimeType: 'image/png',
                },
            ],
        }

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-img',
                runId: 'run-img',
                entries: [],
                userEntry: user,
            }),
        )

        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(2)

        // First request includes the user image as input_image.
        const firstInput = JSON.stringify(bodies[0]!.input)
        expect(firstInput).toMatch(/input_image|image_url|data:image/)

        // Second request includes tool image output from read.
        const secondInput = JSON.stringify(bodies[1]!.input)
        expect(secondInput).toMatch(/function_call_output|input_image|image/)

        const readEnd = events.find(
            (e) =>
                e.type === 'tool-end' &&
                (e as { toolName?: string }).toolName === 'read',
        ) as {
            type: 'tool-end'
            toolName: string
            isError?: boolean
            result: { content: Array<{ type: string; data?: string; mimeType?: string }> }
        } | undefined
        expect(readEnd).toBeDefined()
        expect(readEnd!.isError).not.toBe(true)
        expect(
            readEnd!.result.content.some(
                (block) => block.type === 'image' && typeof block.data === 'string' && block.data.length > 0,
            ),
        ).toBe(true)
        service.dispose()
    })

    it('context overflow force-compacts once then second overflow terminates', async () => {
        const { service, bridge, delays } = createHarness()

        // Unlimited opens: session + isolated summaries may interleave freely.
        for (let i = 0; i < 12; i += 1) {
            bridge.queueWebSocket({ frames: [{ kind: 'websocket-open' }] })
        }

        let sessionOverflow = 0
        let summarySeq = 0
        bridge.setWebSocketSendHandler((_opId, payload) => {
            const body = JSON.parse(payload) as {
                instructions?: string
                max_output_tokens?: number
            }
            const isSummary =
                typeof body.max_output_tokens === 'number' ||
                (typeof body.instructions === 'string' &&
                    body.instructions.includes('context summarization assistant'))
            if (isSummary) {
                summarySeq += 1
                const textBody =
                    summarySeq % 2 === 1 ? validSummary() : validTurnPrefix()
                return textFrames(`resp_ovf_sum_${summarySeq}`, textBody, 5)
            }
            sessionOverflow += 1
            return overflowFailedFrames(`resp_ovf_${sessionOverflow}`)
        })

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const history: ConversationEntry[] = [
            userEntry('u0', 'old history padding '.repeat(100), 'sess-ovf'),
            assistantDone('a0', 'old answer '.repeat(100), 'sess-ovf'),
            userEntry('u1', 'more old history '.repeat(100), 'sess-ovf'),
            assistantDone('a1', 'more old answer '.repeat(100), 'sess-ovf'),
            userEntry('u2', 'recent', 'sess-ovf'),
            assistantDone('a2', 'ok', 'sess-ovf'),
        ]

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-ovf',
                runId: 'run-ovf',
                entries: history,
                userEntry: userEntry('u-ovf', 'continue huge context', 'sess-ovf'),
            }),
        )

        expect(events.filter((e) => e.type === 'compaction-start')).toHaveLength(1)
        expect(events.filter((e) => e.type === 'compaction-end')).toHaveLength(1)
        expect(events.some((e) => e.type === 'error')).toBe(true)
        // Only-once overflow retry: two session provider failures + at least one summary.
        expect(sessionOverflow).toBe(2)
        expect(summarySeq).toBeGreaterThanOrEqual(1)
        // Overflow path does not use transient retry delays.
        expect(delays).toEqual([])
        const bodies = parseSentBodies(bridge)
        expect(bodies.length).toBeGreaterThanOrEqual(3)
        service.dispose()
    })

    it('protocol middlewares intercept and enrich end-to-end WebSocket stream sessions', async () => {
        const registry = new ExtensionRegistry()
        const completedStats: Array<{ elapsedMs: number; error?: Error }> = []

        const mw: ProtocolMiddleware = {
            id: 'e2e-audit-middleware',
            onRequest: (input) => ({
                ...input,
                systemPrompt: `${input.systemPrompt}\n[E2E Policy Guardrail]`,
            }),
            onStreamEvent: (event) => {
                if (event.type === 'text-delta') {
                    return {
                        ...event,
                        delta: event.delta.replace('Hello', 'Greetings'),
                    }
                }
                return event
            },
            onStreamComplete: (stats) => {
                completedStats.push(stats)
            },
        }
        registry.registerProtocolMiddleware(mw)

        const { service, bridge } = createHarness({
            extensionRegistry: registry,
        })
        seedOpenSocket(bridge)
        bridge.queueWebSocketSendResponse(
            textFrames('resp_e2e_mw', 'Hello from model', 5),
        )

        const prepared = await service.prepare({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            modelId: visionModel.id,
            models: [visionModel],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: PROJECT,
        })

        const events = await collect(
            service.streamChat({
                prepared,
                sessionId: 'sess-e2e-mw',
                runId: 'run-e2e-mw',
                entries: [],
                userEntry: userEntry('u-1', 'hi', 'sess-e2e-mw'),
            }),
        )

        const bodies = parseSentBodies(bridge)
        expect(bodies).toHaveLength(1)
        expect(bodies[0]?.instructions).toContain('[E2E Policy Guardrail]')

        expect(completedStats).toHaveLength(1)
        expect(completedStats[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
        expect(completedStats[0]?.error).toBeUndefined()

        const assistantUpdates = events.filter(
            (e) => e.type === 'assistant-update',
        )
        expect(
            assistantUpdates.some((e) => {
                const streamEvent = (e as any).streamEvent
                return (
                    streamEvent?.type === 'text-delta' &&
                    streamEvent?.delta?.includes('Greetings')
                )
            }),
        ).toBe(true)

        await service.dispose()
    })

})
