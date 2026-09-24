import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import { SlotErrorBoundary } from '@/plugins/registry/SlotErrorBoundary'
import { rendererRegistry, type RendererRegistry } from '@/plugins/platform/rendererRegistry'
import {
    createPanelCloseContext,
    createPanelOpenContext,
    createPanelContext,
    usePanels,
} from '@/plugins/platform/contributions/panels'
import { cn } from '@/lib/cn'
import { isBrowserEnvironment, isWindowsPlatform, useIsMobileBrowser } from '@/lib/platform'
import { PanelResizeHandle } from '@/components/layout/PanelResizeHandle'
import { SidebarToggle } from '@/components/layout/SidebarToggle'
import {
    BottomPanelToggle,
    RightSidebarToggle,
} from '@/components/layout/WindowToolbar'
import {
    prefersReducedMotion,
    useCollapsibleOpen,
} from '@/components/layout/useCollapsibleOpen'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import {
    DEFAULT_RIGHT_SIDEBAR_WIDTH,
    MAX_RIGHT_SIDEBAR_WIDTH,
    MIN_RIGHT_SIDEBAR_WIDTH,
    useUiStore,
} from '@/stores/uiStore'
import { RightSidebarSelectionView } from './RightSidebarSelectionView'

export interface SubAgentPanelProps {
    sessionId: string | null
    registry?: RendererRegistry
}

/**
 * Universal right sidebar host decoupled from specific plugins.
 * Tab contributions and content views are discovered dynamically via ExtensionRegistry.
 */
