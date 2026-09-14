import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogEntry, ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { parseSettings, SETTINGS_KEY, type WebSearchSettings } from '../shared/types.js'

const noopSubscribe = () => () => {}

export function useWebSearchConfiguration(client: PluginCapabilityClient | undefined, catalog: ModelCatalogService) {
    const models = useSyncExternalStore(catalog.subscribe ?? noopSubscribe, () => catalog.getModels()) as readonly ModelCatalogEntry[]
    const status = useSyncExternalStore(catalog.subscribe ?? noopSubscribe, () => catalog.getStatus?.() ?? 'idle')
    const [settings, setSettings] = useState<WebSearchSettings>({ enabled: false, modelId: '' })
    const [busy, setBusy] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        let cancelled = false
        if (!client) { setError(true); setBusy(false); return }
        void client.invoke('kvstore:get', [SETTINGS_KEY]).then((value) => {
            if (!cancelled) setSettings(parseSettings(value))
        }).catch(() => { if (!cancelled) setError(true) }).finally(() => { if (!cancelled) setBusy(false) })
        return () => { cancelled = true }
    }, [client])

    const ready = status === 'ready' || status === 'success'
    const candidates = useMemo(
        () => ready ? models.filter((model) => model.cpaCapabilities?.webSearch === true) : [],
        [models, ready],
    )
    const valid = candidates.some((model) => model.id === settings.modelId)

    const save = async (patch: Partial<WebSearchSettings>) => {
        if (!client || busy) return
        const next = { ...settings, ...patch }
        setBusy(true)
        setError(false)
        try {
            await client.invoke('kvstore:set', [SETTINGS_KEY, next])
            await client.invoke('kvstore:save', [])
            setSettings(next)
        } catch {
            setError(true)
        } finally {
            setBusy(false)
        }
    }

    return { settings, busy, error, ready, candidates, valid, save }
}
