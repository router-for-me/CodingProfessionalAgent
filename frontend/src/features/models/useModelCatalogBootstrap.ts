import { useEffect, useRef } from 'react'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { refreshModelCatalog } from '@/features/models/modelCatalogService'

const MODEL_CATALOG_REFRESH_DEBOUNCE_MS = 400

export function useModelCatalogBootstrap(): void {
    const cliProxyApi = useSettingsStore((state) => state.settings.cliProxyApi)
    const reset = useModelCatalogStore((state) => state.reset)
    const lastConfigRef = useRef<{ baseUrl: string; apiKey: string } | null>(null)

    useEffect(() => {
        const baseUrl = cliProxyApi.baseUrl.trim()
        const apiKey = cliProxyApi.apiKey.trim()

        if (!baseUrl || !apiKey) {
            lastConfigRef.current = null
            reset()
            return
        }

        const isSameConfig =
            lastConfigRef.current?.baseUrl === baseUrl &&
            lastConfigRef.current?.apiKey === apiKey
        const currentStatus = useModelCatalogStore.getState().status

        // If this exact config was already successfully loaded and ready, skip redundant re-fetch
        if (isSameConfig && currentStatus === 'ready') {
            return
        }

        const timer = window.setTimeout(() => {
            lastConfigRef.current = { baseUrl, apiKey }
            void refreshModelCatalog({ baseUrl, apiKey })
        }, MODEL_CATALOG_REFRESH_DEBOUNCE_MS)

        return () => {
            window.clearTimeout(timer)
        }
    }, [cliProxyApi.baseUrl, cliProxyApi.apiKey, reset])
}
