import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
    CustomSelect,
    cn,
    createExtensibleComponent,
    useHostService,
    useModelCatalog,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    ALL_SYSTEM_PROMPT_LANGUAGES,
    FileSystemServiceToken,
    PersonalizationServiceToken,
    SettingsServiceToken,
    UiServiceToken,
    type ModelCatalogEntry,
    type ModelSettingsConfig,
    type PersonalityTone,
    type SystemPromptEnhancementSettings,
    type SystemPromptLanguage,
    getAppConfigDirName,
    normalizeSystemPromptEnhancementSettings,
} from '@cpa/plugin-api'
import { SettingsCard, SettingsRow, ToggleSwitch } from './SettingsControls.js'
import { SystemPromptEnhancementAppliedModels } from './SystemPromptEnhancementAppliedModels.js'

function getEnabledOrderedModels(
    catalogModels: readonly ModelCatalogEntry[],
    modelSettings?: ModelSettingsConfig,
): readonly ModelCatalogEntry[] {
    const modelOrder = modelSettings?.modelOrder
    let ordered = catalogModels
    if (modelOrder && modelOrder.length > 0) {
        const rankMap = new Map<string, number>(
            modelOrder.map((id, index) => [id, index]),
        )
        ordered = [...catalogModels]
            .map((model, index) => ({ model, index }))
            .sort((a, b) => {
                const rankA = rankMap.has(a.model.id)
                    ? rankMap.get(a.model.id)!
                    : modelOrder.length + a.index
                const rankB = rankMap.has(b.model.id)
                    ? rankMap.get(b.model.id)!
                    : modelOrder.length + b.index
                return rankA - rankB || a.index - b.index
            })
            .map(({ model }) => model)
    }

    if (!modelSettings || modelSettings.enableAll) {
        return ordered
    }

    return ordered.filter((model) => modelSettings.models?.[model.id]?.enabled !== false)
}

export interface PersonalizationSectionProps {
    children?: ReactNode
}

/** Encode a string to base64 using UTF-8 safe TextEncoder. */
function stringToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
}

/** Decode base64 to a UTF-8 string. */
function base64ToString(b64: string): string {
    if (!b64) return ''
    try {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i)
        }
        return new TextDecoder().decode(bytes)
    } catch {
        return ''
    }
}

/**
 * Personalization settings matching CPA 1:1.
 * Custom instructions are loaded from and saved to ~/.coding-professional-agent/AGENTS.md.
 */
