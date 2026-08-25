import { useEffect, useRef, useState } from 'react'
import {
    DirectoryBrowserModal,
    cn,
    getDefaultHostServices,
    useHostService,
    useProjects,
    useTranslation,
    Cloud,
    FolderPlus,
} from '@cpa/plugin-ui'
import {
    ProjectServiceToken,
    UiServiceToken,
    type Project,
    type ProjectDirectorySelection,
} from '@cpa/plugin-api'
import { getProjectPaths } from '../utils/projectPaths.js'
import { isBrowserEnvironment } from '../utils/platform.js'

export type { ProjectDirectorySelection }

export interface ProjectPickerProps {
    value: string | null
    onChange: (projectId: string | null) => void
    title?: string
    disabled?: boolean
    directoryPicker?: (
        title: string,
    ) => Promise<ProjectDirectorySelection | null>
    className?: string
}

export function sortProjects(projects: readonly Project[]): Project[] {
    return [...projects].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
    })
}

export async function defaultDirectoryPicker(
    title: string,
): Promise<ProjectDirectorySelection | null> {
    const defaultServices = getDefaultHostServices()
    if (defaultServices?.projects?.selectDirectory) {
        return await defaultServices.projects.selectDirectory(title)
    }
    return null
}

function optionClass(selected: boolean): string {
    return cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors',
        selected
            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
    )
}

/**
 * Compact project chip for the composer context bar (CPA-style).
 */
export function ProjectPicker({
    value,
    onChange,
    title,
    disabled = false,
    directoryPicker = defaultDirectoryPicker,
    className,
}: ProjectPickerProps) {
    const { t } = useTranslation()
    const projectService = useHostService(ProjectServiceToken)
    const uiService = useHostService(UiServiceToken)
    const projects = useProjects()

    const [open, setOpen] = useState(false)
    const [selecting, setSelecting] = useState(false)
    const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    const isCustomPicker = directoryPicker !== defaultDirectoryPicker
    const selected = projects.find((project) => project.id === value) ?? null
    const sorted = sortProjects(projects)

    useEffect(() => {
        if (disabled) setOpen(false)
    }, [disabled])

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

    const saveAndSelectProject = async (selection: ProjectDirectorySelection) => {
        const newProject: Project = {
            id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: selection.name,
            path: selection.path,
            paths: [selection.path],
            pinned: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        if (projectService) {
            await projectService.save(newProject)
        }
        onChange(newProject.id)
    }

    const handleAddProject = async () => {
        setOpen(false)
        if (!isCustomPicker && isBrowserEnvironment()) {
            setDirectoryBrowserOpen(true)
            return
        }
        setSelecting(true)
        try {
            const pickerFn = directoryPicker ?? defaultDirectoryPicker
            const selection = await pickerFn(
                t('composer.selectProjectDirectory'),
            )
            if (!selection) return
            await saveAndSelectProject(selection)
        } catch {
            uiService?.pushToast(t('composer.projectSelectionFailed'), 'error')
        } finally {
            setSelecting(false)
        }
    }

    const handleWebDirectorySelect = async (selection: ProjectDirectorySelection) => {
        setDirectoryBrowserOpen(false)
        if (!selection?.path) return
        try {
            await saveAndSelectProject(selection)
        } catch {
            uiService?.pushToast(t('composer.projectSelectionFailed'), 'error')
        }
    }

    const label = selected ? selected.name : t('composer.selectProject')

    return (
        <div ref={rootRef} className={cn('relative', className)}>
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={title ?? t('composer.selectProject')}
                title={title}
                disabled={disabled || selecting}
                aria-disabled={disabled || selecting}
                onClick={() => {
                    if (disabled || selecting) return
                    setOpen((prev) => !prev)
                }}
                className={cn(
                    'inline-flex max-w-[200px] items-center gap-1.5 rounded-full',
                    'border border-transparent bg-transparent',
                    'px-2.5 py-[5px] text-[12px] leading-none transition-colors',
                    'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    'hover:bg-[var(--bg-elevated)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    'disabled:pointer-events-none disabled:opacity-45',
                    selected
                        ? 'text-[var(--text-primary)]'
                        : 'hover:border-[var(--border-subtle)]',
                )}
            >
                <Cloud className="size-3.5 shrink-0 opacity-80" aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
            </button>

            {open ? (
                <div
                    role="listbox"
                    className={cn(
                        'absolute bottom-full left-0 z-30 mb-2 min-w-[220px] overflow-hidden',
                        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                        'bg-[var(--bg-elevated)] py-1 shadow-lg',
                    )}
                >
                    <button
                        type="button"
                        role="option"
                        aria-selected={value === null}
                        className={optionClass(value === null)}
                        onClick={() => {
                            onChange(null)
                            setOpen(false)
                        }}
                    >
                        <span className="truncate">{t('composer.noProject')}</span>
                    </button>

                    {sorted.map((project) => (
                        <button
                            key={project.id}
                            type="button"
                            role="option"
                            aria-selected={project.id === value}
                            className={optionClass(project.id === value)}
                            onClick={() => {
                                onChange(project.id)
                                setOpen(false)
                            }}
                        >
                            <Cloud className="size-3.5 shrink-0 opacity-70" aria-hidden />
                            <span
                                className="min-w-0 flex-1 truncate"
                                title={getProjectPaths(project).join('\n') || project.name}
                            >
                                {project.name}
                            </span>
                        </button>
                    ))}

                    <div className="my-1 border-t border-[var(--border-subtle)]" />

                    <button
                        type="button"
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]',
                            'text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                        onClick={() => {
                            void handleAddProject()
                        }}
                    >
                        <FolderPlus className="size-3.5 shrink-0 opacity-80" aria-hidden />
                        <span className="truncate">{t('composer.addProject')}</span>
                    </button>
                </div>
            ) : null}

            <DirectoryBrowserModal
                isOpen={directoryBrowserOpen}
                onClose={() => setDirectoryBrowserOpen(false)}
                onSelect={(selection) => void handleWebDirectorySelect(selection)}
            />
        </div>
    )
}

export default ProjectPicker
