import {
    cn,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    SettingsServiceToken,
    type GitMergeMethod,
    type GitSettings,
} from '@cpa/plugin-api'
import {
    SegmentedControl,
    SettingsCard,
    SettingsRow,
    ToggleSwitch,
} from './SettingsControls.js'

export const DEFAULT_GIT_SETTINGS: GitSettings = {
    branchPrefix: 'cpa/',
    mergeMethod: 'merge',
    alwaysForcePush: false,
    createDraftPr: true,
    reviewPresentation: 'separate',
    autoMergeWhenReady: false,
    autoMergeInstructions: '',
    commitInstructions: '',
    prInstructions: '',
}

/**
 * Git settings panel matching the CPA Git settings layout 1:1.
 */
export function GitSection() {
    const { t } = useTranslation()
    const settingsService = useHostService(SettingsServiceToken)
    const settings = useSettings()

    const git: GitSettings = settings.git ?? DEFAULT_GIT_SETTINGS
    const setGitSettings = (partial: Partial<GitSettings>) =>
        settingsService?.setGitSettings?.(partial)

    const branchPrefix = git.branchPrefix ?? DEFAULT_GIT_SETTINGS.branchPrefix
    const mergeMethod = (git.mergeMethod ?? DEFAULT_GIT_SETTINGS.mergeMethod) as GitMergeMethod
    const alwaysForcePush = git.alwaysForcePush ?? DEFAULT_GIT_SETTINGS.alwaysForcePush
    const createDraftPr = git.createDraftPr ?? DEFAULT_GIT_SETTINGS.createDraftPr
    const autoMergeWhenReady = git.autoMergeWhenReady ?? DEFAULT_GIT_SETTINGS.autoMergeWhenReady
    const autoMergeInstructions = git.autoMergeInstructions ?? ''
    const commitInstructions = git.commitInstructions ?? ''
    const prInstructions = git.prInstructions ?? ''

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            {/* Page title */}
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.nav.git', 'Git')}
            </h1>

            {/* General Git Options Card */}
            <SettingsCard>
                <SettingsRow
                    title={t('settings.git.branchPrefix', 'Branch prefix')}
                    description={t(
                        'settings.git.branchPrefix.desc',
                        'Prefix used when CPA creates a new branch',
                    )}
                    control={
                        <input
                            type="text"
                            value={branchPrefix}
                            onChange={(event) =>
                                setGitSettings({ branchPrefix: event.target.value })
                            }
                            aria-label={t('settings.git.branchPrefix', 'Branch prefix')}
                            className={cn(
                                'w-[240px] rounded-lg border border-[var(--border-subtle)]',
                                'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-mono',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                            )}
                        />
                    }
                />

                <SettingsRow
                    title={t('settings.git.mergeMethod', 'Pull request merge method')}
                    description={t(
                        'settings.git.mergeMethod.desc',
                        'Choose how CPA merges pull requests',
                    )}
                    control={
                        <SegmentedControl<GitMergeMethod>
                            ariaLabel={t(
                                'settings.git.mergeMethod',
                                'Pull request merge method',
                            )}
                            value={mergeMethod}
                            options={[
                                {
                                    value: 'merge',
                                    label: t('settings.git.mergeMethod.merge', 'Merge'),
                                },
                                {
                                    value: 'squash',
                                    label: t(
                                        'settings.git.mergeMethod.squash',
                                        'Squash',
                                    ),
                                },
                            ]}
                            onChange={(val) => setGitSettings({ mergeMethod: val })}
                        />
                    }
                />

                <SettingsRow
                    title={t('settings.git.alwaysForcePush', 'Always force push')}
                    description={t(
                        'settings.git.alwaysForcePush.desc',
                        'Use --force-with-lease when pushing from CPA',
                    )}
                    control={
                        <ToggleSwitch
                            checked={alwaysForcePush}
                            label={t('settings.git.alwaysForcePush', 'Always force push')}
                            onChange={(val) =>
                                setGitSettings({ alwaysForcePush: val })
                            }
                        />
                    }
                />

                <SettingsRow
                    title={t('settings.git.createDraftPr', 'Create draft pull requests')}
                    description={t(
                        'settings.git.createDraftPr.desc',
                        'Default to draft PRs when creating from CPA',
                    )}
                    control={
                        <ToggleSwitch
                            checked={createDraftPr}
                            label={t(
                                'settings.git.createDraftPr',
                                'Create draft pull requests',
                            )}
                            onChange={(val) =>
                                setGitSettings({ createDraftPr: val })
                            }
                        />
                    }
                    last
                />
            </SettingsCard>

            {/* Monitor and fix Pull Request */}
            <section className="space-y-2">
                <h2 className="text-[13px] font-medium text-[var(--text-primary)]">
                    {t('settings.git.monitorAndFixPr', 'Monitor and fix pull requests')}
                </h2>
                <SettingsCard>
                    <SettingsRow
                        title={t(
                            'settings.git.autoMergeWhenReady',
                            'Auto-merge when ready',
                        )}
                        description={t(
                            'settings.git.autoMergeWhenReady.desc',
                            'Continue monitoring until the pull request merges',
                        )}
                        control={
                            <ToggleSwitch
                                checked={autoMergeWhenReady}
                                label={t(
                                    'settings.git.autoMergeWhenReady',
                                    'Auto-merge when ready',
                                )}
                                onChange={(val) =>
                                    setGitSettings({ autoMergeWhenReady: val })
                                }
                            />
                        }
                    />
                    <textarea
                        value={autoMergeInstructions}
                        onChange={(event) =>
                            setGitSettings({
                                autoMergeInstructions: event.target.value,
                            })
                        }
                        placeholder={t(
                            'settings.git.autoMergeInstructions.placeholder',
                            'e.g., Comment /merge once checks pass, approve unrelated Chromatic changes...',
                        )}
                        rows={4}
                        className={cn(
                            'w-full bg-transparent p-3.5 text-[13px] leading-relaxed',
                            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                            'outline-none resize-y min-h-[96px]',
                        )}
                    />
                </SettingsCard>
            </section>

            {/* Commit Instructions */}
            <section className="space-y-1.5">
                <div>
                    <h2 className="text-[13px] font-medium text-[var(--text-primary)]">
                        {t('settings.git.commitInstructions', 'Commit instructions')}
                    </h2>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                        {t(
                            'settings.git.commitInstructions.desc',
                            'Will be added to commit message generation prompts',
                        )}
                    </p>
                </div>
                <SettingsCard>
                    <textarea
                        value={commitInstructions}
                        onChange={(event) =>
                            setGitSettings({
                                commitInstructions: event.target.value,
                            })
                        }
                        placeholder={t(
                            'settings.git.commitInstructions.placeholder',
                            'Add commit message guidelines...',
                        )}
                        rows={4}
                        className={cn(
                            'w-full bg-transparent p-3.5 text-[13px] leading-relaxed',
                            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                            'outline-none resize-y min-h-[110px]',
                        )}
                    />
                </SettingsCard>
            </section>

            {/* Pull Request Instructions */}
            <section className="space-y-1.5">
                <div>
                    <h2 className="text-[13px] font-medium text-[var(--text-primary)]">
                        {t('settings.git.prInstructions', 'Pull request instructions')}
                    </h2>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)]">
                        {t(
                            'settings.git.prInstructions.desc',
                            'Will be added to PR title and description generation prompts',
                        )}
                    </p>
                </div>
                <SettingsCard>
                    <textarea
                        value={prInstructions}
                        onChange={(event) =>
                            setGitSettings({
                                prInstructions: event.target.value,
                            })
                        }
                        placeholder={t(
                            'settings.git.prInstructions.placeholder',
                            'Add pull request guidelines...',
                        )}
                        rows={4}
                        className={cn(
                            'w-full bg-transparent p-3.5 text-[13px] leading-relaxed',
                            'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                            'outline-none resize-y min-h-[110px]',
                        )}
                    />
                </SettingsCard>
            </section>
        </div>
    )
}
