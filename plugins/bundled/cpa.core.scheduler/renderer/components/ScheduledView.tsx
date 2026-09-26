import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    Bell,
    ChevronLeft,
    ChevronRight,
    Circle,
    Compass,
    FileText,
    PauseCircle,
    Pencil,
    Play,
    RotateCcw,
    Search,
    Trash2,
    X,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    useScheduledTasksStore,
    type ScheduledTask,
} from '../stores/scheduledTasksStore.js'
import { getPrimaryProjectPath } from '../scheduler/scheduledTaskProject.js'
import { STALLED_RUN_CLAIM } from '../../shared/runClaim.js'

interface SuggestionItem {
    id: string
    titleKey: string
    defaultTitle: string
    timeKey: string
    defaultTime: string
    descKey: string
    defaultDesc: string
    promptKey: string
    defaultPrompt: string
    iconColor: string
    iconType: 'bell' | 'file' | 'compass'
}

type FilterStatus = 'all' | 'active' | 'paused' | 'completed'

const PAGE_SIZE = 5

const SUGGESTIONS: SuggestionItem[] = [
    {
        id: 'daily-briefing',
        titleKey: 'scheduled.suggestion.dailyBriefing.title',
        defaultTitle: 'Daily Standup',
        timeKey: 'scheduled.suggestion.dailyBriefing.time',
        defaultTime: 'Weekdays 8:00',
        descKey: 'scheduled.suggestion.dailyBriefing.desc',
        defaultDesc: 'Start each weekday with a summary of calendar, unread emails, and priorities',
        promptKey: 'scheduled.suggestion.dailyBriefing.prompt',
        defaultPrompt:
            'Help me set up a daily standup task to run weekdays at 8:00: summarize calendar, unread emails, and priorities.',
        iconColor: 'text-sky-400',
        iconType: 'bell',
    },
    {
        id: 'weekly-review',
        titleKey: 'scheduled.suggestion.weeklyReview.title',
        defaultTitle: 'Weekly Review',
        timeKey: 'scheduled.suggestion.weeklyReview.time',
        defaultTime: 'Fridays at 16:00',
        descKey: 'scheduled.suggestion.weeklyReview.desc',
        defaultDesc: 'Summarize recent work into a concise status update every Friday',
        promptKey: 'scheduled.suggestion.weeklyReview.prompt',
        defaultPrompt:
            'Help me set up a weekly review task to run Fridays at 16:00: organize recent work into a status update.',
        iconColor: 'text-purple-400',
        iconType: 'file',
    },
    {
        id: 'follow-up-monitor',
        titleKey: 'scheduled.suggestion.followUpMonitor.title',
        defaultTitle: 'Follow-up Monitor',
        timeKey: 'scheduled.suggestion.followUpMonitor.time',
        defaultTime: 'Weekdays 9:00',
        descKey: 'scheduled.suggestion.followUpMonitor.desc',
        defaultDesc: 'Review recent email and calendar activity and flag items that need attention',
        promptKey: 'scheduled.suggestion.followUpMonitor.prompt',
        defaultPrompt:
            'Help me set up a follow-up monitor task to run weekdays at 9:00: check recent activity and flag items needing attention.',
        iconColor: 'text-emerald-400',
        iconType: 'compass',
    },
]

const WEEKDAY_KEYS: Record<number, string> = {
    0: 'common.sunday',
    1: 'common.monday',
    2: 'common.tuesday',
    3: 'common.wednesday',
    4: 'common.thursday',
    5: 'common.friday',
    6: 'common.saturday',
}

const ENGLISH_WEEKDAY_MAP: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
}

