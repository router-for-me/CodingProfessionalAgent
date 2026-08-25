import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    ChevronDown,
    ChevronRight,
    Copy,
    ExternalLink,
    FileTypeIcon,
    Folder,
    PanelRightClose,
    PanelRightOpen,
    Search,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import { base64ToUtf8, highlightCodeToLines } from '../utils/highlight.js'

export interface FileTreeEntry {
    name: string
    isDir: boolean
    path: string
    relativePath: string
}

export interface FileManagerPanelContentProps {
    sessionId?: string | null
    activeFilePath?: string | null
    onSelectFile?: (file: { path: string; name: string; relativePath: string }) => void
    className?: string
}

interface FileTreeNodeProps {
    item: FileTreeEntry
    level?: number
    expandedDirs: Record<string, boolean>
    dirChildren: Record<string, FileTreeEntry[]>
    selectedFilePath?: string | null
    onToggleDir: (entry: FileTreeEntry) => void
    onOpenFile: (entry: FileTreeEntry) => void
}

function FileTreeNode({
    item,
    level = 0,
    expandedDirs,
    dirChildren,
    selectedFilePath,
    onToggleDir,
    onOpenFile,
}: FileTreeNodeProps) {
    const isSelected = selectedFilePath === item.path
    const isExpanded = Boolean(expandedDirs[item.path])
    const children = dirChildren[item.path] || []

    return (
        <div>
            <button
                type="button"
                onClick={() =>
                    item.isDir ? onToggleDir(item) : onOpenFile(item)
                }
                style={{ paddingLeft: `${6 + level * 14}px` }}
                className={cn(
                    'group flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors',
                    isSelected
                        ? 'bg-white/[0.08] text-[var(--text-primary)] font-medium'
                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                )}
            >
                {item.isDir ? (
                    isExpanded ? (
                        <ChevronDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                    ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                    )
                ) : (
                    <FileTypeIcon name={item.name} />
                )}
                <span className="truncate">{item.name}</span>
            </button>

            {item.isDir && isExpanded ? (
                <div className="space-y-0.5">
                    {children.map((child) => (
                        <FileTreeNode
                            key={child.path}
                            item={child}
                            level={level + 1}
                            expandedDirs={expandedDirs}
                            dirChildren={dirChildren}
                            selectedFilePath={selectedFilePath}
                            onToggleDir={onToggleDir}
                            onOpenFile={onOpenFile}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    )
}

export function FileManagerPanelContent({
    sessionId,
    activeFilePath,
    onSelectFile,
    className,
}: FileManagerPanelContentProps) {
    const { t } = useTranslation()
    const services = useHostServices()

    const projects = services?.projects?.getSnapshot?.() ?? []
    const sessions = services?.sessions?.getSnapshot?.() ?? []
    const pendingContext = services?.ui?.getPendingSessionContext?.()
    const pendingProjectId = pendingContext?.projectId ?? null

    const uiSnapshot = services?.ui?.getSnapshot?.()
    const tabParams = uiSnapshot?.rightPanelTabParams?.['file-manager']

    const currentSession = sessionId ? sessions.find((s) => s.id === sessionId) : undefined
    const activeProject =
        (currentSession?.projectId ? projects.find((p) => p.id === currentSession.projectId) : undefined) ??
        (pendingProjectId ? projects.find((p) => p.id === pendingProjectId) : undefined) ??
        projects[0] ??
        null

    const [fileTreeVisible, setFileTreeVisible] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [treeEntries, setTreeEntries] = useState<FileTreeEntry[]>([])
    const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
    const [dirChildren, setDirChildren] = useState<Record<string, FileTreeEntry[]>>({})

    const [selectedFile, setSelectedFile] = useState<{
        path: string
        relativePath: string
        name: string
        content: string
    } | null>(null)
    const [loading, setLoading] = useState(false)
    const [openMenu, setOpenMenu] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)
    const prevProjectPathRef = useRef<string | null>(null)

    const projectPath = (activeProject as any)?.path ?? (activeProject as any)?.paths?.[0] ?? ''

    const isBrowser = typeof window !== 'undefined' && !services?.fileSystem

    // Resolve explicit file target if provided via props or tabParams (validated against current projectPath)
    const resolvedTargetFilePath = useMemo(() => {
        const rawTarget =
            activeFilePath ??
            (tabParams?.activeFilePath as string | undefined) ??
            null
        if (!rawTarget || !projectPath) return null
        const normProj = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
        const normF = rawTarget.replace(/\\/g, '/')
        if (normF.startsWith(normProj + '/') || normF === normProj) {
            return rawTarget
        }
        return null
    }, [activeFilePath, tabParams?.activeFilePath, projectPath])

    // Read directory entries for a given path
    const loadDir = useCallback(
        async (dirPath: string, relativeBase = ''): Promise<FileTreeEntry[]> => {
            if (services?.fileSystem?.readDir) {
                try {
                    const raw = await services.fileSystem.readDir(dirPath)
                    if (!raw) return []
                    const filtered = raw.filter(
                        (entry) =>
                            !['.git', 'node_modules', 'dist', 'bin', '.next', 'coverage'].includes(
                                entry.name,
                            ),
                    )
                    const isWin = dirPath.includes('\\')
                    const sep = isWin ? '\\' : '/'
                    const list: FileTreeEntry[] = filtered.map((item) => ({
                        name: item.name,
                        isDir: Boolean(item.isDirectory),
                        path: item.path || `${dirPath}${sep}${item.name}`,
                        relativePath: relativeBase ? `${relativeBase}/${item.name}` : item.name,
                    }))
                    list.sort((a, b) => {
                        if (a.isDir && !b.isDir) return -1
                        if (!a.isDir && b.isDir) return 1
                        return a.name.localeCompare(b.name)
                    })
                    return list
                } catch {
                    return []
                }
            }

            return []
        },
        [services?.fileSystem],
    )

    // Load file content when requested
    const handleOpenFile = useCallback(
        async (entry: FileTreeEntry) => {
            if (entry.isDir) return
            setLoading(true)
            try {
                let content = ''
                if (services?.fileSystem?.readFile) {
                    const res = await services.fileSystem.readFile(entry.path)
                    content = base64ToUtf8(res.dataBase64)
                }
                const fileObj = {
                    path: entry.path,
                    relativePath: entry.relativePath,
                    name: entry.name,
                    content,
                }
                setSelectedFile(fileObj)
                services?.ui?.openRightPanelTab?.('file-manager', {
                    activate: false,
                    params: {
                        activeFilePath: entry.path,
                        name: entry.name,
                        relativePath: entry.relativePath,
                    },
                })
                if (onSelectFile) {
                    onSelectFile(fileObj)
                }
            } catch {
                // Ignore read failure
            } finally {
                setLoading(false)
            }
        },
        [onSelectFile, services],
    )

    // Load root directory when project changes
    useEffect(() => {
        let mounted = true
        if (!projectPath) {
            setTreeEntries([])
            setSelectedFile(null)
            setExpandedDirs({})
            setDirChildren({})
            prevProjectPathRef.current = null
            return
        }

        const projectChanged =
            prevProjectPathRef.current !== null &&
            prevProjectPathRef.current !== projectPath
        prevProjectPathRef.current = projectPath

        if (projectChanged) {
            setExpandedDirs({})
            setDirChildren({})
            setSelectedFile(null)
        }

        void (async () => {
            const rootEntries = await loadDir(projectPath)
            if (mounted) {
                setTreeEntries(rootEntries)
                // Auto-open first config/readme/example file if none selected and no target specified
                setSelectedFile((curr) => {
                    const isUnder =
                        curr &&
                        (() => {
                            const normProj = projectPath.replace(/\\/g, '/').replace(/\/$/, '')
                            const normF = curr.path.replace(/\\/g, '/')
                            return normF.startsWith(normProj + '/') || normF === normProj
                        })()
                    const validSelected = isUnder ? curr : null
                    if (!validSelected && !resolvedTargetFilePath && rootEntries.length > 0) {
                        const firstFile =
                            rootEntries.find(
                                (e) =>
                                    !e.isDir &&
                                    (e.name.includes('config.example') ||
                                        e.name.includes('config') ||
                                        e.name.includes('README')),
                            ) ?? rootEntries.find((e) => !e.isDir)

                        if (firstFile) {
                            void handleOpenFile(firstFile)
                        }
                    }
                    return validSelected
                })
            }
        })()
        return () => {
            mounted = false
        }
    }, [projectPath, loadDir, resolvedTargetFilePath, handleOpenFile])

    // Load file content when target path changes
    useEffect(() => {
        if (!resolvedTargetFilePath || !projectPath) return
        if (selectedFile?.path === resolvedTargetFilePath) return

        const filename =
            (tabParams?.name as string | undefined) ||
            resolvedTargetFilePath.split(/[/\\]/).pop() ||
            ''
        const relativePath =
            (tabParams?.relativePath as string | undefined) ||
            (resolvedTargetFilePath.startsWith(projectPath)
                ? resolvedTargetFilePath.slice(projectPath.length).replace(/^[/\\]/, '')
                : filename)

        void (async () => {
            try {
                let content = ''
                if (services?.fileSystem?.readFile) {
                    const res = await services.fileSystem.readFile(resolvedTargetFilePath)
                    content = base64ToUtf8(res.dataBase64)
                }
                setSelectedFile({
                    path: resolvedTargetFilePath,
                    relativePath,
                    name: filename,
                    content,
                })
            } catch {
                // Ignore read failure
            }
        })()
    }, [
        resolvedTargetFilePath,
        projectPath,
        selectedFile?.path,
        tabParams?.name,
        tabParams?.relativePath,
        services?.fileSystem,
    ])

    // Toggle folder expansion at any depth level
    const handleToggleDir = useCallback(
        async (dirEntry: FileTreeEntry) => {
            const nextExpanded = !expandedDirs[dirEntry.path]
            setExpandedDirs((prev) => ({ ...prev, [dirEntry.path]: nextExpanded }))

            if (nextExpanded && !dirChildren[dirEntry.path]) {
                const children = await loadDir(dirEntry.path, dirEntry.relativePath)
                setDirChildren((prev) => ({ ...prev, [dirEntry.path]: children }))
            }
        },
        [expandedDirs, dirChildren, loadDir],
    )

    // Filter tree entries based on query
    const filteredTreeEntries = useMemo(() => {
        if (!searchQuery.trim()) return treeEntries
        const q = searchQuery.toLowerCase().trim()
        return treeEntries.filter((item) => item.name.toLowerCase().includes(q))
    }, [treeEntries, searchQuery])

    // Close menu when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpenMenu(false)
            }
        }
        if (openMenu) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [openMenu])

    const handleReveal = async () => {
        setOpenMenu(false)
        if (!selectedFile) return
        if (services?.fileSystem?.revealInFileManager) {
            await services.fileSystem.revealInFileManager(selectedFile.path)
        }
    }

    const handleCopyPath = async () => {
        setOpenMenu(false)
        if (!selectedFile) return
        if (services?.ui?.writeClipboard) {
            await services.ui.writeClipboard(selectedFile.path)
        } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(selectedFile.path).catch(() => {})
        }
        services?.ui?.pushToast?.(t('rightSidebar.files.copied'))
    }

    const highlightedLines = useMemo(() => {
        if (!selectedFile) return []
        return highlightCodeToLines(selectedFile.content, selectedFile.name)
    }, [selectedFile])

    if (!activeProject) {
        return (
            <div
                data-testid="right-sidebar-files-view"
                className={cn(
                    'flex h-full min-h-0 flex-col items-center justify-center p-6 text-center text-[var(--text-muted)]',
                    className,
                )}
            >
                <Folder className="size-10 stroke-[1.25] opacity-40 mb-3" />
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                    {t('rightSidebar.files.noProject')}
                </p>
            </div>
        )
    }

    return (
        <div
            data-testid="right-sidebar-files-view"
            className={cn('flex h-full min-h-0 w-full overflow-hidden bg-[var(--bg-app)]', className)}
        >
            {/* Left Column: Code Viewer / File Preview */}
            <div className="flex flex-1 min-w-0 flex-col overflow-hidden border-r border-[var(--border-subtle)]">
                {/* Breadcrumbs Sub-Header */}
                <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3 bg-[var(--bg-app)]">
                    <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
                        <span className="truncate text-[var(--text-muted)]">{activeProject.name}</span>
                        {selectedFile ? (
                            <>
                                <span className="text-[var(--text-muted)]">&gt;</span>
                                <span className="truncate font-medium text-[var(--text-primary)]">
                                    {selectedFile.relativePath}
                                </span>
                            </>
                        ) : null}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                        {/* Toggle File Tree Button */}
                        <button
                            type="button"
                            data-testid="toggle-file-tree-btn"
                            aria-label={t('rightSidebar.files.toggleTree')}
                            onClick={() => setFileTreeVisible(!fileTreeVisible)}
                            className="flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                        >
                            {fileTreeVisible ? (
                                <PanelRightClose className="size-3.5" />
                            ) : (
                                <PanelRightOpen className="size-3.5" />
                            )}
                        </button>

                        {/* Open Action Dropdown (Electron) or Direct Copy Path (Browser) */}
                        {isBrowser ? (
                            <button
                                type="button"
                                data-testid="file-copy-path-btn"
                                onClick={handleCopyPath}
                                className={cn(
                                    'inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors',
                                    'bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]',
                                    'hover:bg-[var(--bg-sidebar-hover)] hover:border-[var(--border-strong)]',
                                )}
                            >
                                <Copy className="size-3 text-[var(--text-muted)]" />
                                <span>{t('rightSidebar.files.copyPath')}</span>
                            </button>
                        ) : (
                            <div className="relative" ref={menuRef}>
                                <button
                                    type="button"
                                    data-testid="file-open-action-btn"
                                    onClick={() => setOpenMenu(!openMenu)}
                                    className={cn(
                                        'inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors',
                                        'bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)]',
                                        'hover:bg-[var(--bg-sidebar-hover)] hover:border-[var(--border-strong)]',
                                    )}
                                >
                                    <span>{t('rightSidebar.files.openAction')}</span>
                                    <ChevronDown className="size-3 text-[var(--text-muted)]" />
                                </button>

                                {openMenu ? (
                                    <div
                                        data-testid="file-action-menu"
                                        className="absolute right-0 top-full mt-1 z-50 min-w-[150px] rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] p-1 shadow-lg text-[12px]"
                                    >
                                        <button
                                            type="button"
                                            onClick={handleReveal}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                                        >
                                            <ExternalLink className="size-3.5 text-[var(--text-muted)]" />
                                            <span>{t('rightSidebar.files.revealInFileManager')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleCopyPath}
                                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]"
                                        >
                                            <Copy className="size-3.5 text-[var(--text-muted)]" />
                                            <span>{t('rightSidebar.files.copyPath')}</span>
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>
                </div>

                {/* Code Viewer Viewport */}
                <div className="relative flex-1 overflow-auto bg-[var(--bg-card)] p-3 font-mono text-[12px] leading-relaxed select-text">
                    {loading ? (
                        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
                            {t('rightSidebar.files.loading')}
                        </div>
                    ) : selectedFile ? (
                        <div className="table w-full border-collapse">
                            {highlightedLines.map((lineHtml, idx) => {
                                const lineNum = idx + 1
                                return (
                                    <div key={lineNum} className="table-row group hover:bg-white/[0.04]">
                                        <span className="table-cell pr-4 text-right text-[var(--text-muted)] select-none opacity-40 group-hover:opacity-80 w-[1%] whitespace-nowrap">
                                            {lineNum}
                                        </span>
                                        <span
                                            className="table-cell whitespace-pre font-mono text-[var(--text-primary)]"
                                            dangerouslySetInnerHTML={{ __html: lineHtml || ' ' }}
                                        />
                                    </div>
                                )
                            })}
                        </div>
                    ) : (
                        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
                            {t('rightSidebar.files.emptySelect')}
                        </div>
                    )}
                </div>
            </div>

            {/* Right Column: File Explorer Tree */}
            {fileTreeVisible ? (
                <div
                    data-testid="file-tree-container"
                    className="flex w-[240px] shrink-0 flex-col overflow-hidden bg-[var(--bg-app)]"
                >
                    {/* Search & Filter Header */}
                    <div className="flex h-9 shrink-0 items-center border-b border-[var(--border-subtle)] px-2">
                        <div className="relative flex flex-1 items-center">
                            <Search className="absolute left-2 size-3.5 text-[var(--text-muted)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t('rightSidebar.files.searchPlaceholder')}
                                className="h-6 w-full rounded bg-[var(--bg-elevated)] pl-7 pr-2 text-[11px] text-[var(--text-primary)] border border-[var(--border-subtle)] focus:outline-none focus:border-[var(--border-strong)]"
                            />
                        </div>
                    </div>

                    {/* Tree Node List */}
                    <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5 select-none">
                        {filteredTreeEntries.length === 0 ? (
                            <div className="p-3 text-center text-[11px] text-[var(--text-muted)]">
                                {t('rightSidebar.files.emptyTree')}
                            </div>
                        ) : (
                            filteredTreeEntries.map((entry) => (
                                <FileTreeNode
                                    key={entry.path}
                                    item={entry}
                                    level={0}
                                    expandedDirs={expandedDirs}
                                    dirChildren={dirChildren}
                                    selectedFilePath={selectedFile?.path}
                                    onToggleDir={handleToggleDir}
                                    onOpenFile={handleOpenFile}
                                />
                            ))
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    )
}
