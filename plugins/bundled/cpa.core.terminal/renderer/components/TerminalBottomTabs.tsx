import { useCallback, useEffect, useMemo } from 'react'
import { Plus, SquareTerminal, X, cn, useHostServices, useTranslation } from '@cpa/plugin-ui'
import { useTerminalStore } from '../stores/terminalStore.js'
import { resolveTerminalContext } from '../utils/context.js'

export function TerminalBottomTabs() {
    const { t } = useTranslation()
    const services = useHostServices()
    const allTabs = useTerminalStore((state) => state.tabs)
    const tabs = useMemo(
        () => allTabs.filter((tab) => (tab.location ?? 'bottom') === 'bottom'),
        [allTabs],
    )
    const activeTabIdByLocation = useTerminalStore((state) => state.activeTabIdByLocation)
    const globalActiveTabId = useTerminalStore((state) => state.activeTabId)
    const activeTabId =
        activeTabIdByLocation?.bottom ??
        tabs.find((tab) => tab.id === globalActiveTabId)?.id ??
        tabs[tabs.length - 1]?.id ??
        null

    const addTab = useTerminalStore((state) => state.addTab)
    const closeTab = useTerminalStore((state) => state.closeTab)
    const setActiveTab = useTerminalStore((state) => state.setActiveTab)

    const resolveContext = useCallback(() => {
        const sessionId = services?.sessions?.getCurrentSessionId?.() ?? null
        const sessions = services?.sessions?.getSnapshot?.() ?? []
        const projects = services?.projects?.getSnapshot?.() ?? []
        const pendingContext = services?.ui?.getPendingSessionContext?.()
        return resolveTerminalContext({
            sessionId,
            sessions: sessions as any,
            projects: projects as any,
            pendingProjectId: pendingContext?.projectId ?? null,
            fallbackTitle: t('terminal.defaultTitle'),
        })
    }, [services, t])

    const handleAddTab = useCallback(() => {
        const ctx = resolveContext()
        addTab({ ...ctx, location: 'bottom' })
        services?.ui?.setBottomPanelVisible?.(true)
    }, [addTab, resolveContext, services])

    const handleCloseTab = useCallback(
        (id: string) => {
            closeTab(id)
            const remaining = useTerminalStore
                .getState()
                .tabs.filter((tab) => (tab.location ?? 'bottom') === 'bottom' && tab.id !== id)
            if (remaining.length === 0) {
                services?.ui?.setBottomPanelVisible?.(false)
            }
        },
        [closeTab, services],
    )

    // Auto-create initial tab if bottom panel has none
    useEffect(() => {
        if (tabs.length === 0) {
            const ctx = resolveContext()
            addTab({ ...ctx, location: 'bottom' })
        }
    }, [tabs.length, addTab, resolveContext])

    return (
        <div
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar"
            data-no-drag
            onWheel={(event) => {
                if (event.deltaY !== 0 && event.deltaX === 0) {
                    event.currentTarget.scrollLeft += event.deltaY
                }
            }}
        >
            {tabs.map((tab) => {
                const active = tab.id === activeTabId
                return (
                    <div
                        key={tab.id}
                        className={cn(
                            'flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2',
                            active
                                ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]',
                        )}
                    >
                        <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5"
                            onClick={() => setActiveTab(tab.id, 'bottom')}
                        >
                            <SquareTerminal
                                className="size-3.5 shrink-0 text-[var(--text-muted)]"
                                strokeWidth={1.75}
                                aria-hidden
                            />
                            <span className="truncate text-[12px]">{tab.title}</span>
                        </button>
                        <button
                            type="button"
                            data-testid={`terminal-tab-close-${tab.id}`}
                            aria-label={t('terminal.closeTab')}
                            className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            onClick={(event) => {
                                event.stopPropagation()
                                handleCloseTab(tab.id)
                            }}
                        >
                            <X className="size-3" strokeWidth={1.75} aria-hidden />
                        </button>
                    </div>
                )
            })}
            <button
                type="button"
                data-testid="terminal-new-tab"
                aria-label={t('terminal.newTab')}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                onClick={handleAddTab}
            >
                <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
            </button>
        </div>
    )
}