function formatScheduleDisplay(schedule: string, t: any): string {
    const raw = schedule.trim()
    const lower = raw.toLowerCase()
    const timeMatch = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)/)
    const timeStr = timeMatch ? timeMatch[1] : ''

    if (lower.startsWith('daily')) {
        const prefix = t('scheduled.drawer.daily', t('scheduled.drawer.repeatDaily', 'Daily'))
        return timeStr ? `${prefix} ${timeStr}` : prefix
    }
    if (lower.startsWith('weekdays')) {
        const prefix = t('scheduled.drawer.weekdays', t('scheduled.drawer.repeatWeekdays', 'Weekdays'))
        return timeStr ? `${prefix} ${timeStr}` : prefix
    }
    if (lower.startsWith('hourly')) {
        const prefix = t('scheduled.drawer.hourly', t('scheduled.drawer.repeatHourly', 'Hourly'))
        return timeStr ? `${prefix} ${timeStr}` : prefix
    }
    for (const [dayName, dayIndex] of Object.entries(ENGLISH_WEEKDAY_MAP)) {
        if (lower.startsWith(dayName)) {
            const dayKey = WEEKDAY_KEYS[dayIndex]
            const dayLabel = dayKey ? t(dayKey, dayName) : dayName
            return timeStr ? `${dayLabel} ${timeStr}` : dayLabel
        }
    }
    return raw
}

function formatTaskSubtitle(task: ScheduledTask, t: any): string {
    const displaySchedule = formatScheduleDisplay(task.schedule, t)

    if (task.status === 'completed') {
        return `${displaySchedule} · ${t('scheduled.completedStatus', 'Completed')}`
    }
    if (task.enabled === false || task.status === 'paused') {
        return `${displaySchedule} · ${t('scheduled.pausedStatus', 'Paused')}`
    }
    if (task.lastRunError === STALLED_RUN_CLAIM) {
        return `${displaySchedule} · ${t('scheduled.recoveryRequired', 'Run stalled, recovery required')}`
    }
    if (task.lastRunError && (task.lastAttemptAt ?? 0) > (task.lastRunAt ?? 0)) {
        return `${displaySchedule} · ${t('scheduled.retryingStatus', 'Failed to start, retrying')}`
    }

    const fullSchedule = displaySchedule

    const timeMatch = task.schedule.match(/(\d{1,2}):(\d{2})/)
    if (!timeMatch) {
        return fullSchedule
    }

    const hour = parseInt(timeMatch[1] ?? '9', 10)
    const minute = parseInt(timeMatch[2] ?? '0', 10)

    const now = new Date()
    const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hour,
        minute,
        0,
        0,
    )

    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1)
    }

    if (
        task.schedule.toLowerCase().includes('weekday') ||
        task.schedule.toLowerCase().includes('weekday')
    ) {
        const day = next.getDay()
        if (day === 6) {
            next.setDate(next.getDate() + 2)
        } else if (day === 0) {
            next.setDate(next.getDate() + 1)
        }
    }

    const diffMs = next.getTime() - now.getTime()
    let relativeStr = ''
    if (diffMs < 60 * 60 * 1000) {
        const mins = Math.max(1, Math.round(diffMs / 60000))
        relativeStr = t('scheduled.approxMinutesLater', {
            minutes: mins,
            defaultValue: `in approx. ${mins} minutes`,
        })
    } else if (diffMs < 24 * 60 * 60 * 1000) {
        const hours = Math.round(diffMs / 3600000)
        relativeStr = t('scheduled.approxHoursLater', {
            hours,
            defaultValue: `in approx. ${hours} hours`,
        })
    } else {
        const days = Math.round(diffMs / 86400000)
        relativeStr = t('scheduled.approxDaysLater', {
            days,
            defaultValue: `in approx. ${days} days`,
        })
    }

    return `${fullSchedule} · ${t('scheduled.nextRun', 'Next run')} ${relativeStr}`
}

