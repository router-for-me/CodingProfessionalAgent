import { describe, expect, it, vi, beforeEach } from 'vitest'
import { refreshModelCatalog, type ModelCatalogFetcher } from './modelCatalogService'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { FALLBACK_MODEL_CATALOG } from '@/features/models/fallbackModels'
import type { ModelCatalogEntry } from '@/features/models/types'

const remoteModel = (id: string): ModelCatalogEntry => ({
    id,
    label: id,
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
})

const config = {
    baseUrl: 'http://127.0.0.1:8317',
    apiKey: 'secret',
}

describe('model catalog service', () => {
    beforeEach(() => {
        useModelCatalogStore.getState().reset()
    })

    it('keeps models state while a configured refresh is loading', async () => {
        let resolveFetch!: (models: readonly ModelCatalogEntry[]) => void
        const fetcher = vi.fn(() => new Promise<readonly ModelCatalogEntry[]>((resolve) => {
            resolveFetch = resolve
        }))

        const refreshPromise = refreshModelCatalog(config, fetcher)

        expect(useModelCatalogStore.getState().status).toBe('loading')
        expect(useModelCatalogStore.getState().models).toEqual(FALLBACK_MODEL_CATALOG)

        resolveFetch([remoteModel('remote')])
        await refreshPromise

        expect(useModelCatalogStore.getState().status).toBe('ready')
        expect(useModelCatalogStore.getState().models.map((model) => model.id)).toEqual(['remote'])
    })

    it('keeps the previous catalog when a refresh fails', async () => {
        const fetcher = vi.fn<ModelCatalogFetcher>()
        fetcher.mockResolvedValueOnce([remoteModel('existing')])
        fetcher.mockRejectedValueOnce(new Error('service unavailable'))

        await refreshModelCatalog(config, fetcher)
        await refreshModelCatalog(config, fetcher)

        expect(useModelCatalogStore.getState().status).toBe('error')
        expect(useModelCatalogStore.getState().error).toBe('service unavailable')
        expect(useModelCatalogStore.getState().models.map((model) => model.id)).toEqual(['existing'])
    })

    it('prevents an older refresh from overwriting a newer refresh', async () => {
        let resolveFirst!: (models: readonly ModelCatalogEntry[]) => void
        let resolveSecond!: (models: readonly ModelCatalogEntry[]) => void
        const fetcher = vi.fn()
            .mockImplementationOnce(() => new Promise<readonly ModelCatalogEntry[]>((resolve) => {
                resolveFirst = resolve
            }))
            .mockImplementationOnce(() => new Promise<readonly ModelCatalogEntry[]>((resolve) => {
                resolveSecond = resolve
            }))

        const firstRefresh = refreshModelCatalog(config, fetcher)
        const secondRefresh = refreshModelCatalog(config, fetcher)

        resolveSecond([remoteModel('newer')])
        await secondRefresh
        resolveFirst([remoteModel('older')])
        await firstRefresh

        expect(useModelCatalogStore.getState().status).toBe('ready')
        expect(useModelCatalogStore.getState().models.map((model) => model.id)).toEqual(['newer'])
    })
})
