import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { rendererRegistry, type RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { createPanelContext, createPanelOpenContext, usePanels } from '@/plugins/platform/contributions/panels'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'

export interface RightSidebarSelectionViewProps {
    sessionId?: string | null
    registry?: RendererRegistry
    onSelectTab?: (tabId: string) => void
    className?: string
}

/**
 * Dynamic selection view for the right sidebar empty state.
 * Discovers and renders registered panel tab selection cards from ExtensionRegistry.
 */
export function RightSidebarSelectionView({
    sessionId = null,
    registry = rendererRegistry,
    onSelectTab,
    className,
}: RightSidebarSelectionViewProps) {
    const { t } = useTranslation()
    const isMac =
        typeof navigator !== 'undefined' &&
        (/mac|iphone|ipad|ipod/i.test(navigator.platform || '') ||
            /mac/i.test(navigator.userAgent || ''))

    const panels = usePanels(registry)
    const sessions = useSessionStore((state) => state.sessions)
    const projects = useProjectStore((state) => state.projects)
    const pendingProjectId = useUiStore(
        (state) => state.pendingSessionContext.projectId
    )

    const currentSession = sessions.find((s) => s.id === sessionId)
    const effectiveProjectId = currentSession?.projectId ?? pendingProjectId ?? null
    const hasProject = Boolean(
        effectiveProjectId && projects.some((p) => p.id === effectiveProjectId)
    )

    const visibleTabs = panels.filter((tab) => {
        if (!tab.selectionCard) return false

        if (tab.selectionCard.requiresProject && !hasProject) {
            return false
        }
        if (
            typeof tab.isAvailable === 'function' &&
            !tab.isAvailable(createPanelContext(sessionId ?? undefined))
        ) {
            return false
        }
        if (
            typeof (tab as any).isEnabled === 'function' &&
            !(tab as any).isEnabled({
                projectId: effectiveProjectId,
                hasProject,
                sessionId,
            })
        ) {
            return false
        }
        return true
    })

    const sortedTabs = [...visibleTabs].sort(
        (a, b) =>
            (a.selectionCard?.order ?? a.order ?? 100) -
            (b.selectionCard?.order ?? b.order ?? 100)
    )

    const handleTabClick = (tabId: string) => {
        const panel = panels.find((p) => p.id === tabId)
        if (panel?.onOpen) {
            panel.onOpen(createPanelOpenContext(tabId, sessionId ?? undefined))
        }

        useUiStore.getState().openRightPanelTab(tabId, { activate: true })
        onSelectTab?.(tabId)
    }

    return (
        <div
            data-testid="right-sidebar-selection-view"
            className={cn(
                'flex flex-1 flex-col items-center justify-center p-6 min-h-0 w-full select-none',
                className
            )}
        >
            <div className="w-full max-w-[340px] flex flex-col gap-2.5">
                {sortedTabs.map((tab) => {
                    const card = tab.selectionCard!
                    const Icon = card.icon ?? tab.icon
                    const shortcut = isMac ? card.shortcutMac : card.shortcutOther
                    const label = card.labelKey
                        ? t(card.labelKey)
                        : card.label
                          ? card.label
                          : tab.titleKey
                            ? t(tab.titleKey)
                            : tab.title ?? tab.id

                    return (
                        <button
                            key={tab.id}
                            type="button"
                            data-testid={`right-sidebar-option-${tab.id}`}
                            onClick={() => handleTabClick(tab.id)}
                            className={cn(
                                'group flex h-11 w-full items-center justify-between rounded-lg',
                                'border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/60 px-3.5',
                                'text-left transition-all duration-150',
                                'hover:bg-[var(--bg-sidebar-hover)] hover:border-[var(--border-strong)]',
                                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-subtle)]',
                                'cursor-pointer'
                            )}
                        >
                            <div className="flex min-w-0 items-center gap-2.5">
                                {Icon ? (
                                    <Icon
                                        className="size-4 shrink-0 text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-primary)]"
                                        strokeWidth={1.75}
                                        aria-hidden
                                    />
                                ) : null}
                                <span className="truncate text-[13px] font-normal text-[var(--text-primary)]">
                                    {label}
                                </span>
                            </div>
                            {shortcut ? (
                                <span className="shrink-0 text-[12px] font-mono text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-secondary)]">
                                    {shortcut}
                                </span>
                            ) : null}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
