import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
    ModelCapabilities,
    ModelCatalogEntry,
    ModelCatalogProviderContribution,
} from '@cpa/plugin-api'
import {
    fetchModelCatalogFromProvider,
    getModelCapabilities,
    ModelCatalogProviderRegistry,
} from './ModelCatalogProvider'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { createToolsFromProviders } from './ToolFactoryProvider'
import type { NativeBridge } from '../native/types'

describe('ModelCatalogProvider SPI & Business Tool Factories', () => {
    function readRuntimeSource(): string {
        const servicePath = resolve(
            __dirname,
            '../CLIProxyAPIAgentService.ts'
        )
        return readFileSync(servicePath, 'utf8')
    }

    const existingModelCatalogFixture: readonly ModelCatalogEntry[] = [
        {
            id: 'gpt-5-turbo',
            label: 'GPT-5 Turbo',
            supportsFast: true,
            reasoningLevels: [{ id: 'medium', requestValue: 'medium' }],
            input: ['text', 'image'],
            contextWindow: 200_000,
            maxTokens: 16_384,
        },
        {
            id: 'claude-3-7-sonnet',
            label: 'Claude 3.7 Sonnet',
            supportsFast: false,
            reasoningLevels: [{ id: 'high', requestValue: 'high' }],
            input: ['text'],
            contextWindow: 200_000,
            maxTokens: 8_192,
        },
    ]

    const settings = {
        baseUrl: 'http://127.0.0.1:18080',
        apiKey: 'sk-test-token',
    }

    it('loads the current CLIProxyAPI model catalog through the selected provider', async () => {
        const mockProvider: ModelCatalogProviderContribution = {
            id: 'cliproxyapi',
            protocolProviderId: 'codex-responses-ws',
            fetchCatalog: vi.fn().mockResolvedValue(existingModelCatalogFixture),
            getModelCapabilities: (model: ModelCatalogEntry): ModelCapabilities => ({
                supportsImages: model.input.includes('image'),
                supportsFast: model.supportsFast,
                reasoningLevels: model.reasoningLevels.map((r) => r.id),
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxTokens,
            }),
        }

        const registry = new RendererRegistry()
        registry.registerModelCatalogProvider(mockProvider as any)

        const providerRegistry = new ModelCatalogProviderRegistry(registry)
        const provider = providerRegistry.getProvider('cliproxyapi')
        expect(provider).toBeDefined()

        const models = await provider!.fetchCatalog(settings)
        expect(models).toEqual(existingModelCatalogFixture)
        expect(mockProvider.fetchCatalog).toHaveBeenCalledWith(settings)
    })

    it('retrieves model capabilities from provider or falls back to standard schema', async () => {
        const mockProvider: ModelCatalogProviderContribution = {
            id: 'custom-catalog',
            protocolProviderId: 'custom-protocol',
            fetchCatalog: vi.fn().mockResolvedValue(existingModelCatalogFixture),
            getModelCapabilities: (model: ModelCatalogEntry): ModelCapabilities => ({
                supportsImages: model.input.includes('image'),
                supportsFast: model.supportsFast,
                reasoningLevels: ['low', 'medium', 'high'],
                contextWindow: model.contextWindow,
                maxOutputTokens: model.maxTokens,
                customVendorFlag: true,
            }),
        }

        const registry = new RendererRegistry()
        registry.registerModelCatalogProvider(mockProvider as any)

        const providerRegistry = new ModelCatalogProviderRegistry(registry)
        const capabilities = providerRegistry.getModelCapabilities(
            existingModelCatalogFixture[0],
            'custom-catalog'
        )

        expect(capabilities).toEqual({
            supportsImages: true,
            supportsFast: true,
            reasoningLevels: ['low', 'medium', 'high'],
            contextWindow: 200_000,
            maxOutputTokens: 16_384,
            customVendorFlag: true,
        })

        const helperCaps = getModelCapabilities(existingModelCatalogFixture[0], {
            registry,
            providerId: 'custom-catalog',
        })
        expect(helperCaps).toEqual(capabilities)
    })

    it('fetches model catalog via helper function', async () => {
        const mockProvider: ModelCatalogProviderContribution = {
            id: 'cliproxyapi',
            protocolProviderId: 'codex-responses-ws',
            fetchCatalog: vi.fn().mockResolvedValue(existingModelCatalogFixture),
            getModelCapabilities: vi.fn().mockReturnValue({}),
        }

        const registry = new RendererRegistry()
        registry.registerModelCatalogProvider(mockProvider as any)

        const models = await fetchModelCatalogFromProvider(settings, {
            registry,
            providerId: 'cliproxyapi',
        })
        expect(models).toEqual(existingModelCatalogFixture)
    })

    it('creates subagent and session title tools only from plugin factories', async () => {
        const mockBridge: NativeBridge = {
            stat: vi.fn().mockResolvedValue({ isDir: true, isFile: false, size: 0, mtimeMs: 0 }),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            runtimeInfo: vi.fn().mockResolvedValue({
                platform: 'darwin',
                userConfigDir: '/test/config',
                tempDir: '/test/temp',
                homeDir: '/test/home',
            }),
        } as unknown as NativeBridge

        const registry = new RendererRegistry()

        // Register subagent tool factories
        registry.registerToolFactory({
            id: 'spawn_agent',
            order: 60,
            targets: ['main'],
            riskLevel: 'process',
            requiresApproval: false,
            approvalCategory: 'subagent-lifecycle',
            create: () => ({
                name: 'spawn_agent',
                label: 'spawn_agent',
                description: 'Spawn subagent',
                parameters: { type: 'object' },
                validate: () => ({}),
                execute: vi.fn(),
            }),
        })
        registry.registerToolFactory({
            id: 'send_message',
            order: 61,
            targets: ['main'],
            riskLevel: 'process',
            requiresApproval: false,
            approvalCategory: 'subagent-communication',
            aliases: ['send_input'],
            create: () => ({
                name: 'send_input',
                label: 'send_input',
                description: 'Send input to subagent',
                parameters: { type: 'object' },
                validate: () => ({}),
                execute: vi.fn(),
            }),
        })
        registry.registerToolFactory({
            id: 'stop_agent',
            order: 62,
            targets: ['main'],
            riskLevel: 'process',
            requiresApproval: false,
            approvalCategory: 'subagent-lifecycle',
            create: () => ({
                name: 'stop_agent',
                label: 'stop_agent',
                description: 'Stop subagent',
                parameters: { type: 'object' },
                validate: () => ({}),
                execute: vi.fn(),
            }),
        })
        registry.registerToolFactory({
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
                validate: () => ({}),
                execute: vi.fn(),
            }),
        })

        const tools = await createToolsFromProviders({
            cwd: '/mock/project',
            bridge: mockBridge,
            extensionRegistry: registry,
            targetAgent: 'main',
        })

        const toolNames = tools.map((t) => t.name)
        expect(toolNames).toEqual(
            expect.arrayContaining([
                'spawn_agent',
                'send_input',
                'stop_agent',
                'title',
            ])
        )

        const runtimeSource = readRuntimeSource()
        expect(runtimeSource).not.toMatch(/createSubagentTools|createSessionTitleTool/)
    })
})