export function SubAgentPanel({
    sessionId,
    registry = rendererRegistry,
}: SubAgentPanelProps) {
    const { t } = useTranslation()
    const showBottomPanel = useSettingsStore((state) => state.settings.showBottomPanel)
    const terminalPosition = useSettingsStore((state) => state.settings.terminalPosition)
    const isBottomDrawerActive = showBottomPanel && terminalPosition === 'bottom'

    const sessions = useSessionStore((state) => state.sessions)
    const projects = useProjectStore((state) => state.projects)
    const pendingProjectId = useUiStore(
        (state) => state.pendingSessionContext.projectId
    )

    const storedWidth = useUiStore((state) => state.rightSidebarWidth)
    const setRightSidebarWidth = useUiStore((state) => state.setRightSidebarWidth)
    const [isResizing, setIsResizing] = useState(false)
    const collapsed = useUiStore((state) => state.rightSidebarCollapsed)
    const setRightSidebarCollapsed = useUiStore((state) => state.setRightSidebarCollapsed)
    const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
    const sidebarWidth = useUiStore((state) => state.sidebarWidth)
    const maximized = useUiStore((state) => state.rightSidebarMaximized) && !collapsed
    const collapse = useCollapsibleOpen(!collapsed)

    const [isMaxTransitioning, setIsMaxTransitioning] = useState(false)
    const [maxTransitionEpoch, setMaxTransitionEpoch] = useState(0)
    const prevMaximizedRef = useRef(maximized)
    const prevCollapsedRef = useRef(collapsed)
    const prevSidebarCollapsedRef = useRef(sidebarCollapsed)
    const collapsedFromMaximizedRef = useRef(false)
    const wasMaximized = prevMaximizedRef.current

    // Synchronize transition flag during render to avoid any first-frame text reflow
    if (prevMaximizedRef.current !== maximized) {
        prevMaximizedRef.current = maximized
        if (!collapsed && !prefersReducedMotion()) {
            setIsMaxTransitioning(true)
            setMaxTransitionEpoch((epoch) => epoch + 1)
        }
    }

    if (prevSidebarCollapsedRef.current !== sidebarCollapsed) {
        prevSidebarCollapsedRef.current = sidebarCollapsed
        if (maximized && !collapsed && !prefersReducedMotion()) {
            setIsMaxTransitioning(true)
            setMaxTransitionEpoch((epoch) => epoch + 1)
        }
    }

    if (prevCollapsedRef.current !== collapsed) {
        if (collapsed && wasMaximized) {
            collapsedFromMaximizedRef.current = true
        } else if (!collapsed) {
            collapsedFromMaximizedRef.current = false
        }
        prevCollapsedRef.current = collapsed
    }

    useEffect(() => {
        if (maxTransitionEpoch === 0) return
        const timer = window.setTimeout(() => {
            setIsMaxTransitioning(false)
        }, 250)
        return () => window.clearTimeout(timer)
    }, [maxTransitionEpoch])

    const rightPanelOpenTabs = useUiStore((state) => state.rightPanelOpenTabs)
    const rightPanelActiveTab = useUiStore((state) => state.rightPanelActiveTab)
    const rightPanelTabParams = useUiStore((state) => state.rightPanelTabParams)
    const openRightPanelTab = useUiStore((state) => state.openRightPanelTab)
    const closeRightPanelTab = useUiStore((state) => state.closeRightPanelTab)
    const setActiveRightPanelTab = useUiStore((state) => state.setActiveRightPanelTab)

    const panels = usePanels(registry)
    const panelsMap = useMemo(
        () => new Map(panels.map((tab) => [tab.id, tab])),
        [panels]
    )

    const currentSession = sessions.find((s) => s.id === sessionId)
    const selectedProjectId = currentSession?.projectId ?? pendingProjectId
    const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null
    const hasSelectedProject = Boolean(selectedProject)

    // Panels with custom multi-instance headers vs standard single tab headers
    const customHeaderPanels = useMemo(
        () => panels.filter((p) => Boolean(p.headerActionsComponent)),
        [panels]
    )
    const standardOpenPanelIds = useMemo(
        () =>
            rightPanelOpenTabs.filter((id) => {
                const panel = panelsMap.get(id)
                return panel && !panel.headerActionsComponent
            }),
        [rightPanelOpenTabs, panelsMap]
    )

    const hasAnyCustomOpen = customHeaderPanels.some(
        (p) => Boolean(p.hasOpenTabs?.(sessionId))
    )
    const hasAnyStandardOpen = standardOpenPanelIds.length > 0
    const hasAnyOpenTabs = hasAnyCustomOpen || hasAnyStandardOpen

    // Determine current active view fallback dynamically
    const resolvedActiveTab: string | null = useMemo(() => {
        if (rightPanelActiveTab === 'selection') return 'selection'

        if (rightPanelActiveTab) {
            const activeDef = panelsMap.get(rightPanelActiveTab)
            if (activeDef) {
                if (activeDef.headerActionsComponent && activeDef.hasOpenTabs?.(sessionId)) {
                    return rightPanelActiveTab
                }
                if (standardOpenPanelIds.includes(rightPanelActiveTab)) {
                    return rightPanelActiveTab
                }
            }
        }

        // Fallbacks
        for (const customPanel of customHeaderPanels) {
            if (customPanel.hasOpenTabs?.(sessionId)) {
                return customPanel.id
            }
        }

        if (hasAnyStandardOpen) {
            return standardOpenPanelIds[standardOpenPanelIds.length - 1]
        }

        return null
    }, [
        rightPanelActiveTab,
        panelsMap,
        customHeaderPanels,
        standardOpenPanelIds,
        hasAnyStandardOpen,
        sessionId,
    ])

    const handleResize = useCallback(
        (clientX: number) => {
            setRightSidebarWidth(window.innerWidth - clientX)
        },
        [setRightSidebarWidth]
    )

    // Global keyboard shortcuts for registered panel tabs
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null
            const isInput =
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable)
            if (isInput) return

            for (const panel of panels) {
                if (!panel.shortcut) continue
                if (panel.shortcut.keyEventMatch(event, { hasProject: hasSelectedProject })) {
                    event.preventDefault()
                    panel.onOpen?.(
                        createPanelOpenContext(panel.id, sessionId ?? undefined)
                    )
                    openRightPanelTab(panel.id, { activate: true })

                    if (collapsed) {
                        setRightSidebarCollapsed(false)
                    }
                    return
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [
        panels,
        hasSelectedProject,
        sessionId,
        openRightPanelTab,
        collapsed,
        setRightSidebarCollapsed,
    ])

    // EventBus integration for right panel tabs
    useEffect(() => {
        const unsubOpen = rendererEventBus.on('right-panel:open-tab', (payload) => {
            const { tabId, params } = (payload ?? {}) as {
                tabId?: string
                params?: Record<string, unknown>
            }
            if (!tabId) return

            const panel = panelsMap.get(tabId)
            panel?.onOpen?.(
                createPanelOpenContext(tabId, sessionId ?? undefined, params)
            )

            openRightPanelTab(tabId, { activate: true, params })
            if (collapsed) {
                setRightSidebarCollapsed(false)
            }
        })

        const unsubClose = rendererEventBus.on('right-panel:close-tab', (payload) => {
            const { tabId } = (payload ?? {}) as { tabId?: string }
            if (!tabId) return

            const panel = panelsMap.get(tabId)
            panel?.onClose?.(
                createPanelCloseContext(tabId, sessionId ?? undefined)
            )
            closeRightPanelTab(tabId)
        })

        return () => {
            unsubOpen()
            unsubClose()
        }
    }, [
        panelsMap,
        sessionId,
        openRightPanelTab,
        closeRightPanelTab,
        collapsed,
        setRightSidebarCollapsed,
    ])

    const activePanelDef = resolvedActiveTab ? panelsMap.get(resolvedActiveTab) : undefined
    const dynamicPreferredWidth =
        typeof activePanelDef?.preferredWidth === 'function'
            ? activePanelDef.preferredWidth(
                createPanelContext(sessionId ?? undefined)
            )
            : activePanelDef?.preferredWidth

    const panelWidth =
        storedWidth ?? dynamicPreferredWidth ?? DEFAULT_RIGHT_SIDEBAR_WIDTH

    const isWebLayout = isBrowserEnvironment() || isWindowsPlatform()
    const isMobile = useIsMobileBrowser()

    const availableMaximizedWidth = typeof window !== 'undefined'
        ? window.innerWidth - (sidebarCollapsed ? 0 : sidebarWidth)
        : DEFAULT_RIGHT_SIDEBAR_WIDTH

    // Pre-set inner content width so text/child elements never reflow into narrow widths
    // during collapse, expand, or maximize animations.
    const isCollapsingFromMaximized =
        collapsedFromMaximizedRef.current && (collapsed || !collapse.open || collapse.transition)

    const isLayoutTransitioning =
        !collapse.open || collapse.transition || isMaxTransitioning

    const targetContentWidth = isCollapsingFromMaximized || maximized
        ? availableMaximizedWidth
        : panelWidth

    const useFluidWidth =
        maximized && !isMaxTransitioning && collapse.open && !isCollapsingFromMaximized

    useEffect(() => {
        if (!isMobile || collapsed) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setRightSidebarCollapsed(true)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isMobile, collapsed, setRightSidebarCollapsed])

    if (isMobile && collapsed) {
        return (
            <aside
                className="hidden"
                aria-hidden="true"
                inert
                data-state="closed"
                data-mobile="true"
                data-testid="subagent-panel"
            />
        )
    }

    return (
        <aside
            className={cn(
                isMobile
                    ? 'fixed inset-0 z-50 flex h-full w-full flex-col overflow-hidden app-background-surface bg-[var(--bg-app)]'
                    : cn(
                        'relative flex h-full flex-col',
                        isLayoutTransitioning
                            ? 'overflow-hidden'
                            : 'overflow-visible',
                        !maximized && 'border-l border-[var(--border-subtle)]',
                        'app-background-surface bg-[var(--bg-app)]',
                        maximized ? 'min-w-0 flex-1' : 'shrink-0',
                        !isResizing &&
                            'transition-[width,flex] duration-200 ease-out motion-reduce:transition-none',
                    ),
            )}
            style={
                isMobile
                    ? undefined
                    : {
                        width: maximized
                            ? undefined
                            : collapse.open
                              ? (isCollapsingFromMaximized ? availableMaximizedWidth : panelWidth)
                              : 0,
                        flex: maximized ? '1 1 0%' : '0 0 auto',
                    }
            }
            aria-hidden={collapsed}
            inert={collapsed}
            data-state={collapse.open ? 'open' : 'closed'}
            data-maximized={maximized}
            data-mobile={isMobile ? 'true' : undefined}
            data-testid="subagent-panel"
        >
            <div
                data-testid="subagent-panel-content"
                className={cn(
                    'flex h-full min-h-0 flex-col',
                    isLayoutTransitioning ? 'overflow-hidden' : 'overflow-visible',
                    isMobile ? 'w-full' : 'shrink-0',
                )}
                style={
                    isMobile
                        ? undefined
                        : {
                            width: useFluidWidth ? '100%' : targetContentWidth,
                            minWidth: useFluidWidth ? undefined : targetContentWidth,
                        }
                }
            >
                <div
                    className={cn(
                        'flex h-[var(--titlebar-height)] shrink-0 items-center border-b border-[var(--border-subtle)] py-0',
                        isMobile
                            ? 'pl-0 pr-0'
                            : cn(
                                'pr-24',
                                maximized && sidebarCollapsed
                                    ? isWebLayout
                                        ? 'pl-2.5'
                                        : 'pl-0'
                                    : 'pl-2',
                            ),
                    )}
                    data-drag-region
                >
                    {isMobile ? (
                        <div className="flex -translate-y-px items-center pl-2.5 pr-1">
                            <SidebarToggle />
                        </div>
                    ) : maximized && sidebarCollapsed ? (
                        <>
                            {!isWebLayout ? (
                                <div
                                    aria-hidden
                                    className="h-full shrink-0"
                                    style={{ width: 'var(--traffic-lights-pad)' }}
                                    data-drag-region
                                />
                            ) : null}
                            <div className="flex -translate-y-px items-center pr-1">
                                <SidebarToggle />
                            </div>
                        </>
                    ) : null}
                    <div
                        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto no-scrollbar px-1"
                        data-no-drag
                        onWheel={(event) => {
                            if (event.deltaY !== 0 && event.deltaX === 0) {
                                event.currentTarget.scrollLeft += event.deltaY
                            }
                        }}
                    >
                        {customHeaderPanels.map((panel) => {
                            const HeaderComp = panel.headerActionsComponent!
                            return (
                                <HeaderComp
                                    key={panel.id}
                                    sessionId={sessionId}
                                    active={resolvedActiveTab === panel.id}
                                />
                            )
                        })}

                        {standardOpenPanelIds.map((tabId) => {
                            const tabDef = panelsMap.get(tabId)!
                            const tabParams = rightPanelTabParams[tabId] ?? {}
                            const active = resolvedActiveTab === tabId
                            const Icon =
                                tabDef.getDynamicIcon?.(tabParams, { sessionId }) ?? tabDef.icon
                            const title =
                                tabDef.getDynamicTitle?.(tabParams, { sessionId }) ??
                                (tabDef.titleKey ? t(tabDef.titleKey) : tabDef.title ?? tabId)

                            return (
                                <div
                                    key={tabId}
                                    className={cn(
                                        'flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2',
                                        active
                                            ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)]'
                                    )}
                                >
                                    <button
                                        type="button"
                                        className="flex min-w-0 flex-1 items-center gap-1.5"
                                        onClick={() => setActiveRightPanelTab(tabId)}
                                    >
                                        {Icon ? (
                                            <Icon
                                                className="size-3.5 shrink-0 text-[var(--text-muted)]"
                                                strokeWidth={1.75}
                                                aria-hidden
                                            />
                                        ) : null}
                                        <span className="truncate text-[12px]">{title}</span>
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`${tabId}-tab-close`}
                                        aria-label={t('rightSidebar.closeTab')}
                                        className="flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                        onClick={(event) => {
                                            event.stopPropagation()
                                            tabDef.onClose?.(
                                                createPanelCloseContext(tabId, sessionId ?? undefined)
                                            )
                                            closeRightPanelTab(tabId)
                                        }}
                                    >
                                        <X className="size-3" strokeWidth={1.75} aria-hidden />
                                    </button>
                                </div>
                            )
                        })}

                        {hasAnyOpenTabs ? (
                            <button
                                type="button"
                                data-testid="terminal-new-tab"
                                aria-label={t('rightSidebar.newTab')}
                                className={cn(
                                    'flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors',
                                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                    resolvedActiveTab === 'selection' &&
                                        'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                                )}
                                onClick={() => {
                                    setActiveRightPanelTab('selection')
                                    if (collapsed) setRightSidebarCollapsed(false)
                                }}
                            >
                                <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
                            </button>
                        ) : null}
                    </div>
                    {isMobile ? (
                        <div className="flex shrink-0 -translate-y-px items-center pr-2 gap-0.5">
                            {isBottomDrawerActive ? <BottomPanelToggle /> : null}
                            <RightSidebarToggle />
                        </div>
                    ) : null}
                </div>

                {!hasAnyOpenTabs ||
                resolvedActiveTab === 'selection' ||
                resolvedActiveTab === null ? (
                    <RightSidebarSelectionView
                        key={`${sessionId ?? 'none'}:selection`}
                        sessionId={sessionId}
                        registry={registry}
                    />
                ) : activePanelDef ? (
                    (() => {
                        const TabComponent = activePanelDef.component as React.ComponentType<any>
                        const tabParams = rightPanelTabParams[resolvedActiveTab] ?? {}
                        return (
                            <div
                                key={`${sessionId ?? 'none'}:${resolvedActiveTab}`}
                                className="flex min-h-0 flex-1 flex-col w-full overflow-hidden"
                            >
                                <SlotErrorBoundary
                                    key={`${sessionId ?? 'none'}:${resolvedActiveTab}`}
                                    id={resolvedActiveTab}
                                    pluginId={activePanelDef.pluginId ?? resolvedActiveTab}
                                >
                                    <TabComponent sessionId={sessionId} {...tabParams} />
                                </SlotErrorBoundary>
                            </div>
                        )
                    })()
                ) : (
                    <RightSidebarSelectionView
                        key={`${sessionId ?? 'none'}:fallback`}
                        sessionId={sessionId}
                        registry={registry}
                    />
                )}
            </div>
            {!maximized && !isMobile && (
                <PanelResizeHandle
                    label={t('nav.resizeRightSidebar')}
                    width={panelWidth}
                    min={MIN_RIGHT_SIDEBAR_WIDTH}
                    max={MAX_RIGHT_SIDEBAR_WIDTH}
                    edge="left"
                    onResize={handleResize}
                    onDraggingChange={setIsResizing}
                />
            )}
        </aside>
    )
}
