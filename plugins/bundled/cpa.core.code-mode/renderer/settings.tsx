import { useEffect, useState } from 'react'
import {
    CustomSelect,
    SettingsCard,
    SettingsRow,
    SettingsSection,
    ToggleSwitch,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import type { AppSettings } from '@cpa/plugin-api'
import { codeModeConfiguration } from '../shared/configuration'

const CONTROL_CLASS = cn(
    'rounded-lg border border-[var(--border-subtle)]',
    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-[inherit]',
    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
)

const NUMBER_KEYS = ['defaultExecYieldMs', 'defaultWaitYieldMs', 'maxOutputTokens'] as const
const NUMBER_UNITS: Partial<Record<(typeof NUMBER_KEYS)[number], string>> = {
    defaultExecYieldMs: 'codeMode.unit.ms',
    defaultWaitYieldMs: 'codeMode.unit.ms',
}
const LIST_KEYS = ['excludedToolNames', 'directOnlyToolNames'] as const

/**
 * Code Mode settings laid out like the other CPA settings sections.
 */
export function CodeModeSettings() {
    const services = useHostServices()
    const { t } = useTranslation()
    const [snapshot, setSnapshot] = useState<Partial<AppSettings>>(() => services?.settings.getSnapshot?.() ?? {})
    const [error, setError] = useState('')
    useEffect(() => {
        if (!services) return
        if (!services.settings.getSnapshot) void services.settings.get().then(setSnapshot).catch((failure) => setError(String(failure)))
        return services.settings.subscribe?.(setSnapshot)
    }, [services])
    const config = codeModeConfiguration(snapshot)
    const save = (patch: Partial<AppSettings>) => {
        setSnapshot((previous) => ({ ...previous, ...patch }))
        if (services?.settings.hydrate) services.settings.hydrate(patch)
        else void services?.settings.update(patch).catch((failure) => setError(String(failure)))
    }

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12 font-[inherit]">
            <div className="space-y-1">
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                    {t('codeMode.title')}
                </h1>
                <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
                    {t('codeMode.description')}
                </p>
            </div>

            <SettingsCard>
                <SettingsRow
                    title={t('codeMode.mode')}
                    description={t('codeMode.mode.desc')}
                    control={
                        <CustomSelect
                            ariaLabel={t('codeMode.mode')}
                            value={config.toolMode}
                            options={(['direct', 'code', 'code-only'] as const).map((value) => ({
                                value,
                                label: t(`codeMode.modes.${value}`),
                            }))}
                            onChange={(toolMode) => save({ toolMode })}
                            triggerClassName={cn(CONTROL_CLASS, 'py-1.5 pl-2.5 pr-2')}
                        />
                    }
                />
                <SettingsRow
                    last
                    title={t('codeMode.disableWhenUnavailable')}
                    description={t('codeMode.disableWhenUnavailable.desc')}
                    control={
                        <ToggleSwitch
                            checked={config.disableWhenUnavailable}
                            label={t('codeMode.disableWhenUnavailable')}
                            onChange={(disableWhenUnavailable) => save({ disableWhenUnavailable })}
                        />
                    }
                />
            </SettingsCard>

            <SettingsSection title={t('codeMode.section.limits')}>
                <SettingsCard>
                    {NUMBER_KEYS.map((key, index) => (
                        <SettingsRow
                            key={key}
                            last={index === NUMBER_KEYS.length - 1}
                            title={t(`codeMode.${key}`)}
                            description={t(`codeMode.${key}.desc`)}
                            control={
                                <label className="flex items-center gap-1.5">
                                    <input
                                        className={cn(CONTROL_CLASS, 'w-[120px] text-right [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none')}
                                        aria-label={t(`codeMode.${key}`)}
                                        type="number"
                                        inputMode="numeric"
                                        min={0}
                                        max={Number.MAX_SAFE_INTEGER}
                                        step={1}
                                        value={config[key]}
                                        onChange={(event) => {
                                            const value = Number(event.target.value)
                                            if (Number.isSafeInteger(value) && value >= 0) save({ [key]: value })
                                        }}
                                    />
                                    {NUMBER_UNITS[key] ? (
                                        <span className="text-[12px] text-[var(--text-muted)]">{t(NUMBER_UNITS[key])}</span>
                                    ) : null}
                                </label>
                            }
                        />
                    ))}
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title={t('codeMode.section.tools')}>
                <SettingsCard>
                    {LIST_KEYS.map((key, index) => (
                        <SettingsRow
                            key={key}
                            last={index === LIST_KEYS.length - 1}
                            title={t(`codeMode.${key}`)}
                            description={t(`codeMode.${key}.desc`)}
                            control={
                                <input
                                    key={config[key].join(',')}
                                    className={cn(CONTROL_CLASS, 'w-[260px]')}
                                    aria-label={t(`codeMode.${key}`)}
                                    defaultValue={config[key].join(', ')}
                                    onBlur={(event) => save({
                                        [key]: event.target.value.split(',').map((name) => name.trim()).filter(Boolean),
                                    })}
                                />
                            }
                        />
                    ))}
                </SettingsCard>
            </SettingsSection>

            {error ? <p role="alert" className="text-[13px] text-[var(--text-secondary)]">{error}</p> : null}
        </div>
    )
}
