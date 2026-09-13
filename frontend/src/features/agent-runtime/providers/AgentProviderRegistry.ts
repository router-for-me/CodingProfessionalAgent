/**
 * AgentProviderRegistry: unified provider orchestration and generation snapshot factory.
 * Freezes tools, resources, hooks, middleware, protocol session, and model provider
 * under a protected PluginGenerationLease for deterministic Agent runs.
 */

import type {
    AgentTool,
    HookContribution,
    ModelCatalogEntry,
    ModelCatalogProviderContribution,
    ProtocolMiddleware,
    ProtocolProviderContribution,
    ProtocolSession,
    ProtocolSessionContext,
} from '@cpa/plugin-api'
import type { PluginGenerationLease } from '@cpa/plugin-kernel'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    type RendererPluginRuntimeHost,
} from '@/plugins/platform/RendererPluginRuntimeHost'
import {
    agentRegistry,
    agentPluginRuntime,
    type AgentPluginRuntimeHost,
} from '@/plugins/platform/AgentPluginRuntimeHost'
import type { AgentPrepareInput } from '@/features/agent/types'
import type { NativeBridge } from '../native/types'
import type { WorktreeRunPolicy } from '../context/worktreeMode'
import {
    inferDefaultModelCapabilities,
} from './ModelCatalogProvider'
import {
    createToolsFromProviders,
    type CreateToolsFromProvidersOptions,
} from './ToolFactoryProvider'
import {
    loadResourcesFromProviders,
    type ResourceSnapshot,
} from './ResourceProvider'
import type {
    AgentGenerationSnapshot,
} from './generationSnapshot'

export interface AgentProviderRegistryOptions {
    extensionRegistry?: RendererRegistry
    pluginRuntime?: AgentPluginRuntimeHost | RendererPluginRuntimeHost | {
        readonly generation?: number
        acquireGeneration?: (pluginIds?: readonly string[]) => PluginGenerationLease
    }
    bridge?: NativeBridge
    createClient?: (options: any) => ProtocolSession
    createTools?: (
        cwd: string | undefined | null,
        bridge: NativeBridge,
        model: ModelCatalogEntry,
        options?: CreateToolsFromProvidersOptions
    ) => Promise<AgentTool[]>
    loadResources?: (input: any) => Promise<ResourceSnapshot>
}

export interface CreateSnapshotOptions {
    bridge?: NativeBridge
    platform?: string
    model?: ModelCatalogEntry
    worktreePolicy?: WorktreeRunPolicy
    tools?: readonly AgentTool[]
    resources?: ResourceSnapshot
    sessionContext?: Partial<ProtocolSessionContext>
    lease?: PluginGenerationLease
    protocolSession?: ProtocolSession
    hooks?: readonly HookContribution[]
    middleware?: readonly ProtocolMiddleware[]
    modelProvider?: ModelCatalogProviderContribution
}

/**
 * Creates a standalone fallback lease when no PluginRuntime host is active.
 */
function createStandaloneLease(generation = 0, pluginIds: readonly string[] = []): PluginGenerationLease {
    let released = false
    return {
        generation,
        pluginIds: Object.freeze([...pluginIds]),
        get released() {
            return released
        },
        release() {
            released = true
        },
    }
}

/**
 * Registry and snapshot coordinator for all agent runtime providers.
 */
export class AgentProviderRegistry {
    readonly extensionRegistry: RendererRegistry
    private readonly pluginRuntime?: RendererPluginRuntimeHost | {
        readonly generation?: number
        acquireGeneration?: (pluginIds?: readonly string[]) => PluginGenerationLease
    }
    private readonly bridge?: NativeBridge
    private readonly createClient?: (options: any) => ProtocolSession
    private readonly customCreateTools?: (
        cwd: string | undefined | null,
        bridge: NativeBridge,
        model: ModelCatalogEntry,
        options?: CreateToolsFromProvidersOptions
    ) => Promise<AgentTool[]>
    private readonly customLoadResources?: (input: any) => Promise<ResourceSnapshot>

    constructor(options: AgentProviderRegistryOptions = {}) {
        this.extensionRegistry = options.extensionRegistry ?? agentRegistry
        this.pluginRuntime = options.pluginRuntime ?? agentPluginRuntime
        this.bridge = options.bridge
        this.createClient = options.createClient
        this.customCreateTools = options.createTools
        this.customLoadResources = options.loadResources
    }

