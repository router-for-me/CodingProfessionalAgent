import { useCallback, useSyncExternalStore } from 'react'
import type { ModelCatalogEntry, ModelCatalogService } from '@cpa/plugin-api'
import { useHostServices } from './HostServicesContext.js'

const EMPTY_MODELS: readonly ModelCatalogEntry[] = []

export function useModelCatalog() {
    const service = useHostServices()?.models
    const subscribe = useCallback((listener: () => void) =>
        service?.subscribe?.(listener) ?? (() => {}), [service])
    const models = useSyncExternalStore<readonly ModelCatalogEntry[]>(
        subscribe,
        useCallback(() => service?.getModels?.() ?? EMPTY_MODELS, [service]),
        () => EMPTY_MODELS,
    )
    const status = useSyncExternalStore<ReturnType<NonNullable<ModelCatalogService['getStatus']>>>(
        subscribe,
        useCallback(() => service?.getStatus?.() ?? 'idle', [service]),
        () => 'idle',
    )
    const error = useSyncExternalStore(
        subscribe,
        useCallback(() => service?.getError?.() ?? null, [service]),
        () => null,
    )
    return { models, status, error }
}