export function ScheduledView() {
    const { t } = useTranslation()
    const hostServices = useHostServices()

    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<FilterStatus>('all')
    const [currentPage, setCurrentPage] = useState(1)
    const [recoveryTask, setRecoveryTask] = useState<ScheduledTask | null>(null)

    const tasks = useScheduledTasksStore((s) => s.tasks)
    const modalOpen = useScheduledTasksStore((s) => s.modalOpen)
    const historyDrawerOpen = useScheduledTasksStore((s) => s.historyDrawerOpen)

    const addTask = useScheduledTasksStore((s) => s.addTask)
    const toggleTask = useScheduledTasksStore((s) => s.toggleTask)
    const deleteTask = useScheduledTasksStore((s) => s.deleteTask)
    const markAllAsRead = useScheduledTasksStore((s) => s.markAllAsRead)
    const markAsRead = useScheduledTasksStore((s) => s.markAsRead)
    const openCreateModal = useScheduledTasksStore((s) => s.openCreateModal)
    const openEditModal = useScheduledTasksStore((s) => s.openEditModal)

    const pendingSessionContext = hostServices?.ui?.getPendingSessionContext?.() ?? {
        projectId: null,
        branch: null,
        workLocation: 'local',
        environmentId: null,
    }
    const pushToast = hostServices?.ui?.pushToast

    useEffect(() => {
        hostServices?.sessions?.setCurrentSessionId?.(null)
    }, [hostServices])

    useEffect(() => {
        let active = true
        void (async () => {
            const scheduleService = hostServices?.schedule
            if (scheduleService?.list) {
                try {
                    const loadedTasks = await scheduleService.list()
                    if (active && Array.isArray(loadedTasks)) {
                        const projects = hostServices?.projects?.getSnapshot?.() ?? []
                        useScheduledTasksStore.getState().hydrate(loadedTasks as ScheduledTask[], projects)
                    }
                } catch (err) {
                    console.error('[ScheduledView] Failed to load scheduled tasks:', err)
                }
            }
        })()
        return () => {
            active = false
        }
    }, [hostServices])

    useEffect(() => {
        setCurrentPage(1)
    }, [searchQuery, statusFilter])

    const handleSelectSuggestion = (suggestion: SuggestionItem) => {
        const projects = hostServices?.projects?.getSnapshot?.() ?? []
        const targetProject = (pendingSessionContext.projectId
            ? projects.find((p) => p.id === pendingSessionContext.projectId)
            : null) ?? projects[0] ?? null

        addTask({
            title: t(suggestion.titleKey, suggestion.defaultTitle),
            schedule: t(suggestion.timeKey, suggestion.defaultTime),
            description: t(suggestion.descKey, suggestion.defaultDesc),
            prompt: t(suggestion.promptKey, suggestion.defaultPrompt),
            enabled: true,
            status: 'active',
            unread: true,
            runIn: 'new-chat',
            projectId: targetProject?.id ?? null,
            projectName: targetProject?.name,
            projectPath: targetProject ? getPrimaryProjectPath(targetProject) : undefined,
        })

        pushToast?.(t('scheduled.taskSaved', 'Task saved'))
    }

    const handleMarkAllAsRead = () => {
        markAllAsRead()
        pushToast?.(t('scheduled.allMarkedAsRead', 'All tasks marked as read'))
    }

    const handleRecover = async () => {
        if (!recoveryTask) return
        const taskId = recoveryTask.id
        setRecoveryTask(null)
        try {
            const recovered = await hostServices?.schedule?.recoverRun?.(taskId)
            if (recovered) {
                useScheduledTasksStore.getState().updateTask(taskId, {
                    lastAttemptAt: null,
                    lastRunError: null,
                })
                pushToast?.(t('scheduled.recoveryStarted', 'Task recovery started'))
            } else {
                pushToast?.(t('scheduled.recoveryUnavailable', 'Task is no longer stalled'), 'warning')
            }
        } catch (err) {
            console.error('[ScheduledView] Failed to recover scheduled task:', err)
            pushToast?.(t('scheduled.recoveryFailed', 'Could not recover the task'), 'error')
        }
    }

    const filteredSuggestions = SUGGESTIONS.filter((item) => {
        if (!searchQuery.trim()) return true
        const q = searchQuery.toLowerCase()
        const title = t(item.titleKey, item.defaultTitle).toLowerCase()
        const time = t(item.timeKey, item.defaultTime).toLowerCase()
        const desc = t(item.descKey, item.defaultDesc).toLowerCase()
        return title.includes(q) || time.includes(q) || desc.includes(q)
    })

    const filteredTasks = tasks.filter((task) => {
        if (statusFilter === 'active') {
            if (
                task.status === 'completed' ||
                task.status === 'paused' ||
                task.enabled === false
            ) {
                return false
            }
        } else if (statusFilter === 'paused') {
            if (task.status !== 'paused' && task.enabled !== false) {
                return false
            }
        } else if (statusFilter === 'completed') {
            if (task.status !== 'completed') {
                return false
            }
        }

        if (!searchQuery.trim()) return true
        const q = searchQuery.toLowerCase()
        return (
            task.title.toLowerCase().includes(q) ||
            task.schedule.toLowerCase().includes(q) ||
            (task.description && task.description.toLowerCase().includes(q)) ||
            task.prompt.toLowerCase().includes(q)
        )
    })

    const filterTabs: { id: FilterStatus; label: string }[] = [
        { id: 'all', label: t('scheduled.filter.all', 'All') },
        { id: 'active', label: t('scheduled.filter.active', 'Active') },
        { id: 'paused', label: t('scheduled.filter.paused', 'Paused') },
        { id: 'completed', label: t('scheduled.filter.completed', 'Completed') },
    ]

    const totalPages = Math.ceil(filteredTasks.length / PAGE_SIZE)
    const paginatedTasks = filteredTasks.slice(
        (currentPage - 1) * PAGE_SIZE,
        currentPage * PAGE_SIZE,
    )

    const hasTasks = tasks.length > 0
    const hasSearchResults =
        filteredTasks.length > 0 || filteredSuggestions.length > 0

    return (
        <div className="relative flex h-full w-full flex-row overflow-hidden bg-[var(--bg-app)]">
            <div className="relative flex h-full flex-1 flex-col overflow-hidden min-w-0">
                {/* Top Right Create Button (Hidden when drawer is open) */}
                {!modalOpen && !historyDrawerOpen ? (
                    <div className="absolute top-2.5 right-6 z-20 flex items-center">
                        <button
                            type="button"
                            onClick={openCreateModal}
                            className={cn(
                                'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-[inherit]',
                                'bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-primary)]',
                                'hover:bg-[var(--bg-sidebar-hover)] shadow-xs transition-colors cursor-pointer select-none',
                            )}
                        >
                            <span>{t('scheduled.create', 'Create')}</span>
                        </button>
                    </div>
                ) : null}

                {/* Main Scrollable View */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <div className="mx-auto w-full max-w-[760px] px-8 pt-8 pb-16">
                        {/* Page Header */}
                        <div className="mb-6">
                            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                                {t('scheduled.title', 'Scheduled tasks')}
                            </h1>
                            <p className="mt-1 text-xs text-[var(--text-muted)] leading-relaxed font-[inherit]">
                                {t(
                                    'scheduled.subtitle',
                                    'Have CPA schedule tasks, set reminders, or monitor updates',
                                )}
                            </p>
                        </div>

                        {/* Search Bar & Filter Bar */}
                        <div className="mb-6 flex flex-col gap-3">
                            <div className="relative flex-1">
                                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-[var(--text-muted)]" />
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder={t(
                                        'scheduled.searchPlaceholder',
                                        'Search scheduled tasks',
                                    )}
                                    className={cn(
                                        'h-10 w-full rounded-xl pl-10 pr-9 text-xs',
                                        'bg-[var(--bg-card)] border border-[var(--border-subtle)]',
                                        'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                        'focus:border-[var(--border-focus)] focus:outline-none transition-colors font-[inherit]',
                                    )}
                                />
                                {searchQuery ? (
                                    <button
                                        type="button"
                                        aria-label={t('common.clear', 'Clear')}
                                        onClick={() => setSearchQuery('')}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                                    >
                                        <X className="size-4" />
                                    </button>
                                ) : null}
                            </div>

                            {/* Filter Bar (Only shown when tasks exist) */}
                            {hasTasks ? (
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                        {filterTabs.map((tab) => {
                                            const isSelected = statusFilter === tab.id
                                            return (
                                                <button
                                                    key={tab.id}
                                                    type="button"
                                                    onClick={() => setStatusFilter(tab.id)}
                                                    className={cn(
                                                        'rounded-lg px-2.5 py-1 text-xs transition-colors cursor-pointer select-none font-[inherit]',
                                                        isSelected
                                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] font-medium'
                                                            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                                                    )}
                                                >
                                                    {tab.label}
                                                </button>
                                            )
                                        })}
                                    </div>

                                    <button
                                        type="button"
                                        onClick={handleMarkAllAsRead}
                                        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer font-[inherit]"
                                    >
                                        {t(
                                            'scheduled.markAllAsRead',
                                            'Mark all as read',
                                        )}
                                    </button>
                                </div>
                            ) : null}
                        </div>

                        {/* Task List */}
                        {hasTasks && paginatedTasks.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                {paginatedTasks.map((task) => {
                                    const subtitle = formatTaskSubtitle(task, t)
                                    return (
                                        <div
                                            key={task.id}
                                            onClick={() => {
                                                markAsRead(task.id)
                                                openEditModal(task)
                                            }}
                                            className={cn(
                                                'group relative flex items-center justify-between rounded-xl px-3 py-2.5 -mx-3',
                                                'hover:bg-[var(--bg-sidebar-hover)] transition-colors cursor-pointer select-none',
                                            )}
                                        >
                                            <div className="flex min-w-0 flex-1 flex-col">
                                                <div className="flex items-center gap-2">
                                                    {task.unread ? (
                                                        <Circle className="size-2 fill-[var(--accent-blue)] text-[var(--accent-blue)] shrink-0" />
                                                    ) : null}
                                                    <span className="text-[14px] font-medium text-[var(--text-primary)] truncate font-[inherit]">
                                                        {task.title}
                                                    </span>
                                                </div>
                                                <span className="mt-0.5 text-xs text-[var(--text-muted)] font-normal font-[inherit]">
                                                    {subtitle}
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-1">
                                                {task.lastRunError === STALLED_RUN_CLAIM ? (
                                                    <button
                                                        type="button"
                                                        onClick={(event) => {
                                                            event.stopPropagation()
                                                            setRecoveryTask(task)
                                                        }}
                                                        className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                                        title={t('scheduled.recover', 'Recover stalled task')}
                                                        aria-label={t('scheduled.recover', 'Recover stalled task')}
                                                    >
                                                        <RotateCcw className="size-4" />
                                                    </button>
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        toggleTask(task.id)
                                                    }}
                                                    className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                                    title={task.enabled ? t('scheduled.pause', 'Pause') : t('scheduled.resume', 'Resume')}
                                                >
                                                    {task.enabled ? (
                                                        <PauseCircle className="size-4" />
                                                    ) : (
                                                        <Play className="size-4" />
                                                    )}
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        markAsRead(task.id)
                                                        openEditModal(task)
                                                    }}
                                                    className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                                                    title={t('common.edit', 'Edit')}
                                                >
                                                    <Pencil className="size-3.5" />
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        deleteTask(task.id)
                                                    }}
                                                    className="flex size-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-red-400 transition-colors cursor-pointer"
                                                    title={t('common.delete', 'Delete')}
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        ) : null}

                        {/* Pagination (Shown when > 5 tasks) */}
                        {hasTasks && totalPages > 1 ? (
                            <div className="mt-4 flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                                <span>
                                    {t('scheduled.pageInfo', {
                                        current: currentPage,
                                        total: totalPages,
                                        defaultValue: `Page ${currentPage} of ${totalPages}`,
                                    })}
                                </span>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        disabled={currentPage <= 1}
                                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                        aria-label={t('common.prevPage', 'Previous page')}
                                        className="flex size-7 items-center justify-center rounded-lg hover:bg-[var(--bg-sidebar-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ChevronLeft className="size-4" />
                                    </button>
                                    <button
                                        type="button"
                                        disabled={currentPage >= totalPages}
                                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                        aria-label={t('common.nextPage', 'Next page')}
                                        className="flex size-7 items-center justify-center rounded-lg hover:bg-[var(--bg-sidebar-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ChevronRight className="size-4" />
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {/* Suggestions List */}
                        {filteredSuggestions.length > 0 ? (
                            <div
                                className={cn(
                                    'w-full',
                                    hasTasks ? 'mt-8' : 'mt-8',
                                )}
                            >
                                <h2 className="mb-4 text-[15px] font-medium text-[var(--text-primary)] font-[inherit] select-none">
                                    {t('scheduled.suggestions', 'Suggestions')}
                                </h2>
                                <div className="flex flex-col gap-3.5">
                                    {filteredSuggestions.map((item) => (
                                        <div
                                            key={item.id}
                                            onClick={() => handleSelectSuggestion(item)}
                                            className={cn(
                                                'group flex items-start gap-3.5 rounded-xl px-3 py-2 -mx-3',
                                                'hover:bg-[var(--bg-sidebar-hover)] cursor-pointer transition-colors select-none',
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    'mt-0.5 flex size-5 shrink-0 items-center justify-center',
                                                    item.iconColor,
                                                )}
                                            >
                                                {item.iconType === 'bell' ? (
                                                    <Bell className="size-4.5 stroke-[1.75]" />
                                                ) : item.iconType === 'file' ? (
                                                    <FileText className="size-4.5 stroke-[1.75]" />
                                                ) : (
                                                    <Compass className="size-4.5 stroke-[1.75]" />
                                                )}
                                            </div>

                                            <div className="flex min-w-0 flex-1 flex-col">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[14px] font-medium text-[var(--text-primary)] font-[inherit]">
                                                        {t(
                                                            item.titleKey,
                                                            item.defaultTitle,
                                                        )}
                                                    </span>
                                                    <span className="text-[13px] text-[var(--text-muted)] font-normal font-[inherit]">
                                                        {t(
                                                            item.timeKey,
                                                            item.defaultTime,
                                                        )}
                                                    </span>
                                                </div>
                                                <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed font-[inherit]">
                                                    {t(
                                                        item.descKey,
                                                        item.defaultDesc,
                                                    )}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : null}

                        {/* No Search Matches */}
                        {!hasSearchResults ? (
                            <div className="mt-12 flex w-full flex-col items-center justify-center text-center">
                                <p className="text-sm text-[var(--text-muted)] font-[inherit]">
                                    {t(
                                        'scheduled.noSearchMatch',
                                        'No matching tasks found',
                                    )}
                                </p>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
            {recoveryTask ? createPortal(
                <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--bg-app)]/80 px-4">
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('scheduled.recover', 'Recover stalled task')}
                        className="w-full max-w-md rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-5 shadow-xl font-[inherit]"
                    >
                        <h2 className="text-base text-[var(--text-primary)] font-[inherit]">
                            {t('scheduled.recover', 'Recover stalled task')}
                        </h2>
                        <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)] font-[inherit]">
                            {t('scheduled.recoveryWarning', 'Confirm the previous client is closed before releasing this run. If it resumes, the task may run twice.')}
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => setRecoveryTask(null)}
                                className="rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] font-[inherit]"
                            >
                                {t('common.cancel', 'Cancel')}
                            </button>
                            <button
                                type="button"
                                onClick={() => { void handleRecover() }}
                                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1.5 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)] font-[inherit]"
                            >
                                {t('scheduled.confirmRecovery', 'Release and retry')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            ) : null}
        </div>
    )
}
