import { useCallback, useEffect, useRef, useState } from 'react'
import {
    AlertCircle,
    FolderOpen,
    GitCompare,
    RefreshCw,
    useTranslation,
    useHostServices,
    useProjects,
    useSessions,
    cn,
} from '@cpa/plugin-ui'
import { useNavigate } from '@tanstack/react-router'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import {
    buildGitHubCompareUrl,
    isLargeGitDiff,
    loadGitDiff,
    loadGitRepoDetails,
    type GitCommandRunner,
    type GitDiffFile,
    type GitDiffSummary,
    type GitRepoDetails,
} from '../utils/gitDiff.js'
import { DiffFileCard } from './DiffFileCard.js'
import { DiffFileTree } from './DiffFileTree.js'
import { DiffHeaderToolbar } from './DiffHeaderToolbar.js'
import { BranchCompareModal } from './BranchCompareModal.js'
import { SingleFileNavHeader } from './SingleFileNavHeader.js'

export interface ReviewPanelContentProps {
    sessionId?: string | null
    className?: string
    selectedFilePath?: string | null
    selectedFile?: string | null
    timestamp?: number
    mode?: 'workingTree' | 'branch'
    baseBranch?: string
    compareTarget?: string
}

export function matchDiffFile(
    files: GitDiffFile[],
    targetPath: string | null | undefined
): GitDiffFile | undefined {
    if (!targetPath || !files || files.length === 0) return undefined
    const cleanTarget = targetPath.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (!cleanTarget) return undefined

    // 1. Exact match against displayPath, newPath, or oldPath
    const exact = files.find(
        (f) =>
            f.displayPath === cleanTarget ||
            f.newPath === cleanTarget ||
            f.oldPath === cleanTarget
    )
    if (exact) return exact

    // 2. Suffix or prefix match
    const suffix = files.find(
        (f) =>
            cleanTarget.endsWith('/' + f.displayPath) ||
            cleanTarget.endsWith(f.displayPath) ||
            f.displayPath.endsWith('/' + cleanTarget) ||
            f.displayPath.endsWith(cleanTarget)
    )
    if (suffix) return suffix

    return undefined
}

