import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { normalizeModelsUrl, parseModelCatalog } from './modelCatalogParser'
import type {
    HttpTransport,
    ModelCatalogConfig,
    ModelCatalogEntry,
} from './types'

const MODEL_CATALOG_TIMEOUT_MS = 60_000

/**
 * Direct HTTP transport-based model catalog fetcher for CLIProxyAPI endpoint.
 */
export async function fetchModelCatalogDirect(
    config: ModelCatalogConfig,
    transport?: HttpTransport,
): Promise<readonly ModelCatalogEntry[]> {
    if (!config.baseUrl.trim() || !config.apiKey.trim()) {
        throw new Error('Model catalog configuration is incomplete')
    }

    const request = {
        url: normalizeModelsUrl(config.baseUrl),
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: '',
        timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
    }

    let response
    try {
        const activeTransport = transport ?? (await import('./transport')).electronHttpTransport
        response = await activeTransport.request(request)
    } catch {
        throw new Error('Model catalog request failed')
    }

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Model catalog request failed with status ${response.status}`)
    }

    let payload: unknown
    try {
        payload = JSON.parse(response.body)
    } catch {
        throw new Error('Invalid model catalog JSON')
    }

    const models = parseModelCatalog(payload)
    if (models.length === 0) {
        throw new Error('No available models')
    }
    return models
}

/**
 * Unified model catalog fetcher that delegates to registered model catalog providers
 * or falls back to direct CLIProxyAPI transport.
 */
export async function fetchModelCatalog(
    config: ModelCatalogConfig,
    transport?: HttpTransport,
    providerId?: string,
): Promise<readonly ModelCatalogEntry[]> {
    const activeTransport = transport ?? (await import('./transport')).electronHttpTransport

    const provider = rendererRegistry.getModelCatalogProvider(providerId)
    if (provider) {
        return provider.fetchCatalog(config, activeTransport)
    }

    return fetchModelCatalogDirect(config, activeTransport)
}
