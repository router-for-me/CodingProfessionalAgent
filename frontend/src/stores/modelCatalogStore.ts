import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { FALLBACK_MODEL_CATALOG } from '@/features/models/fallbackModels'
import type { ModelCatalogEntry } from '@/features/models/types'

export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ModelCatalogState {
    models: readonly ModelCatalogEntry[]
    status: ModelCatalogStatus
    error: string | null
    setCatalog: (patch: Partial<Pick<ModelCatalogState, 'models' | 'status' | 'error'>>) => void
    setModels: (models: readonly ModelCatalogEntry[]) => void
    setStatus: (status: ModelCatalogStatus) => void
    setError: (error: string | null) => void
    reset: () => void
    hydrate: (models: readonly ModelCatalogEntry[]) => void
}

export function createModelCatalogStore(): UseBoundStore<StoreApi<ModelCatalogState>> {
    return create<ModelCatalogState>((set) => ({
        models: FALLBACK_MODEL_CATALOG,
        status: 'idle',
        error: null,

        setCatalog: (patch) => set(patch),
        setModels: (models) => set({ models }),
        setStatus: (status) => set({ status }),
        setError: (error) => set({ error }),

        reset: () => {
            set({
                models: FALLBACK_MODEL_CATALOG,
                status: 'idle',
                error: null,
            })
        },

        hydrate: (models) => {
            if (Array.isArray(models) && models.length > 0) {
                set({
                    models,
                    status: 'idle',
                    error: null,
                })
            }
        },
    }))
}

export const useModelCatalogStore = createModelCatalogStore()
