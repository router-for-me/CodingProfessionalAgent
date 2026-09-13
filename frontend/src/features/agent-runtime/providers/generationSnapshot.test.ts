import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    AssistantEntry,
    AssistantStreamEvent,
    HookResult,
    ModelCatalogEntry,
    ModelCatalogProviderContribution,
    ProtocolProviderContribution,
    ProtocolSession,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import {
    RendererRegistry as ExtensionRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    createRendererRuntimeHost,
    type RendererPluginRuntimeHost,
} from '@/plugins/platform/RendererPluginRuntimeHost'
import { FakeNativeBridge } from '../native/fakeNativeBridge'
import { CLIProxyAPIAgentService } from '../CLIProxyAPIAgentService'
import type { AgentPrepareInput } from '@/features/agent/types'
import {
    AgentProviderRegistry,
} from './AgentProviderRegistry'
import {
    collectProviderIds,
} from './generationSnapshot'
import { AgentLoop } from '../agent/agentLoop'

const modelBase: ModelCatalogEntry = {
    id: 'test-model',
    label: 'Test Model',
    supportsFast: true,
    reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
    input: ['text', 'image'],
    contextWindow: 128_000,
    maxTokens: 8_192,
}

const mockAssistantSeed: AssistantEntry = {
    id: 'asst-1',
    sessionId: 'sess-test',
    createdAt: 1,
    kind: 'assistant',
    status: 'streaming',
    stopReason: 'pending',
    content: [],
}

class TestProtocolClient implements ProtocolSession {
    readonly calls: ProtocolStreamInput[] = []
    disposed = false
    cancelled = false

    async *stream(
        input: ProtocolStreamInput,
        _options?: ProtocolStreamOptions,
    ): AsyncGenerator<AssistantStreamEvent, AssistantEntry> {
        this.calls.push(input)
        yield {
            type: 'text-delta',
            contentIndex: 0,
            delta: 'Hello from test protocol',
            partial: mockAssistantSeed,
        }
        return {
            ...mockAssistantSeed,
            status: 'done',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Hello from test protocol' }],
        }
    }

    async cancel(_reason?: string): Promise<void> {
        this.cancelled = true
    }

    dispose(): void {
        this.disposed = true
    }
}

