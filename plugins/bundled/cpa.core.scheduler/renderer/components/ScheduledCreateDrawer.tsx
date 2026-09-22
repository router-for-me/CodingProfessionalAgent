import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent,
    type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
    Check,
    ChevronDown,
    Play,
    Search,
    X,
    buildSkillSuggestions,
    cn,
    getSkillQuery,
    insertSkillAtCaret,
    SkillDraftEditor,
    SkillMenu,
    useHostServices,
    useSkillUsageCounts,
    useTranslation,
    type SkillSuggestion,
} from '@cpa/plugin-ui'
import { useNavigate } from '@tanstack/react-router'
import {
    CANONICAL_REASONING_OPTIONS,
    type ModelCatalogEntry,
    getFilteredModels,
} from '../utils/models.js'
import { useScheduledTasksStore, type ScheduledTask } from '../stores/scheduledTasksStore.js'
import {
    findScheduledTaskProject,
    getPrimaryProjectPath,
} from '../scheduler/scheduledTaskProject.js'
import type { Project, SessionItem } from '@cpa/plugin-api'

export const DEFAULT_SCHEDULED_DRAWER_WIDTH = 420
export const MIN_SCHEDULED_DRAWER_WIDTH = 320
export const MAX_SCHEDULED_DRAWER_WIDTH = 720

export interface ScheduledCreateDrawerProps {
    open: boolean
    onClose: () => void
    editingTask?: ScheduledTask | null
    onRun?: (task: ScheduledTask) => void
    models?: readonly ModelCatalogEntry[]
    skills?: readonly { name: string; description?: string; filePath?: string }[]
}

interface SelectOption<T extends string> {
    value: T
    label: string
}

const EMPTY_SKILLS: readonly {
    name: string
    description?: string
    filePath?: string
}[] = []
const EMPTY_MODELS: ModelCatalogEntry[] = []
const EMPTY_PROJECTS: Project[] = []
const EMPTY_SESSIONS: SessionItem[] = []

interface DrawerMenuPosition {
    top?: number
    bottom?: number
    right: number
    maxHeight: number
    maxWidth: number
}

const DRAWER_MENU_VIEWPORT_PAD = 8
const DRAWER_MENU_GUTTER = 4

function computeDrawerMenuPosition(triggerRect: DOMRect): DrawerMenuPosition {
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200

    const spaceBelow = vh - triggerRect.bottom - DRAWER_MENU_VIEWPORT_PAD
    const spaceAbove = triggerRect.top - DRAWER_MENU_VIEWPORT_PAD

    const placement = spaceBelow < 180 && spaceAbove > spaceBelow ? 'top' : 'bottom'
    const availableHeight = placement === 'bottom' ? spaceBelow : spaceAbove

    const maxHeight = Math.max(96, availableHeight - DRAWER_MENU_GUTTER)
    const maxWidth = Math.max(160, vw - DRAWER_MENU_VIEWPORT_PAD * 2)

    const right = Math.max(DRAWER_MENU_VIEWPORT_PAD, vw - triggerRect.right)

    const vertical =
        placement === 'bottom'
            ? { top: triggerRect.bottom + DRAWER_MENU_GUTTER }
            : { bottom: vh - triggerRect.top + DRAWER_MENU_GUTTER }

    return {
        ...vertical,
        right,
        maxHeight,
        maxWidth,
    }
}

function DrawerSelectRow<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string
    value: T
    options: SelectOption<T>[]
    onChange: (val: T) => void
}) {
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<DrawerMenuPosition | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)

    const selectedOption = options.find((opt) => opt.value === value) ?? options[0]

    const updatePosition = useCallback(() => {
        if (!triggerRef.current) return
        setPosition(computeDrawerMenuPosition(triggerRef.current.getBoundingClientRect()))
    }, [])

    useLayoutEffect(() => {
        if (!open) return
        updatePosition()
    }, [open, updatePosition, options.length])

    useEffect(() => {
        if (!open) return

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node | null
            if (!target) return
            if (
                triggerRef.current?.contains(target) ||
                menuRef.current?.contains(target)
            ) {
                return
            }
            setOpen(false)
        }

        const handleKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setOpen(false)
                triggerRef.current?.focus()
            }
        }

        const handleReposition = () => {
            updatePosition()
        }

        document.addEventListener('mousedown', handleClickOutside, true)
        document.addEventListener('keydown', handleKeyDown, true)
        window.addEventListener('resize', handleReposition)
        window.addEventListener('scroll', handleReposition, true)

        return () => {
            document.removeEventListener('mousedown', handleClickOutside, true)
            document.removeEventListener('keydown', handleKeyDown, true)
            window.removeEventListener('resize', handleReposition)
            window.removeEventListener('scroll', handleReposition, true)
        }
    }, [open, updatePosition])

    const handleToggle = () => {
        if (!open && triggerRef.current) {
            setPosition(computeDrawerMenuPosition(triggerRef.current.getBoundingClientRect()))
            setOpen(true)
        } else {
            setOpen(false)
        }
    }

    return (
        <div className="relative flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[13px] text-[var(--text-primary)] select-none font-[inherit]">
                {label}
            </span>
            <div className="relative">
                <button
                    ref={triggerRef}
                    type="button"
                    onClick={handleToggle}
                    className={cn(
                        'flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)]',
                        'hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none font-[inherit]',
                    )}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                >
                    <span>{selectedOption?.label}</span>
                    <ChevronDown className="size-3.5 opacity-60 stroke-[2]" />
                </button>

                {open && position && typeof document !== 'undefined'
                    ? createPortal(
                        <div
                            ref={menuRef}
                            className={cn(
                                'fixed z-[70] w-max min-w-[140px] rounded-xl',
                                'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1 shadow-2xl',
                                'overflow-y-auto custom-scrollbar',
                                'animate-in fade-in zoom-in-95 duration-100',
                            )}
                            style={{
                                top: position.top,
                                bottom: position.bottom,
                                right: position.right,
                                maxHeight: `${position.maxHeight}px`,
                                maxWidth: `${position.maxWidth}px`,
                            }}
                            role="listbox"
                        >
                            {options.map((opt) => {
                                const isSelected = opt.value === value
                                return (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => {
                                            onChange(opt.value)
                                            setOpen(false)
                                            triggerRef.current?.focus()
                                        }}
                                        className={cn(
                                            'flex w-full items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-[13px] text-left transition-colors cursor-pointer font-[inherit] whitespace-nowrap',
                                            isSelected
                                                ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-medium'
                                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        )}
                                        role="option"
                                        aria-selected={isSelected}
                                    >
                                        <span className="whitespace-nowrap">{opt.label}</span>
                                        {isSelected ? (
                                            <Check className="size-3.5 text-[var(--accent-blue)] shrink-0" />
                                        ) : null}
                                    </button>
                                )
                            })}
                        </div>,
                        document.body,
                    )
                    : null}
            </div>
        </div>
    )
}

