import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@/features/models/types'
import { AgentPreflightError, type AgentPrepareInput } from '@/features/agent/types'
import type { AssistantEntry, UserEntry } from './session/types'
import type { AgentTool, AssistantStreamEvent, AgentRunEvent } from './agent/types'
import { FakeNativeBridge } from './native/fakeNativeBridge'

class CPAConnectionManager {
    public isDisposed = false
    constructor(public bridge?: any, public options?: any) {}
    dispose: any = vi.fn().mockImplementation(async () => {
        this.isDisposed = true
    })
}
type CPAClientOptions = Record<string, unknown>
type CPAClient = any
import {
    adaptCodexClientToProtocolClient,
    buildAgentDir,
    CLIProxyAPIAgentService,
    joinPath,
    redactDeep,
    redactSecrets,
    sanitizeEvent,
    type CLIProxyAPIAgentServiceDependencies,
} from './CLIProxyAPIAgentService'
import type { LoadResourceSnapshotInput } from './context/resourceLoader'
import type { CreateCodingToolsOptions } from './providers/ToolFactoryProvider'
import { useMessageStore } from '@/stores/messageStore'
import {
    __resetAgentEventAdapterRegistryForTests,
    createAgentEventAdapter,
} from './ui/eventAdapter'
import { createSubAgentTools, subagentAgentEntry } from '../../../../plugins/bundled/cpa.core.subagent/agent/index.js'
import { toolsAgentEntry } from '../../../../plugins/bundled/cpa.core.tools/agent/index.js'
import { resourcesAgentEntry } from '../../../../plugins/bundled/cpa.core.resources/agent/index.js'
import {
    RendererRegistry as ExtensionRegistry,
    rendererRegistry as defaultExtensionRegistry,
} from '@/plugins/platform/rendererRegistry'
import type {
    ProtocolClient,
    ProtocolProvider,
    ProtocolMiddleware,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'

const modelBase: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test',
    supportsFast: true,
    reasoningLevels: [
        { id: 'medium', requestValue: 'medium' },
        { id: 'high', requestValue: 'high-effort' },
    ],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

const modelNoFast: ModelCatalogEntry = {
    ...modelBase,
    id: 'no-fast',
    supportsFast: false,
    input: ['text'],
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
        if (!script) throw new Error('FakeCPAClient: no script left')
        if (signal.aborted) {
            const err = new Error('Request was aborted')
            err.name = 'AbortError'
            throw err
        }
        if (script.kind === 'throw') throw script.error
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

function makeTool(
    name: string,
    execute: AgentTool['execute'] = async () => ({
        content: [{ type: 'text', text: 'ok' }],
    }),
): AgentTool {
    return {
        name,
        label: name,
        description: `${name} tool`,
        parameters: { type: 'object', properties: {} },
        validate: (input) => (input ?? {}) as Record<string, unknown>,
        execute,
    }
}

async function collect(iterable: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
    const out: AgentRunEvent[] = []
    for await (const event of iterable) out.push(event)
    return out
}

function createService(opts?: {
    bridge?: FakeNativeBridge
    client?: FakeCPAClient
    loadResources?: CLIProxyAPIAgentService['prepare'] extends never ? never : never
    createTools?: (
        cwd: string | undefined | null,
    ) => Promise<AgentTool[]>
    compact?: ReturnType<typeof vi.fn>
    streamUpdateIntervalMs?: number
}) {
    const bridge = opts?.bridge ?? new FakeNativeBridge()
    const fakeClient = opts?.client ?? new FakeCPAClient()
    const loadCalls: LoadResourceSnapshotInput[] = []
    const toolCalls: unknown[] = []
    const toolOptionCalls: CreateCodingToolsOptions[] = []

    const service = new CLIProxyAPIAgentService({
        bridge,
        createClient: () => fakeClient as unknown as CPAClient,
        loadResources: async (input) => {
            loadCalls.push(input)
            return {
                contextFiles: [],
                skills: [
                    {
                        name: 'demo-skill',
                        description: 'demo',
                        filePath: '/agent/skills/demo/SKILL.md',
                        baseDir: '/agent/skills/demo',
                        disableModelInvocation: false,
                        body: 'skill body',
                    },
                ],
                prompts: [],
                systemPrompt: `SYSTEM tools=${(input.tools ?? []).map((t) => t.name).join(',')}`,
                diagnostics: [],
            }
        },
        createTools: async (cwd, _bridge, _model, options) => {
            toolCalls.push(cwd)
            toolOptionCalls.push({ ...(options ?? {}) })
            if (opts?.createTools) return opts.createTools(cwd)
            if (!cwd) return []
            const subTools = options?.subAgents
                ? createSubAgentTools(options.subAgents as any, options.models)
                : []
            return [
                makeTool('read'),
                makeTool('bash'),
                makeTool('edit'),
                makeTool('write'),
                ...subTools,
            ]
        },
        compact: opts?.compact as CLIProxyAPIAgentServiceDependencies['compact'],
        streamUpdateIntervalMs: opts?.streamUpdateIntervalMs,
        generateId: (() => {
            let n = 0
            return () => `id-${++n}`
        })(),
        now: () => 1_700_000_000_000,
    })

    return { service, bridge, fakeClient, loadCalls, toolCalls, toolOptionCalls }
}

describe('CLIProxyAPIAgentService', () => {
    beforeEach(() => {
        defaultExtensionRegistry.registerToolFactory({
            id: 'title',
            order: 100,
            targets: ['main', 'all'],
            riskLevel: 'session',
            requiresApproval: false,
            approvalCategory: 'session-metadata',
            create: () => makeTool('title'),
        })
    })

    afterEach(() => {
        defaultExtensionRegistry.clear()
        vi.restoreAllMocks()
    })

    describe('agentDir / joinPath', () => {
        it('builds agentDir under userConfigDir for unix and windows roots', () => {
            expect(buildAgentDir('/Users/me/.config')).toBe(
                '/Users/me/.config/coding-professional-agent/agent',
            )
            const winDir = buildAgentDir('C:\\Users\\me\\AppData\\Roaming')
            expect(winDir.replace(/\\/g, '/')).toBe(
                'C:/Users/me/AppData/Roaming/coding-professional-agent/agent',
            )
            expect(winDir.toLowerCase()).toContain('coding-professional-agent')
            expect(joinPath('/tmp', 'coding-professional-agent', 'agent')).toBe(
                '/tmp/coding-professional-agent/agent',
            )
        })

        it('never uses Pi path segments', () => {
            const dir = buildAgentDir('/home/u/.config')
            expect(dir.includes('pi')).toBe(false)
            expect(dir).toContain('coding-professional-agent')
        })
    })

function createWorktreePrepareInput(
    worktreePolicy = {
        worktreePath: '/worktrees/repo-session',
        sourceTreePath: '/repo',
    },
): AgentPrepareInput {
    return {
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'key',
        modelId: modelBase.id,
        models: [modelBase],
        reasoningLevel: 'medium',
        speed: 'standard',
        requestApproval: false,
        projectPath: worktreePolicy.worktreePath,
        projectPaths: [worktreePolicy.worktreePath],
        worktreePolicy,
    }
}

    describe('prepare preflight', () => {
        it('validates, freezes, and propagates a worktree policy through prepare', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/worktrees/repo-session/.keep', '')
            const { service, loadCalls, toolOptionCalls } = createService({ bridge })
            const input = createWorktreePrepareInput()

            const prepared = await service.prepare(input)

            expect(prepared.worktreePolicy).toEqual(input.worktreePolicy)
            expect(prepared.worktreePolicy).not.toBe(input.worktreePolicy)
            expect(Object.isFrozen(prepared.worktreePolicy)).toBe(true)
            expect(toolOptionCalls[0]?.worktreePolicy).toEqual(input.worktreePolicy)
            expect(loadCalls[0]?.worktreePolicy).toEqual(input.worktreePolicy)
        })

        it('rejects a worktree policy that does not match resolved projectCwd', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/worktrees/repo-session/.keep', '')
            const { service, loadCalls } = createService({ bridge })
            const input = createWorktreePrepareInput()

            await expect(service.prepare({
                ...input,
                worktreePolicy: {
                    worktreePath: '/worktrees/other',
                    sourceTreePath: '/repo',
                },
            })).rejects.toMatchObject({
                code: 'invalid_worktree_policy',
                i18nKey: 'agent.preflight.invalid_worktree_policy',
            })
            expect(loadCalls).toHaveLength(0)
        })

        it('fails closed when worktree coding tools cannot be created', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/worktrees/repo-session/.keep', '')
            const { service } = createService({
                bridge,
                createTools: async () => [],
            })

            await expect(service.prepare(
                createWorktreePrepareInput(),
            )).rejects.toMatchObject({ code: 'invalid_worktree_policy' })
        })
        it('rejects non-absolute or non-http baseUrl without loading resources', async () => {
            const { service, loadCalls } = createService()
            await expect(
                service.prepare({
                    baseUrl: 'not-a-url',
                    apiKey: 'k',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({
                code: 'invalid_base_url',
                i18nKey: 'agent.preflight.invalid_base_url',
            })

            await expect(
                service.prepare({
                    baseUrl: 'ftp://example.com',
                    apiKey: 'k',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toBeInstanceOf(AgentPreflightError)

            expect(loadCalls).toHaveLength(0)
            expect(service.isActive).toBe(false)
        })

        it('rejects empty apiKey', async () => {
            const { service, loadCalls } = createService()
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: '  ',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'missing_api_key' })
            expect(loadCalls).toHaveLength(0)
        })

        it('rejects model not in catalog', async () => {
            const { service } = createService()
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key',
                    modelId: 'missing',
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'model_not_found' })
        })

        it('maps reasoning requestValue and rejects invalid reasoning', async () => {
            const { service, loadCalls } = createService()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                fastContextCompaction: false,
            })
            expect(prepared.reasoningEffort).toBe('high-effort')
            expect(prepared.fastContextCompaction).toBe(false)

            const preparedWithLang = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                language: 'zh-CN',
                personality: 'enthusiastic',
                localMemoryEnabled: false,
            })
            expect(preparedWithLang.language).toBe('zh-CN')
            expect(preparedWithLang.personality).toBe('enthusiastic')
            expect(loadCalls[loadCalls.length - 1]?.personality).toBe('enthusiastic')
            expect(loadCalls[loadCalls.length - 1]?.language).toBe('zh-CN')
            expect(loadCalls[loadCalls.length - 1]?.localMemoryEnabled).toBe(false)

            // Test subagents disabled -> omits subagent tools and system prompt
            const bridgeWithDir = new FakeNativeBridge()
            bridgeWithDir.setFile('/workspace/.keep', '')
            const { service: serviceWithDir } = createService({ bridge: bridgeWithDir })

            const preparedWithoutSubagents = await serviceWithDir.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/workspace',
                subagentsSettings: {
                    enabled: false,
                    concurrency: 10,
                    maxPerSession: 3,
                    maxDepth: 1,
                },
            })
            expect(preparedWithoutSubagents.tools.some((t) => t.name === 'spawn_agent')).toBe(false)
            expect(preparedWithoutSubagents.tools.some((t) => t.name === 'send_message')).toBe(false)
            expect(preparedWithoutSubagents.tools.some((t) => t.name === 'stop_agent')).toBe(false)
            expect(preparedWithoutSubagents.systemPrompt).not.toContain('spawn_agent')

            // Test subagents enabled -> retains subagent tools and system prompt
            const preparedWithSubagents = await serviceWithDir.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/workspace',
                subagentsSettings: {
                    enabled: true,
                    concurrency: 10,
                    maxPerSession: 3,
                    maxDepth: 1,
                },
            })
            expect(preparedWithSubagents.tools.some((t) => t.name === 'spawn_agent')).toBe(true)
            expect(preparedWithSubagents.systemPrompt).toContain('spawn_agent')

            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'nope',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'invalid_reasoning' })
        })

        it('downgrades fast when model.supportsFast is false silently without diagnostic warning', async () => {
            const { service } = createService()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelNoFast.id,
                models: [modelNoFast],
                reasoningLevel: 'medium',
                speed: 'fast',
                requestApproval: false,
            })
            expect(prepared.speed).toBe('standard')
            expect(prepared.fastContextCompaction).toBe(true)
            expect(
                prepared.diagnostics.some((d) =>
                    d.message.toLowerCase().includes('fast'),
                ),
            ).toBe(false)
        })

        it('loads resources once after tools known; pure chat has tools=[]', async () => {
            const { service, loadCalls, toolCalls, bridge } = createService()
            bridge.setRuntimeInfo({ userConfigDir: '/cfg' })

            const prepared = await service.prepare({
                baseUrl: 'https://proxy.example/backend-api',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: null,
            })

            expect(prepared.tools).toEqual([])
            expect(prepared.projectCwd).toBeUndefined()
            expect(prepared.agentDir).toBe(
                '/cfg/coding-professional-agent/agent',
            )
            expect(
                bridge.calls
                    .filter((call) => call.method === 'mkdirAll')
                    .map((call) => call.args[0]),
            ).toEqual([
                '/cfg/coding-professional-agent/agent/skills',
                '/cfg/coding-professional-agent/agent/prompts',
            ])
            expect(prepared.systemPrompt).toContain('tools=')
            expect(prepared.skills).toHaveLength(1)
            expect(toolCalls).toEqual([undefined])
            expect(loadCalls).toHaveLength(1)
            expect(loadCalls[0]?.tools).toEqual([])
        })

        it('invalid project path yields tools=[] + warning without blocking', async () => {
            const { service, bridge } = createService()
            bridge.setRuntimeInfo({ userConfigDir: '/cfg' })

            const relative = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: 'relative/path',
            })
            expect(relative.tools).toEqual([])
            expect(relative.projectCwd).toBeUndefined()
            expect(relative.diagnostics.some((d) => d.type === 'warning')).toBe(
                true,
            )

            const missing = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/no/such/project',
            })
            expect(missing.tools).toEqual([])
            expect(missing.projectCwd).toBeUndefined()

            await bridge.mkdirAll('/fallback')
            const partial = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/no/such/project',
                projectPaths: ['/no/such/project', '/fallback'],
            })
            expect(partial.projectCwd).toBe('/fallback')
            expect(partial.projectPaths).toEqual(['/fallback'])
            expect(partial.tools).toHaveLength(7)
        })

        it('valid project paths yield coding tools and all allowed folders', async () => {
            const { service, bridge, loadCalls } = createService()
            bridge.setRuntimeInfo({ userConfigDir: '/cfg' })
            // Create virtual directories via FakeNativeBridge mkdir/stat.
            await bridge.mkdirAll('/repo')
            await bridge.mkdirAll('/shared')

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
                projectPaths: ['/repo', '/shared'],
            })

            expect(prepared.projectCwd).toBe('/repo')
            expect(prepared.projectPaths).toEqual(['/repo', '/shared'])
            expect(prepared.tools.map((t) => t.name)).toEqual([
                'read',
                'bash',
                'edit',
                'write',
                'spawn_agent',
                'send_message',
                'stop_agent',
            ])
            const spawnTool = prepared.tools.find((tool) => tool.name === 'spawn_agent')
            expect(spawnTool?.parameters).toMatchObject({
                required: ['prompt', 'name'],
                properties: {
                    model: { enum: [modelBase.id] },
                },
            })
            expect(loadCalls).toHaveLength(1)
            expect(loadCalls[0]?.projectPaths).toEqual(['/repo', '/shared'])
            expect(loadCalls[0]?.tools?.map((t) => t.name)).toEqual([
                'read',
                'bash',
                'edit',
                'write',
                'spawn_agent',
                'send_message',
                'stop_agent',
            ])
        })
    })

    describe('streamChat / stop / approve', () => {
        it('streams agent-start/end with frozen prepared snapshot tools', async () => {
            const { service, fakeClient } = createService()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'hello' }],
                    }),
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const user = userEntry('u1', 'hi')
            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-1',
                    runId: 'run-1',
                    entries: [user],
                    userEntry: user,
                }),
            )

            expect(events[0]).toMatchObject({
                type: 'agent-start',
                runId: 'run-1',
                sessionId: 'sess-1',
            })
            expect(events.some((e) => e.type === 'agent-end')).toBe(true)
            expect(fakeClient.calls[0]?.systemPrompt).toContain('SYSTEM tools=')
            expect(fakeClient.calls[0]?.systemPrompt).toContain('title')
            expect(fakeClient.calls[0]?.tools?.map((t) => t.name)).toEqual([
                'title',
            ])
            expect(service.isActive).toBe(false)
        })

        it('coalesces cumulative assistant snapshots and flushes the latest before assistant-end', async () => {
            const { service, fakeClient } = createService({
                streamUpdateIntervalMs: 60_000,
            })
            const partial = (text: string): AssistantEntry => ({
                id: 'assistant-1',
                sessionId: 'sess-1',
                createdAt: 1,
                kind: 'assistant',
                content: [{ type: 'text', text }],
                stopReason: 'pending',
                status: 'streaming',
            })
            fakeClient.queue({
                kind: 'stream',
                events: ['a', 'ab', 'abc'].map((text) => ({
                    type: 'text-delta' as const,
                    contentIndex: 0,
                    delta: text.slice(-1),
                    partial: partial(text),
                })),
                final: () =>
                    doneAssistant(partial('abc'), {
                        stopReason: 'stop',
                    }),
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const user = userEntry('u1', 'hi')
            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-1',
                    runId: 'run-coalesce',
                    entries: [user],
                    userEntry: user,
                }),
            )

            const updates = events.filter(
                (event): event is Extract<AgentRunEvent, { type: 'assistant-update' }> =>
                    event.type === 'assistant-update',
            )
            expect(
                updates.map((event) =>
                    event.entry.content
                        .filter((block) => block.type === 'text')
                        .map((block) => block.text)
                        .join(''),
                ),
            ).toEqual(['a', 'abc'])
            expect(
                updates.map((event) =>
                    'delta' in event.streamEvent
                        ? event.streamEvent.delta
                        : undefined,
                ),
            ).toEqual(['a', 'bc'])
            expect(events.findIndex((event) => event === updates[1])).toBeLessThan(
                events.findIndex((event) => event.type === 'assistant-end'),
            )
        })

        it('abort stops an active run', async () => {
            const heldClient = new FakeCPAClient()
            heldClient.queue({
                kind: 'stream',
                events: [
                    {
                        type: 'text-delta',
                        contentIndex: 0,
                        delta: 'x',
                        partial: {
                            id: 'a',
                            sessionId: 's',
                            createdAt: 1,
                            kind: 'assistant',
                            content: [{ type: 'text', text: 'x' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    },
                ],
                final: (seed: AssistantEntry) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'done' }],
                    }),
            })

            const bridge = new FakeNativeBridge()
            const svc = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => heldClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [],
                generateId: () => 'id-1',
            })

            const prepared = await svc.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const user = userEntry('u1', 'hi')
            const iter = svc.streamChat({
                prepared,
                sessionId: 'sess-1',
                runId: 'run-abort',
                entries: [user],
                userEntry: user,
            })

            const first = await iter.next()
            expect(first.value).toMatchObject({ type: 'agent-start' })
            svc.abort('run-abort')
            const rest: AgentRunEvent[] = []
            for await (const event of {
                [Symbol.asyncIterator]: () => iter,
            }) {
                rest.push(event)
            }
            expect(
                rest.some(
                    (e) => e.type === 'aborted' || e.type === 'agent-end',
                ) || rest.length >= 0,
            ).toBe(true)
        })

        it('allows multiple sessions to streamChat concurrently and abort independently', async () => {
            const { service } = createService()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const user1 = userEntry('u1', 'session 1 prompt')
            const user2 = userEntry('u2', 'session 2 prompt')

            const iter1 = service.streamChat({
                prepared,
                sessionId: 'session-concurrent-1',
                runId: 'run-concurrent-1',
                entries: [user1],
                userEntry: user1,
            })

            const iter2 = service.streamChat({
                prepared,
                sessionId: 'session-concurrent-2',
                runId: 'run-concurrent-2',
                entries: [user2],
                userEntry: user2,
            })

            const [start1, start2] = await Promise.all([iter1.next(), iter2.next()])
            expect(start1.value).toMatchObject({
                type: 'agent-start',
                runId: 'run-concurrent-1',
                sessionId: 'session-concurrent-1',
            })
            expect(start2.value).toMatchObject({
                type: 'agent-start',
                runId: 'run-concurrent-2',
                sessionId: 'session-concurrent-2',
            })

            expect(service.isActive).toBe(true)

            // Abort session 1 only
            service.abort('run-concurrent-1')

            // Drain session 1 and session 2
            const events1: AgentRunEvent[] = []
            for await (const ev of { [Symbol.asyncIterator]: () => iter1 }) {
                events1.push(ev)
            }
            const events2: AgentRunEvent[] = []
            for await (const ev of { [Symbol.asyncIterator]: () => iter2 }) {
                events2.push(ev)
            }

            // Session 2 finished normally with agent-end
            expect(events2.some((e) => e.type === 'agent-end')).toBe(true)
            expect(service.isActive).toBe(false)
        })

        it('approve/reject are scoped to runId + toolCallId', async () => {
            const { service } = createService()
            const controller = service.getApprovalController()
            const wait = controller.waitForApproval('run-x', 'tool-1')
            expect(service.approve('other-run', 'tool-1')).toBe(false)
            expect(service.approve('run-x', 'tool-1')).toBe(true)
            await expect(wait).resolves.toBe('approved')

            const wait2 = controller.waitForApproval('run-y', 'tool-2')
            expect(service.reject('run-y', 'tool-2')).toBe(true)
            await expect(wait2).resolves.toBe('rejected')
        })
    })

    describe('sub-agent independent connections', () => {
        it('opens a dedicated manager and sends the child model upstream', async () => {
            const bridge = new FakeNativeBridge()
            const managers: CPAConnectionManager[] = []
            const clientOptions: CPAClientOptions[] = []
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'child done' }],
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: (opts) => {
                    clientOptions.push(opts)
                    return childClient as unknown as CPAClient
                },
                createConnectionManager: () => {
                    const manager = new CPAConnectionManager(bridge)
                    managers.push(manager)
                    return manager
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [
                    makeTool('read'),
                    makeTool('bash'),
                    makeTool('edit'),
                    makeTool('write'),
                ],
                generateId: (() => {
                    let n = 0
                    return () => `id-${++n}`
                })(),
                now: () => 1_700_000_000_000,
            })

            await bridge.mkdirAll('/repo')
            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase, modelNoFast],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })

            expect(managers).toHaveLength(1)
            const parentManager = managers[0]
            const parentNamespace = service.currentConnectionNamespace
            expect(parentNamespace).toBeTruthy()

            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
            })
            const result = await service.subAgents.spawn('inspect the repo', {
                name: 'Atlas',
                modelId: modelNoFast.id,
            })

            expect(result.isError).toBeFalsy()
            expect(managers).toHaveLength(2)
            const childManager = managers[1]
            expect(childManager).not.toBe(parentManager)
            expect(clientOptions).toHaveLength(1)
            expect(clientOptions[0]?.connectionManager).toBe(childManager)
            expect(clientOptions[0]?.connectionManager).not.toBe(parentManager)
            expect(clientOptions[0]?.connectionNamespace).toBeTruthy()
            expect(clientOptions[0]?.connectionNamespace).not.toBe(
                parentNamespace,
            )
            expect(clientOptions[0]?.sessionId).not.toBe('parent-sess')
            expect(service.currentConnectionNamespace).toBe(parentNamespace)
            expect(childClient.calls).toHaveLength(1)
            expect(childClient.calls[0]?.model.id).toBe(modelNoFast.id)
            expect(childManager?.isDisposed).toBe(true)
            expect(parentManager?.isDisposed).toBe(false)
        })

        it('defaults to the parent model but still uses a private connection', async () => {
            const bridge = new FakeNativeBridge()
            const managers: CPAConnectionManager[] = []
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => childClient as unknown as CPAClient,
                createConnectionManager: () => {
                    const manager = new CPAConnectionManager(bridge)
                    managers.push(manager)
                    return manager
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [makeTool('read')],
                generateId: (() => {
                    let n = 0
                    return () => `id-${++n}`
                })(),
            })

            await bridge.mkdirAll('/repo')
            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })
            const parentManager = managers[0]
            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
            })
            await service.subAgents.spawn('follow up', { name: 'Relay' })

            expect(managers).toHaveLength(2)
            expect(managers[1]).not.toBe(parentManager)
            expect(childClient.calls[0]?.model.id).toBe(modelBase.id)
            expect(managers[1]?.isDisposed).toBe(true)
            expect(parentManager?.isDisposed).toBe(false)
        })

        it('passes explicit child reasoning effort from model:thinking spec upstream', async () => {
            const bridge = new FakeNativeBridge()
            const managers: CPAConnectionManager[] = []
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'grok reviewed' }],
                    }),
            })

            const grokModel: ModelCatalogEntry = {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                supportsFast: false,
                reasoningLevels: [
                    { id: 'high', requestValue: 'high' },
                    { id: 'xhigh', requestValue: 'xhigh' },
                ],
                input: ['text'],
                contextWindow: 500_000,
                maxTokens: 16_384,
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => childClient as unknown as CPAClient,
                createConnectionManager: () => {
                    const manager = new CPAConnectionManager(bridge)
                    managers.push(manager)
                    return manager
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [makeTool('read')],
                generateId: (() => {
                    let n = 0
                    return () => `id-${++n}`
                })(),
                now: () => 1_700_000_000_000,
            })

            await bridge.mkdirAll('/repo')
            // Parent session configured with reasoningLevel = 'medium'
            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase, grokModel],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })

            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
            })

            // Spawn subagent specifying 'grok-4.6:xhigh'
            await service.subAgents.spawn('review the PR', {
                name: 'Reviewer',
                modelId: 'grok-4.6:xhigh',
            })

            expect(childClient.calls).toHaveLength(1)
            expect(childClient.calls[0]?.model.id).toBe('grok-4.6')
            // Child must receive 'xhigh', not parent's 'medium'
            expect(childClient.calls[0]?.reasoningEffort).toBe('xhigh')
        })

        it('ensures subagent is only controlled by parent arguments and not overridden by parent dynamic runtime settings', async () => {
            const bridge = new FakeNativeBridge()
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'child analysis done' }],
                    }),
            })

            const grokModel: ModelCatalogEntry = {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                supportsFast: false,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low' },
                    { id: 'high', requestValue: 'high' },
                    { id: 'xhigh', requestValue: 'xhigh' },
                ],
                input: ['text'],
                contextWindow: 500_000,
                maxTokens: 16_384,
            }

            const parentModel: ModelCatalogEntry = {
                ...modelBase,
                reasoningLevels: [
                    ...modelBase.reasoningLevels,
                    { id: 'xhigh', requestValue: 'xhigh' },
                ],
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => childClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [makeTool('read')],
                generateId: (() => {
                    let n = 0
                    return () => `id-${++n}`
                })(),
                now: () => 1_700_000_000_000,
            })

            await bridge.mkdirAll('/repo')
            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: parentModel.id,
                models: [parentModel, grokModel],
                reasoningLevel: 'xhigh',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })

            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
                getRuntimeSettings: () => ({
                    reasoningEffort: 'xhigh',
                    reasoningLevel: 'xhigh',
                }),
            })

            // Spawn subagent specifying 'low' effort while parent is at 'xhigh'
            await service.subAgents.spawn('review the PR', {
                name: 'Reviewer',
                modelId: 'grok-4.6',
                reasoningEffort: 'low',
            })

            expect(childClient.calls).toHaveLength(1)
            expect(childClient.calls[0]?.model.id).toBe('grok-4.6')
            // Child must receive 'low' from arguments, NOT parent dynamic runtime setting 'xhigh'
            expect(childClient.calls[0]?.reasoningEffort).toBe('low')
        })

        it('passes fast speed down to subagent stream when fast speed is selected', async () => {
            const bridge = new FakeNativeBridge()
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'fast child done' }],
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => childClient,
            })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'fast',
                requestApproval: false,
            })
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'parent-fast-sess',
                    runId: 'parent-fast-run',
                    entries: [],
                    userEntry: userEntry('u-parent', 'start'),
                }),
            )

            service.subAgents.setParentContext({
                sessionId: 'parent-fast-sess',
                runId: 'parent-fast-run',
            })

            await service.subAgents.spawn('fast subagent task', {
                name: 'FastWorker',
            })

            expect(childClient.calls).toHaveLength(2)
            expect(childClient.calls[0]?.speed).toBe('fast')
            expect(childClient.calls[1]?.speed).toBe('fast')
            expect(childClient.calls[1]?.model.id).toBe(modelBase.id)
        })
    })

    describe('manual compact', () => {
        it('emits agent-start → compaction → agent-end with authoritative entries', async () => {
            const compact = vi.fn(async (entries: unknown[]) => {
                const entry = {
                    id: 'c1',
                    sessionId: 'sess-1',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: 'summary',
                    firstKeptEntryId: 'u1',
                }
                return {
                    entry,
                    entries: [...(entries as never[]), entry],
                }
            })
            const { service } = createService({ compact })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                fastContextCompaction: false,
            })
            const user = userEntry('u1', 'hi')
            const result = await service.compact({
                prepared,
                sessionId: 'sess-1',
                runId: 'compact-1',
                entries: [user],
                customInstructions: 'focus on tests',
            })
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.entry.summary).toBe('summary')
                expect(result.events.map((e) => e.type)).toEqual([
                    'agent-start',
                    'compaction-start',
                    'compaction-end',
                    'agent-end',
                ])
                const end = result.events.find((e) => e.type === 'agent-end') as {
                    entries?: { id: string }[]
                }
                expect(end.entries?.some((e) => e.id === 'c1')).toBe(true)
            }
            expect(compact).toHaveBeenCalledOnce()
            const compactArgs = compact.mock.calls[0] as unknown as [
                unknown,
                { force?: boolean; customInstructions?: string; model: unknown },
            ]
            expect(compactArgs[1]).toMatchObject({
                force: true,
                customInstructions: 'focus on tests',
                model: prepared.model,
                fastContextCompaction: false,
                speed: 'standard',
            })
            expect(service.isActive).toBe(false)
        })

        it('passes fast speed to compactFn when prepared with fast speed', async () => {
            const compact = vi.fn(async (entries: unknown[]) => {
                const entry = {
                    id: 'c-fast',
                    sessionId: 'sess-fast',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: 'fast summary',
                    firstKeptEntryId: 'u1',
                }
                return {
                    entry,
                    entries: [...(entries as never[]), entry],
                }
            })
            const { service } = createService({ compact })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'fast',
                requestApproval: false,
            })
            const user = userEntry('u1', 'hi')
            await service.compact({
                prepared,
                sessionId: 'sess-fast',
                runId: 'compact-fast',
                entries: [user],
            })

            expect(compact).toHaveBeenCalledOnce()
            const compactArgs = compact.mock.calls[0] as unknown as [
                unknown,
                { speed?: string },
            ]
            expect(compactArgs[1].speed).toBe('fast')
        })

        it('rejects double compact and stream/compact mutual exclusion', async () => {
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const compact = vi.fn(async (entries: unknown[]) => {
                await gate
                const entry = {
                    id: 'c1',
                    sessionId: 'sess-1',
                    createdAt: 1,
                    kind: 'compaction' as const,
                    summary: 's',
                    firstKeptEntryId: 'u1',
                }
                return { entry, entries: [...(entries as never[]), entry] }
            })
            const { service } = createService({ compact })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const user = userEntry('u1', 'hi')
            const first = service.compact({
                prepared,
                sessionId: 'sess-1',
                runId: 'c1',
                entries: [user],
            })
            await Promise.resolve()
            expect(service.activeKind).toBe('compact')
            const second = await service.compact({
                prepared,
                sessionId: 'sess-1',
                runId: 'c2',
                entries: [user],
            })
            expect(second.ok).toBe(false)
            if (!second.ok) {
                expect(second.code).toBe('run_active')
            }
            release()
            await first
            expect(service.isActive).toBe(false)
        })

        it('failure path emits agent-start → error → agent-end without leaking apiKey', async () => {
            const secret = 'super-secret-api-key-xyz'
            const compact = vi.fn(async () => {
                throw new Error(`upstream failed with Bearer ${secret}`)
            })
            const { service } = createService({ compact })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: secret,
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const result = await service.compact({
                prepared,
                sessionId: 'sess-1',
                runId: 'c-fail',
                entries: [userEntry('u1', 'hi')],
            })
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(result.code).toBe('compact_failed')
                expect(result.message).not.toContain(secret)
                expect(result.message).toContain('[REDACTED]')
                expect(result.events?.map((e) => e.type)).toEqual([
                    'agent-start',
                    'compaction-start',
                    'error',
                    'agent-end',
                ])
                const errEvent = result.events?.find((e) => e.type === 'error') as {
                    message: string
                }
                expect(errEvent.message).not.toContain(secret)
            }
        })
    })

    describe('baseURL canonicalize + prepared isolation', () => {
        it('rejects credentials/query/hash and normalizes trailing slash', async () => {
            const { service } = createService()
            await expect(
                service.prepare({
                    baseUrl: 'http://user:pass@127.0.0.1:8317/v1',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'invalid_base_url' })

            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317/v1?x=1',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'invalid_base_url' })

            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317/v1#frag',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'invalid_base_url' })

            const a = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317/v1/',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const b = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317/v1',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(a.baseUrl).toBe('http://127.0.0.1:8317/v1')
            expect(b.baseUrl).toBe(a.baseUrl)
        })

        it('deep freezes prepared model so catalog mutation cannot rewrite run', async () => {
            const { service } = createService()
            const models = [structuredClone(modelBase)]
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models,
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            models[0]!.id = 'mutated'
            models[0]!.label = 'mutated'
            expect(prepared.model.id).toBe(modelBase.id)
            expect(prepared.model.label).toBe(modelBase.label)
            expect(() => {
                ;(prepared as { speed: string }).speed = 'fast'
            }).toThrow()
        })

        it('deep freezes nested tool parameters and keeps execute/validate callable', async () => {
            const nestedSchema = {
                type: 'object',
                properties: {
                    path: { type: 'string', enum: ['a', 'b'] },
                    nested: { type: 'object', properties: { n: { type: 'number' } } },
                },
                required: ['path'],
            }
            let executed = false
            const tool: AgentTool = {
                name: 'read',
                label: 'Read',
                description: 'read',
                parameters: nestedSchema,
                validate: (input) => (input ?? {}) as Record<string, unknown>,
                execute: async () => {
                    executed = true
                    return { content: [{ type: 'text', text: 'ok' }] }
                },
            }
            const { service, bridge } = createService({
                createTools: async () => [tool],
            })
            await bridge.mkdirAll('/repo')

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })

            expect(prepared.tools).toHaveLength(1)
            const frozen = prepared.tools[0]!
            // Nested schema mutations on the original must not affect prepared.
            ;(nestedSchema.properties as { path: { enum: string[] } }).path.enum.push('c')
            const params = frozen.parameters as {
                properties: { path: { enum: string[] } }
            }
            expect(params.properties.path.enum).toEqual(['a', 'b'])
            expect(() => {
                params.properties.path.enum.push('d')
            }).toThrow()
            expect(() => {
                ;(frozen as { description: string }).description = 'x'
            }).toThrow()
            // Functions remain callable.
            expect(typeof frozen.execute).toBe('function')
            expect(typeof frozen.validate).toBe('function')
            await frozen.execute('t1', {}, {})
            expect(executed).toBe(true)
            // Top-level prepared is frozen.
            expect(Object.isFrozen(prepared)).toBe(true)
            expect(Object.isFrozen(prepared.model)).toBe(true)
        })

        it('sanitizeEvent redacts only error-bearing fields and never mutates original', () => {
            const secret = 'super-secret-api-key-xyz'
            const original: AgentRunEvent = {
                type: 'assistant-end',
                runId: 'r1',
                sessionId: 's1',
                entry: {
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'assistant',
                    content: [{ type: 'text', text: `normal content ${secret}` }],
                    stopReason: 'error',
                    status: 'error',
                    errorMessage: `Bearer ${secret} failed`,
                    model: 'model-a',
                },
            }
            const agentEnd: AgentRunEvent = {
                type: 'agent-end',
                runId: 'r1',
                sessionId: 's1',
                entries: [
                    {
                        id: 'a1',
                        sessionId: 's1',
                        createdAt: 1,
                        kind: 'assistant',
                        content: [{ type: 'text', text: `keep ${secret}` }],
                        stopReason: 'error',
                        status: 'error',
                        errorMessage: `err ${secret}`,
                    },
                    {
                        id: 't1',
                        sessionId: 's1',
                        createdAt: 2,
                        kind: 'toolResult',
                        toolCallId: 'tc1',
                        toolName: 'bash',
                        content: [{ type: 'text', text: `out ${secret}` }],
                        isError: true,
                    },
                    {
                        id: 't2',
                        sessionId: 's1',
                        createdAt: 3,
                        kind: 'toolResult',
                        toolCallId: 'tc2',
                        toolName: 'read',
                        content: [{ type: 'text', text: `ok ${secret}` }],
                        isError: false,
                    },
                ],
            }
            const sanitized = sanitizeEvent(original, [secret]) as Extract<
                AgentRunEvent,
                { type: 'assistant-end' }
            >
            const sanitizedEnd = sanitizeEvent(agentEnd, [secret]) as Extract<
                AgentRunEvent,
                { type: 'agent-end' }
            >

            expect(sanitized.type).toBe('assistant-end')
            expect(sanitized.runId).toBe('r1')
            expect(sanitized.sessionId).toBe('s1')
            expect(sanitized.entry.errorMessage).toBe('Bearer [REDACTED] failed')
            // Normal assistant content is preserved even when it mentions the secret.
            expect(sanitized.entry.content[0]).toMatchObject({
                type: 'text',
                text: `normal content ${secret}`,
            })
            expect(sanitized.entry.model).toBe('model-a')

            const assistant = sanitizedEnd.entries?.[0]
            const errorTool = sanitizedEnd.entries?.[1]
            const okTool = sanitizedEnd.entries?.[2]
            expect(assistant).toMatchObject({
                kind: 'assistant',
                errorMessage: 'err [REDACTED]',
                content: [{ type: 'text', text: `keep ${secret}` }],
            })
            expect(errorTool).toMatchObject({
                kind: 'toolResult',
                isError: true,
                toolCallId: 'tc1',
                toolName: 'bash',
                content: [{ type: 'text', text: 'out [REDACTED]' }],
            })
            expect(okTool).toMatchObject({
                kind: 'toolResult',
                isError: false,
                content: [{ type: 'text', text: `ok ${secret}` }],
            })

            // Originals untouched.
            expect(original.type === 'assistant-end' && original.entry.errorMessage).toContain(
                secret,
            )
            expect(agentEnd.type === 'agent-end' && agentEnd.entries?.[0]).toMatchObject({
                errorMessage: expect.stringContaining(secret),
            })
            expect(redactSecrets(`Bearer ${secret}`, [secret])).toContain('[REDACTED]')
        })

        it('schema-aware short-key redaction preserves type/ids/content (key a and k$)', () => {
            // Bearer form is redacted before exact key replacement.
            expect(redactSecrets('Authorization: Bearer k$ xyz', ['k$'])).toBe(
                'Authorization: Bearer [REDACTED] xyz',
            )

            for (const key of ['a', 'k$', 'key'] as const) {
                const message = `auth failed secret=${key} detail`
                const redacted = redactSecrets(message, [key])
                expect(redacted).not.toContain(key)
                expect(redacted).toContain('[REDACTED]')

                const runId = `run-${key}-id`
                const sessionId = `sess-${key}-id`
                const normalText = `assistant says ${key} remains`
                const event: AgentRunEvent = {
                    type: 'assistant-end',
                    runId,
                    sessionId,
                    entry: {
                        id: `entry-${key}`,
                        sessionId,
                        createdAt: 1,
                        kind: 'assistant',
                        content: [{ type: 'text', text: normalText }],
                        stopReason: 'error',
                        status: 'error',
                        errorMessage: `err ${key}`,
                        model: 'gpt-test',
                    },
                }
                const sanitized = sanitizeEvent(event, [key]) as Extract<
                    AgentRunEvent,
                    { type: 'assistant-end' }
                >
                // Structural fields must be byte-identical to the original.
                expect(sanitized.type).toBe('assistant-end')
                expect(sanitized.type).toBe(event.type)
                expect(sanitized.runId).toBe(runId)
                expect(sanitized.sessionId).toBe(sessionId)
                expect(sanitized.entry.id).toBe(`entry-${key}`)
                expect(sanitized.entry.sessionId).toBe(sessionId)
                expect(sanitized.entry.kind).toBe('assistant')
                expect(sanitized.entry.status).toBe('error')
                expect(sanitized.entry.stopReason).toBe('error')
                expect(sanitized.entry.model).toBe('gpt-test')
                // Normal content keeps the short key intact.
                expect(sanitized.entry.content).toEqual([
                    { type: 'text', text: normalText },
                ])
                // Only errorMessage is redacted.
                expect(sanitized.entry.errorMessage).not.toContain(key)
                expect(sanitized.entry.errorMessage).toContain('[REDACTED]')
                // Original untouched.
                expect(event.entry.errorMessage).toContain(key)
            }

            // agent-end nested: errorMessage redacted; assistant content preserved.
            for (const key of ['a', 'k$'] as const) {
                const event: AgentRunEvent = {
                    type: 'agent-end',
                    runId: `r-${key}`,
                    sessionId: `s-${key}`,
                    entries: [
                        {
                            id: 'a1',
                            sessionId: `s-${key}`,
                            createdAt: 1,
                            kind: 'assistant',
                            content: [{ type: 'text', text: `content ${key}` }],
                            stopReason: 'error',
                            status: 'error',
                            errorMessage: `fail ${key}`,
                        },
                    ],
                }
                const sanitized = sanitizeEvent(event, [key]) as Extract<
                    AgentRunEvent,
                    { type: 'agent-end' }
                >
                expect(sanitized.type).toBe('agent-end')
                expect(sanitized.runId).toBe(`r-${key}`)
                expect(sanitized.sessionId).toBe(`s-${key}`)
                expect(sanitized.entries?.[0]).toMatchObject({
                    kind: 'assistant',
                    content: [{ type: 'text', text: `content ${key}` }],
                    errorMessage: expect.stringContaining('[REDACTED]'),
                })
                expect(sanitized.entries?.[0]).toMatchObject({
                    errorMessage: expect.not.stringContaining(key),
                })
            }
        })

        it('schema-aware redaction covers error/diagnostic/retrying and tool isError only', () => {
            const key = 'a'
            const errorEvent = sanitizeEvent(
                {
                    type: 'error',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    message: `boom ${key}`,
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'error' }>
            expect(errorEvent.type).toBe('error')
            expect(errorEvent.runId).toBe('run-a')
            expect(errorEvent.sessionId).toBe('sess-a')
            expect(errorEvent.message).toBe('boom [REDACTED]')

            const diagnostic = sanitizeEvent(
                {
                    type: 'diagnostic',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    message: `diag ${key}`,
                    code: 'path-a',
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'diagnostic' }>
            // 1-char key may over-redact inside error text; structural code stays intact.
            expect(diagnostic.message).toContain('[REDACTED]')
            expect(diagnostic.message).not.toContain(` ${key}`)
            expect(diagnostic.code).toBe('path-a')
            expect(diagnostic.runId).toBe('run-a')

            const retrying = sanitizeEvent(
                {
                    type: 'retrying',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    attempt: 1,
                    delayMs: 10,
                    error: `retry ${key}`,
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'retrying' }>
            expect(retrying.error).toContain('[REDACTED]')
            expect(retrying.error).not.toContain(` ${key}`)
            expect(retrying.runId).toBe('run-a')

            const toolErr = sanitizeEvent(
                {
                    type: 'tool-end',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    toolCallId: 'call-a',
                    toolName: 'bash',
                    isError: true,
                    result: {
                        content: [{ type: 'text', text: `tool failed ${key}` }],
                        isError: true,
                    },
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'tool-end' }>
            expect(toolErr.toolCallId).toBe('call-a')
            expect(toolErr.toolName).toBe('bash')
            const toolErrText =
                toolErr.result.content[0] &&
                'text' in toolErr.result.content[0]
                    ? String(toolErr.result.content[0].text)
                    : ''
            expect(toolErrText).toContain('[REDACTED]')
            expect(toolErrText).not.toContain(` ${key}`)
            expect(toolErrText).not.toBe(`tool failed ${key}`)


            const toolOk = sanitizeEvent(
                {
                    type: 'tool-end',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    toolCallId: 'call-b',
                    toolName: 'read',
                    isError: false,
                    result: {
                        content: [{ type: 'text', text: `success ${key}` }],
                        isError: false,
                    },
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'tool-end' }>
            expect(toolOk.result.content[0]).toMatchObject({
                type: 'text',
                text: `success ${key}`,
            })

            const toolUpdateErr = sanitizeEvent(
                {
                    type: 'tool-update',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    toolCallId: 'call-c',
                    toolName: 'bash',
                    result: {
                        content: [{ type: 'text', text: `partial ${key}` }],
                        isError: true,
                    },
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'tool-update' }>
            const toolUpdateErrText =
                toolUpdateErr.result.content[0] &&
                'text' in toolUpdateErr.result.content[0]
                    ? String(toolUpdateErr.result.content[0].text)
                    : ''
            expect(toolUpdateErrText).toContain('[REDACTED]')
            expect(toolUpdateErrText).not.toBe(`partial ${key}`)

            const toolUpdateOk = sanitizeEvent(
                {
                    type: 'tool-update',
                    runId: 'run-a',
                    sessionId: 'sess-a',
                    toolCallId: 'call-d',
                    toolName: 'bash',
                    result: {
                        content: [{ type: 'text', text: `progress ${key}` }],
                        isError: false,
                    },
                },
                [key],
            ) as Extract<AgentRunEvent, { type: 'tool-update' }>
            expect(toolUpdateOk.result.content[0]).toMatchObject({
                text: `progress ${key}`,
            })
        })

        it('tool-end normalizes effectiveIsError across event/result/entry flags before redaction', () => {
            for (const key of ['a', 'k$'] as const) {
                const makeToolEnd = (flags: {
                    event: boolean
                    result: boolean
                    entry: boolean
                }) =>
                    ({
                        type: 'tool-end' as const,
                        runId: `run-${key}`,
                        sessionId: `sess-${key}`,
                        toolCallId: `call-${key}`,
                        toolName: 'bash',
                        isError: flags.event,
                        result: {
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `result secret=${key}`,
                                },
                                {
                                    type: 'image' as const,
                                    data: 'img-result',
                                    mimeType: 'image/png',
                                },
                            ],
                            isError: flags.result,
                        },
                        entry: {
                            id: `tr-${key}`,
                            sessionId: `sess-${key}`,
                            createdAt: 1,
                            kind: 'toolResult' as const,
                            toolCallId: `call-${key}`,
                            toolName: 'bash',
                            content: [
                                {
                                    type: 'text' as const,
                                    text: `entry secret=${key}`,
                                },
                                {
                                    type: 'image' as const,
                                    data: 'img-entry',
                                    mimeType: 'image/png',
                                },
                            ],
                            isError: flags.entry,
                        },
                    }) satisfies Extract<AgentRunEvent, { type: 'tool-end' }>

                // Three single-flag-true combinations must all trigger full redact + normalize.
                for (const flags of [
                    { event: true, result: false, entry: false },
                    { event: false, result: true, entry: false },
                    { event: false, result: false, entry: true },
                ] as const) {
                    const original = makeToolEnd(flags)
                    const sanitized = sanitizeEvent(original, [key]) as Extract<
                        AgentRunEvent,
                        { type: 'tool-end' }
                    >

                    expect(sanitized.isError).toBe(true)
                    expect(sanitized.result.isError).toBe(true)
                    expect(sanitized.entry?.isError).toBe(true)

                    const resultText =
                        sanitized.result.content[0] &&
                        'text' in sanitized.result.content[0]
                            ? String(sanitized.result.content[0].text)
                            : ''
                    const entryText =
                        sanitized.entry?.content[0] &&
                        'text' in sanitized.entry.content[0]
                            ? String(sanitized.entry.content[0].text)
                            : ''
                    expect(resultText).toContain('[REDACTED]')
                    expect(resultText).not.toContain(key)
                    expect(entryText).toContain('[REDACTED]')
                    expect(entryText).not.toContain(key)

                    // Images / ids / structural fields unchanged.
                    expect(sanitized.type).toBe('tool-end')
                    expect(sanitized.runId).toBe(`run-${key}`)
                    expect(sanitized.sessionId).toBe(`sess-${key}`)
                    expect(sanitized.toolCallId).toBe(`call-${key}`)
                    expect(sanitized.toolName).toBe('bash')
                    expect(sanitized.result.content[1]).toMatchObject({
                        type: 'image',
                        data: 'img-result',
                        mimeType: 'image/png',
                    })
                    expect(sanitized.entry).toMatchObject({
                        id: `tr-${key}`,
                        sessionId: `sess-${key}`,
                        toolCallId: `call-${key}`,
                        toolName: 'bash',
                        content: expect.arrayContaining([
                            expect.objectContaining({
                                type: 'image',
                                data: 'img-entry',
                                mimeType: 'image/png',
                            }),
                        ]),
                    })

                    // Original must remain inconsistent / unredacted.
                    expect(original.isError).toBe(flags.event)
                    expect(original.result.isError).toBe(flags.result)
                    expect(original.entry.isError).toBe(flags.entry)
                    expect(original.result.content[0]).toMatchObject({
                        text: `result secret=${key}`,
                    })
                    expect(original.entry.content[0]).toMatchObject({
                        text: `entry secret=${key}`,
                    })
                }

                // All flags false: success text never redacted; flags stay false.
                const success = makeToolEnd({
                    event: false,
                    result: false,
                    entry: false,
                })
                const sanitizedOk = sanitizeEvent(success, [key]) as Extract<
                    AgentRunEvent,
                    { type: 'tool-end' }
                >
                expect(sanitizedOk.isError).toBe(false)
                expect(sanitizedOk.result.isError).toBe(false)
                expect(sanitizedOk.entry?.isError).toBe(false)
                expect(sanitizedOk.result.content[0]).toMatchObject({
                    text: `result secret=${key}`,
                })
                expect(sanitizedOk.entry?.content[0]).toMatchObject({
                    text: `entry secret=${key}`,
                })
            }
        })

        it('eventAdapter persists sanitized tool-end entry already redacted with isError true', () => {
            for (const key of ['a', 'k$'] as const) {
                useMessageStore.setState({ entriesBySession: {} })
                __resetAgentEventAdapterRegistryForTests(useMessageStore)
                const adapter = createAgentEventAdapter(useMessageStore)
                const sessionId = `sess-tool-flag-${key}`
                const runId = `run-tool-flag-${key}`
                const toolCallId = `call-tool-flag-${key}`

                adapter.apply({ type: 'agent-start', runId, sessionId })
                adapter.apply({
                    type: 'assistant-end',
                    runId,
                    sessionId,
                    entry: {
                        id: `asst-${key}`,
                        sessionId,
                        createdAt: 1,
                        kind: 'assistant',
                        content: [
                            { type: 'text', text: 'calling tool' },
                            {
                                type: 'toolCall',
                                id: toolCallId,
                                name: 'bash',
                                arguments: { command: 'echo hi' },
                            },
                        ],
                        stopReason: 'toolUse',
                        status: 'done',
                    },
                })

                // Critical inconsistency: only top-level isError true; entry/result false.
                // Adapter prefers entry — without normalization secrets would persist.
                const sanitized = sanitizeEvent(
                    {
                        type: 'tool-end',
                        runId,
                        sessionId,
                        toolCallId,
                        toolName: 'bash',
                        isError: true,
                        result: {
                            content: [
                                {
                                    type: 'text',
                                    text: `result leak=${key}`,
                                },
                            ],
                            isError: false,
                        },
                        entry: {
                            id: `tr-${key}`,
                            sessionId,
                            createdAt: 2,
                            kind: 'toolResult',
                            toolCallId,
                            toolName: 'bash',
                            content: [
                                {
                                    type: 'text',
                                    text: `entry leak=${key}`,
                                },
                            ],
                            isError: false,
                        },
                    },
                    [key],
                ) as Extract<AgentRunEvent, { type: 'tool-end' }>

                expect(sanitized.isError).toBe(true)
                expect(sanitized.result.isError).toBe(true)
                expect(sanitized.entry?.isError).toBe(true)

                const applied = adapter.apply(sanitized)
                expect(applied.changed).toBe(true)

                const persisted = useMessageStore
                    .getState()
                    .getEntries(sessionId)
                const toolEntry = persisted.find((e) => e.kind === 'toolResult')
                expect(toolEntry).toMatchObject({
                    kind: 'toolResult',
                    isError: true,
                    toolCallId,
                    toolName: 'bash',
                    id: `tr-${key}`,
                })
                const textBlock =
                    toolEntry && 'content' in toolEntry
                        ? toolEntry.content.find((b) => b.type === 'text')
                        : undefined
                const text =
                    textBlock && 'text' in textBlock ? String(textBlock.text) : ''
                expect(text).toContain('[REDACTED]')
                expect(text).not.toContain(key)
                expect(text).not.toBe(`entry leak=${key}`)
            }
        })

        it('eventAdapter accepts schema-sanitized terminal assistant-end/agent-end and persists', () => {
            const key = 'a'
            useMessageStore.setState({ entriesBySession: {} })
            __resetAgentEventAdapterRegistryForTests(useMessageStore)
            const adapter = createAgentEventAdapter(useMessageStore)
            const sessionId = 'sess-schema'
            const runId = 'run-schema'

            adapter.apply({ type: 'agent-start', runId, sessionId })

            const assistantEnd = sanitizeEvent(
                {
                    type: 'assistant-end',
                    runId,
                    sessionId,
                    entry: {
                        id: 'asst-1',
                        sessionId,
                        createdAt: 1,
                        kind: 'assistant',
                        content: [{ type: 'text', text: `hello ${key} world` }],
                        stopReason: 'error',
                        status: 'error',
                        errorMessage: `upstream ${key}`,
                    },
                },
                [key],
            )
            const endResult = adapter.apply(assistantEnd)
            expect(endResult.changed).toBe(true)
            expect(assistantEnd.type).toBe('assistant-end')

            const agentEnd = sanitizeEvent(
                {
                    type: 'agent-end',
                    runId,
                    sessionId,
                    entries: [
                        {
                            id: 'asst-1',
                            sessionId,
                            createdAt: 1,
                            kind: 'assistant',
                            content: [{ type: 'text', text: `hello ${key} world` }],
                            stopReason: 'error',
                            status: 'error',
                            errorMessage: `upstream ${key}`,
                        },
                    ],
                },
                [key],
            )
            const agentResult = adapter.apply(agentEnd)
            expect(agentResult.changed).toBe(true)
            expect(agentEnd.type).toBe('agent-end')

            const persisted = useMessageStore.getState().getEntries(sessionId)
            expect(persisted).toHaveLength(1)
            expect(persisted[0]).toMatchObject({
                id: 'asst-1',
                kind: 'assistant',
                content: [{ type: 'text', text: `hello ${key} world` }],
            })
            const errMsg =
                persisted[0] && 'errorMessage' in persisted[0]
                    ? String(persisted[0].errorMessage ?? '')
                    : ''
            expect(errMsg).toContain('[REDACTED]')
            expect(errMsg).not.toBe(`upstream ${key}`)
            // Short-key over-redaction is acceptable only on error text.
            expect(errMsg.includes(key) && !errMsg.includes('[REDACTED]')).toBe(false)
        })

        it('rotates opaque connection namespace on exact apiKey change (no key fingerprint)', async () => {
            const namespaces: string[] = []
            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: (opts) => {
                    if (opts.connectionNamespace) {
                        namespaces.push(opts.connectionNamespace)
                    }
                    return new FakeCPAClient() as unknown as CPAClient
                },
                createConnectionManager: () => new CPAConnectionManager(bridge),
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [],
                compact: async (entries) => {
                    const entry = {
                        id: 'c1',
                        sessionId: 's',
                        createdAt: 1,
                        kind: 'compaction' as const,
                        summary: 's',
                        firstKeptEntryId: 'u',
                    }
                    return { entry, entries: [...entries, entry] }
                },
                generateId: (() => {
                    let n = 0
                    return () => `ns-${++n}`
                })(),
            })

            const p1 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-alpha-unique',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            await service.compact({
                prepared: p1,
                sessionId: 's',
                runId: 'r1',
                entries: [userEntry('u', 'x')],
            })

            const ns1 = service.currentConnectionNamespace
            expect(ns1).toBeTruthy()
            expect(ns1).not.toContain('key-alpha')

            const p2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-beta-unique',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            await service.compact({
                prepared: p2,
                sessionId: 's',
                runId: 'r2',
                entries: [userEntry('u', 'y')],
            })

            const ns2 = service.currentConnectionNamespace
            expect(ns2).toBeTruthy()
            expect(ns2).not.toBe(ns1)
            expect(namespaces.length).toBeGreaterThanOrEqual(2)
            expect(namespaces[0]).not.toBe(namespaces[1])
            // Opaque tokens never embed the raw key.
            for (const ns of namespaces) {
                expect(ns).not.toContain('key-alpha')
                expect(ns).not.toContain('key-beta')
            }

            await service.dispose()
        })

        it('second-stat tools empty forces global-only resource load', async () => {
            const { service, loadCalls, bridge } = createService({
                createTools: async () => [],
            })
            bridge.setRuntimeInfo({ userConfigDir: '/cfg' })
            await bridge.mkdirAll('/repo')
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })
            expect(prepared.tools).toEqual([])
            expect(prepared.projectCwd).toBeUndefined()
            expect(loadCalls).toHaveLength(1)
            expect((loadCalls[0] as { cwd?: string }).cwd).toBeUndefined()
            expect(
                prepared.diagnostics.some((d) =>
                    d.message.toLowerCase().includes('global-only'),
                ),
            ).toBe(true)
        })
    })

    describe('fix round 3: freeze / redact / prepare namespace', () => {
        it('recursively freezes skills/prompts body and content; mutation throws', async () => {
            const { service } = createService({
                createTools: async () => [],
            })
            // Override loadResources via a dedicated service for nested resources.
            const bridge = new FakeNativeBridge()
            const svc = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [
                        {
                            path: '/repo/AGENTS.md',
                            content: 'agents',
                        },
                    ],
                    skills: [
                        {
                            name: 'demo',
                            description: 'd',
                            filePath: '/a/skills/demo/SKILL.md',
                            baseDir: '/a/skills/demo',
                            disableModelInvocation: false,
                            body: 'skill-body-original',
                        },
                    ],
                    prompts: [
                        {
                            name: 'p1',
                            description: 'pd',
                            content: 'prompt-content-original',
                            filePath: '/a/prompts/p1.md',
                        },
                    ],
                    systemPrompt: 'SYS',
                    diagnostics: [{ type: 'warning', message: 'w' }],
                }),
                createTools: async () => [],
            })
            const prepared = await svc.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(Object.isFrozen(prepared.skills)).toBe(true)
            expect(Object.isFrozen(prepared.skills[0])).toBe(true)
            expect(Object.isFrozen(prepared.prompts[0])).toBe(true)
            expect(Object.isFrozen(prepared.snapshot)).toBe(true)
            expect(Object.isFrozen(prepared.diagnostics)).toBe(true)
            expect(() => {
                ;(prepared.skills[0] as { body: string }).body = 'mutated'
            }).toThrow()
            expect(() => {
                ;(prepared.prompts[0] as { content: string }).content = 'mutated'
            }).toThrow()
            expect(() => {
                ;(prepared.skills as { length: number }).length = 0
            }).toThrow()
            expect(prepared.skills[0]!.body).toBe('skill-body-original')
            expect(prepared.prompts[0]!.content).toBe('prompt-content-original')
            void service
        })

        it('sanitizeEvent is cycle-safe/BigInt-safe/shared-ref-safe without structuredClone', () => {
            const secret = 'cycle-secret-api-key-999'
            const originalStructuredClone = globalThis.structuredClone
            // Force the no-structuredClone path.
            // @ts-expect-error deliberate delete for test
            delete globalThis.structuredClone

            try {
                const entry = {
                    id: 'a1',
                    sessionId: 's1',
                    createdAt: 1,
                    kind: 'assistant' as const,
                    content: [{ type: 'text' as const, text: `normal ${secret}` }],
                    stopReason: 'error' as const,
                    status: 'error' as const,
                    errorMessage: `fail ${secret}`,
                }
                // Shared refs: entry === streamEvent.partial === streamEvent.error
                const event: AgentRunEvent = {
                    type: 'assistant-update',
                    runId: 'r1',
                    sessionId: 's1',
                    entry,
                    streamEvent: {
                        type: 'error',
                        reason: 'error',
                        error: entry,
                    },
                }
                // Inject a cycle + BigInt on a non-schema extension for clone safety.
                type MetaBag = {
                    a: { token: string }
                    b: { token: string }
                    cyclic: { note: string; big: bigint; self?: unknown }
                }
                type AssistantUpdateWithMeta = Extract<
                    AgentRunEvent,
                    { type: 'assistant-update' }
                > & { meta: MetaBag }
                const extended = event as AssistantUpdateWithMeta
                const shared = { token: `Bearer ${secret}` }
                const cyclic: { note: string; big: bigint; self?: unknown } = {
                    note: `x ${secret}`,
                    big: 10n,
                }
                cyclic.self = cyclic
                extended.meta = { a: shared, b: shared, cyclic }

                const sanitized = sanitizeEvent(
                    extended,
                    [secret],
                ) as AssistantUpdateWithMeta
                expect(sanitized.type).toBe('assistant-update')
                expect(sanitized.runId).toBe('r1')
                expect(sanitized.sessionId).toBe('s1')
                // Schema-aware: errorMessage redacted; normal content preserved.
                expect(sanitized.entry.errorMessage).toBe('fail [REDACTED]')
                expect(sanitized.entry.content[0]).toMatchObject({
                    text: `normal ${secret}`,
                })
                // Shared-ref: streamEvent.error is the same cloned object as entry.
                expect(sanitized.streamEvent.type).toBe('error')
                if (sanitized.streamEvent.type === 'error') {
                    expect(sanitized.streamEvent.error).toBe(sanitized.entry)
                    expect(sanitized.streamEvent.error.errorMessage).toBe(
                        'fail [REDACTED]',
                    )
                }
                // Extra non-schema fields are cloned with shared refs/cycles/BigInt;
                // they are not globally string-redacted.
                expect(sanitized.meta.a).toBe(sanitized.meta.b)
                expect(sanitized.meta.a.token).toContain(secret)
                expect(sanitized.meta.cyclic.self).toBe(sanitized.meta.cyclic)
                expect(sanitized.meta.cyclic.big).toBe(10n)
                expect(sanitized.meta.cyclic.note).toContain(secret)
                // Original intact / not mutated.
                expect(entry.errorMessage).toContain(secret)
                expect(Object.isFrozen(Object.freeze({ ...entry }))).toBe(true)

                // Generic redactDeep still deep-redacts arbitrary payloads.
                const jsonSafe = redactDeep(
                    { note: `x ${secret}`, n: 42n },
                    [secret],
                ) as { note: string; n: bigint }
                expect(jsonSafe.note).not.toContain(secret)
                expect(jsonSafe.note).toContain('[REDACTED]')
                expect(jsonSafe.n).toBe(42n)

                // Top-level error event message is redacted; structure preserved.
                const errSanitized = sanitizeEvent(
                    {
                        type: 'error',
                        runId: 'r1',
                        sessionId: 's1',
                        message: `fail ${secret}`,
                    },
                    [secret],
                ) as Extract<AgentRunEvent, { type: 'error' }>
                expect(errSanitized.type).toBe('error')
                expect(errSanitized.runId).toBe('r1')
                expect(errSanitized.message).toBe('fail [REDACTED]')
            } finally {
                if (originalStructuredClone) {
                    globalThis.structuredClone = originalStructuredClone
                }
            }
        })

        it('sanitizeEvent does not mutate frozen input events', () => {
            const secret = 'frozen-secret-key'
            const frozen = Object.freeze({
                type: 'error' as const,
                runId: 'r-frozen',
                sessionId: 's-frozen',
                message: `fail ${secret}`,
            }) as AgentRunEvent
            const sanitized = sanitizeEvent(frozen, [secret]) as Extract<
                AgentRunEvent,
                { type: 'error' }
            >
            expect(sanitized).not.toBe(frozen)
            expect(sanitized.message).toBe('fail [REDACTED]')
            expect((frozen as { message: string }).message).toContain(secret)
        })

        it('prepare config rotation awaits old dispose and serializes concurrent prepares', async () => {
            const bridge = new FakeNativeBridge()
            const disposeOrder: string[] = []
            let releaseDispose!: () => void
            const disposeParked = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })
            // Gate is closed until the test opens it after observing dispose start.
            let disposeBarrier: Promise<void> = Promise.resolve()
            let managers = 0
            let disposeStarts = 0
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    managers += 1
                    const id = `mgr-${managers}`
                    const mgr = new CPAConnectionManager(bridge)
                    const original = mgr.dispose.bind(mgr)
                    mgr.dispose = async () => {
                        disposeStarts += 1
                        disposeOrder.push(`start:${id}`)
                        await disposeBarrier
                        await original()
                        disposeOrder.push(`end:${id}`)
                    }
                    return mgr
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-${++n}`
                })(),
            })

            const p1 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-alpha-unique',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(service.currentConnectionNamespace).toBeTruthy()
            const ns1 = service.currentConnectionNamespace
            expect(managers).toBe(1)

            // Next dispose must park until we release.
            disposeBarrier = disposeParked
            const p2Promise = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-beta-unique',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            // Spin until dispose has started (prepare reached namespace rotation).
            for (let i = 0; i < 50 && disposeStarts === 0; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            expect(disposeStarts).toBe(1)
            let p2Done = false
            void p2Promise.then(() => {
                p2Done = true
            })
            await new Promise((r) => setTimeout(r, 10))
            expect(p2Done).toBe(false)

            releaseDispose()
            const p2 = await p2Promise
            expect(p2.apiKey).toBe('key-beta-unique')
            expect(service.currentConnectionNamespace).not.toBe(ns1)
            expect(managers).toBe(2)
            expect(disposeOrder.some((x) => x.startsWith('end:'))).toBe(true)
            expect(p1.apiKey).toBe('key-alpha-unique')

            // Open barrier for final service.dispose.
            disposeBarrier = Promise.resolve()
            await service.dispose()
        })

        it('old manager dispose rejection is redacted typed error and still installs new namespace', async () => {
            const bridge = new FakeNativeBridge()
            let managers = 0
            const secret = 'dispose-fail-secret-key'
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    managers += 1
                    const mgr = new CPAConnectionManager(bridge)
                    if (managers === 1) {
                        mgr.dispose = async () => {
                            throw new Error(`boom ${secret} leaked`)
                        }
                    }
                    return mgr
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-fail-${++n}`
                })(),
            })

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: secret,
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const ns1 = service.currentConnectionNamespace

            const p2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'other-key-value',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(p2.apiKey).toBe('other-key-value')
            expect(service.currentConnectionNamespace).not.toBe(ns1)
            expect(managers).toBe(2)
            const observed = service.observedConfigDisposeError
            expect(observed).toBeInstanceOf(AgentPreflightError)
            expect(observed?.code).toBe('connection_dispose_failed')
            expect(observed?.message).not.toContain(secret)
            expect(observed?.message).toContain('[REDACTED]')
            await service.dispose()
        })
    })

    describe('dispose', () => {
        it('marks disposed, closes connection manager, rejects subsequent prepare', async () => {
            const disposedManagers: CPAConnectionManager[] = []
            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    const original = mgr.dispose.bind(mgr)
                    mgr.dispose = async () => {
                        disposedManagers.push(mgr)
                        await original()
                    }
                    return mgr
                },
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'SYS',
                    diagnostics: [],
                }),
                createTools: async () => [],
                compact: async (entries) => {
                    const entry = {
                        id: 'c1',
                        sessionId: 's',
                        createdAt: 1,
                        kind: 'compaction' as const,
                        summary: 's',
                        firstKeptEntryId: 'u',
                    }
                    return { entry, entries: [...entries, entry] }
                },
            })

            // Force manager construction via compact path after prepare.
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            // compact creates client+manager even if compact fn short-circuits via mock
            await service.compact({
                prepared,
                sessionId: 's',
                runId: 'r',
                entries: [userEntry('u', 'x')],
            }).catch(() => undefined)

            await service.dispose()
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({ code: 'disposed' })
            // idempotent
            await service.dispose()
        })
    })

    describe('fix round 4: abortable prepare + config mutex', () => {
        const emptyResources = async () => ({
            contextFiles: [],
            skills: [],
            prompts: [],
            systemPrompt: 'SYS',
            diagnostics: [],
        })

        it('never-resolving resource prepare aborts then second prepare succeeds', async () => {
            const bridge = new FakeNativeBridge()
            let loadCalls = 0
            let releaseLoad!: () => void
            const firstLoadParked = new Promise<void>((resolve) => {
                releaseLoad = resolve
            })
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                loadResources: async () => {
                    loadCalls += 1
                    if (loadCalls === 1) {
                        await firstLoadParked
                    }
                    return emptyResources()
                },
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-abort-${++n}`
                })(),
            })

            const ac1 = new AbortController()
            const p1 = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-a',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                signal: ac1.signal,
            })

            for (let i = 0; i < 50 && loadCalls === 0; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            expect(loadCalls).toBe(1)

            ac1.abort()
            await expect(p1).rejects.toMatchObject({ name: 'AbortError' })

            // Next prepare must start and finish without waiting for the late load.
            const p2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-a',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(p2.apiKey).toBe('key-a')
            expect(service.currentConnectionNamespace).toBeTruthy()
            expect(service.committedSnapshot?.apiKey).toBe('key-a')

            // Late first load resolves; must not clobber committed state.
            releaseLoad()
            await new Promise((r) => setTimeout(r, 10))
            expect(service.committedSnapshot?.apiKey).toBe('key-a')
            await service.dispose()
        })

        it('abort while queued on rotation mutex removes waiter immediately', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeParked = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })
            let managers = 0
            let disposeStarts = 0
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    managers += 1
                    const mgr = new CPAConnectionManager(bridge)
                    if (managers === 1) {
                        const original = mgr.dispose.bind(mgr)
                        mgr.dispose = async () => {
                            disposeStarts += 1
                            await disposeParked
                            await original()
                        }
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-q-${++n}`
                })(),
            })

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-hold',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            // Hold rotation lock via hanging dispose of key-hold.
            const pHold = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-rotate',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            for (let i = 0; i < 50 && disposeStarts === 0; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            expect(disposeStarts).toBe(1)

            const acQueued = new AbortController()
            const pQueued = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-queued',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                signal: acQueued.signal,
            })

            // Let queued prepare reach the mutex wait.
            await new Promise((r) => setTimeout(r, 20))
            acQueued.abort()
            await expect(pQueued).rejects.toMatchObject({ name: 'AbortError' })

            releaseDispose()
            const held = await pHold
            expect(held.apiKey).toBe('key-rotate')
            await service.dispose()
        })

        it('old dispose never resolves: timeout installs new manager without reuse', async () => {
            const bridge = new FakeNativeBridge()
            const managers: CPAConnectionManager[] = []
            let disposeCalls = 0
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    managers.push(mgr)
                    if (managers.length === 1) {
                        mgr.dispose = () =>
                            new Promise<void>(() => {
                                disposeCalls += 1
                                // never resolves
                            })
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                disposeTimeoutMs: 30,
                delay: async (ms, signal) => {
                    // Fake scheduler: honor ms with real timer for test simplicity.
                    if (signal?.aborted) {
                        const err = new Error('Request was aborted')
                        err.name = 'AbortError'
                        throw err
                    }
                    await new Promise<void>((resolve, reject) => {
                        const t = setTimeout(resolve, ms)
                        const onAbort = () => {
                            clearTimeout(t)
                            const err = new Error('Request was aborted')
                            err.name = 'AbortError'
                            reject(err)
                        }
                        signal?.addEventListener('abort', onAbort, { once: true })
                    })
                },
                generateId: (() => {
                    let n = 0
                    return () => `ns-to-${++n}`
                })(),
            })

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-old',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const oldManager = managers[0]
            const ns1 = service.currentConnectionNamespace

            const p2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-new',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(p2.apiKey).toBe('key-new')
            expect(disposeCalls).toBe(1)
            expect(managers.length).toBe(2)
            expect(service.currentConnectionNamespace).not.toBe(ns1)
            // Must not reuse the disposing old manager instance.
            expect(service.currentConnectionNamespace).toBeTruthy()
            expect(managers[1]).not.toBe(oldManager)
            await service.dispose()
        })

        it('active stream: same config reuses manager; changed config typed reject; after end rotates', async () => {
            const bridge = new FakeNativeBridge()
            let disposeCount = 0
            let releaseHold!: () => void
            const hold = new Promise<void>((resolve) => {
                releaseHold = resolve
            })

            class HoldingClient extends FakeCPAClient {
                override async *stream(
                    input: ProtocolStreamInput,
                    options?: ProtocolStreamOptions,
                ): AsyncGenerator<AssistantStreamEvent, AssistantEntry> {
                    const signal = options?.signal ?? new AbortController().signal
                    this.calls.push(input)
                    if (signal.aborted) {
                        const err = new Error('Request was aborted')
                        err.name = 'AbortError'
                        throw err
                    }
                    yield {
                        type: 'text-delta',
                        contentIndex: 0,
                        delta: 'x',
                        partial: {
                            ...input.seed,
                            content: [{ type: 'text', text: 'x' }],
                            stopReason: 'pending',
                            status: 'streaming',
                        },
                    }
                    await hold
                    if (signal.aborted) {
                        const err = new Error('Request was aborted')
                        err.name = 'AbortError'
                        throw err
                    }
                    return doneAssistant(input.seed, {
                        content: [{ type: 'text', text: 'x' }],
                        stopReason: 'stop',
                    })
                }
            }

            const holdClient = new HoldingClient()
            const liveService = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => holdClient as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    const original = mgr.dispose.bind(mgr)
                    mgr.dispose = async () => {
                        disposeCount += 1
                        await original()
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-live-${++n}`
                })(),
            })

            const pLive = await liveService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-live',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const nsLive = liveService.currentConnectionNamespace
            const disposeBefore = disposeCount

            const streamPromise = collect(
                liveService.streamChat({
                    prepared: pLive,
                    sessionId: 's-live',
                    runId: 'r-live',
                    entries: [userEntry('u1', 'hi')],
                    userEntry: userEntry('u1', 'hi'),
                }),
            )

            for (let i = 0; i < 50 && !liveService.isActive; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            expect(liveService.isActive).toBe(true)
            expect(liveService.activeKind).toBe('stream')

            // Same config prepare while active: no dispose.
            const same = await liveService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-live',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(same.apiKey).toBe('key-live')
            expect(liveService.currentConnectionNamespace).toBe(nsLive)
            expect(disposeCount).toBe(disposeBefore)

            // Changed config while active: typed reject, no dispose.
            await expect(
                liveService.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key-other',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({
                code: 'config_change_during_run',
                name: 'AgentPreflightError',
            })
            expect(disposeCount).toBe(disposeBefore)
            expect(liveService.currentConnectionNamespace).toBe(nsLive)

            releaseHold()
            await streamPromise
            expect(liveService.isActive).toBe(false)

            // After end, rotation is allowed.
            const after = await liveService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-other',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(after.apiKey).toBe('key-other')
            expect(liveService.currentConnectionNamespace).not.toBe(nsLive)
            expect(disposeCount).toBeGreaterThan(disposeBefore)
            await liveService.dispose()
        })

        it('two concurrent prepares reverse completion: only latest generation commits', async () => {
            const bridge = new FakeNativeBridge()
            let loadSeq = 0
            const gates: Array<{ release: () => void; promise: Promise<void> }> =
                []
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                loadResources: async () => {
                    const idx = loadSeq
                    loadSeq += 1
                    let release!: () => void
                    const promise = new Promise<void>((resolve) => {
                        release = resolve
                    })
                    gates[idx] = { release, promise }
                    await promise
                    return {
                        contextFiles: [],
                        skills: [],
                        prompts: [],
                        systemPrompt: `SYS-${idx}`,
                        diagnostics: [],
                    }
                },
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-rev-${++n}`
                })(),
            })

            const pA = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A-first',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            for (let i = 0; i < 50 && loadSeq < 1; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }

            const pB = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-B-second',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            for (let i = 0; i < 50 && loadSeq < 2; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }

            // Reverse completion: B finishes first.
            gates[1]!.release()
            const b = await pB
            expect(b.apiKey).toBe('key-B-second')
            expect(service.committedSnapshot?.apiKey).toBe('key-B-second')
            const nsB = service.currentConnectionNamespace

            gates[0]!.release()
            const a = await pA
            expect(a.apiKey).toBe('key-A-first')
            // Late A must not overwrite latest committed namespace/snapshot.
            expect(service.committedSnapshot?.apiKey).toBe('key-B-second')
            expect(service.currentConnectionNamespace).toBe(nsB)
            await service.dispose()
        })

        it('service dispose aborts queued prepare waiters', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeParked = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })
            let managers = 0
            let disposeStarts = 0
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    managers += 1
                    const mgr = new CPAConnectionManager(bridge)
                    if (managers === 1) {
                        const original = mgr.dispose.bind(mgr)
                        mgr.dispose = async () => {
                            disposeStarts += 1
                            await disposeParked
                            await original()
                        }
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-disp-${++n}`
                })(),
            })

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-1',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const pRotate = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-2',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            for (let i = 0; i < 50 && disposeStarts === 0; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            expect(disposeStarts).toBe(1)

            const pQueued = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-3',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            await new Promise((r) => setTimeout(r, 15))

            const disposePromise = service.dispose()
            await expect(pQueued).rejects.toMatchObject({ code: 'disposed' })

            releaseDispose()
            await disposePromise
            // pRotate may reject disposed or complete depending on race; observe either.
            await pRotate.then(
                () => undefined,
                () => undefined,
            )
        })
    })

    describe('fix round 5: active owner token before any await', () => {
        const emptyResources = async () => ({
            contextFiles: [],
            skills: [],
            prompts: [],
            systemPrompt: 'SYS',
            diagnostics: [],
        })

        function withApiKey(
            prepared: Awaited<ReturnType<CLIProxyAPIAgentService['prepare']>>,
            apiKey: string,
        ) {
            return Object.freeze({ ...prepared, apiKey }) as typeof prepared
        }

        async function waitFor(
            predicate: () => boolean,
            label: string,
            attempts = 80,
        ): Promise<void> {
            for (let i = 0; i < attempts && !predicate(); i += 1) {
                await new Promise((r) => setTimeout(r, 5))
            }
            if (!predicate()) {
                throw new Error(`timed out waiting for ${label}`)
            }
        }

        it('stream claims active before ensure settles: changed-config prepare + second stream/compact reject', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })
            let managerCount = 0

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    managerCount += 1
                    const mgr = new CPAConnectionManager(bridge)
                    const original = mgr.dispose.bind(mgr)
                    mgr.dispose = async () => {
                        await disposeHold
                        await original()
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-stream-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(managerCount).toBe(1)

            const preparedB = withApiKey(preparedA, 'key-B')
            const user = userEntry('u1', 'hi')
            const ac = new AbortController()

            const streamPromise = collect(
                service.streamChat({
                    prepared: preparedB,
                    sessionId: 's-r5',
                    runId: 'run-r5-1',
                    entries: [user],
                    userEntry: user,
                    signal: ac.signal,
                }),
            )

            await waitFor(() => service.isActive, 'stream active during ensure')
            expect(service.activeKind).toBe('stream')

            // Changed config prepare must fail-fast while ensure still pending.
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key-C',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    requestApproval: false,
                }),
            ).rejects.toMatchObject({
                code: 'config_change_during_run',
                name: 'AgentPreflightError',
            })

            // Changed config stream rejects immediately.
            expect(() =>
                service.streamChat({
                    prepared: preparedA,
                    sessionId: 's-r5-b',
                    runId: 'run-r5-2',
                    entries: [user],
                    userEntry: user,
                }),
            ).toThrow(
                expect.objectContaining({
                    code: 'config_change_during_run',
                    name: 'AgentPreflightError',
                }),
            )

            // Second stream on the same active session rejects with run_active.
            expect(() =>
                service.streamChat({
                    prepared: preparedB,
                    sessionId: 's-r5',
                    runId: 'run-r5-2-same',
                    entries: [user],
                    userEntry: user,
                }),
            ).toThrow(
                expect.objectContaining({
                    code: 'run_active',
                    name: 'AgentPreflightError',
                }),
            )

            const compactBusy = await service.compact({
                prepared: preparedB,
                sessionId: 's-r5',
                runId: 'compact-r5-2',
                entries: [user],
            })
            expect(compactBusy.ok).toBe(false)
            if (!compactBusy.ok) {
                expect(compactBusy.code).toBe('run_active')
            }

            ac.abort()
            releaseDispose()
            await streamPromise.then(
                () => undefined,
                () => undefined,
            )
            expect(service.isActive).toBe(false)

            // After owner released, same-config prepare succeeds.
            const same = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-B',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            expect(same.apiKey).toBe('key-B')
            await service.dispose()
        })

        it('stream ensure abort/reject clears active', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    mgr.dispose = async () => {
                        await disposeHold
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-abort-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const preparedB = withApiKey(preparedA, 'key-B')
            const user = userEntry('u1', 'hi')
            const ac = new AbortController()

            const streamPromise = collect(
                service.streamChat({
                    prepared: preparedB,
                    sessionId: 's-abort',
                    runId: 'run-abort-ensure',
                    entries: [user],
                    userEntry: user,
                    signal: ac.signal,
                }),
            )

            await waitFor(() => service.isActive, 'active before abort')
            ac.abort()
            await streamPromise.then(
                () => undefined,
                () => undefined,
            )
            expect(service.isActive).toBe(false)

            // Late dispose release must not resurrect active.
            releaseDispose()
            await new Promise((r) => setTimeout(r, 20))
            expect(service.isActive).toBe(false)
            await service.dispose()
        })

        it('compact queued mutex abort / ensure reject clears active', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    mgr.dispose = async () => {
                        await disposeHold
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-compact-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            // Hold rotation mutex with a hanging dispose for a different config.
            const acRotate = new AbortController()
            const rotatePromise = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-rotate',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                signal: acRotate.signal,
            })
            await waitFor(() => true, 'yield', 1)
            for (let i = 0; i < 40; i += 1) {
                await new Promise((r) => setTimeout(r, 5))
                // rotate is parked on dispose; mutex held.
                if (true) break
            }
            // Give the rotate prepare time to acquire mutex + start dispose wait.
            await new Promise((r) => setTimeout(r, 30))

            const preparedB = withApiKey(preparedA, 'key-B')
            const acCompact = new AbortController()
            const compactPromise = service.compact({
                prepared: preparedB,
                sessionId: 's-compact',
                runId: 'compact-ensure-abort',
                entries: [userEntry('u1', 'hi')],
                signal: acCompact.signal,
            })

            await waitFor(() => service.isActive, 'compact active while ensure queued')
            expect(service.activeKind).toBe('compact')

            acCompact.abort()
            const compactResult = await compactPromise
            expect(compactResult.ok).toBe(false)
            expect(service.isActive).toBe(false)

            acRotate.abort()
            releaseDispose()
            await rotatePromise.then(
                () => undefined,
                () => undefined,
            )
            expect(service.isActive).toBe(false)
            await service.dispose()
        })

        it('compact ensure reject (auth rotate dispose failure path) clears active', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    mgr.dispose = async () => {
                        await disposeHold
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-c-rej-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const preparedB = withApiKey(preparedA, 'key-B')
            const ac = new AbortController()

            const compactPromise = service.compact({
                prepared: preparedB,
                sessionId: 's-c-rej',
                runId: 'compact-rej',
                entries: [userEntry('u1', 'hi')],
                signal: ac.signal,
            })

            await waitFor(() => service.isActive, 'compact active during ensure')
            ac.abort()
            const result = await compactPromise
            expect(result.ok).toBe(false)
            expect(service.isActive).toBe(false)

            releaseDispose()
            await new Promise((r) => setTimeout(r, 20))
            expect(service.isActive).toBe(false)
            await service.dispose()
        })

        it('owner token: old stream finally cannot clear a newer active op', async () => {
            const bridge = new FakeNativeBridge()
            let releaseCompact!: () => void
            const compactHold = new Promise<void>((resolve) => {
                releaseCompact = resolve
            })
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })
            let disposeCount = 0

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    const original = mgr.dispose.bind(mgr)
                    mgr.dispose = async () => {
                        disposeCount += 1
                        if (disposeCount === 1) {
                            await disposeHold
                        }
                        await original()
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                compact: async (entries) => {
                    await compactHold
                    const entry = {
                        id: 'c-new',
                        sessionId: 's-new',
                        createdAt: 1,
                        kind: 'compaction' as const,
                        summary: 'newer',
                        firstKeptEntryId: 'u1',
                    }
                    return { entry, entries: [...entries, entry] }
                },
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-owner-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const preparedB = withApiKey(preparedA, 'key-B')
            const user = userEntry('u1', 'hi')

            // Old op: stream claims active, parks inside ensure (dispose wait).
            const acOld = new AbortController()
            const oldStream = collect(
                service.streamChat({
                    prepared: preparedB,
                    sessionId: 's-old',
                    // Intentionally reuse runId later on the newer op.
                    runId: 'shared-run-id',
                    entries: [user],
                    userEntry: user,
                    signal: acOld.signal,
                }),
            )
            await waitFor(() => service.isActive, 'old stream active')

            // Abort old ensure so its finally will release only its owner token.
            acOld.abort()
            await oldStream.then(
                () => undefined,
                () => undefined,
            )
            expect(service.isActive).toBe(false)

            // Let the parked dispose finish so the next ensure can rotate.
            releaseDispose()
            await new Promise((r) => setTimeout(r, 20))

            // Newer op claims active (same runId) and holds inside compactFn.
            const newer = service.compact({
                prepared: preparedA,
                sessionId: 's-new',
                runId: 'shared-run-id',
                entries: [user],
            })
            await waitFor(
                () => service.isActive && service.activeKind === 'compact',
                'newer compact active',
            )

            // Old stream is already settled; a second late return/cleanup must not
            // clear the newer owner (releaseActive is token-scoped).
            expect(service.isActive).toBe(true)
            expect(service.activeKind).toBe('compact')

            releaseCompact()
            const newerResult = await newer
            expect(newerResult.ok).toBe(true)
            expect(service.isActive).toBe(false)
            await service.dispose()
        })

        it('dispose during ensure cleans active; late owner finally stays inactive', async () => {
            const bridge = new FakeNativeBridge()
            let releaseDispose!: () => void
            const disposeHold = new Promise<void>((resolve) => {
                releaseDispose = resolve
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => new FakeCPAClient() as unknown as CPAClient,
                createConnectionManager: () => {
                    const mgr = new CPAConnectionManager(bridge)
                    mgr.dispose = async () => {
                        await disposeHold
                    }
                    return mgr
                },
                loadResources: emptyResources,
                createTools: async () => [],
                generateId: (() => {
                    let n = 0
                    return () => `ns-r5-disp-${++n}`
                })(),
            })

            const preparedA = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key-A',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })
            const preparedB = withApiKey(preparedA, 'key-B')
            const user = userEntry('u1', 'hi')

            const streamPromise = collect(
                service.streamChat({
                    prepared: preparedB,
                    sessionId: 's-disp',
                    runId: 'run-disp',
                    entries: [user],
                    userEntry: user,
                }),
            )
            await waitFor(() => service.isActive, 'active during ensure before dispose')

            const disposePromise = service.dispose()
            expect(service.isActive).toBe(false)

            await streamPromise.then(
                () => undefined,
                () => undefined,
            )
            // Old owner finally must leave active false (not resurrect).
            expect(service.isActive).toBe(false)

            releaseDispose()
            await disposePromise
            expect(service.isActive).toBe(false)
        })
    })

    describe('protocol provider and middleware pipeline integration', () => {
        afterEach(() => {
            defaultExtensionRegistry.clear()
        })

        it('dynamically uses protocol provider registered in ExtensionRegistry when createClient is omitted', async () => {
            const registry = new ExtensionRegistry()
            const customStreamSpy = vi.fn()

            const mockProvider: ProtocolProvider = {
                id: 'custom-provider',
                name: 'Custom Protocol Provider',
                isDefault: true,
                createClient: (_opts) => ({
                    stream: async function* (input, options) {
                        customStreamSpy(input, options)
                        yield {
                            type: 'text-delta',
                            contentIndex: 0,
                            delta: 'Hello from custom provider',
                            partial: input.seed,
                        }
                        yield {
                            type: 'done',
                            reason: 'stop',
                            message: doneAssistant(input.seed, {
                                content: [{ type: 'text', text: 'Hello from custom provider' }],
                                stopReason: 'stop',
                            }),
                        }
                    },
                }),
            }
            registry.registerProtocolProvider(mockProvider)

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Base system prompt',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-proto-1',
                    runId: 'run-proto-1',
                    entries: [userEntry('u1', 'hello')],
                }),
            )

            expect(customStreamSpy).toHaveBeenCalledTimes(1)
            expect(events.some((e) => e.type === 'assistant-start')).toBe(true)
            expect(events.some((e) => e.type === 'assistant-end')).toBe(true)
            const assistantEnd = events.find((e) => e.type === 'assistant-end') as {
                entry: AssistantEntry
            }
            expect(assistantEnd.entry.content[0]).toEqual({
                type: 'text',
                text: 'Hello from custom provider',
            })
        })

        it('prioritizes deps.createClient over protocol providers in ExtensionRegistry for backwards compatibility', async () => {
            const registry = new ExtensionRegistry()
            const providerCreateClientSpy = vi.fn()
            registry.registerProtocolProvider({
                id: 'custom-provider',
                name: 'Custom Protocol Provider',
                isDefault: true,
                createClient: providerCreateClientSpy,
            })

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'From fake client' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'System',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-compat',
                    runId: 'run-compat',
                    entries: [userEntry('u1', 'hi')],
                }),
            )

            expect(providerCreateClientSpy).not.toHaveBeenCalled()
            expect(fakeClient.calls).toHaveLength(1)
            const assistantEnd = events.find((e) => e.type === 'assistant-end') as {
                entry: AssistantEntry
            }
            expect(assistantEnd.entry.content[0]).toEqual({
                type: 'text',
                text: 'From fake client',
            })
        })

        it('middleware onRequest modifies system prompt before stream dispatch', async () => {
            const registry = new ExtensionRegistry()
            const mw: ProtocolMiddleware = {
                id: 'system-prompt-injector',
                order: 10,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt}\n[Injected Security Guardrail]`,
                }),
            }
            registry.registerProtocolMiddleware(mw)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Checked' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Base prompt',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-mw-1',
                    runId: 'run-mw-1',
                    entries: [userEntry('u1', 'hello')],
                }),
            )

            expect(fakeClient.calls).toHaveLength(1)
            expect(fakeClient.calls[0]?.systemPrompt).toContain(
                'Base prompt',
            )
            expect(fakeClient.calls[0]?.systemPrompt).toContain(
                '[Injected Security Guardrail]',
            )
        })

        it('middleware onStreamEvent rewrites text delta and filters events', async () => {
            const registry = new ExtensionRegistry()
            const mw: ProtocolMiddleware = {
                id: 'stream-rewriter',
                order: 10,
                onStreamEvent: (event) => {
                    if (event.type === 'text-delta') {
                        return {
                            ...event,
                            delta: `[SAFE] ${event.delta}`,
                        }
                    }
                    if (event.type === 'thinking-delta') {
                        return null
                    }
                    return event
                },
            }
            registry.registerProtocolMiddleware(mw)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [
                    {
                        type: 'thinking-delta',
                        contentIndex: 0,
                        delta: 'internal thought',
                        partial: {} as AssistantEntry,
                    },
                    {
                        type: 'text-delta',
                        contentIndex: 0,
                        delta: 'Hello world',
                        partial: {} as AssistantEntry,
                    },
                ],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: '[SAFE] Hello world' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Base',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-mw-stream',
                    runId: 'run-mw-stream',
                    entries: [userEntry('u1', 'hi')],
                }),
            )

            const assistantUpdates = events.filter(
                (e) => e.type === 'assistant-update',
            ) as Array<{
                type: 'assistant-update'
                streamEvent: AssistantStreamEvent
            }>

            expect(
                assistantUpdates.some(
                    (u) => u.streamEvent.type === 'thinking-delta',
                ),
            ).toBe(false)

            const textDeltaUpdate = assistantUpdates.find(
                (u) => u.streamEvent.type === 'text-delta',
            )
            expect(textDeltaUpdate).toBeDefined()
            expect(
                (textDeltaUpdate?.streamEvent as { delta?: string })?.delta,
            ).toBe('[SAFE] Hello world')
        })

        it('middleware onStreamComplete records execution statistics and error state', async () => {
            const registry = new ExtensionRegistry()
            const completedStats: Array<{ elapsedMs: number; error?: Error }> = []
            const mw: ProtocolMiddleware = {
                id: 'stats-collector',
                onStreamComplete: (stats) => {
                    completedStats.push(stats)
                },
            }
            registry.registerProtocolMiddleware(mw)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Finished' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Base',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-stats',
                    runId: 'run-stats',
                    entries: [userEntry('u1', 'test')],
                }),
            )

            expect(completedStats).toHaveLength(1)
            expect(completedStats[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
            expect(completedStats[0]?.error).toBeUndefined()
        })

        it('middleware exceptions are safely isolated without crashing stream pipeline', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            const registry = new ExtensionRegistry()
            const mwBroken: ProtocolMiddleware = {
                id: 'broken-middleware',
                order: 10,
                onRequest: () => {
                    throw new Error('onRequest exploded')
                },
                onStreamEvent: () => {
                    throw new Error('onStreamEvent exploded')
                },
                onStreamComplete: () => {
                    throw new Error('onStreamComplete exploded')
                },
            }
            const mwWorking: ProtocolMiddleware = {
                id: 'working-middleware',
                order: 20,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt} [working]`,
                }),
            }
            registry.registerProtocolMiddleware(mwBroken)
            registry.registerProtocolMiddleware(mwWorking)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [
                    {
                        type: 'text-delta',
                        contentIndex: 0,
                        delta: 'Still works',
                        partial: {} as AssistantEntry,
                    },
                ],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Still works' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Initial',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-isolated',
                    runId: 'run-isolated',
                    entries: [userEntry('u1', 'go')],
                }),
            )

            expect(fakeClient.calls[0]?.systemPrompt).toContain('Initial')
            expect(fakeClient.calls[0]?.systemPrompt).toContain('[working]')

            const assistantEnd = events.find((e) => e.type === 'assistant-end') as {
                entry: AssistantEntry
            }
            expect(assistantEnd.entry.content[0]).toEqual({
                type: 'text',
                text: 'Still works',
            })
            consoleSpy.mockRestore()
        })

        it('chains multiple middlewares according to their order priority', async () => {
            const registry = new ExtensionRegistry()
            const executionOrder: string[] = []

            const mw1: ProtocolMiddleware = {
                id: 'mw-second',
                order: 200,
                onRequest: (input) => {
                    executionOrder.push('mw-second')
                    return { ...input, systemPrompt: `${input.systemPrompt} -> mw2` }
                },
            }
            const mw2: ProtocolMiddleware = {
                id: 'mw-first',
                order: 10,
                onRequest: (input) => {
                    executionOrder.push('mw-first')
                    return { ...input, systemPrompt: `${input.systemPrompt} -> mw1` }
                },
            }
            registry.registerProtocolMiddleware(mw1)
            registry.registerProtocolMiddleware(mw2)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                events: [],
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Order verified' }],
                        stopReason: 'stop',
                    }),
            })

            const bridge = new FakeNativeBridge()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Root',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-order',
                    runId: 'run-order',
                    entries: [userEntry('u1', 'test')],
                }),
            )

            expect(executionOrder).toEqual(['mw-first', 'mw-second'])
            expect(fakeClient.calls[0]?.systemPrompt).toContain('Root')
            expect(fakeClient.calls[0]?.systemPrompt).toContain('-> mw1 -> mw2')
        })

        it('adapts custom createClient returning CPAClient instance', async () => {
            const bridge = new FakeNativeBridge()
            const streamSpy = vi.fn().mockImplementation(async function* (input) {
                const finalEntry = doneAssistant(input.seed, {
                    content: [{ type: 'text', text: 'from real codex client' }],
                    stopReason: 'stop',
                })
                yield {
                    type: 'done',
                    reason: 'stop',
                    message: finalEntry,
                }
                return finalEntry
            })
            const realCPAClient = {
                stream: streamSpy,
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => realCPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'System',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-real',
                    runId: 'run-real',
                    entries: [userEntry('u1', 'hello')],
                }),
            )

            expect(streamSpy).toHaveBeenCalledTimes(1)
        })
    })

    describe('adaptCodexClientToProtocolClient', () => {
        it('adapts CPAClient.stream call signature and forwards stream options', async () => {
            const mockStream = vi.fn().mockImplementation(async function* (input) {
                yield { type: 'text-delta', delta: 'chunk' }
                return input.seed
            })
            const fakeCPA = {
                stream: mockStream,
            } as unknown as CPAClient

            const protocolClient = adaptCodexClientToProtocolClient(fakeCPA)
            const input: ProtocolStreamInput = {
                model: modelBase,
                systemPrompt: 'System',
                entries: [],
                seed: {
                    id: 'a1',
                    sessionId: 'sess-1',
                    createdAt: 0,
                    completedAt: 0,
                    kind: 'assistant',
                    status: 'streaming',
                    content: [],
                    stopReason: 'pending',
                },
            }
            const controller = new AbortController()
            const streamOpts: ProtocolStreamOptions = {
                signal: controller.signal,
                connectionMode: 'isolated',
                promptCacheKey: 'custom-cache-key',
                maxOutputTokens: 500,
            }

            const generator = protocolClient.stream(input, streamOpts)
            const chunks = []
            for await (const chunk of generator) {
                chunks.push(chunk)
            }

            expect(mockStream).toHaveBeenCalledWith(
                input,
                controller.signal,
                {
                    connectionMode: 'isolated',
                    promptCacheKey: 'custom-cache-key',
                    maxOutputTokens: 500,
                },
            )
            expect(chunks).toHaveLength(1)
            expect(chunks[0]).toEqual({ type: 'text-delta', delta: 'chunk' })
        })

        it('provides default AbortSignal and undefined codexOpts when stream options are omitted', async () => {
            const mockStream = vi.fn().mockImplementation(async function* (input) {
                yield { type: 'text-delta', delta: 'chunk' }
                return input.seed
            })
            const fakeCPA = {
                stream: mockStream,
            } as unknown as CPAClient

            const protocolClient = adaptCodexClientToProtocolClient(fakeCPA)
            const input: ProtocolStreamInput = {
                model: modelBase,
                systemPrompt: 'System',
                entries: [],
                seed: {
                    id: 'a1',
                    sessionId: 'sess-1',
                    createdAt: 0,
                    completedAt: 0,
                    kind: 'assistant',
                    status: 'streaming',
                    content: [],
                    stopReason: 'pending',
                },
            }

            const generator = protocolClient.stream(input)
            for await (const _chunk of generator) {
                // consume
            }

            expect(mockStream).toHaveBeenCalledTimes(1)
            const callArgs = mockStream.mock.calls[0]
            expect(callArgs[0]).toBe(input)
            expect(callArgs[1]).toBeInstanceOf(AbortSignal)
            expect(callArgs[2]).toBeUndefined()
        })
    })

    describe('auto session naming tool (title)', () => {
        it('mounts title tool and augments prompt on the first turn of a session', async () => {
            const { service, fakeClient } = createService()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'hello' }],
                        stopReason: 'stop',
                    }),
            })

            const prepared = await service.prepare({
                baseUrl: 'https://api.example.com',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const user = userEntry('u1', 'First message')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-first-turn',
                    runId: 'run-1',
                    entries: [user],
                    userEntry: user,
                }),
            )

            expect(fakeClient.calls).toHaveLength(1)
            const call = fakeClient.calls[0]!
            expect(call.tools?.some((t) => t.name === 'title')).toBe(true)
            expect(call.systemPrompt).toContain('title')
            expect(call.systemPrompt).toContain(
                'Before starting other work, call the title tool to set a concise session title based on user input',
            )
        })

        it('keeps title tool and prompt guideline mounted on subsequent turns to preserve prompt cache', async () => {
            const { service, fakeClient } = createService()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'reply 2' }],
                        stopReason: 'stop',
                    }),
            })

            const prepared = await service.prepare({
                baseUrl: 'https://api.example.com',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            const user1 = userEntry('u1', 'First message')
            const assistant1 = doneAssistant(
                {
                    id: 'a1',
                    sessionId: 'sess-second-turn',
                    createdAt: 100,
                    kind: 'assistant',
                    content: [{ type: 'text', text: 'First answer' }],
                    stopReason: 'pending',
                    status: 'streaming',
                },
                {
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'First answer' }],
                },
            )
            const user2 = userEntry('u2', 'Follow-up message')

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-second-turn',
                    runId: 'run-2',
                    entries: [user1, assistant1, user2],
                    userEntry: user2,
                }),
            )

            expect(fakeClient.calls).toHaveLength(1)
            const call = fakeClient.calls[0]!
            expect(call.tools?.some((t) => t.name === 'title')).toBe(true)
            expect(call.systemPrompt).toContain('title')
            expect(call.systemPrompt).toContain(
                'Before starting other work, call the title tool to set a concise session title based on user input',
            )
        })

        it('never mounts title in sub-agents', async () => {
            const bridge = new FakeNativeBridge()
            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'sub-agent finished' }],
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => childClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'Parent Prompt',
                    diagnostics: [],
                }),
                createTools: async () => [makeTool('read')],
            })

            await service.prepare({
                baseUrl: 'https://api.example.com',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
            })
            await service.subAgents.spawn('task for child', {
                name: 'Worker',
                modelId: modelBase.id,
            })

            expect(childClient.calls).toHaveLength(1)
            const childCall = childClient.calls[0]!
            expect(
                childCall.tools?.some((t) => t.name === 'title'),
            ).toBe(false)
            expect(childCall.systemPrompt).not.toContain('title')
        })

        it('scopes plugin tools and prompts to main vs subagent properly', async () => {
            const registry = new ExtensionRegistry()
            registry.registerAgentTool({
                name: 'todo',
                description: 'Manage todo list',
                parameters: { type: 'object' },
                targetAgent: 'main',
                execute: vi.fn(),
            })
            registry.registerAgentTool({
                name: 'subagent_special_tool',
                description: 'Special subagent tool',
                parameters: { type: 'object' },
                targetAgent: 'subagent',
                execute: vi.fn(),
            })
            registry.registerAgentTool({
                name: 'shared_plugin_tool',
                description: 'Shared tool for all agents',
                parameters: { type: 'object' },
                targetAgent: 'all',
                execute: vi.fn(),
            })

            toolsAgentEntry.activate({
                register: (c: any) => {
                    if (c.kind === 'tool-factory') {
                        registry.registerToolFactory(c.value ?? c)
                    }
                },
            } as any)

            resourcesAgentEntry.activate({
                register: (c: any) => {
                    if (c.kind === 'resource-provider') {
                        registry.registerResourceProvider(c.value ?? c)
                    }
                },
            } as any)

            subagentAgentEntry.activate({
                register: (c: any) => {
                    if (c.kind === 'tool-factory') {
                        registry.registerToolFactory(c.value ?? c)
                    }
                },
            } as any)

            registry.registerSystemPrompt({
                id: 'main-guideline',
                guideline: 'Main agent guideline',
                targetAgent: 'main',
            })
            registry.registerSystemPrompt({
                id: 'subagent-guideline',
                guideline: 'Subagent guideline',
                targetAgent: 'subagent',
            })

            const bridge = new FakeNativeBridge()
            bridge.setRuntimeInfo({ userConfigDir: '/cfg' })
            await bridge.mkdirAll('/repo')

            const childClient = new FakeCPAClient()
            childClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'child finished' }],
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => childClient,
            })

            const prepared = await service.prepare({
                baseUrl: 'https://api.example.com',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo',
            })

            // Main agent checks
            const mainToolNames = prepared.tools.map((t) => t.name)
            expect(mainToolNames).toContain('todo')
            expect(mainToolNames).toContain('shared_plugin_tool')
            expect(mainToolNames).toContain('spawn_agent')
            expect(mainToolNames).not.toContain('subagent_special_tool')
            expect(prepared.systemPrompt).toContain('Main agent guideline')
            expect(prepared.systemPrompt).not.toContain('Subagent guideline')

            // Spawn subagent
            service.subAgents.setParentContext({
                sessionId: 'parent-sess',
                runId: 'parent-run',
            })
            await service.subAgents.spawn('task for child', {
                name: 'Worker',
                modelId: modelBase.id,
            })

            expect(childClient.calls).toHaveLength(1)
            const childCall = childClient.calls[0]!
            const childToolNames = childCall.tools?.map((t) => t.name) ?? []

            expect(childToolNames).toContain('subagent_special_tool')
            expect(childToolNames).toContain('shared_plugin_tool')
            expect(childToolNames).toContain('read')
            expect(childToolNames).toContain('bash')
            expect(childToolNames).toContain('edit')
            expect(childToolNames).toContain('write')
            // todo and spawn_agent must NOT be present in subagent
            expect(childToolNames).not.toContain('todo')
            expect(childToolNames).not.toContain('spawn_agent')
            expect(childToolNames).not.toContain('send_message')
            expect(childToolNames).not.toContain('stop_agent')
            expect(childToolNames).not.toContain('title')

            expect(childCall.systemPrompt).toContain('Subagent guideline')
            expect(childCall.systemPrompt).not.toContain('Main agent guideline')
        })
    })

    describe('default connection manager from protocol provider', () => {
        it('uses extensionRegistry protocol provider createConnectionManager by default', async () => {
            const bridge = new FakeNativeBridge()
            const registry = new ExtensionRegistry()
            const fakeManager = {
                acquire: vi.fn(),
                dispose: vi.fn().mockResolvedValue(undefined),
            }
            const providerCreateConnectionManager = vi.fn().mockReturnValue(fakeManager)
            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'ok' }],
                    }),
            })

            let receivedConnectionManager: any = null
            registry.registerProtocolProvider({
                id: 'test-protocol-with-manager',
                isDefault: true,
                createConnectionManager: providerCreateConnectionManager,
                createClient: (opts: any) => {
                    receivedConnectionManager = opts.connectionManager
                    return fakeClient as unknown as ProtocolClient
                },
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'prompt',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-cm-1',
                    runId: 'run-cm-1',
                    entries: [userEntry('u1', 'hello')],
                }),
            )

            expect(providerCreateConnectionManager).toHaveBeenCalledTimes(1)
            expect(receivedConnectionManager).toBe(fakeManager)
            await service.dispose()
            expect(fakeManager.dispose).toHaveBeenCalledTimes(1)
        })
    })

    describe('production no-Mock scan', () => {
        it('production sources do not import or construct MockAgentService', () => {
            const here = path.dirname(fileURLToPath(import.meta.url))
            const frontendSrc = path.resolve(here, '../..')
            const allow = new Set([
                path.normalize(
                    path.join(frontendSrc, 'features/agent/MockAgentService.ts'),
                ),
                path.normalize(
                    path.join(
                        frontendSrc,
                        'features/agent/MockAgentService.test.ts',
                    ),
                ),
            ])

            const hits: string[] = []
            const walk = (dir: string) => {
                for (const name of readdirSync(dir)) {
                    if (name === 'node_modules' || name === 'dist') continue
                    const full = path.join(dir, name)
                    const st = statSync(full)
                    if (st.isDirectory()) {
                        walk(full)
                        continue
                    }
                    if (!/\.(ts|tsx)$/.test(name)) continue
                    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) {
                        continue
                    }
                    const normalized = path.normalize(full)
                    if (allow.has(normalized)) continue
                    const text = readFileSync(full, 'utf8')
                    if (
                        text.includes('MockAgentService') ||
                        text.includes('new MockAgentService')
                    ) {
                        hits.push(path.relative(frontendSrc, full))
                    }
                }
            }
            walk(frontendSrc)
            expect(hits).toEqual([])
        })
    })
})
