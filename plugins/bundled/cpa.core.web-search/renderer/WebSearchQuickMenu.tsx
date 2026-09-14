import type { AttachmentProviderSubmenuProps, ModelCatalogService, PluginCapabilityClient } from '@cpa/plugin-api'
import { CustomSelect, ToggleSwitch, useTranslation } from '@cpa/plugin-ui'
import { Globe, Info } from 'lucide-react'
import { useWebSearchConfiguration } from './useWebSearchConfiguration.js'

export function WebSearchQuickMenu({
    client,
    catalog,
}: AttachmentProviderSubmenuProps & { client?: PluginCapabilityClient; catalog: ModelCatalogService }) {
    const { t } = useTranslation()
    const { settings, busy, error, ready, candidates, valid, save } = useWebSearchConfiguration(client, catalog)
    const options = [
        { value: '', label: t('webSearch.chooseModel') },
        ...(!valid && settings.modelId ? [{ value: settings.modelId, label: `${settings.modelId} (${t('webSearch.unavailable')})` }] : []),
        ...candidates.map((model) => ({ value: model.id, label: model.label })),
    ]

    return <section className="space-y-3 px-2 pb-2 pt-1 font-[inherit] text-[var(--text-primary)]" aria-label={t('webSearch.quick.title')}>
        <header className="flex items-center gap-2 px-0.5">
            <Globe className="size-4 text-[var(--text-secondary)]" aria-hidden />
            <div>
                <h2 className="text-[13px] font-medium">{t('webSearch.quick.title')}</h2>
                <p className="text-[11px] leading-snug text-[var(--text-muted)]">{t('webSearch.quick.globalHint')}</p>
            </div>
        </header>

        <div className="space-y-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2.5">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-[var(--text-secondary)]">{t('webSearch.quick.globalToggle')}</span>
                <ToggleSwitch
                    label={t('webSearch.quick.globalToggle')}
                    checked={settings.enabled}
                    disabled={busy || !client}
                    onChange={(enabled) => { void save({ enabled }) }}
                />
            </div>
            <CustomSelect
                value={settings.modelId}
                options={options}
                ariaLabel={t('webSearch.model')}
                fullWidth
                triggerClassName="w-full justify-between"
                disabled={busy || !client || !ready}
                onChange={(modelId) => { void save({ modelId }) }}
            />
        </div>

        {(!ready || !candidates.length || (settings.enabled && !valid)) && <p role="status" className="flex gap-1.5 px-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            {t(!ready ? 'webSearch.quick.catalogPending' : 'webSearch.quick.noModels')}
        </p>}
        {error && <p role="alert" className="flex gap-1.5 px-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">
            <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
            {t('webSearch.settingsError')}
        </p>}
    </section>
}
