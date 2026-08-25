import {
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import {
    NavigationServiceToken,
    ProjectServiceToken,
    SessionServiceToken,
    UiServiceToken,
    type Project,
    type SessionItem,
} from '@cpa/plugin-api'
import {
    cn,
    createHashRouteUrl,
    useHostService,
    useProjects,
    useSessions,
    useTranslation,
    useUiState,
    Folder,
    FolderOpen,
    FolderSearch,
    Pin,
    PinOff,
    Settings,
    SquarePen,
    X,
} from '@cpa/plugin-ui'
import { useIsMobileBrowser } from '../utils/platform.js'
import { ProjectEditDialog } from './ProjectEditDialog.js'
import { SessionRow } from './SessionRow.js'
import { getProjectPaths } from '../utils/projectPaths.js'
import { revealProjectPath } from '../utils/projectReveal.js'
import { getLastUsedProjectWorktreeSettings } from '../utils/projectWorktreeSettings.js'
import {
    getOrderedSessions,
    getSessionFirstPromptTime,
    sortByFirstPromptDesc,
} from '../utils/sessionOrdering.js'

export {
    getOrderedSessions,
    getSessionFirstPromptTime,
    sortByFirstPromptDesc,
}

const UNCATEGORIZED_KEY = 'uncategorized'
export const SESSIONS_PER_PAGE = 10

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIX_REGEX = /^id_\w+_\w+$/

export function getOrphanProjectDisplayName(
    projectId: string,
    sessions: readonly SessionItem[],
    t: (key: string, defaultValue?: any) => string,
): string {
    for (const session of sessions) {
        const candidatePath =
            session.worktreeSetup?.sourceTreePath ||
            session.worktreeSetup?.worktreePath ||
            session.worktreePath
        if (candidatePath && typeof candidatePath === 'string') {
            const normalized = candidatePath.replace(/[\\/]+$/, '')
            const segments = normalized.split(/[\\/]/)
            const lastSegment = segments[segments.length - 1]
            if (lastSegment && lastSegment.trim()) {
                return lastSegment.trim()
            }
        }
        if (session.worktreeSetup?.environmentName && session.worktreeSetup.environmentName.trim()) {
            return session.worktreeSetup.environmentName.trim()
        }
    }

    if (!UUID_REGEX.test(projectId) && !ID_PREFIX_REGEX.test(projectId)) {
        return projectId
    }

    return t('project.unknownProject', 'Unknown project')
}

/**
 * Sidebar session & project tree contribution for `layout.sidebar.content`.
 */
export function SidebarSessionList() {
    const { t } = useTranslation()

    const sessionService = useHostService(SessionServiceToken)
    const projectService = useHostService(ProjectServiceToken)
    const navigationService = useHostService(NavigationServiceToken)
    const uiService = useHostService(UiServiceToken)

    const sessions = useSessions()
    const projects = useProjects()
    const isMobile = useIsMobileBrowser()
    useUiState()

    let navigate: any = null
    try {
        navigate = useNavigate()
    } catch {}

    const [editingProject, setEditingProject] = useState<Project | null>(null)
    const entriesBySession = sessionService?.getEntriesBySession?.()

    const activeSessions = useMemo(
        () => sessions.filter((session: SessionItem) => session.archivedAt === undefined),
        [sessions],
    )

    const pinnedSessions = useMemo(
        () => sortByFirstPromptDesc(activeSessions.filter((session: SessionItem) => session.pinned), entriesBySession),
        [activeSessions, entriesBySession],
    )

    const unpinnedSessions = useMemo(
        () => activeSessions.filter((session: SessionItem) => !session.pinned),
        [activeSessions],
    )

    const sortedProjects = useMemo(
        () =>
            [...projects].sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
                return b.updatedAt - a.updatedAt
            }),
        [projects],
    )

    const sessionsByProject = useMemo(() => {
        const map = new Map<string, SessionItem[]>()
        for (const session of unpinnedSessions) {
            if (!session.projectId) continue
            const list = map.get(session.projectId) ?? []
            list.push(session)
            map.set(session.projectId, list)
        }
        for (const [key, list] of map) {
            map.set(key, sortByFirstPromptDesc(list, entriesBySession))
        }
        return map
    }, [unpinnedSessions, entriesBySession])

    const uncategorizedSessions = useMemo(
        () => sortByFirstPromptDesc(unpinnedSessions.filter((session: SessionItem) => !session.projectId), entriesBySession),
        [unpinnedSessions, entriesBySession],
    )

    const orphanProjectIds = useMemo(() => {
        const known = new Set(projects.map((project) => project.id))
        const orphans: string[] = []
        for (const projectId of sessionsByProject.keys()) {
            if (!known.has(projectId)) orphans.push(projectId)
        }
        return orphans
    }, [projects, sessionsByProject])

    const beginNewChat = (projectId: string | null) => {
        sessionService?.setCurrentSessionId?.(null)
        const lastSettings = getLastUsedProjectWorktreeSettings(projectId, { sessions, projects })
        uiService?.setPendingSessionContext({
            projectId,
            branch: null,
            ...(lastSettings.workLocation !== undefined ? { workLocation: lastSettings.workLocation } : {}),
            ...(lastSettings.environmentId !== undefined ? { environmentId: lastSettings.environmentId } : {}),
        })
        if (isMobile) {
            uiService?.setSidebarCollapsed?.(true)
        }
        if (navigate) {
            void navigate({ to: '/' })
        } else if (navigationService) {
            void navigationService.navigate('/')
        } else if (typeof window !== 'undefined') {
            window.location.assign(createHashRouteUrl('/'))
        }
        uiService?.emitEvent?.('composer:focus')
    }

    const handleNewProjectChat = (projectId: string) => {
        beginNewChat(projectId)
    }

    const handleRemoveProject = async (projectId: string) => {
        for (const session of sessions) {
            if (session.projectId === projectId) {
                await sessionService?.update(session.id, { projectId: undefined })
            }
        }
        if (projectService) {
            await projectService.remove(projectId)
        }
    }

    const toggleProjectPin = async (projectId: string) => {
        if (projectService?.togglePin) {
            await projectService.togglePin(projectId)
        } else if (projectService) {
            const current = projects.find((p) => p.id === projectId)
            if (current) {
                await projectService.save({ ...current, pinned: !current.pinned })
            }
        }
    }

    const isGroupCollapsed = (groupKey: string): boolean => {
        return uiService?.isGroupCollapsed?.(groupKey) ?? false
    }

    const toggleGroup = (groupKey: string) => {
        uiService?.toggleGroup?.(groupKey)
    }

    return (
        <>
            {pinnedSessions.length > 0 ? (
                <SectionLabel>{t('nav.pinned')}</SectionLabel>
            ) : null}
            {pinnedSessions.map((session: SessionItem) => (
                <SessionRow key={session.id} session={session} />
            ))}

            {sortedProjects.length > 0 ||
            uncategorizedSessions.length > 0 ||
            orphanProjectIds.length > 0 ? (
                <SectionLabel className={pinnedSessions.length > 0 ? 'mt-3' : undefined}>
                    {t('nav.projects')}
                </SectionLabel>
            ) : null}

            {sortedProjects.map((project: Project) => (
                <ProjectGroup
                    key={project.id}
                    groupKey={`project:${project.id}`}
                    name={project.name}
                    sessions={sessionsByProject.get(project.id) ?? []}
                    collapsed={isGroupCollapsed(`project:${project.id}`)}
                    project={project}
                    onToggle={() => toggleGroup(`project:${project.id}`)}
                    onNewChat={() => handleNewProjectChat(project.id)}
                    onTogglePin={() => toggleProjectPin(project.id)}
                    onEdit={() => setEditingProject(project)}
                    onRemove={() => handleRemoveProject(project.id)}
                />
            ))}

            {orphanProjectIds.map((projectId: string) => {
                const orphanSessions = sessionsByProject.get(projectId) ?? []
                const displayName = getOrphanProjectDisplayName(projectId, orphanSessions, t)
                const inferredPath = orphanSessions
                    .map((s: SessionItem) => s.worktreeSetup?.sourceTreePath || s.worktreeSetup?.worktreePath || s.worktreePath)
                    .find((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
                const pseudoProject: Project = {
                    id: projectId,
                    name: displayName,
                    paths: inferredPath ? [inferredPath] : undefined,
                    path: inferredPath,
                    pinned: false,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                }
                return (
                    <ProjectGroup
                        key={projectId}
                        groupKey={`project:${projectId}`}
                        name={displayName}
                        sessions={orphanSessions}
                        collapsed={isGroupCollapsed(`project:${projectId}`)}
                        project={pseudoProject}
                        onToggle={() => toggleGroup(`project:${projectId}`)}
                        onNewChat={() => handleNewProjectChat(projectId)}
                        onTogglePin={() => toggleProjectPin(projectId)}
                        onEdit={() => setEditingProject(pseudoProject)}
                        onRemove={() => handleRemoveProject(projectId)}
                    />
                )
            })}

            {uncategorizedSessions.length > 0 ? (
                <ProjectGroup
                    groupKey={UNCATEGORIZED_KEY}
                    name={t('nav.uncategorized')}
                    sessions={uncategorizedSessions}
                    collapsed={isGroupCollapsed(UNCATEGORIZED_KEY)}
                    onToggle={() => toggleGroup(UNCATEGORIZED_KEY)}
                />
            ) : null}

            {editingProject ? (
                <ProjectEditDialog
                    project={editingProject}
                    onClose={() => setEditingProject(null)}
                />
            ) : null}
        </>
    )
}

function SectionLabel({
    children,
    className,
}: {
    children: ReactNode
    className?: string
}) {
    return (
        <div
            className={cn(
                'px-2.5 pb-1.5 pt-2.5 text-[11px] font-medium tracking-wide text-[var(--text-muted)]',
                className,
            )}
        >
            {children}
        </div>
    )
}

function ProjectGroup({
    groupKey,
    name,
    sessions,
    collapsed,
    project,
    onToggle,
    onNewChat,
    onTogglePin,
    onEdit,
    onRemove,
}: {
    groupKey: string
    name: string
    sessions: SessionItem[]
    collapsed: boolean
    project?: Project
    onToggle: () => void
    onNewChat?: () => void
    onTogglePin?: () => void
    onEdit?: () => void
    onRemove?: () => void
}) {
    const { t } = useTranslation()
    const isMobile = useIsMobileBrowser()
    const menuId = useId()
    const uiService = useHostService(UiServiceToken)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [menuOpen, setMenuOpen] = useState(false)
    const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 })
    const [visibleCount, setVisibleCount] = useState(SESSIONS_PER_PAGE)
    const hasSessions = sessions.length > 0
    const projectPaths = project ? getProjectPaths(project) : []
    const primaryPath = projectPaths[0]

    useEffect(() => {
        if (collapsed) {
            setVisibleCount(SESSIONS_PER_PAGE)
        }
    }, [collapsed])

    const visibleSessions = useMemo(
        () => sessions.slice(0, visibleCount),
        [sessions, visibleCount],
    )
    const hasMore = sessions.length > visibleCount

    const closeMenu = () => setMenuOpen(false)

    const openMenuAt = (left: number, top: number) => {
        if (!project) return

        const margin = 8
        const menuWidth = 192
        const menuHeight = 140
        setMenuPosition({
            left: Math.min(
                Math.max(margin, left),
                Math.max(margin, window.innerWidth - menuWidth - margin),
            ),
            top: Math.min(
                Math.max(margin, top),
                Math.max(margin, window.innerHeight - menuHeight - margin),
            ),
        })
        setMenuOpen(true)
    }

    const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (!project) return
        event.preventDefault()
        event.stopPropagation()
        openMenuAt(event.clientX, event.clientY)
    }

    const handleReveal = () => {
        if (!primaryPath) return
        closeMenu()
        void revealProjectPath(primaryPath).catch(() => {
            uiService?.pushToast(t('project.revealFailed'), 'error')
        })
    }

    useEffect(() => {
        if (!menuOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (
                !triggerRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            ) {
                closeMenu()
            }
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeMenu()
        }
        const handleViewportChange = () => closeMenu()

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleViewportChange)
        window.addEventListener('scroll', handleViewportChange, true)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleViewportChange)
            window.removeEventListener('scroll', handleViewportChange, true)
        }
    }, [menuOpen])

    return (
        <div className="mb-1.5" data-group={groupKey}>
            <div className="group relative">
                <button
                    ref={triggerRef}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-9 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    aria-expanded={!collapsed}
                    aria-haspopup={project ? 'menu' : undefined}
                    aria-controls={menuOpen && project ? menuId : undefined}
                    onClick={() => {
                        closeMenu()
                        onToggle()
                    }}
                    onContextMenu={handleContextMenu}
                    onKeyDown={(event) => {
                        if (
                            event.key === 'ContextMenu' ||
                            (event.shiftKey && event.key === 'F10')
                        ) {
                            event.preventDefault()
                            const rect = event.currentTarget.getBoundingClientRect()
                            openMenuAt(rect.left + 16, rect.bottom + 4)
                        }
                    }}
                >
                    {collapsed ? (
                        <Folder className="size-3.5 shrink-0 opacity-80" aria-hidden />
                    ) : (
                        <FolderOpen className="size-3.5 shrink-0 opacity-80" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1 truncate" title={name}>
                        {name}
                    </span>
                </button>

                {onNewChat ? (
                    <button
                        type="button"
                        aria-label={t('project.newChat', { name })}
                        title={t('project.newChat', { name })}
                        className={cn(
                            'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-[var(--text-muted)] transition-opacity hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] focus-visible:opacity-100',
                            isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                        onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            closeMenu()
                            onNewChat()
                        }}
                    >
                        <SquarePen className="size-3.5" aria-hidden />
                    </button>
                ) : null}
            </div>

            {!collapsed ? (
                hasSessions ? (
                    <div className="ml-2 space-y-0.5 border-l border-[var(--border-subtle)] pl-1.5">
                        {visibleSessions.map((session: SessionItem) => (
                            <SessionRow key={session.id} session={session} />
                        ))}
                        {hasMore ? (
                            <button
                                type="button"
                                className="flex h-7 w-full select-none items-center rounded-md px-2 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-secondary)]"
                                onClick={() =>
                                    setVisibleCount((prev: number) => prev + SESSIONS_PER_PAGE)
                                }
                            >
                                {t('project.showMore', 'Show more')}
                            </button>
                        ) : null}
                    </div>
                ) : (
                    <p className="px-2.5 py-1 text-[12px] text-[var(--text-muted)]">
                        {t('empty.noChats')}
                    </p>
                )
            ) : null}

            {menuOpen && project && typeof document !== 'undefined'
                ? createPortal(
                    <div
                        ref={menuRef}
                        id={menuId}
                        role="menu"
                        aria-label={project.name}
                        className="fixed z-50 w-48 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-2xl"
                        style={menuPosition}
                    >
                        <ProjectMenuItem
                            icon={project.pinned ? PinOff : Pin}
                            label={
                                project.pinned ? t('project.unpin') : t('project.pin')
                            }
                            onClick={() => {
                                closeMenu()
                                onTogglePin?.()
                            }}
                        />
                        <ProjectMenuItem
                            icon={FolderSearch}
                            label={t('project.showInFinder')}
                            disabled={!primaryPath}
                            onClick={handleReveal}
                        />
                        <ProjectMenuItem
                            icon={Settings}
                            label={t('project.edit')}
                            onClick={() => {
                                closeMenu()
                                onEdit?.()
                            }}
                        />
                        <ProjectMenuItem
                            icon={X}
                            label={t('project.remove')}
                            onClick={() => {
                                closeMenu()
                                onRemove?.()
                            }}
                        />
                    </div>,
                    document.body,
                )
                : null}
        </div>
    )
}

function ProjectMenuItem({
    icon: Icon,
    label,
    onClick,
    disabled = false,
}: {
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
    label: string
    onClick: () => void
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-secondary)]"
            onClick={onClick}
        >
            <Icon className="size-3.5 shrink-0 opacity-80" aria-hidden />
            <span>{label}</span>
        </button>
    )
}

export default SidebarSessionList
