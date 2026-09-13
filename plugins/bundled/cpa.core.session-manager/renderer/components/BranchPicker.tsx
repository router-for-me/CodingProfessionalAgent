import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, GitBranch, Plus, Search, cn, useHostServices, useTranslation } from '@cpa/plugin-ui'
import {
    createHostGitFs,
    isValidGitBranchName,
    readGitRepo,
    switchGitBranchWithDefaultRunner,
    type GitCommandRunner,
    type GitFs,
    type GitRepoInfo,
} from '../utils/gitBranches.js'
import { CreateBranchModal } from './CreateBranchModal.js'

export interface BranchPickerProps {
    value: string | null
    onChange: (branch: string | null) => void
    projectName?: string
    projectPaths?: readonly string[]
    disabled?: boolean
    className?: string
    loadRepo?: (paths: readonly string[]) => Promise<GitRepoInfo | null>
    checkoutBranch?: (
        repo: GitRepoInfo,
        name: string,
        options?: { create?: boolean; baseBranch?: string },
    ) => Promise<void>
    branchPrefix?: string
    pollIntervalMs?: number
}

function areRepoInfosEqual(a: GitRepoInfo | null, b: GitRepoInfo | null): boolean {
    if (a === b) return true
    if (!a || !b) return false
    if (a.current !== b.current || a.detached !== b.detached || a.headSha !== b.headSha) {
        return false
    }
    if (a.branches.length !== b.branches.length) {
        return false
    }
    for (let i = 0; i < a.branches.length; i++) {
        if (a.branches[i] !== b.branches[i]) return false
    }
    return true
}

/**
 * Compact branch chip for the composer context bar.
 * Lists local branches by reading git metadata; switches with git switch.
 */
