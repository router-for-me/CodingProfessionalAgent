import { useEffect, useState } from 'react'
import {
    SettingsCard,
    SettingsRow,
    ToggleSwitch,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    SubagentRolesSection,
    getDefaultSubagentRoles,
    type SubagentRole,
} from './SubagentRolesSection.js'

export type { SubagentRole }

export interface SubagentsSettings {
    enabled: boolean
    concurrency: number
    maxPerSession: number
    maxDepth: number
    roles?: SubagentRole[]
}

const STORAGE_KEY = 'cpa.settings.subagents'

export const DEFAULT_SUBAGENT_SETTINGS: SubagentsSettings = {
    enabled: true,
    concurrency: 10,
    maxPerSession: 3,
    maxDepth: 1,
    roles: getDefaultSubagentRoles(),
}

function loadInitialSettings(t?: any): SubagentsSettings {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            const raw = window.localStorage.getItem(STORAGE_KEY)
            if (raw) {
                const parsed = JSON.parse(raw)
                return {
                    enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_SUBAGENT_SETTINGS.enabled,
                    concurrency: typeof parsed.concurrency === 'number' ? parsed.concurrency : DEFAULT_SUBAGENT_SETTINGS.concurrency,
                    maxPerSession: typeof parsed.maxPerSession === 'number' ? parsed.maxPerSession : DEFAULT_SUBAGENT_SETTINGS.maxPerSession,
                    maxDepth: typeof parsed.maxDepth === 'number' ? parsed.maxDepth : DEFAULT_SUBAGENT_SETTINGS.maxDepth,
                    roles: Array.isArray(parsed.roles) ? parsed.roles : getDefaultSubagentRoles(t),
                }
            }
        }
    } catch {
        // Fallback to default if reading storage fails
    }
    return {
        ...DEFAULT_SUBAGENT_SETTINGS,
        roles: getDefaultSubagentRoles(t),
    }
}

function saveSettings(settings: SubagentsSettings): void {
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
        }
    } catch {
        // Ignore storage write failures
    }
}

/**
 * Compact numeric input matching SettingsPercentInput style:
 * - Hides native spinner buttons
 * - Allows incrementing/decrementing via ArrowUp/ArrowDown keys
 * - Clamps input within [min, max] range on blur
 */
export function SettingsNumberInput({
    value,
    onChange,
    ariaLabel,
    min = 1,
    max = 100,
    step = 1,
}: {
    value: number
    onChange: (value: number) => void
    ariaLabel: string
    min?: number
    max?: number
    step?: number
}) {
    const [draft, setDraft] = useState(String(value))

    useEffect(() => {
        setDraft(String(value))
    }, [value])

    const commit = () => {
        const next = Number(draft)
        if (!Number.isFinite(next)) {
            setDraft(String(value))
            return
        }
        const clamped = Math.min(max, Math.max(min, Math.round(next)))
        setDraft(String(clamped))
        onChange(clamped)
    }

    return (
        <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={step}
            aria-label={ariaLabel}
            value={draft}
            className={cn(
                'w-[72px] rounded-lg border border-[var(--border-subtle)]',
                'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-right text-[12px]',
                'text-[var(--text-primary)] font-[inherit]',
                'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                '[&::-webkit-outer-spin-button]:appearance-none'
            )}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.currentTarget.blur()
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    const current = Number(draft)
                    const base = Number.isFinite(current) ? current : value
                    const next = Math.min(max, base + step)
                    setDraft(String(next))
                    onChange(next)
                } else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    const current = Number(draft)
                    const base = Number.isFinite(current) ? current : value
                    const next = Math.max(min, base - step)
                    setDraft(String(next))
                    onChange(next)
                }
            }}
        />
    )
}

/**
 * Subagents settings section: configure enablement, concurrency, and maximum depth.
 */
