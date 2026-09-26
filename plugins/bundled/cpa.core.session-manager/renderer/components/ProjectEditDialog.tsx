import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    DirectoryBrowserModal,
    cn,
    getDefaultHostServices,
    useHostService,
    useSessions,
    useTranslation,
    useWorkspaceVisible,
    Folder,
    FolderPlus,
    X,
} from '@cpa/plugin-ui'
import {
    ProjectServiceToken,
    SessionServiceToken,
    UiServiceToken,
    type Project,
    type ProjectDirectorySelection,
} from '@cpa/plugin-api'
import {
    createProjectPathsPatch,
    getProjectPaths,
} from '../utils/projectPaths.js'
import { isBrowserEnvironment } from '../utils/platform.js'

export interface ProjectEditDialogProps {
    project: Project
    onClose: () => void
    directoryPicker?: (
        title: string,
    ) => Promise<ProjectDirectorySelection | null>
}

/** Edit a project's name and source folders, or remove it from the app. */
export function ProjectEditDialog({
    project,
    onClose,
    directoryPicker,
}: ProjectEditDialogProps) {
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const titleId = useId()
    const nameInputRef = useRef<HTMLInputElement>(null)
    const projectService = useHostService(ProjectServiceToken)
    const sessionService = useHostService(SessionServiceToken)
    const uiService = useHostService(UiServiceToken)
    const sessions = useSessions()

    const [name, setName] = useState(project.name)
    const [paths, setPaths] = useState(() => getProjectPaths(project))
    const [selecting, setSelecting] = useState(false)
    const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)

    useEffect(() => {
        if (!workspaceVisible) return
        nameInputRef.current?.focus()
        nameInputRef.current?.select()

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [onClose, workspaceVisible])

    const isCustomPicker = directoryPicker !== undefined

    const handleAddPath = async () => {
        if (!isCustomPicker && isBrowserEnvironment()) {
            setDirectoryBrowserOpen(true)
            return
        }
        setSelecting(true)
        try {
            const defaultServices = getDefaultHostServices()
            const selectFn = directoryPicker ?? projectService?.selectDirectory ?? defaultServices?.projects?.selectDirectory
            const selection = await selectFn?.(t('composer.selectProjectDirectory'))
            if (selection && selection.path) {
                setPaths((current) =>
                    current.includes(selection.path)
                        ? current
                        : [...current, selection.path],
                )
            }
        } catch {
            uiService?.pushToast(t('composer.projectSelectionFailed'), 'error')
        } finally {
            setSelecting(false)
        }
    }

    const handleWebDirectorySelect = (selection: ProjectDirectorySelection) => {
        setDirectoryBrowserOpen(false)
        if (selection?.path) {
            setPaths((current) =>
                current.includes(selection.path)
                    ? current
                    : [...current, selection.path],
            )
        }
    }

    const handleSave = async () => {
        const trimmedName = name.trim()
        if (!trimmedName) return

        const updated: Project = {
            ...project,
            name: trimmedName,
            ...createProjectPathsPatch(paths),
            updatedAt: Date.now(),
        }

        if (projectService) {
            await projectService.save(updated)
        }
        onClose()
    }

    const handleRemove = async () => {
        for (const session of sessions) {
            if (session.projectId === project.id) {
                await sessionService?.update(session.id, { projectId: undefined })
            }
        }
        if (projectService) {
            await projectService.remove(project.id)
        }
        onClose()
    }

    if (typeof document === 'undefined') return null

    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-5"
            style={workspaceVisible ? undefined : { display: 'none' }}
            inert={!workspaceVisible}
            aria-hidden={!workspaceVisible}
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="w-full max-w-[544px] rounded-[18px] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 text-[var(--text-primary)] shadow-2xl"
            >
                <div className="mb-3 flex items-center gap-3">
                    <h2 id={titleId} className="min-w-0 flex-1 text-[20px] font-semibold">
                        {t('project.edit')}
                    </h2>
                    <button
                        type="button"
                        aria-label={t('project.closeEditor')}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                        onClick={onClose}
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <label className="mb-4 flex h-11 overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] focus-within:border-[var(--accent-blue)] focus-within:ring-1 focus-within:ring-[var(--accent-blue)]/35">
                    <span className="flex w-11 shrink-0 items-center justify-center border-r border-[var(--border-subtle)] text-[var(--text-secondary)]">
                        <Folder className="size-4" aria-hidden />
                    </span>
                    <span className="sr-only">{t('project.name')}</span>
                    <input
                        ref={nameInputRef}
                        value={name}
                        aria-label={t('project.name')}
                        className="min-w-0 flex-1 bg-transparent px-3 text-[14px] outline-none"
                        onChange={(event) => setName(event.target.value)}
                    />
                </label>

                <div className="mb-5">
                    <div className="mb-2 text-[13px] font-medium">
                        {t('project.sourceFolder')}
                    </div>
                    <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                        <div className="max-h-48 overflow-y-auto">
                            {paths.map((path, index) => (
                                <div key={path}>
                                    {index > 0 ? (
                                        <div className="border-t border-[var(--border-subtle)]" />
                                    ) : null}
                                    <div className="flex h-12 items-center gap-2.5 px-3 text-[14px]">
                                        <Folder
                                            className="size-4 shrink-0 text-[var(--text-secondary)]"
                                            aria-hidden
                                        />
                                        <span className="min-w-0 flex-1 truncate" title={path}>
                                            {getPathLabel(path)}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={t('project.removePath', { path })}
                                            className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                                            onClick={() =>
                                                setPaths((current) =>
                                                    current.filter((item) => item !== path),
                                                )
                                            }
                                        >
                                            <X className="size-3.5" aria-hidden />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {paths.length > 0 ? (
                            <div className="border-t border-[var(--border-subtle)]" />
                        ) : null}

                        <button
                            type="button"
                            className="flex h-12 w-full items-center gap-2.5 px-3 text-left text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] disabled:opacity-50"
                            disabled={selecting}
                            onClick={() => void handleAddPath()}
                        >
                            <FolderPlus
                                className="size-4 shrink-0 text-[var(--text-secondary)]"
                                aria-hidden
                            />
                            <span>{t('project.addFolder')}</span>
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        className="rounded-lg bg-red-500/15 px-4 py-2 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/25 hover:text-red-300"
                        onClick={handleRemove}
                    >
                        {t('project.remove')}
                    </button>
                    <div className="flex-1" />
                    <button
                        type="button"
                        className="rounded-lg px-4 py-2 text-[13px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                        onClick={onClose}
                    >
                        {t('project.cancel')}
                    </button>
                    <button
                        type="button"
                        className={cn(
                            'rounded-lg px-4 py-2 text-[13px] font-medium transition-colors',
                            'bg-[var(--text-primary)] text-[var(--bg-app)] hover:opacity-90',
                            'disabled:cursor-not-allowed disabled:opacity-40',
                        )}
                        disabled={!name.trim() || selecting}
                        onClick={handleSave}
                    >
                        {t('project.save')}
                    </button>
                </div>
            </div>

            <DirectoryBrowserModal
                isOpen={directoryBrowserOpen}
                onClose={() => setDirectoryBrowserOpen(false)}
                onSelect={handleWebDirectorySelect}
            />
        </div>,
        document.body,
    )
}

function getPathLabel(path: string): string {
    const normalized = path.replace(/[\\/]+$/, '')
    return normalized.split(/[\\/]/).pop() || path
}

export default ProjectEditDialog
