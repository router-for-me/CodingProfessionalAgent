import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import {
    PERIODIC_ELEMENTS,
    PERIODIC_SERIES_PLACEHOLDERS,
    buildQuickModelPickerItems,
    extractGemini4VariantLabel,
    filterModelReasoningOptions,
    groupGemini4Models,
    isGemini4Model,
    isGemini4PeriodicTableEnabled,
    resolveGemini4Element,
    shouldGroupGemini4InQuickPicker,
} from './gemini4PeriodicTable.js'

function makeModel(overrides: Partial<ModelCatalogEntry> & { id: string }): ModelCatalogEntry {
    return {
        label: overrides.id,
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text'],
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...overrides,
    }
}

describe('gemini4PeriodicTable utils', () => {
    it('defines all 118 chemical elements with unique numbers, symbols, and non-overlapping grid coordinates', () => {
        expect(PERIODIC_ELEMENTS).toHaveLength(118)
        const numbers = new Set<number>()
        const symbols = new Set<string>()
        const coords = new Set<string>()

        for (const el of PERIODIC_ELEMENTS) {
            expect(el.number).toBeGreaterThanOrEqual(1)
            expect(el.number).toBeLessThanOrEqual(118)
            expect(el.row).toBeGreaterThanOrEqual(1)
            expect(el.row).toBeLessThanOrEqual(9)
            expect(el.col).toBeGreaterThanOrEqual(1)
            expect(el.col).toBeLessThanOrEqual(18)

            expect(numbers.has(el.number)).toBe(false)
            expect(symbols.has(el.symbol)).toBe(false)
            const key = `${el.row}:${el.col}`
            expect(coords.has(key)).toBe(false)

            numbers.add(el.number)
            symbols.add(el.symbol)
            coords.add(key)
        }

        for (const placeholder of PERIODIC_SERIES_PLACEHOLDERS) {
            const key = `${placeholder.row}:${placeholder.col}`
            expect(coords.has(key)).toBe(false)
            coords.add(key)
        }
        expect(PERIODIC_SERIES_PLACEHOLDERS).toEqual([
            { id: 'range-57-71', label: '57-71', seriesLabel: 'Ln', row: 6, col: 3, kind: 'range' },
            { id: 'range-89-103', label: '89-103', seriesLabel: 'An', row: 7, col: 3, kind: 'range' },
        ])

        expect(PERIODIC_ELEMENTS.find((e) => e.number === 1)).toMatchObject({ symbol: 'H', name: 'Hydrogen', row: 1, col: 1 })
        expect(PERIODIC_ELEMENTS.find((e) => e.number === 6)).toMatchObject({ symbol: 'C', name: 'Carbon', row: 2, col: 14 })
        expect(PERIODIC_ELEMENTS.find((e) => e.number === 18)).toMatchObject({ symbol: 'Ar', name: 'Argon', row: 3, col: 18 })
        expect(PERIODIC_ELEMENTS.find((e) => e.number === 118)).toMatchObject({ symbol: 'Og', name: 'Oganesson', row: 7, col: 18 })
    })

    it('treats gemini4PeriodicTable setting as enabled by default unless explicitly false', () => {
        expect(isGemini4PeriodicTableEnabled(undefined)).toBe(true)
        expect(isGemini4PeriodicTableEnabled({ enableAll: true, models: {} })).toBe(true)
        expect(isGemini4PeriodicTableEnabled({ enableAll: true, models: {}, gemini4PeriodicTable: true })).toBe(true)
        expect(isGemini4PeriodicTableEnabled({ enableAll: true, models: {}, gemini4PeriodicTable: false })).toBe(false)
    })

    it('matches only models whose display name starts with Gemini 4', () => {
        expect(isGemini4Model(makeModel({ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon' }))).toBe(true)
        expect(isGemini4Model(makeModel({ id: 'devin/gemini-4-argon', label: 'Gemini 4 Argon (Devin)' }))).toBe(true)
        expect(isGemini4Model(makeModel({ id: 'gemini-4-argon', label: 'Gemini 4 Argon SU' }))).toBe(true)
        expect(isGemini4Model(makeModel({ id: 'gemini-4-flash', label: 'Gemini 4 Flash' }))).toBe(true)
        expect(isGemini4Model(makeModel({ id: 'gemini-4-carbon', label: '' }))).toBe(true)

        expect(isGemini4Model(makeModel({ id: 'gemini-3.8-flash-tiered', label: 'Gemini 3.8 Flash (Tiered)' }))).toBe(false)
        expect(isGemini4Model(makeModel({ id: 'gemini-4.5-pro', label: 'Gemini 4.5 Pro' }))).toBe(false)
        expect(isGemini4Model(makeModel({ id: 'gemini-40', label: 'Gemini 40' }))).toBe(false)
        expect(isGemini4Model(makeModel({ id: 'gpt-5.4', label: 'GPT-5.4' }))).toBe(false)
    })

    it('groups Gemini 4 variants into corresponding elements without misclassifying channel suffixes and preserves non-element models in otherModels', () => {
        const models: ModelCatalogEntry[] = [
            makeModel({ id: 'gpt-5.4', label: 'GPT-5.4' }),
            makeModel({ id: 'gemini-4-argon-su', label: 'Gemini 4 Argon SU' }),
            makeModel({ id: 'devin/gemini-4-argon', label: 'Gemini 4 Argon (Devin)' }),
            makeModel({ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon', description: 'Code and analysis' }),
            makeModel({ id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon' }),
            makeModel({ id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen' }),
            makeModel({ id: 'gemini-4-flash', label: 'Gemini 4 Flash' }),
            makeModel({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }),
        ]

        const grouped = groupGemini4Models(models)
        expect(grouped.nonGemini4Models.map((m) => m.id)).toEqual(['gpt-5.4', 'gemini-3.8-flash'])
        expect(grouped.releasedCount).toBe(3)
        expect(grouped.otherModels.map((m) => m.id)).toEqual(['gemini-4-flash'])

        const argonGroup = grouped.elementMap.get(18)
        expect(argonGroup?.element.symbol).toBe('Ar')
        expect(argonGroup?.models.map((m) => m.id)).toEqual([
            'gemini-4-argon-high',
            'devin/gemini-4-argon',
            'gemini-4-argon-su',
        ])

        expect(resolveGemini4Element(makeModel({ id: 'gemini-4-su', label: 'Gemini 4 SU' }))).toBeNull()
        expect(extractGemini4VariantLabel(models[3]!, argonGroup!.element)).toBeNull()
        expect(extractGemini4VariantLabel(models[2]!, argonGroup!.element)).toBe('Devin')
        expect(extractGemini4VariantLabel(models[1]!, argonGroup!.element)).toBe('SU')
    })

    it('filters reasoning levels according to modelSettings when enableAll is false and falls back safely', () => {
        const model = makeModel({
            id: 'gemini-4-hydrogen-xhigh',
            label: 'Gemini 4 Hydrogen',
            reasoningLevels: [
                { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
                { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
                { id: 'xhigh', requestValue: 'xhigh', labelKey: 'composer.reasoning.xhigh' },
            ],
        })

        expect(filterModelReasoningOptions(model, undefined).map((o) => o.id)).toEqual([
            'low', 'medium', 'high', 'xhigh',
        ])
        expect(
            filterModelReasoningOptions(model, {
                enableAll: false,
                models: {
                    'gemini-4-hydrogen-xhigh': {
                        enabled: true,
                        enabledReasoningLevels: ['low', 'xhigh'],
                    },
                },
            }).map((o) => o.id),
        ).toEqual(['low', 'xhigh'])
        expect(
            filterModelReasoningOptions(model, {
                enableAll: false,
                models: {
                    'gemini-4-hydrogen-xhigh': {
                        enabled: true,
                        enabledReasoningLevels: [],
                    },
                },
            }).map((o) => o.id),
        ).toEqual(['low', 'medium', 'high', 'xhigh'])

        const refreshedOnlyLow = makeModel({
            id: 'gemini-4-hydrogen-xhigh',
            reasoningLevels: [{ id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' }],
        })
        expect(
            filterModelReasoningOptions(refreshedOnlyLow, {
                enableAll: false,
                models: {
                    'gemini-4-hydrogen-xhigh': {
                        enabled: true,
                        enabledReasoningLevels: ['high'],
                    },
                },
            }).map((o) => o.id),
        ).toEqual([])
    })

    it('groups Gemini 4 in quick picker for empty or group queries while preserving direct element keyword search', () => {
        const models = [
            makeModel({ id: 'claude-opus-4.6', label: 'Claude Opus 4.6' }),
            makeModel({ id: 'gemini-4-argon-high', label: 'Gemini 4 Argon' }),
            makeModel({ id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon' }),
            makeModel({ id: 'gpt-5.4', label: 'GPT 5.4' }),
        ]

        expect(shouldGroupGemini4InQuickPicker('')).toBe(true)
        expect(shouldGroupGemini4InQuickPicker('gemini')).toBe(true)
        expect(shouldGroupGemini4InQuickPicker('periodic')).toBe(true)
        expect(shouldGroupGemini4InQuickPicker('周期表')).toBe(true)
        expect(shouldGroupGemini4InQuickPicker('argon')).toBe(false)

        const defaultItems = buildQuickModelPickerItems({
            models,
            currentModelId: 'gemini-4-argon-high',
            searchQuery: '',
            enableGemini4Grouping: true,
        })
        expect(defaultItems.map((i) => i.id)).toEqual([
            'claude-opus-4.6',
            '__gemini4_group__',
            'gpt-5.4',
        ])
        expect(defaultItems[1]).toMatchObject({
            kind: 'gemini4-group',
            containsCurrentModel: true,
            releasedCount: 2,
        })

        const periodicSearchItems = buildQuickModelPickerItems({
            models,
            currentModelId: 'gpt-5.4',
            searchQuery: '周期表',
            enableGemini4Grouping: true,
        })
        expect(periodicSearchItems.map((i) => i.id)).toEqual(['__gemini4_group__'])

        const directElementSearch = buildQuickModelPickerItems({
            models,
            currentModelId: 'gpt-5.4',
            searchQuery: 'argon',
            enableGemini4Grouping: true,
        })
        expect(directElementSearch.map((i) => i.id)).toEqual(['gemini-4-argon-high'])

        const disabledItems = buildQuickModelPickerItems({
            models,
            currentModelId: 'gpt-5.4',
            searchQuery: '',
            enableGemini4Grouping: false,
        })
        expect(disabledItems.map((i) => i.id)).toEqual([
            'claude-opus-4.6',
            'gemini-4-argon-high',
            'gemini-4-carbon-high',
            'gpt-5.4',
        ])
    })

    it('uses IUPAC primary element names, prefers full element names across label/id before symbol collision, and avoids swallowing ta', () => {
        expect(PERIODIC_ELEMENTS.find((e) => e.number === 13)?.name).toBe('Aluminium')
        expect(PERIODIC_ELEMENTS.find((e) => e.number === 55)?.name).toBe('Caesium')

        const collisionModel = makeModel({
            id: 'gemini-4-carbon',
            label: 'Gemini 4 In Preview',
        })
        expect(resolveGemini4Element(collisionModel)?.number).toBe(6)

        const alu = makeModel({ id: 'gemini-4-aluminum', label: 'Gemini 4 Aluminum' })
        expect(resolveGemini4Element(alu)?.number).toBe(13)

        const taModels = [
            makeModel({ id: 'gemini-4-tantalum', label: 'Gemini 4 Tantalum' }),
            makeModel({ id: 'gemini-10-pro', label: 'Gemini 10 Pro' }),
        ]
        expect(shouldGroupGemini4InQuickPicker('ta')).toBe(false)
        expect(
            buildQuickModelPickerItems({
                models: taModels,
                currentModelId: 'gemini-10-pro',
                searchQuery: 'ta',
                enableGemini4Grouping: true,
            }).map((i) => i.id),
        ).toEqual(['gemini-4-tantalum'])

        expect(
            buildQuickModelPickerItems({
                models: taModels,
                currentModelId: 'gemini-10-pro',
                searchQuery: '',
                enableGemini4Grouping: true,
            }).map((i) => i.id),
        ).toEqual(['__gemini4_group__', 'gemini-10-pro'])
    })
})
