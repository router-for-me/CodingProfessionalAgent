import { useCallback, useEffect, useState } from 'react'
import {
    Folder,
    FolderOpen,
    GitBranch,
    RotateCw,
    Trash2,
    SettingsCard,
    SettingsRow,
    ToggleSwitch,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    deleteWorktree,
    listWorktreesUnderDir,
    type DiscoveredWorktree,
    type GitCommandRunner,
    type WorktreeFsBridge,
} from '../utils/worktrees.js'

export const DEFAULT_WORKTREE_SETTINGS = {
    rootDir: '~/.coding-professional-agent/worktrees',
    fetchUpstream: false,
    autoDeleteOld: true,
    deleteLimit: 15,
}

export interface WorktreesSectionProps {
    fsBridge?: WorktreeFsBridge
    gitRunner?: GitCommandRunner
    onDelete?: (worktree: DiscoveredWorktree) => Promise<void> | void
}

/**
 * Worktrees settings panel matching the CPA Worktrees settings layout 1:1.
 */
export function WorktreesSection({
    fsBridge,
    gitRunner,
    onDelete,
}: WorktreesSectionProps = {}) {
    const { t } = useTranslation()
    const services = useHostServices()

    const [settingsSnapshot, setSettingsSnapshot] = useState(() => services?.settings?.getSnapshot?.() ?? ({} as any))

    useEffect(() => {
        if (!services?.settings?.subscribe) return
        return services.settings.subscribe((next) => {
            setSettingsSnapshot(next)
        })
    }, [services])

    const worktreesSettings = settingsSnapshot.worktrees ?? DEFAULT_WORKTREE_SETTINGS

    const rootDir = worktreesSettings.rootDir ?? DEFAULT_WORKTREE_SETTINGS.rootDir
    const fetchUpstream = worktreesSettings.fetchUpstream ?? DEFAULT_WORKTREE_SETTINGS.fetchUpstream
    const autoDeleteOld = worktreesSettings.autoDeleteOld ?? DEFAULT_WORKTREE_SETTINGS.autoDeleteOld
    const deleteLimit = worktreesSettings.deleteLimit ?? DEFAULT_WORKTREE_SETTINGS.deleteLimit

    const updateWorktrees = (patch: Partial<typeof DEFAULT_WORKTREE_SETTINGS>) => {
        const next = { ...worktreesSettings, ...patch }
        if (services?.settings?.setWorktreeSettings) {
            services.settings.setWorktreeSettings(next)
        } else if (services?.settings?.update) {
            void services.settings.update({ worktrees: next } as any)
        }
    }

    const [discoveredWorktrees, setDiscoveredWorktrees] = useState<DiscoveredWorktree[]>([])
    const [refreshing, setRefreshing] = useState(false)
    const [loading, setLoading] = useState(false)
    const [deletingPath, setDeletingPath] = useState<string | null>(null)

    const scanWorktrees = useCallback(async () => {
        setLoading(true)
        try {
            const list = await listWorktreesUnderDir(rootDir, {
                fsBridge,
                fileSystemService: services?.fileSystem,
            })
            setDiscoveredWorktrees(list)
        } catch {
            setDiscoveredWorktrees([])
        } finally {
            setLoading(false)
        }
    }, [rootDir, fsBridge, services?.fileSystem])

    useEffect(() => {
        void scanWorktrees()
    }, [scanWorktrees])

    const handleRefresh = async () => {
        setRefreshing(true)
        try {
            await scanWorktrees()
        } finally {
            setTimeout(() => {
                setRefreshing(false)
            }, 300)
        }
    }

    const handleReveal = (path: string) => {
        if (services?.projects?.revealPath) {
            void services.projects.revealPath(path)
        }
    }

    const handleDelete = async (wt: DiscoveredWorktree) => {
        if (deletingPath) return
        setDeletingPath(wt.path)
        try {
            if (onDelete) {
                await onDelete(wt)
            } else {
                const res = await deleteWorktree(wt, {
                    fsBridge,
                    gitRunner,
                    fileSystemService: services?.fileSystem,
                    processService: services?.process,
                })
                if (!res.ok) {
                    services?.ui?.pushToast?.(
                        res.error || t('settings.worktrees.deleteFailed', 'Failed to delete worktree'),
                    )
                    return
                }
            }
            services?.ui?.pushToast?.(
                t('settings.worktrees.deletedSuccess', 'Worktree deleted'),
            )
            await scanWorktrees()
        } catch (err) {
            services?.ui?.pushToast?.(
                err instanceof Error ? err.message : String(err),
            )
        } finally {
            setDeletingPath(null)
        }
    }

    return (
        <div className="flex w-full flex-col">
            <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 pt-8 pb-16">
                <div className="mb-6 flex items-center justify-between">
                    <div>
                        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                            {t('settings.worktrees.title', 'Worktrees')}
                        </h1>
                        <p className="mt-1 text-[13px] text-[var(--text-muted)] font-[inherit]">
                            {t(
                                'settings.worktrees.subtitle',
                                'Manage local worktrees and isolated workspace configuration.',
                            )}
                        </p>
                    </div>

                    <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={refreshing || loading}
                        className={cn(
                            'flex size-8 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer disabled:opacity-50',
                        )}
                        title={t('common.refresh', 'Refresh')}
                    >
                        <RotateCw className={cn('size-4', refreshing && 'animate-spin')} />
                    </button>
                </div>

                <div className="space-y-6">
                    {/* Settings Group */}
                    <SettingsCard>
                        <SettingsRow
                            title={t('settings.worktrees.rootDir', 'Worktree root directory')}
                            description={t(
                                'settings.worktrees.rootDir.desc',
                                'Directory where CPA creates managed worktrees. Leave blank to use default location',
                            )}
                            control={
                                <input
                                    type="text"
                                    aria-label={t('settings.worktrees.rootDir', 'Worktree root directory')}
                                    value={rootDir}
                                    onChange={(e) => updateWorktrees({ rootDir: e.target.value })}
                                    className={cn(
                                        'w-72 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5',
                                        'text-[13px] font-mono text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none transition-colors',
                                    )}
                                />
                            }
                        />

                        <SettingsRow
                            title={t(
                                'settings.worktrees.fetchUpstream',
                                'Always fetch upstream updates before creating worktree',
                            )}
                            description={t(
                                'settings.worktrees.fetchUpstream.desc',
                                'CPA normally fetches branch updates during regular Git operations. This setting also fetches upstream updates before creating each new worktree.',
                            )}
                            control={
                                <ToggleSwitch
                                    checked={fetchUpstream}
                                    onChange={(val) => updateWorktrees({ fetchUpstream: val })}
                                    label={t(
                                        'settings.worktrees.fetchUpstream',
                                        'Always fetch upstream updates before creating worktree',
                                    )}
                                />
                            }
                        />

                        <SettingsRow
                            title={t('settings.worktrees.autoDeleteOld', 'Automatically delete old worktrees')}
                            description={t(
                                'settings.worktrees.autoDeleteOld.desc',
                                'Recommended for most users. Disable only if you need to manually manage old worktrees and disk usage.',
                            )}
                            control={
                                <ToggleSwitch
                                    checked={autoDeleteOld}
                                    onChange={(val) => updateWorktrees({ autoDeleteOld: val })}
                                    label={t('settings.worktrees.autoDeleteOld', 'Automatically delete old worktrees')}
                                />
                            }
                        />

                        <SettingsRow
                            last
                            title={t('settings.worktrees.deleteLimit', 'Auto-delete limit')}
                            description={t(
                                'settings.worktrees.deleteLimit.desc',
                                'Number of managed worktrees to retain; older worktrees are automatically cleaned up when exceeded. CPA takes snapshots before removing worktrees, so cleaned worktrees can always be restored.',
                            )}
                            control={
                                <input
                                    type="number"
                                    aria-label={t('settings.worktrees.deleteLimit', 'Auto-delete limit')}
                                    min={1}
                                    max={100}
                                    value={deleteLimit}
                                    onChange={(e) =>
                                        updateWorktrees({
                                            deleteLimit: parseInt(e.target.value, 10) || 15,
                                        })
                                    }
                                    className={cn(
                                        'w-24 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-center',
                                        'text-[13px] font-mono text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none transition-colors',
                                    )}
                                />
                            }
                        />
                    </SettingsCard>

                    {/* Discovered Worktrees List */}
                    <div>
                        <h3 className="mb-3 text-[13px] font-medium text-[var(--text-secondary)] font-[inherit]">
                            {t('settings.worktrees.activeTitle', 'Managed worktrees')} ({discoveredWorktrees.length})
                        </h3>

                        {discoveredWorktrees.length === 0 ? (
                            <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] py-12 text-center">
                                <Folder className="size-10 text-[var(--text-muted)] opacity-50 mb-3 stroke-[1.5]" />
                                <span className="text-[14px] font-medium text-[var(--text-primary)] mb-1 font-[inherit]">
                                    {t('settings.worktrees.emptyTitle', 'No worktrees yet')}
                                </span>
                                <span className="text-xs text-[var(--text-muted)] max-w-sm font-[inherit]">
                                    {t(
                                        'settings.worktrees.emptyDesc',
                                        'Worktrees created by CPA will appear here',
                                    )}
                                </span>
                            </div>
                        ) : (
                            <div className="space-y-2.5">
                                {discoveredWorktrees.map((wt) => (
                                    <div
                                        key={wt.path}
                                        className={cn(
                                            'flex items-center justify-between rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-4 py-3',
                                            'hover:bg-[var(--bg-sidebar-hover)] transition-colors',
                                        )}
                                    >
                                        <div className="flex items-center gap-3 min-w-0 flex-1">
                                            <FolderOpen className="size-5 text-[var(--accent-blue)] shrink-0 stroke-[1.75]" />
                                            <div className="flex flex-col min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[13px] font-medium text-[var(--text-primary)] truncate font-[inherit]">
                                                        {wt.name}
                                                    </span>
                                                    {wt.branch ? (
                                                        <span className="flex items-center gap-1 rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] font-mono">
                                                            <GitBranch className="size-3" />
                                                            {wt.branch}
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <span className="text-xs font-mono text-[var(--text-muted)] truncate">
                                                    {wt.path}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-1.5 shrink-0 ml-3">
                                            <button
                                                type="button"
                                                onClick={() => handleReveal(wt.path)}
                                                className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                                aria-label={t('settings.worktrees.revealInFinder', 'Reveal in file manager')}
                                                title={t('settings.worktrees.revealInFinder', 'Reveal in file manager')}
                                            >
                                                <Folder className="size-3.5" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleDelete(wt)}
                                                disabled={deletingPath === wt.path}
                                                className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-red-400 transition-colors cursor-pointer disabled:opacity-50"
                                                aria-label={t('settings.worktrees.deleteWorktree', 'Delete worktree')}
                                                title={t('settings.worktrees.deleteWorktree', 'Delete worktree')}
                                            >
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
