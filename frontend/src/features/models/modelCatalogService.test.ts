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

    it('strips ultra reasoning levels from fetched catalog models', async () => {
        const fetcher = vi.fn<ModelCatalogFetcher>().mockResolvedValue([
            {
                ...remoteModel('with-ultra'),
                reasoningLevels: [
                    { id: 'low', requestValue: 'low' },
                    { id: 'ultra', requestValue: 'ultra' },
                    { id: 'high', requestValue: 'high' },
                ],
            },
        ])

        await refreshModelCatalog(config, fetcher)

        expect(useModelCatalogStore.getState().models[0]?.reasoningLevels.map((level) => level.id)).toEqual([
            'low',
            'high',
        ])
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

    it('invalidates cached endpoint-scoped capabilities before a changed-config refresh completes', async () => {
        const capable = { ...remoteModel('search'), cpaCapabilities: { webSearch: true } }
        await refreshModelCatalog(
            { baseUrl: 'http://original-endpoint', apiKey: 'original-auth' },
            vi.fn().mockResolvedValue([capable]),
        )
        let rejectFetch!: (error: Error) => void
        const fetcher = vi.fn(() => new Promise<readonly ModelCatalogEntry[]>((_resolve, reject) => {
            rejectFetch = reject
        }))

        const refresh = refreshModelCatalog(
            { baseUrl: 'http://other-endpoint', apiKey: 'different-auth' },
            fetcher,
        )
        expect(useModelCatalogStore.getState().models[0]).not.toHaveProperty('cpaCapabilities')

        rejectFetch(new Error('unavailable'))
        await refresh
        expect(useModelCatalogStore.getState().models[0]).not.toHaveProperty('cpaCapabilities')
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
