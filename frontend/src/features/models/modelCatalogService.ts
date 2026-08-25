import { fetchModelCatalog } from './modelCatalogClient'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import type { ModelCatalogConfig, ModelCatalogEntry } from './types'

export type ModelCatalogFetcher = (
    config: ModelCatalogConfig,
) => Promise<readonly ModelCatalogEntry[]>

let requestGeneration = 0

/**
 * Orchestrates fetching the remote model catalog and updating the pure modelCatalogStore.
 */
export async function refreshModelCatalog(
    config: ModelCatalogConfig,
    fetcher: ModelCatalogFetcher = fetchModelCatalog,
): Promise<void> {
    const generation = ++requestGeneration
    useModelCatalogStore.getState().setCatalog({ status: 'loading', error: null })

    try {
        const models = await fetcher(config)
        if (generation !== requestGeneration) {
            return
        }
        useModelCatalogStore.getState().setCatalog({ models, status: 'ready', error: null })
    } catch (error: unknown) {
        if (generation !== requestGeneration) {
            return
        }
        useModelCatalogStore.getState().setCatalog({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
        })
    }
}
