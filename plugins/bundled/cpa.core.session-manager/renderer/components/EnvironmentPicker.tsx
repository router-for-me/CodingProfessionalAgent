import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Settings, cn, useHostServices, useProjects, useTranslation } from '@cpa/plugin-ui'
import type { Project } from '@cpa/plugin-api'
import { getProjectPaths } from '../utils/projectPaths.js'

export interface EnvironmentPickerProps {
    value?: string | null
    projectId?: string | null
    onChange?: (environmentId: string | null) => void
    disabled?: boolean
    className?: string
    readFileBridge?: any
    projects?: Project[]
}

/**
 * Compact environment chip for worktree mode in the composer context bar (CPA-style).
 * Lists environments or allows working without an environment / configuring project environments.
 */
export function EnvironmentPicker({
    value: controlledValue,
    projectId,
    onChange,
    disabled = false,
    className,
    readFileBridge,
    projects: customProjects,
}: EnvironmentPickerProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const storeProjects = useProjects()
    const projects = customProjects ?? (storeProjects as Project[])

    const [internalValue, setInternalValue] = useState<string | null>(null)
    const activeValue = controlledValue !== undefined ? controlledValue : internalValue

    const [open, setOpen] = useState(false)
    const [envProjects, setEnvProjects] = useState<Project[]>([])
    const rootRef = useRef<HTMLDivElement>(null)

    const currentProject = (
        projectId !== undefined
            ? (projectId
                  ? projects.find(
                        (p) =>
                            p.id === projectId ||
                            p.name === projectId ||
                            p.path === projectId ||
                            p.paths?.includes(projectId),
                    )
                  : null)
            : (activeValue
                  ? projects.find((p) => p.id === activeValue || p.name === activeValue)
                  : null)
    ) ?? null

    useEffect(() => {
        if (disabled) setOpen(false)
    }, [disabled])

    useEffect(() => {
        let isMounted = true

        const checkCurrentProject = async () => {
            if (!currentProject) {
                if (isMounted) {
                    setEnvProjects([])
                }
                return
            }

            const paths = getProjectPaths(currentProject)
            let hasEnv = false
            for (const p of paths) {
                const candidates = [
                    `${p}/.cpa/environments/environment.toml`,
                    `${p}/environment.toml`,
                    `${p}/.cpa/environment.toml`,
                ]
                for (const tomlPath of candidates) {
                    try {
                        let res: any = null
                        if (readFileBridge) {
                            if (typeof readFileBridge.ReadFile === 'function') {
                                res = await readFileBridge.ReadFile(tomlPath)
                            } else if (typeof readFileBridge === 'function') {
                                res = await readFileBridge(tomlPath)
                            }
                        } else if (services?.fileSystem) {
                            res =
                                (await services.fileSystem.readFileIfExists?.(tomlPath)) ??
                                (await services.fileSystem.readFile(tomlPath).catch(() => null))
                        }
                        if (res !== null && res !== undefined) {
                            hasEnv = true
                            break
                        }
                    } catch {
                        // Ignore read errors
                    }
                }
                if (hasEnv) break
            }

            if (isMounted) {
                setEnvProjects(hasEnv ? [currentProject] : [])
            }
        }

        void checkCurrentProject()

        const onEnvChanged = () => {
            void checkCurrentProject()
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('cpa:environment-changed', onEnvChanged)
        }

        return () => {
            isMounted = false
            if (typeof window !== 'undefined') {
                window.removeEventListener('cpa:environment-changed', onEnvChanged)
            }
        }
    }, [currentProject, readFileBridge, services?.fileSystem])

    useEffect(() => {
        if (!open) return

        const onPointerDown = (event: MouseEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false)
            }
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false)
            }
        }

        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    const handleSelectEnv = (environmentId: string | null) => {
        if (controlledValue === undefined) {
            setInternalValue(environmentId)
        }
        onChange?.(environmentId)
        setOpen(false)
    }

    const handleSetupProject = () => {
        setOpen(false)
        const targetProject =
            currentProject ??
            (activeValue
                ? projects.find((p) => p.id === activeValue || p.name === activeValue)
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

    const isCurrentProjectSelected =
        Boolean(currentProject) &&
        (activeValue === currentProject?.id || activeValue === currentProject?.name)

    const label =
        isCurrentProjectSelected && currentProject
            ? currentProject.name
            : t('composer.environment.noEnvironment', { defaultValue: 'No environment' })

    return (
        <div ref={rootRef} className={cn('relative', className)}>
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('composer.environment', { defaultValue: 'Environment' })}
                title={t('composer.environment', { defaultValue: 'Environment' })}
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
                <Settings className="size-3.5 shrink-0 opacity-80" aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
            </button>

            {open ? (
                <div
                    role="menu"
                    aria-label={t('composer.environment', { defaultValue: 'Environment' })}
                    className={cn(
                        'absolute bottom-full left-0 z-30 mb-2 min-w-[210px] overflow-hidden',
                        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                        'bg-[var(--bg-elevated)] py-1.5 shadow-lg backdrop-blur-md',
                    )}
                >
                    <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--text-muted)] select-none">
                        {t('composer.environment', { defaultValue: 'Environment' })}
                    </div>

                    {/* Option 1: Work without environment */}
                    <button
                        type="button"
                        role="menuitem"
                        className={cn(
                            'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
                            'text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]',
                        )}
                        onClick={() => handleSelectEnv(null)}
                    >
                        <span className="truncate">
                            {t('composer.environment.workWithoutEnvironment', {
                                defaultValue: 'Work without environment',
                            })}
                        </span>
                        {!isCurrentProjectSelected ? (
                            <Check
                                className="size-3.5 shrink-0 text-[var(--text-primary)]"
                                aria-hidden
                            />
                        ) : null}
                    </button>

                    {/* Option 2: Projects with environment.toml */}
                    {envProjects.map((project) => {
                        const isSelected = isCurrentProjectSelected
                        return (
                            <button
                                key={project.id}
                                type="button"
                                role="menuitem"
                                className={cn(
                                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
                                    'text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]',
                                )}
                                onClick={() => handleSelectEnv(project.id)}
                            >
                                <span className="truncate">{project.name}</span>
                                {isSelected ? (
                                    <Check
                                        className="size-3.5 shrink-0 text-[var(--text-primary)]"
                                        aria-hidden
                                    />
                                ) : null}
                            </button>
                        )
                    })}

                    <div className="my-1 border-t border-[var(--border-subtle)]" />

                    {/* Option 3: Set up project */}
                    <button
                        type="button"
                        role="menuitem"
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors',
                            'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                        onClick={handleSetupProject}
                    >
                        <ExternalLink className="size-3.5 shrink-0 opacity-80" aria-hidden />
                        <span className="truncate">
                            {t('composer.environment.setupProject', { defaultValue: 'Set up project' })}
                        </span>
                    </button>
                </div>
            ) : null}
        </div>
    )
}
