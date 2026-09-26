import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    ChevronRight,
    ChevronUp,
    Folder,
    FolderPlus,
    HardDrive,
    Home,
    Loader2,
    Pencil,
    RotateCw,
    Search,
    X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
    FileSystemServiceToken,
    type ProjectDirectorySelection,
} from '@cpa/plugin-api'
import { cn } from './cn.js'
import { useHostService } from './HostServicesContext.js'
import { useWorkspaceVisible } from './WorkspaceVisibility.js'
import {
    getBaseName,
    getParentPath,
    getPathSegments,
    isWindowsPath,
    joinPath,
    normalizePath,
} from './pathUtils.js'

export interface DirectoryBrowserModalProps {
    isOpen: boolean
    onClose: () => void
    onSelect: (selection: ProjectDirectorySelection) => void
    initialPath?: string
    title?: string
    /** Injectable bridge methods for testing */
    readDir?: (path: string) => Promise<Array<{ name: string; isDir: boolean }>>
    runtimeInfo?: () => Promise<{ homeDir: string; platform: string }>
    mkdirAll?: (path: string) => Promise<void>
}

interface DirEntryItem {
    name: string
    isDir: boolean
    path: string
}

/**
 * Web-based directory browser modal component for selecting project folders in web environments.
 */
export function DirectoryBrowserModal({
    isOpen,
    onClose,
    onSelect,
    initialPath,
    title,
    readDir,
    runtimeInfo,
    mkdirAll,
}: DirectoryBrowserModalProps) {
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const titleId = useId()
    const filterInputRef = useRef<HTMLInputElement>(null)
    const pathInputRef = useRef<HTMLInputElement>(null)
    const newFolderInputRef = useRef<HTMLInputElement>(null)

    const fileSystemService = useHostService(FileSystemServiceToken)

    const [currentPath, setCurrentPath] = useState<string>('')
    const [selectedEntryName, setSelectedEntryName] = useState<string | null>(null)
    const [entries, setEntries] = useState<DirEntryItem[]>([])
    const [loading, setLoading] = useState<boolean>(false)
    const [error, setError] = useState<string | null>(null)
    const [filterQuery, setFilterQuery] = useState<string>('')
    const [showHidden, setShowHidden] = useState<boolean>(false)
    const [isEditingPath, setIsEditingPath] = useState<boolean>(false)
    const [pathInputText, setPathInputText] = useState<string>('')
    const [homeDir, setHomeDir] = useState<string>('')
    const [platform, setPlatform] = useState<string>('darwin')
    const [newFolderOpen, setNewFolderOpen] = useState<boolean>(false)
    const [newFolderName, setNewFolderName] = useState<string>('')
    const [creatingFolder, setCreatingFolder] = useState<boolean>(false)

    // Directory operations via scoped service or props
    const doReadDir = useCallback(
        async (targetPath: string) => {
            if (readDir) return readDir(targetPath)
            if (fileSystemService?.readDir) {
                const list = await fileSystemService.readDir(targetPath)
                return (list || []).map((e) => ({ name: e.name, isDir: e.isDirectory }))
            }
            return []
        },
        [readDir, fileSystemService],
    )

    const doRuntimeInfo = useCallback(async () => {
        if (runtimeInfo) return runtimeInfo()
        if (fileSystemService?.getRuntimeInfo) {
            const info = await fileSystemService.getRuntimeInfo()
            return { homeDir: info.homeDir, platform: info.platform }
        }
        return { homeDir: '/', platform: 'darwin' }
    }, [runtimeInfo, fileSystemService])

    const doMkdirAll = useCallback(
        async (targetPath: string) => {
            if (mkdirAll) return mkdirAll(targetPath)
            if (fileSystemService?.mkdirAll) {
                return fileSystemService.mkdirAll(targetPath)
            }
        },
        [mkdirAll, fileSystemService],
    )

    // Load directory entries for a specific path
    const loadDirectory = useCallback(
        async (targetPath: string) => {
            const normalized = normalizePath(targetPath)
            setLoading(true)
            setError(null)
            setSelectedEntryName(null)
            try {
                const rawEntries = await doReadDir(normalized)
                const dirs: DirEntryItem[] = (rawEntries || [])
                    .filter((item) => item.isDir)
                    .map((item) => ({
                        name: item.name,
                        isDir: true,
                        path: joinPath(normalized, item.name),
                    }))

                // Sort alphabetical
                dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

                setEntries(dirs)
                setCurrentPath(normalized)
                setPathInputText(normalized)
            } catch (err: unknown) {
                const msg = (err as Error)?.message || String(err)
                setError(msg)
            } finally {
                setLoading(false)
            }
        },
        [doReadDir],
    )

    // Initialize path when modal opens
    useEffect(() => {
        if (!isOpen) return

        let cancelled = false
        void (async () => {
            let startPath = initialPath?.trim()
            try {
                const info = await doRuntimeInfo()
                if (cancelled) return
                if (info.homeDir) setHomeDir(info.homeDir)
                if (info.platform) setPlatform(info.platform)

                if (!startPath) {
                    startPath = info.homeDir || (info.platform === 'win32' ? 'C:\\' : '/')
                }
            } catch {
                if (!startPath) startPath = '/'
            }

            if (!cancelled && startPath) {
                await loadDirectory(startPath)
            }
        })()

        return () => {
            cancelled = true
        }
    }, [isOpen, initialPath, doRuntimeInfo, loadDirectory])

    // Handle global key events (Escape to close)
    useEffect(() => {
        if (!isOpen || !workspaceVisible) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (newFolderOpen) {
                    setNewFolderOpen(false)
                } else if (isEditingPath) {
                    setIsEditingPath(false)
                    setPathInputText(currentPath)
                } else {
                    onClose()
                }
            }
        }
        document.addEventListener('keydown', handleKeyDown)
        return () => document.removeEventListener('keydown', handleKeyDown)
    }, [isOpen, workspaceVisible, newFolderOpen, isEditingPath, currentPath, onClose])

    // Focus path input when editing starts
    useEffect(() => {
        if (isEditingPath) {
            pathInputRef.current?.focus()
            pathInputRef.current?.select()
        }
    }, [isEditingPath])

    // Focus new folder input when opened
    useEffect(() => {
        if (newFolderOpen) {
            newFolderInputRef.current?.focus()
        }
    }, [newFolderOpen])

    // Navigation action handlers
    const handleNavigateUp = () => {
        const parent = getParentPath(currentPath)
        if (parent && parent !== currentPath) {
            void loadDirectory(parent)
        }
    }

    const handleNavigateHome = () => {
        if (homeDir) {
            void loadDirectory(homeDir)
        }
    }

    const handleNavigateRoot = () => {
        const isWin = isWindowsPath(currentPath) || platform === 'win32'
        const rootPath = isWin
            ? (currentPath.match(/^[a-zA-Z]:/)?.[0] || 'C:') + '\\'
            : '/'
        void loadDirectory(rootPath)
    }

    const handleRefresh = () => {
        if (currentPath) {
            void loadDirectory(currentPath)
        }
    }

    const handlePathSubmit = (event?: React.FormEvent) => {
        event?.preventDefault()
        if (!pathInputText.trim()) return
        setIsEditingPath(false)
        void loadDirectory(pathInputText.trim())
    }

    const handleFolderClick = (entry: DirEntryItem) => {
        setSelectedEntryName(entry.name)
    }

    const handleFolderDoubleClick = (entry: DirEntryItem) => {
        void loadDirectory(entry.path)
    }

    const handleCreateFolder = async (event?: React.FormEvent) => {
        event?.preventDefault()
        const trimmed = newFolderName.trim()
        if (!trimmed || !currentPath) return

        setCreatingFolder(true)
        try {
            const newPath = joinPath(currentPath, trimmed)
            await doMkdirAll(newPath)
            setNewFolderName('')
            setNewFolderOpen(false)
            await loadDirectory(currentPath)
            setSelectedEntryName(trimmed)
        } catch (err: unknown) {
            const msg = (err as Error)?.message || String(err)
            setError(`${t('fileBrowser.createFolderFailed')}: ${msg}`)
        } finally {
            setCreatingFolder(false)
        }
    }

    // Determine currently selected destination path
    const selectedPath = useMemo(() => {
        if (selectedEntryName) {
            return joinPath(currentPath, selectedEntryName)
        }
        return currentPath
    }, [currentPath, selectedEntryName])

    const handleConfirm = () => {
        if (!selectedPath) return
        const name = getBaseName(selectedPath) || selectedPath
        onSelect({ name, path: selectedPath })
        onClose()
    }

    // Filtered visible entries
    const visibleEntries = useMemo(() => {
        return entries.filter((entry) => {
            if (!showHidden && entry.name.startsWith('.')) {
                return false
            }
            if (filterQuery.trim()) {
                return entry.name.toLowerCase().includes(filterQuery.trim().toLowerCase())
            }
            return true
        })
    }, [entries, showHidden, filterQuery])

    const pathSegments = useMemo(() => {
        return getPathSegments(currentPath)
    }, [currentPath])

    if (!isOpen || !workspaceVisible || typeof document === 'undefined') return null

    return createPortal(
        <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 backdrop-blur-xs p-4"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose()
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                data-testid="directory-browser-modal"
                className={cn(
                    'flex h-[560px] w-full max-w-[660px] flex-col rounded-xl',
                    'border border-[var(--border-subtle)] bg-[var(--bg-elevated)]',
                    'shadow-2xl overflow-hidden select-none',
                )}
            >
                {/* Header */}
                <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4">
                    <div className="flex items-center gap-2">
                        <Folder className="size-4 text-[var(--accent-blue)]" aria-hidden />
                        <h2
                            id={titleId}
                            className="text-[14px] font-semibold text-[var(--text-primary)]"
                        >
                            {title || t('fileBrowser.title')}
                        </h2>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('common.close')}
                        className={cn(
                            'rounded-md p-1.5 text-[var(--text-muted)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                {/* Navigation Toolbar */}
                <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-app)]/40 px-3 py-2">
                    <button
                        type="button"
                        onClick={handleNavigateUp}
                        disabled={!currentPath || currentPath === '/' || currentPath === 'C:\\' || loading}
                        title={t('fileBrowser.up')}
                        aria-label={t('fileBrowser.up')}
                        className={cn(
                            'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                            'bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'disabled:pointer-events-none disabled:opacity-40',
                        )}
                    >
                        <ChevronUp className="size-4" aria-hidden />
                    </button>

                    {homeDir ? (
                        <button
                            type="button"
                            onClick={handleNavigateHome}
                            disabled={loading}
                            title={t('fileBrowser.home')}
                            aria-label={t('fileBrowser.home')}
                            className={cn(
                                'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                                'bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors',
                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                'disabled:pointer-events-none disabled:opacity-40',
                            )}
                        >
                            <Home className="size-3.5" aria-hidden />
                        </button>
                    ) : null}

                    <button
                        type="button"
                        onClick={handleNavigateRoot}
                        disabled={loading}
                        title={t('fileBrowser.root')}
                        aria-label={t('fileBrowser.root')}
                        className={cn(
                            'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                            'bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'disabled:pointer-events-none disabled:opacity-40',
                        )}
                    >
                        <HardDrive className="size-3.5" aria-hidden />
                    </button>

                    <button
                        type="button"
                        onClick={handleRefresh}
                        disabled={loading}
                        title={t('fileBrowser.refresh')}
                        aria-label={t('fileBrowser.refresh')}
                        className={cn(
                            'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                            'bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'disabled:pointer-events-none disabled:opacity-40',
                        )}
                    >
                        <RotateCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
                    </button>

                    <div className="h-4 w-px bg-[var(--border-subtle)]" />

                    {/* Breadcrumb Path Bar or Text Input */}
                    <div className="relative min-w-0 flex-1">
                        {isEditingPath ? (
                            <form onSubmit={handlePathSubmit} className="flex items-center gap-1">
                                <input
                                    ref={pathInputRef}
                                    type="text"
                                    value={pathInputText}
                                    onChange={(e) => setPathInputText(e.target.value)}
                                    onBlur={() => {
                                        if (!pathInputText.trim()) {
                                            setIsEditingPath(false)
                                            setPathInputText(currentPath)
                                        }
                                    }}
                                    className={cn(
                                        'h-7 w-full rounded-md border border-[var(--accent-blue)] bg-[var(--bg-elevated)] px-2 text-[12px]',
                                        'text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-blue)]',
                                    )}
                                    placeholder="/path/to/directory"
                                />
                                <button
                                    type="submit"
                                    className={cn(
                                        'h-7 rounded-md bg-[var(--accent-blue)] px-2 text-[12px] font-medium text-white',
                                        'hover:bg-[var(--accent-blue)]/90',
                                    )}
                                >
                                    {t('fileBrowser.go')}
                                </button>
                            </form>
                        ) : (
                            <div
                                onClick={() => setIsEditingPath(true)}
                                title={t('fileBrowser.editPath')}
                                className={cn(
                                    'group flex h-7 items-center gap-0.5 overflow-x-auto rounded-md border border-[var(--border-subtle)]',
                                    'bg-[var(--bg-elevated)] px-2 text-[12px] cursor-text no-scrollbar',
                                )}
                            >
                                {pathSegments.map((segment, index) => (
                                    <div key={segment.path} className="flex shrink-0 items-center">
                                        {index > 0 ? (
                                            <ChevronRight className="size-3 text-[var(--text-muted)] opacity-60" />
                                        ) : null}
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                void loadDirectory(segment.path)
                                            }}
                                            className={cn(
                                                'rounded px-1 py-0.5 text-[var(--text-secondary)] transition-colors',
                                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                                index === pathSegments.length - 1 && 'font-medium text-[var(--text-primary)]',
                                            )}
                                        >
                                            {segment.name}
                                        </button>
                                    </div>
                                ))}
                                <div className="flex-1 min-w-[20px]" />
                                <Pencil className="size-3 shrink-0 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                        )}
                    </div>

                    <button
                        type="button"
                        onClick={() => setNewFolderOpen((prev) => !prev)}
                        title={t('fileBrowser.newFolder')}
                        aria-label={t('fileBrowser.newFolder')}
                        className={cn(
                            'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                            'bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            newFolderOpen && 'border-[var(--accent-blue)] text-[var(--accent-blue)]',
                        )}
                    >
                        <FolderPlus className="size-3.5" aria-hidden />
                    </button>
                </div>

                {/* Inline New Folder Input */}
                {newFolderOpen ? (
                    <form
                        onSubmit={handleCreateFolder}
                        className="flex shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)]/40 px-3 py-2"
                    >
                        <FolderPlus className="size-4 text-[var(--accent-blue)] shrink-0" />
                        <input
                            ref={newFolderInputRef}
                            type="text"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            placeholder={t('fileBrowser.folderName')}
                            className={cn(
                                'h-7 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 text-[12px]',
                                'text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none',
                            )}
                        />
                        <button
                            type="submit"
                            disabled={!newFolderName.trim() || creatingFolder}
                            className={cn(
                                'h-7 rounded-md bg-[var(--accent-blue)] px-2.5 text-[12px] font-medium text-white transition-colors',
                                'hover:bg-[var(--accent-blue)]/90 disabled:opacity-50',
                            )}
                        >
                            {creatingFolder ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                t('fileBrowser.create')
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={() => setNewFolderOpen(false)}
                            className="h-7 rounded-md px-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                            {t('common.cancel')}
                        </button>
                    </form>
                ) : null}

                {/* Filter & Options Toolbar */}
                <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3 py-1.5 text-[12px]">
                    <div className="relative flex max-w-[240px] flex-1 items-center">
                        <Search className="absolute left-2 size-3.5 text-[var(--text-muted)]" />
                        <input
                            ref={filterInputRef}
                            type="text"
                            value={filterQuery}
                            onChange={(e) => setFilterQuery(e.target.value)}
                            placeholder={t('fileBrowser.filterPlaceholder')}
                            className={cn(
                                'h-6 w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/50 pl-7 pr-2 text-[11px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'focus:border-[var(--accent-blue)] focus:outline-none',
                            )}
                        />
                    </div>

                    <label className="flex items-center gap-1.5 cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                        <input
                            type="checkbox"
                            checked={showHidden}
                            onChange={(e) => setShowHidden(e.target.checked)}
                            className="size-3.5 rounded border-[var(--border-subtle)] text-[var(--accent-blue)] focus:ring-0"
                        />
                        <span className="text-[11px]">{t('fileBrowser.showHidden')}</span>
                    </label>
                </div>

                {/* Directory List Area */}
                <div className="flex-1 min-h-0 overflow-y-auto p-2">
                    {loading ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)] py-12">
                            <Loader2 className="size-6 animate-spin text-[var(--accent-blue)]" />
                            <span className="text-[12px]">{t('fileBrowser.loading')}</span>
                        </div>
                    ) : error ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                            <div className="text-[13px] text-[var(--accent-red,#ef4444)] font-medium">
                                {t('fileBrowser.error')}
                            </div>
                            <p className="text-[12px] text-[var(--text-muted)] max-w-[360px] break-words">
                                {error}
                            </p>
                            {homeDir ? (
                                <button
                                    type="button"
                                    onClick={handleNavigateHome}
                                    className={cn(
                                        'rounded-md bg-[var(--bg-app)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] border border-[var(--border-subtle)]',
                                        'hover:bg-[var(--bg-sidebar-hover)]',
                                    )}
                                >
                                    {t('fileBrowser.home')}
                                </button>
                            ) : null}
                        </div>
                    ) : visibleEntries.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--text-muted)] py-12">
                            <Folder className="size-8 stroke-1 opacity-40" />
                            <span className="text-[12px]">{t('fileBrowser.noFolders')}</span>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-0.5">
                            {visibleEntries.map((entry) => {
                                const isSelected = selectedEntryName === entry.name
                                return (
                                    <button
                                        key={entry.path}
                                        type="button"
                                        onClick={() => handleFolderClick(entry)}
                                        onDoubleClick={() => handleFolderDoubleClick(entry)}
                                        className={cn(
                                            'group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                                            isSelected
                                                ? 'bg-[var(--accent-blue)]/15 font-medium text-[var(--text-primary)] ring-1 ring-[var(--accent-blue)]/40'
                                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        )}
                                    >
                                        <Folder
                                            className={cn(
                                                'size-4 shrink-0 transition-colors',
                                                isSelected ? 'text-[var(--accent-blue)]' : 'text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]',
                                            )}
                                        />
                                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                        <span
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                handleFolderDoubleClick(entry)
                                            }}
                                            className={cn(
                                                'rounded px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] opacity-0',
                                                'group-hover:opacity-100 hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-all',
                                            )}
                                        >
                                            {t('fileBrowser.open')} →
                                        </span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="flex shrink-0 items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--bg-app)]/40 px-4 py-3">
                    <div className="min-w-0 flex-1 pr-3">
                        <div className="text-[11px] text-[var(--text-muted)] leading-tight">
                            {t('fileBrowser.selected')}:
                        </div>
                        <div
                            title={selectedPath}
                            className="truncate text-[12px] font-mono text-[var(--text-primary)]"
                        >
                            {selectedPath || '/'}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className={cn(
                                'rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-1.5 text-[12px]',
                                'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            )}
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={handleConfirm}
                            disabled={!selectedPath || loading}
                            className={cn(
                                'rounded-lg bg-[var(--accent-blue)] px-3.5 py-1.5 text-[12px] font-medium text-white shadow-xs transition-colors',
                                'hover:bg-[var(--accent-blue)]/90 disabled:pointer-events-none disabled:opacity-50',
                            )}
                        >
                            {t('fileBrowser.selectThisDirectory')}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    )
}
export default DirectoryBrowserModal
