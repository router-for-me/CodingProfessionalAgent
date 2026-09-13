import { describe, expect, it, vi } from 'vitest'
import {
    ModelCatalogFormatError,
    fetchModelCatalogDirect,
    normalizeModelsUrl,
    parseModelCatalog,
} from './modelCatalog.js'

describe('protocol-codex model catalog', () => {
    it('normalizes the CPA models URL with client_version=cpa', () => {
        expect(normalizeModelsUrl('http://127.0.0.1:8317')).toBe(
            'http://127.0.0.1:8317/v1/models?client_version=cpa',
        )
        expect(normalizeModelsUrl('127.0.0.1:8317/backend-api/')).toBe(
            'http://127.0.0.1:8317/v1/models?client_version=cpa',
        )
        expect(normalizeModelsUrl('https://example.test/api/v1')).toBe(
            'https://example.test/api/v1/models?client_version=cpa',
        )
    })

    it('parses CPA rich catalog payloads with supported_reasoning_levels', () => {
        const [model] = parseModelCatalog({
            models: [
                {
                    slug: 'gpt-5.5',
                    display_name: 'GPT 5.5',
                    description: 'Frontier model',
                    service_tiers: [{ id: 'priority', name: 'Fast' }],
                    supported_reasoning_levels: [
                        { effort: 'low', description: 'Light reasoning' },
                        { effort: 'medium' },
                        { effort: 'high' },
                        'xhigh',
                    ],
                    input_modalities: ['text', 'image'],
                    context_window: 272_000,
                    max_tokens: 32_768,
                },
            ],
        })

        expect(model).toEqual(
            expect.objectContaining({
                id: 'gpt-5.5',
                label: 'GPT 5.5',
                description: 'Frontier model',
                supportsFast: true,
                input: ['text', 'image'],
                contextWindow: 272_000,
                maxTokens: 32_768,
            }),
        )
        expect(model.reasoningLevels.map((level) => level.id)).toEqual([
            'low',
            'medium',
            'high',
            'xhigh',
        ])
        expect(model.reasoningLevels[0]).toEqual(
            expect.objectContaining({
                id: 'low',
                requestValue: 'low',
                labelKey: 'composer.reasoning.low',
                description: 'Light reasoning',
            }),
        )
    })

    it('preserves only boolean CPA web-search capabilities', () => {
        const [supported, unsupported, unknown, malformed] = parseModelCatalog({ models: [
            { id: 'supported', cpa_capabilities: { web_search: true, secret: 'ignored' } },
            { id: 'unsupported', cpa_capabilities: { web_search: false } },
            { id: 'unknown' },
            { id: 'malformed', cpa_capabilities: { web_search: 'true' } },
        ] })

        expect(supported.cpaCapabilities).toEqual({ webSearch: true })
        expect(unsupported.cpaCapabilities).toEqual({ webSearch: false })
        expect(unknown).not.toHaveProperty('cpaCapabilities')
        expect(malformed).not.toHaveProperty('cpaCapabilities')
    })

    it('does not treat additional_speed_tiers alone as Fast support', () => {
        const [model] = parseModelCatalog({
            models: [
                {
                    slug: 'gemini-flash',
                    display_name: 'Gemini Flash',
                    additional_speed_tiers: ['fast'],
                    service_tiers: [],
                    supported_reasoning_levels: ['minimal', 'low', 'medium', 'high'],
                },
            ],
        })

        expect(model.supportsFast).toBe(false)
        expect(model.reasoningLevels.map((level) => level.id)).toEqual([
            'minimal',
            'low',
            'medium',
            'high',
        ])
    })

    it('accepts OpenAI-style data arrays but leaves reasoning empty when absent', () => {
        const models = parseModelCatalog({
            object: 'list',
            data: [{ id: 'kimi-k2.6', object: 'model', created: 1, owned_by: 'openai' }],
        })

        expect(models).toEqual([
            expect.objectContaining({
                id: 'kimi-k2.6',
                label: 'kimi-k2.6',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
            }),
        ])
    })

    it('filters hidden models and rejects invalid payload shapes', () => {
        expect(
            parseModelCatalog({
                models: [
                    { slug: 'visible', display_name: 'Visible' },
                    { slug: 'hidden', visibility: 'hide' },
                ],
            }).map((model) => model.id),
        ).toEqual(['visible'])

        expect(() => parseModelCatalog(null)).toThrow(ModelCatalogFormatError)
        expect(() => parseModelCatalog({})).toThrow(ModelCatalogFormatError)
    })

    it('requests the CPA catalog URL through the transport', async () => {
        const transport = {
            request: vi.fn(async () => ({
                status: 200,
                body: JSON.stringify({
                    models: [
                        {
                            slug: 'gpt-5.5',
                            display_name: 'GPT 5.5',
                            service_tiers: [{ id: 'priority' }],
                            supported_reasoning_levels: [
                                { effort: 'low' },
                                { effort: 'high' },
                            ],
                        },
                    ],
                }),
            })),
        }

        const models = await fetchModelCatalogDirect(
            { baseUrl: 'http://127.0.0.1:8317', apiKey: 'test-key' },
            transport,
        )

        expect(transport.request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'http://127.0.0.1:8317/v1/models?client_version=cpa',
                method: 'GET',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-key',
                }),
            }),
        )
        expect(models[0]?.reasoningLevels.map((level) => level.id)).toEqual(['low', 'high'])
        expect(models[0]?.supportsFast).toBe(true)
    })
})
