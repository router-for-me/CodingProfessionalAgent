import {
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import {
    ChatMessageServiceToken,
    NavigationServiceToken,
    ProjectServiceToken,
    SessionServiceToken,
    UiServiceToken,
    WorktreeServiceToken,
    type SessionItem,
    type UiService,
} from '@cpa/plugin-api'
import {
    cn,
    createHashRouteUrl,
    useActiveRun,
    useHostService,
    useProjects,
    useSessions,
    useTranslation,
    AlertCircle,
    Archive,
    Check,
    ChevronRight,
    Clock,
    Folder,
    GitBranch,
    GitFork,
    Loader2,
    Pin,
    PinOff,
} from '@cpa/plugin-ui'
import { useIsMobileBrowser } from '../utils/platform.js'
import { getProjectPaths } from '../utils/projectPaths.js'
import { revealProjectPath } from '../utils/projectReveal.js'
import { ContinueInWorktreeModal } from './ContinueInWorktreeModal.js'

interface SessionRowProps {
    session: SessionItem
}

const MENU_WIDTH = 208
const MENU_HEIGHT = 396
const HOVER_CARD_WIDTH = 320
const HOVER_CARD_HEIGHT = 152
const SESSION_HOVER_CARD_OPEN_EVENT = 'session-hover-card-open'

interface SessionAge {
    key: string
    count?: number
}

function getSessionAge(updatedAt: number): SessionAge {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000))
    if (elapsedSeconds < 60) return { key: 'session.age.now' }
    const elapsedMinutes = Math.floor(elapsedSeconds / 60)
    if (elapsedMinutes < 60) return { key: 'session.age.minutes', count: elapsedMinutes }
    const elapsedHours = Math.floor(elapsedMinutes / 60)
    if (elapsedHours < 24) return { key: 'session.age.hours', count: elapsedHours }
    const elapsedDays = Math.floor(elapsedHours / 24)
    return { key: 'session.age.days', count: elapsedDays }
}

async function writeClipboard(text: string, uiService?: UiService | null): Promise<void> {
    if (uiService?.writeClipboard) {
        await uiService.writeClipboard(text)
        return
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
    }
}

