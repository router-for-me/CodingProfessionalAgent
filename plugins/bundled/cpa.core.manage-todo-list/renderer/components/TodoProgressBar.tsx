import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    CheckCircle2,
    FileCode2,
    FileEdit,
    Loader2,
    cn,
    useActiveRun,
    useAgentRunState,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import { useTodoListStore } from '../../shared/todoStore.js'
import { syncTodosFromEntries } from '../../shared/todoOrchestration.js'
import type { TodoItem, TodoStatus } from '../../shared/types.js'
import {
    EMPTY_SESSION_CHANGES,
    extractFileChangesFromEntries,
    type SessionFileChanges,
} from '../../shared/fileChanges.js'

export interface TodoProgressBarProps {
    sessionId?: string
    todos?: TodoItem[]
    fileChanges?: SessionFileChanges
    isRunning?: boolean
    className?: string
}

function getBaseName(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/')
    const parts = normalized.split('/')
    return parts[parts.length - 1] || filePath
}

function StatusIcon({ status }: { status: TodoStatus }) {
    if (status === 'completed') {
        return (
            <span
                data-testid="todo-status-completed"
                className="flex size-4 shrink-0 items-center justify-center rounded-full border border-neutral-500/60 bg-neutral-700/40 text-[10px] font-bold text-neutral-300 select-none"
            >
                ✓
            </span>
        )
    }
    if (status === 'in-progress') {
        return (
            <span
                data-testid="todo-status-in-progress"
                className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-neutral-200 bg-transparent select-none"
            />
        )
    }
    return (
        <span
            data-testid="todo-status-not-started"
            className="flex size-4 shrink-0 items-center justify-center rounded-full border border-neutral-600 bg-transparent select-none"
        />
    )
}

function StatusItemText({ todo }: { todo: TodoItem }) {
    if (todo.status === 'completed') {
        return (
            <span
                className="truncate text-neutral-300"
                title={todo.description || todo.title}
            >
                {todo.title}
            </span>
        )
    }
    if (todo.status === 'in-progress') {
        return (
            <span
                className="truncate font-medium text-[var(--text-primary)]"
                title={todo.description || todo.title}
            >
                {todo.title}
            </span>
        )
    }
    return (
        <span
            className="truncate text-[var(--text-muted)]"
            title={todo.description || todo.title}
        >
            {todo.title}
        </span>
    )
}

function DiffBadge({
    additions,
    deletions,
    className,
}: {
    additions: number
    deletions: number
    className?: string
}) {
    if (additions === 0 && deletions === 0) {
        return (
            <span
                className={cn(
                    'shrink-0 font-mono text-[11.5px] text-[var(--text-muted)] font-normal tabular-nums text-right select-none',
                    className
                )}
            >
                0
            </span>
        )
    }
    return (
        <span
            className={cn(
                'shrink-0 inline-flex items-center justify-end gap-1.5 font-mono text-[11.5px] font-semibold tabular-nums select-none',
                className
            )}
        >
            {additions > 0 ? (
                <span className="text-[var(--accent-green)]">+{additions}</span>
            ) : null}
            {deletions > 0 ? (
                <span className="text-[#f87171]">-{deletions}</span>
            ) : null}
        </span>
    )
}

const EMPTY_TODOS: TodoItem[] = []

