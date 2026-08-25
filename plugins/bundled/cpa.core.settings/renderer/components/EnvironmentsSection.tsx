import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ArrowLeft,
    Bug,
    Check,
    ChevronRight,
    Copy,
    DirectoryBrowserModal,
    FlaskConical,
    Notebook,
    Pencil,
    Play,
    Plus,
    Settings,
    Trash2,
    cn,
    useHostService,
    useProjects,
    useTranslation,
    useUiState,
} from '@cpa/plugin-ui'
import {
    ProjectServiceToken,
    UiServiceToken,
    type Project,
    type ProjectDirectorySelection,
    type ProjectEnvironmentAction,
    type ProjectEnvironmentScripts,
} from '@cpa/plugin-api'
import {
    type EnvironmentPlatform,
    type ProjectEnvironmentConfig,
    type ReadFileBridge,
    type WriteFileBridge,
    normalizeActionPlatform,
    readProjectEnvironment,
    saveProjectEnvironment,
} from '../utils/environmentToml.js'
import { isBrowserEnvironment } from '../utils/platform.js'
import { getProjectPaths } from '../utils/projectPaths.js'

type PlatformTab = EnvironmentPlatform
type ViewMode = 'list' | 'detail' | 'edit'

export const ACTION_ICON_OPTIONS = [
    { id: 'tool', labelKey: 'settings.environments.iconTool', defaultLabel: 'Tool', icon: Settings },
    { id: 'run', labelKey: 'settings.environments.iconRun', defaultLabel: 'Run', icon: Play },
    { id: 'debug', labelKey: 'settings.environments.iconDebug', defaultLabel: 'Debug', icon: Bug },
    { id: 'test', labelKey: 'settings.environments.iconTest', defaultLabel: 'Test', icon: FlaskConical },
] as const

export const ACTION_ICONS = ['tool', 'run', 'debug', 'test'] as const
export type ActionIconType = (typeof ACTION_ICONS)[number]

export function renderActionIcon(icon?: string, className = 'size-5') {
    const norm = (icon || '').toLowerCase().trim()
    switch (norm) {
        case 'test':
            return <FlaskConical className={className} aria-hidden />
        case 'debug':
            return <Bug className={className} aria-hidden />
        case 'tool':
            return <Settings className={className} aria-hidden />
        case 'run':
        default:
            return <Play className={className} aria-hidden />
    }
}

const DEFAULT_DETAIL_SETUP_SCRIPT = 'cd "$CODEX_SOURCE_TREE_PATH"'
const DEFAULT_DETAIL_CLEANUP_SCRIPT = 'cd "$CODEX_WORKTREE_PATH"'

const DEFAULT_SETUP_SCRIPT_PLACEHOLDER = `cd "$CODEX_WORKTREE_PATH"
pip install -r requirements.txt
npm install
./run/setup.sh`

const DEFAULT_CLEANUP_SCRIPT_PLACEHOLDER = `docker compose down --remove-orphans
rm -rf .cache/tmp`

const DEFAULT_ACTION_SCRIPT_PLACEHOLDER = `npm run dev`

export interface EnvironmentsSectionProps {
    /** Injectable native directory picker used by tests. */
    directoryPicker?: (
        title: string,
    ) => Promise<ProjectDirectorySelection | null>
    /** Injectable file read bridge used by tests or custom runners. */
    readFileBridge?: ReadFileBridge
    /** Injectable file write bridge used by tests or custom runners. */
    writeFileBridge?: WriteFileBridge
}

