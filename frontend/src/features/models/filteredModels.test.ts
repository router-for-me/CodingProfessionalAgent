import { describe, expect, it } from 'vitest'
import {
    getFilteredModels,
    getReasoningOptions,
    orderModels,
    stripHiddenReasoningLevels,
} from './filteredModels'
import type { ModelCatalogEntry } from './types'

describe('filteredModels', () => {
    const mockModels: ModelCatalogEntry[] = [
        {
            id: 'model-a',
            label: 'Model A',
            supportsFast: true,
            reasoningLevels: [
                { id: 'low', requestValue: 'low' },
                { id: 'medium', requestValue: 'medium' },
                { id: 'high', requestValue: 'high' },
            ],
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
        },
        {
            id: 'model-b',
            label: 'Model B',
            supportsFast: false,
            reasoningLevels: [
                { id: 'medium', requestValue: 'medium' },
            ],
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 4096,
        },
    ]

    it('returns all models unchanged when enableAll is true', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: true,
            models: {},
        })
        expect(result).toEqual(mockModels)
    })

    it('returns all models unchanged when modelSettings is undefined', () => {
        const result = getFilteredModels(mockModels, undefined)
        expect(result).toEqual(mockModels)
    })

    it('filters out disabled models when enableAll is false', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: false,
            models: {
                'model-a': { enabled: false },
                'model-b': { enabled: true },
            },
        })
        expect(result.map((m) => m.id)).toEqual(['model-b'])
    })

    it('filters reasoning levels for enabled models when enableAll is false', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: false,
            models: {
                'model-a': {
                    enabled: true,
                    enabledReasoningLevels: ['low', 'high'],
                },
            },
        })
        expect(result).toHaveLength(2)
        const modelA = result.find((m) => m.id === 'model-a')
        expect(modelA?.reasoningLevels.map((r) => r.id)).toEqual(['low', 'high'])
    })

    it('retains all reasoning levels if enabledReasoningLevels is not specified', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: false,
            models: {
                'model-a': { enabled: true },
            },
        })
        const modelA = result.find((m) => m.id === 'model-a')
        expect(modelA?.reasoningLevels.map((r) => r.id)).toEqual(['low', 'medium', 'high'])
    })

    it('reorders models based on modelOrder array', () => {
        const ordered = orderModels(mockModels, ['model-b', 'model-a'])
        expect(ordered.map((m) => m.id)).toEqual(['model-b', 'model-a'])
    })

    it('returns filtered models in custom modelOrder', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: true,
            models: {},
            modelOrder: ['model-b', 'model-a'],
        })
        expect(result.map((m) => m.id)).toEqual(['model-b', 'model-a'])
    })

    it('hides ultra reasoning levels for every model while keeping other levels', () => {
        const modelsWithUltra: ModelCatalogEntry[] = [
            {
                ...mockModels[0]!,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low' },
                    { id: 'medium', requestValue: 'medium' },
                    { id: 'high', requestValue: 'high' },
                    { id: 'ultra', requestValue: 'ultra' },
                ],
            },
            {
                ...mockModels[1]!,
                reasoningLevels: [
                    { id: 'ultra', requestValue: 'ULTRA' },
                    { id: 'max', requestValue: 'max' },
                ],
            },
        ]

        const stripped = stripHiddenReasoningLevels(modelsWithUltra)
        expect(stripped[0]?.reasoningLevels.map((level) => level.id)).toEqual([
            'low',
            'medium',
            'high',
        ])
        expect(stripped[1]?.reasoningLevels.map((level) => level.id)).toEqual(['max'])

        const filtered = getFilteredModels(modelsWithUltra, { enableAll: true, models: {} })
        expect(filtered[0]?.reasoningLevels.map((level) => level.id)).toEqual([
            'low',
            'medium',
            'high',
        ])
        expect(filtered[1]?.reasoningLevels.map((level) => level.id)).toEqual(['max'])
        expect(getReasoningOptions(modelsWithUltra[0]).map((level) => level.id)).toEqual([
            'low',
            'medium',
            'high',
        ])
    })

    it('overrides contextWindow when enableAll is false and model has custom contextWindow', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: false,
            models: {
                'model-a': { enabled: true, contextWindow: 256000 },
                'model-b': { enabled: true },
            },
        })
        const modelA = result.find((m) => m.id === 'model-a')
        const modelB = result.find((m) => m.id === 'model-b')
        expect(modelA?.contextWindow).toBe(256000)
        expect(modelB?.contextWindow).toBe(128000)
    })

    it('does not override contextWindow when enableAll is true', () => {
        const result = getFilteredModels(mockModels, {
            enableAll: true,
            models: {
                'model-a': { enabled: true, contextWindow: 256000 },
            },
        })
        const modelA = result.find((m) => m.id === 'model-a')
        expect(modelA?.contextWindow).toBe(128000)
    })
})
