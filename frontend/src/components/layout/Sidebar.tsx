import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'
import { cn } from '@/lib/cn'
import { useIsMobileBrowser } from '@/lib/platform'
import {
    MAX_SIDEBAR_WIDTH,
    MIN_SIDEBAR_WIDTH,
    useUiStore,
} from '@/stores/uiStore'
import { PanelResizeHandle } from './PanelResizeHandle'
import { TitleBar } from './TitleBar'
import { useCollapsibleOpen } from './useCollapsibleOpen'
import { UserFooter } from './UserFooter'

/**
 * Pure collapsible and resizable sidebar container hosting extension slots.
 * Renders full screen on mobile browser viewports when expanded.
 */
export function Sidebar() {
    const { t } = useTranslation()
    const isMobile = useIsMobileBrowser()
    const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
    const sidebarWidth = useUiStore((s) => s.sidebarWidth)
    const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)
    const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
    const collapse = useCollapsibleOpen(!sidebarCollapsed)
    const [isResizing, setIsResizing] = useState(false)

    useEffect(() => {
        if (!isMobile || sidebarCollapsed) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSidebarCollapsed(true)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isMobile, sidebarCollapsed, setSidebarCollapsed])

    if (isMobile) {
        if (sidebarCollapsed) {
            return (
                <aside
                    className="hidden"
                    aria-hidden="true"
                    inert
                    data-state="closed"
                    data-mobile="true"
                />
            )
        }

        return (
            <aside
                className="fixed inset-0 z-50 flex h-full w-full flex-col overflow-hidden bg-[var(--bg-sidebar)] select-none"
                aria-hidden={false}
                data-state="open"
                data-mobile="true"
            >
                <div className="flex h-full min-h-0 w-full shrink-0 flex-col">
                    <TitleBar />
                    <ExtensionSlot name="layout.sidebar.nav.top" />
                    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                        <ExtensionSlot name="layout.sidebar.content" />
                    </div>
                    <ExtensionSlot name="layout.sidebar.nav.bottom" />
                    <UserFooter />
                </div>
            </aside>
        )
    }

    return (
        <aside
            className={cn(
                'relative flex h-full shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)] select-none',
                !collapse.open || collapse.transition
                    ? 'overflow-hidden'
                    : 'overflow-visible',
                !isResizing && 'transition-[width] duration-200 ease-out',
            )}
            style={{ width: collapse.open ? sidebarWidth : 0 }}
            aria-hidden={sidebarCollapsed}
            inert={sidebarCollapsed}
            data-state={collapse.open ? 'open' : 'closed'}
        >
            <div
                className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
                style={{ width: sidebarWidth }}
            >
                <TitleBar />
                <ExtensionSlot name="layout.sidebar.nav.top" />
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    <ExtensionSlot name="layout.sidebar.content" />
                </div>
                <ExtensionSlot name="layout.sidebar.nav.bottom" />
                <UserFooter />
            </div>

            <PanelResizeHandle
                label={t('nav.resizeSidebar')}
                width={sidebarWidth}
                min={MIN_SIDEBAR_WIDTH}
                max={MAX_SIDEBAR_WIDTH}
                edge="right"
                onResize={setSidebarWidth}
                onDraggingChange={setIsResizing}
            />
        </aside>
    )
}