function parseScheduleTime(schedule?: string): string {
    if (!schedule) return '09:00:00'
    const match = schedule.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
    if (match) {
        const hh = (match[1] ?? '09').padStart(2, '0')
        const mm = (match[2] ?? '00').padStart(2, '0')
        const ss = (match[3] ?? '00').padStart(2, '0')
        return `${hh}:${mm}:${ss}`
    }
    return '09:00:00'
}

function TimeColumn({
    label,
    count,
    value,
    onChange,
}: {
    label: string
    count: number
    value: number
    onChange: (val: number) => void
}) {
    const listRef = useRef<HTMLDivElement>(null)
    const selectedRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (
            selectedRef.current &&
            listRef.current &&
            typeof selectedRef.current.scrollIntoView === 'function'
        ) {
            selectedRef.current.scrollIntoView({
                block: 'center',
                behavior: 'auto',
            })
        }
    }, [value])

    const items = useMemo(() => Array.from({ length: count }, (_, i) => i), [count])

    return (
        <div className="flex flex-1 flex-col items-center min-w-0">
            <span className="text-[11px] font-medium text-[var(--text-muted)] mb-1.5 select-none font-[inherit]">
                {label}
            </span>
            <div
                ref={listRef}
                className="h-[180px] w-full overflow-y-auto custom-scrollbar rounded-xl bg-[var(--bg-card)]/50 border border-[var(--border-subtle)] p-1 space-y-0.5"
                role="listbox"
                aria-label={label}
            >
                {items.map((i) => {
                    const isSelected = i === value
                    const formatted = i.toString().padStart(2, '0')
                    return (
                        <button
                            key={i}
                            ref={isSelected ? selectedRef : null}
                            type="button"
                            onClick={() => onChange(i)}
                            className={cn(
                                'flex w-full items-center justify-center rounded-lg py-1.5 text-xs font-mono transition-colors cursor-pointer select-none',
                                isSelected
                                    ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-semibold shadow-xs'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]/60 hover:text-[var(--text-primary)]',
                            )}
                            role="option"
                            aria-selected={isSelected}
                        >
                            {formatted}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

function DrawerTimeSelectRow({
    label,
    value,
    onChange,
}: {
    label: string
    value: string
    onChange: (val: string) => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    const { h, m, s } = useMemo(() => {
        const parts = value.split(':').map((p) => parseInt(p, 10))
        const hour = isNaN(parts[0] ?? 0) ? 9 : Math.max(0, Math.min(23, parts[0]!))
        const minute = isNaN(parts[1] ?? 0) ? 0 : Math.max(0, Math.min(59, parts[1]!))
        const second = isNaN(parts[2] ?? 0) ? 0 : Math.max(0, Math.min(59, parts[2]!))
        return { h: hour, m: minute, s: second }
    }, [value])

    const formattedDisplay = useMemo(() => {
        const hh = h.toString().padStart(2, '0')
        const mm = m.toString().padStart(2, '0')
        const ss = s.toString().padStart(2, '0')
        return `${hh}:${mm}:${ss}`
    }, [h, m, s])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        if (open) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [open])

    const handleHourChange = (newH: number) => {
        const hh = newH.toString().padStart(2, '0')
        const mm = m.toString().padStart(2, '0')
        const ss = s.toString().padStart(2, '0')
        onChange(`${hh}:${mm}:${ss}`)
    }

    const handleMinuteChange = (newM: number) => {
        const hh = h.toString().padStart(2, '0')
        const mm = newM.toString().padStart(2, '0')
        const ss = s.toString().padStart(2, '0')
        onChange(`${hh}:${mm}:${ss}`)
    }

    const handleSecondChange = (newS: number) => {
        const hh = h.toString().padStart(2, '0')
        const mm = m.toString().padStart(2, '0')
        const ss = newS.toString().padStart(2, '0')
        onChange(`${hh}:${mm}:${ss}`)
    }

    return (
        <div className="relative flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[13px] text-[var(--text-primary)] select-none font-[inherit]">
                {label}
            </span>
            <div ref={containerRef} className="relative">
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className={cn(
                        'flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)]',
                        'hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none font-mono',
                    )}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                >
                    <span>{formattedDisplay}</span>
                    <ChevronDown className="size-3.5 opacity-60 stroke-[2]" />
                </button>

                {open ? (
                    <div
                        className={cn(
                            'absolute right-0 top-full mt-1.5 z-50 w-[270px] rounded-2xl',
                            'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3 shadow-2xl',
                            'animate-in fade-in zoom-in-95 duration-100',
                        )}
                        role="dialog"
                        aria-label={t('scheduled.drawer.time', 'Time')}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <TimeColumn
                                label={t('scheduled.drawer.hours', 'h')}
                                count={24}
                                value={h}
                                onChange={handleHourChange}
                            />
                            <TimeColumn
                                label={t('scheduled.drawer.minutes', 'm')}
                                count={60}
                                value={m}
                                onChange={handleMinuteChange}
                            />
                            <TimeColumn
                                label={t('scheduled.drawer.seconds', 's')}
                                count={60}
                                value={s}
                                onChange={handleSecondChange}
                            />
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function DrawerChatSelectRow({
    label,
    selectedSessionId,
    selectedChatTitle,
    onSelect,
    sessions,
}: {
    label: string
    selectedSessionId: string | null
    selectedChatTitle?: string
    onSelect: (sessionId: string | null, title: string) => void
    sessions: readonly SessionItem[]
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const containerRef = useRef<HTMLDivElement>(null)

    const newChatLabel = t('scheduled.drawer.chatNew', 'New chat')

    const activeSessions = useMemo(
        () => sessions.filter((s) => s.archivedAt === undefined),
        [sessions],
    )

    const sortedSessions = useMemo(
        () =>
            [...activeSessions].sort(
                (a, b) =>
                    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0),
            ),
        [activeSessions],
    )

    const filteredSessions = useMemo(() => {
        const q = searchQuery.trim().toLowerCase()
        if (!q) return sortedSessions
        return sortedSessions.filter((s) => (s.title || '').toLowerCase().includes(q))
    }, [searchQuery, sortedSessions])

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        if (open) {
            document.addEventListener('mousedown', handleClickOutside)
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [open])

    const displayTitle = useMemo(() => {
        if (!selectedSessionId || selectedSessionId === 'new-chat') {
            return newChatLabel
        }
        if (selectedChatTitle) return selectedChatTitle
        const match = sessions.find((s) => s.id === selectedSessionId)
        return match?.title || newChatLabel
    }, [selectedSessionId, selectedChatTitle, sessions, newChatLabel])

    return (
        <div className="relative flex items-center justify-between px-3.5 py-2.5">
            <span className="text-[13px] text-[var(--text-primary)] select-none font-[inherit]">
                {label}
            </span>
            <div ref={containerRef} className="relative">
                <button
                    type="button"
                    onClick={() => setOpen(!open)}
                    className={cn(
                        'flex items-center gap-1.5 text-[13px] text-[var(--text-secondary)]',
                        'hover:text-[var(--text-primary)] transition-colors cursor-pointer select-none font-[inherit] max-w-[200px] truncate',
                    )}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                >
                    <span className="truncate">{displayTitle}</span>
                    <ChevronDown className="size-3.5 opacity-60 stroke-[2] shrink-0" />
                </button>

                {open ? (
                    <div
                        className={cn(
                            'absolute right-0 top-full mt-1.5 z-50 w-[240px] rounded-xl',
                            'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-2xl',
                            'animate-in fade-in zoom-in-95 duration-100',
                        )}
                        role="listbox"
                    >
                        <div className="relative mb-1 px-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-[var(--text-muted)]" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t('scheduled.drawer.searchChats', 'Search chats')}
                                className="w-full rounded-lg bg-[var(--bg-card)] py-1 pl-7 pr-6 text-xs text-[var(--text-primary)] border border-[var(--border-subtle)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] font-[inherit]"
                            />
                            {searchQuery ? (
                                <button
                                    type="button"
                                    aria-label={t('common.clear', 'Clear')}
                                    onClick={() => setSearchQuery('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                                >
                                    <X className="size-3" />
                                </button>
                            ) : null}
                        </div>

                        <div className="max-h-[220px] overflow-y-auto custom-scrollbar space-y-0.5">
                            <button
                                type="button"
                                onClick={() => {
                                    onSelect('new-chat', newChatLabel)
                                    setOpen(false)
                                }}
                                className={cn(
                                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-left transition-colors cursor-pointer font-[inherit]',
                                    (!selectedSessionId || selectedSessionId === 'new-chat')
                                        ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-medium'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                )}
                                role="option"
                                aria-selected={!selectedSessionId || selectedSessionId === 'new-chat'}
                            >
                                <span>{newChatLabel}</span>
                                {(!selectedSessionId || selectedSessionId === 'new-chat') ? (
                                    <Check className="size-3 text-[var(--accent-blue)]" />
                                ) : null}
                            </button>

                            {filteredSessions.length > 0 ? (
                                <div className="pt-1 border-t border-[var(--border-subtle)] my-1">
                                    <div className="px-2 py-1 text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-semibold font-[inherit]">
                                        {t('scheduled.drawer.otherChats', 'Other chats')}
                                    </div>
                                    {filteredSessions.map((s) => {
                                        const isSelected = selectedSessionId === s.id
                                        return (
                                            <button
                                                key={s.id}
                                                type="button"
                                                onClick={() => {
                                                    onSelect(s.id, s.title)
                                                    setOpen(false)
                                                }}
                                                className={cn(
                                                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-left transition-colors cursor-pointer font-[inherit] truncate',
                                                    isSelected
                                                        ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-medium'
                                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                                )}
                                                role="option"
                                                aria-selected={isSelected}
                                            >
                                                <span className="truncate">{s.title}</span>
                                                {isSelected ? (
                                                    <Check className="size-3 text-[var(--accent-blue)] shrink-0 ml-1" />
                                                ) : null}
                                            </button>
                                        )
                                    })}
                                </div>
                            ) : searchQuery ? (
                                <div className="py-3 text-center text-xs text-[var(--text-muted)] font-[inherit]">
                                    {t('scheduled.drawer.noChatsFound', 'No chats found')}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    )
}

export function ScheduledCreateDrawer({
    open,
    onClose,
    editingTask,
    onRun,
    models: modelsProp,
    skills: skillsProp,
}: ScheduledCreateDrawerProps) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const hostServices = useHostServices()
    const usageCounts = useSkillUsageCounts()
    const reactId = useId()
    const skillListboxId = `skill-menu-${reactId.replace(/:/g, '')}`

    const addTask = useScheduledTasksStore((s) => s.addTask)
    const updateTask = useScheduledTasksStore((s) => s.updateTask)

    const [title, setTitle] = useState('')
    const [prompt, setPrompt] = useState('')
    const [promptCursor, setPromptCursor] = useState(0)
    const [skillMenuOpen, setSkillMenuOpen] = useState(false)
    const [runIn, setRunIn] = useState<'existing-chat' | 'new-chat'>('existing-chat')
    const [chatSessionId, setChatSessionId] = useState<string | null>(null)
    const [chatTitle, setChatTitle] = useState('')
    const [frequency, setFrequency] = useState<'daily' | 'weekdays' | 'weekly' | 'hourly'>('daily')
    const [weekday, setWeekday] = useState<number>(1)
    const [time, setTime] = useState('09:00:00')
    const [notification, setNotification] = useState<'important' | 'failure-only'>('important')
    const [projectId, setProjectId] = useState<string | null>(null)
    const [projectName, setProjectName] = useState<string>('')
    const [projectPath, setProjectPath] = useState<string>('')
    const [modelId, setModelId] = useState<string>('')
    const [modelLabel, setModelLabel] = useState<string>('')
    const [reasoningLevel, setReasoningLevel] = useState<string>('xhigh')

    const [drawerWidth, setDrawerWidth] = useState(DEFAULT_SCHEDULED_DRAWER_WIDTH)
    const [isResizing, setIsResizing] = useState(false)
    const [isMobile, setIsMobile] = useState(false)

    const [serviceModels, setServiceModels] = useState<readonly ModelCatalogEntry[]>(() =>
        (hostServices?.models?.getModels?.() ?? EMPTY_MODELS) as readonly ModelCatalogEntry[],
    )

    useEffect(() => {
        const modelService = hostServices?.models
        if (!modelService) return
        setServiceModels((modelService.getModels?.() ?? EMPTY_MODELS) as readonly ModelCatalogEntry[])
        if (typeof modelService.subscribe === 'function') {
            return modelService.subscribe(() => {
                setServiceModels((modelService.getModels?.() ?? EMPTY_MODELS) as readonly ModelCatalogEntry[])
            })
        }
    }, [hostServices?.models])

    const models = useMemo(() => {
        if (modelsProp && modelsProp.length > 0) return modelsProp
        if (serviceModels && serviceModels.length > 0) return serviceModels
        const fromService = hostServices?.models?.getModels?.()
        if (fromService && fromService.length > 0) {
            return fromService as readonly ModelCatalogEntry[]
        }
        return modelsProp ?? EMPTY_MODELS
    }, [modelsProp, serviceModels, hostServices?.models])

    const skills = useMemo((): readonly {
        name: string
        description?: string
        filePath?: string
    }[] => {
        if (skillsProp && skillsProp.length > 0) return skillsProp
        const fromService = hostServices?.skillUsage?.getAvailableSkills?.()
        if (fromService && fromService.length > 0) {
            return fromService as readonly {
                name: string
                description?: string
                filePath?: string
            }[]
        }
        if (typeof globalThis !== 'undefined' && (globalThis as any).__cpaComposerSkills) {
            return (globalThis as any).__cpaComposerSkills as readonly {
                name: string
                description?: string
                filePath?: string
            }[]
        }
        return EMPTY_SKILLS
    }, [hostServices?.skillUsage, skillsProp])

    const [activeSkillIndex, setActiveSkillIndex] = useState(0)

    const sessions = hostServices?.sessions?.getSnapshot?.() ?? EMPTY_SESSIONS
    const projects = hostServices?.projects?.getSnapshot?.() ?? EMPTY_PROJECTS
    const settings = hostServices?.settings?.getSnapshot?.() ?? ({} as any)

    useEffect(() => {
        const checkMobile = () => {
            const isTouch =
                typeof navigator !== 'undefined' &&
                (navigator.maxTouchPoints > 0 ||
                    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
                        navigator.userAgent,
                    ))
            const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 640
            setIsMobile(Boolean(isTouch && isNarrow) || (typeof window !== 'undefined' && window.innerWidth <= 640))
        }
        checkMobile()
        window.addEventListener('resize', checkMobile)
        return () => window.removeEventListener('resize', checkMobile)
    }, [])

    useEffect(() => {
        if (editingTask) {
            const resolvedEditingProject = findScheduledTaskProject(editingTask, projects)
            setTitle(editingTask.title)
            setPrompt(editingTask.prompt)
            setRunIn((editingTask.runIn as any) || 'existing-chat')
            setChatSessionId(editingTask.chatSessionId || null)
            setChatTitle(editingTask.chatTitle || '')
            setNotification((editingTask.notification as any) || 'important')
            setProjectId(
                resolvedEditingProject?.id ?? editingTask.projectId ?? (projects[0]?.id || null),
            )
            setProjectName(
                resolvedEditingProject?.name ?? editingTask.projectName ?? (projects[0]?.name || ''),
            )
            setProjectPath(
                resolvedEditingProject
                    ? (getPrimaryProjectPath(resolvedEditingProject) || '')
                    : (editingTask.projectPath || ''),
            )
            setModelId(editingTask.modelId || models[0]?.id || settings.modelId || '')
            setModelLabel(editingTask.modelLabel || models[0]?.label || '')
            setReasoningLevel(editingTask.reasoningLevel || settings.reasoningLevel || 'xhigh')
            setTime(parseScheduleTime(editingTask.schedule))

            if (editingTask.schedule.toLowerCase().includes('weekday')) {
                setFrequency('weekdays')
            } else if (editingTask.schedule.toLowerCase().includes('week') || editingTask.schedule.toLowerCase().includes('mon') || editingTask.schedule.toLowerCase().includes('tue') || editingTask.schedule.toLowerCase().includes('wed') || editingTask.schedule.toLowerCase().includes('thu') || editingTask.schedule.toLowerCase().includes('fri') || editingTask.schedule.toLowerCase().includes('sat') || editingTask.schedule.toLowerCase().includes('sun')) {
                setFrequency('weekly')
            } else if (editingTask.schedule.toLowerCase().includes('hour')) {
                setFrequency('hourly')
            } else {
                setFrequency('daily')
            }
        } else {
            setTitle('')
            setPrompt('')
            setRunIn('existing-chat')
            setChatSessionId(null)
            setChatTitle('')
            setFrequency('daily')
            setWeekday(1)
            setTime('09:00:00')
            setNotification('important')
            if (projects.length > 0) {
                setProjectId(projects[0]!.id)
                setProjectName(projects[0]!.name)
                setProjectPath(projects[0]!.path || projects[0]!.paths?.[0] || '')
            }
            if (models.length > 0) {
                setModelId(models[0]!.id)
                setModelLabel(models[0]!.label)
            } else if (settings.modelId) {
                setModelId(settings.modelId)
            }
            setReasoningLevel(settings.reasoningLevel || 'xhigh')
        }
        // Only re-initialize when the drawer opens or the edited task changes.
        // Do NOT depend on projects/models identity — unstable array defaults
        // (or store snapshot churn) would wipe in-progress prompt input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [editingTask, open])

    const isEditMode = Boolean(editingTask)

    const effectiveModels = useMemo(() => {
        return getFilteredModels(models, settings.modelSettings)
    }, [models, settings.modelSettings])

    const selectedModel = useMemo(() => {
        return effectiveModels.find((m) => m.id === modelId) ?? effectiveModels[0]
    }, [effectiveModels, modelId])

    const availableReasoningLevels = useMemo(() => {
        if (selectedModel && selectedModel.reasoningLevels && selectedModel.reasoningLevels.length > 0) {
            return selectedModel.reasoningLevels
        }
        return CANONICAL_REASONING_OPTIONS
    }, [selectedModel])

    const handleModelSelect = (newModelId: string) => {
        setModelId(newModelId)
        const match = effectiveModels.find((m) => m.id === newModelId)
        if (match) {
            setModelLabel(match.label)
            if (match.reasoningLevels && match.reasoningLevels.length > 0) {
                const hasCurrent = match.reasoningLevels.some((r) => r.id === reasoningLevel)
                if (!hasCurrent) {
                    setReasoningLevel(match.reasoningLevels[0]!.id)
                }
            }
        }
    }

    const selectedProject = useMemo(() => {
        return projects.find((p) => p.id === projectId) ?? projects[0]
    }, [projects, projectId])

    const skillQuery = getSkillQuery(prompt, promptCursor)
    const skillSuggestions = useMemo(() => {
        if (skillQuery === null) return [] as SkillSuggestion[]
        return buildSkillSuggestions({
            query: skillQuery,
            skills,
            usageCounts,
        }).map((item, index) => ({
            ...item,
            id: `${skillListboxId}-opt-${index}-${item.name}`,
        }))
    }, [skills, skillListboxId, skillQuery, usageCounts])

    const showSkillMenu =
        skillMenuOpen && skillQuery !== null && skillSuggestions.length > 0
    const activeSkillOptionId = showSkillMenu
        ? skillSuggestions[
              ((activeSkillIndex % skillSuggestions.length) +
                  skillSuggestions.length) %
                  skillSuggestions.length
          ]?.id
        : undefined

    useEffect(() => {
        setActiveSkillIndex(0)
        if (skillQuery !== null) {
            setSkillMenuOpen(true)
            return
        }
        setSkillMenuOpen(false)
    }, [skillQuery])

    const handleSelectSkill = (suggestion: SkillSuggestion | string) => {
        const skillName = typeof suggestion === 'string' ? suggestion : suggestion.name
        const inserted = insertSkillAtCaret(prompt, skillName, promptCursor)
        setPrompt(inserted.text)
        setPromptCursor(inserted.cursor)
        setSkillMenuOpen(false)
        setActiveSkillIndex(0)
    }

    const handlePromptKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (showSkillMenu) {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActiveSkillIndex((prev) => (prev + 1) % skillSuggestions.length)
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActiveSkillIndex(
                    (prev) =>
                        (prev - 1 + skillSuggestions.length) % skillSuggestions.length,
                )
                return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                const activeSkill = skillSuggestions[activeSkillIndex]
                if (activeSkill) {
                    handleSelectSkill(activeSkill)
                }
                return
            }
            if (e.key === 'Escape') {
                e.preventDefault()
                setSkillMenuOpen(false)
                return
            }
        }
    }

    const handleSave = () => {
        const finalTitle = title.trim()
        const finalPrompt = prompt.trim()
        if (!finalTitle || !finalPrompt) return

        let scheduleStr = 'daily ' + time
        if (frequency === 'weekdays') {
            scheduleStr = 'weekdays ' + time
        } else if (frequency === 'weekly') {
            const weekdayLabels = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
            scheduleStr = `${weekdayLabels[weekday] ?? 'Monday'} ${time}`
        } else if (frequency === 'hourly') {
            scheduleStr = 'hourly ' + time
        }

        const taskData = {
            title: finalTitle,
            prompt: finalPrompt,
            schedule: scheduleStr,
            runIn,
            chatSessionId: runIn === 'existing-chat' ? (chatSessionId === 'new-chat' ? null : chatSessionId) : null,
            chatTitle: runIn === 'existing-chat' ? chatTitle : undefined,
            notification,
            projectId: runIn === 'new-chat' ? (selectedProject?.id ?? projectId) : null,
            projectName: runIn === 'new-chat' ? (selectedProject?.name ?? projectName) : undefined,
            projectPath: runIn === 'new-chat' ? (selectedProject?.path || selectedProject?.paths?.[0] || projectPath) : undefined,
            modelId: runIn === 'new-chat' ? (selectedModel?.id ?? modelId) : undefined,
            modelLabel: runIn === 'new-chat' ? (selectedModel?.label ?? modelLabel) : undefined,
            reasoningLevel: runIn === 'new-chat' ? reasoningLevel : undefined,
            enabled: editingTask ? editingTask.enabled : true,
        }

        if (editingTask) {
            updateTask(editingTask.id, taskData)
        } else {
            addTask(taskData)
        }

        onClose()
    }

    // Historical execution runs
    const historicalRuns = useMemo(() => {
        if (!editingTask) return []
        return sessions
            .filter((s) => s.scheduleId === editingTask.id)
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    }, [editingTask, sessions])

    const handleResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()

        const startX = e.clientX
        const startWidth = drawerWidth
        setIsResizing(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'

        const onPointerMove = (moveEvent: PointerEvent) => {
            const deltaX = startX - moveEvent.clientX
            const newWidth = Math.max(
                MIN_SCHEDULED_DRAWER_WIDTH,
                Math.min(MAX_SCHEDULED_DRAWER_WIDTH, startWidth + deltaX),
            )
            setDrawerWidth(newWidth)
        }

        const onPointerUp = () => {
            setIsResizing(false)
            document.body.style.removeProperty('cursor')
            document.body.style.removeProperty('user-select')
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
        }

        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)
    }

    const isCreateDisabled = !title.trim() || !prompt.trim()

    return (
        <aside
            data-state={open ? 'open' : 'closed'}
            data-mobile={isMobile ? 'true' : undefined}
            aria-hidden={!open}
            className={cn(
                'flex flex-col bg-[var(--bg-elevated)] border-l border-[var(--border-subtle)] z-40 select-text',
                !isResizing && 'transition-[width,transform] duration-200',
                isMobile
                    ? cn('fixed inset-0 z-50 w-full', !open && 'hidden')
                    : cn('relative h-full shrink-0', !open && 'hidden'),
            )}
            style={{
                width: isMobile ? '100%' : `${drawerWidth}px`,
            }}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClose()
                }
            }}
        >
            {!isMobile ? (
                <div
                    role="separator"
                    aria-label={t('scheduled.drawer.resize', 'Resize sidebar')}
                    onPointerDown={handleResizeStart}
                    className={cn(
                        'absolute inset-y-0 left-0 z-50 w-3 -ml-1.5 cursor-col-resize touch-none',
                        'after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-px',
                        'after:transition-colors after:duration-150',
                        isResizing
                            ? 'after:bg-[var(--accent-blue)]'
                            : 'hover:after:bg-[var(--accent-blue)]',
                    )}
                />
            ) : null}

            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)] shrink-0">
                <div className="flex items-center gap-2">
                    <span className="text-[15px] font-semibold text-[var(--text-primary)] font-[inherit]">
                        {isEditMode
                            ? t('scheduled.drawer.edit', t('scheduled.drawer.editTitle', 'Edit'))
                            : t('scheduled.drawer.new', t('scheduled.drawer.newTitle', 'New'))}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {isEditMode && onRun ? (
                        <button
                            type="button"
                            onClick={() => {
                                if (editingTask) onRun(editingTask)
                            }}
                            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-[var(--accent-blue)] hover:bg-[var(--bg-sidebar-hover)] transition-colors cursor-pointer font-[inherit]"
                        >
                            <Play className="size-3" />
                            <span>{t('scheduled.drawer.runNow', t('scheduled.runNow', 'Run now'))}</span>
                        </button>
                    ) : null}

                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={!isEditMode && isCreateDisabled}
                        className={cn(
                            'rounded-lg px-3 py-1 text-xs font-medium text-white shadow-xs transition-opacity cursor-pointer font-[inherit]',
                            !isEditMode && isCreateDisabled
                                ? 'bg-[var(--accent-blue)]/50 cursor-not-allowed'
                                : 'bg-[var(--accent-blue)] hover:opacity-90 active:opacity-100',
                        )}
                    >
                        {isEditMode
                            ? t('scheduled.drawer.save', 'Save')
                            : t('scheduled.drawer.create', 'Create')}
                    </button>

                    <button
                        type="button"
                        aria-label={t('common.close', 'Close')}
                        onClick={onClose}
                        className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            </div>

            {/* Content Body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
                {/* Title Input */}
                <div>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t('scheduled.drawer.titlePlaceholder', 'Scheduled task title')}
                        className="w-full rounded-xl bg-[var(--bg-card)] px-3.5 py-2.5 text-[14px] font-medium text-[var(--text-primary)] border border-[var(--border-subtle)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] transition-colors font-[inherit]"
                    />
                </div>

                {/* Prompt Input with $ Menu */}
                <div className="relative">
                    <div
                        className={cn(
                            'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3',
                            'focus-within:border-[var(--accent-blue)] transition-colors',
                        )}
                    >
                        <SkillDraftEditor
                            value={prompt}
                            cursor={promptCursor}
                            skills={skills}
                            placeholder={t(
                                'scheduled.drawer.promptPlaceholder',
                                'Describe what CPA should do',
                            )}
                            onChange={(val, cur) => {
                                setPrompt(val)
                                setPromptCursor(cur)
                            }}
                            onKeyDown={handlePromptKeyDown}
                            testId="scheduled-prompt-input"
                            ariaControls={showSkillMenu ? skillListboxId : undefined}
                            ariaExpanded={showSkillMenu}
                            ariaActivedescendant={activeSkillOptionId}
                            ariaAutocomplete={showSkillMenu ? 'list' : undefined}
                            role={showSkillMenu ? 'combobox' : undefined}
                        />
                    </div>

                    {showSkillMenu ? (
                        <SkillMenu
                            id={skillListboxId}
                            testId="scheduled-skill-menu"
                            suggestions={skillSuggestions}
                            activeIndex={activeSkillIndex}
                            onActiveIndexChange={setActiveSkillIndex}
                            onSelect={handleSelectSkill}
                            onClose={() => setSkillMenuOpen(false)}
                        />
                    ) : null}
                </div>

                {/* Details Section */}
                <div className="space-y-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-1">
                    <div className="px-3.5 pt-2 pb-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider font-[inherit]">
                        {t('scheduled.drawer.details', 'Details')}
                    </div>

                    <DrawerSelectRow
                        label={t('scheduled.drawer.runIn', 'Run in')}
                        value={runIn}
                        options={[
                            { value: 'existing-chat', label: t('scheduled.drawer.existingChat', t('scheduled.drawer.runInExisting', 'Existing chat')) },
                            { value: 'new-chat', label: t('scheduled.drawer.newChat', t('scheduled.drawer.runInNew', 'New chat')) },
                        ]}
                        onChange={(val) => setRunIn(val)}
                    />

                    {runIn === 'existing-chat' ? (
                        <DrawerChatSelectRow
                            label={t('scheduled.drawer.chat', 'Chat')}
                            selectedSessionId={chatSessionId}
                            selectedChatTitle={chatTitle}
                            sessions={sessions}
                            onSelect={(id, t) => {
                                setChatSessionId(id)
                                setChatTitle(t)
                            }}
                        />
                    ) : (
                        <>
                            {projects.length > 0 ? (
                                <DrawerSelectRow
                                    label={t('scheduled.drawer.project', 'Project')}
                                    value={selectedProject?.id || ''}
                                    options={projects.map((p) => ({ value: p.id, label: p.name }))}
                                    onChange={(val) => {
                                        const match = projects.find((p) => p.id === val)
                                        if (match) {
                                            setProjectId(match.id)
                                            setProjectName(match.name)
                                            setProjectPath(match.path || match.paths?.[0] || '')
                                        }
                                    }}
                                />
                            ) : null}

                            {effectiveModels.length > 0 ? (
                                <DrawerSelectRow
                                    label={t('scheduled.drawer.model', 'Model')}
                                    value={selectedModel?.id || ''}
                                    options={effectiveModels.map((m) => ({ value: m.id, label: m.label }))}
                                    onChange={handleModelSelect}
                                />
                            ) : (
                                <DrawerSelectRow
                                    label={t('scheduled.drawer.model', 'Model')}
                                    value=""
                                    options={[
                                        {
                                            value: '',
                                            label: t('composer.modelCatalog.noModels', 'No models available'),
                                        },
                                    ]}
                                    onChange={() => {}}
                                />
                            )}

                            <DrawerSelectRow
                                label={t('scheduled.drawer.reasoning', 'Reasoning')}
                                value={reasoningLevel}
                                options={availableReasoningLevels.map((r) => ({
                                    value: r.id,
                                    label: String(
                                        t(
                                            r.labelKey || '',
                                            (r as any).fallbackLabel ||
                                                (r.id === 'low'
                                                    ? 'Low'
                                                    : r.id === 'medium'
                                                      ? 'Medium'
                                                      : r.id === 'high'
                                                        ? 'High'
                                                        : r.id === 'xhigh'
                                                          ? 'Very High'
                                                          : r.id),
                                        ),
                                    ),
                                }))}
                                onChange={(val) => setReasoningLevel(val)}
                            />
                        </>
                    )}
                </div>

                {/* Frequency Section */}
                <div className="space-y-1 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-1">
                    <div className="px-3.5 pt-2 pb-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider font-[inherit]">
                        {t('scheduled.drawer.frequency', 'Frequency')}
                    </div>

                    <DrawerSelectRow
                        label={t('scheduled.drawer.repeat', 'Repeat')}
                        value={frequency}
                        options={[
                            { value: 'daily', label: t('scheduled.drawer.daily', t('scheduled.drawer.repeatDaily', 'Daily')) },
                            { value: 'weekdays', label: t('scheduled.drawer.weekdays', t('scheduled.drawer.repeatWeekdays', 'Weekdays')) },
                            { value: 'weekly', label: t('scheduled.drawer.weekly', t('scheduled.drawer.repeatWeekly', 'Weekly')) },
                            { value: 'hourly', label: t('scheduled.drawer.hourly', t('scheduled.drawer.repeatHourly', 'Hourly')) },
                        ]}
                        onChange={(val) => setFrequency(val)}
                    />

                    {frequency === 'weekly' ? (
                        <DrawerSelectRow
                            label={t('scheduled.drawer.weekday', 'Weekday')}
                            value={String(weekday)}
                            options={[
                                { value: '1', label: t('common.monday', 'Monday') },
                                { value: '2', label: t('common.tuesday', 'Tuesday') },
                                { value: '3', label: t('common.wednesday', 'Wednesday') },
                                { value: '4', label: t('common.thursday', 'Thursday') },
                                { value: '5', label: t('common.friday', 'Friday') },
                                { value: '6', label: t('common.saturday', 'Saturday') },
                                { value: '0', label: t('common.sunday', 'Sunday') },
                            ]}
                            onChange={(val) => setWeekday(parseInt(val, 10))}
                        />
                    ) : null}

                    <DrawerTimeSelectRow
                        label={t('scheduled.drawer.time', 'Time')}
                        value={time}
                        onChange={(val) => setTime(val)}
                    />

                    <DrawerSelectRow
                        label={t('scheduled.drawer.notification', 'Notifications')}
                        value={notification}
                        options={[
                            { value: 'important', label: t('scheduled.drawer.notificationImportant', t('scheduled.drawer.notifyImportant', 'Important updates')) },
                            { value: 'failure-only', label: t('scheduled.drawer.notificationFailureOnly', t('scheduled.drawer.notifyFailureOnly', 'Only unsuccessful runs')) },
                        ]}
                        onChange={(val) => setNotification(val)}
                    />
                </div>

                {/* Execution Results Section (Shown only when editing a task with runs) */}
                {isEditMode && historicalRuns.length > 0 ? (
                    <div className="space-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-3">
                        <div className="text-[12px] font-semibold text-[var(--text-primary)] font-[inherit]">
                            {t('scheduled.drawer.executionResults', 'Execution results')}
                        </div>

                        <div className="space-y-1.5">
                            {historicalRuns.map((run, index) => {
                                const seqNumber = historicalRuns.length - index
                                return (
                                    <div
                                        key={run.id}
                                        onClick={() => {
                                            onClose()
                                            navigate({
                                                to: '/chat/$sessionId',
                                                params: { sessionId: run.id },
                                            } as any)
                                        }}
                                        className="flex items-center justify-between rounded-xl px-2.5 py-2 hover:bg-[var(--bg-sidebar-hover)] transition-colors cursor-pointer font-[inherit]"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-xs font-mono font-medium text-[var(--accent-blue)]">
                                                #{seqNumber}
                                            </span>
                                            <span className="text-xs text-[var(--text-primary)] truncate">
                                                {run.title}
                                            </span>
                                        </div>
                                        <ChevronDown className="size-3.5 -rotate-90 text-[var(--text-muted)] shrink-0" />
                                    </div>
                                )
                            })}
                        </div>
                    </div>
                ) : null}
            </div>
        </aside>
    )
}
