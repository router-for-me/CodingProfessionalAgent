import { describe, expect, it } from 'vitest'
import {
    ModelCatalogFormatError,
    normalizeModelsUrl,
    parseModelCatalog,
} from './modelCatalogParser'

describe('model catalog parser', () => {
    it('normalizes the CPA models URL', () => {
        expect(normalizeModelsUrl('http://127.0.0.1:8317')).toBe(
            'http://127.0.0.1:8317/v1/models?client_version=cpa',
        )
        expect(normalizeModelsUrl('127.0.0.1:8317/backend-api/')).toBe(
            'http://127.0.0.1:8317/v1/models?client_version=cpa',
        )
        expect(normalizeModelsUrl('https://example.test/api/')).toBe(
            'https://example.test/api/v1/models?client_version=cpa',
        )
    })

    it('maps visible models and detects Fast only from non-empty service tiers', () => {
        expect(parseModelCatalog({
            models: [
                {
                    slug: 'gpt-fast',
                    display_name: 'GPT Fast',
                    service_tiers: [{ id: 'priority' }],
                    supported_reasoning_levels: ['medium', { effort: 'high' }],
                },
                {
                    id: 'hidden',
                    visibility: 'hide',
                    service_tiers: [{ id: 'priority' }],
                },
                {
                    id: 'speed-only',
                    additional_speed_tiers: ['fast'],
                },
                {
                    id: 'empty-tiers',
                    service_tiers: [],
                },
            ],
        })).toEqual([
            expect.objectContaining({
                id: 'gpt-fast',
                label: 'GPT Fast',
                supportsFast: true,
            }),
            expect.objectContaining({ id: 'speed-only', supportsFast: false }),
            expect.objectContaining({ id: 'empty-tiers', supportsFast: false }),
        ])
    })

    it('accepts root arrays, models arrays, and data arrays', () => {
        expect(parseModelCatalog([{ id: 'root' }])).toHaveLength(1)
        expect(parseModelCatalog({ models: [{ id: 'models' }] })[0].id).toBe('models')
        expect(parseModelCatalog({ data: [{ id: 'data' }] })[0].id).toBe('data')
    })

    it('filters hidden and missing identifiers while falling back to the identifier label', () => {
        expect(parseModelCatalog([
            { id: 'named', name: 'Named' },
            { id: 'fallback-label', display_name: '  ' },
            { id: '   ' },
            { display_name: 'Missing ID' },
            { id: 'hidden', visibility: 'hide' },
        ])).toEqual([
            expect.objectContaining({ id: 'named', label: 'Named' }),
            expect.objectContaining({ id: 'fallback-label', label: 'fallback-label' }),
        ])
    })

    it('deduplicates and sorts reasoning efforts with canonical labels', () => {
        const [model] = parseModelCatalog([{
            id: 'reasoning',
            supported_reasoning_levels: [
                'HIGH',
                { effort: 'low', description: 'ignored by the UI label' },
                'medium',
                { effort: 'high' },
                'xhigh',
                'max',
                'ultra',
                'minimal',
            ],
        }])

        expect(model.reasoningLevels).toEqual([
            expect.objectContaining({ id: 'minimal', requestValue: 'minimal', labelKey: 'composer.reasoning.minimal' }),
            expect.objectContaining({ id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low', description: 'ignored by the UI label' }),
            expect.objectContaining({ id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' }),
            expect.objectContaining({ id: 'high', requestValue: 'HIGH', labelKey: 'composer.reasoning.high' }),
            expect.objectContaining({ id: 'xhigh', requestValue: 'xhigh', labelKey: 'composer.reasoning.xhigh' }),
            expect.objectContaining({ id: 'max', requestValue: 'max', labelKey: 'composer.reasoning.max' }),
            expect.objectContaining({ id: 'ultra', requestValue: 'ultra', labelKey: 'composer.reasoning.ultra' }),
        ])
    })

    it('merges none and off while retaining the first request value', () => {
        const [model] = parseModelCatalog([
            { id: 'none-first', supported_reasoning_levels: ['none', 'off'] },
            { id: 'off-first', supported_reasoning_levels: ['off', 'none'] },
        ])

        expect(model.reasoningLevels).toEqual([
            expect.objectContaining({
                id: 'off',
                requestValue: 'none',
                labelKey: 'composer.reasoning.off',
            }),
        ])
        expect(parseModelCatalog([
            { id: 'off-first', supported_reasoning_levels: ['off', 'none'] },
        ])[0].reasoningLevels[0]).toEqual(expect.objectContaining({ requestValue: 'off' }))
    })

    it('keeps unknown efforts at the end with fallback labels', () => {
        const [model] = parseModelCatalog([{
            id: 'custom',
            supported_reasoning_levels: ['custom-effort', { effort: 'low' }, 'another'],
        }])

        expect(model.reasoningLevels).toEqual([
            expect.objectContaining({ id: 'low' }),
            expect.objectContaining({ id: 'custom-effort', fallbackLabel: 'custom-effort' }),
            expect.objectContaining({ id: 'another', fallbackLabel: 'another' }),
        ])
    })

    it('preserves prototype-key efforts as unknown options', () => {
        const [model] = parseModelCatalog([{
            id: 'prototype-keys',
            supported_reasoning_levels: ['constructor', 'toString', '__proto__'],
        }])

        expect(model.reasoningLevels).toEqual([
            expect.objectContaining({ id: 'constructor', fallbackLabel: 'constructor' }),
            expect.objectContaining({ id: 'tostring', fallbackLabel: 'toString' }),
            expect.objectContaining({ id: '__proto__', fallbackLabel: '__proto__' }),
        ])
    })

    it('rejects unsupported payload shapes but accepts an empty array', () => {
        expect(() => parseModelCatalog(null)).toThrow(ModelCatalogFormatError)
        expect(() => parseModelCatalog({ models: 'not-an-array' })).toThrow(ModelCatalogFormatError)
        expect(() => parseModelCatalog({})).toThrow(ModelCatalogFormatError)
        expect(parseModelCatalog({ data: [] })).toEqual([])
    })

    it('preserves agent runtime metadata with safe fallbacks', () => {
        const [full, fallback] = parseModelCatalog({
            data: [
                {
                    id: 'vision-model',
                    input_modalities: ['image', 'text', 'audio'],
                    context_window: 262_144,
                    max_tokens: 32_768,
                },
                { id: 'text-model', input_modalities: ['image'] },
            ],
        })

        expect(full).toMatchObject({
            input: ['image', 'text'],
            contextWindow: 262_144,
            maxTokens: 32_768,
        })
        expect(fallback).toMatchObject({
            input: ['text', 'image'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        })
    })
})