export function ReviewPanelContent({
    sessionId,
    className,
    selectedFilePath: propSelectedFilePath,
    selectedFile: propSelectedFile,
    timestamp: propTimestamp,
    mode: propMode,
    baseBranch: propBaseBranch,
    compareTarget: propCompareTarget,
}: ReviewPanelContentProps) {
    const { t, i18n } = useTranslation()
    const services = useHostServices()
    const projects = useProjects()
    const sessions = useSessions()

    let navigate: any = null
    try {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        navigate = useNavigate()
    } catch {
        // Fallback for tests outside Router context
    }

    const targetFilePath = propSelectedFilePath || propSelectedFile || null

    const pendingProjectId = services?.ui?.getPendingSessionContext?.()?.projectId
    const currentSession = sessions.find((s) => s.id === sessionId)
    const activeProject =
        (currentSession?.projectId ? projects.find((p) => p.id === currentSession.projectId) : undefined) ??
        (pendingProjectId ? projects.find((p) => p.id === pendingProjectId) : undefined) ??
        projects[0] ??
        null

    const worktreePath =
        currentSession?.worktreePath ||
        currentSession?.worktreeSetup?.worktreePath ||
        null

    const effectiveProjectPath = worktreePath || activeProject?.path || null

    const [isLoading, setIsLoading] = useState(true)
    const [isGitRepo, setIsGitRepo] = useState(true)
    const [repoDetails, setRepoDetails] = useState<GitRepoDetails | null>(null)
    const [summary, setSummary] = useState<GitDiffSummary>({
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        totalFilesChanged: 0,
        rawDiff: '',
    })

    const initialBaseBranch =
        propBaseBranch ||
        currentSession?.baseBranch ||
        currentSession?.worktreeSetup?.baseBranch ||
        'main'
    const initialCompareTarget =
        propCompareTarget ||
        currentSession?.branch ||
        currentSession?.worktreeSetup?.branch ||
        'HEAD'
    const initialCompareMode = propMode || 'workingTree'

    const [baseBranch, setBaseBranch] = useState<string>(initialBaseBranch)
    const [compareTarget, setCompareTarget] = useState<string>(initialCompareTarget)
    const [compareMode, setCompareMode] = useState<'workingTree' | 'branch'>(initialCompareMode)

    const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
    const [sidebarOpen, setSidebarOpen] = useState(true)
    const [allExpanded, setAllExpanded] = useState(true)
    const [isSplitView, setIsSplitView] = useState(false)
    const [userViewMode, setUserViewMode] = useState<'single' | 'all' | null>(null)
    const [compareModalOpen, setCompareModalOpen] = useState(false)
    const [flashingFilePath, setFlashingFilePath] = useState<string | null>(null)

    const isLargeDiff = isLargeGitDiff(summary)
    const isSingleFileMode =
        userViewMode === 'single' || (userViewMode === null && isLargeDiff)

    const activeFile =
        summary.files.find((f) => f.displayPath === selectedFilePath) ??
        summary.files[0] ??
        null
    const activeIndex = activeFile
        ? summary.files.findIndex((f) => f.displayPath === activeFile.displayPath)
        : -1

    const diffContainerRef = useRef<HTMLDivElement>(null)
    const scrollCleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        return () => {
            scrollCleanupRef.current?.()
        }
    }, [])

    const gitRunner: GitCommandRunner | undefined = useCallback(
        async (cwd: string, args: readonly string[]) => {
            if (services?.process?.run) {
                const res = await services.process.run({
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
            return { exitCode: 1, stdout: '', stderr: 'Process service unavailable' }
        },
        [services?.process],
    )

    const fetchGitData = useCallback(async () => {
        if (!effectiveProjectPath) {
            setIsLoading(false)
            return
        }

        setIsLoading(true)
        let loadedDetails: GitRepoDetails | null = null
        try {
            const details = await loadGitRepoDetails(effectiveProjectPath, gitRunner)
            if (!details) {
                setIsGitRepo(false)
                setIsLoading(false)
                return
            }

            loadedDetails = details
            setRepoDetails(details)
            setIsGitRepo(true)

            const defaultBase =
                currentSession?.baseBranch ||
                currentSession?.worktreeSetup?.baseBranch ||
                details.defaultBranch ||
                'main'
            const defaultTarget =
                currentSession?.branch ||
                currentSession?.worktreeSetup?.branch ||
                details.currentBranch ||
                'HEAD'

            const base = baseBranch || defaultBase
            const target = compareTarget || defaultTarget

            const diffResult = await loadGitDiff(effectiveProjectPath, {
                baseBranch: compareMode === 'branch' ? base : defaultBase,
                compareTarget: compareMode === 'branch' ? target : defaultTarget,
                mode: compareMode,
                runner: gitRunner,
            })

            setSummary(diffResult)
        } catch (err) {
            // Treat hard failures as "not a git repo" only when repo details never loaded.
            // Transient process/diff errors should not wipe a previously valid git view.
            console.error('Failed to load review git data:', err)
            if (!loadedDetails) {
                setIsGitRepo(false)
            }
        } finally {
            setIsLoading(false)
        }
    }, [
        effectiveProjectPath,
        compareMode,
        baseBranch,
        compareTarget,
        gitRunner,
        currentSession?.baseBranch,
        currentSession?.worktreeSetup?.baseBranch,
        currentSession?.branch,
        currentSession?.worktreeSetup?.branch,
    ])

    useEffect(() => {
        void fetchGitData()
    }, [fetchGitData])

    // Set default selected file when summary files are loaded or updated
    useEffect(() => {
        if (summary.files.length > 0) {
            setSelectedFilePath((prev) => {
                if (prev && summary.files.some((f) => f.displayPath === prev)) {
                    return prev
                }
                if (targetFilePath) {
                    const matched = matchDiffFile(summary.files, targetFilePath)
                    if (matched) return matched.displayPath
                }
                return summary.files[0].displayPath
            })
        } else {
            setSelectedFilePath(null)
        }
    }, [summary.files, targetFilePath])

    const scrollToAndFlashCard = useCallback((displayPath: string) => {
        scrollCleanupRef.current?.()
        setFlashingFilePath(null)

        const performScroll = () => {
            const elementId = `diff-card-${encodeURIComponent(displayPath)}`
            const el = document.getElementById(elementId)
            const container = diffContainerRef.current

            if (!el) return

            const triggerFlash = () => {
                setFlashingFilePath(displayPath)
            }

            el.scrollIntoView({ behavior: 'smooth', block: 'center' })

            if (!container) {
                triggerFlash()
                return
            }

            let triggered = false
            const onScrollEndOrTimeout = () => {
                if (triggered) return
                triggered = true
                cleanup()
                triggerFlash()
            }

            let isScrolling = false
            const onScroll = () => {
                isScrolling = true
            }

            container.addEventListener('scroll', onScroll, { passive: true, once: true })
            container.addEventListener('scrollend', onScrollEndOrTimeout, { once: true })

            // If no scroll event occurred within 150ms (already at position or no-op), trigger immediately
            const initialCheckTimer = setTimeout(() => {
                if (!isScrolling) {
                    onScrollEndOrTimeout()
                }
            }, 150)

            // Maximum fallback timer for smooth scroll completion
            const maxTimer = setTimeout(onScrollEndOrTimeout, 600)

            const cleanup = () => {
                clearTimeout(initialCheckTimer)
                clearTimeout(maxTimer)
                container.removeEventListener('scroll', onScroll)
                container.removeEventListener('scrollend', onScrollEndOrTimeout)
                if (scrollCleanupRef.current === cleanup) {
                    scrollCleanupRef.current = null
                }
            }

            scrollCleanupRef.current = cleanup
        }

        const el = document.getElementById(`diff-card-${encodeURIComponent(displayPath)}`)
        if (el) {
            performScroll()
        } else {
            setTimeout(() => {
                performScroll()
            }, 50)
        }
    }, [])

    const handleSelectFileFromTree = useCallback((file: GitDiffFile) => {
        setSelectedFilePath(file.displayPath)

        if (isSingleFileMode) {
            if (typeof diffContainerRef.current?.scrollTo === 'function') {
                diffContainerRef.current.scrollTo({ top: 0, behavior: 'instant' })
            } else if (diffContainerRef.current) {
                diffContainerRef.current.scrollTop = 0
            }
            return
        }

        scrollToAndFlashCard(file.displayPath)
    }, [isSingleFileMode, scrollToAndFlashCard])

    // Select requested file from props or event when targetFilePath changes
    useEffect(() => {
        if (!targetFilePath || summary.files.length === 0) return

        const matched = matchDiffFile(summary.files, targetFilePath)
        if (matched) {
            handleSelectFileFromTree(matched)
        }
    }, [targetFilePath, propTimestamp, summary.files, handleSelectFileFromTree])

    // Listen to external review:refresh and review:select-file events via EventBus
    useEffect(() => {
        const bus = rendererEventBus
        if (!bus) return

        const unsubRefresh = bus.on('review:refresh', () => {
            void fetchGitData()
        })
        const unsubSelect = bus.on('review:select-file', (payload: any) => {
            const { filePath } = (payload ?? {}) as { filePath?: string }
            if (filePath && summary.files.length > 0) {
                const matched = matchDiffFile(summary.files, filePath)
                if (matched) {
                    handleSelectFileFromTree(matched)
                }
            }
        })
        return () => {
            unsubRefresh?.()
            unsubSelect?.()
        }
    }, [fetchGitData, summary.files, handleSelectFileFromTree])

    const handlePrevFile = () => {
        if (activeIndex > 0) {
            handleSelectFileFromTree(summary.files[activeIndex - 1])
        }
    }

    const handleNextFile = () => {
        if (activeIndex >= 0 && activeIndex < summary.files.length - 1) {
            handleSelectFileFromTree(summary.files[activeIndex + 1])
        }
    }

    const handleCopyDiff = () => {
        if (summary.rawDiff) {
            if (services?.ui?.writeClipboard) {
                void services.ui.writeClipboard(summary.rawDiff)
            } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                void navigator.clipboard.writeText(summary.rawDiff)
            }
            services?.ui?.pushToast?.(t('rightSidebar.review.diffCopied'))
        }
    }

    const handleAiReview = useCallback(async () => {
        const agentRunState =
            services?.agentRun?.getRunState?.(sessionId ?? '') ??
            services?.chatMessages?.getAgentRunState?.(sessionId ?? '')
        if (agentRunState?.isStreaming) return

        const fileList = summary.files
            .map((f) => `- ${f.displayPath} (+${f.additions} -${f.deletions})`)
            .join('\n')

        const promptText =
            `Please review the code changes in this workspace:\n${fileList}\n\nDiff Details:\n\`\`\`diff\n${summary.rawDiff.slice(0, 8000)}\n\`\`\`\n\nProvide a comprehensive code review focusing on correctness, edge cases, readability, and regression risks.`

        const sendPayload = {
            text: promptText,
            kind: 'review' as any,
            projectId: activeProject?.id ?? null,
            branch: repoDetails?.currentBranch ?? null,
            sessionId: sessionId ?? null,
        }

        let targetSessionId: string | null | undefined = null
        if (services?.chatMessages?.send) {
            targetSessionId = await services.chatMessages.send(sendPayload as any)
        } else if (services?.agentRun?.send) {
            targetSessionId = await services.agentRun.send(sendPayload as any)
        }

        if (targetSessionId && targetSessionId !== sessionId) {
            if (navigate) {
                void navigate({
                    to: '/chat/$sessionId',
                    params: { sessionId: targetSessionId },
                })
            } else if (services?.navigation?.navigate) {
                void services.navigation.navigate({
                    to: '/chat/$sessionId',
                    params: { sessionId: targetSessionId },
                })
            }
        }
    }, [
        summary.files,
        summary.rawDiff,
        i18n?.language,
        services?.agentRun,
        services?.chatMessages,
        services?.navigation,
        sessionId,
        navigate,
        activeProject?.id,
        repoDetails?.currentBranch,
    ])

    const handleCreatePullRequest = () => {
        if (!repoDetails?.remoteUrl) {
            services?.ui?.pushToast?.(t('rightSidebar.review.notGitRepo'))
            return
        }

        const base = baseBranch || repoDetails.defaultBranch || 'main'
        const head =
            compareMode === 'branch'
                ? compareTarget
                : repoDetails.currentBranch || 'HEAD'

        const url = buildGitHubCompareUrl(repoDetails.remoteUrl, base, head)
        if (url && typeof window !== 'undefined') {
            window.open(url, '_blank')
        } else {
            services?.ui?.pushToast?.(t('rightSidebar.review.notGitRepo'))
        }
    }

    const handleApplyCompare = (params: {
        baseBranch: string
        compareTarget: string
        compareMode: 'workingTree' | 'branch'
    }) => {
        setBaseBranch(params.baseBranch)
        setCompareTarget(params.compareTarget)
        setCompareMode(params.compareMode)
    }

    if (!effectiveProjectPath) {
        return (
            <div
                data-testid="right-sidebar-review-no-project"
                className={cn(
                    'flex h-full min-h-0 flex-col items-center justify-center p-6 text-center select-none',
                    className,
                )}
            >
                <FolderOpen className="size-10 text-[var(--text-muted)] opacity-60" />
                <h4 className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">
                    {t('rightSidebar.files.noProject')}
                </h4>
                <p className="mt-1 max-w-[220px] text-[12px] text-[var(--text-muted)]">
                    {t('rightSidebar.review.desc')}
                </p>
            </div>
        )
    }

    if (!isGitRepo) {
        return (
            <div
                data-testid="right-sidebar-review-not-git"
                className={cn(
                    'flex h-full min-h-0 flex-col items-center justify-center p-6 text-center select-none',
                    className,
                )}
            >
                <AlertCircle className="size-10 text-amber-400 opacity-80" />
                <h4 className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">
                    {t('rightSidebar.review.notGitRepo')}
                </h4>
                <p className="mt-1 max-w-[220px] text-[12px] text-[var(--text-muted)]">
                    {effectiveProjectPath}
                </p>
                <button
                    type="button"
                    onClick={fetchGitData}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                >
                    <RefreshCw className="size-3.5" />
                    <span>{t('rightSidebar.review.refresh')}</span>
                </button>
            </div>
        )
    }

    return (
        <div
            data-testid="right-sidebar-review-view"
            className={cn(
                'flex h-full min-h-0 w-full flex-col bg-[var(--bg-app)] text-[var(--text-primary)] overflow-hidden',
                className,
            )}
        >
            {/* Header Toolbar */}
            <DiffHeaderToolbar
                summary={summary}
                currentBranch={repoDetails?.currentBranch ?? null}
                baseBranch={baseBranch}
                compareTarget={compareTarget}
                compareMode={compareMode}
                sidebarOpen={sidebarOpen}
                allExpanded={allExpanded}
                isSplitView={isSplitView}
                isSingleFileMode={isSingleFileMode}
                isLoading={isLoading}
                onToggleSidebar={() => setSidebarOpen((v) => !v)}
                onToggleAllExpanded={() => setAllExpanded((v) => !v)}
                onToggleSplitView={() => setIsSplitView((v) => !v)}
                onToggleSingleFileMode={() =>
                    setUserViewMode(isSingleFileMode ? 'all' : 'single')
                }
                onOpenCompareModal={() => setCompareModalOpen(true)}
                onRefresh={fetchGitData}
                onCopyDiff={handleCopyDiff}
                onCreatePullRequest={handleCreatePullRequest}
                onAiReview={handleAiReview}
            />

            {/* Main Split Content */}
            <div className="flex flex-1 min-h-0 w-full overflow-hidden">
                {/* Left / Main Diff Viewer */}
                <div
                    ref={diffContainerRef}
                    data-testid="diff-container"
                    className="flex-1 min-w-0 min-h-0 overflow-y-auto p-3 space-y-3"
                >
                    {isLoading ? (
                        <div className="flex h-40 items-center justify-center text-[var(--text-muted)]">
                            <RefreshCw className="size-5 animate-spin" />
                        </div>
                    ) : summary.files.length === 0 ? (
                        <div className="flex h-64 flex-col items-center justify-center text-center select-none">
                            <GitCompare className="size-8 text-[var(--text-muted)] opacity-50" />
                            <p className="mt-3 text-[13px] font-medium text-[var(--text-primary)]">
                                {t('rightSidebar.review.noChanges')}
                            </p>
                            <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                                {t('rightSidebar.review.noChangesDesc')}
                            </p>
                            <button
                                type="button"
                                onClick={fetchGitData}
                                className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                            >
                                <RefreshCw className="size-3.5" />
                                <span>{t('rightSidebar.review.refresh')}</span>
                            </button>
                        </div>
                    ) : isSingleFileMode && activeFile ? (
                        <div className="space-y-3">
                            <SingleFileNavHeader
                                file={activeFile}
                                currentIndex={activeIndex}
                                totalFiles={summary.files.length}
                                isLargeDiff={isLargeDiff}
                                onPrevFile={handlePrevFile}
                                onNextFile={handleNextFile}
                                onToggleViewMode={() => setUserViewMode('all')}
                            />
                            <DiffFileCard
                                key={activeFile.displayPath}
                                id={`diff-card-${encodeURIComponent(activeFile.displayPath)}`}
                                file={activeFile}
                                projectPath={effectiveProjectPath}
                                defaultExpanded={allExpanded}
                                isSplitView={isSplitView}
                                isFlashing={flashingFilePath === activeFile.displayPath}
                                onFlashEnd={() => {
                                    if (flashingFilePath === activeFile.displayPath) {
                                        setFlashingFilePath(null)
                                    }
                                }}
                            />
                        </div>
                    ) : (
                        summary.files.map((file) => (
                            <DiffFileCard
                                key={file.displayPath}
                                id={`diff-card-${encodeURIComponent(file.displayPath)}`}
                                file={file}
                                projectPath={effectiveProjectPath}
                                defaultExpanded={allExpanded}
                                isSplitView={isSplitView}
                                isFlashing={flashingFilePath === file.displayPath}
                                onFlashEnd={() => {
                                    if (flashingFilePath === file.displayPath) {
                                        setFlashingFilePath(null)
                                    }
                                }}
                            />
                        ))
                    )}
                </div>

                {/* Right File Tree Sidebar */}
                {summary.files.length > 0 ? (
                    <DiffFileTree
                        files={summary.files}
                        selectedFilePath={selectedFilePath}
                        onSelectFile={handleSelectFileFromTree}
                        open={sidebarOpen}
                        transition
                    />
                ) : null}
            </div>

            {/* Comparison Configuration Modal */}
            <BranchCompareModal
                isOpen={compareModalOpen}
                onClose={() => setCompareModalOpen(false)}
                currentBranch={repoDetails?.currentBranch ?? null}
                defaultBranch={repoDetails?.defaultBranch ?? null}
                branches={repoDetails?.branches ?? []}
                baseBranch={baseBranch}
                compareTarget={compareTarget}
                compareMode={compareMode}
                onApply={handleApplyCompare}
            />
        </div>
    )
}