    /**
     * Get current plugin runtime generation number.
     */
    getGeneration(): number {
        if (this.pluginRuntime) {
            if (typeof (this.pluginRuntime as any).getGeneration === 'function') {
                return (this.pluginRuntime as any).getGeneration()
            }
            if (typeof (this.pluginRuntime as any).generation === 'number') {
                return (this.pluginRuntime as any).generation
            }
        }
        return 0
    }

    /**
     * Acquire a lease on the current runtime generation.
     */
    acquireLease(pluginIds?: readonly string[]): PluginGenerationLease {
        if (this.pluginRuntime && typeof this.pluginRuntime.acquireGeneration === 'function') {
            return this.pluginRuntime.acquireGeneration(pluginIds)
        }
        return createStandaloneLease(this.getGeneration(), pluginIds ?? [])
    }

    /**
     * Freeze all runtime providers into an immutable AgentGenerationSnapshot.
     */
    async createSnapshot(
        input: AgentPrepareInput,
        options: CreateSnapshotOptions = {}
    ): Promise<AgentGenerationSnapshot> {
        const lease = options.lease ?? this.acquireLease()
        const generation = lease.generation ?? this.getGeneration()

        // 1. Model Catalog Provider
        const modelProvider =
            options.modelProvider ??
            (this.extensionRegistry.getModelCatalogProvider() as unknown as ModelCatalogProviderContribution) ??
            (rendererRegistry.getModelCatalogProvider() as unknown as ModelCatalogProviderContribution) ??
            {
                id: 'cpa.models.default',
                fetchCatalog: async () => input.models,
                getModelCapabilities: (m: ModelCatalogEntry) => inferDefaultModelCapabilities(m),
            }

        const model =
            options.model ??
            input.models.find((m) => m.id === input.modelId) ?? {
                id: input.modelId,
                label: input.modelId,
                supportsFast: true,
                reasoningLevels: [],
                input: ['text', 'image'],
                contextWindow: 128_000,
                maxTokens: 8_192,
            }

        // 2. Protocol Session
        let protocolSession = options.protocolSession
        let protocolProvider: ProtocolProviderContribution | undefined

        if (!protocolSession) {
            protocolProvider = this.extensionRegistry.getProtocolProvider(input.protocolProviderId) as unknown as ProtocolProviderContribution | undefined

            const sessionCtx: ProtocolSessionContext = {
                apiKey: input.apiKey,
                baseUrl: input.baseUrl,
                sessionId: input.sessionId ?? 'default-session',
                bridge: options.bridge ?? this.bridge,
                ...options.sessionContext,
            }

            if (protocolProvider) {
                const targetProvider = protocolProvider
                const createClientFn = this.createClient
                protocolSession = {
                    id: targetProvider.id,
                    stream: async function* (streamInput, streamOpts) {
                        let activeSession: ProtocolSession
                        if (options.protocolSession) {
                            activeSession = options.protocolSession
                        } else if (typeof targetProvider.createSession === 'function') {
                            activeSession = await targetProvider.createSession(sessionCtx)
                        } else if (typeof targetProvider.createClient === 'function') {
                            activeSession = (await targetProvider.createClient(sessionCtx)) as unknown as ProtocolSession
                        } else if (createClientFn) {
                            activeSession = createClientFn({ ...sessionCtx, protocolProviderId: targetProvider.id })
                        } else {
                            throw new Error(`Protocol provider "${targetProvider.id}" cannot create session`)
                        }
                        for await (const ev of activeSession.stream(streamInput, streamOpts)) {
                            yield ev
                        }
                    },
                    cancel: async () => {},
                    dispose: () => {},
                }
            } else if (this.createClient) {
                const createClientFn = this.createClient
                protocolSession = {
                    id: 'injected-client',
                    stream: async function* (streamInput, streamOpts) {
                        const activeSession = createClientFn(sessionCtx)
                        for await (const ev of activeSession.stream(streamInput, streamOpts)) {
                            yield ev
                        }
                    },
                    cancel: async () => {},
                    dispose: () => {},
                }
            }
        }

        if (!protocolSession) {
            throw new Error(`No protocol provider available for "${input.protocolProviderId ?? 'default'}"`)
        }

        // 3. Hooks Snapshot
        const hooks = Object.freeze(
            options.hooks
                ? [...options.hooks]
                : [...this.extensionRegistry.getHookContributions()]
        )

        // 4. Middlewares Snapshot
        const middleware = Object.freeze(
            options.middleware
                ? [...options.middleware]
                : [...this.extensionRegistry.getProtocolMiddlewares()]
        )

        // 5. Tools Snapshot
        let tools: readonly AgentTool[]
        if (options.tools) {
            tools = Object.freeze([...options.tools])
        } else {
            const bridge = options.bridge ?? this.bridge
            const cwd = input.projectPath ?? undefined

            let createdTools: AgentTool[] = []
            if (this.customCreateTools && bridge) {
                createdTools = await this.customCreateTools(cwd, bridge, model, {
                    extensionRegistry: this.extensionRegistry,
                    scheduleId: input.scheduleId,
                    sessionId: input.sessionId,
                    worktreePolicy: options.worktreePolicy,
                    models: input.models,
                })
            } else if (cwd && bridge) {
                createdTools = await createToolsFromProviders({
                    cwd,
                    bridge,
                    model,
                    platform: options.platform,
                    worktreePolicy: options.worktreePolicy,
                    extensionRegistry: this.extensionRegistry,
                    scheduleId: input.scheduleId,
                    sessionId: input.sessionId,
                    models: input.models,
                })
            }
            tools = Object.freeze(createdTools.filter((t) => t.targetAgent !== 'subagent'))
        }

        // 6. Resources Snapshot
        let resources: ResourceSnapshot
        if (options.resources) {
            resources = options.resources
        } else {
            const bridge = options.bridge ?? this.bridge
            if (this.customLoadResources) {
                resources = await this.customLoadResources({
                    cwd: input.projectPath ?? undefined,
                    projectPaths: input.projectPaths ?? [],
                    agentDir: '',
                    bridge,
                    tools: tools.map((t) => ({ name: t.name, description: t.description })),
                    language: input.language,
                    personality: input.personality,
                    localMemoryEnabled: input.localMemoryEnabled,
                    extensionRegistry: this.extensionRegistry,
                    worktreePolicy: options.worktreePolicy,
                    subagentsSettings: input.subagentsSettings,
                })
            } else if (bridge) {
                resources = await loadResourcesFromProviders({
                    cwd: input.projectPath ?? undefined,
                    projectPaths: input.projectPaths ?? (input.projectPath ? [input.projectPath] : []),
                    agentDir: '/default-agent-dir',
                    bridge,
                    tools: tools.map((t) => ({ name: t.name, description: t.description })),
                    language: input.language,
                    personality: input.personality,
                    localMemoryEnabled: input.localMemoryEnabled,
                    extensionRegistry: this.extensionRegistry,
                    worktreePolicy: options.worktreePolicy,
                    sessionId: input.sessionId ?? undefined,
                    subagentsSettings: input.subagentsSettings,
                })
            } else {
                resources = Object.freeze({
                    contextFiles: Object.freeze([]),
                    skills: Object.freeze([]),
                    prompts: Object.freeze([]),
                    systemPrompt: '',
                    diagnostics: Object.freeze([]),
                })
            }
        }

        // 7. Collect All Provider IDs
        const ids = new Set<string>()

        // Plugin IDs from lease
        for (const pid of lease.pluginIds) {
            ids.add(pid)
        }

        // Tool factory IDs & tool names
        for (const tool of tools) {
            ids.add(tool.name)
        }
        for (const factory of this.extensionRegistry.getToolFactories()) {
            ids.add(factory.id)
        }

        // Resource provider IDs
        for (const res of this.extensionRegistry.getResourceProviders()) {
            ids.add(res.id)
        }

        // Hook contribution IDs
        for (const hook of hooks) {
            ids.add(hook.id)
        }

        // Protocol provider ID
        if (protocolProvider?.id) {
            ids.add(protocolProvider.id)
        }

        // Middleware IDs
        for (const mw of middleware) {
            ids.add(mw.id)
        }

        // Model provider ID
        if (modelProvider?.id) {
            ids.add(modelProvider.id)
        }

        const providerIds = Object.freeze(Array.from(ids).sort())

        const models = Object.freeze(input.models.map((entry) => Object.freeze({
            ...entry,
            reasoningLevels: Object.freeze(entry.reasoningLevels.map((level) => Object.freeze({ ...level }))),
            input: Object.freeze([...entry.input]),
            ...(entry.cpaCapabilities
                ? { cpaCapabilities: Object.freeze({ ...entry.cpaCapabilities }) }
                : {}),
        })))
        const snapshot: AgentGenerationSnapshot = Object.freeze({
            generation,
            lease,
            tools,
            resources,
            hooks,
            protocolSession,
            protocolProvider,
            models,
            middleware,
            modelProvider,
            providerIds,
        })

        return snapshot
    }
}
