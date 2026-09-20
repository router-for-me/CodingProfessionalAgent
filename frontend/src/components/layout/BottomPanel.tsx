import { useCallback, useEffect, useRef, useState } from 'react'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'
import { cn } from '@/lib/cn'
import { useIsMobileBrowser } from '@/lib/platform'
import { HorizontalPanelResizeHandle } from '@/components/layout/PanelResizeHandle'
import { SidebarToggle } from '@/components/layout/SidebarToggle'
import { useCollapsibleOpen } from '@/components/layout/useCollapsibleOpen'
import { useSettingsStore } from '@/stores/settingsStore'
import {
    MAX_BOTTOM_PANEL_HEIGHT,
    MIN_BOTTOM_PANEL_HEIGHT,
    useUiStore,
} from '@/stores/uiStore'

export function BottomPanel() {
    const isMobile = useIsMobileBrowser()
    const showBottomPanel = useSettingsStore((state) => state.settings.showBottomPanel)
    const terminalPosition = useSettingsStore((state) => state.settings.terminalPosition)
    const isBottom = showBottomPanel && terminalPosition === 'bottom'
    const visible = useUiStore((state) => state.bottomPanelVisible)
    const height = useUiStore((state) => state.bottomPanelHeight)
    const setHeight = useUiStore((state) => state.setBottomPanelHeight)
    const setVisible = useUiStore((state) => state.setBottomPanelVisible)

    const panelRef = useRef<HTMLDivElement>(null)
    const [isResizing, setIsResizing] = useState(false)
    const collapse = useCollapsibleOpen(visible, { animatePresent: true })

    useEffect(() => {
        if (!isMobile || !visible) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setVisible(false)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isMobile, visible, setVisible])

    const handleResize = useCallback(
        (clientY: number) => {
            const rect = panelRef.current?.getBoundingClientRect()
            if (!rect) return
            setHeight(rect.bottom - clientY)
        },
        [setHeight],
    )

    if (!isBottom) {
        return null
    }

    if (isMobile) {
        if (!visible) {
            return (
                <div
                    data-testid="bottom-panel"
                    role="region"
                    aria-label="Bottom Panel"
                    aria-hidden="true"
                    inert
                    data-state="closed"
                    data-mobile="true"
                    className="hidden"
                />
            )
        }

        return (
            <div
                ref={panelRef}
                data-testid="bottom-panel"
                role="region"
                aria-label="Bottom Panel"
                aria-hidden={false}
                data-state="open"
                data-mobile="true"
                className="fixed inset-0 z-50 flex h-full w-full flex-col overflow-hidden app-background-surface bg-[var(--bg-app)]"
            >
                <div className="flex h-full min-h-0 w-full shrink-0 flex-col">
                    <div
                        className="flex h-[var(--titlebar-height)] shrink-0 items-center border-b border-[var(--border-subtle)] py-0"
                        data-drag-region
                    >
                        <div className="flex -translate-y-px items-center pl-2.5 pr-1">
                            <SidebarToggle />
                        </div>
                        <div className="flex min-w-0 flex-1 items-center px-1 pr-2">
                            <ExtensionSlot name="layout.bottom_panel.tabs" />
                        </div>
                    </div>

                    <div className="min-h-0 flex-1">
                        <ExtensionSlot name="layout.bottom_panel.content" />
                    </div>
                </div>
            </div>
        )
    }

    if (!visible && !collapse.open && !collapse.transition) {
        return null
    }

    return (
        <div
            ref={panelRef}
            data-testid="bottom-panel"
            role="region"
            aria-label="Bottom Panel"
            aria-hidden={!visible}
            inert={!visible}
            data-state={collapse.open ? 'open' : 'closed'}
            className={cn(
                'relative flex shrink-0 flex-col overflow-hidden border-t border-[var(--border-subtle)] app-background-surface bg-[var(--bg-app)]',
                !isResizing && 'transition-[height] duration-200 ease-out',
            )}
            style={{ height: collapse.open ? height : 0 }}
        >
            <HorizontalPanelResizeHandle
                label="Resize bottom panel"
                height={height}
                min={MIN_BOTTOM_PANEL_HEIGHT}
                max={MAX_BOTTOM_PANEL_HEIGHT}
                onResize={handleResize}
                onDraggingChange={setIsResizing}
            />

            <div
                className="flex w-full shrink-0 flex-col"
                style={{ height }}
            >
                <div className="flex h-9 shrink-0 items-center gap-1 px-2">
                    <div className="flex min-w-0 flex-1 items-center">
                        <ExtensionSlot name="layout.bottom_panel.tabs" />
                    </div>
                </div>

                <div className="min-h-0 flex-1">
                    <ExtensionSlot name="layout.bottom_panel.content" />
                </div>
            </div>
        </div>
    )
}
export default BottomPanel
