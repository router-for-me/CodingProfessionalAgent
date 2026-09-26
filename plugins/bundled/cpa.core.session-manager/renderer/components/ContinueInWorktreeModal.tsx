import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    AlertCircle,
    Check,
    CustomSelect,
    ExternalLink,
    GitBranch,
    GitFork,
    Loader2,
    X,
    cn,
    useHostServices,
    useProjects,
    useTranslation,
    useWorkspaceVisible,
} from '@cpa/plugin-ui'
import type { Project, SessionItem } from '@cpa/plugin-api'
import { getProjectPaths } from '../utils/projectPaths.js'
import { createHostGitFs, readGitRepo, type GitFs, type GitRepoInfo } from '../utils/gitBranches.js'

export interface ContinueInWorktreeModalProps {
    session: SessionItem
    isOpen: boolean
    onClose: () => void
    onConfirm: (environmentId: string | null, branch?: string) => Promise<void> | void
    isSubmitting?: boolean
    projects?: Project[]
    readFileBridge?: any
    loadRepo?: (paths: readonly string[]) => Promise<GitRepoInfo | null>
}

/**
 * Modal dialog for continuing a session in a new Git worktree with environment selection.
 */
export function ContinueInWorktreeModal({
    session,
    isOpen,
    onClose,
    onConfirm,
    isSubmitting = false,
    projects: customProjects,
    readFileBridge,
    loadRepo,
}: ContinueInWorktreeModalProps) {
    const titleId = useId()
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const services = useHostServices()
    const storeProjects = useProjects()
    const projects = customProjects ?? (storeProjects as Project[])

    const currentProject = (
        session.projectId
            ? projects.find((p) => p.id === session.projectId || p.name === session.projectId)
            : null
    ) ?? null

    const projectPaths = currentProject ? getProjectPaths(currentProject) : []
    const primaryPath = projectPaths[0]

    const [selectedEnvId, setSelectedEnvId] = useState<string | null>(
        session.environmentId ?? null,
    )
    const [envProjects, setEnvProjects] = useState<Project[]>([])
    const [isDetecting, setIsDetecting] = useState(true)

    // Real-time git branch detection from the repository
    const [selectedBranch, setSelectedBranch] = useState<string>('')
    const [detectedBranch, setDetectedBranch] = useState<string>('')
    const [repoBranches, setRepoBranches] = useState<string[]>([])

    useEffect(() => {
        let isMounted = true
        const detectGit = async () => {
            if (projectPaths.length === 0) return
            try {
                const pathsToCheck = session.worktreePath
                    ? [session.worktreePath, ...projectPaths]
                    : projectPaths

                let repoInfo: GitRepoInfo | null = null
                if (loadRepo) {
                    repoInfo = await loadRepo(pathsToCheck)
                } else if (services?.fileSystem) {
                    const fs: GitFs = createHostGitFs(services.fileSystem)
                    repoInfo = await readGitRepo(pathsToCheck, fs)
                }

                if (isMounted && repoInfo) {
                    if (repoInfo.current) {
                        setDetectedBranch(repoInfo.current)
                    }
                    if (repoInfo.branches && repoInfo.branches.length > 0) {
                        setRepoBranches(repoInfo.branches)
                    }
                }
            } catch {
                // Ignore git read error
            }
        }
        void detectGit()
        return () => {
            isMounted = false
        }
    }, [session.worktreePath, projectPaths.join('\0'), loadRepo, services?.fileSystem])

    useEffect(() => {
        let isMounted = true
        setIsDetecting(true)

        const detectEnvironments = async () => {
            const detected: Project[] = []
            for (const p of projects) {
                const paths = getProjectPaths(p)
                let has = false
                for (const path of paths) {
                    const candidates = [
                        `${path}/.cpa/environments/environment.toml`,
                        `${path}/.codex/environments/environment.toml`,
                        `${path}/environment.toml`,
                        `${path}/.cpa/environment.toml`,
                        `${path}/.codex/environment.toml`,
                    ]
                    for (const cand of candidates) {
                        try {
                            let res: any = null
                            if (readFileBridge) {
                                if (typeof readFileBridge.ReadFile === 'function') {
                                    res = await readFileBridge.ReadFile(cand)
                                } else if (typeof readFileBridge === 'function') {
                                    res = await readFileBridge(cand)
                                }
                            } else if (services?.fileSystem) {
                                res =
                                    (await services.fileSystem.readFileIfExists?.(cand)) ??
                                    (await services.fileSystem.readFile(cand).catch(() => null))
                            }
                            if (res !== null && res !== undefined) {
                                has = true
                                break
                            }
                        } catch {
                            // Ignore read errors
                        }
                    }
                    if (has) break
                }
                if (has) detected.push(p)
            }

            if (isMounted) {
                setEnvProjects(detected)
                setIsDetecting(false)
            }
        }

        void detectEnvironments()
        return () => {
            isMounted = false
        }
    }, [projects, readFileBridge, services?.fileSystem])

    useEffect(() => {
        if (!isOpen || !workspaceVisible) return

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !isSubmitting) {
                onClose()
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [isOpen, workspaceVisible, isSubmitting, onClose])

    const handleSetupProject = () => {
        onClose()
        const targetProject =
            currentProject ??
            (selectedEnvId
                ? projects.find((p) => p.id === selectedEnvId || p.name === selectedEnvId)
                : null) ??
            (projects.length > 0 ? projects[0] : null)

        if (targetProject) {
            services?.ui?.openSettings?.('environments', {
                projectId: targetProject.id,
                mode: 'detail',
                fromChat: true,
            } as any)
        } else {
            services?.ui?.openSettings?.('environments', { mode: 'list', fromChat: true } as any)
        }
    }

    if (!isOpen || typeof document === 'undefined') return null

    const workingBranch = selectedBranch || detectedBranch || session.branch || 'main'

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-5"
            style={workspaceVisible ? undefined : { display: 'none' }}
            inert={!workspaceVisible}
            aria-hidden={!workspaceVisible}
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget && !isSubmitting) {
                    onClose()
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-[500px] rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 text-[var(--text-primary)] shadow-2xl"
            >
                {/* Header */}
                <div className="mb-4 flex items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-blue)]/10 text-[var(--accent-blue)]">
                        <GitFork className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-[17px] font-semibold leading-tight">
                            {t('session.continueInNewWorktree', { defaultValue: 'Continue in new worktree' })}
                        </h2>
                        <p className="text-[12px] text-[var(--text-muted)]">
                            {t('session.worktreeForkDesc', {
                                defaultValue: 'Create an isolated worktree based on the current branch and fork the chat',
                            })}
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label={t('common.close', { defaultValue: 'Close' })}
                        disabled={isSubmitting}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                        onClick={onClose}
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                {/* Session Context Summary */}
                <div className="mb-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3 space-y-2">
                    <div className="flex items-center justify-between text-[12px]">
                        <span className="text-[var(--text-muted)]">
                            {t('composer.branchSection', { defaultValue: 'Working branch' })}
                        </span>
                        <div data-testid="worktree-modal-branch" className="flex items-center justify-end min-w-0">
                            {repoBranches.length > 1 ? (
                                <div className="w-[180px] flex justify-end">
                                    <CustomSelect<string>
                                        value={workingBranch}
                                        onChange={(val) => setSelectedBranch(val)}
                                        options={repoBranches.map((b) => ({ value: b, label: b }))}
                                        ariaLabel={t('composer.branchSection', { defaultValue: 'Working branch' })}
                                        icon={GitBranch}
                                        align="right"
                                        triggerClassName="h-7 text-[12px] font-mono px-2 justify-end"
                                    />
                                </div>
                            ) : (
                                <span className="flex items-center gap-1.5 font-mono font-medium text-[var(--text-primary)]">
                                    <GitBranch className="size-3.5 opacity-70" aria-hidden />
                                    <span>{workingBranch}</span>
                                </span>
                            )}
                        </div>
                    </div>
                    {currentProject ? (
                        <div className="flex items-center justify-between text-[12px]">
                            <span className="text-[var(--text-muted)]">
                                {t('session.currentProject', { defaultValue: 'Current project' })}
                            </span>
                            <span className="font-medium text-[var(--text-primary)] truncate max-w-[260px]">
                                <span className="truncate">{currentProject.name}</span>
                            </span>
                        </div>
                    ) : null}
                </div>

                {!primaryPath ? (
                    <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-[12px] text-red-500">
                        <AlertCircle className="size-4 shrink-0" aria-hidden />
                        <span>
                            {t('project.noPath', {
                                defaultValue: 'Project path not set, cannot create worktree',
                            })}
                        </span>
                    </div>
                ) : null}

                {/* Environment Selection */}
                <div className="mb-5">
                    <div className="mb-2 flex items-center justify-between text-[13px] font-medium">
                        <span>{t('composer.environment', { defaultValue: 'Environment' })}</span>
                        {isDetecting ? (
                            <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                                <Loader2 className="size-3 animate-spin" aria-hidden />
                                Detecting environment...
                            </span>
                        ) : null}
                    </div>

                    <div className="max-h-56 space-y-2 overflow-y-auto pr-0.5">
                        {/* Option 1: Without environment */}
                        <div
                            role="button"
                            tabIndex={0}
                            data-testid="env-option-none"
                            onClick={() => !isSubmitting && setSelectedEnvId(null)}
                            onKeyDown={(e) => {
                                if ((e.key === 'Enter' || e.key === ' ') && !isSubmitting) {
                                    e.preventDefault()
                                    setSelectedEnvId(null)
                                }
                            }}
                            className={cn(
                                'flex cursor-pointer items-center justify-between rounded-xl border p-3 transition-colors',
                                selectedEnvId === null
                                    ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)]/5'
                                    : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-sidebar-hover)]',
                                isSubmitting ? 'pointer-events-none opacity-60' : '',
                            )}
                        >
                            <div className="flex items-center gap-2.5">
                                <div
                                    className={cn(
                                        'flex size-4 items-center justify-center rounded-full border',
                                        selectedEnvId === null
                                            ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)] text-white'
                                            : 'border-[var(--border-subtle)] bg-transparent',
                                    )}
                                >
                                    {selectedEnvId === null ? (
                                        <Check className="size-2.5 stroke-[3]" aria-hidden />
                                    ) : null}
                                </div>
                                <div>
                                    <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                        {t('composer.environment.workWithoutEnvironment', {
                                            defaultValue: 'Work without environment',
                                        })}
                                    </div>
                                    <div className="text-[11px] text-[var(--text-muted)]">
                                        {t('session.worktreeNoEnvDesc', {
                                            defaultValue: 'Only create an isolated Git worktree without running setup scripts',
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Option 2: Configured Project Environments */}
                        {envProjects.map((p) => {
                            const isSelected = selectedEnvId === p.id
                            return (
                                <div
                                    key={p.id}
                                    role="button"
                                    tabIndex={0}
                                    data-testid={`env-option-${p.id}`}
                                    onClick={() => !isSubmitting && setSelectedEnvId(p.id)}
                                    onKeyDown={(e) => {
                                        if ((e.key === 'Enter' || e.key === ' ') && !isSubmitting) {
                                            e.preventDefault()
                                            setSelectedEnvId(p.id)
                                        }
                                    }}
                                    className={cn(
                                        'flex cursor-pointer items-center justify-between rounded-xl border p-3 transition-colors',
                                        isSelected
                                            ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)]/5'
                                            : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-sidebar-hover)]',
                                        isSubmitting ? 'pointer-events-none opacity-60' : '',
                                    )}
                                >
                                    <div className="flex items-center gap-2.5">
                                        <div
                                            className={cn(
                                                'flex size-4 items-center justify-center rounded-full border',
                                                isSelected
                                                    ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)] text-white'
                                                    : 'border-[var(--border-subtle)] bg-transparent',
                                            )}
                                        >
                                            {isSelected ? (
                                                <Check className="size-2.5 stroke-[3]" aria-hidden />
                                            ) : null}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[13px] font-medium text-[var(--text-primary)]">
                                                    {p.name}
                                                </span>
                                                <span className="rounded bg-[var(--accent-blue)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent-blue)]">
                                                    environment.toml
                                                </span>
                                            </div>
                                            <div className="text-[11px] text-[var(--text-muted)] truncate max-w-[340px]">
                                                {getProjectPaths(p)[0] || p.path}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}

                        {/* Option 3: Set up project environment */}
                        <div
                            role="button"
                            tabIndex={0}
                            data-testid="env-option-setup"
                            onClick={() => !isSubmitting && handleSetupProject()}
                            onKeyDown={(e) => {
                                if ((e.key === 'Enter' || e.key === ' ') && !isSubmitting) {
                                    e.preventDefault()
                                    handleSetupProject()
                                }
                            }}
                            className={cn(
                                'flex cursor-pointer items-center justify-between rounded-xl border border-dashed border-[var(--border-subtle)] p-3 transition-colors',
                                'bg-[var(--bg-card)]/50 hover:bg-[var(--bg-sidebar-hover)] hover:border-[var(--accent-blue)]',
                                isSubmitting ? 'pointer-events-none opacity-60' : '',
                            )}
                        >
                            <div className="flex items-center gap-2.5">
                                <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
                                    <ExternalLink className="size-3.5 opacity-80" aria-hidden />
                                </div>
                                <div>
                                    <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                        {t('composer.environment.setupProject', { defaultValue: 'Set up work environment' })}
                                    </div>
                                    <div className="text-[11px] text-[var(--text-muted)]">
                                        {envProjects.length === 0
                                            ? t('session.worktreeNoEnvConfiguredDesc', {
                                                  defaultValue: 'No work environment detected, click to create one in Settings',
                                              })
                                            : t('session.worktreeManageEnvDesc', {
                                                  defaultValue: 'Manage or edit project environment configuration in Settings (environment.toml)',
                                              })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Footer buttons */}
                <div className="flex items-center justify-end gap-2.5 border-t border-[var(--border-subtle)] pt-4">
                    <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={onClose}
                        className="rounded-xl border border-[var(--border-subtle)] px-4 py-2 text-[13px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-40"
                    >
                        {t('common.cancel', { defaultValue: 'Cancel' })}
                    </button>
                    <button
                        type="button"
                        data-testid="confirm-worktree-fork-btn"
                        disabled={isSubmitting || !primaryPath}
                        onClick={() => void onConfirm(selectedEnvId, workingBranch)}
                        className="flex items-center gap-2 rounded-xl bg-[var(--accent-blue)] px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                                <span>Creating worktree...</span>
                            </>
                        ) : (
                            <>
                                <GitFork className="size-3.5" aria-hidden />
                                <span>
                                    {t('session.continueInNewWorktree', {
                                        defaultValue: 'Continue in new worktree',
                                    })}
                                </span>
                            </>
                        )}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    )
}
