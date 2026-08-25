import { describe, expect, it } from 'vitest'
import { createModelCatalogStore } from './modelCatalogStore'
import { FALLBACK_MODEL_CATALOG } from '@/features/models/fallbackModels'
import type { ModelCatalogEntry } from '@/features/models/types'

const testModel = (id: string): ModelCatalogEntry => ({
    id,
    label: id,
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
})

describe('model catalog store', () => {
    it('initializes with fallback models and idle status', () => {
        const store = createModelCatalogStore()
        expect(store.getState().status).toBe('idle')
        expect(store.getState().models).toEqual(FALLBACK_MODEL_CATALOG)
        expect(store.getState().error).toBeNull()
    })

    it('updates status, models, and error with pure setters', () => {
        const store = createModelCatalogStore()

        store.getState().setStatus('loading')
        expect(store.getState().status).toBe('loading')

        store.getState().setModels([testModel('gpt-4o')])
        expect(store.getState().models.map((m) => m.id)).toEqual(['gpt-4o'])

        store.getState().setError('failed')
        expect(store.getState().error).toBe('failed')

        store.getState().setCatalog({ status: 'ready', error: null })
        expect(store.getState().status).toBe('ready')
        expect(store.getState().error).toBeNull()
    })

    it('resets the catalog to fallback models', () => {
        const store = createModelCatalogStore()
        store.getState().setModels([testModel('custom')])
        store.getState().setStatus('ready')

        store.getState().reset()
        expect(store.getState().status).toBe('idle')
        expect(store.getState().error).toBeNull()
        expect(store.getState().models).toEqual(FALLBACK_MODEL_CATALOG)
    })

    it('hydrates with non-empty model list', () => {
        const store = createModelCatalogStore()
        store.getState().hydrate([testModel('hydrated')])
        expect(store.getState().models.map((m) => m.id)).toEqual(['hydrated'])
    })
})
