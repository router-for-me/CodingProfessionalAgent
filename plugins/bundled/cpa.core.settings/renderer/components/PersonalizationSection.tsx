import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
    CustomSelect,
    cn,
    createExtensibleComponent,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    FileSystemServiceToken,
    PersonalizationServiceToken,
    SettingsServiceToken,
    UiServiceToken,
    type PersonalityTone,
} from '@cpa/plugin-api'

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

    const pushToast = (msg: string) => uiService?.pushToast(msg)

    const personality = (settings.personality ?? 'pragmatic') as PersonalityTone
    const setPersonality = (val: PersonalityTone) => settingsService?.setPersonality?.(val)

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
                    const filePath = `${homeDir}${sep}.coding-professional-agent${sep}AGENTS.md`
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
                const dirPath = `${homeDir}${sep}.coding-professional-agent`
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
        </div>
    )
}

export const PersonalizationSection = createExtensibleComponent(
    'PersonalizationSection',
    BasePersonalizationSection,
)
