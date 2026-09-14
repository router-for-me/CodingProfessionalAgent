import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { Info } from 'lucide-react'
import { CustomSelect, ToggleSwitch, useTranslation } from '@cpa/plugin-ui'
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

    return <section className="mx-auto w-full max-w-[760px] space-y-6 px-8 pb-12 pt-8 font-[inherit] text-[var(--text-primary)] select-none" aria-label={t('webSearch.title')}>
        <header>
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('webSearch.title')}
            </h1>
        </header>

        <section className="space-y-2">
            <h2 className="px-0.5 text-[12px] font-medium text-[var(--text-secondary)]">
                {t('webSearch.configuration')}
            </h2>
            <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                <div className="flex items-start gap-4 border-b border-[var(--border-subtle)] px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{t('webSearch.enable')}</h3>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">{t('webSearch.enableHint')}</p>
                    </div>
                    <div className="flex shrink-0 items-center pt-0.5">
                        <ToggleSwitch label={t('webSearch.enable')} checked={settings.enabled} disabled={busy || !client} onChange={(enabled) => { void save({ enabled }) }} />
                    </div>
                </div>

                <div className="flex items-start gap-4 px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                        <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{t('webSearch.model')}</h3>
                        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">{t('webSearch.modelHint')}</p>
                    </div>
                    <CustomSelect
                        value={settings.modelId}
                        options={options}
                        ariaLabel={t('webSearch.model')}
                        className="w-[260px] shrink-0"
                        triggerClassName="w-full justify-between"
                        disabled={busy || !client || !ready}
                        onChange={(modelId) => { void save({ modelId }) }}
                    />
                </div>

                {(!ready || !candidates.length || (settings.enabled && !valid)) && <div role="status" className="flex items-start gap-2 border-t border-[var(--border-subtle)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <p>{t(!ready ? 'webSearch.catalogPending' : 'webSearch.noModels')}</p>
                </div>}
            </div>
        </section>

        <section className="space-y-2">
            <h2 className="px-0.5 text-[12px] font-medium text-[var(--text-secondary)]">
                {t('webSearch.privacyTitle')}
            </h2>
            <aside className="space-y-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--text-muted)]" aria-label={t('webSearch.privacyTitle')}>
                <p>{t('webSearch.privacy')}</p>
                <p>{t('webSearch.approvalHint')}</p>
            </aside>
        </section>

        {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <p>{t('webSearch.settingsError')}</p>
        </div>}
    </section>
}
