import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { CustomSelect, useTranslation } from '@cpa/plugin-ui'
import { parseSettings, SETTINGS_KEY, type WebSearchSettings } from '../shared/types.js'

const noopSubscribe = () => () => {}

export function SearchSettings({ client, catalog }: { client?: PluginCapabilityClient; catalog: ModelCatalogService }) {
    const { t } = useTranslation()
    const models = useSyncExternalStore(catalog.subscribe ?? noopSubscribe, () => catalog.getModels())
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
    const candidates = ready ? models.filter((model) => model.cpaCapabilities?.webSearch === true) : []
    const valid = candidates.some((model) => model.id === settings.modelId)
    const options = [
        { value: '', label: t('webSearch.chooseModel') },
        ...(!valid && settings.modelId ? [{ value: settings.modelId, label: `${settings.modelId} (${t('webSearch.unavailable')})` }] : []),
        ...candidates.map((model) => ({ value: model.id as string, label: model.label as string })),
    ]
    const save = async (patch: Partial<WebSearchSettings>) => {
        if (!client || busy) return
        const next = { ...settings, ...patch }
        setBusy(true)
        setError(false)
        try {
            await client.invoke('kvstore:set', [SETTINGS_KEY, next])
            await client.invoke('kvstore:save', [])
            setSettings(next)
        } catch { setError(true) }
        finally { setBusy(false) }
    }

    return <section className="space-y-5 text-[var(--text-primary)] font-[inherit]" aria-label={t('webSearch.title')}>
        <div>
            <h2 className="text-[1.15em] font-[inherit]">{t('webSearch.title')}</h2>
            <p className="mt-2 text-[var(--text-secondary)]">{t('webSearch.description')}</p>
        </div>
        <label className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4">
            <span>{t('webSearch.enable')}</span>
            <input type="checkbox" checked={settings.enabled} disabled={busy || !client} onChange={(event) => { void save({ enabled: event.target.checked }) }} />
        </label>
        <div className="space-y-2">
            <p>{t('webSearch.model')}</p>
            <CustomSelect value={settings.modelId} options={options} ariaLabel={t('webSearch.model')} fullWidth disabled={busy || !client || !ready} onChange={(modelId) => { void save({ modelId }) }} />
        </div>
        {(!ready || !candidates.length || (settings.enabled && !valid)) && <p role="status" className="text-[var(--text-muted)]">{t('webSearch.noModels')}</p>}
        <p className="text-[var(--text-muted)]">{t('webSearch.privacy')}</p>
        {error && <p role="alert" className="text-[var(--text-primary)]">{t('webSearch.settingsError')}</p>}
    </section>
}