function renderBashTokens(line: string) {
    if (!line.trim()) {
        return <span>&nbsp;</span>
    }
    if (line.trim().startsWith('#')) {
        return <span className="text-[var(--text-muted)]">{line}</span>
    }

    const tokens: React.ReactNode[] = []
    const regex =
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\$[A-Za-z0-9_]+|--?[A-Za-z0-9_-]+|\b(?:cd|npm|pip|pip3|docker|rm|mkdir|cp|mv|echo|export|git|source|sh|bash|cat|touch|node|pnpm|yarn|run|compose|build|install)\b|[^\s"'$]+|\s+)/g

    let match: RegExpExecArray | null
    let keyIdx = 0

    while ((match = regex.exec(line)) !== null) {
        const text = match[0]
        if (!text) continue

        if (text.startsWith('"') || text.startsWith("'") || text.startsWith('$')) {
            tokens.push(
                <span key={keyIdx++} className="text-[#ec4899] dark:text-[#f472b6]">
                    {text}
                </span>
            )
        } else if (text.startsWith('-')) {
            tokens.push(
                <span key={keyIdx++} className="text-sky-400">
                    {text}
                </span>
            )
        } else if (
            /^(?:cd|npm|pip|pip3|docker|rm|mkdir|cp|mv|echo|export|git|source|sh|bash|cat|touch|node|pnpm|yarn|run|compose|build|install)$/.test(
                text
            )
        ) {
            tokens.push(
                <span key={keyIdx++} className="text-amber-400 dark:text-[#e5c07b]">
                    {text}
                </span>
            )
        } else {
            tokens.push(<span key={keyIdx++}>{text}</span>)
        }
    }

    return <span>{tokens}</span>
}

function HighlightedBash({ code }: { code: string }) {
    const lines = code.split('\n')
    return (
        <div className="font-mono text-[12.5px] leading-relaxed text-[var(--text-primary)] select-text space-y-0.5">
            {lines.map((line, idx) => (
                <div key={idx}>{renderBashTokens(line)}</div>
            ))}
        </div>
    )
}

/**
 * Environments settings panel replicating CPA Environments UI 1:1.
 * Supports reading/saving .cpa/environments/environment.toml (and .codex compatibility)
 * and switching between list view, detail view, and edit view for workspace projects.
 */
export function EnvironmentsSection({
    directoryPicker,
    readFileBridge,
    writeFileBridge,
}: EnvironmentsSectionProps = {}) {
    const { t } = useTranslation()
    const projects = useProjects()
    const projectService = useHostService(ProjectServiceToken)
    const uiService = useHostService(UiServiceToken)
    const settingsParams = useUiState((s) => s?.settingsParams)
    const isFromChat = Boolean(settingsParams?.fromChat || settingsParams?.returnToChat)

    const pushToast = (msg: string, type?: 'info' | 'success' | 'warning' | 'error') =>
        uiService?.pushToast(msg, type)

    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
    const [viewMode, setViewMode] = useState<ViewMode>('list')
    const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
    const [selecting, setSelecting] = useState(false)

    // Loaded environment.toml config and resolved file path
    const [envConfig, setEnvConfig] = useState<ProjectEnvironmentConfig | null>(null)
    const [envFilePath, setEnvFilePath] = useState<string | null>(null)
    const [projectEnvStatus, setProjectEnvStatus] = useState<Record<string, boolean>>({})

    // Form state in edit view
    const [projectName, setProjectName] = useState('')
    const [setupPlatform, setSetupPlatform] = useState<PlatformTab>('default')
    const [setupScripts, setSetupScripts] = useState<ProjectEnvironmentScripts>({})
    const [cleanupPlatform, setCleanupPlatform] = useState<PlatformTab>('default')
    const [cleanupScripts, setCleanupScripts] = useState<ProjectEnvironmentScripts>({})
    const [actions, setActions] = useState<ProjectEnvironmentAction[]>([])

    // Detail view platform tabs state
    const [detailSetupPlatform, setDetailSetupPlatform] = useState<PlatformTab>('default')
    const [detailCleanupPlatform, setDetailCleanupPlatform] = useState<PlatformTab>('default')

    // Action icon menu state
    const [openActionIconMenuId, setOpenActionIconMenuId] = useState<string | null>(null)

    // Track applied navigation params to prevent repeated resets when store projects mutate
    const appliedParamsRef = useRef<Record<string, unknown> | null | undefined>(undefined)
    const rootRef = useRef<HTMLDivElement>(null)

    // Reset scroll container to top whenever viewMode or selectedProjectId changes
    useEffect(() => {
        const scrollParent = rootRef.current?.closest('.overflow-y-auto')
        if (scrollParent) {
            scrollParent.scrollTop = 0
        }
    }, [viewMode, selectedProjectId])

    // Variables popover state
    const [variablesOpen, setVariablesOpen] = useState(false)
    const [copiedKey, setCopiedKey] = useState<string | null>(null)
    const variablesContainerRef = useRef<HTMLDivElement>(null)
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Detect environment.toml for all projects in list
    useEffect(() => {
        let isMounted = true

        const checkProjects = async () => {
            const statusMap: Record<string, boolean> = {}
            await Promise.all(
                projects.map(async (project) => {
                    const paths = getProjectPaths(project)
                    const primaryPath = paths[0]
                    if (!primaryPath) {
                        statusMap[project.id] = false
                        return
                    }
                    try {
                        const result = await readProjectEnvironment(primaryPath, readFileBridge)
                        statusMap[project.id] = result !== null
                    } catch {
                        statusMap[project.id] = false
                    }
                })
            )
            if (isMounted) {
                setProjectEnvStatus(statusMap)
            }
        }

        void checkProjects()

        const onEnvChanged = () => {
            void checkProjects()
        }
        const unsubUi = uiService?.subscribe ? uiService.subscribe(onEnvChanged) : undefined
        const unsubProjects = projectService?.subscribe ? projectService.subscribe(onEnvChanged) : undefined

        return () => {
            isMounted = false
            unsubUi?.()
            unsubProjects?.()
        }
    }, [projects, readFileBridge, envFilePath, uiService, projectService])

    const setupEditForm = useCallback(
        (project: Project, config?: ProjectEnvironmentConfig | null) => {
            const initialName = config?.name || project.name
            const initialSetupScripts: ProjectEnvironmentScripts = {
                ...(project.setupScripts || {}),
                ...(config?.setupScripts || {}),
            }
            if (project.setupScript && !initialSetupScripts.default) {
                initialSetupScripts.default = project.setupScript
            }

            const initialCleanupScripts: ProjectEnvironmentScripts = {
                ...(project.cleanupScripts || {}),
                ...(config?.cleanupScripts || {}),
            }
            if (project.cleanupScript && !initialCleanupScripts.default) {
                initialCleanupScripts.default = project.cleanupScript
            }

            const initialActions: ProjectEnvironmentAction[] =
                config?.actions && config.actions.length > 0
                    ? config.actions
                    : project.actions || []

            setProjectName(initialName)
            setSetupScripts(initialSetupScripts)
            setCleanupScripts(initialCleanupScripts)
            setSetupPlatform(project.setupPlatform ?? 'default')
            setCleanupPlatform(project.cleanupPlatform ?? 'default')
            setActions(initialActions)
        },
        [],
    )

    useEffect(() => {
        if (!settingsParams) {
            appliedParamsRef.current = null
            return
        }

        if (appliedParamsRef.current === settingsParams) {
            return
        }

        if (settingsParams.projectId && typeof settingsParams.projectId === 'string') {
            const targetProj = projects.find(
                (p) =>
                    p.id === settingsParams.projectId ||
                    p.name === settingsParams.projectId ||
                    p.paths?.includes(settingsParams.projectId as string) ||
                    p.path === settingsParams.projectId,
            )
            if (targetProj) {
                appliedParamsRef.current = settingsParams

                const requestedMode: ViewMode =
                    settingsParams.mode === 'detail'
                        ? 'detail'
                        : settingsParams.mode === 'list'
                          ? 'list'
                          : 'edit'
                setSelectedProjectId(targetProj.id)
                setViewMode(requestedMode)
                setDetailSetupPlatform('default')
                setDetailCleanupPlatform('default')

                const paths = getProjectPaths(targetProj)
                const primaryPath = paths[0]
                if (primaryPath) {
                    void readProjectEnvironment(primaryPath, readFileBridge).then((result) => {
                        setupEditForm(targetProj, result?.config ?? null)
                    })
                } else {
                    setupEditForm(targetProj, null)
                }
            }
        }
    }, [settingsParams, projects, readFileBridge, setupEditForm])

    const selectedProject = useMemo(() => {
        if (!selectedProjectId) return null
        return projects.find((p) => p.id === selectedProjectId) ?? null
    }, [projects, selectedProjectId])

    // Load environment.toml whenever selectedProject changes
    useEffect(() => {
        if (!selectedProject) {
            setEnvConfig(null)
            setEnvFilePath(null)
            return
        }

        const projectPaths = getProjectPaths(selectedProject)
        const primaryPath = projectPaths[0]
        if (!primaryPath) {
            setEnvConfig(null)
            setEnvFilePath(null)
            return
        }

        let isMounted = true
        void readProjectEnvironment(primaryPath, readFileBridge).then((result) => {
            if (!isMounted) return
            if (result) {
                setEnvConfig(result.config)
                setEnvFilePath(result.filePath)
            } else {
                setEnvConfig(null)
                setEnvFilePath(null)
            }
        })

        return () => {
            isMounted = false
        }
    }, [selectedProject, readFileBridge])

    const handleCopyText = useCallback(
        (text: string, key: string, toastMessage?: string) => {
            void navigator.clipboard?.writeText?.(text)
            setCopiedKey(key)
            pushToast(toastMessage || t('settings.environments.varCopied', 'Copied to clipboard'))
            if (copyTimeoutRef.current) {
                clearTimeout(copyTimeoutRef.current)
            }
            copyTimeoutRef.current = setTimeout(() => {
                setCopiedKey(null)
                copyTimeoutRef.current = null
            }, 2000)
        },
        [pushToast, t]
    )

    useEffect(() => {
        if (!variablesOpen && !openActionIconMenuId) return

        const onPointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (variablesContainerRef.current?.contains(target)) return
            if ((target as Element).closest?.('[data-action-icon-container]')) return
            setVariablesOpen(false)
            setOpenActionIconMenuId(null)
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setVariablesOpen(false)
                setOpenActionIconMenuId(null)
            }
        }

        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown, true)
        }
    }, [variablesOpen, openActionIconMenuId])

    useEffect(() => {
        return () => {
            if (copyTimeoutRef.current) {
                clearTimeout(copyTimeoutRef.current)
            }
        }
    }, [])

    const sortedProjects = useMemo(() => {
        return [...projects].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
            return b.updatedAt - a.updatedAt
        })
    }, [projects])

    const handleSelectProject = (project: Project) => {
        setSelectedProjectId(project.id)
        setViewMode('detail')
        setDetailSetupPlatform('default')
        setDetailCleanupPlatform('default')
    }

    const handleSelectProjectForEdit = (project: Project) => {
        setSelectedProjectId(project.id)
        setupEditForm(project, null)
        setDetailSetupPlatform('default')
        setDetailCleanupPlatform('default')
        setViewMode('edit')
    }

    const handleOpenEdit = () => {
        if (!selectedProject) return
        setupEditForm(selectedProject, envConfig)
        setViewMode('edit')
    }

    const handleBackToList = () => {
        setSelectedProjectId(null)
        setViewMode('list')
    }

    const handleBack = () => {
        if (isFromChat) {
            uiService?.closeSettings?.()
        } else {
            handleBackToList()
        }
    }

    const handleBackToDetail = () => {
        setViewMode('detail')
    }

    const handleAddAction = () => {
        const newAction: ProjectEnvironmentAction = {
            id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
            name: '',
            script: '',
            icon: 'run',
        }
        setActions((prev) => [...prev, newAction])
    }

    const handleUpdateAction = (
        id: string,
        patch: Partial<ProjectEnvironmentAction>
    ) => {
        setActions((prev) =>
            prev.map((act) => (act.id === id ? { ...act, ...patch } : act))
        )
    }

    const handleDeleteAction = (id: string) => {
        setActions((prev) => prev.filter((act) => act.id !== id))
    }

    const handleSave = () => {
        if (!selectedProject) return

        const finalName = projectName.trim() || selectedProject.name
        const validActions: ProjectEnvironmentAction[] = actions
            .map((act) => {
                const normPlatform = normalizeActionPlatform(act.platform)
                const actionObj: ProjectEnvironmentAction = {
                    id: act.id,
                    name: act.name.trim(),
                    script: (act.script || act.command || '').trim(),
                    icon: act.icon || 'run',
                }
                if (normPlatform) {
                    actionObj.platform = normPlatform
                }
                return actionObj
            })
            .filter((act) => act.name.length > 0 || act.script.length > 0)

        const defaultSetup = setupScripts.default?.trim()
        const defaultCleanup = cleanupScripts.default?.trim()

        const newConfig: ProjectEnvironmentConfig = {
            version: 1,
            name: finalName,
            setupScripts,
            cleanupScripts,
            actions: validActions,
        }

        if (projectService) {
            void projectService.save({
                ...selectedProject,
                name: finalName,
                setupScript: defaultSetup || Object.values(setupScripts).find((s) => s?.trim()) || undefined,
                cleanupScript: defaultCleanup || Object.values(cleanupScripts).find((s) => s?.trim()) || undefined,
                setupScripts,
                cleanupScripts,
                setupPlatform,
                cleanupPlatform,
                actions: validActions.length > 0 ? validActions : undefined,
            })
        }

        setEnvConfig(newConfig)

        const projectPaths = getProjectPaths(selectedProject)
        const primaryPath = projectPaths[0]
        if (primaryPath) {
            void saveProjectEnvironment(
                primaryPath,
                newConfig,
                envFilePath || undefined,
                writeFileBridge
            ).then((savedPath) => {
                if (savedPath) {
                    setEnvFilePath(savedPath)
                }
            })
        }

        setViewMode('detail')
    }

    const isCustomPicker = directoryPicker !== undefined

    const handleAddProject = async () => {
        if (!isCustomPicker && isBrowserEnvironment()) {
            setDirectoryBrowserOpen(true)
            return
        }
        setSelecting(true)
        try {
            let selection: ProjectDirectorySelection | null = null
            if (directoryPicker) {
                selection = await directoryPicker(
                    t('composer.selectProjectDirectory', 'Select project directory')
                )
            } else if (projectService?.selectDirectory) {
                selection = await projectService.selectDirectory(
                    t('composer.selectProjectDirectory', 'Select project directory')
                )
            }
            if (!selection) return
            const newProj: Project = {
                id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: selection.name,
                path: selection.path,
                paths: [selection.path],
                pinned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
            if (projectService) {
                await projectService.save(newProj)
            }
            handleSelectProject(newProj)
        } catch {
            pushToast(t('composer.projectSelectionFailed', 'Failed to select project directory'))
        } finally {
            setSelecting(false)
        }
    }

    const handleWebDirectorySelect = async (selection: ProjectDirectorySelection) => {
        const newProj: Project = {
            id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: selection.name,
            path: selection.path,
            paths: [selection.path],
            pinned: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        if (projectService) {
            await projectService.save(newProj)
        }
        setDirectoryBrowserOpen(false)
        handleSelectProject(newProj)
    }

    // Detail View (1:1 replica of reference screenshot QQ20260826-183349.png & QQ20260826-191050.png)
    if (selectedProject && viewMode === 'detail') {
        const hasEnvironmentConfig = Boolean(envConfig || envFilePath)
        const effectiveName = envConfig?.name || selectedProject.name

        // When environment.toml is not configured, render empty state (matching QQ20260826-191050.png)
        if (!hasEnvironmentConfig) {
            return (
                <div ref={rootRef} className="relative">
                    {/* Topbar Breadcrumbs */}
                    <div
                        className="sticky top-0 z-10 flex h-11 w-full items-center bg-[var(--bg-app)] px-8"
                    >
                        <nav
                            aria-label="Breadcrumb"
                            className="flex items-center gap-2 text-[13px]"
                        >
                            {isFromChat ? (
                                <button
                                    type="button"
                                    onClick={handleBack}
                                    className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                                    <span>{t('common.back', 'Back')}</span>
                                </button>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleBack}
                                        className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                    >
                                        {t('settings.nav.environments', 'Environments')}
                                    </button>
                                    <ChevronRight className="size-3.5 text-[var(--text-muted)] opacity-60" aria-hidden />
                                    <span className="font-medium text-[var(--text-primary)]">
                                        {effectiveName}
                                    </span>
                                </>
                            )}
                        </nav>
                    </div>

                    {/* Main Content Area */}
                    <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
                        {/* Header Row: Environment Title & Create Local Environment Button */}
                        <div className="flex items-center justify-between">
                            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                                {t('settings.nav.environments', 'Environments')}
                            </h1>
                            <button
                                type="button"
                                onClick={handleOpenEdit}
                                className={cn(
                                    'rounded-full bg-white px-4 py-1.5 text-[13px] font-medium text-black',
                                    'shadow-sm transition-all hover:bg-white/90 active:scale-95 cursor-pointer'
                                )}
                            >
                                {t('settings.environments.createLocalEnv', 'Create local environment')}
                            </button>
                        </div>

                        {/* Empty Environment Card */}
                        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] py-12 px-6 text-center text-[13px] text-[var(--text-secondary)]">
                            {t(
                                'settings.environments.noEnvConfigured',
                                'No local environment configured for this project'
                            )}
                        </div>
                    </div>
                </div>
            )
        }

        // Active setup script based on selected platform tab
        const activeSetupScripts: ProjectEnvironmentScripts = {
            ...(selectedProject.setupScripts || {}),
            ...(envConfig?.setupScripts || {}),
        }
        let displayedSetupScript = activeSetupScripts[detailSetupPlatform]?.trim() ?? ''
        if (!displayedSetupScript && detailSetupPlatform === 'default') {
            displayedSetupScript =
                selectedProject.setupScript?.trim() || DEFAULT_DETAIL_SETUP_SCRIPT
        }

        // Active cleanup script based on selected platform tab
        const activeCleanupScripts: ProjectEnvironmentScripts = {
            ...(selectedProject.cleanupScripts || {}),
            ...(envConfig?.cleanupScripts || {}),
        }
        let displayedCleanupScript = activeCleanupScripts[detailCleanupPlatform]?.trim() ?? ''
        if (!displayedCleanupScript && detailCleanupPlatform === 'default') {
            displayedCleanupScript =
                selectedProject.cleanupScript?.trim() || DEFAULT_DETAIL_CLEANUP_SCRIPT
        }

        // Actions to display
        const displayedActions =
            envConfig?.actions && envConfig.actions.length > 0
                ? envConfig.actions
                : selectedProject.actions || []

        return (
            <div ref={rootRef} className="relative">
                {/* Topbar Breadcrumbs */}
                <div
                    className="sticky top-0 z-10 flex h-11 w-full items-center bg-[var(--bg-app)] px-8"
                >
                    <nav
                        aria-label="Breadcrumb"
                        className="flex items-center gap-2 text-[13px]"
                    >
                        {isFromChat ? (
                            <button
                                type="button"
                                onClick={handleBack}
                                className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                            >
                                <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                                <span>{t('common.back', 'Back')}</span>
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={handleBack}
                                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    {t('settings.nav.environments', 'Environments')}
                                </button>
                                <ChevronRight className="size-3.5 text-[var(--text-muted)] opacity-60" aria-hidden />
                                <span className="font-medium text-[var(--text-primary)]">
                                    {effectiveName}
                                </span>
                            </>
                        )}
                    </nav>
                </div>

                {/* Main Content Area */}
                <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
                    {/* Header Row: Project Title & Edit Button */}
                    <div className="flex items-center justify-between">
                        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                            {effectiveName}
                        </h1>
                        <button
                            type="button"
                            onClick={handleOpenEdit}
                            className={cn(
                                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium',
                                'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                                'hover:bg-[var(--bg-sidebar-hover)]/80 active:scale-95 cursor-pointer'
                            )}
                        >
                            <Pencil className="size-3.5" aria-hidden />
                            <span>{t('settings.environments.edit', 'Edit')}</span>
                        </button>
                    </div>

                    {/* Setup Script Section */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                    {t('settings.environments.setupScript', 'Setup script')}
                                </div>
                                <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                    {t(
                                        'settings.environments.setupScriptDescDetail',
                                        'This script runs when a worktree is created'
                                    )}
                                </div>
                            </div>
                            <div className="relative" ref={variablesContainerRef}>
                                <button
                                    type="button"
                                    onClick={() => setVariablesOpen((v) => !v)}
                                    aria-expanded={variablesOpen}
                                    aria-haspopup="dialog"
                                    className={cn(
                                        'flex items-center justify-center rounded-lg px-3 py-1 text-[12px] font-medium',
                                        'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                                        'hover:bg-[var(--bg-sidebar-hover)]/80 active:scale-95 cursor-pointer',
                                        variablesOpen && 'bg-[var(--bg-sidebar-hover)]/90 ring-1 ring-[var(--border-medium)]'
                                    )}
                                >
                                    {t('settings.environments.variables', 'Variables')}
                                </button>

                                {variablesOpen && (
                                    <div
                                        data-testid="env-variables-popover"
                                        role="dialog"
                                        aria-label={t(
                                            'settings.environments.variablesPopoverTitle',
                                            'Setup script environment variables'
                                        )}
                                        className={cn(
                                            'absolute right-0 top-full mt-2 z-30 w-[300px]',
                                            'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4',
                                            'shadow-2xl shadow-black/60 backdrop-blur-md space-y-3.5',
                                            'animate-in fade-in zoom-in-95 duration-150'
                                        )}
                                    >
                                        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                                            {t(
                                                'settings.environments.variablesPopoverTitle',
                                                'Setup script environment variables'
                                            )}
                                        </div>

                                        <div className="space-y-1.5">
                                            <div className="text-[12px] text-[var(--text-secondary)]">
                                                {t(
                                                    'settings.environments.varSourceTreePath',
                                                    'Source workspace path'
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleCopyText(
                                                        'CODEX_SOURCE_TREE_PATH',
                                                        'CODEX_SOURCE_TREE_PATH'
                                                    )
                                                }
                                                title={t('settings.environments.clickToCopy', 'Click to copy')}
                                                className={cn(
                                                    'group flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)]',
                                                    'bg-[var(--bg-sidebar-hover)]/60 px-3.5 py-2.5 text-left font-mono text-[12px]',
                                                    'text-[var(--text-primary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--bg-sidebar-hover)] cursor-pointer'
                                                )}
                                            >
                                                <span>CODEX_SOURCE_TREE_PATH</span>
                                                {copiedKey === 'CODEX_SOURCE_TREE_PATH' ? (
                                                    <Check className="size-3.5 text-emerald-400 shrink-0 ml-2" />
                                                ) : (
                                                    <Copy className="size-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                                                )}
                                            </button>
                                        </div>

                                        <div className="space-y-1.5">
                                            <div className="text-[12px] text-[var(--text-secondary)]">
                                                {t(
                                                    'settings.environments.varWorktreePath',
                                                    'New worktree path'
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleCopyText(
                                                        'CODEX_WORKTREE_PATH',
                                                        'CODEX_WORKTREE_PATH'
                                                    )
                                                }
                                                title={t('settings.environments.clickToCopy', 'Click to copy')}
                                                className={cn(
                                                    'group flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)]',
                                                    'bg-[var(--bg-sidebar-hover)]/60 px-3.5 py-2.5 text-left font-mono text-[12px]',
                                                    'text-[var(--text-primary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--bg-sidebar-hover)] cursor-pointer'
                                                )}
                                            >
                                                <span>CODEX_WORKTREE_PATH</span>
                                                {copiedKey === 'CODEX_WORKTREE_PATH' ? (
                                                    <Check className="size-3.5 text-emerald-400 shrink-0 ml-2" />
                                                ) : (
                                                    <Copy className="size-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Platform Selector */}
                        <div className="flex items-center gap-1 pt-1">
                            {(
                                [
                                    { id: 'default', label: t('settings.environments.tabDefault', 'Default') },
                                    { id: 'macos', label: 'macOS' },
                                    { id: 'linux', label: 'Linux' },
                                    { id: 'windows', label: 'Windows' },
                                ] as const
                            ).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setDetailSetupPlatform(tab.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer',
                                        detailSetupPlatform === tab.id
                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Code Card */}
                        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 space-y-2.5">
                            <div className="flex items-center justify-between">
                                <span className="font-mono text-[12px] text-[var(--text-muted)]">bash</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        handleCopyText(
                                            displayedSetupScript,
                                            'detail-setup-script',
                                            t('settings.environments.scriptCopied', 'Script copied to clipboard')
                                        )
                                    }
                                    aria-label={t('settings.environments.clickToCopy', 'Click to copy')}
                                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    {copiedKey === 'detail-setup-script' ? (
                                        <Check className="size-3.5 text-emerald-400" />
                                    ) : (
                                        <Copy className="size-3.5" />
                                    )}
                                </button>
                            </div>
                            <HighlightedBash code={displayedSetupScript} />
                        </div>
                    </div>

                    {/* Cleanup Script Section */}
                    <div className="space-y-2">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.environments.cleanupScript', 'Cleanup script')}
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                {t(
                                    'settings.environments.cleanupScriptDesc',
                                    'Runs in project root before cleaning up worktree'
                                )}
                            </div>
                        </div>

                        {/* Platform Selector */}
                        <div className="flex items-center gap-1 pt-1">
                            {(
                                [
                                    { id: 'default', label: t('settings.environments.tabDefault', 'Default') },
                                    { id: 'macos', label: 'macOS' },
                                    { id: 'linux', label: 'Linux' },
                                    { id: 'windows', label: 'Windows' },
                                ] as const
                            ).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setDetailCleanupPlatform(tab.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer',
                                        detailCleanupPlatform === tab.id
                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Code Card */}
                        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 space-y-2.5">
                            <div className="flex items-center justify-between">
                                <span className="font-mono text-[12px] text-[var(--text-muted)]">bash</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        handleCopyText(
                                            displayedCleanupScript,
                                            'detail-cleanup-script',
                                            t('settings.environments.scriptCopied', 'Script copied to clipboard')
                                        )
                                    }
                                    aria-label={t('settings.environments.clickToCopy', 'Click to copy')}
                                    className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    {copiedKey === 'detail-cleanup-script' ? (
                                        <Check className="size-3.5 text-emerald-400" />
                                    ) : (
                                        <Copy className="size-3.5" />
                                    )}
                                </button>
                            </div>
                            <HighlightedBash code={displayedCleanupScript} />
                        </div>
                    </div>

                    {/* Actions Section */}
                    <div className="space-y-2">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.environments.actions', 'Actions')}
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                {t(
                                    'settings.environments.actionsDesc',
                                    'These actions run arbitrary commands and appear in the top bar'
                                )}
                            </div>
                        </div>

                        {/* Empty / Configured State Card */}
                        {displayedActions && displayedActions.length > 0 ? (
                            <div className="space-y-2">
                                {displayedActions.map((act) => {
                                    const normPlat = normalizeActionPlatform(act.platform)
                                    const platformLabel =
                                        normPlat === 'darwin'
                                            ? 'macOS'
                                            : normPlat === 'linux'
                                            ? 'Linux'
                                            : normPlat === 'win32'
                                            ? 'Windows'
                                            : null

                                    return (
                                        <div
                                            key={act.id}
                                            className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-5 py-4 flex items-center justify-between"
                                        >
                                            <div className="flex items-center gap-4">
                                                <div className="text-[var(--text-secondary)] shrink-0 flex items-center justify-center">
                                                    {renderActionIcon(act.icon, 'size-5')}
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                                                            {act.name}
                                                        </span>
                                                        {platformLabel && (
                                                            <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]">
                                                                {platformLabel}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="font-mono text-[12px] text-[var(--text-muted)] mt-0.5">
                                                        {act.script || act.command}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] py-6 px-4 text-center">
                                <span className="text-[13px] text-[var(--text-muted)]">
                                    {t(
                                        'settings.environments.addActionsPlaceholder',
                                        'Add actions to run commands from local toolbar'
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    // Detail / Edit View
    if (selectedProject && viewMode === 'edit') {
        const effectiveName = envConfig?.name || selectedProject.name

        return (
            <div ref={rootRef} className="relative">
                {/* Topbar Breadcrumbs */}
                <div
                    className="sticky top-0 z-10 flex h-11 w-full items-center bg-[var(--bg-app)] px-8"
                >
                    <nav
                        aria-label="Breadcrumb"
                        className="flex items-center gap-2 text-[13px]"
                    >
                        {isFromChat ? (
                            <button
                                type="button"
                                onClick={handleBack}
                                className="flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                            >
                                <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                                <span>{t('common.back', 'Back')}</span>
                            </button>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    onClick={handleBack}
                                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    {t('settings.nav.environments', 'Environments')}
                                </button>
                                <ChevronRight className="size-3.5 text-[var(--text-muted)] opacity-60" aria-hidden />
                                <button
                                    type="button"
                                    onClick={handleBackToDetail}
                                    className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    {effectiveName}
                                </button>
                                <ChevronRight className="size-3.5 text-[var(--text-muted)] opacity-60" aria-hidden />
                                <span className="font-medium text-[var(--text-primary)]">
                                    {t('settings.environments.edit', 'Edit')}
                                </span>
                            </>
                        )}
                    </nav>
                </div>

                {/* Main Content Area */}
                <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
                    {/* Page Title */}
                    <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                        {t('settings.environments.editLocalEnv', 'Edit local environment')}
                    </h1>

                    {/* Name Input */}
                    <div className="space-y-2">
                        <label
                            htmlFor="env-project-name"
                            className="block text-[13px] font-medium text-[var(--text-primary)]"
                        >
                            {t('settings.environments.name', 'Name')}
                        </label>
                        <input
                            id="env-project-name"
                            type="text"
                            value={projectName}
                            placeholder={t('settings.environments.projectNamePlaceholder', 'Project name')}
                            onChange={(event) => setProjectName(event.target.value)}
                            className={cn(
                                'w-full rounded-xl border border-[var(--border-subtle)]',
                                'bg-[var(--bg-card)] px-3.5 py-2.5 text-[13px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                            )}
                        />
                    </div>

                    {/* Setup Script */}
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                    {t('settings.environments.setupScript', 'Setup script')}
                                </div>
                                <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                    {t(
                                        'settings.environments.setupScriptDesc',
                                        'Runs in project root when worktree is created'
                                    )}
                                </div>
                            </div>
                            <div className="relative" ref={variablesContainerRef}>
                                <button
                                    type="button"
                                    onClick={() => setVariablesOpen((v) => !v)}
                                    aria-expanded={variablesOpen}
                                    aria-haspopup="dialog"
                                    className={cn(
                                        'flex items-center justify-center rounded-lg px-3 py-1 text-[12px] font-medium',
                                        'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                                        'hover:bg-[var(--bg-sidebar-hover)]/80 active:scale-95 cursor-pointer',
                                        variablesOpen && 'bg-[var(--bg-sidebar-hover)]/90 ring-1 ring-[var(--border-medium)]'
                                    )}
                                >
                                    {t('settings.environments.variables', 'Variables')}
                                </button>

                                {variablesOpen && (
                                    <div
                                        data-testid="env-variables-popover"
                                        role="dialog"
                                        aria-label={t(
                                            'settings.environments.variablesPopoverTitle',
                                            'Setup script environment variables'
                                        )}
                                        className={cn(
                                            'absolute right-0 top-full mt-2 z-30 w-[300px]',
                                            'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4',
                                            'shadow-2xl shadow-black/60 backdrop-blur-md space-y-3.5',
                                            'animate-in fade-in zoom-in-95 duration-150'
                                        )}
                                    >
                                        <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                                            {t(
                                                'settings.environments.variablesPopoverTitle',
                                                'Setup script environment variables'
                                            )}
                                        </div>

                                        <div className="space-y-1.5">
                                            <div className="text-[12px] text-[var(--text-secondary)]">
                                                {t(
                                                    'settings.environments.varSourceTreePath',
                                                    'Source workspace path'
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleCopyText(
                                                        'CODEX_SOURCE_TREE_PATH',
                                                        'CODEX_SOURCE_TREE_PATH'
                                                    )
                                                }
                                                title={t('settings.environments.clickToCopy', 'Click to copy')}
                                                className={cn(
                                                    'group flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)]',
                                                    'bg-[var(--bg-sidebar-hover)]/60 px-3.5 py-2.5 text-left font-mono text-[12px]',
                                                    'text-[var(--text-primary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--bg-sidebar-hover)] cursor-pointer'
                                                )}
                                            >
                                                <span>CODEX_SOURCE_TREE_PATH</span>
                                                {copiedKey === 'CODEX_SOURCE_TREE_PATH' ? (
                                                    <Check className="size-3.5 text-emerald-400 shrink-0 ml-2" />
                                                ) : (
                                                    <Copy className="size-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                                                )}
                                            </button>
                                        </div>

                                        <div className="space-y-1.5">
                                            <div className="text-[12px] text-[var(--text-secondary)]">
                                                {t(
                                                    'settings.environments.varWorktreePath',
                                                    'New worktree path'
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    handleCopyText(
                                                        'CODEX_WORKTREE_PATH',
                                                        'CODEX_WORKTREE_PATH'
                                                    )
                                                }
                                                title={t('settings.environments.clickToCopy', 'Click to copy')}
                                                className={cn(
                                                    'group flex w-full items-center justify-between rounded-xl border border-[var(--border-subtle)]',
                                                    'bg-[var(--bg-sidebar-hover)]/60 px-3.5 py-2.5 text-left font-mono text-[12px]',
                                                    'text-[var(--text-primary)] transition-colors hover:border-[var(--border-medium)] hover:bg-[var(--bg-sidebar-hover)] cursor-pointer'
                                                )}
                                            >
                                                <span>CODEX_WORKTREE_PATH</span>
                                                {copiedKey === 'CODEX_WORKTREE_PATH' ? (
                                                    <Check className="size-3.5 text-emerald-400 shrink-0 ml-2" />
                                                ) : (
                                                    <Copy className="size-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2" />
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Platform Selector */}
                        <div className="flex items-center gap-1 pt-1">
                            {(
                                [
                                    { id: 'default', label: t('settings.environments.tabDefault', 'Default') },
                                    { id: 'macos', label: 'macOS' },
                                    { id: 'linux', label: 'Linux' },
                                    { id: 'windows', label: 'Windows' },
                                ] as const
                            ).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setSetupPlatform(tab.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer',
                                        setupPlatform === tab.id
                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Code Editor Box */}
                        <textarea
                            rows={5}
                            value={setupScripts[setupPlatform] ?? ''}
                            placeholder={DEFAULT_SETUP_SCRIPT_PLACEHOLDER}
                            onChange={(event) =>
                                setSetupScripts((prev) => ({
                                    ...prev,
                                    [setupPlatform]: event.target.value,
                                }))
                            }
                            aria-label={t('settings.environments.setupScript', 'Setup script')}
                            className={cn(
                                'w-full resize-y rounded-2xl border border-[var(--border-subtle)]',
                                'bg-[var(--bg-card)] p-4 text-[12px] font-mono leading-relaxed',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors',
                                'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                            )}
                            spellCheck={false}
                        />
                    </div>

                    {/* Cleanup Script */}
                    <div className="space-y-2">
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                {t('settings.environments.cleanupScript', 'Cleanup script')}
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                {t(
                                    'settings.environments.cleanupScriptDesc',
                                    'Runs in project root before cleaning up worktree'
                                )}
                            </div>
                        </div>

                        {/* Platform Selector */}
                        <div className="flex items-center gap-1 pt-1">
                            {(
                                [
                                    { id: 'default', label: t('settings.environments.tabDefault', 'Default') },
                                    { id: 'macos', label: 'macOS' },
                                    { id: 'linux', label: 'Linux' },
                                    { id: 'windows', label: 'Windows' },
                                ] as const
                            ).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setCleanupPlatform(tab.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer',
                                        cleanupPlatform === tab.id
                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Code Editor Box */}
                        <textarea
                            rows={4}
                            value={cleanupScripts[cleanupPlatform] ?? ''}
                            placeholder={DEFAULT_CLEANUP_SCRIPT_PLACEHOLDER}
                            onChange={(event) =>
                                setCleanupScripts((prev) => ({
                                    ...prev,
                                    [cleanupPlatform]: event.target.value,
                                }))
                            }
                            aria-label={t('settings.environments.cleanupScript', 'Cleanup script')}
                            className={cn(
                                'w-full resize-y rounded-2xl border border-[var(--border-subtle)]',
                                'bg-[var(--bg-card)] p-4 text-[12px] font-mono leading-relaxed',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors',
                                'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                            )}
                            spellCheck={false}
                        />
                    </div>

                    {/* Actions Section */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="text-[13px] font-medium text-[var(--text-primary)]">
                                    {t('settings.environments.actions', 'Actions')}
                                </div>
                                <div className="text-[12px] text-[var(--text-muted)] mt-0.5">
                                    {t(
                                        'settings.environments.actionsDesc',
                                        'These actions run arbitrary commands and appear in the top bar'
                                    )}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleAddAction}
                                className={cn(
                                    'flex items-center justify-center rounded-lg px-3 py-1 text-[12px] font-medium',
                                    'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                                    'hover:bg-[var(--bg-sidebar-hover)]/80 active:scale-95 cursor-pointer'
                                )}
                            >
                                {t('settings.environments.addAction', 'Add action')}
                            </button>
                        </div>

                        {/* Actions List (Expanded for Direct Editing) */}
                        {actions.map((act, index) => {
                            const actIcon = (act.icon as ActionIconType) || 'run'

                            return (
                                <div
                                    key={act.id}
                                    className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-4 space-y-3"
                                >
                                    {/* Name with Icon Picker */}
                                    <div className="space-y-1.5">
                                        <label className="block text-[12px] font-medium text-[var(--text-secondary)]">
                                            {t('settings.environments.name', 'Name')}
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <div className="relative" data-action-icon-container>
                                                <button
                                                    type="button"
                                                    aria-label={`Action icon: ${actIcon}`}
                                                    aria-expanded={openActionIconMenuId === act.id}
                                                    aria-haspopup="menu"
                                                    title={t('settings.environments.selectIcon', 'Select icon')}
                                                    onClick={() => {
                                                        setOpenActionIconMenuId((prev) => (prev === act.id ? null : act.id))
                                                    }}
                                                    className={cn(
                                                        'flex size-8 shrink-0 items-center justify-center rounded-lg',
                                                        'bg-[var(--bg-sidebar-hover)] text-[var(--text-secondary)] transition-colors',
                                                        'hover:bg-[var(--bg-sidebar-hover)]/80 hover:text-[var(--text-primary)] cursor-pointer',
                                                        openActionIconMenuId === act.id && 'ring-1 ring-[var(--border-medium)]'
                                                    )}
                                                >
                                                    {renderActionIcon(actIcon, 'size-4')}
                                                </button>

                                                {openActionIconMenuId === act.id && (
                                                    <div
                                                        data-testid={`action-icon-menu-${act.id}`}
                                                        role="menu"
                                                        aria-label={t('settings.environments.selectIcon', 'Select icon')}
                                                        className={cn(
                                                            'absolute left-0 top-full mt-1.5 z-30 min-w-[130px]',
                                                            'rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-1.5',
                                                            'shadow-2xl shadow-black/60 backdrop-blur-md space-y-0.5',
                                                            'animate-in fade-in zoom-in-95 duration-150'
                                                        )}
                                                    >
                                                        {ACTION_ICON_OPTIONS.map((opt) => {
                                                            const IconComponent = opt.icon
                                                            const isSelected = actIcon === opt.id

                                                            return (
                                                                <button
                                                                    key={opt.id}
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => {
                                                                        handleUpdateAction(act.id, { icon: opt.id })
                                                                        setOpenActionIconMenuId(null)
                                                                    }}
                                                                    className={cn(
                                                                        'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] font-medium transition-colors cursor-pointer',
                                                                        isSelected
                                                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                                                            : 'text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]/70'
                                                                    )}
                                                                >
                                                                    <IconComponent className="size-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
                                                                    <span>{t(opt.labelKey, opt.defaultLabel)}</span>
                                                                </button>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                            <input
                                                type="text"
                                                value={act.name}
                                                placeholder={t(
                                                    'settings.environments.actionNamePlaceholder',
                                                    'Action name'
                                                )}
                                                onChange={(event) =>
                                                    handleUpdateAction(act.id, {
                                                        name: event.target.value,
                                                    })
                                                }
                                                aria-label={t('settings.environments.name', 'Name')}
                                                className={cn(
                                                    'w-full rounded-lg border border-[var(--border-subtle)]',
                                                    'bg-[var(--bg-sidebar-hover)]/60 px-3 py-1.5 text-[12px]',
                                                    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                                    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                                                )}
                                            />
                                        </div>
                                    </div>

                                    {/* Action Script */}
                                    <div className="space-y-1.5">
                                        <label className="block text-[12px] font-medium text-[var(--text-secondary)]">
                                            {t('settings.environments.actionScript', 'Action script')}
                                        </label>
                                        <textarea
                                            rows={3}
                                            value={act.script || act.command || ''}
                                            placeholder={DEFAULT_ACTION_SCRIPT_PLACEHOLDER}
                                            onChange={(event) =>
                                                handleUpdateAction(act.id, {
                                                    script: event.target.value,
                                                })
                                            }
                                            aria-label={t(
                                                'settings.environments.actionScript',
                                                'Action script'
                                            )}
                                            className={cn(
                                                'w-full resize-y rounded-xl border border-[var(--border-subtle)]',
                                                'bg-[var(--bg-sidebar-hover)]/60 p-3 text-[12px] font-mono leading-relaxed',
                                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors',
                                                'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40'
                                            )}
                                            spellCheck={false}
                                        />
                                    </div>

                                    {/* Platform & Delete Row */}
                                    <div className="flex items-end justify-between pt-1">
                                        <div className="space-y-1.5">
                                            <span className="block text-[12px] font-medium text-[var(--text-secondary)]">
                                                {t('settings.environments.platform', 'Platform')}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                {(
                                                    [
                                                        {
                                                            id: 'all',
                                                            label: t(
                                                                'settings.environments.tabAllPlatforms',
                                                                'All platforms'
                                                            ),
                                                        },
                                                        { id: 'darwin', label: 'macOS' },
                                                        { id: 'linux', label: 'Linux' },
                                                        { id: 'win32', label: 'Windows' },
                                                    ] as const
                                                ).map((tab) => {
                                                    const activePlatform = normalizeActionPlatform(act.platform) ?? 'all'
                                                    const isSelected = activePlatform === tab.id

                                                    return (
                                                        <button
                                                            key={tab.id}
                                                            type="button"
                                                            onClick={() =>
                                                                handleUpdateAction(act.id, {
                                                                    platform: tab.id === 'all' ? undefined : tab.id,
                                                                })
                                                            }
                                                            className={cn(
                                                                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors cursor-pointer',
                                                                isSelected
                                                                    ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                                            )}
                                                        >
                                                            {tab.label}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => handleDeleteAction(act.id)}
                                            aria-label={`Delete action ${act.name || index + 1}`}
                                            className={cn(
                                                'flex size-7 items-center justify-center rounded-md',
                                                'text-[var(--text-muted)] transition-colors',
                                                'hover:bg-rose-500/15 hover:text-rose-400 active:scale-95 cursor-pointer'
                                            )}
                                        >
                                            <Trash2 className="size-4" aria-hidden />
                                        </button>
                                    </div>
                                </div>
                            )
                        })}

                        {/* Empty Actions Placeholder */}
                        {actions.length === 0 && (
                            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] py-6 px-4 text-center">
                                <span className="text-[13px] text-[var(--text-muted)]">
                                    {t(
                                        'settings.environments.addActionsPlaceholder',
                                        'Add actions to run commands from local toolbar'
                                    )}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Bottom Save Button */}
                    <div className="flex justify-end pt-2">
                        <button
                            type="button"
                            onClick={handleSave}
                            className={cn(
                                'rounded-full bg-white px-5 py-1.5 text-[13px] font-medium text-black',
                                'shadow-sm transition-all hover:bg-white/90 active:scale-95 cursor-pointer'
                            )}
                        >
                            {t('common.save', 'Save')}
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    // List View (1:1 matching reference)
    return (
        <div ref={rootRef} className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            {/* Page Header */}
            <div>
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                    {t('settings.nav.environments', 'Environments')}
                </h1>
                <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
                    {t(
                        'settings.environments.description',
                        'Local environments tell CPA how to set up worktrees for a project.'
                    )}{' '}
                    <a
                        href="https://platform.openai.com/docs"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent-blue)] hover:underline cursor-pointer"
                    >
                        {t('settings.environments.learnMore', 'Learn more.')}
                    </a>
                </p>
            </div>

            {/* Select and Add Project Section */}
            <div className="space-y-3">
                <div className="flex items-center justify-between pt-1">
                    <h2 className="text-[13px] font-medium text-[var(--text-primary)]">
                        {t('settings.environments.selectProject', 'Select project')}
                    </h2>
                    <button
                        type="button"
                        onClick={() => void handleAddProject()}
                        disabled={selecting}
                        className={cn(
                            'flex items-center justify-center rounded-lg px-3 py-1.5 text-[12px] font-medium',
                            'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)]/80 active:scale-95 cursor-pointer',
                            'disabled:pointer-events-none disabled:opacity-45'
                        )}
                    >
                        {t('settings.environments.addProject', 'Add project')}
                    </button>
                </div>

                {/* Projects List */}
                <div className="space-y-3">
                    {sortedProjects.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-[var(--border-subtle)] bg-[var(--bg-card)]/50 px-6 py-12 text-center text-[13px] text-[var(--text-muted)]">
                            {t('settings.environments.emptyProjects', 'No projects')}
                        </div>
                    ) : (
                        sortedProjects.map((project) => {
                            const projectPaths = getProjectPaths(project)
                            const primaryPath = projectPaths[0]

                            return (
                                <div
                                    key={project.id}
                                    onClick={() => handleSelectProject(project)}
                                    className={cn(
                                        'flex items-center justify-between rounded-2xl border border-[var(--border-subtle)]',
                                        'bg-[var(--bg-card)] px-5 py-4 transition-colors hover:bg-[var(--bg-sidebar-hover)]/40 cursor-pointer'
                                    )}
                                >
                                    <div className="flex min-w-0 items-center gap-4">
                                        <Notebook
                                            className="size-5 shrink-0 text-[var(--text-secondary)]"
                                            aria-hidden
                                        />
                                        <div className="min-w-0">
                                            <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">
                                                {project.name}
                                            </div>
                                            <div
                                                className="truncate text-[12px] text-[var(--text-muted)] mt-0.5"
                                                title={primaryPath}
                                            >
                                                {primaryPath ||
                                                    t('pinnedSummary.noPath', 'No path set')}
                                            </div>
                                        </div>
                                    </div>
                                    {(() => {
                                        const hasEnvironment = Boolean(projectEnvStatus[project.id])
                                        return (
                                            <button
                                                type="button"
                                                aria-label={
                                                    hasEnvironment
                                                        ? `View environment for ${project.name}`
                                                        : `Add environment for ${project.name}`
                                                }
                                                onClick={(event) => {
                                                    event.stopPropagation()
                                                    if (hasEnvironment) {
                                                        handleSelectProject(project)
                                                    } else {
                                                        handleSelectProjectForEdit(project)
                                                    }
                                                }}
                                                className={cn(
                                                    'flex size-8 shrink-0 items-center justify-center rounded-lg',
                                                    'bg-[var(--bg-sidebar-hover)] text-[var(--text-secondary)] transition-colors',
                                                    'hover:bg-[var(--bg-sidebar-hover)]/80 hover:text-[var(--text-primary)]',
                                                    'active:scale-95 cursor-pointer'
                                                )}
                                            >
                                                {hasEnvironment ? (
                                                    <ChevronRight className="size-4" aria-hidden />
                                                ) : (
                                                    <Plus className="size-4" aria-hidden />
                                                )}
                                            </button>
                                        )
                                    })()}
                                </div>
                            )
                        })
                    )}
                </div>
            </div>

            <DirectoryBrowserModal
                isOpen={directoryBrowserOpen}
                onClose={() => setDirectoryBrowserOpen(false)}
                onSelect={handleWebDirectorySelect}
            />
        </div>
    )
}