export function BranchPicker({
    value,
    onChange,
    projectName,
    projectPaths = [],
    disabled = false,
    className,
    loadRepo,
    checkoutBranch,
    branchPrefix,
    pollIntervalMs,
}: BranchPickerProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const pushToast = (msg: string, type?: any) => {
        services?.ui?.pushToast?.(msg, type)
    }

    const fileSystem = services?.fileSystem
    // Keep the effect dependency stable when setRepo triggers a render.
    const defaultLoadRepo = useCallback(async (paths: readonly string[]) => {
        if (!fileSystem) return null
        const fs: GitFs = createHostGitFs(fileSystem)
        return readGitRepo(paths, fs)
    }, [fileSystem])

    const defaultCheckoutBranch = async (
        repo: GitRepoInfo,
        name: string,
        options?: { create?: boolean; baseBranch?: string },
    ) => {
        if (!services?.process) {
            throw new Error('Process service unavailable for git branch switch')
        }
        const runner: GitCommandRunner = async (cwd, args) => {
            const res = await services.process!.run({
                command: 'git',
                args,
                cwd,
            })
            return {
                exitCode: res.exitCode,
                stdout: res.stdout,
                stderr: res.stderr,
            }
        }
        await switchGitBranchWithDefaultRunner(repo, name, options, runner)
    }

    const effectiveLoadRepo = loadRepo ?? defaultLoadRepo
    const effectiveCheckoutBranch = checkoutBranch ?? defaultCheckoutBranch

    const [open, setOpen] = useState(false)
    const [createModalOpen, setCreateModalOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [repo, setRepo] = useState<GitRepoInfo | null>(null)
    const [busy, setBusy] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)
    const onChangeRef = useRef(onChange)
    const valueRef = useRef(value)
    const busyRef = useRef(busy)
    const repoRef = useRef<GitRepoInfo | null>(null)
    const inFlightRef = useRef(false)
    const pendingRefreshRef = useRef(false)
    const loadGenerationRef = useRef(0)

    onChangeRef.current = onChange
    valueRef.current = value
    busyRef.current = busy

    const pathsKey = projectPaths.filter(Boolean).join('\0')

    const refreshRepo = useCallback(async (force = false): Promise<GitRepoInfo | null> => {
        if (!pathsKey) {
            if (repoRef.current !== null) {
                repoRef.current = null
                setRepo(null)
            }
            return null
        }
        if (inFlightRef.current && !force) {
            pendingRefreshRef.current = true
            return repoRef.current
        }
        if (busyRef.current) {
            return repoRef.current
        }
        inFlightRef.current = true
        const generation = ++loadGenerationRef.current
        const paths = pathsKey.split('\0')
        try {
            const info = await effectiveLoadRepo(paths)
            if (generation !== loadGenerationRef.current) {
                return repoRef.current
            }
            if (!areRepoInfosEqual(repoRef.current, info)) {
                repoRef.current = info
                setRepo(info)
            }
            if (info?.current && info.current !== valueRef.current) {
                onChangeRef.current(info.current)
            }
            return info
        } catch {
            if (generation === loadGenerationRef.current && repoRef.current !== null) {
                repoRef.current = null
                setRepo(null)
            }
            return null
        } finally {
            inFlightRef.current = false
            if (pendingRefreshRef.current) {
                pendingRefreshRef.current = false
                void refreshRepo()
            }
        }
    }, [pathsKey, effectiveLoadRepo])

    useEffect(() => {
        if (!pathsKey) {
            repoRef.current = null
            setRepo(null)
            return
        }
        void refreshRepo(true)
    }, [pathsKey, refreshRepo, open])

    useEffect(() => {
        if (!pathsKey) return

        const onFocusOrVisible = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return
            }
            void refreshRepo()
        }

        window.addEventListener('focus', onFocusOrVisible)
        document.addEventListener('visibilitychange', onFocusOrVisible)
        return () => {
            window.removeEventListener('focus', onFocusOrVisible)
            document.removeEventListener('visibilitychange', onFocusOrVisible)
        }
    }, [pathsKey, refreshRepo])

    const effectivePollInterval = pollIntervalMs ?? 3000
    useEffect(() => {
        if (!pathsKey || effectivePollInterval <= 0) return

        const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                return
            }
            void refreshRepo()
        }, effectivePollInterval)

        return () => {
            clearInterval(timer)
        }
    }, [pathsKey, effectivePollInterval, refreshRepo])

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    useEffect(() => {
        if (disabled) setOpen(false)
    }, [disabled])

    useEffect(() => {
        if (!open) {
            setQuery('')
            return
        }
        searchRef.current?.focus()
    }, [open])

    const branches = repo?.branches ?? []
    const normalizedQuery = query.trim()
    const filtered = useMemo(() => {
        if (!normalizedQuery) return branches
        const needle = normalizedQuery.toLowerCase()
        return branches.filter((branch) => branch.toLowerCase().includes(needle))
    }, [branches, normalizedQuery])

    const exactMatch = useMemo(
        () => branches.some((b) => b.toLowerCase() === normalizedQuery.toLowerCase()),
        [branches, normalizedQuery],
    )
    const canCreate = Boolean(
        normalizedQuery && !exactMatch && isValidGitBranchName(normalizedQuery),
    )

    const applyBranch = async (
        branch: string,
        create = false,
        baseBranch?: string,
    ): Promise<boolean> => {
        if (busy) return false
        if (!repo) {
            onChange(branch)
            setOpen(false)
            return true
        }
        if (!create && branch === repo.current) {
            onChange(branch)
            setOpen(false)
            return true
        }
        setBusy(true)
        try {
            await effectiveCheckoutBranch(repo, branch, { create, baseBranch })
            const paths = pathsKey ? pathsKey.split('\0') : []
            if (paths.length > 0) {
                const info = await effectiveLoadRepo(paths).catch(() => null)
                if (info) {
                    repoRef.current = info
                    setRepo(info)
                }
            }
            onChange(branch)
            setOpen(false)
            return true
        } catch (error: any) {
            pushToast(checkoutErrorMessage(error, create, t), 'error')
            return false
        } finally {
            setBusy(false)
        }
    }

    const handleCreate = async () => {
        if (!normalizedQuery) {
            searchRef.current?.focus()
            pushToast(t('composer.enterBranchName', { defaultValue: 'Please enter a branch name' }), 'error')
            return
        }
        if (!isValidGitBranchName(normalizedQuery)) {
            pushToast(t('composer.invalidBranchName', { defaultValue: 'Invalid branch name' }), 'error')
            return
        }
        await applyBranch(normalizedQuery, true)
    }

    const detachedLabel = repo?.detached && repo?.headSha ? `HEAD (${repo.headSha.slice(0, 7)})` : null
    const activeBranch = repo?.current || detachedLabel || value
    const currentLabel =
        activeBranch || t('composer.selectBranch', { defaultValue: 'Select branch' })
    const searchPlaceholder = projectName
        ? t('composer.searchProjectBranches', {
              name: projectName,
              defaultValue: `Search ${projectName} branches`,
          })
        : t('composer.searchBranches', { defaultValue: 'Search branches' })

    return (
        <div ref={rootRef} className={cn('relative inline-block text-[12px]', className)}>
            <button
                type="button"
                role="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={t('composer.selectBranch', { defaultValue: 'Select branch' })}
                title={projectName ? `${projectName}: ${currentLabel}` : currentLabel}
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => {
                    if (disabled) return
                    setOpen((prev) => !prev)
                }}
                className={cn(
                    'inline-flex max-w-[200px] items-center gap-1.5 rounded-full',
                    'border border-transparent bg-transparent',
                    'px-2.5 py-[5px] text-[12px] leading-normal transition-colors',
                    'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    'hover:bg-[var(--bg-elevated)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    'disabled:pointer-events-none disabled:opacity-45',
                    open
                        ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)]',
                )}
            >
                <GitBranch className="size-3.5 shrink-0 opacity-80" aria-hidden />
                <span className="min-w-0 truncate">{currentLabel}</span>
            </button>

            {open ? (
                <div
                    role="listbox"
                    aria-label={t('composer.branchList', { defaultValue: 'Git branches' })}
                    className={cn(
                        'absolute bottom-full left-0 z-30 mb-2 w-64 overflow-hidden',
                        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                        'bg-[var(--bg-elevated)] p-1.5 shadow-lg backdrop-blur-md',
                    )}
                >
                    <div className="relative mb-1 flex items-center px-1">
                        <Search
                            className="absolute left-2.5 size-3.5 text-[var(--text-muted)]"
                            aria-hidden
                        />
                        <input
                            ref={searchRef}
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    if (canCreate) {
                                        void handleCreate()
                                    } else if (filtered.length > 0) {
                                        void applyBranch(filtered[0]!, false)
                                    }
                                }
                            }}
                            placeholder={searchPlaceholder}
                            className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] py-1 pl-7 pr-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
                        />
                    </div>

                    <div className="max-h-48 overflow-y-auto space-y-0.5">
                        {filtered.map((branch) => {
                            const isSelected = branch === (repo?.current || value)
                            return (
                                <button
                                    key={branch}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    onClick={() => void applyBranch(branch, false)}
                                    className={cn(
                                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        isSelected
                                            ? 'bg-[var(--bg-sidebar-hover)]/60 font-semibold text-[var(--text-primary)]'
                                            : 'text-[var(--text-secondary)]',
                                    )}
                                >
                                    <span className="truncate">{branch}</span>
                                    {isSelected ? (
                                        <Check
                                            className="size-3.5 shrink-0 text-[var(--accent-blue)]"
                                            aria-hidden
                                        />
                                    ) : null}
                                </button>
                            )
                        })}

                        {canCreate ? (
                            <button
                                type="button"
                                role="button"
                                aria-label={t('composer.createBranchNamed', {
                                    name: normalizedQuery,
                                    defaultValue: `Create and checkout ${normalizedQuery}`,
                                })}
                                onClick={() => void handleCreate()}
                                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-[var(--accent-blue)] transition-colors hover:bg-[var(--accent-blue)]/10"
                            >
                                <Plus className="size-3.5 shrink-0" aria-hidden />
                                <span className="truncate">
                                    {t('composer.createBranchNamed', {
                                        name: normalizedQuery,
                                        defaultValue: `Create and checkout ${normalizedQuery}`,
                                    })}
                                </span>
                            </button>
                        ) : null}

                        {filtered.length === 0 && !canCreate ? (
                            <div className="px-2 py-2 text-center text-[12px] text-[var(--text-muted)]">
                                {t('composer.noBranchesFound', { defaultValue: 'No branches found' })}
                            </div>
                        ) : null}
                    </div>

                    <div className="my-1 border-t border-[var(--border-subtle)]" />
                    <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => {
                            setOpen(false)
                            setCreateModalOpen(true)
                        }}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    >
                        <Plus className="size-3.5 shrink-0 opacity-80" aria-hidden />
                        <span className="truncate">
                            {t('composer.createBranch', { defaultValue: '创建并检出新分支...' })}
                        </span>
                    </button>
                </div>
            ) : null}

            <CreateBranchModal
                isOpen={createModalOpen}
                onClose={() => setCreateModalOpen(false)}
                onConfirm={async (newBranch) => {
                    const base = repo?.current || value || undefined
                    const ok = await applyBranch(newBranch, true, base)
                    if (ok) {
                        setCreateModalOpen(false)
                    }
                }}
                existingBranches={repo?.branches}
                initialValue={query.trim()}
                branchPrefix={branchPrefix}
            />
        </div>
    )
}

function checkoutErrorMessage(
    error: unknown,
    create: boolean,
    translate: (key: string, options?: Record<string, string>) => string,
): string {
    const message = error instanceof Error ? error.message : String(error ?? '')
    if (message === 'invalid branch name') {
        return translate('composer.invalidBranchName', { defaultValue: 'Invalid branch name' })
    }
    if (/git executable not found/i.test(message)) {
        return translate('composer.gitNotFound', { defaultValue: 'Git executable not found' })
    }
    return translate(
        create ? 'composer.branchCreateFailed' : 'composer.branchSwitchFailed',
        {
            message: message || (create ? 'create failed' : 'switch failed'),
            defaultValue: message,
        },
    )
}