describe('AgentGenerationSnapshot & AgentProviderRegistry', () => {
    let bridge: FakeNativeBridge
    let extensionRegistry: ExtensionRegistry
    let pluginRuntime: RendererPluginRuntimeHost
    let testClient: TestProtocolClient

    beforeEach(async () => {
        bridge = new FakeNativeBridge()
        await bridge.mkdirAll('/test-user/coding-professional-agent/agent/skills')
        await bridge.mkdirAll('/test-user/coding-professional-agent/agent/prompts')
        await bridge.mkdirAll('/test-project')

        pluginRuntime = createRendererRuntimeHost()
        extensionRegistry = pluginRuntime.registry
        testClient = new TestProtocolClient()

        // Register default protocol provider
        const protocolProvider: ProtocolProviderContribution = {
            id: 'test-protocol',
            name: 'Test Protocol',
            isDefault: true,
            createSession: () => testClient,
            createClient: () => testClient as any,
        }
        extensionRegistry.registerProtocolProvider(protocolProvider)

        // Register default model catalog provider
        const modelCatalogProvider: ModelCatalogProviderContribution = {
            id: 'test-catalog-provider',
            protocolProviderId: 'test-protocol',
            fetchCatalog: async () => [modelBase],
            getModelCapabilities: () => ({
                supportsImages: true,
                supportsFast: true,
                reasoningLevels: ['medium'],
                contextWindow: 128_000,
                maxOutputTokens: 8_192,
            }),
        }
        extensionRegistry.registerModelCatalogProvider(modelCatalogProvider)
    })

    it('keeps every provider from the prepared generation until the run completes', async () => {
        // Register tooling plugin contributions
        const dynamicToolDisposer = extensionRegistry.registerToolFactory({
            id: 'tooling-custom-tool',
            order: 50,
            targets: ['main', 'all'],
            riskLevel: 'read',
            requiresApproval: false,
            create: async () => ({
                name: 'custom_inspect',
                label: 'custom_inspect',
                description: 'Custom inspect tool',
                parameters: { type: 'object', properties: {} },
                validate: (a) => (a && typeof a === 'object' ? (a as any) : {}),
                execute: async () => ({
                    content: [{ type: 'text', text: 'inspected' }],
                    details: null,
                    isError: false,
                }),
            }),
        })

        const middlewareExecuted: string[] = []
        const dynamicMiddlewareDisposer = extensionRegistry.registerProtocolMiddleware({
            id: 'tooling-mw',
            order: 50,
            onRequest: async (input) => {
                middlewareExecuted.push('tooling-mw')
                return input
            },
        })

        const dynamicHookDisposer = extensionRegistry.registerHook({
            id: 'tooling-hook',
            event: 'PreToolUse',
            order: 50,
            failureMode: 'open',
            execute: async (): Promise<HookResult> => {
                return { continue: true }
            },
        })

        const service = new CLIProxyAPIAgentService({
            bridge,
            extensionRegistry,
            createClient: () => testClient,
        })

        const input: AgentPrepareInput = {
            baseUrl: 'http://127.0.0.1:8080',
            apiKey: 'test-key',
            modelId: 'test-model',
            models: [modelBase],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: '/test-project',
        }

        const prepared = await service.prepare(input)
        expect(prepared.generationSnapshot).toBeDefined()
        expect(prepared.generationSnapshot!.providerIds).toContain('tooling-custom-tool')
        expect(prepared.generationSnapshot!.providerIds).toContain('tooling-mw')
        expect(prepared.generationSnapshot!.providerIds).toContain('tooling-hook')
        expect(prepared.generationSnapshot!.protocolProvider?.id).toBe('test-protocol')
        expect(prepared.generationSnapshot!.models).toEqual([modelBase])
        expect(Object.isFrozen(prepared.generationSnapshot!.models)).toBe(true)

        const run = service.streamChat({
            prepared,
            sessionId: 'sess-test',
            runId: 'run-1',
            entries: [],
        })

        // Simulate plugin deactivation / contribution unregistration while run is active
        dynamicToolDisposer()
        dynamicMiddlewareDisposer()
        dynamicHookDisposer()

        // Unregistered from live registry
        expect(extensionRegistry.getProtocolMiddlewares().map((m) => m.id)).not.toContain('tooling-mw')
        expect(extensionRegistry.getHookContributions().map((h) => h.id)).not.toContain('tooling-hook')

        // Snapshot provider IDs preserved on active run
        expect(await collectProviderIds(run)).toEqual(prepared.generationSnapshot!.providerIds)

        // Terminate run early
        await run.return?.(undefined as any)

        // Lease is released after run completion
        expect(prepared.generationSnapshot!.lease.released).toBe(true)
    })

    it('creates an immutable, frozen snapshot with all provider components', async () => {
        const providerRegistry = new AgentProviderRegistry({
            extensionRegistry,
            pluginRuntime,
            bridge,
        })

        const input: AgentPrepareInput = {
            baseUrl: 'http://127.0.0.1:8080',
            apiKey: 'test-key',
            modelId: 'test-model',
            models: [modelBase],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: '/test-project',
        }

        const snapshot = await providerRegistry.createSnapshot(input)

        expect(snapshot).toBeDefined()
        expect(typeof snapshot.generation).toBe('number')
        expect(snapshot.lease).toBeDefined()
        expect(typeof snapshot.lease.release).toBe('function')
        expect(Array.isArray(snapshot.tools)).toBe(true)
        expect(snapshot.resources).toBeDefined()
        expect(Array.isArray(snapshot.hooks)).toBe(true)
        expect(snapshot.protocolSession).toBeDefined()
        expect(Array.isArray(snapshot.middleware)).toBe(true)
        expect(snapshot.modelProvider).toBeDefined()
        expect(Array.isArray(snapshot.providerIds)).toBe(true)

        // Verify immutability
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.tools)).toBe(true)
        expect(Object.isFrozen(snapshot.hooks)).toBe(true)
        expect(Object.isFrozen(snapshot.middleware)).toBe(true)
        expect(Object.isFrozen(snapshot.providerIds)).toBe(true)

        snapshot.lease.release()
        expect(snapshot.lease.released).toBe(true)
    })

    it('releases lease and disposes session in finally when stream completes normally', async () => {
        const service = new CLIProxyAPIAgentService({
            bridge,
            extensionRegistry,
            createClient: () => testClient,
        })

        const input: AgentPrepareInput = {
            baseUrl: 'http://127.0.0.1:8080',
            apiKey: 'test-key',
            modelId: 'test-model',
            models: [modelBase],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: '/test-project',
        }

        const prepared = await service.prepare(input)
        const run = service.streamChat({
            prepared,
            sessionId: 'sess-test-2',
            runId: 'run-2',
            entries: [],
        })

        for await (const _event of run) {
            // consume full stream
        }

        expect(prepared.generationSnapshot!.lease.released).toBe(true)
    })

    it('releases lease and disposes session in finally when stream errors or completes with error event', async () => {
        const throwingClient: ProtocolSession = {
            stream: async function* () {
                throw new Error('Connection reset')
            },
            cancel: vi.fn(),
            dispose: vi.fn(),
        }

        const service = new CLIProxyAPIAgentService({
            bridge,
            extensionRegistry,
            createClient: () => throwingClient as any,
            createLoop: (deps) =>
                new AgentLoop({
                    ...deps,
                    retryDelaysMs: [],
                    sleep: async () => {},
                }),
        })

        const input: AgentPrepareInput = {
            baseUrl: 'http://127.0.0.1:8080',
            apiKey: 'test-key',
            modelId: 'test-model',
            models: [modelBase],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: '/test-project',
        }

        const prepared = await service.prepare(input)
        const run = service.streamChat({
            prepared,
            sessionId: 'sess-test-3',
            runId: 'run-3',
            entries: [],
        })

        const events: any[] = []
        for await (const event of run) {
            events.push(event)
        }

        expect(events.some((e) => e.type === 'error')).toBe(true)
        expect(prepared.generationSnapshot!.lease.released).toBe(true)
    })

    it('isolates running agent turns from mid-flight middleware additions', async () => {
        const executedMiddlewares: string[] = []

        const mw1 = extensionRegistry.registerProtocolMiddleware({
            id: 'mw-initial',
            order: 10,
            onRequest: async (input) => {
                executedMiddlewares.push('mw-initial')
                return input
            },
        })

        const service = new CLIProxyAPIAgentService({
            bridge,
            extensionRegistry,
            createClient: () => testClient,
        })

        const input: AgentPrepareInput = {
            baseUrl: 'http://127.0.0.1:8080',
            apiKey: 'test-key',
            modelId: 'test-model',
            models: [modelBase],
            reasoningLevel: 'medium',
            speed: 'standard',
            requestApproval: false,
            projectPath: '/test-project',
        }

        const prepared = await service.prepare(input)
        expect(prepared.generationSnapshot!.providerIds).toContain('mw-initial')

        // Register a late middleware into live extensionRegistry after prepare
        extensionRegistry.registerProtocolMiddleware({
            id: 'mw-late-intruder',
            order: 20,
            onRequest: async (input) => {
                executedMiddlewares.push('mw-late-intruder')
                return input
            },
        })

        const run = service.streamChat({
            prepared,
            sessionId: 'sess-test-4',
            runId: 'run-4',
            entries: [],
        })

        for await (const _event of run) {
            // run turn
        }

        // Only initial middleware from the snapshot was executed
        expect(executedMiddlewares).toContain('mw-initial')
        expect(executedMiddlewares).not.toContain('mw-late-intruder')
        expect(prepared.generationSnapshot!.lease.released).toBe(true)

        mw1()
    })
})
