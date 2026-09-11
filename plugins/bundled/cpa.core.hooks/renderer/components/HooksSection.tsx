import { useEffect, useState } from 'react'
import {
    ArrowLeft,
    ChevronRight,
    Folder,
    Plus,
    RotateCw,
    Settings,
    Trash2,
    Edit3,
    Shield,
    Zap,
    Clock,
    Layers,
    ToggleSwitch,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import { useHooksStore } from '../hooksStore.js'
import {
    fetchHooks,
    deleteHook,
    toggleHookEnabled,
} from '../hooksActions.js'
import type { HookEventName, HookMetadata, Project, SessionItem } from '@cpa/plugin-api'
import { getAppConfigDirName } from '@cpa/plugin-api'
import { HOOK_EVENT_NAMES } from '../../agent/types.js'
import { HookEditorModal } from './HookEditorModal.js'
import { HookLearnMoreModal } from './HookLearnMoreModal.js'

const EVENT_COLORS: Record<HookEventName, { bg: string; text: string; border: string }> = {
    PreToolUse: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
    PostToolUse: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30' },
    PermissionRequest: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
    SessionStart: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
    SessionEnd: { bg: 'bg-rose-500/10', text: 'text-rose-400', border: 'border-rose-500/30' },
    UserPromptSubmit: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', border: 'border-cyan-500/30' },
    PreCompact: { bg: 'bg-indigo-500/10', text: 'text-indigo-400', border: 'border-indigo-500/30' },
    PostCompact: { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/30' },
    SubagentStart: { bg: 'bg-pink-500/10', text: 'text-pink-400', border: 'border-pink-500/30' },
    SubagentStop: { bg: 'bg-fuchsia-500/10', text: 'text-fuchsia-400', border: 'border-fuchsia-500/30' },
    Stop: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30' },
}

export function HooksSection() {
    const { t } = useTranslation()
    const services = useHostServices()

    const [projects, setProjects] = useState<readonly Project[]>(() => services?.projects?.getSnapshot?.() ?? [])
    const [sessions, setSessions] = useState<readonly SessionItem[]>(() => services?.sessions?.getSnapshot?.() ?? [])
    const [currentSessionId] = useState<string | null>(() => services?.sessions?.getCurrentSessionId?.() ?? null)

    useEffect(() => {
        const unsubProjects = services?.projects?.subscribe?.((p) => setProjects(p))
        const unsubSessions = services?.sessions?.subscribe?.((s) => setSessions(s))
        return () => {
            unsubProjects?.()
            unsubSessions?.()
        }
    }, [services])

    const activeSession = sessions.find((s) => s.id === currentSessionId)
    const activeProject = projects.find((p) => p.id === activeSession?.projectId) || (projects.length > 0 ? projects[0] : null)

    const loading = useHooksStore((s: any) => s.loading)
    const userHooks = useHooksStore((s: any) => s.userHooks)
    const projectConfigs = useHooksStore((s: any) => s.projectConfigs)
    const selectedSource = useHooksStore((s: any) => s.selectedSource)
    const setSelectedSource = useHooksStore((s: any) => s.setSelectedSource)
    const setLearnMoreOpen = useHooksStore((s: any) => s.setLearnMoreOpen)
    const openCreateEditor = useHooksStore((s: any) => s.openCreateEditor)
    const openEditEditor = useHooksStore((s: any) => s.openEditEditor)

    const [selectedEventFilter, setSelectedEventFilter] = useState<string>('all')
    const [isRefreshing, setIsRefreshing] = useState(false)

    // Gather project paths
    const projectPaths = Array.from(
        new Set(
            [
                ...(activeProject?.path ? [activeProject.path] : []),
                ...projects.map((p) => p.path).filter(Boolean),
            ].filter(Boolean) as string[],
        ),
    )

    useEffect(() => {
        if (services) {
            void fetchHooks(services, projectPaths)
        }
    }, [services])

    const handleRefresh = async () => {
        if (!services) return
        setIsRefreshing(true)
        try {
            await fetchHooks(services, projectPaths)
        } finally {
            setTimeout(() => setIsRefreshing(false), 500)
        }
    }

    const handleDelete = async (hook: HookMetadata) => {
        if (!services) return
        await deleteHook(services, hook, projectPaths)
    }

    const handleToggle = async (hook: HookMetadata) => {
        if (!services) return
        await toggleHookEnabled(services, hook, projectPaths)
    }

    const projectEntries = Object.entries(projectConfigs)

    if (selectedSource !== 'root') {
        const isUser = selectedSource === 'user'
        const currentHooks: HookMetadata[] = isUser
            ? userHooks
            : projectConfigs[selectedSource]?.hooks ?? []

        const filteredHooks =
            selectedEventFilter === 'all'
                ? currentHooks
                : currentHooks.filter((h) => h.eventName === selectedEventFilter)

        const title = isUser
            ? t('settings.hooks.userConfig', { defaultValue: 'User configuration' })
            : projects.find((p) => p.path === selectedSource)?.name ||
              selectedSource.split('/').filter(Boolean).pop() ||
              t('settings.hooks.projectConfig', { defaultValue: 'Project configuration' })

        const pathInfo = isUser
            ? `~/${getAppConfigDirName()}/hooks.json`
            : `${selectedSource}/.cpa/hooks.json`

        return (
            <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
                {/* Detail Header Actions */}
                <div className="flex items-center justify-between">
                    <button
                        type="button"
                        onClick={() => setSelectedSource('root')}
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                        <ArrowLeft className="size-3.5" />
                        <span>{t('common.back', { defaultValue: 'Back' })}</span>
                    </button>

                    <button
                        type="button"
                        onClick={() => openCreateEditor(selectedSource)}
                        className="flex size-8 items-center justify-center rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-white transition-all shadow-sm"
                        title={t('settings.hooks.addHook', { defaultValue: 'Add Hook' })}
                        aria-label={t('settings.hooks.addHook', { defaultValue: 'Add Hook' })}
                    >
                        <Plus className="size-4" strokeWidth={2.2} />
                    </button>
                </div>

                {/* Detail Title and Path */}
                <div>
                    <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                        {title}
                    </h1>
                    <p className="text-[12px] text-[var(--text-muted)] font-mono mt-0.5">{pathInfo}</p>
                </div>

                {/* Event Filter Pills */}
                <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border-subtle)] pb-3">
                    <button
                        type="button"
                        onClick={() => setSelectedEventFilter('all')}
                        className={cn(
                            'rounded-lg px-3 py-1 text-[13px] font-medium transition-colors',
                            selectedEventFilter === 'all'
                                ? 'bg-[var(--accent-blue)] text-white'
                                : 'bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]',
                        )}
                    >
                        {t('common.all', { defaultValue: 'All' })} ({currentHooks.length})
                    </button>
                    {HOOK_EVENT_NAMES.map((name) => {
                        const count = currentHooks.filter((h) => h.eventName === name).length
                        if (count === 0 && selectedEventFilter !== name) return null
                        return (
                            <button
                                key={name}
                                type="button"
                                onClick={() => setSelectedEventFilter(name)}
                                className={cn(
                                    'rounded-lg px-3 py-1 text-[13px] font-medium font-mono transition-colors',
                                    selectedEventFilter === name
                                        ? 'bg-[var(--accent-blue)] text-white'
                                        : 'bg-[var(--bg-sidebar)] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]',
                                )}
                            >
                                {name} ({count})
                            </button>
                        )
                    })}
                </div>

                {/* Hook Cards List */}
                {filteredHooks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)]/50 py-12 text-center">
                        <div className="flex size-12 items-center justify-center rounded-full bg-[var(--bg-card)] text-[var(--text-muted)]">
                            <Layers className="size-6" />
                        </div>
                        <h3 className="mt-3 text-sm font-medium text-[var(--text-primary)]">
                            {t('settings.hooks.emptyTitle', { defaultValue: 'No configured hooks' })}
                        </h3>
                        <p className="mt-1 text-xs text-[var(--text-muted)] max-w-sm">
                            {t('settings.hooks.emptyDesc', {
                                defaultValue: 'Click "Add Hook" in the top right corner to create the first lifecycle hook for this configuration.',
                            })}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredHooks.map((hook) => {
                            const colors = EVENT_COLORS[hook.eventName] || {
                                bg: 'bg-zinc-800/30',
                                text: 'text-zinc-300',
                                border: 'border-zinc-700',
                            }
                            const isCommand = hook.handler.type === 'command'
                            const commandText = isCommand
                                ? (hook.handler as any).command
                                : ''
                            const isAsync = isCommand && Boolean((hook.handler as any).async)

                            return (
                                <div
                                    key={hook.key}
                                    className={cn(
                                        'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] p-4 transition-all',
                                        !hook.enabled && 'opacity-60',
                                    )}
                                >
                                    {/* Header Row */}
                                    <div className="flex items-center justify-between">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span
                                                className={cn(
                                                    'inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 font-mono text-[12px] font-semibold border',
                                                    colors.bg,
                                                    colors.text,
                                                    colors.border,
                                                )}
                                            >
                                                <Shield className="size-3.5" />
                                                {hook.eventName}
                                            </span>

                                            {hook.matcher && (
                                                <span className="rounded-md bg-zinc-800/60 px-2.5 py-0.5 font-mono text-[12px] text-zinc-300 border border-zinc-700/50">
                                                    Match: {hook.matcher}
                                                </span>
                                            )}

                                            {isAsync && (
                                                <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2.5 py-0.5 text-[12px] text-amber-400 border border-amber-500/30">
                                                    <Zap className="size-3.5" />
                                                    Async
                                                </span>
                                            )}

                                            <span className="inline-flex items-center gap-1 text-[12px] text-[var(--text-muted)]">
                                                <Clock className="size-3.5" />
                                                {hook.timeoutSec}s
                                            </span>
                                        </div>

                                        <div className="flex items-center gap-2">
                                            <ToggleSwitch
                                                checked={hook.enabled}
                                                onChange={() => void handleToggle(hook)}
                                                label={hook.enabled ? 'Enabled' : 'Disabled'}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => openEditEditor(hook)}
                                                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                                                title="Edit"
                                            >
                                                <Edit3 className="size-4" />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => void handleDelete(hook)}
                                                className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-400 transition-colors"
                                                title="Delete"
                                            >
                                                <Trash2 className="size-4" />
                                            </button>
                                        </div>
                                    </div>

                                    {isCommand && (
                                        <div className="mt-2.5">
                                            <pre className="overflow-x-auto rounded-lg border border-[var(--border-subtle)] bg-black/40 p-3 font-mono text-[13px] text-zinc-200">
                                                {commandText}
                                            </pre>
                                        </div>
                                    )}

                                    {(hook.statusMessage || hook.additionalContextLimit) && (
                                        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12px] text-[var(--text-muted)]">
                                            {hook.statusMessage && (
                                                <span>Status: &ldquo;{hook.statusMessage}&rdquo;</span>
                                            )}
                                            {hook.additionalContextLimit && (
                                                <span>Context limit: {hook.additionalContextLimit} tokens</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                )}

                <HookEditorModal />
                <HookLearnMoreModal />
            </div>
        )
    }

    return (
        <div className="mx-auto w-full max-w-[760px] px-8 pt-8 pb-12">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                        {t('settings.hooks.title', { defaultValue: 'Hooks' })}
                    </h1>
                    <p className="mt-1 text-[13px] text-[var(--text-secondary)]">
                        {t('settings.hooks.subtitle', {
                            defaultValue: 'Manage lifecycle hooks through configuration and enabled plugins.',
                        })}
                        <button
                            type="button"
                            onClick={() => setLearnMoreOpen(true)}
                            className="text-[#3b82f6] hover:underline focus:outline-none font-medium ml-1"
                        >
                            {t('settings.hooks.learnMoreLink', { defaultValue: 'Learn more' })}
                        </button>
                    </p>
                </div>

                <button
                    type="button"
                    onClick={handleRefresh}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] transition-colors"
                    title={t('common.refresh', { defaultValue: 'Refresh' })}
                >
                    <RotateCw className={cn('size-4', (loading || isRefreshing) && 'animate-spin')} />
                </button>
            </div>

            <div className="mt-8">
                <h2 className="text-[13px] font-medium text-[var(--text-muted)] mb-3">
                    {t('settings.hooks.fromConfig', { defaultValue: 'From Configuration' })}
                </h2>

                <div
                    onClick={() => setSelectedSource('user')}
                    className={cn(
                        'group flex items-center justify-between rounded-2xl border border-[var(--border-subtle)]',
                        'bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] p-4 cursor-pointer transition-colors shadow-sm',
                    )}
                >
                    <div className="flex items-center gap-3.5">
                        <div className="flex size-9 items-center justify-center rounded-xl bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
                            <Settings className="size-4" />
                        </div>
                        <div>
                            <div className="text-[15px] font-semibold text-[var(--text-primary)]">
                                {t('settings.hooks.userConfig', { defaultValue: 'User configuration' })}
                            </div>
                            <div className="text-[13px] text-[var(--text-muted)] mt-0.5">
                                {t('settings.hooks.hooksCount', {
                                    count: userHooks.length,
                                    defaultValue: `${userHooks.length} hooks`,
                                })}
                            </div>
                        </div>
                    </div>

                    <ChevronRight className="size-4 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors" />
                </div>
            </div>

            {projectEntries.length > 0 && (
                <div className="mt-7">
                    <h2 className="text-[13px] font-medium text-[var(--text-muted)] mb-3">
                        {t('settings.hooks.fromProjectConfig', { defaultValue: 'From Project Configuration' })}
                    </h2>

                    <div className="space-y-3">
                        {projectEntries.map(([projPath, config]: [string, any]) => {
                            const projectName =
                                projects.find((p) => p.path === projPath)?.name ||
                                projPath.split('/').filter(Boolean).pop() ||
                                'Project'

                            return (
                                <div
                                    key={projPath}
                                    onClick={() => setSelectedSource(projPath)}
                                    className={cn(
                                        'group flex items-center justify-between rounded-2xl border border-[var(--border-subtle)]',
                                        'bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] p-4 cursor-pointer transition-colors shadow-sm',
                                    )}
                                >
                                    <div className="flex items-center gap-3.5">
                                        <div className="flex size-9 items-center justify-center rounded-xl bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors">
                                            <Folder className="size-4" />
                                        </div>
                                        <div>
                                            <div className="text-[15px] font-semibold text-[var(--text-primary)]">
                                                {projectName}
                                            </div>
                                            <div className="text-[13px] text-[var(--text-muted)] mt-0.5">
                                                {t('settings.hooks.hooksCount', {
                                                    count: config.hooks.length,
                                                    defaultValue: `${config.hooks.length} hooks`,
                                                })}
                                            </div>
                                        </div>
                                    </div>

                                    <ChevronRight className="size-4 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors" />
                                </div>
                            )
                        })}
                    </div>
                </div>
            )}

            <HookEditorModal />
            <HookLearnMoreModal />
        </div>
    )
}