export function BasePersonalizationSection(props: PersonalizationSectionProps = {}) {
    const { children } = props
    const { t } = useTranslation()
    const uiService = useHostService(UiServiceToken)
    const settingsService = useHostService(SettingsServiceToken)
    const personalizationService = useHostService(PersonalizationServiceToken)
    const fileSystemService = useHostService(FileSystemServiceToken)
    const settings = useSettings()
    const { models: catalogModels } = useModelCatalog()

    const pushToast = (msg: string) => uiService?.pushToast(msg)

    const personality = (settings.personality ?? 'pragmatic') as PersonalityTone
    const setPersonality = (val: PersonalityTone) => settingsService?.setPersonality?.(val)

    const enhancement = useMemo(
        () => normalizeSystemPromptEnhancementSettings(settings.systemPromptEnhancement),
        [settings.systemPromptEnhancement],
    )
    const updateEnhancement = useCallback(
        (partial: Partial<SystemPromptEnhancementSettings>) => {
            settingsService?.setSystemPromptEnhancement?.(partial)
        },
        [settingsService],
    )

    const enabledModels = useMemo(
        () => getEnabledOrderedModels(catalogModels, settings.modelSettings),
        [catalogModels, settings.modelSettings],
    )
    const modelOptions = useMemo(
        () =>
            enabledModels.map((model) => ({
                value: model.id,
                label: model.label || model.id,
            })),
        [enabledModels],
    )
    const selectedBuilderModelId = useMemo(() => {
        const availableIds = new Set(modelOptions.map((option) => option.value))
        if (enhancement.modelId && availableIds.has(enhancement.modelId)) {
            return enhancement.modelId
        }
        if (settings.modelId && availableIds.has(settings.modelId)) {
            return settings.modelId
        }
        return modelOptions[0]?.value ?? ''
    }, [enhancement.modelId, modelOptions, settings.modelId])

    const handleToggleLanguage = useCallback(
        (lang: SystemPromptLanguage) => {
            const current = enhancement.allowedLanguages
            if (current.includes(lang)) {
                if (current.length <= 1) return
                updateEnhancement({
                    allowedLanguages: current.filter((item) => item !== lang),
                })
                return
            }
            updateEnhancement({
                allowedLanguages: [...current, lang],
            })
        },
        [enhancement.allowedLanguages, updateEnhancement],
    )

    const handleSelectAllLanguages = useCallback(() => {
        updateEnhancement({
            allowedLanguages: [...ALL_SYSTEM_PROMPT_LANGUAGES],
        })
    }, [updateEnhancement])

    const [instructions, setInstructions] = useState('')
    const [saving, setSaving] = useState(false)

    const personalityOptions = useMemo(
        () => [
            {
                value: 'pragmatic' as PersonalityTone,
                label: t('settings.personalization.tone.pragmatic'),
            },
            {
                value: 'casual' as PersonalityTone,
                label: t('settings.personalization.tone.casual'),
            },
            {
                value: 'professional' as PersonalityTone,
                label: t('settings.personalization.tone.professional'),
            },
            {
                value: 'enthusiastic' as PersonalityTone,
                label: t('settings.personalization.tone.enthusiastic'),
            },
            {
                value: 'humorous' as PersonalityTone,
                label: t('settings.personalization.tone.humorous'),
            },
            {
                value: 'concise' as PersonalityTone,
                label: t('settings.personalization.tone.concise'),
            },
        ],
        [t],
    )

    // Load instructions
    useEffect(() => {
        let mounted = true
        const load = async () => {
            if (personalizationService?.loadInstructions) {
                try {
                    const text = await personalizationService.loadInstructions()
                    if (mounted) {
                        setInstructions(text ?? '')
                    }
                    return
                } catch {
                    if (mounted) setInstructions('')
                    return
                }
            }

            if (fileSystemService) {
                try {
                    const info = await fileSystemService.getRuntimeInfo?.()
                    const homeDir = info?.homeDir
                    if (!homeDir) return
                    const sep = homeDir.includes('\\') ? '\\' : '/'
                    const configDirName = (info as any)?.appConfigDirName || getAppConfigDirName((info as any)?.isDebug)
                    const filePath = `${homeDir}${sep}${configDirName}${sep}AGENTS.md`
                    const res = fileSystemService.readFileIfExists
                        ? await fileSystemService.readFileIfExists(filePath)
                        : await fileSystemService.readFile(filePath)
                    if (mounted && res?.dataBase64) {
                        setInstructions(base64ToString(res.dataBase64))
                    } else if (mounted && !res) {
                        setInstructions('')
                    }
                } catch {
                    if (mounted) {
                        setInstructions('')
                    }
                }
            }
        }
        void load()
        return () => {
            mounted = false
        }
    }, [personalizationService, fileSystemService])

    const handleSaveInstructions = useCallback(async () => {
        setSaving(true)
        try {
            if (personalizationService?.saveInstructions) {
                await personalizationService.saveInstructions(instructions)
                pushToast(t('settings.personalization.customInstructions.saved'))
                return
            }

            if (fileSystemService) {
                const info = await fileSystemService.getRuntimeInfo?.()
                const homeDir = info?.homeDir
                if (!homeDir) {
                    pushToast(t('settings.personalization.customInstructions.saveFailed'))
                    return
                }
                const sep = homeDir.includes('\\') ? '\\' : '/'
                const configDirName = (info as any)?.appConfigDirName || getAppConfigDirName((info as any)?.isDebug)
                const dirPath = `${homeDir}${sep}${configDirName}`
                const filePath = `${dirPath}${sep}AGENTS.md`

                if (fileSystemService.mkdirAll) {
                    await fileSystemService.mkdirAll(dirPath).catch(() => {})
                }
                const dataBase64 = stringToBase64(instructions)
                await fileSystemService.writeFile(filePath, dataBase64)
                pushToast(t('settings.personalization.customInstructions.saved'))
                return
            }

            pushToast(t('settings.personalization.customInstructions.saveFailed'))
        } catch {
            pushToast(t('settings.personalization.customInstructions.saveFailed'))
        } finally {
            setSaving(false)
        }
    }, [instructions, personalizationService, fileSystemService, pushToast, t])

    const learnMore = useCallback(() => {
        pushToast(t('toast.comingSoon'))
    }, [pushToast, t])

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            {/* Title */}
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.personalization.title')}
            </h1>

            {/* Custom Instructions Section */}
            <section className="space-y-2">
                <div className="flex items-center justify-between">
                    <h2 className="text-[14px] font-medium text-[var(--text-primary)]">
                        {t('settings.personalization.customInstructions')}
                    </h2>
                    <button
                        type="button"
                        disabled={saving}
                        className={cn(
                            'rounded-lg bg-[var(--bg-sidebar-hover)] px-3 py-1 text-[13px] font-medium',
                            'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar)] hover:text-[var(--text-primary)]',
                            'disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer',
                        )}
                        onClick={handleSaveInstructions}
                    >
                        {saving
                            ? t('settings.personalization.customInstructions.saving')
                            : t('settings.personalization.customInstructions.save')}
                    </button>
                </div>

                <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    {t('settings.personalization.customInstructions.desc')}{' '}
                    <button
                        type="button"
                        className="text-[var(--accent-blue)] hover:underline cursor-pointer"
                        onClick={learnMore}
                    >
                        {t('settings.personalization.learnMore')}
                    </button>
                </p>

                <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder={t(
                        'settings.personalization.customInstructions.placeholder',
                    )}
                    spellCheck={false}
                    className={cn(
                        'min-h-[190px] w-full rounded-xl border border-[var(--border-subtle)]',
                        'bg-[var(--bg-card)] p-3.5 text-[13px] font-mono leading-relaxed',
                        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                        'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 resize-y',
                    )}
                />
            </section>

            {/* Injected extensions / children */}
            {children}

            {/* Personality Section */}
            <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 flex-1 pr-4">
                        <div className="text-[13px] font-medium text-[var(--text-primary)]">
                            {t('settings.personalization.personality')}
                        </div>
                        <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                            {t('settings.personalization.personality.desc')}
                        </div>
                    </div>
                    <CustomSelect
                        value={personality}
                        options={personalityOptions}
                        ariaLabel={t('settings.personalization.personality')}
                        triggerClassName={cn(
                            'rounded-lg border border-[var(--border-subtle)]',
                            'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] text-[var(--text-primary)]',
                            'hover:bg-[var(--bg-sidebar)]',
                        )}
                        onChange={(val) => setPersonality(val as PersonalityTone)}
                    />
                </div>
            </div>

            {/* System Prompt Enhancement Section */}
            <section className="space-y-2">
                <div>
                    <h2 className="font-[inherit] text-[length:var(--ui-font-size)] text-[var(--text-primary)]">
                        {t('settings.personalization.systemPromptEnhancement')}
                    </h2>
                    <p className="mt-0.5 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] leading-relaxed text-[var(--text-muted)]">
                        {t('settings.personalization.systemPromptEnhancement.desc')}
                    </p>
                </div>

                <SettingsCard>
                    <SettingsRow
                        id="systemPromptEnhancement"
                        title={t('settings.personalization.systemPromptEnhancement.enable')}
                        description={t('settings.personalization.systemPromptEnhancement.enableDesc')}
                        inheritTypography
                        control={
                            <ToggleSwitch
                                checked={enhancement.enabled}
                                label={t('settings.personalization.systemPromptEnhancement')}
                                onChange={(next) => updateEnhancement({ enabled: next })}
                            />
                        }
                    />
                    <SettingsRow
                        id="systemPromptEnhancementModel"
                        title={t('settings.personalization.systemPromptEnhancement.model')}
                        description={t('settings.personalization.systemPromptEnhancement.modelDesc')}
                        inheritTypography
                        control={
                            <CustomSelect
                                value={selectedBuilderModelId}
                                options={
                                    modelOptions.length > 0
                                        ? modelOptions
                                        : [
                                              {
                                                  value: '',
                                                  label: t(
                                                      'settings.personalization.systemPromptEnhancement.noModels',
                                                  ),
                                              },
                                          ]
                                }
                                ariaLabel={t('settings.personalization.systemPromptEnhancement.model')}
                                disabled={modelOptions.length === 0}
                                triggerClassName={cn(
                                    'max-w-[240px] rounded-lg border border-[var(--border-subtle)]',
                                    'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] text-[var(--text-primary)]',
                                    'hover:bg-[var(--bg-sidebar)]',
                                )}
                                onChange={(val) => updateEnhancement({ modelId: val })}
                            />
                        }
                    />
                    <SystemPromptEnhancementAppliedModels
                        models={catalogModels}
                        value={enhancement.appliedModelIds}
                        onChange={(appliedModelIds) => updateEnhancement({ appliedModelIds })}
                    />
                    <SettingsRow
                        id="systemPromptEnhancementMultilingual"
                        title={t('settings.personalization.systemPromptEnhancement.multilingual')}
                        description={t('settings.personalization.systemPromptEnhancement.multilingualDesc')}
                        last={!enhancement.multilingualEnabled}
                        inheritTypography
                        control={
                            <ToggleSwitch
                                checked={enhancement.multilingualEnabled}
                                label={t('settings.personalization.systemPromptEnhancement.multilingual')}
                                onChange={(next) => updateEnhancement({ multilingualEnabled: next })}
                            />
                        }
                    />
                    {enhancement.multilingualEnabled ? (
                        <div
                            id="systemPromptEnhancementLanguages"
                            data-setting-id="systemPromptEnhancementLanguages"
                            className="space-y-3 px-3.5 py-3"
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0 flex-1">
                                    <div className="font-[inherit] text-[length:calc(var(--ui-font-size)-1px)] text-[var(--text-primary)]">
                                        {t('settings.personalization.systemPromptEnhancement.languages')}
                                    </div>
                                    <div className="mt-0.5 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] leading-relaxed text-[var(--text-muted)]">
                                        {t('settings.personalization.systemPromptEnhancement.languagesDesc')}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    disabled={
                                        enhancement.allowedLanguages.length >=
                                        ALL_SYSTEM_PROMPT_LANGUAGES.length
                                    }
                                    className={cn(
                                        'shrink-0 rounded-lg bg-[var(--bg-sidebar-hover)] px-2.5 py-1 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)]',
                                        'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar)] hover:text-[var(--text-primary)]',
                                        'disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer',
                                    )}
                                    onClick={handleSelectAllLanguages}
                                >
                                    {t('settings.personalization.systemPromptEnhancement.selectAll')}
                                </button>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {ALL_SYSTEM_PROMPT_LANGUAGES.map((lang) => {
                                    const selected = enhancement.allowedLanguages.includes(lang)
                                    const isLastSelected =
                                        selected && enhancement.allowedLanguages.length <= 1
                                    return (
                                        <button
                                            key={lang}
                                            type="button"
                                            aria-pressed={selected}
                                            title={
                                                isLastSelected
                                                    ? t(
                                                          'settings.personalization.systemPromptEnhancement.languagesDesc',
                                                      )
                                                    : undefined
                                            }
                                            className={cn(
                                                'rounded-lg border px-2.5 py-1 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] transition-colors',
                                                isLastSelected ? 'cursor-not-allowed opacity-75' : 'cursor-pointer',
                                                selected
                                                    ? 'border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/15 text-[var(--text-primary)]'
                                                    : 'border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                                            )}
                                            disabled={isLastSelected}
                                            aria-disabled={isLastSelected}
                                            onClick={() => handleToggleLanguage(lang)}
                                        >
                                            {t(
                                                `settings.personalization.systemPromptEnhancement.lang.${lang}`,
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                    ) : null}
                </SettingsCard>
            </section>
        </div>
    )
}

export const PersonalizationSection = createExtensibleComponent(
    'PersonalizationSection',
    BasePersonalizationSection,
)
