import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import {
    getDefaultReasoningLevel,
    getDefaultReasoningOption,
    getReasoningOptions,
    getSpeedOptions,
    normalizeModelPreferences,
    sortModelsByName,
} from './modelMenuOptions.js'

describe('model menu options', () => {
    it('returns empty reasoning options when model is undefined', () => {
        expect(getReasoningOptions(undefined)).toEqual([])
        expect(getDefaultReasoningLevel(undefined)).toBe('off')
    })

    it('orders and deduplicates injected reasoning levels canonically', () => {
        const model: ModelCatalogEntry = {
            id: 'unsorted',
            label: 'Unsorted',
            supportsFast: false,
            reasoningLevels: [
                { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
                { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                { id: 'high', requestValue: 'high-duplicate', labelKey: 'composer.reasoning.high' },
                { id: 'custom', requestValue: 'custom', fallbackLabel: 'custom' },
                { id: 'off', requestValue: 'off', labelKey: 'composer.reasoning.off' },
            ],
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        }

        expect(getReasoningOptions(model).map((option) => option.id)).toEqual([
            'off',
            'low',
            'high',
            'custom',
        ])
    })

    it('selects the middle reasoning level for odd counts and upper-middle for even counts', () => {
        const makeModel = (levels: string[]): ModelCatalogEntry => ({
            id: 'test-model',
            label: 'Test Model',
            supportsFast: false,
            reasoningLevels: levels.map((id) => ({ id, requestValue: id })),
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        })

        // 5 levels (odd): [low, medium, high, xhigh, max] -> middle is index 2: high
        const fiveLevels = makeModel(['low', 'medium', 'high', 'xhigh', 'max'])
        expect(getDefaultReasoningLevel(fiveLevels)).toBe('high')
        expect(getDefaultReasoningOption(fiveLevels)?.id).toBe('high')

        // 3 levels (odd): [low, medium, high] -> middle is index 1: medium
        const threeLevels = makeModel(['low', 'medium', 'high'])
        expect(getDefaultReasoningLevel(threeLevels)).toBe('medium')

        // 4 levels (even): [low, medium, high, max] -> upper-middle is index 2: high
        const fourLevels = makeModel(['low', 'medium', 'high', 'max'])
        expect(getDefaultReasoningLevel(fourLevels)).toBe('high')

        // 2 levels (even): [low, high] -> upper-middle is index 1: high
        const twoLevels = makeModel(['low', 'high'])
        expect(getDefaultReasoningLevel(twoLevels)).toBe('high')

        // 1 level: [medium] -> index 0: medium
        const oneLevel = makeModel(['medium'])
        expect(getDefaultReasoningLevel(oneLevel)).toBe('medium')

        // 0 levels: [] -> 'off'
        const zeroLevels = makeModel([])
        expect(getDefaultReasoningLevel(zeroLevels)).toBe('off')
    })

    it('only exposes model reasoning levels', () => {
        const model: ModelCatalogEntry = {
            id: 'limited',
            label: 'Limited',
            supportsFast: false,
            reasoningLevels: [
                { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
            ],
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        }

        expect(getReasoningOptions(model).map((option) => option.id)).toEqual(['low', 'high'])
        expect(getSpeedOptions(false).map((option) => option.id)).toEqual(['standard'])
        expect(getSpeedOptions(true).map((option) => option.id)).toEqual([
            'standard',
            'fast',
        ])
    })

    it('falls back invalid preferences to default middle reasoning level when switching models', () => {
        const model: ModelCatalogEntry = {
            id: 'standard-only',
            label: 'Standard only',
            supportsFast: false,
            reasoningLevels: [
                { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
                { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
            ],
            input: ['text'],
            contextWindow: 128_000,
            maxTokens: 16_384,
        }

        // 'unknown-level' falls back to default middle 'medium'
        expect(normalizeModelPreferences(model, 'unknown-level', 'max')).toEqual({
            reasoningLevel: 'medium',
            speed: 'standard',
        })

        // Valid 'high' is preserved
        expect(
            normalizeModelPreferences({ ...model, supportsFast: true }, 'high', 'max'),
        ).toEqual({
            reasoningLevel: 'high',
            speed: 'fast',
        })
    })

    describe('sortModelsByName', () => {
        it('sorts models alphabetically by label (case-insensitive and numeric-aware)', () => {
            const models: ModelCatalogEntry[] = [
                { id: 'gpt-4o', label: 'GPT-4o', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                { id: 'deepseek-v3', label: 'DeepSeek-V3', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
            ]

            const sorted = sortModelsByName(models)
            expect(sorted.map((m) => m.label)).toEqual([
                'Claude 3.5 Sonnet',
                'Claude 3.7 Sonnet',
                'DeepSeek-V3',
                'GPT-4o',
            ])
        })

        it('falls back to model id when label is empty or whitespace', () => {
            const models: ModelCatalogEntry[] = [
                { id: 'zeta-model', label: '', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                { id: 'alpha-model', label: '   ', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                { id: 'beta-model', label: 'Beta Model', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
            ]

            const sorted = sortModelsByName(models)
            expect(sorted.map((m) => m.id)).toEqual([
                'alpha-model',
                'beta-model',
                'zeta-model',
            ])
        })
    })
})