export function SubagentsSection() {
    const { t } = useTranslation()
    const services = useHostServices()

    const [settings, setSettings] = useState<SubagentsSettings>(() => {
        const fromHost = services?.settings?.getSnapshot?.()?.subagents
        if (fromHost) {
            return {
                enabled: typeof fromHost.enabled === 'boolean' ? fromHost.enabled : DEFAULT_SUBAGENT_SETTINGS.enabled,
                concurrency: typeof fromHost.concurrency === 'number' ? fromHost.concurrency : DEFAULT_SUBAGENT_SETTINGS.concurrency,
                maxPerSession: typeof fromHost.maxPerSession === 'number' ? fromHost.maxPerSession : DEFAULT_SUBAGENT_SETTINGS.maxPerSession,
                maxDepth: typeof fromHost.maxDepth === 'number' ? fromHost.maxDepth : DEFAULT_SUBAGENT_SETTINGS.maxDepth,
                roles: Array.isArray(fromHost.roles) ? fromHost.roles : (loadInitialSettings(t).roles ?? getDefaultSubagentRoles(t)),
            }
        }
        return loadInitialSettings(t)
    })

    useEffect(() => {
        if (!services?.settings?.subscribe) return
        return services.settings.subscribe((appSettings) => {
            if (appSettings?.subagents) {
                setSettings((prev) => ({
                    ...prev,
                    ...appSettings.subagents,
                }))
            }
        })
    }, [services])

    const updateSettings = (patch: Partial<SubagentsSettings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch }
            saveSettings(next)
            if (services?.settings?.setSubagentSettings) {
                services.settings.setSubagentSettings(next)
            } else if (services?.settings?.update) {
                void services.settings.update({ subagents: next } as any)
            }
            return next
        })
    }

    return (
        <div className="flex w-full flex-col">
            <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 pt-8 pb-16">
                <div className="mb-6">
                    <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                        {t('settings.subagents.title', 'Subagents')}
                    </h1>
                    <p className="mt-1 text-[13px] text-[var(--text-muted)] font-[inherit]">
                        {t(
                            'settings.subagents.subtitle',
                            'Configure subagent enablement, concurrency limits, and call depth.'
                        )}
                    </p>
                </div>

                <div className="space-y-6">
                    <SettingsCard>
                        <SettingsRow
                            id="subagentsEnabled"
                            last={!settings.enabled}
                            title={t('settings.subagents.enabled', 'Subagents')}
                            description={t(
                                'settings.subagents.enabledDesc',
                                'Enable subagent collaboration to dispatch parallel or nested subtasks.'
                            )}
                            control={
                                <ToggleSwitch
                                    checked={settings.enabled}
                                    onChange={(enabled) => updateSettings({ enabled })}
                                    label={t('settings.subagents.enabled', 'Subagents')}
                                />
                            }
                        />

                        {settings.enabled ? (
                            <>
                                <SettingsRow
                                    id="subagentsConcurrency"
                                    title={t(
                                        'settings.subagents.concurrency',
                                        'Global subagent concurrency'
                                    )}
                                    description={t(
                                        'settings.subagents.concurrencyDesc',
                                        'Maximum number of concurrently running subagents across the entire application.'
                                    )}
                                    control={
                                        <SettingsNumberInput
                                            value={settings.concurrency}
                                            onChange={(concurrency) => updateSettings({ concurrency })}
                                            ariaLabel={t(
                                                'settings.subagents.concurrency',
                                                'Global subagent concurrency'
                                            )}
                                            min={1}
                                            max={50}
                                            step={1}
                                        />
                                    }
                                />

                                <SettingsRow
                                    id="subagentsMaxPerSession"
                                    title={t(
                                        'settings.subagents.maxPerSession',
                                        'Max concurrent subagents per session'
                                    )}
                                    description={t(
                                        'settings.subagents.maxPerSessionDesc',
                                        'Maximum number of concurrently running subagents in a single session.'
                                    )}
                                    control={
                                        <SettingsNumberInput
                                            value={settings.maxPerSession}
                                            onChange={(maxPerSession) => updateSettings({ maxPerSession })}
                                            ariaLabel={t(
                                                'settings.subagents.maxPerSession',
                                                'Max concurrent subagents per session'
                                            )}
                                            min={1}
                                            max={20}
                                            step={1}
                                        />
                                    }
                                />

                                <SettingsRow
                                    id="subagentsMaxDepth"
                                    last
                                    title={t(
                                        'settings.subagents.maxDepth',
                                        'Maximum subagent depth'
                                    )}
                                    description={t(
                                        'settings.subagents.maxDepthDesc',
                                        'Maximum depth for subagents recursively creating nested subtasks.'
                                    )}
                                    control={
                                        <SettingsNumberInput
                                            value={settings.maxDepth}
                                            onChange={(maxDepth) => updateSettings({ maxDepth })}
                                            ariaLabel={t(
                                                'settings.subagents.maxDepth',
                                                'Maximum subagent depth'
                                            )}
                                            min={1}
                                            max={10}
                                            step={1}
                                        />
                                    }
                                />
                            </>
                        ) : null}
                    </SettingsCard>

                    <SubagentRolesSection
                        roles={settings.roles ?? []}
                        onChange={(roles) => updateSettings({ roles })}
                    />
                </div>
            </div>
        </div>
    )
}
