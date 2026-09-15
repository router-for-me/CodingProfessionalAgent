import { fetchModelCatalog } from './modelCatalogClient'
import { stripHiddenReasoningLevels } from './filteredModels'
import { invalidateCachedModelCapabilities } from './modelCatalogParser'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import type { ModelCatalogConfig, ModelCatalogEntry } from './types'

export type ModelCatalogFetcher = (
    config: ModelCatalogConfig,
) => Promise<readonly ModelCatalogEntry[]>

let requestGeneration = 0
let activeCatalogConfig: ModelCatalogConfig | undefined

function isSameCatalogConfig(
    left: ModelCatalogConfig | undefined,
    right: ModelCatalogConfig,
): boolean {
    return left?.baseUrl.trim() === right.baseUrl.trim() && left.apiKey === right.apiKey
}

/**
 * Orchestrates fetching the remote model catalog and updating the pure modelCatalogStore.
 */
export async function refreshModelCatalog(
    config: ModelCatalogConfig,
    fetcher: ModelCatalogFetcher = fetchModelCatalog,
): Promise<void> {
    const generation = ++requestGeneration
    const cachedModels = useModelCatalogStore.getState().models
    const configChanged =
        activeCatalogConfig !== undefined && !isSameCatalogConfig(activeCatalogConfig, config)
    activeCatalogConfig = { baseUrl: config.baseUrl.trim(), apiKey: config.apiKey }
    useModelCatalogStore.getState().setCatalog({
        ...(configChanged
            ? { models: invalidateCachedModelCapabilities(cachedModels) }
            : {}),
        status: 'loading',
        error: null,
    })

    try {
        const models = stripHiddenReasoningLevels(await fetcher(config))
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