export function TodoProgressBar({
    sessionId: propSessionId,
    todos: propTodos,
    fileChanges: propFileChanges,
    isRunning: propIsRunning,
    className,
}: TodoProgressBarProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const currentSessionId = services?.sessions?.getCurrentSessionId?.() ?? ''
    const effectiveSessionId =
        propSessionId !== undefined ? (propSessionId || '') : currentSessionId

    const agentRunState = useAgentRunState(effectiveSessionId)
    const activeRun = useActiveRun(effectiveSessionId)

    const isRunning =
        propIsRunning !== undefined
            ? propIsRunning
            : Boolean(
                  agentRunState.isStreaming ||
                      (activeRun &&
                          activeRun.status !== 'idle' &&
                          activeRun.status !== 'error')
              )

    const storeTodos = useTodoListStore(
        useCallback(
            (state) => (effectiveSessionId ? state.todosBySession[effectiveSessionId] ?? EMPTY_TODOS : EMPTY_TODOS),
            [effectiveSessionId]
        )
    )

    const todos = propTodos ?? storeTodos
    const [derivedFileChanges, setDerivedFileChanges] = useState<SessionFileChanges>(EMPTY_SESSION_CHANGES)

    // Restore todos / file changes from persisted conversation entries after app/session reload.
    useEffect(() => {
        if (!effectiveSessionId) {
            if (!propFileChanges) {
                setDerivedFileChanges(EMPTY_SESSION_CHANGES)
            }
            return
        }

        const chat = services?.chatMessages
        if (!chat?.getEntries) return

        let cancelled = false

        const syncFromEntries = () => {
            if (cancelled) return
            const entries = chat.getEntries(effectiveSessionId)
            if (!entries || entries.length === 0) {
                // Session may still be hydrating; do not clear an in-progress restore.
                return
            }

            if (!propTodos) {
                syncTodosFromEntries(effectiveSessionId, entries as readonly Record<string, unknown>[])
            }

            if (!propFileChanges) {
                setDerivedFileChanges(
                    extractFileChangesFromEntries(entries as readonly Record<string, unknown>[]) ??
                        EMPTY_SESSION_CHANGES
                )
            }
        }

        void (async () => {
            try {
                await chat.ensureSessionLoaded?.(effectiveSessionId)
            } catch {
                // Best-effort hydrate; still attempt a sync from whatever is in memory.
            }
            syncFromEntries()
        })()

        const unsubscribe = chat.subscribeMessages?.(effectiveSessionId, syncFromEntries)
        return () => {
            cancelled = true
            unsubscribe?.()
        }
    }, [effectiveSessionId, propTodos, propFileChanges, services?.chatMessages])

    const fileChanges = propFileChanges ?? derivedFileChanges

    const [isHovered, setIsHovered] = useState(false)
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleMouseEnter = useCallback(() => {
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current)
            hoverTimeoutRef.current = null
        }
        setIsHovered(true)
    }, [])

    const handleMouseLeave = useCallback(() => {
        hoverTimeoutRef.current = setTimeout(() => {
            setIsHovered(false)
            hoverTimeoutRef.current = null
        }, 120)
    }, [])

    useEffect(() => {
        return () => {
            if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current)
            }
        }
    }, [])

    const handleOpenReview = useCallback(
        (targetFile: string | null) => {
            services?.ui?.openRightPanelTab?.('review', {
                activate: true,
                params: targetFile
                    ? { selectedFilePath: targetFile, timestamp: Date.now() }
                    : undefined,
            })
            services?.ui?.setRightSidebarCollapsed?.(false)
            setIsHovered(false)
        },
        [services]
    )

    const { total, currentStep, allCompleted } = useMemo(() => {
        const totalCount = todos.length
        if (totalCount === 0) {
            return { total: 0, currentStep: 0, allCompleted: false }
        }

        const completedCount = todos.filter((item) => item.status === 'completed').length
        const inProgressIndex = todos.findIndex((item) => item.status === 'in-progress')

        let step = 1
        if (inProgressIndex !== -1) {
            step = inProgressIndex + 1
        } else if (completedCount === totalCount) {
            step = totalCount
        } else {
            step = Math.min(completedCount + 1, totalCount)
        }

        return {
            total: totalCount,
            currentStep: step,
            allCompleted: completedCount === totalCount,
        }
    }, [todos])

    const hasTodos = total > 0
    const hasFileChanges =
        fileChanges.totalFilesChanged > 0 ||
        fileChanges.totalAdditions > 0 ||
        fileChanges.totalDeletions > 0

    if (!hasTodos && !hasFileChanges) {
        return null
    }

    const stepText = hasTodos
        ? t('todo.stepProgress', {
              current: currentStep,
              total,
              defaultValue: `Step ${currentStep} of ${total}`,
          })
        : ''

    const filesChangedText = hasFileChanges
        ? t('todo.filesChanged', {
              count: fileChanges.totalFilesChanged,
              defaultValue: `${fileChanges.totalFilesChanged} files changed`,
          })
        : ''

    const fileEntries = Object.values(fileChanges.files)

    return (
        <div
            data-testid="todo-progress-container"
            className={cn('relative flex flex-col items-center select-none', className)}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {/* Popover Card */}
            {isHovered ? (
                <div
                    data-testid="todo-progress-popover"
                    className={cn(
                        'absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 min-w-[260px] max-w-[420px]',
                        'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]/95 p-3',
                        'shadow-2xl shadow-black/60 backdrop-blur-md',
                        'animate-in fade-in zoom-in-95 duration-150'
                    )}
                >
                    {hasTodos ? (
                        <div className="flex flex-col gap-2">
                            {todos.map((todo) => (
                                <div
                                    key={todo.id}
                                    data-testid={`todo-item-${todo.id}`}
                                    className="flex items-center gap-2.5 text-[13px] leading-snug"
                                >
                                    <StatusIcon status={todo.status} />
                                    <StatusItemText todo={todo} />
                                </div>
                            ))}
                        </div>
                    ) : null}

                    {hasTodos && hasFileChanges ? (
                        <div className="my-2.5 border-t border-[var(--border-subtle)]" />
                    ) : null}

                    {hasFileChanges ? (
                        <div className="flex flex-col gap-1.5" data-testid="popover-file-changes">
                            <div className="flex items-center justify-between pl-1.5 pr-2.5 text-[12px] font-medium text-[var(--text-secondary)]">
                                <button
                                    type="button"
                                    data-testid="popover-changes-header-button"
                                    onClick={() => handleOpenReview(null)}
                                    className="flex items-center gap-1 cursor-pointer hover:text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:underline"
                                >
                                    <span>{t('pinnedSummary.changes', 'Changes')}</span>
                                </button>
                                <DiffBadge
                                    additions={fileChanges.totalAdditions}
                                    deletions={fileChanges.totalDeletions}
                                />
                            </div>
                            <div className="flex flex-col gap-1 max-h-[180px] overflow-y-auto pr-1">
                                {fileEntries.map((file) => (
                                    <button
                                        type="button"
                                        key={file.path}
                                        data-testid={`popover-file-item-${file.path}`}
                                        onClick={() => handleOpenReview(file.path)}
                                        className="flex w-full items-center justify-between gap-2 text-[12px] px-1.5 py-1 rounded-md text-left transition-colors cursor-pointer hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/40"
                                        title={file.path}
                                    >
                                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                            <FileCode2 className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                                            <span className="truncate text-[var(--text-primary)]">
                                                {getBaseName(file.path)}
                                            </span>
                                        </div>
                                        <DiffBadge
                                            additions={file.additions}
                                            deletions={file.deletions}
                                        />
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {/* Pill Trigger */}
            <button
                type="button"
                data-testid="todo-progress-pill"
                aria-label={
                    hasTodos
                        ? `${stepText}${hasFileChanges ? ` · ${filesChangedText}` : ''}`
                        : filesChangedText
                }
                onClick={() => {
                    if (hasFileChanges) {
                        handleOpenReview(null)
                    }
                }}
                className={cn(
                    'inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)]',
                    'bg-[var(--bg-card)]/90 px-3.5 py-1 text-[13px] text-[var(--text-primary)]',
                    'shadow-lg backdrop-blur-md transition-all duration-150 cursor-pointer',
                    'hover:bg-[var(--bg-sidebar-hover)] hover:border-[var(--border-medium)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                )}
            >
                {hasTodos ? (
                    allCompleted ? (
                        <CheckCircle2
                            data-testid="todo-pill-icon-completed"
                            className="size-3.5 text-emerald-400"
                        />
                    ) : isRunning ? (
                        <Loader2
                            data-testid="todo-pill-icon-running"
                            className="size-3.5 animate-spin text-sky-400"
                        />
                    ) : null
                ) : (
                    <FileEdit
                        data-testid="todo-pill-icon-file-edit"
                        className="size-3.5 text-sky-400"
                    />
                )}

                {hasTodos ? (
                    <span data-testid="todo-pill-text-step" className="font-medium">
                        {stepText}
                    </span>
                ) : null}

                {hasTodos && hasFileChanges ? (
                    <span className="text-[var(--text-muted)] select-none">·</span>
                ) : null}

                {hasFileChanges ? (
                    <span data-testid="todo-pill-text-changes" className="flex items-center gap-1.5">
                        <span className="text-[var(--text-secondary)]">{filesChangedText}</span>
                        <DiffBadge
                            additions={fileChanges.totalAdditions}
                            deletions={fileChanges.totalDeletions}
                        />
                    </span>
                ) : null}
            </button>
        </div>
    )
}
