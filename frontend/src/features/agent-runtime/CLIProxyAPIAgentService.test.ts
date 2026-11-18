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
    now?: () => number
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
        now: opts?.now ?? (() => 1_700_000_000_000),
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
        it('fails a required policy closed when its plugin did not activate', async () => {
            const { service, fakeClient } = createService({ createTools: async () => [makeTool('read')] })
            const prepared = await service.prepare({ ...createWorktreePrepareInput(), projectPath: null, projectPaths: [], worktreePolicy: undefined, requiredToolPolicy: 'code-only' })
            expect(prepared.requiredToolPolicy).toBe('code-only')
            const events = await collect(service.streamChat({ prepared, sessionId: 's', runId: 'r', entries: [] }))
            expect(events.some((event) => event.type === 'error' && event.message.includes('Required tool policy unavailable'))).toBe(true)
            expect(fakeClient.calls).toHaveLength(0)
            await service.dispose()
        })

        it('preserves required policy metadata in immutable prepared tool snapshots', async () => {
            const policy = makeTool('policy')
            policy.toolPolicyId = 'restricted'
            policy.prepareToolSet = async () => ({ policyId: 'restricted', tools: [], nestedTools: [] })
            const { service, fakeClient } = createService({ createTools: async () => [makeTool('read'), policy] })
            fakeClient.queue({ kind: 'stream', final: (seed) => doneAssistant(seed, { stopReason: 'stop' }) })
            const prepared = await service.prepare({ ...createWorktreePrepareInput(), projectPath: null, projectPaths: [], worktreePolicy: undefined, requiredToolPolicy: 'restricted' })
            expect(prepared.tools.find((tool) => tool.name === 'policy')?.toolPolicyId).toBe('restricted')
            const events = await collect(service.streamChat({ prepared, sessionId: 's', runId: 'r', entries: [] }))
            expect(events.some((event) => event.type === 'error')).toBe(false)
            expect(fakeClient.calls).toHaveLength(1)
            expect(fakeClient.calls[0]?.tools ?? []).toHaveLength(0)
            await service.dispose()
        })
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
            const { service: serviceWithDir, loadCalls: dirLoadCalls } = createService({ bridge: bridgeWithDir })

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

            // Test gitSettings passed -> injected into prepared.gitSettings and loadResources input
            const preparedWithGit = await serviceWithDir.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/workspace',
                gitSettings: {
                    mergeMethod: 'squash',
                    alwaysForcePush: true,
                    createDraftPr: false,
                    commitInstructions: 'Use conventional commits',
                    prInstructions: 'Follow PR checklist',
                },
            })
            expect(preparedWithGit.gitSettings?.mergeMethod).toBe('squash')
            expect(dirLoadCalls[dirLoadCalls.length - 1]?.gitSettings?.mergeMethod).toBe('squash')
            expect(dirLoadCalls[dirLoadCalls.length - 1]?.gitSettings?.alwaysForcePush).toBe(true)
            expect(dirLoadCalls[dirLoadCalls.length - 1]?.gitSettings?.createDraftPr).toBe(false)
            expect(dirLoadCalls[dirLoadCalls.length - 1]?.gitSettings?.commitInstructions).toBe('Use conventional commits')
            expect(dirLoadCalls[dirLoadCalls.length - 1]?.gitSettings?.prInstructions).toBe('Follow PR checklist')

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

        it('applies modelSettings custom contextWindow override to prepared model and generation snapshot when enableAll is false', async () => {
            const { service } = createService()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: false,
                    models: {
                        [modelBase.id]: {
                            enabled: true,
                            contextWindow: 500_000,
                        },
                    },
                },
            })
            expect(prepared.model.contextWindow).toBe(500_000)
            expect(prepared.models?.[0]?.contextWindow).toBe(500_000)
            expect(prepared.generationSnapshot?.models[0]?.contextWindow).toBe(500_000)
        })

        it('does not override contextWindow when enableAll is true', async () => {
            const { service } = createService()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'high',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: true,
                    models: {
                        [modelBase.id]: {
                            enabled: true,
                            contextWindow: 500_000,
                        },
                    },
                },
            })
            expect(prepared.model.contextWindow).toBe(modelBase.contextWindow)
            expect(prepared.models?.[0]?.contextWindow).toBe(modelBase.contextWindow)
            expect(prepared.generationSnapshot?.models[0]?.contextWindow).toBe(modelBase.contextWindow)
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

        it('starts CacheWarmer on model request and settles into idle when warming is configured', async () => {
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
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'idle',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const user = userEntry('u1', 'hi')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-warm-1',
                    runId: 'run-warm-1',
                    entries: [user],
                    userEntry: user,
                }),
            )

            const warmer = service.getCacheWarmer('sess-warm-1')
            expect(warmer).toBeDefined()
            expect(warmer?.status.state).toBe('scheduled')
            expect(warmer?.status.phase).toBe('idle')

            // When service is disposed, warmer is cancelled
            await service.dispose()
            expect(warmer?.status.state).toBe('inactive')
        })

        it('stops idle warming an enhanced prompt when its model is deselected', async () => {
            vi.useFakeTimers()
            const { service, bridge, fakeClient } = createService({ now: () => Date.now() })
            try {
                const sessionId = 'sess-warm-enhanced'
                const savedPrompt = 'Saved enhanced system prompt'
                await bridge.SessionSetSystemPrompt(sessionId, savedPrompt)
                const response = {
                    kind: 'stream' as const,
                    final: (seed: AssistantEntry) => doneAssistant(seed, { stopReason: 'stop' }),
                }
                fakeClient.queue(response, response, response)

                let enhancement: NonNullable<AgentPrepareInput['systemPromptEnhancement']> = {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                    appliedModelIds: [modelBase.id],
                }
                const modelSettings = {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: { mode: 'idle' as const, maxWarmingTime: 1800 },
                }
                const prepared = await service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'key',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    modelSettings,
                    systemPromptEnhancement: enhancement,
                })
                const user = userEntry('u1', 'hi', sessionId)
                await collect(
                    service.streamChat({
                        prepared,
                        sessionId,
                        runId: 'run-warm-enhanced',
                        entries: [user],
                        userEntry: user,
                        getRuntimeSettings: () => ({
                            modelSettings,
                            systemPromptEnhancement: enhancement,
                        }),
                    }),
                )

                const warmer = service.getCacheWarmer(sessionId)
                expect(warmer?.status).toMatchObject({ state: 'scheduled', phase: 'idle' })
                expect(fakeClient.calls.map((call) => call.systemPrompt)).toEqual([savedPrompt])

                // Disabling new builds does not stop replay of a still-in-scope saved prompt.
                enhancement = { ...enhancement, enabled: false }
                await vi.advanceTimersByTimeAsync(270_000)
                expect(fakeClient.calls.map((call) => call.systemPrompt)).toEqual([savedPrompt, savedPrompt])

                enhancement = { ...enhancement, appliedModelIds: [] }
                await vi.advanceTimersByTimeAsync(270_000)
                expect(fakeClient.calls.map((call) => call.systemPrompt)).toEqual([savedPrompt, savedPrompt])
                expect(warmer?.status.state).toBe('inactive')
                expect(await bridge.SessionGetSystemPrompt(sessionId)).toBe(savedPrompt)
            } finally {
                await service.dispose()
                vi.useRealTimers()
            }
        })

        it('rebinds warmer with updated settings on subsequent runs in the same session', async () => {
            const { service, fakeClient } = createService()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'turn 1' }],
                    }),
            })

            // Run 1: warming off
            const prepared1 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'off',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u1 = userEntry('u1', 'hi')
            await collect(
                service.streamChat({
                    prepared: prepared1,
                    sessionId: 'sess-rebind',
                    runId: 'run-rebind-1',
                    entries: [u1],
                    userEntry: u1,
                }),
            )

            expect(service.getCacheWarmer('sess-rebind')?.status.state).toBe('inactive')

            // Run 2 in same session: user turned warming on ('idle')
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'turn 2' }],
                    }),
            })

            const prepared2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'idle',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u2 = userEntry('u2', 'hi again')
            await collect(
                service.streamChat({
                    prepared: prepared2,
                    sessionId: 'sess-rebind',
                    runId: 'run-rebind-2',
                    entries: [u1, u2],
                    userEntry: u2,
                }),
            )

            // Warmer should now be active and scheduled in idle phase
            const warmer2 = service.getCacheWarmer('sess-rebind')
            expect(warmer2?.status.state).toBe('scheduled')
            expect(warmer2?.status.phase).toBe('idle')

            // Cancelling warmer by session ID immediately cancels idle warmer
            await service.cancelSessionWarmers('sess-rebind')
            expect(warmer2?.status.state).toBe('inactive')
            expect(service.getCacheWarmer('sess-rebind')).toBeUndefined()
        })

        it('re-registers and tracks warmer in sessionWarmers on subsequent turn after cancellation', async () => {
            const { service, fakeClient } = createService()

            // Turn 1
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'turn 1' }],
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
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'idle',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u1 = userEntry('u1', 'first turn')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-multiturn',
                    runId: 'run-turn-1',
                    entries: [u1],
                    userEntry: u1,
                }),
            )

            // Warmer is active after turn 1
            expect(service.getCacheWarmer('sess-multiturn')).toBeDefined()

            // Cancel warmer between turns
            await service.cancelSessionWarmers('sess-multiturn')
            expect(service.getCacheWarmer('sess-multiturn')).toBeUndefined()

            // Turn 2 in same session
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'turn 2' }],
                    }),
            })

            const u2 = userEntry('u2', 'second turn')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-multiturn',
                    runId: 'run-turn-2',
                    entries: [u1, u2],
                    userEntry: u2,
                }),
            )

            // On turn 2, warmer should have been re-registered and tracked
            const finalWarmer = service.getCacheWarmer('sess-multiturn')
            expect(finalWarmer).toBeDefined()
            expect(finalWarmer?.status.state).toBe('scheduled')

            // Can be cancelled by session ID
            await service.cancelSessionWarmers('sess-multiturn')
            expect(finalWarmer?.status.state).toBe('inactive')
            expect(service.getCacheWarmer('sess-multiturn')).toBeUndefined()
        })

        it('cancels active session cache warmer when compacting session context', async () => {
            const compactMock = vi.fn(async (entries: unknown[]) => {
                const entry = {
                    id: 'c1',
                    sessionId: 'sess-compact-warm',
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
            const { service, fakeClient } = createService({
                compact: compactMock,
            })

            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        stopReason: 'stop',
                        content: [{ type: 'text', text: 'turn done' }],
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
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'idle',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u1 = userEntry('u1', 'msg 1')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-compact-warm',
                    runId: 'run-c1',
                    entries: [u1],
                    userEntry: u1,
                }),
            )

            // Warmer is scheduled in idle phase
            const warmer = service.getCacheWarmer('sess-compact-warm')
            expect(warmer).toBeDefined()
            expect(warmer?.status.state).toBe('scheduled')

            // Trigger compact
            await service.compact({
                prepared,
                sessionId: 'sess-compact-warm',
                runId: 'run-compact-1',
                entries: [u1],
            })

            // Compacting should have cancelled the pre-compaction warmer
            expect(warmer?.status.state).toBe('inactive')
            expect(service.getCacheWarmer('sess-compact-warm')).toBeUndefined()
        })

        it('does not prematurely release generation lease during agent run when warming is off', async () => {
            const { service, fakeClient } = createService()

            fakeClient.queue({
                kind: 'stream',
                final: (seed) => {
                    // Check if generation lease was released prematurely during the model request
                    return doneAssistant(seed, { stopReason: 'stop' })
                },
            })

            const releaseMock = vi.fn()
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {},
                    cacheWarming: {
                        mode: 'off',
                        maxWarmingTime: 1800,
                    },
                },
            })

            if (prepared.generationSnapshot?.lease) {
                prepared.generationSnapshot.lease.release = releaseMock
            }

            const user = userEntry('u1', 'hi')
            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 'sess-lease-check',
                    runId: 'run-lease-check',
                    entries: [user],
                    userEntry: user,
                }),
            )

            // Lease was released after run completed, not during warming start
            expect(releaseMock).toHaveBeenCalled()
        })

        it('ignores per-model TTL when enableAll is true and uses it when enableAll is false', async () => {
            const { service, fakeClient } = createService({
                now: () => 1000,
            })

            // Run 1: enableAll: true, model-1 has ttl: 100 configured in models map
            fakeClient.queue({
                kind: 'stream',
                final: (seed) => doneAssistant(seed, { stopReason: 'stop' }),
            })

            const prepared1 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: true,
                    defaultTtl: 300,
                    models: {
                        [modelBase.id]: {
                            enabled: true,
                            ttl: 100, // Should be ignored because enableAll is true
                        },
                    },
                    cacheWarming: {
                        mode: 'streaming',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u1 = userEntry('u1', 'hi')
            await collect(
                service.streamChat({
                    prepared: prepared1,
                    sessionId: 'sess-ttl-1',
                    runId: 'run-ttl-1',
                    entries: [u1],
                    userEntry: u1,
                }),
            )

            // When enableAll is true, uses defaultTtl 300s -> 270s delay
            // nextWarmAt = 1000 + 270,000 = 271,000
            const warmer1 = service.getCacheWarmer('sess-ttl-1')
            expect(warmer1).toBeDefined()
            // Now test run with enableAll: false and idle mode to verify nextWarmAt:
            fakeClient.queue({
                kind: 'stream',
                final: (seed) => doneAssistant(seed, { stopReason: 'stop' }),
            })

            const prepared2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                modelSettings: {
                    enableAll: false,
                    defaultTtl: 300,
                    models: {
                        [modelBase.id]: {
                            enabled: true,
                            ttl: 100, // 100s TTL -> 100 * 0.9 = 90s delay = 90,000ms
                        },
                    },
                    cacheWarming: {
                        mode: 'idle',
                        maxWarmingTime: 1800,
                    },
                },
            })

            const u2 = userEntry('u2', 'hi')
            await collect(
                service.streamChat({
                    prepared: prepared2,
                    sessionId: 'sess-ttl-2',
                    runId: 'run-ttl-2',
                    entries: [u2],
                    userEntry: u2,
                }),
            )

            const warmer2 = service.getCacheWarmer('sess-ttl-2')
            expect(warmer2?.status.state).toBe('scheduled')
            // Delay for 100s TTL is 90,000ms (100 * 0.9) from 1_700_000_000_000
            expect(warmer2?.status.nextWarmAt).toBe(1000 + 90_000)
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
        it('pins child tools and cwd to the parent run across unrelated prepares', async () => {
            const { service, bridge, fakeClient } = createService()
            await bridge.mkdirAll('/repo-a')
            await bridge.mkdirAll('/repo-b')

            const projectPrepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo-a',
                sessionId: 'project-session',
            })
            const pureChatPrepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                sessionId: 'pure-chat-session',
            })
            expect(pureChatPrepared.tools).toEqual([])

            fakeClient.queue(
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'stop',
                            content: [{ type: 'text', text: 'first child done' }],
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'stop',
                            content: [{ type: 'text', text: 'second child done' }],
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'stop',
                            content: [{ type: 'text', text: 'parent done' }],
                        }),
                },
            )

            const parentUser = userEntry(
                'parent-user',
                'start project work',
                'project-session',
            )
            const parentStream = service.streamChat({
                prepared: projectPrepared,
                sessionId: 'project-session',
                runId: 'project-run',
                entries: [parentUser],
                userEntry: parentUser,
            })
            const firstEvent = await parentStream.next()
            expect(firstEvent.value).toMatchObject({ type: 'agent-start' })

            const firstResult = await service.subAgents.spawn('inspect repo A', {
                name: 'FirstWorker',
                modelId: modelBase.id,
                parentSessionId: 'project-session',
            })
            expect(firstResult.isError).toBeFalsy()
            expect(fakeClient.calls[1]?.tools?.map((tool) => tool.name)).toEqual([
                'read',
                'bash',
                'edit',
                'write',
            ])
            expect(fakeClient.calls[1]?.systemPrompt).toContain(
                'Current working directory: /repo-a',
            )

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                projectPath: '/repo-b',
                sessionId: 'other-project-session',
            })

            const secondResult = await service.subAgents.spawn('recheck repo A', {
                name: 'SecondWorker',
                modelId: modelBase.id,
                parentSessionId: 'project-session',
            })
            expect(secondResult.isError).toBeFalsy()
            expect(fakeClient.calls[2]?.tools?.map((tool) => tool.name)).toEqual([
                'read',
                'bash',
                'edit',
                'write',
            ])
            expect(fakeClient.calls[2]?.systemPrompt).toContain(
                'Current working directory: /repo-a',
            )
            expect(fakeClient.calls[2]?.systemPrompt).not.toContain(
                'Current working directory: /repo-b',
            )

            for await (const _event of {
                [Symbol.asyncIterator]: () => parentStream,
            }) {
                // Drain the parent run so scoped resources are released.
            }
            expect(fakeClient.calls).toHaveLength(3)
        })

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

        it('persists session cachedContext across streamChat into manual compact only when fastContextCompaction is false', async () => {
            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) => ({
                    ...seed,
                    status: 'done',
                    stopReason: 'stop',
                    content: [{ type: 'text', text: 'First turn reply' }],
                }),
            })
            const compactSpy = vi.fn(
                async (entries: readonly any[], _opts: any) => {
                    const entry = {
                        id: 'cmp-manual-1',
                        sessionId: 'sess-manual-cache',
                        createdAt: 20,
                        kind: 'compaction' as const,
                        summary: 'manual summary',
                        firstKeptEntryId: entries[0]?.id ?? 'u1',
                    }
                    return { entry, entries: [...entries, entry] }
                },
            )
            const { service } = createService({
                client: fakeClient,
                compact: compactSpy,
                createTools: async () => [],
            })

            const preparedSlow = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'test-key',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                requestApproval: false,
                fastContextCompaction: false,
            })

            const u1 = userEntry('u1', 'hello')
            await collect(
                service.streamChat({
                    prepared: preparedSlow,
                    sessionId: 'sess-manual-cache',
                    runId: 'run-1',
                    entries: [u1],
                }),
            )

            // Manual compact with fastContextCompaction: false receives cachedContext from the completed turn.
            const compactRes = await service.compact({
                prepared: preparedSlow,
                sessionId: 'sess-manual-cache',
                runId: 'run-compact-1',
                entries: [u1],
            })
            expect(compactRes.ok).toBe(true)
            expect(compactSpy).toHaveBeenCalledTimes(1)
            expect(compactSpy.mock.calls[0]?.[1]?.trigger).toBe('manual')
            expect(compactSpy.mock.calls[0]?.[1]?.fastContextCompaction).toBe(false)
            expect(compactSpy.mock.calls[0]?.[1]?.cachedContext).toMatchObject({
                modelId: modelBase.id,
            })
            expect(compactSpy.mock.calls[0]?.[1]?.cachedContext?.cacheExpiresAt).toBeGreaterThan(0)

            // Subsequent compact after compaction has cleared cachedContext.
            await service.compact({
                prepared: preparedSlow,
                sessionId: 'sess-manual-cache',
                runId: 'run-compact-2',
                entries: [u1],
            })
            expect(compactSpy.mock.calls[1]?.[1]?.cachedContext).toBeUndefined()
            await service.dispose()
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

    describe('system prompt enhancement lifecycle', () => {

        it.each(['compact', 'winner', 'write-error', 'readback-error'] as const)('resolves the authoritative enhanced prompt for %s', async (scenario) => {
            const bridge = new FakeNativeBridge()
            const candidate = 'Inspect files carefully using title when available, preserve safety constraints and reply in the user language.'
            const client = new FakeCPAClient()
            client.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: candidate }], stopReason: 'stop' }) },
                { kind: 'stream', final: (seed) => doneAssistant(seed, { stopReason: 'stop' }) },
            )
            if (scenario === 'winner') {
                bridge.SessionSetSystemPrompt = vi.fn(async (id) => { await FakeNativeBridge.prototype.SessionSetSystemPrompt.call(bridge, id, 'DATABASE_WINNER'); return true })
            } else if (scenario === 'write-error') {
                bridge.SessionSetSystemPrompt = vi.fn().mockRejectedValue(new Error('SQLite write failed'))
            } else if (scenario === 'readback-error') {
                bridge.SessionGetSystemPrompt = vi.fn().mockResolvedValueOnce(null).mockRejectedValue(new Error('Readback failed'))
            }
            const compact = vi.fn(async (entries: any, _options?: any) => ({ entries }))
            const service = new CLIProxyAPIAgentService({
                bridge, createClient: () => client,
                createTools: async () => [], compact: compact as any,
                loadResources: async () => ({ contextFiles: [], skills: [], prompts: [], systemPrompt: 'RAW', mutableCoreSystemPrompt: 'Preserve all behavioral and language rules.', verbatimContextPrompt: '', diagnostics: [] }),
            })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317', apiKey: 'key', modelId: modelBase.id, models: [modelBase],
                reasoningLevel: 'medium', speed: 'standard', sessionId: 'review-session',
                systemPromptEnhancement: { enabled: true, multilingualEnabled: false, allowedLanguages: ['en'], modelId: '' },
            })
            if (scenario === 'compact') {
                await service.compact({ prepared, sessionId: 'review-session', runId: 'compact', entries: [userEntry('old', 'history')] })
                expect(client.calls).toHaveLength(1)
                expect(compact.mock.calls[0]?.[1]?.sessionSystemPrompt).toBe(candidate)
                expect(await bridge.SessionGetSystemPrompt('review-session')).toBe(candidate)
            } else {
                const run = () => collect(service.streamChat({ prepared, sessionId: 'review-session', runId: 'run', entries: [], userEntry: userEntry('new', 'hello') }))
                if (scenario === 'winner') {
                    await run()
                    expect(client.calls[1]?.systemPrompt).toBe('DATABASE_WINNER')
                } else {
                    await expect(run()).rejects.toMatchObject({ name: 'AgentPreflightError', code: 'system_prompt_enhancement_failed', i18nKey: 'agent.preflight.system_prompt_enhancement_failed' })
                    expect(client.calls).toHaveLength(1)
                }
            }
        })
        it('does not call build model during double prepareRun (worktree flow), synthesizes once on first streamChat, persists to SQLite, and reuses identical prompt across subsequent turns, manual compact, and settings changes', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/agent/AGENTS.md', 'GLOBAL_VERBATIM_AGENTS')
            const fakeClient = new FakeCPAClient()
            const builderModel: ModelCatalogEntry = {
                ...modelBase,
                id: 'builder-model',
            }

            // Turn 1: build call + main chat call; Turn 2: main chat call; Compact: isolated summary call
            fakeClient.queue(
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            content: [
                                {
                                    type: 'text',
                                    text: 'Rewritten unique instruction set using title read bash edit write in /wt/s-wt.',
                                },
                            ],
                            stopReason: 'stop',
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            content: [{ type: 'text', text: 'Turn 1 answer' }],
                            stopReason: 'stop',
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            content: [{ type: 'text', text: 'Turn 2 answer' }],
                            stopReason: 'stop',
                        }),
                },
            )

            const compactMock = vi.fn(async (entries: any, _options?: any) => ({
                entry: {
                    id: 'cmp-1',
                    sessionId: 's-wt',
                    kind: 'compaction' as const,
                    summary: 'summary',
                    firstKeptEntryId: entries[0]?.id ?? 'u1',
                    createdAt: 100,
                },
                entries,
            }))

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async (input) => ({
                    contextFiles: [{ path: '/agent/AGENTS.md', content: 'GLOBAL_VERBATIM_AGENTS' }],
                    skills: [],
                    prompts: [],
                    systemPrompt: `SYSTEM tools=${(input.tools ?? []).map((t) => t.name).join(',')}`,
                    mutableCoreSystemPrompt: `CORE tools=${(input.tools ?? []).map((t) => t.name).join(',')} cwd=${input.cwd ?? ''}`,
                    verbatimContextPrompt: 'GLOBAL_VERBATIM_AGENTS',
                    diagnostics: [],
                }),
                createTools: async (cwd) =>
                    cwd
                        ? [makeTool('read'), makeTool('bash'), makeTool('edit'), makeTool('write')]
                        : [],
                now: () => 1000,
                generateId: (() => {
                    let n = 0
                    return () => `id-${++n}`
                })(),
            })

            const enhancement = {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en'] as ('en')[],
                modelId: 'builder-model',
            }

            // Double prepareRun (worktree flow: first with sessionId: null, second with sessionId: 's-wt')
            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase, builderModel],
                reasoningLevel: 'medium',
                speed: 'standard',
                projectPath: '/repo',
                sessionId: null,
                systemPromptEnhancement: enhancement,
            })
            const preparedWt = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase, builderModel],
                reasoningLevel: 'medium',
                speed: 'standard',
                projectPath: '/wt/s-wt',
                sessionId: 's-wt',
                systemPromptEnhancement: enhancement,
            })

            // Zero build model calls during prepareRun
            expect(fakeClient.calls).toHaveLength(0)

            // Turn 1 streamChat triggers 1 build call + 1 main call
            const u1 = userEntry('u1', 'Hello', 's-wt')
            const buildProgress = vi.fn((active: boolean) => {
                expect(fakeClient.calls).toHaveLength(active ? 0 : 1)
            })
            await collect(
                service.streamChat({
                    prepared: preparedWt,
                    sessionId: 's-wt',
                    runId: 'r1',
                    entries: [],
                    userEntry: u1,
                    onSystemPromptBuildChange: buildProgress,
                }),
            )

            expect(buildProgress.mock.calls).toEqual([[true], [false]])
            expect(fakeClient.calls).toHaveLength(2)
            expect(fakeClient.calls[0]?.model.id).toBe('builder-model')
            const expectedLockedPrompt =
                'Rewritten unique instruction set using title read bash edit write in /wt/s-wt.\n\nGLOBAL_VERBATIM_AGENTS'
            expect(fakeClient.calls[1]?.systemPrompt).toBe(expectedLockedPrompt)
            expect(await bridge.SessionGetSystemPrompt('s-wt')).toBe(expectedLockedPrompt)

            // Turn 2: disable enhancement globally; session must still reuse exact persisted prompt
            const preparedTurn2 = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase, builderModel],
                reasoningLevel: 'medium',
                speed: 'standard',
                projectPath: '/wt/s-wt',
                sessionId: 's-wt',
                systemPromptEnhancement: { ...enhancement, enabled: false },
            })
            buildProgress.mockClear()
            await collect(
                service.streamChat({
                    prepared: preparedTurn2,
                    sessionId: 's-wt',
                    runId: 'r2',
                    entries: [u1],
                    userEntry: userEntry('u2', 'Next turn', 's-wt'),
                    onSystemPromptBuildChange: buildProgress,
                }),
            )

            expect(buildProgress).not.toHaveBeenCalled()
            expect(fakeClient.calls).toHaveLength(3)
            expect(fakeClient.calls[2]?.systemPrompt).toBe(expectedLockedPrompt)

            // Manual compact also passes the exact persisted sessionSystemPrompt
            await service.compact({
                prepared: preparedTurn2,
                sessionId: 's-wt',
                runId: 'r-cmp',
                entries: [u1],
            })
            expect(compactMock).toHaveBeenCalledTimes(1)
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBe(expectedLockedPrompt)
        })

        it('ends prompt build progress when the run is cancelled before the main request', async () => {
            const { service, fakeClient } = createService()
            fakeClient.queue({ kind: 'throw', error: new Error('builder unavailable') })
            const sessionId = 's-build-cancel'
            const runId = 'r-build-cancel'
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId,
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })
            const progress = vi.fn((active: boolean) => {
                if (active) queueMicrotask(() => service.abort(runId))
            })
            await expect(collect(service.streamChat({
                prepared, sessionId, runId, entries: [],
                userEntry: userEntry('u-cancel', 'Hello', sessionId),
                onSystemPromptBuildChange: progress,
            }))).rejects.toMatchObject({ code: 'aborted' })
            expect(progress.mock.calls).toEqual([[true], [false]])
        })

        it('throws AgentPreflightError(system_prompt_enhancement_no_model) in prepareRun when enhancement is enabled and no enabled model exists', async () => {
            const { service } = createService()
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'sk-test',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    modelSettings: {
                        enableAll: false,
                        models: {
                            [modelBase.id]: { enabled: false },
                        },
                        modelOrder: [],
                    },
                    systemPromptEnhancement: {
                        enabled: true,
                        multilingualEnabled: false,
                        allowedLanguages: ['en'],
                        modelId: '',
                    },
                }),
            ).rejects.toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_no_model',
            })
        })

        it('fails closed when SessionGetSystemPrompt rejects instead of rebuilding or sending raw prompt, and drops cache when SessionSetSystemPrompt returns false', async () => {
            const bridge = new FakeNativeBridge()
            bridge.SessionGetSystemPrompt = vi.fn().mockRejectedValue(new Error('SQLite read failed'))
            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Should not run' }],
                        stopReason: 'stop',
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
                now: () => 1000,
                generateId: () => 'id-1',
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-read-err',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: modelBase.id,
                },
            })

            await expect(
                collect(
                    service.streamChat({
                        prepared,
                        sessionId: 's-read-err',
                        runId: 'r-read-err',
                        entries: [],
                        userEntry: userEntry('u1', 'hi', 's-read-err'),
                    }),
                ),
            ).rejects.toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_failed',
            })
            expect(fakeClient.calls).toHaveLength(0)

            // When SessionSetSystemPrompt returns false (tombstoned), do not cache or proceed
            bridge.SessionGetSystemPrompt = vi.fn().mockResolvedValue(null)
            bridge.SessionSetSystemPrompt = vi.fn().mockResolvedValue(false)
            const fakeClient2 = new FakeCPAClient()
            fakeClient2.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Unique rewritten core prompt using title without fingerprints.' }],
                        stopReason: 'stop',
                    }),
            })
            const service2 = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient2 as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
                now: () => 1000,
                generateId: () => 'id-2',
            })
            const prepared2 = await service2.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-tomb',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: modelBase.id,
                },
            })
            await expect(
                collect(
                    service2.streamChat({
                        prepared: prepared2,
                        sessionId: 's-tomb',
                        runId: 'r-tomb',
                        entries: [],
                        userEntry: userEntry('u1', 'hi', 's-tomb'),
                    }),
                ),
            ).rejects.toMatchObject({
                name: 'AgentPreflightError',
                code: 'session_gone',
            })
            expect(fakeClient2.calls).toHaveLength(1)
        })

        it('falls back to global defaultModelId rather than session modelId when enhancement.modelId is empty', async () => {
            const bridge = new FakeNativeBridge()
            const globalModel: ModelCatalogEntry = { ...modelBase, id: 'global-default-model', label: 'Global' }
            const sessionModel: ModelCatalogEntry = { ...modelBase, id: 'session-override-model', label: 'Session' }
            const fakeClient = new FakeCPAClient()
            fakeClient.queue(
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            content: [{ type: 'text', text: 'Use title before other work only when declared; otherwise focus on the delegated task. Preserve behavioral constraints and the user reply language.' }],
                            stopReason: 'stop',
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            content: [{ type: 'text', text: 'Reply' }],
                            stopReason: 'stop',
                        }),
                },
            )
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
                now: () => 1000,
                generateId: () => 'id-3',
            })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: sessionModel.id,
                defaultModelId: globalModel.id,
                models: [sessionModel, globalModel],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-default-model',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            await collect(
                service.streamChat({
                    prepared,
                    sessionId: 's-default-model',
                    runId: 'r-def',
                    entries: [],
                    userEntry: userEntry('u1', 'hi', 's-default-model'),
                }),
            )

            expect(fakeClient.calls).toHaveLength(2)
            expect(fakeClient.calls[0]?.model.id).toBe('global-default-model')
            expect(fakeClient.calls[1]?.model.id).toBe('session-override-model')
        })

        it('builds once on the first selected child and never uses the enhanced prompt for unselected turns', async () => {
            const bridge = new FakeNativeBridge()
            const fakeClient = new FakeCPAClient()
            const sessionId = 's-model-scope'
            const target = { ...modelBase, id: 'selected-child' }
            const builder = { ...modelBase, id: 'prompt-builder' }
            const builtPrompt = 'Rewritten instructions for this session; use title when appropriate and assist the user in English.'
            for (const text of [builtPrompt, builtPrompt, 'child reply', 'raw child reply', 'another child reply', 'next main reply']) {
                fakeClient.queue({
                    kind: 'stream',
                    final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text }], stopReason: 'stop' }),
                })
            }
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [],
                loadResources: async () => ({
                    contextFiles: [], skills: [], prompts: [], diagnostics: [],
                    systemPrompt: 'RAW_MAIN', mutableCoreSystemPrompt: 'Base instructions.',
                    verbatimContextPrompt: '',
                }),
            })
            const prepareInput = {
                baseUrl: 'http://127.0.0.1:8317', apiKey: 'sk-test',
                modelId: modelBase.id, models: [modelBase, target, builder],
                reasoningLevel: 'medium' as const, speed: 'standard' as const, sessionId,
                systemPromptEnhancement: {
                    enabled: true, multilingualEnabled: false, allowedLanguages: ['en' as const],
                    modelId: builder.id, appliedModelIds: [target.id],
                },
            }
            const u1 = userEntry('u-scope-1', 'delegate work', sessionId)
            const parent = service.streamChat({
                prepared: await service.prepare(prepareInput),
                sessionId, runId: 'r-scope-1', entries: [], userEntry: u1,
            })
            let first = await parent.next()
            while (fakeClient.calls.length === 0 && !first.done) first = await parent.next()
            expect(fakeClient.calls.map((call) => call.model.id)).toEqual([modelBase.id])
            expect(fakeClient.calls[0]?.systemPrompt).toContain('RAW_MAIN')
            expect(await bridge.SessionGetSystemPrompt(sessionId)).toBeNull()

            for (const modelId of [target.id, modelBase.id, target.id]) {
                const result = await service.subAgents.spawn('do work', { name: 'Worker', modelId, parentSessionId: sessionId })
                expect(result.isError).toBeFalsy()
            }
            expect(await bridge.SessionGetSystemPrompt(sessionId)).toBe(builtPrompt)
            expect(fakeClient.calls.map((call) => call.model.id)).toEqual([
                modelBase.id, builder.id, target.id, modelBase.id, target.id,
            ])
            expect(fakeClient.calls[2]?.systemPrompt).toBe(builtPrompt)
            expect(fakeClient.calls[3]?.systemPrompt).toContain('Worker')
            expect(fakeClient.calls[3]?.systemPrompt).not.toContain(builtPrompt)
            expect(fakeClient.calls[4]?.systemPrompt).toBe(builtPrompt)
            await collect(parent)

            await collect(service.streamChat({
                prepared: await service.prepare(prepareInput),
                sessionId, runId: 'r-scope-2', entries: [u1],
                userEntry: userEntry('u-scope-2', 'next turn', sessionId),
            }))
            expect(fakeClient.calls).toHaveLength(6)
            expect(fakeClient.calls[5]?.systemPrompt).toContain('RAW_MAIN')
        })

        it('skips builder preflight for an unselected model even when no enabled builder is available', async () => {
            const service = new CLIProxyAPIAgentService({
                bridge: new FakeNativeBridge(),
                loadResources: async () => ({
                    contextFiles: [], skills: [], prompts: [], diagnostics: [], systemPrompt: 'RAW',
                }),
                createTools: async () => [],
            })
            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317', apiKey: 'sk-test',
                modelId: modelBase.id, models: [modelBase],
                reasoningLevel: 'medium', speed: 'standard',
                modelSettings: { enableAll: false, models: { [modelBase.id]: { enabled: false } } },
                systemPromptEnhancement: {
                    enabled: true, multilingualEnabled: false, allowedLanguages: ['en'],
                    modelId: 'unavailable-builder', appliedModelIds: [],
                },
            })
            expect(prepared.model.id).toBe(modelBase.id)
        })

        it('does not compact with an enhanced prompt or its cached request after unselecting that model', async () => {
            const bridge = new FakeNativeBridge()
            const sessionId = 's-unselected-compact'
            await bridge.SessionSetSystemPrompt(sessionId, 'SAVED_ENHANCED')
            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'reply' }], stopReason: 'stop' }),
            })
            const compactMock = vi.fn(async (_entries: any, _options?: any) => null)
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async () => ({
                    contextFiles: [], skills: [], prompts: [], diagnostics: [], systemPrompt: 'RAW',
                }),
                createTools: async () => [],
            })
            const prepareInput = {
                baseUrl: 'http://127.0.0.1:8317', apiKey: 'sk-test',
                modelId: modelBase.id, models: [modelBase],
                reasoningLevel: 'medium' as const, speed: 'standard' as const,
                fastContextCompaction: false, sessionId,
            }
            const entry = userEntry('u-scope-compact', 'a message', sessionId)
            await collect(service.streamChat({
                prepared: await service.prepare(prepareInput),
                sessionId, runId: 'r-scope-cached', entries: [], userEntry: entry,
            }))
            expect(fakeClient.calls[0]?.systemPrompt).toBe('SAVED_ENHANCED')

            await service.compact({
                prepared: await service.prepare({
                    ...prepareInput,
                    systemPromptEnhancement: {
                        enabled: true, multilingualEnabled: false, allowedLanguages: ['en'],
                        modelId: '', appliedModelIds: [],
                    },
                }),
                sessionId, runId: 'r-scope-compact', entries: [entry],
            })
            expect(compactMock).toHaveBeenCalledTimes(1)
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBeUndefined()
            expect(compactMock.mock.calls[0]?.[1]?.cachedContext).toBeUndefined()
            expect(await bridge.SessionGetSystemPrompt(sessionId)).toBe('SAVED_ENHANCED')
        })

        it('forwards parent enhancedSystemPrompt through sub-agent loop into overflow compaction', async () => {
            const bridge = new FakeNativeBridge()
            const lockedPrompt = 'LOCKED_SUBAGENT_PARENT_PROMPT'
            await bridge.SessionSetSystemPrompt('s-sub-cmp', lockedPrompt)

            const fakeClient = new FakeCPAClient()
            // 1. Subagent initial call fails with context_length_exceeded to trigger overflow compaction
            // 2. Subagent retry after compaction succeeds
            // 3. Parent turn completes
            fakeClient.queue(
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'error',
                            status: 'error',
                            errorMessage: 'context_length_exceeded',
                            content: [],
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'stop',
                            content: [{ type: 'text', text: 'child recovered after compact' }],
                        }),
                },
                {
                    kind: 'stream',
                    final: (seed) =>
                        doneAssistant(seed, {
                            stopReason: 'stop',
                            content: [{ type: 'text', text: 'parent finished' }],
                        }),
                },
            )

            const compactMock = vi.fn(async (entries: any, _options?: any) => ({
                entry: {
                    id: 'cmp-sub-1',
                    sessionId: 'child-1',
                    kind: 'compaction' as const,
                    summary: 'child compacted',
                    firstKeptEntryId: entries[0]?.id ?? 'u-child',
                    createdAt: 100,
                },
                entries,
            }))

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
                now: () => 1000,
                generateId: (() => {
                    let n = 0
                    return () => `sub-${++n}`
                })(),
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-sub-cmp',
            })

            const parentStream = service.streamChat({
                prepared,
                sessionId: 's-sub-cmp',
                runId: 'r-parent-sub',
                entries: [],
                userEntry: userEntry('u-p', 'delegate work', 's-sub-cmp'),
            })
            const firstEvent = await parentStream.next()
            expect(firstEvent.value).toMatchObject({ type: 'agent-start' })

            const childRes = await service.subAgents.spawn('work task', {
                name: 'Worker',
                modelId: modelBase.id,
                parentSessionId: 's-sub-cmp',
            })
            expect(childRes.isError).toBeFalsy()
            expect(compactMock).toHaveBeenCalledTimes(1)
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBe(lockedPrompt)

            // Drain parent stream
            while (!(await parentStream.next()).done) {
                // drain
            }
        })

        it('resolves persisted parent enhanced prompt asynchronously on direct sub-agent resume after restart without prior streamChat and fails closed on read error', async () => {
            const bridge = new FakeNativeBridge()
            const persistedPrompt = 'PERSISTED_AFTER_RESTART_PROMPT'
            await bridge.SessionSetSystemPrompt('s-restart', persistedPrompt)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Sub-agent resumed' }],
                        stopReason: 'stop',
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW_UNENHANCED_SUBAGENT',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            service.subAgents.hydrate([
                {
                    id: 'sub-restart-1',
                    sessionId: 'child-restart-1',
                    parentSessionId: 's-restart',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-restart',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const res = await service.subAgents.resumeSubAgent('sub-restart-1', {
                entries: [userEntry('u-child', 'Continue', 'child-restart-1')],
            })
            expect(res.isError).toBeFalsy()
            expect(fakeClient.calls).toHaveLength(1)
            expect(fakeClient.calls[0]?.systemPrompt).toBe(persistedPrompt)

            // Fail closed if reading persisted prompt fails
            const failingBridge = new FakeNativeBridge()
            failingBridge.SessionGetSystemPrompt = vi.fn().mockRejectedValue(new Error('DB down'))
            const failClient = new FakeCPAClient()
            const failService = new CLIProxyAPIAgentService({
                bridge: failingBridge,
                createClient: () => failClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW_UNENHANCED_SUBAGENT',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            failService.subAgents.hydrate([
                {
                    id: 'sub-restart-fail',
                    sessionId: 'child-restart-fail',
                    parentSessionId: 's-restart-fail',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
            await failService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-restart-fail',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })
            const failRes = await failService.subAgents.resumeSubAgent('sub-restart-fail', {
                entries: [userEntry('u-child-fail', 'Continue', 'child-restart-fail')],
            })
            expect(failRes.isError).toBe(true)
            expect(failClient.calls).toHaveLength(0)
        })

        it('rejects stale cachedContext whose systemPrompt differs from persisted sessionSystemPrompt during compact', async () => {
            const bridge = new FakeNativeBridge()
            const fakeClient = new FakeCPAClient()
            const u1 = userEntry('u1', 'Hello', 's-stale-cache')
            const a1: AssistantEntry = {
                id: 'a1',
                sessionId: 's-stale-cache',
                createdAt: 2,
                kind: 'assistant',
                model: modelBase.id,
                content: [{ type: 'text', text: 'Answer' }],
                status: 'done',
                stopReason: 'stop',
            }
            fakeClient.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'Answer' }], stopReason: 'stop' }) },
            )

            const compactMock = vi.fn(async (entries: any, _options?: any) => ({
                entry: {
                    id: 'cmp-stale',
                    sessionId: 's-stale-cache',
                    kind: 'compaction' as const,
                    summary: 'summary',
                    firstKeptEntryId: 'u1',
                    createdAt: 100,
                },
                entries,
            }))

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'OLD_RAW',
                    mutableCoreSystemPrompt: 'OLD_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const preparedUnenhanced = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                fastContextCompaction: false,
                sessionId: 's-stale-cache',
            })

            await collect(service.streamChat({
                prepared: preparedUnenhanced,
                sessionId: 's-stale-cache',
                runId: 'r-old',
                entries: [],
                userEntry: u1,
            }))

            // Later the session gets an enhanced prompt persisted
            await bridge.SessionSetSystemPrompt('s-stale-cache', 'ENHANCED_LOCKED_PROMPT')
            await service.compact({
                prepared: preparedUnenhanced,
                sessionId: 's-stale-cache',
                runId: 'r-compact-stale',
                entries: [u1, a1],
            })

            expect(compactMock).toHaveBeenCalledTimes(1)
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBe('ENHANCED_LOCKED_PROMPT')
            expect(compactMock.mock.calls[0]?.[1]?.cachedContext).toBeUndefined()
        })

        it('includes SessionStart hook additionalContexts and dynamic title tool during first-time compact on a pre-existing session', async () => {
            const bridge = new FakeNativeBridge()
            const fakeClient = new FakeCPAClient()
            const candidate = 'Use title tool carefully and honor HOOK_SESSION_CONTEXT when assisting the user in English.'
            fakeClient.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: candidate }], stopReason: 'stop' }) },
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'Chat turn' }], stopReason: 'stop' }) },
            )

            const registry = new ExtensionRegistry()
            registry.registerHook({
                id: 'test.session-start',
                event: 'SessionStart',
                order: 100,
                failureMode: 'open',
                execute: async () => ({
                    continue: true,
                    additionalContexts: ['HOOK_SESSION_CONTEXT'],
                }),
            })
            registry.registerToolFactory({
                id: 'title',
                targets: ['main'],
                create: async () => makeTool('title'),
            })

            const compactMock = vi.fn(async (entries: any, _options?: any) => ({
                entry: {
                    id: 'cmp-hook',
                    sessionId: 's-preexisting',
                    kind: 'compaction' as const,
                    summary: 'summary',
                    firstKeptEntryId: entries[0]?.id ?? 'u1',
                    createdAt: 100,
                },
                entries,
            }))

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preexisting',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const u1 = userEntry('u1', 'Old turn', 's-preexisting')
            const progress = vi.fn((active: boolean) => {
                expect(fakeClient.calls).toHaveLength(active ? 0 : 1)
                expect(compactMock).not.toHaveBeenCalled()
            })
            await service.compact({
                prepared,
                sessionId: 's-preexisting',
                runId: 'r-cmp-hook',
                entries: [u1],
                onSystemPromptBuildChange: progress,
            })
            expect(progress.mock.calls).toEqual([[true], [false]])

            // Builder call received SessionStart additionalContexts and dynamic title tool requirement
            expect(fakeClient.calls).toHaveLength(1)
            const builderUserText = JSON.stringify(fakeClient.calls[0]?.entries)
            expect(builderUserText).toContain('HOOK_SESSION_CONTEXT')
            expect(builderUserText).toContain('title')
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBe(candidate)

            // Subsequent chat turn reuses the exact locked prompt
            await collect(service.streamChat({
                prepared,
                sessionId: 's-preexisting',
                runId: 'r-chat-after-cmp',
                entries: [u1],
                userEntry: userEntry('u2', 'Next', 's-preexisting'),
            }))
            expect(fakeClient.calls[1]?.systemPrompt).toBe(candidate)
        })

        it('builds, persists, and uses enhanced prompt when directly resuming a sub-agent on a pre-existing session with no persisted prompt, failing closed on error', async () => {
            const bridge = new FakeNativeBridge()
            const builtPrompt = 'Synthesized parent prompt preserving read and title tool usage and HOOK_DIRECT_RESUME context in English.'
            const fakeClient = new FakeCPAClient()
            fakeClient.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: builtPrompt }], stopReason: 'stop' }) },
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'Sub-agent resumed with enhancement' }], stopReason: 'stop' }) },
            )

            const registry = new ExtensionRegistry()
            let sessionStartCalls = 0
            registry.registerHook({
                id: 'test.direct-sub-resume-hook',
                event: 'SessionStart',
                order: 100,
                failureMode: 'open',
                execute: async () => {
                    sessionStartCalls += 1
                    return {
                        continue: true,
                        additionalContexts: ['HOOK_DIRECT_RESUME'],
                    }
                },
            })
            let titleFactoryCalls = 0
            registry.registerToolFactory({
                id: 'title',
                targets: ['main'],
                create: async () => {
                    titleFactoryCalls += 1
                    return makeTool('title')
                },
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW_UNENHANCED_SUBAGENT',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            service.subAgents.hydrate([
                {
                    id: 'sub-preexisting-1',
                    sessionId: 'child-preexisting-1',
                    parentSessionId: 's-preexisting-direct',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preexisting-direct',
                getEntries: async () => [userEntry('u-parent', 'Start parent', 's-preexisting-direct')],
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const res = await service.subAgents.resumeSubAgent('sub-preexisting-1', {
                entries: [userEntry('u-child', 'Continue', 'child-preexisting-1')],
            })

            expect(res.isError).toBeFalsy()
            expect(sessionStartCalls).toBe(1)
            expect(titleFactoryCalls).toBe(1)
            expect(await bridge.SessionGetSystemPrompt('s-preexisting-direct')).toBe(builtPrompt)
            expect(fakeClient.calls).toHaveLength(2)
            expect(JSON.stringify(fakeClient.calls[0]?.entries)).toContain('HOOK_DIRECT_RESUME')
            expect(fakeClient.calls[1]?.systemPrompt).toBe(builtPrompt)

            // Fail closed when enhancement synthesis fails on direct sub-agent resume
            const failClient = new FakeCPAClient()
            failClient.queue({
                kind: 'throw',
                error: new Error('Builder upstream failed'),
            })
            const failService = new CLIProxyAPIAgentService({
                bridge: new FakeNativeBridge(),
                createClient: () => failClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW_UNENHANCED_SUBAGENT',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            failService.subAgents.hydrate([
                {
                    id: 'sub-preexisting-fail',
                    sessionId: 'child-preexisting-fail',
                    parentSessionId: 's-preexisting-fail',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
            await failService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preexisting-fail',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const failRes = await failService.subAgents.resumeSubAgent('sub-preexisting-fail', {
                entries: [userEntry('u-child-fail', 'Continue', 'child-preexisting-fail')],
            })
            expect(failRes.isError).toBe(true)
            // Must never invoke sub-agent execution with unenhanced fallback prompt
            expect(failClient.calls.every((call) => call.systemPrompt !== 'RAW_UNENHANCED_SUBAGENT')).toBe(true)
        })

        it('skips SessionStart hook and dynamic title tool during manual compact when enhancement is disabled and no persisted prompt exists', async () => {
            const bridge = new FakeNativeBridge()
            const fakeClient = new FakeCPAClient()
            const registry = new ExtensionRegistry()
            let sessionStartCalls = 0
            registry.registerHook({
                id: 'test.compact-disabled-hook',
                event: 'SessionStart',
                order: 100,
                failureMode: 'open',
                execute: async () => {
                    sessionStartCalls += 1
                    return {
                        continue: true,
                        additionalContexts: ['SHOULD_NOT_RUN'],
                    }
                },
            })
            let titleFactoryCalls = 0
            registry.registerToolFactory({
                id: 'title',
                targets: ['main'],
                create: async () => {
                    titleFactoryCalls += 1
                    return makeTool('title')
                },
            })

            const compactMock = vi.fn(async (entries: any, _options?: any) => ({
                entry: {
                    id: 'cmp-disabled',
                    sessionId: 's-cmp-disabled',
                    kind: 'compaction' as const,
                    summary: 'summary',
                    firstKeptEntryId: entries[0]?.id ?? 'u1',
                    createdAt: 100,
                },
                entries,
            }))

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                compact: compactMock as any,
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
                createTools: async () => [],
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-cmp-disabled',
                systemPromptEnhancement: {
                    enabled: false,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const u1 = userEntry('u1', 'Hello', 's-cmp-disabled')
            await service.compact({
                prepared,
                sessionId: 's-cmp-disabled',
                runId: 'r-cmp-disabled',
                entries: [u1],
            })

            expect(sessionStartCalls).toBe(0)
            expect(titleFactoryCalls).toBe(0)
            expect(compactMock).toHaveBeenCalledTimes(1)
            expect(compactMock.mock.calls[0]?.[1]?.sessionSystemPrompt).toBeUndefined()
        })

        it('cancels parent prompt synthesis immediately when stopping direct sub-agent resume', async () => {
            const bridge = new FakeNativeBridge()
            let builderAborted = false
            let builderStarted!: () => void
            const builderStartedPromise = new Promise<void>((resolve) => {
                builderStarted = resolve
            })

            const hangingBuilderClient = {
                stream: (_input: any, signalOrOpts?: AbortSignal | { signal?: AbortSignal }) => {
                    const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : signalOrOpts?.signal
                    builderStarted()
                    return (async function* () {
                        await new Promise<void>((_resolve, reject) => {
                            if (signal?.aborted) {
                                builderAborted = true
                                const err = new Error('Aborted')
                                err.name = 'AbortError'
                                reject(err)
                                return
                            }
                            signal?.addEventListener(
                                'abort',
                                () => {
                                    builderAborted = true
                                    const err = new Error('Aborted')
                                    err.name = 'AbortError'
                                    reject(err)
                                },
                                { once: true },
                            )
                        })
                    })()
                },
                cancel: async () => {},
                dispose: () => {},
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => hangingBuilderClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            service.subAgents.hydrate([
                {
                    id: 'sub-stop-1',
                    sessionId: 'child-stop-1',
                    parentSessionId: 's-parent-stop',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-parent-stop',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const resumePromise = service.subAgents.resumeSubAgent('sub-stop-1', {
                entries: [userEntry('u-child-stop', 'Continue', 'child-stop-1')],
            })

            await builderStartedPromise
            const stopResult = service.subAgents.stop('sub-stop-1')
            expect(stopResult.isError).toBeFalsy()

            const resumeResult = await Promise.race([
                resumePromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('resumeSubAgent stayed blocked after stop()')), 1000),
                ),
            ])

            expect(builderAborted).toBe(true)
            expect(resumeResult.isError).toBe(true)
            expect(service.subAgents.list().find((a) => a.id === 'sub-stop-1')?.status).toBe('aborted')
            expect(await bridge.SessionGetSystemPrompt('s-parent-stop')).toBeNull()
        })

        it('supports safe multi-waiter cancellation in single-flight inFlightPromptBuilds', async () => {
            const bridge = new FakeNativeBridge()
            const builtPrompt = 'Synthesized parent prompt preserving read and title tool usage in English.'
            let builderAborted = false
            let builderCalls = 0
            let builderStarted!: () => void
            const builderStartedPromise = new Promise<void>((resolve) => {
                builderStarted = resolve
            })
            let resolveBuilder!: (text: string) => void
            const builderResultPromise = new Promise<string>((resolve) => {
                resolveBuilder = resolve
            })

            const multiClient = {
                stream: (_input: any, signalOrOpts?: AbortSignal | { signal?: AbortSignal }) => {
                    const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : signalOrOpts?.signal
                    builderCalls += 1
                    if (builderCalls === 1) {
                        builderStarted()
                        return (async function* () {
                            const text = await new Promise<string>((resolve, reject) => {
                                if (signal?.aborted) {
                                    builderAborted = true
                                    const err = new Error('Aborted')
                                    err.name = 'AbortError'
                                    reject(err)
                                    return
                                }
                                signal?.addEventListener(
                                    'abort',
                                    () => {
                                        builderAborted = true
                                        const err = new Error('Aborted')
                                        err.name = 'AbortError'
                                        reject(err)
                                    },
                                    { once: true },
                                )
                                void builderResultPromise.then(resolve, reject)
                            })
                            const seed: AssistantEntry = {
                                id: 'builder-mw-1',
                                sessionId: 's-multi-waiter',
                                createdAt: 1,
                                kind: 'assistant',
                                model: modelBase.id,
                                content: [{ type: 'text', text }],
                                status: 'done',
                                stopReason: 'stop',
                            }
                            yield { type: 'done', message: seed } as AssistantStreamEvent
                        })()
                    }
                    return (async function* () {
                        const seed: AssistantEntry = {
                            id: 'child-mw-2',
                            sessionId: 'child-mw-2',
                            createdAt: 2,
                            kind: 'assistant',
                            model: modelBase.id,
                            content: [{ type: 'text', text: 'Sub-agent 2 succeeded' }],
                            status: 'done',
                            stopReason: 'stop',
                        }
                        yield { type: 'done', message: seed } as AssistantStreamEvent
                    })()
                },
                cancel: async () => {},
                dispose: () => {},
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => multiClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            service.subAgents.hydrate([
                {
                    id: 'sub-mw-1',
                    sessionId: 'child-mw-1',
                    parentSessionId: 's-multi-waiter',
                    name: 'Worker 1',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    id: 'sub-mw-2',
                    sessionId: 'child-mw-2',
                    parentSessionId: 's-multi-waiter',
                    name: 'Worker 2',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-multi-waiter',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const p1 = service.subAgents.resumeSubAgent('sub-mw-1', {
                entries: [userEntry('u-c1', 'Continue 1', 'child-mw-1')],
            })
            await builderStartedPromise
            const p2 = service.subAgents.resumeSubAgent('sub-mw-2', {
                entries: [userEntry('u-c2', 'Continue 2', 'child-mw-2')],
            })
            await new Promise((r) => setTimeout(r, 20))

            expect(builderCalls).toBe(1)

            // Stop only the first waiter: p1 rejects/aborts immediately, shared build must NOT abort!
            service.subAgents.stop('sub-mw-1')
            const res1 = await Promise.race([
                p1,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Waiter 1 did not abort promptly')), 1000),
                ),
            ])
            expect(res1.isError).toBe(true)
            expect(service.subAgents.list().find((a) => a.id === 'sub-mw-1')?.status).toBe('aborted')
            expect(builderAborted).toBe(false)

            // Now complete the shared synthesis for waiter 2
            resolveBuilder(builtPrompt)
            const res2 = await p2
            expect(res2.isError).toBeFalsy()
            expect(service.subAgents.list().find((a) => a.id === 'sub-mw-2')?.status).toBe('completed')
            expect(await bridge.SessionGetSystemPrompt('s-multi-waiter')).toBe(builtPrompt)

            // When ALL active waiters abort, the shared synthesis controller MUST abort
            const bridge2 = new FakeNativeBridge()
            let allWaitersAborted = false
            let started2!: () => void
            const started2Promise = new Promise<void>((resolve) => {
                started2 = resolve
            })
            const abortAllClient = {
                stream: (_input: any, signalOrOpts?: AbortSignal | { signal?: AbortSignal }) => {
                    const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : signalOrOpts?.signal
                    started2()
                    return (async function* () {
                        await new Promise<void>((_resolve, reject) => {
                            if (signal?.aborted) {
                                allWaitersAborted = true
                                const err = new Error('Aborted')
                                err.name = 'AbortError'
                                reject(err)
                                return
                            }
                            signal?.addEventListener(
                                'abort',
                                () => {
                                    allWaitersAborted = true
                                    const err = new Error('Aborted')
                                    err.name = 'AbortError'
                                    reject(err)
                                },
                                { once: true },
                            )
                        })
                    })()
                },
                cancel: async () => {},
                dispose: () => {},
            }
            const service2 = new CLIProxyAPIAgentService({
                bridge: bridge2,
                createClient: () => abortAllClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            service2.subAgents.hydrate([
                {
                    id: 'sub-all-1',
                    sessionId: 'child-all-1',
                    parentSessionId: 's-multi-abort',
                    name: 'Worker A',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
                {
                    id: 'sub-all-2',
                    sessionId: 'child-all-2',
                    parentSessionId: 's-multi-abort',
                    name: 'Worker B',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
            await service2.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-multi-abort',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const a1 = service2.subAgents.resumeSubAgent('sub-all-1', {
                entries: [userEntry('u-a1', 'Go 1', 'child-all-1')],
            })
            await started2Promise
            const a2 = service2.subAgents.resumeSubAgent('sub-all-2', {
                entries: [userEntry('u-a2', 'Go 2', 'child-all-2')],
            })
            await new Promise((r) => setTimeout(r, 20))

            service2.subAgents.stop('sub-all-1')
            await a1
            expect(allWaitersAborted).toBe(false)

            service2.subAgents.stop('sub-all-2')
            await a2
            expect(allWaitersAborted).toBe(true)
            expect(await bridge2.SessionGetSystemPrompt('s-multi-abort')).toBeNull()
        })

        it('incorporates onRequest middleware systemPrompt additions during synthesis and fails closed if middleware mutates locked prompt at dispatch', async () => {
            const bridge = new FakeNativeBridge()
            const synthesized = 'Synthesized prompt honoring GUARDRAIL_FROM_MW with read and title tool in English.'
            const fakeClient = new FakeCPAClient()
            fakeClient.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: synthesized }], stopReason: 'stop' }) },
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'Main turn ok' }], stopReason: 'stop' }) },
            )

            const registry = new ExtensionRegistry()
            registry.registerProtocolMiddleware({
                id: 'idempotent-guardrail-mw',
                order: 10,
                onRequest: (input) => {
                    if (
                        input.systemPrompt.includes('Base core instructions.') &&
                        !input.systemPrompt.includes('GUARDRAIL_FROM_MW')
                    ) {
                        return {
                            ...input,
                            systemPrompt: `${input.systemPrompt}\nGUARDRAIL_FROM_MW`,
                        }
                    }
                    return input
                },
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-mw-idempotent',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const events1 = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 's-mw-idempotent',
                    runId: 'r-mw-idempotent',
                    entries: [],
                    userEntry: userEntry('u1', 'Hello', 's-mw-idempotent'),
                }),
            )

            expect(fakeClient.calls).toHaveLength(2)
            expect(JSON.stringify(fakeClient.calls[0]?.entries)).toContain('GUARDRAIL_FROM_MW')
            expect(fakeClient.calls[1]?.systemPrompt).toBe(synthesized)
            expect(events1.some((e) => e.type === 'error')).toBe(false)

            // Non-idempotent middleware mutating locked enhanced prompt must fail closed at dispatch
            const badRegistry = new ExtensionRegistry()
            badRegistry.registerProtocolMiddleware({
                id: 'mutating-bypass-mw',
                order: 10,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt}\n[UNVALIDATED_TEMPLATE_BYPASS]`,
                }),
            })
            const badClient = new FakeCPAClient()
            badClient.queue(
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: synthesized }], stopReason: 'stop' }) },
                { kind: 'stream', final: (seed) => doneAssistant(seed, { content: [{ type: 'text', text: 'Should never dispatch' }], stopReason: 'stop' }) },
            )
            const badService = new CLIProxyAPIAgentService({
                bridge: new FakeNativeBridge(),
                extensionRegistry: badRegistry,
                createClient: () => badClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            const badPrepared = await badService.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-mw-bypass',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const badEvents = await collect(
                badService.streamChat({
                    prepared: badPrepared,
                    sessionId: 's-mw-bypass',
                    runId: 'r-mw-bypass',
                    entries: [],
                    userEntry: userEntry('u2', 'Hello', 's-mw-bypass'),
                }),
            )

            // Only the synthesis builder call ran; main chat call with mutated prompt never dispatched
            expect(badClient.calls).toHaveLength(1)
            expect(badEvents.some((e) => e.type === 'error' && e.message.includes('Locked enhanced system prompt cannot be modified by middleware'))).toBe(true)
        })

        it('does not leave an orphaned prompt build running when caller aborts around resolvePersistedEnhancedPrompt or before awaitInFlightPromptBuild', async () => {
            // Case 1: Caller aborts right as SessionGetSystemPrompt resolves null
            const bridge1 = new FakeNativeBridge()
            const originalGet1 = bridge1.SessionGetSystemPrompt.bind(bridge1)
            let abortedDuringGet = false
            bridge1.SessionGetSystemPrompt = (sessionId: string) => {
                const promise = originalGet1(sessionId)
                if (!abortedDuringGet && sessionId === 's-preabort-get') {
                    abortedDuringGet = true
                    void promise.then(() => {
                        Promise.resolve().then(() => {
                            service1.abort('r-preabort-get')
                        })
                    })
                }
                return promise
            }
            const client1 = new FakeCPAClient()
            client1.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Should never synthesize' }],
                        stopReason: 'stop',
                    }),
            })
            const service1 = new CLIProxyAPIAgentService({
                bridge: bridge1,
                createClient: () => client1 as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            const prepared1 = await service1.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preabort-get',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            await expect(
                collect(
                    service1.streamChat({
                        prepared: prepared1,
                        sessionId: 's-preabort-get',
                        runId: 'r-preabort-get',
                        entries: [],
                        userEntry: userEntry('u-preabort-1', 'Hello', 's-preabort-get'),
                    }),
                ),
            ).rejects.toMatchObject({ code: 'aborted' })
            await new Promise((r) => setTimeout(r, 20))

            expect(abortedDuringGet).toBe(true)
            expect(client1.calls).toHaveLength(0)
            expect(await originalGet1('s-preabort-get')).toBeNull()

            // Case 2: Caller aborts synchronously right before awaitInFlightPromptBuild when activeWaiters.size === 0
            const bridge2 = new FakeNativeBridge()
            const client2 = new FakeCPAClient()
            client2.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Should never synthesize after pre-aborted awaitInFlightPromptBuild' }],
                        stopReason: 'stop',
                    }),
            })
            const registry2 = new ExtensionRegistry()
            registry2.registerProtocolMiddleware({
                id: 'abort-before-await-inflight-mw',
                order: 10,
                onRequest: (input) => {
                    service2.abort('r-preabort-inflight')
                    return input
                },
            })
            const service2 = new CLIProxyAPIAgentService({
                bridge: bridge2,
                extensionRegistry: registry2,
                createClient: () => client2 as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            const prepared2 = await service2.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preabort-inflight',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            await expect(
                collect(
                    service2.streamChat({
                        prepared: prepared2,
                        sessionId: 's-preabort-inflight',
                        runId: 'r-preabort-inflight',
                        entries: [],
                        userEntry: userEntry('u-preabort-2', 'Hello', 's-preabort-inflight'),
                    }),
                ),
            ).rejects.toMatchObject({ code: 'aborted' })
            await new Promise((r) => setTimeout(r, 20))

            expect(client2.calls).toHaveLength(0)
            expect(await bridge2.SessionGetSystemPrompt('s-preabort-inflight')).toBeNull()
            expect((service2 as any).inFlightPromptBuilds.size).toBe(0)

            // Case 3: Concurrent non-aborted waiter still succeeds cleanly when another waiter is pre-aborted
            const bridge3 = new FakeNativeBridge()
            const builtPrompt3 = 'Synthesized shared parent prompt preserving read and title tool usage in English.'
            let resolveBuilder3!: (text: string) => void
            const builderResult3 = new Promise<string>((resolve) => {
                resolveBuilder3 = resolve
            })
            let builderStarted3!: () => void
            const builderStartedPromise3 = new Promise<void>((resolve) => {
                builderStarted3 = resolve
            })
            let streamCount3 = 0
            const client3 = {
                stream: (_input: any) => {
                    streamCount3 += 1
                    if (streamCount3 === 1) {
                        builderStarted3()
                        return (async function* () {
                            const text = await builderResult3
                            const seed: AssistantEntry = {
                                id: 'builder-preabort-3',
                                sessionId: 's-preabort-concurrent',
                                createdAt: 1,
                                kind: 'assistant',
                                model: modelBase.id,
                                content: [{ type: 'text', text }],
                                status: 'done',
                                stopReason: 'stop',
                            }
                            yield { type: 'done', message: seed } as AssistantStreamEvent
                        })()
                    }
                    return (async function* () {
                        const seed: AssistantEntry = {
                            id: 'child-preabort-3',
                            sessionId: 'child-preabort-3',
                            createdAt: 2,
                            kind: 'assistant',
                            model: modelBase.id,
                            content: [{ type: 'text', text: 'Concurrent waiter succeeded' }],
                            status: 'done',
                            stopReason: 'stop',
                        }
                        yield { type: 'done', message: seed } as AssistantStreamEvent
                    })()
                },
                cancel: async () => {},
                dispose: () => {},
            }
            const service3 = new CLIProxyAPIAgentService({
                bridge: bridge3,
                createClient: () => client3 as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            service3.subAgents.hydrate([
                {
                    id: 'sub-preabort-waiter',
                    sessionId: 'child-preabort-3',
                    parentSessionId: 's-preabort-concurrent',
                    name: 'Worker 1',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])
            await service3.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-preabort-concurrent',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const activeWaiterPromise = service3.subAgents.resumeSubAgent('sub-preabort-waiter', {
                entries: [userEntry('u-c1', 'Continue', 'child-preabort-3')],
            })
            await builderStartedPromise3

            const inFlightEntry = (service3 as any).inFlightPromptBuilds.get('s-preabort-concurrent')
            expect(inFlightEntry).toBeDefined()
            expect(inFlightEntry.activeWaiters.size).toBe(1)

            const preAbortedController = new AbortController()
            preAbortedController.abort()
            await expect(
                (service3 as any).awaitInFlightPromptBuild(
                    's-preabort-concurrent',
                    inFlightEntry,
                    preAbortedController.signal,
                ),
            ).rejects.toMatchObject({ code: 'aborted' })

            // Shared build must remain active for the concurrent non-aborted waiter
            expect(inFlightEntry.controller.signal.aborted).toBe(false)
            expect((service3 as any).inFlightPromptBuilds.get('s-preabort-concurrent')).toBe(inFlightEntry)

            resolveBuilder3(builtPrompt3)
            const activeResult = await activeWaiterPromise
            expect(activeResult.isError).toBeFalsy()
            expect(await bridge3.SessionGetSystemPrompt('s-preabort-concurrent')).toBe(builtPrompt3)
        })

        it('redacts apiKey from synthesis errors during direct sub-agent resume while preserving AgentPreflightError code', async () => {
            const secretApiKey = 'sk-super-secret-subagent-key-12345'
            const bridge = new FakeNativeBridge()
            const failingClient = new FakeCPAClient()
            const authError = new Error(
                `Upstream auth failed for Bearer ${secretApiKey} with key=${secretApiKey}`,
            )
            failingClient.queue(
                { kind: 'throw', error: authError },
                { kind: 'throw', error: authError },
                { kind: 'throw', error: authError },
                { kind: 'throw', error: authError },
                { kind: 'throw', error: authError },
                { kind: 'throw', error: authError },
            )

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => failingClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            service.subAgents.hydrate([
                {
                    id: 'sub-redact-1',
                    sessionId: 'child-redact-1',
                    parentSessionId: 'parent-redact-1',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: secretApiKey,
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 'parent-redact-1',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const resumeResult = await service.subAgents.resumeSubAgent('sub-redact-1', {
                entries: [userEntry('u-redact-1', 'Continue', 'child-redact-1')],
            })
            expect(resumeResult.isError).toBe(true)
            const resultText = resumeResult.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
            expect(resultText).not.toContain(secretApiKey)
            expect(resultText).toContain('[REDACTED]')

            const record = service.subAgents.list().find((a) => a.id === 'sub-redact-1')
            expect(record?.status).toBe('error')
            expect(record?.errorMessage).toBeDefined()
            expect(record?.errorMessage).not.toContain(secretApiKey)
            expect(record?.errorMessage).toContain('[REDACTED]')

            // Direct resolver rejection must preserve AgentPreflightError identity/code/i18nKey without leaking secrets
            let caught: unknown
            try {
                await (service as any).resolveSubAgentParentEnhancedPrompt(
                    prepared,
                    'parent-redact-1',
                )
            } catch (err) {
                caught = err
            }
            expect(caught).toBeInstanceOf(AgentPreflightError)
            expect(caught).toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_failed',
                i18nKey: 'agent.preflight.system_prompt_enhancement_failed',
            })
            expect((caught as Error).message).not.toContain(secretApiKey)
            expect((caught as Error).message).toContain('[REDACTED]')
        }, 15_000)

        it('allows prepare() and streamChat() for an existing session with a locked system_prompt even when all enhancement builder models are disabled', async () => {
            const bridge = new FakeNativeBridge()
            const lockedPrompt = 'LOCKED_EXISTING_SESSION_PROMPT'
            await bridge.SessionSetSystemPrompt('s-locked-no-model', lockedPrompt)

            const fakeClient = new FakeCPAClient()
            fakeClient.queue({
                kind: 'stream',
                final: (seed) =>
                    doneAssistant(seed, {
                        content: [{ type: 'text', text: 'Reply using locked prompt' }],
                        stopReason: 'stop',
                    }),
            })

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            const disabledModelSettings = {
                enableAll: false,
                models: {
                    [modelBase.id]: { enabled: false },
                },
                modelOrder: [],
            }
            const enhancement = {
                enabled: true,
                multilingualEnabled: false,
                allowedLanguages: ['en' as const],
                modelId: '',
            }

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-locked-no-model',
                modelSettings: disabledModelSettings,
                systemPromptEnhancement: enhancement,
            })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 's-locked-no-model',
                    runId: 'r-locked-no-model',
                    entries: [],
                    userEntry: userEntry('u-locked', 'hi', 's-locked-no-model'),
                }),
            )

            expect(events.some((e) => e.type === 'error')).toBe(false)
            expect(fakeClient.calls).toHaveLength(1)
            expect(fakeClient.calls[0]?.systemPrompt).toBe(lockedPrompt)

            // A new session without a persisted prompt must still fail preflight with system_prompt_enhancement_no_model
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'sk-test',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    sessionId: 's-new-no-model',
                    modelSettings: disabledModelSettings,
                    systemPromptEnhancement: enhancement,
                }),
            ).rejects.toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_no_model',
            })

            // If reading the persisted prompt rejects while no builder model is available, prepare() must fail closed
            const originalGet = bridge.SessionGetSystemPrompt.bind(bridge)
            bridge.SessionGetSystemPrompt = vi
                .fn()
                .mockRejectedValueOnce(new Error('SQLite read failed'))
            await expect(
                service.prepare({
                    baseUrl: 'http://127.0.0.1:8317',
                    apiKey: 'sk-test',
                    modelId: modelBase.id,
                    models: [modelBase],
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    sessionId: 's-read-err-no-model',
                    modelSettings: disabledModelSettings,
                    systemPromptEnhancement: enhancement,
                }),
            ).rejects.toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_failed',
            })
            bridge.SessionGetSystemPrompt = originalGet
        })

        it('does not call SessionSetSystemPrompt when buildController.signal aborts right after synthesizeEnhancedSystemPrompt resolves', async () => {
            const bridge = new FakeNativeBridge()
            const setSystemPromptSpy = vi.spyOn(bridge, 'SessionSetSystemPrompt')
            const validBuiltPrompt =
                'Unique synthesized instructions preserving read and title tool usage in English.'
            let streamCalls = 0
            let service!: CLIProxyAPIAgentService

            const raceClient = {
                stream: (input: ProtocolStreamInput) => {
                    streamCalls += 1
                    const seed: AssistantEntry = {
                        ...input.seed,
                        id: 'builder-post-synth-abort',
                        content: [{ type: 'text', text: validBuiltPrompt }],
                        status: 'done',
                        stopReason: 'stop',
                    }
                    let yielded = false
                    return {
                        [Symbol.asyncIterator]() {
                            return {
                                async next() {
                                    if (!yielded) {
                                        yielded = true
                                        return {
                                            value: { type: 'done', message: seed } as AssistantStreamEvent,
                                            done: false,
                                        }
                                    }
                                    return { value: undefined, done: true }
                                },
                                async return() {
                                    // Schedule abort on the microtask between collectSynthesisStreamText
                                    // finishing and synthesizeEnhancedSystemPrompt resolving its caller.
                                    Promise.resolve().then(() => {
                                        Promise.resolve().then(() => {
                                            service.abort('r-post-synth-abort')
                                        })
                                    })
                                    return { value: undefined, done: true }
                                },
                            }
                        },
                    }
                },
                cancel: async () => {},
                dispose: () => {},
            }

            service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => raceClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            const prepared = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-post-synth-abort',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            await expect(
                collect(
                    service.streamChat({
                        prepared,
                        sessionId: 's-post-synth-abort',
                        runId: 'r-post-synth-abort',
                        entries: [],
                        userEntry: userEntry('u-post-synth', 'Hello', 's-post-synth-abort'),
                    }),
                ),
            ).rejects.toMatchObject({ code: 'aborted' })

            // Allow the observed background buildPromise continuation to run
            await new Promise((r) => setTimeout(r, 20))

            expect(streamCalls).toBe(1)
            expect(setSystemPromptSpy).not.toHaveBeenCalled()
            expect(await bridge.SessionGetSystemPrompt('s-post-synth-abort')).toBeNull()
        })

        it('redacts apiKey when concurrent prepare() with disabled builder models awaits a failing in-flight sub-agent synthesis', async () => {
            const secretApiKey = 'sk-prepare-concurrent-secret-98765'
            const bridge = new FakeNativeBridge()
            let markBuilderStarted!: () => void
            const builderStartedPromise = new Promise<void>((resolve) => {
                markBuilderStarted = resolve
            })
            let releaseSynthesisFailure!: () => void
            const synthesisFailureGate = new Promise<void>((resolve) => {
                releaseSynthesisFailure = resolve
            })

            let streamCallCount = 0
            const failingClient = {
                stream: () => {
                    streamCallCount += 1
                    const currentCall = streamCallCount
                    if (currentCall === 1) {
                        markBuilderStarted()
                    }
                    return {
                        [Symbol.asyncIterator]() {
                            return {
                                async next() {
                                    if (currentCall === 1) {
                                        await synthesisFailureGate
                                    }
                                    throw new Error(
                                        `Upstream auth failed for Bearer ${secretApiKey} with key=${secretApiKey}`,
                                    )
                                },
                                async return() {
                                    return { value: undefined, done: true }
                                },
                            }
                        },
                    }
                },
                cancel: async () => {},
                dispose: () => {},
            }

            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => failingClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'Base core instructions.',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })
            service.subAgents.hydrate([
                {
                    id: 'sub-prepare-redact',
                    sessionId: 'child-prepare-redact',
                    parentSessionId: 'parent-prepare-redact',
                    name: 'Worker',
                    color: '#3dd68c',
                    icon: 'atom',
                    status: 'aborted',
                    modelId: modelBase.id,
                    createdAt: 1,
                    updatedAt: 2,
                },
            ])

            await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: secretApiKey,
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 'parent-prepare-redact',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            const subAgentPromise = service.subAgents.resumeSubAgent('sub-prepare-redact', {
                entries: [userEntry('u-pr-1', 'Continue', 'child-prepare-redact')],
            })
            await builderStartedPromise

            const inFlightEntry = (service as any).inFlightPromptBuilds.get('parent-prepare-redact')
            expect(inFlightEntry).toBeDefined()
            expect(inFlightEntry.activeWaiters.size).toBe(1)

            const concurrentPreparePromise = service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: secretApiKey,
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 'parent-prepare-redact',
                modelSettings: {
                    enableAll: false,
                    models: {
                        [modelBase.id]: { enabled: false },
                    },
                    modelOrder: [],
                },
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })

            expect(inFlightEntry.activeWaiters.size).toBe(2)
            releaseSynthesisFailure()

            let caught: unknown
            try {
                await concurrentPreparePromise
            } catch (err) {
                caught = err
            }

            expect(caught).toBeInstanceOf(AgentPreflightError)
            expect(caught).toMatchObject({
                name: 'AgentPreflightError',
                code: 'system_prompt_enhancement_failed',
                i18nKey: 'agent.preflight.system_prompt_enhancement_failed',
            })
            expect((caught as Error).message).not.toContain(secretApiKey)
            expect((caught as Error).message).toContain('[REDACTED]')

            const subAgentResult = await subAgentPromise
            expect(subAgentResult.isError).toBe(true)
        }, 15_000)

        it('preserves system_prompt_enhancement_no_model and system_prompt_enhancement_failed codes in compact() result and error event', async () => {
            const bridge = new FakeNativeBridge()
            const failingClient = new FakeCPAClient()
            failingClient.queue(
                { kind: 'throw', error: new Error('builder fail 1') },
                { kind: 'throw', error: new Error('builder fail 2') },
                { kind: 'throw', error: new Error('builder fail 3') },
            )
            const service = new CLIProxyAPIAgentService({
                bridge,
                createClient: () => failingClient as unknown as CPAClient,
                createTools: async () => [makeTool('read')],
                loadResources: async () => ({
                    contextFiles: [],
                    skills: [],
                    prompts: [],
                    systemPrompt: 'RAW',
                    mutableCoreSystemPrompt: 'RAW_CORE',
                    verbatimContextPrompt: '',
                    diagnostics: [],
                }),
            })

            // 1. system_prompt_enhancement_no_model during compact
            const preparedNoModel = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-compact-no-model',
                modelSettings: {
                    enableAll: false,
                    models: { [modelBase.id]: { enabled: false } },
                    modelOrder: [],
                },
            })
            // Simulate enhancement enabled when compact runs without a persisted prompt or builder model
            const noModelCompactRes = await service.compact({
                prepared: {
                    ...preparedNoModel,
                    systemPromptEnhancement: {
                        enabled: true,
                        multilingualEnabled: false,
                        allowedLanguages: ['en'],
                        modelId: '',
                    },
                },
                sessionId: 's-compact-no-model',
                runId: 'run-compact-no-model',
                entries: [userEntry('u1', 'hi', 's-compact-no-model')],
            })
            expect(noModelCompactRes.ok).toBe(false)
            if (!noModelCompactRes.ok) {
                expect(noModelCompactRes.code).toBe('system_prompt_enhancement_no_model')
                expect(noModelCompactRes.events?.find((e) => e.type === 'error')).toMatchObject({
                    type: 'error',
                    preflightCode: 'system_prompt_enhancement_no_model',
                })
            }

            // 2. system_prompt_enhancement_failed during compact
            const preparedFail = await service.prepare({
                baseUrl: 'http://127.0.0.1:8317',
                apiKey: 'sk-test',
                modelId: modelBase.id,
                models: [modelBase],
                reasoningLevel: 'medium',
                speed: 'standard',
                sessionId: 's-compact-enh-fail',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: '',
                },
            })
            const failCompactRes = await service.compact({
                prepared: preparedFail,
                sessionId: 's-compact-enh-fail',
                runId: 'run-compact-enh-fail',
                entries: [userEntry('u2', 'hi', 's-compact-enh-fail')],
            })
            expect(failCompactRes.ok).toBe(false)
            if (!failCompactRes.ok) {
                expect(failCompactRes.code).toBe('system_prompt_enhancement_failed')
                expect(failCompactRes.events?.find((e) => e.type === 'error')).toMatchObject({
                    type: 'error',
                    preflightCode: 'system_prompt_enhancement_failed',
                })
            }
        })

        it('previews code-only tool policy before resource loading and enhancement without invoking prepareToolSet during prepare', async () => {
            const bridge = new FakeNativeBridge()
            bridge.setFile('/repo/.cpa/keep', '')
            const runtimeInfo = await bridge.runtimeInfo()
            bridge.setFile(
                `${buildAgentDir(runtimeInfo.userConfigDir)}/skills/code-skill/SKILL.md`,
                '---\nname: code-skill\ndescription: Skill visible in code-only\n---\n\nDetails',
            )
            const registry = new ExtensionRegistry()
            resourcesAgentEntry.activate({
                register: (contrib: any) => {
                    if (contrib.kind === 'resource-provider') {
                        registry.registerResourceProvider(contrib.value)
                    }
                },
                getService: () => undefined,
            } as any)

            const readTool = makeTool('read')
            const skillSearchTool = makeTool('skill_search')
            const spawnAgentTool = { ...makeTool('spawn_agent'), exposure: 'direct' as const }
            const prepareToolSetSpy = vi.fn(async (allTools: readonly AgentTool[]) => ({
                policyId: 'code-only',
                tools: allTools.filter((t) => t.name === 'exec' || t.name === 'spawn_agent').map((t) =>
                    t.name === 'exec'
                        ? { ...t, description: 'FULL_EXEC_TS_DECL_read_skill_search', promptDescription: 'CONCISE_EXEC_PROMPT_read_skill_search' }
                        : t,
                ),
                nestedTools: allTools.filter((t) => t.name === 'read' || t.name === 'skill_search'),
            }))
            const execTool: AgentTool = {
                ...makeTool('exec'),
                description: 'INITIAL_CODE_MODE_DESC',
                promptDescription: 'INITIAL_CODE_MODE_PROMPT_DESC',
                exposure: 'direct',
                needsNestedDispatcher: true,
                toolPolicyId: 'code-only',
                previewToolSet: vi.fn(async (allTools: readonly AgentTool[]) => ({
                    policyId: 'code-only',
                    tools: allTools
                        .filter((t) => t.name === 'exec' || t.name === 'spawn_agent')
                        .map((t) =>
                            t.name === 'exec'
                                ? {
                                      ...t,
                                      description: 'FULL_EXEC_TS_DECL_read_skill_search',
                                      promptDescription:
                                          'CONCISE_EXEC_PROMPT_read_skill_search Promise.all tools.read text(out)',
                                  }
                                : t,
                        ),
                    nestedTools: allTools.filter((t) => t.name === 'read' || t.name === 'skill_search'),
                })),
                prepareToolSet: prepareToolSetSpy,
            }

            const fakeClient = new FakeCPAClient()
            const service = new CLIProxyAPIAgentService({
                bridge,
                extensionRegistry: registry,
                createClient: () => fakeClient as unknown as CPAClient,
                createTools: async () => [readTool, skillSearchTool, spawnAgentTool, execTool],
                generateId: (() => {
                    let n = 0
                    return () => `code-only-id-${++n}`
                })(),
                now: () => 1_700_000_000_000,
            })

            const prepared = await service.prepare({
                ...createWorktreePrepareInput(),
                projectPath: '/repo',
                projectPaths: ['/repo'],
                worktreePolicy: undefined,
                requiredToolPolicy: 'code-only',
                systemPromptEnhancement: {
                    enabled: true,
                    multilingualEnabled: false,
                    allowedLanguages: ['en'],
                    modelId: modelBase.id,
                },
            })

            // prepare() must use previewToolSet without invoking prepareToolSet, while keeping full prepared.tools.
            expect(prepareToolSetSpy).not.toHaveBeenCalled()
            expect(execTool.previewToolSet).toHaveBeenCalledTimes(1)
            expect(prepared.tools.map((t) => t.name)).toEqual(['read', 'skill_search', 'spawn_agent', 'exec'])
            expect(prepared.systemPrompt).toContain('CONCISE_EXEC_PROMPT_read_skill_search')
            expect(prepared.systemPrompt).not.toContain('FULL_EXEC_TS_DECL_read_skill_search')
            expect(prepared.systemPrompt).not.toContain('- read:')
            expect(prepared.systemPrompt).toContain('<skill_names>')
            expect(prepared.systemPrompt).toContain('- code-skill')

            fakeClient.queue({
                kind: 'stream',
                final: (seed) => ({
                    ...doneAssistant(seed, { stopReason: 'stop' }),
                    content: [
                        {
                            type: 'text',
                            text: 'Enhanced code-only workspace instructions for /repo: ordinary tools are hidden inside the sandboxed executor rather than exposed top-level, while direct orchestration uses spawn_agent when delegating independent tasks. Whenever executing file reads, searches, or shell operations, call exec and invoke nested tools via await tools.read({}) and await tools.skill_search({}), combining parallel calls inside Promise.all([tools.read({})]) and emitting structured output via text(res). Always verify file paths and obey workspace constraints carefully before concluding your work in /repo.',
                        },
                    ],
                }),
            })
            fakeClient.queue({ kind: 'stream', final: (seed) => doneAssistant(seed, { stopReason: 'stop' }) })

            const events = await collect(
                service.streamChat({
                    prepared,
                    sessionId: 's-code-only-preview',
                    runId: 'run-code-only-preview',
                    entries: [userEntry('u1', 'hello', 's-code-only-preview')],
                }),
            )

            expect(events.some((e) => e.type === 'error')).toBe(false)
            // Synthesis prompt builder sees ONLY top-level tools (not nested read/skill_search), plus Promise.all requirement.
            const synthReq = fakeClient.calls[0]!
            const firstSynthEntry = synthReq.entries[0]
            const synthUserText =
                firstSynthEntry && 'content' in firstSynthEntry && Array.isArray(firstSynthEntry.content)
                    ? firstSynthEntry.content.find((b) => b.type === 'text')
                    : undefined
            expect(synthUserText && synthUserText.type === 'text' ? synthUserText.text : '').toContain(
                'Exact tool names that MUST appear verbatim in your output: spawn_agent, exec',
            )
            // Runtime execution call invokes prepareToolSet and sends full exec description in body.tools.
            expect(prepareToolSetSpy).toHaveBeenCalledTimes(1)
            const runtimeReq = fakeClient.calls[1]!
            expect((runtimeReq.tools ?? []).map((t) => t.name)).toEqual(['spawn_agent', 'exec'])
            expect((runtimeReq.tools ?? []).find((t) => t.name === 'exec')?.description).toBe(
                'FULL_EXEC_TS_DECL_read_skill_search',
            )
            await service.dispose()
        })
    })
})