/** Single sidebar session entry with navigation and a native-style context menu. */
export function SessionRow({ session }: SessionRowProps) {
    const { t } = useTranslation()
    const isMobile = useIsMobileBrowser()
    const sessionService = useHostService(SessionServiceToken)
    const chatMessageService = useHostService(ChatMessageServiceToken)
    const worktreeService = useHostService(WorktreeServiceToken)
    const projectService = useHostService(ProjectServiceToken)
    const navigationService = useHostService(NavigationServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()
    const projects = useProjects()
    const runState = useActiveRun(session.id)
    const isRunning = Boolean(runState && runState.status !== 'idle')

    let navigate: any = null
    try {
        navigate = useNavigate()
    } catch {}

    const hoverCardId = useId()
    const [menuOpen, setMenuOpen] = useState(false)
    const [moveMenuOpen, setMoveMenuOpen] = useState(false)
    const [hoverCardOpen, setHoverCardOpen] = useState(false)
    const [editingTitle, setEditingTitle] = useState(false)
    const [worktreeModalOpen, setWorktreeModalOpen] = useState(false)
    const [isCreatingWorktree, setIsCreatingWorktree] = useState(false)
    const [titleDraft, setTitleDraft] = useState(session.title)
    const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 })
    const [hoverCardPosition, setHoverCardPosition] = useState({ left: 0, top: 0 })
    const rowRef = useRef<HTMLDivElement>(null)
    const hoverCardRef = useRef<HTMLDivElement>(null)
    const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const editingTitleRef = useRef(false)
    const rowHoveredRef = useRef(false)
    const hoverCardHoveredRef = useRef(false)
    const titleInputRef = useRef<HTMLInputElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)

    const isCurrent = sessionService?.getCurrentSessionId?.() === session.id
    const active = isCurrent
    const isManuallyMarkedUnread = sessionService?.isManuallyMarkedUnread?.(session.id) ?? false
    const project =
        projects.find((candidate) => candidate.id === session.projectId) ?? null
    const projectPath = project ? getProjectPaths(project)[0] : undefined
    const sortedProjects = [...projects].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
    })
    const sessionAge = getSessionAge(session.updatedAt)

    const cancelHoverCardClose = () => {
        if (hoverCloseTimerRef.current === null) return
        clearTimeout(hoverCloseTimerRef.current)
        hoverCloseTimerRef.current = null
    }

    const closeHoverCard = (force = false) => {
        if (editingTitleRef.current && !force) return
        cancelHoverCardClose()
        editingTitleRef.current = false
        setHoverCardOpen(false)
        setEditingTitle(false)
        setTitleDraft(session.title)
    }

    const scheduleHoverCardClose = () => {
        cancelHoverCardClose()
        if (editingTitleRef.current) return
        hoverCloseTimerRef.current = setTimeout(() => {
            hoverCloseTimerRef.current = null
            if (
                editingTitleRef.current ||
                rowHoveredRef.current ||
                hoverCardHoveredRef.current
            ) {
                return
            }
            setHoverCardOpen(false)
            setEditingTitle(false)
            setTitleDraft(session.title)
        }, 150)
    }

    const showHoverCard = () => {
        if (isMobile) return
        const row = rowRef.current
        if (!row) return

        window.dispatchEvent(
            new CustomEvent<string>(SESSION_HOVER_CARD_OPEN_EVENT, {
                detail: session.id,
            }),
        )

        const rect = row.getBoundingClientRect()
        const margin = 8
        const gap = 8
        const roomOnRight = window.innerWidth - rect.right
        const left =
            roomOnRight >= HOVER_CARD_WIDTH + gap
                ? rect.right + gap
                : Math.max(margin, rect.left - HOVER_CARD_WIDTH - gap)
        const top = Math.min(
            Math.max(margin, rect.top),
            Math.max(margin, window.innerHeight - HOVER_CARD_HEIGHT - margin),
        )

        setHoverCardPosition({ left, top })
        setHoverCardOpen(true)
    }

    const openHoverCard = () => {
        if (isMobile) return
        cancelHoverCardClose()
        if (menuOpen || hoverCardOpen) return
        showHoverCard()
    }

    const closeMenu = () => {
        setMenuOpen(false)
        setMoveMenuOpen(false)
    }

    const openMenuAt = (left: number, top: number) => {
        closeHoverCard(true)
        const margin = 8
        setMenuPosition({
            left: Math.min(
                Math.max(margin, left),
                Math.max(margin, window.innerWidth - MENU_WIDTH - margin),
            ),
            top: Math.min(
                Math.max(margin, top),
                Math.max(margin, window.innerHeight - MENU_HEIGHT - margin),
            ),
        })
        setMoveMenuOpen(false)
        setMenuOpen(true)
    }

    useEffect(() => {
        const closeWhenAnotherCardOpens = (event: Event) => {
            const nextSessionId = (event as CustomEvent<string>).detail
            if (nextSessionId !== session.id) closeHoverCard(true)
        }

        window.addEventListener(
            SESSION_HOVER_CARD_OPEN_EVENT,
            closeWhenAnotherCardOpens,
        )
        return () => {
            window.removeEventListener(
                SESSION_HOVER_CARD_OPEN_EVENT,
                closeWhenAnotherCardOpens,
            )
        }
    })

    useEffect(() => {
        if (isMobile) return
        const row = rowRef.current
        if (!row) return

        const handleMouseEnter = () => {
            rowHoveredRef.current = true
            openHoverCard()
        }
        const handleMouseLeave = () => {
            rowHoveredRef.current = false
            scheduleHoverCardClose()
        }

        row.addEventListener('mouseenter', handleMouseEnter)
        row.addEventListener('mouseleave', handleMouseLeave)
        return () => {
            row.removeEventListener('mouseenter', handleMouseEnter)
            row.removeEventListener('mouseleave', handleMouseLeave)
            cancelHoverCardClose()
        }
    }, [isMobile])

    useEffect(() => {
        const hoverCard = hoverCardRef.current
        if (!hoverCard) return

        const handleMouseEnter = () => {
            hoverCardHoveredRef.current = true
            cancelHoverCardClose()
        }
        const handleMouseLeave = () => {
            hoverCardHoveredRef.current = false
            scheduleHoverCardClose()
        }

        hoverCard.addEventListener('mouseenter', handleMouseEnter)
        hoverCard.addEventListener('mouseleave', handleMouseLeave)
        return () => {
            hoverCard.removeEventListener('mouseenter', handleMouseEnter)
            hoverCard.removeEventListener('mouseleave', handleMouseLeave)
        }
    }, [hoverCardOpen])

    useEffect(() => {
        if (!editingTitle) return
        titleInputRef.current?.focus()
        titleInputRef.current?.select()
    }, [editingTitle])

    useEffect(() => {
        if (!hoverCardOpen) return

        const closeOnViewportChange = () => closeHoverCard()
        window.addEventListener('resize', closeOnViewportChange)
        window.addEventListener('scroll', closeOnViewportChange, true)
        return () => {
            window.removeEventListener('resize', closeOnViewportChange)
            window.removeEventListener('scroll', closeOnViewportChange, true)
        }
    }, [hoverCardOpen])

    useEffect(() => {
        if (!menuOpen) return

        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (!menuRef.current?.contains(target)) closeMenu()
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu()
        }
        const onViewportChange = () => closeMenu()

        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', onViewportChange)
        window.addEventListener('scroll', onViewportChange, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('resize', onViewportChange)
            window.removeEventListener('scroll', onViewportChange, true)
        }
    }, [menuOpen])

    const handleSelect = (e?: ReactMouseEvent<HTMLAnchorElement>) => {
        e?.preventDefault?.()
        closeHoverCard(true)
        closeMenu()
        sessionService?.markRead?.(session.id)
        sessionService?.setCurrentSessionId?.(session.id)
        if (isMobile) {
            uiService?.setSidebarCollapsed?.(true)
        }
        if (navigate) {
            void navigate({
                to: '/chat/$sessionId',
                params: { sessionId: session.id },
            })
        } else if (navigationService) {
            void navigationService.navigate(`/chat/${session.id}`)
        }
    }

    const handleContextMenu = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        event.preventDefault()
        event.stopPropagation()
        openMenuAt(event.clientX, event.clientY)
    }

    const finishTitleEdit = () => {
        editingTitleRef.current = false
        setEditingTitle(false)
        if (!rowHoveredRef.current && !hoverCardHoveredRef.current) {
            scheduleHoverCardClose()
        }
    }

    const commitTitleEdit = () => {
        if (!editingTitleRef.current) return
        const trimmed = titleDraft.trim()
        finishTitleEdit()
        if (!trimmed) {
            setTitleDraft(session.title)
            return
        }
        if (trimmed === session.title) return
        sessionService?.renameSession?.(session.id, trimmed)
    }

    const cancelTitleEdit = () => {
        finishTitleEdit()
        setTitleDraft(session.title)
    }

    const handleTitleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            commitTitleEdit()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelTitleEdit()
        }
    }

    const handleTitleBlur = () => commitTitleEdit()

    const beginTitleEdit = () => {
        cancelHoverCardClose()
        editingTitleRef.current = true
        setTitleDraft(session.title)
        setEditingTitle(true)
        showHoverCard()
    }

    const handleRename = () => {
        closeMenu()
        beginTitleEdit()
    }

    const handleTogglePin = () => {
        closeMenu()
        closeHoverCard(true)
        sessionService?.togglePin?.(session.id)
    }

    const handleMove = (projectId: string | undefined) => {
        closeMenu()
        sessionService?.setProject?.(session.id, projectId ?? null)
    }

    const handleToggleUnread = () => {
        closeMenu()
        if (session.unread) {
            sessionService?.markRead?.(session.id)
        } else {
            sessionService?.markUnreadManually?.(session.id)
        }
    }

    const handleArchive = async () => {
        closeMenu()
        closeHoverCard(true)
        await sessionService?.update?.(session.id, { archivedAt: Date.now() })
        if (isMobile) {
            uiService?.setSidebarCollapsed?.(true)
        }
        const remaining = sessions.filter((s: SessionItem) => s.id !== session.id && s.archivedAt === undefined)
        if (remaining.length > 0) {
            const nextId = remaining[0].id
            sessionService?.setCurrentSessionId?.(nextId)
            if (navigate) {
                void navigate({
                    to: '/chat/$sessionId',
                    params: { sessionId: nextId },
                })
            } else if (navigationService) {
                void navigationService.navigate({
                    to: '/chat/$sessionId',
                    params: { sessionId: nextId },
                } as any)
            }
        } else {
            sessionService?.setCurrentSessionId?.(null)
            if (navigate) {
                void navigate({ to: '/' })
            } else if (navigationService) {
                void navigationService.navigate({ to: '/' } as any)
            }
        }
    }

    const handleReveal = () => {
        if (!projectPath) return
        closeMenu()
        void revealProjectPath(projectPath, projectService as any).catch(() => {
            uiService?.pushToast?.(t('project.revealFailed'), 'error')
        })
    }

    const handleCopy = (value: string) => {
        closeMenu()
        void writeClipboard(value, uiService)
            .then(() => uiService?.pushToast?.(t('session.copySuccess'), 'info'))
            .catch(() => uiService?.pushToast?.(t('session.copyFailed'), 'error'))
    }

    const handleContinueInNewChat = async () => {
        closeMenu()
        closeHoverCard(true)
        try {
            const forkFn = sessionService?.forkSession ?? chatMessageService?.forkSession
            let forkedId: string | undefined
            if (forkFn) {
                forkedId = await forkFn(session.id)
            }
            if (forkedId) {
                sessionService?.setCurrentSessionId?.(forkedId)
                if (isMobile) {
                    uiService?.setSidebarCollapsed?.(true)
                }
                uiService?.pushToast?.(
                    t('message.forkSuccess', {
                        defaultValue: 'Forked new chat from current position',
                    }),
                    'success',
                )
                if (navigate) {
                    void navigate({
                        to: '/chat/$sessionId',
                        params: { sessionId: forkedId },
                    })
                } else if (navigationService) {
                    void navigationService.navigate(`/chat/${forkedId}`)
                }
            } else {
                uiService?.pushToast?.(t('message.forkFailed'), 'error')
            }
        } catch {
            uiService?.pushToast?.(t('message.forkFailed'), 'error')
        }
    }

    const handleContinueInWorktree = () => {
        closeMenu()
        closeHoverCard(true)
        setWorktreeModalOpen(true)
    }

    const handleConfirmContinueInWorktree = async (envId: string | null, targetBranch?: string) => {
        setIsCreatingWorktree(true)
        try {
            const targetProject = project ?? projects.find((p) => p.id === session.projectId) ?? null
            const sourceTreePath = targetProject ? getProjectPaths(targetProject)[0] : undefined

            if (!sourceTreePath) {
                uiService?.pushToast?.(
                    t('project.noPath', { defaultValue: 'Project path not set, cannot create worktree' }),
                    'error',
                )
                setIsCreatingWorktree(false)
                return
            }

            const effectiveBranch = targetBranch || session.branch || undefined

            // 1. Fork the session with workLocation: 'worktree' and environmentId
            const forkFn = sessionService?.forkSession ?? chatMessageService?.forkSession
            let forkedId: string | undefined

            if (forkFn) {
                forkedId = await forkFn(session.id, undefined, {
                    workLocation: 'worktree',
                    environmentId: envId,
                    branch: effectiveBranch,
                })
            }

            if (!forkedId) {
                uiService?.pushToast?.(
                    t('message.forkFailed', { defaultValue: 'Failed to fork chat' }),
                    'error',
                )
                setIsCreatingWorktree(false)
                return
            }

            // 2. Create worktree and setup environment
            if (worktreeService?.setup) {
                const setupResult = await worktreeService.setup({
                    sessionId: forkedId,
                    sourceTreePath,
                    branch: effectiveBranch,
                    environmentId: envId,
                })

                if (!setupResult.ok) {
                    uiService?.pushToast?.(
                        setupResult.error ||
                            t('worktree.setupFailed', { defaultValue: 'Worktree setup failed' }),
                        'error',
                    )
                } else {
                    uiService?.pushToast?.(
                        t('message.forkSuccess', {
                            defaultValue: 'Forked new chat from current position',
                        }),
                        'success',
                    )
                }
            } else {
                uiService?.pushToast?.(
                    t('message.forkSuccess', {
                        defaultValue: 'Forked new chat from current position',
                    }),
                    'success',
                )
            }

            // 3. Switch current session and navigate
            sessionService?.setCurrentSessionId?.(forkedId)
            if (isMobile) {
                uiService?.setSidebarCollapsed?.(true)
            }
            if (navigate) {
                void navigate({
                    to: '/chat/$sessionId',
                    params: { sessionId: forkedId },
                })
            } else if (navigationService) {
                void navigationService.navigate(`/chat/${forkedId}`)
            }

            setWorktreeModalOpen(false)
        } catch {
            uiService?.pushToast?.(
                t('worktree.setupFailed', { defaultValue: 'Worktree setup failed' }),
                'error',
            )
        } finally {
            setIsCreatingWorktree(false)
        }
    }

    const isWorktree = session.workLocation === 'worktree' || Boolean(session.worktreePath)
    const isWorktreeError = session.worktreeSetup?.status === 'error'

    return (
        <div ref={rowRef} className="group relative">
            <a
                href={`/chat/${session.id}`}
                onClick={handleSelect}
                onContextMenu={handleContextMenu}
                className={cn(
                    'flex h-8 select-none items-center gap-1.5 rounded-md py-1 pl-2 pr-2 text-[13px] transition-colors',
                    active
                        ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                )}
                title={session.title}
            >
                <span className="min-w-0 truncate">{session.title}</span>
                <div className="ml-auto flex items-center gap-1.5 shrink-0 transition-opacity group-hover:opacity-0 focus-within:opacity-0">
                    {/* Worktree: second from right */}
                    {isWorktreeError ? (
                        <span
                            data-testid="session-worktree-error-indicator"
                            role="status"
                            title={t('worktree.setupFailed', 'Worktree setup failed')}
                            aria-label={t('worktree.setupFailed', 'Worktree setup failed')}
                            className="flex size-3.5 items-center justify-center text-red-500"
                        >
                            <AlertCircle className="size-3" aria-hidden />
                        </span>
                    ) : isWorktree ? (
                        <span
                            data-testid="session-worktree-indicator"
                            className="flex size-3.5 items-center justify-center opacity-60 text-[var(--text-muted)]"
                            title={t('composer.workLocation.newWorktree', 'New local worktree')}
                        >
                            <GitFork className="size-3" aria-hidden />
                        </span>
                    ) : null}
                    {/* Running and unread indicators stay at the far right. */}
                    {isRunning ? (
                        <span
                            data-testid="session-running-indicator"
                            role="status"
                            title={t('session.running', 'Running')}
                            aria-label={t('session.running', 'Running')}
                            className="flex size-3.5 shrink-0 items-center justify-center text-[var(--accent-blue)]"
                        >
                            <Loader2 className="size-3 animate-spin-smooth" aria-hidden />
                        </span>
                    ) : null}
                    {session.unread && (!isCurrent || isManuallyMarkedUnread) ? (
                        <span
                            data-testid="session-unread-indicator"
                            className={cn(
                                'size-2 shrink-0 rounded-full',
                                session.unread === 'error'
                                    ? 'bg-[var(--accent-red,#ef4444)]'
                                    : 'bg-[var(--accent-blue,#3b82f6)]',
                            )}
                            aria-label={
                                session.unread === 'error'
                                    ? t('session.unreadError', 'Unread (Error)')
                                    : t('session.unread', 'Unread')
                            }
                        />
                    ) : null}
                </div>
            </a>

            <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-md bg-[var(--bg-sidebar-hover)] pl-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
                <button
                    type="button"
                    aria-label={session.pinned ? t('session.unpin') : t('session.pinChat')}
                    title={session.pinned ? t('session.unpin') : t('session.pinChat')}
                    className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        handleTogglePin()
                    }}
                >
                    {session.pinned ? (
                        <PinOff className="size-3.5" aria-hidden />
                    ) : (
                        <Pin className="size-3.5" aria-hidden />
                    )}
                </button>
                <button
                    type="button"
                    aria-label={t('session.archiveChat')}
                    title={t('session.archiveChat')}
                    className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void handleArchive()
                    }}
                >
                    <Archive className="size-3.5" aria-hidden />
                </button>
            </div>

            {!isMobile && hoverCardOpen && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={hoverCardRef}
                          id={hoverCardId}
                          role="dialog"
                          aria-label={t('session.details', { title: session.title })}
                          className="fixed z-40 w-80 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3 shadow-2xl"
                          style={hoverCardPosition}
                      >
                          <div className="mb-3 flex items-center gap-3">
                              {editingTitle ? (
                                  <input
                                      ref={titleInputRef}
                                      aria-label={t('session.editTitle')}
                                      value={titleDraft}
                                      className="min-w-0 flex-1 select-text rounded-md border border-[var(--accent-blue)] bg-[var(--bg-sidebar)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none"
                                      onChange={(event) => setTitleDraft(event.target.value)}
                                      onKeyDown={handleTitleKeyDown}
                                      onBlur={handleTitleBlur}
                                  />
                              ) : (
                                  <button
                                      type="button"
                                      className="min-w-0 flex-1 truncate rounded px-1 py-1 text-left text-[13px] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                                      title={t('session.editTitle')}
                                      onClick={beginTitleEdit}
                                  >
                                      {session.title}
                                  </button>
                              )}
                              {isRunning ? (
                                  <span
                                      data-testid="session-running-badge"
                                      className="inline-flex items-center gap-1 rounded-full bg-[var(--accent-blue)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent-blue)]"
                                  >
                                      <Loader2 className="size-3 animate-spin-smooth" aria-hidden />
                                      {t('session.running', 'Running')}
                                  </span>
                              ) : null}
                              <span className="shrink-0 text-[13px] text-[var(--text-muted)]">
                                  {t(sessionAge.key, { count: sessionAge.count })}
                              </span>
                          </div>
                          <div className="space-y-2 text-[13px] text-[var(--text-secondary)]">
                              {project ? (
                                  <div className="flex items-center gap-2">
                                      <Folder className="size-3.5 shrink-0 opacity-70" aria-hidden />
                                      <span className="truncate">{project.name}</span>
                                  </div>
                              ) : null}
                              {session.branch ? (
                                  <div className="flex items-center gap-2">
                                      <GitBranch className="size-3.5 shrink-0 opacity-70" aria-hidden />
                                      <span className="truncate">{session.branch}</span>
                                  </div>
                              ) : null}
                              <div className="flex items-center gap-2">
                                  <Clock className="size-3.5 shrink-0 opacity-70" aria-hidden />
                                  <span className="underline decoration-[var(--text-muted)] underline-offset-2">
                                      {t('session.noCiChecks')}
                                  </span>
                              </div>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}

            {menuOpen && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={menuRef}
                          role="menu"
                          aria-label={t('session.contextMenu', {
                              title: session.title,
                          })}
                          className="fixed z-50 w-52 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-2xl"
                          style={menuPosition}
                      >
                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleTogglePin}
                          >
                              <span className="min-w-0 flex-1 truncate">
                                  {session.pinned ? t('session.unpin') : t('session.pinChat')}
                              </span>
                          </button>

                          <div
                              className="relative"
                              onPointerEnter={() => setMoveMenuOpen(true)}
                              onPointerLeave={() => setMoveMenuOpen(false)}
                          >
                              <button
                                  type="button"
                                  role="menuitem"
                                  aria-haspopup="menu"
                                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                                  onClick={() => setMoveMenuOpen((open) => !open)}
                              >
                                  <span className="min-w-0 flex-1 truncate">{t('session.moveTo')}</span>
                                  <ChevronRight className="size-3.5" aria-hidden />
                              </button>
                              {moveMenuOpen ? (
                                  <div
                                      role="menu"
                                      aria-label={t('session.moveTo')}
                                      className="absolute left-full top-0 z-10 ml-1 w-52 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-2xl"
                                  >
                                      <button
                                          type="button"
                                          role="menuitem"
                                          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                                          onClick={() => handleMove(undefined)}
                                      >
                                          <span className="min-w-0 flex-1 truncate">{t('composer.noProject')}</span>
                                          {session.projectId === undefined ? (
                                              <Check className="size-3.5" aria-hidden />
                                          ) : null}
                                      </button>
                                      {sortedProjects.map((candidate: any) => (
                                          <button
                                              key={candidate.id}
                                              type="button"
                                              role="menuitem"
                                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                                              onClick={() => handleMove(candidate.id)}
                                          >
                                              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
                                              {candidate.id === session.projectId ? (
                                                  <Check className="size-3.5" aria-hidden />
                                              ) : null}
                                          </button>
                                      ))}
                                  </div>
                              ) : null}
                          </div>

                          {project ? (
                              <button
                                  type="button"
                                  role="menuitem"
                                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                                  onClick={() => handleMove(undefined)}
                              >
                                  <span className="min-w-0 flex-1 truncate">
                                      {t('session.removeFromProject', { name: project.name })}
                                  </span>
                              </button>
                          ) : null}

                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleRename}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.renameChat')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleArchive}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.archiveChat')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleToggleUnread}
                          >
                              <span className="min-w-0 flex-1 truncate">
                                  {session.unread ? t('session.markRead') : t('session.markUnread')}
                              </span>
                          </button>

                          <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" role="separator" />

                          <button
                              type="button"
                              role="menuitem"
                              disabled={!projectPath}
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                              onClick={handleReveal}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.showInFinder')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              disabled={!projectPath}
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                              onClick={() => {
                                  if (projectPath) handleCopy(projectPath)
                              }}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.copyWorkingDirectory')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={() => handleCopy(session.id)}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.copySessionId')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={() => {
                                  const deepLink = createHashRouteUrl(`/chat/${session.id}`)
                                  handleCopy(deepLink)
                              }}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.copyDeepLink')}</span>
                          </button>

                          <div className="mx-2 my-1 border-t border-[var(--border-subtle)]" role="separator" />

                          <button
                              type="button"
                              role="menuitem"
                              data-testid="session-menu-continue-chat"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleContinueInNewChat}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.continueInNewChat')}</span>
                          </button>

                          <button
                              type="button"
                              role="menuitem"
                              data-testid="session-menu-continue-worktree"
                              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                              onClick={handleContinueInWorktree}
                          >
                              <span className="min-w-0 flex-1 truncate">{t('session.continueInNewWorktree')}</span>
                          </button>
                      </div>,
                      document.body,
                  )
                : null}

            {worktreeModalOpen ? (
                <ContinueInWorktreeModal
                    session={session}
                    isOpen={worktreeModalOpen}
                    onClose={() => !isCreatingWorktree && setWorktreeModalOpen(false)}
                    onConfirm={handleConfirmContinueInWorktree}
                    isSubmitting={isCreatingWorktree}
                />
            ) : null}
        </div>
    )
}

export default SessionRow
