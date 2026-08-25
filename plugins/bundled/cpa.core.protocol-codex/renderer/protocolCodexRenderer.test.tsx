import { describe, expect, it, vi } from 'vitest'
import { protocolCodexRendererEntry } from './index.js'
import type { PluginContext } from '@cpa/plugin-api'

describe('protocolCodexRendererEntry', () => {
    it('registers settings section and model catalog provider', () => {
        let settingsSection: any = null
        let modelCatalogProvider: any = null

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.protocol-codex',
                name: 'Codex Protocol Provider',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'Codex protocol provider',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'renderer',
            registerSettingsSection: (section: any) => {
                settingsSection = section
            },
            registerModelCatalogProvider: (provider: any) => {
                modelCatalogProvider = provider
            },
            getService: () => undefined,
        } as unknown as PluginContext

        protocolCodexRendererEntry.activate(mockContext)

        expect(settingsSection).not.toBeNull()
        expect(settingsSection.id).toBe('models')
        expect(settingsSection.groupId).toBe('code')

        expect(modelCatalogProvider).not.toBeNull()
        expect(modelCatalogProvider.id).toBe('cliproxyapi')
        expect(modelCatalogProvider.protocolProviderId).toBe('codex-responses-ws')

        const capabilities = modelCatalogProvider.getModelCapabilities({
            id: 'test-model',
            label: 'Test Model',
            supportsFast: true,
            input: ['text', 'image'],
            reasoningLevels: [{ id: 'high', requestValue: 'high' }],
            contextWindow: 128_000,
            maxTokens: 16_384,
        })
        expect(capabilities.supportsImages).toBe(true)
        expect(capabilities.supportsFast).toBe(true)
        expect(capabilities.reasoningLevels).toEqual(['high'])
        expect(capabilities.contextWindow).toBe(128_000)
    })

    it('uses context.capabilityClient when fetching catalog without explicit transport', async () => {
        let modelCatalogProvider: any = null

        const mockCapabilityClient = {
            has: vi.fn().mockReturnValue(true),
            invoke: vi.fn().mockResolvedValue({
                status: 200,
                headers: { 'content-type': ['application/json'] },
                body: JSON.stringify({
                    models: [
                        {
                            id: 'proxied-model',
                            display_name: 'Proxied Model',
                            input_modalities: ['text'],
                            context_window: 64_000,
                        },
                    ],
                }),
            }),
            subscribe: vi.fn(),
        }

        const mockContext: PluginContext = {
            manifest: {
                id: 'cpa.core.protocol-codex',
                name: 'Codex Protocol Provider',
                version: '1.0.0',
                apiVersion: '1.0.0',
                description: 'Codex protocol provider',
                engines: { cpa: '>=1.0.0' },
            },
            runtime: 'renderer',
            capabilityClient: mockCapabilityClient as any,
            registerSettingsSection: vi.fn(),
            registerModelCatalogProvider: (provider: any) => {
                modelCatalogProvider = provider
            },
            getService: () => undefined,
        } as unknown as PluginContext

        protocolCodexRendererEntry.activate(mockContext)

        expect(modelCatalogProvider).not.toBeNull()

        const models = await modelCatalogProvider.fetchCatalog({
            baseUrl: 'http://127.0.0.1:8317',
            apiKey: 'test-key',
        })

        expect(mockCapabilityClient.has).toHaveBeenCalledWith('network.http')
        expect(mockCapabilityClient.invoke).toHaveBeenCalledWith('http:request', [
            expect.objectContaining({
                urlString: 'http://127.0.0.1:8317/v1/models?client_version=cpa',
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-key',
                }),
            }),
        ])
        expect(models[0].id).toBe('proxied-model')
    })
})
