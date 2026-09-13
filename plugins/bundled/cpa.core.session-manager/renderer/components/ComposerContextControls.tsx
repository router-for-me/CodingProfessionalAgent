import { useEffect, useMemo, useRef, useState } from 'react'
import {
    cn,
    useHostService,
    useProjects,
    useSessions,
    useTranslation,
    Check,
    GitFork,
    Laptop,
} from '@cpa/plugin-ui'
import {
    SessionServiceToken,
    UiServiceToken,
    type ComposerControlProps,
} from '@cpa/plugin-api'
import { ProjectPicker } from './ProjectPicker.js'
import { BranchPicker } from './BranchPicker.js'
import { EnvironmentPicker } from './EnvironmentPicker.js'
import { getProjectPaths } from '../utils/projectPaths.js'
import { getLastUsedProjectWorktreeSettings } from '../utils/projectWorktreeSettings.js'

export type WorkLocation = 'local' | 'worktree'

export function ProjectPickerControl({ sessionId, disabled, ...props }: ComposerControlProps) {
    const { t } = useTranslation()
    const sessionService = useHostService(SessionServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()
    const projects = useProjects()

    const globalSessionId = sessionService?.getCurrentSessionId?.()
    const effectiveSessionId = sessionId ?? globalSessionId
    const currentSession = effectiveSessionId
        ? sessions.find((session) => session.id === effectiveSessionId)
        : undefined

    const pendingContext = uiService?.getPendingSessionContext?.() ?? { projectId: null, branch: null }

    const projectId = (props.projectId as string | null | undefined) ?? (currentSession
        ? (currentSession.projectId ?? null)
        : pendingContext.projectId)

    const handleProjectChange = (next: string | null) => {
        if (typeof props.onChange === 'function') {
            ;(props.onChange as (val: string | null) => void)(next)
            return
        }
        const switching = Boolean(projectId && next && projectId !== next)
        const nextBranch = switching ? null : undefined
        if (next) {
            const lastSettings = getLastUsedProjectWorktreeSettings(next, { sessions, projects })
            uiService?.setPendingSessionContext?.({
                projectId: next,
                branch: nextBranch ?? null,
                ...(lastSettings.workLocation !== undefined ? { workLocation: lastSettings.workLocation } : {}),
                ...(lastSettings.environmentId !== undefined ? { environmentId: lastSettings.environmentId } : {}),
            })
        } else {
            uiService?.setPendingSessionContext?.({
                projectId: next,
                branch: nextBranch ?? null,
                ...(pendingContext.workLocation !== undefined ? { workLocation: pendingContext.workLocation } : {}),
                ...(pendingContext.environmentId !== undefined ? { environmentId: pendingContext.environmentId } : {}),
            })
        }
        if (effectiveSessionId && sessionService) {
            sessionService.setProject?.(effectiveSessionId, next)
            if (!next || switching) {
                sessionService.setBranch?.(effectiveSessionId, nextBranch ?? null)
            }
        }
    }

    return (
        <ProjectPicker
            value={projectId}
            onChange={handleProjectChange}
            disabled={disabled}
            title={projectId ? t('composer.changeChatProject') : undefined}
        />
    )
}

export function WorkLocationPickerControl({ sessionId, disabled, ...props }: ComposerControlProps) {
    const { t } = useTranslation()
    const sessionService = useHostService(SessionServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()

    const globalSessionId = sessionService?.getCurrentSessionId?.()
    const effectiveSessionId = sessionId ?? globalSessionId
    const currentSession = effectiveSessionId
        ? sessions.find((session) => session.id === effectiveSessionId)
        : undefined

    const pendingContext = uiService?.getPendingSessionContext?.() ?? { projectId: null, branch: null }

    const workLocation: WorkLocation = (props.workLocation as WorkLocation | undefined) ?? (currentSession
        ? (currentSession.workLocation ?? 'local')
        : (pendingContext.workLocation ?? 'local'))

    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onPointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', onPointerDown)
        return () => document.removeEventListener('mousedown', onPointerDown)
    }, [open])

    const handleSelect = (nextLocation: WorkLocation) => {
        setOpen(false)
        if (typeof props.onChange === 'function') {
            ;(props.onChange as (val: WorkLocation) => void)(nextLocation)
            return
        }
        if (effectiveSessionId && sessionService) {
            sessionService.setWorktree?.(effectiveSessionId, {
                sessionId: effectiveSessionId,
                status: 'idle',
                stepWorkspace: 'pending',
                stepCheckout: 'pending',
                stepEnvironment: 'pending',
                logs: '',
                expandedDetails: false,
            })
            void sessionService.update(effectiveSessionId, { workLocation: nextLocation })
        } else {
            uiService?.setPendingSessionContext?.({
                ...pendingContext,
                workLocation: nextLocation,
            })
        }
    }

    const isWorktree = workLocation === 'worktree'
    const ButtonIcon = isWorktree ? GitFork : Laptop
    const buttonLabel = isWorktree
        ? t('composer.workLocation.newWorktree', 'New local worktree')
        : t('composer.workLocation.local', 'Local')

    return (
        <div ref={rootRef} className="relative inline-flex">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('composer.workLocation', 'Work location')}
                title={t('composer.workLocation', 'Work location')}
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => {
                    if (disabled) return
                    setOpen((prev: boolean) => !prev)
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
                <ButtonIcon className="size-3.5 shrink-0 opacity-80" aria-hidden />
                <span className="min-w-0 truncate">{buttonLabel}</span>
            </button>

            {open ? (
                <div
                    role="menu"
                    aria-label={t('composer.workLocation', 'Work location')}
                    className={cn(
                        'absolute bottom-full left-0 z-30 mb-2 min-w-[200px] overflow-hidden',
                        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                        'bg-[var(--bg-elevated)] py-1 shadow-lg backdrop-blur-md',
                    )}
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleSelect('local')}
                        className={cn(
                            'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                            workLocation === 'local'
                                ? 'bg-[var(--bg-sidebar-hover)] font-semibold text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <Laptop className="size-3.5 shrink-0 opacity-80" />
                            <span>{t('composer.workLocation.local', 'Local')}</span>
                        </div>
                        {workLocation === 'local' ? <Check className="size-3.5 shrink-0 text-[var(--text-primary)]" /> : null}
                    </button>

                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => handleSelect('worktree')}
                        className={cn(
                            'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors',
                            workLocation === 'worktree'
                                ? 'bg-[var(--bg-sidebar-hover)] font-semibold text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <GitFork className="size-3.5 shrink-0 opacity-80" />
                            <span>{t('composer.workLocation.newWorktree', 'New local worktree')}</span>
                        </div>
                        {workLocation === 'worktree' ? <Check className="size-3.5 shrink-0 text-[var(--text-primary)]" /> : null}
                    </button>
                </div>
            ) : null}
        </div>
    )
}

export function EnvironmentPickerControl({ sessionId, disabled, ...props }: ComposerControlProps) {
    const sessionService = useHostService(SessionServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()

    const globalSessionId = sessionService?.getCurrentSessionId?.()
    const effectiveSessionId = sessionId ?? globalSessionId
    const currentSession = effectiveSessionId
        ? sessions.find((session) => session.id === effectiveSessionId)
        : undefined

    const pendingContext = uiService?.getPendingSessionContext?.() ?? { projectId: null, branch: null }

    const workLocation: WorkLocation = (props.workLocation as WorkLocation | undefined) ?? (currentSession
        ? (currentSession.workLocation ?? 'local')
        : (pendingContext.workLocation ?? 'local'))

    const projectId = (props.projectId as string | null | undefined) ?? (currentSession
        ? (currentSession.projectId ?? null)
        : pendingContext.projectId)

    const environmentId = (props.environmentId as string | null | undefined) ?? (currentSession
        ? (currentSession.environmentId ?? null)
        : (pendingContext.environmentId ?? null))

    if (workLocation !== 'worktree') {
        return null
    }

    const handleEnvironmentChange = (nextEnvId: string | null) => {
        if (typeof props.onChange === 'function') {
            ;(props.onChange as (val: string | null) => void)(nextEnvId)
            return
        }
        if (effectiveSessionId && sessionService) {
            void sessionService.update(effectiveSessionId, { environmentId: nextEnvId })
        } else {
            uiService?.setPendingSessionContext?.({
                ...pendingContext,
                environmentId: nextEnvId,
            })
        }
    }

    return (
        <EnvironmentPicker
            value={environmentId}
            projectId={projectId}
            onChange={handleEnvironmentChange}
            disabled={disabled}
        />
    )
}

export function BranchPickerControl({ sessionId, disabled, ...props }: ComposerControlProps) {
    const sessionService = useHostService(SessionServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()
    const projects = useProjects()

    const globalSessionId = sessionService?.getCurrentSessionId?.()
    const effectiveSessionId = sessionId ?? globalSessionId
    const currentSession = effectiveSessionId
        ? sessions.find((session) => session.id === effectiveSessionId)
        : undefined

    const pendingContext = uiService?.getPendingSessionContext?.() ?? { projectId: null, branch: null }

    const projectId = (props.projectId as string | null | undefined) ?? (currentSession
        ? (currentSession.projectId ?? null)
        : pendingContext.projectId)

    const branch = (props.branch as string | null | undefined) ?? (currentSession
        ? (currentSession.branch ?? null)
        : pendingContext.branch)

    const selectedProject = useMemo(
        () => projects.find((project) => project.id === projectId) ?? null,
        [projects, projectId],
    )

    const worktreePath = currentSession?.worktreePath || currentSession?.worktreeSetup?.worktreePath
    const projectPaths = useMemo(() => {
        if (currentSession?.workLocation === 'worktree' && worktreePath) {
            return [worktreePath]
        }
        return selectedProject ? getProjectPaths(selectedProject) : []
    }, [selectedProject, currentSession?.workLocation, worktreePath])

    if (!projectId) {
        return null
    }

    const handleBranchChange = (next: string | null) => {
        if (typeof props.onChange === 'function') {
            ;(props.onChange as (val: string | null) => void)(next)
            return
        }
        if (effectiveSessionId && sessionService) {
            sessionService.setBranch?.(effectiveSessionId, next)
        } else {
            uiService?.setPendingSessionContext?.({
                ...pendingContext,
                branch: next,
            })
        }
    }

    return (
        <BranchPicker
            value={branch}
            onChange={handleBranchChange}
            projectName={selectedProject?.name}
            projectPaths={projectPaths}
            disabled={disabled}
        />
    )
}
