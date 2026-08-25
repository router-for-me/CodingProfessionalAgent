/**
 * Neutral Model Catalog SPI and registry.
 * Decouples model catalog discovery and capabilities from specific backend vendors.
 */

import type {
    ModelCapabilities,
    ModelCatalogEntry,
    ModelCatalogProviderContribution,
} from '@cpa/plugin-api'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import type { ModelCatalogConfig } from '@/features/models/types'

export type {
    ModelCapabilities,
    ModelCatalogEntry,
    ModelCatalogProviderContribution,
    ModelCatalogConfig,
}

export interface FetchModelCatalogOptions {
    providerId?: string
    registry?: RendererRegistry
}

export interface GetModelCapabilitiesOptions {
    providerId?: string
    registry?: RendererRegistry
}

/**
 * Infers default standard model capabilities from catalog entry fields.
 */
export function inferDefaultModelCapabilities(model: ModelCatalogEntry): ModelCapabilities {
    return {
        supportsImages: model.input.includes('image'),
        supportsFast: Boolean(model.supportsFast),
        reasoningLevels: (model.reasoningLevels ?? []).map((r) => r.id),
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
    }
}

/**
 * Registry and lifecycle manager for model catalog providers.
 */
export class ModelCatalogProviderRegistry {
    private readonly extensionRegistry: RendererRegistry

    constructor(extensionRegistry: RendererRegistry = rendererRegistry) {
        this.extensionRegistry = extensionRegistry
    }

    /**
     * Resolves a model catalog provider contribution by ID, protocolProviderId, or fallback.
     */
    public getProvider(
        idOrProtocolId?: string
    ): ModelCatalogProviderContribution | undefined {
        return this.extensionRegistry.getModelCatalogProvider(
            idOrProtocolId
        ) as unknown as ModelCatalogProviderContribution | undefined
    }

    /**
     * Lists all registered model catalog provider contributions.
     */
    public getProviders(): readonly ModelCatalogProviderContribution[] {
        return this.extensionRegistry.getModelCatalogProviders() as unknown as readonly ModelCatalogProviderContribution[]
    }

    /**
     * Fetches model catalog through the designated (or default) provider.
     */
    public async fetchCatalog(
        config: ModelCatalogConfig,
        providerId?: string
    ): Promise<readonly ModelCatalogEntry[]> {
        const provider = this.getProvider(providerId)
        if (!provider) {
            throw new Error(
                `No model catalog provider found (providerId: ${providerId ?? 'default'})`
            )
        }

        return provider.fetchCatalog(config)
    }

    /**
     * Resolves model capabilities from provider or falls back to standard properties.
     */
    public getModelCapabilities(
        model: ModelCatalogEntry,
        providerId?: string
    ): ModelCapabilities {
        const provider = this.getProvider(providerId)
        if (provider && typeof provider.getModelCapabilities === 'function') {
            return provider.getModelCapabilities(model)
        }
        return inferDefaultModelCapabilities(model)
    }
}

/**
 * Helper to fetch model catalog using ModelCatalogProviderRegistry.
 */
export async function fetchModelCatalogFromProvider(
    config: ModelCatalogConfig,
    options?: FetchModelCatalogOptions
): Promise<readonly ModelCatalogEntry[]> {
    const registry = options?.registry ?? rendererRegistry
    const providerRegistry = new ModelCatalogProviderRegistry(registry)
    return providerRegistry.fetchCatalog(config, options?.providerId)
}

/**
 * Helper to get model capabilities using ModelCatalogProviderRegistry.
 */
export function getModelCapabilities(
    model: ModelCatalogEntry,
    options?: GetModelCapabilitiesOptions
): ModelCapabilities {
    const registry = options?.registry ?? rendererRegistry
    const providerRegistry = new ModelCatalogProviderRegistry(registry)
    return providerRegistry.getModelCapabilities(model, options?.providerId)
}
