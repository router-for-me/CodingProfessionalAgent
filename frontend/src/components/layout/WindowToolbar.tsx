import type { ButtonHTMLAttributes } from 'react'
import { Maximize2, Minimize2, PanelBottom, PanelRight } from 'lucide-react'
import { useCurrentViewLayout } from '@/plugins/platform/contributions/views'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useIsMobileBrowser } from '@/lib/platform'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'

/** Space reserved in the main title bar when all three actions sit at the window edge. */
export const WINDOW_TOOLBAR_THREE_WIDTH = 84

interface TitlebarIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  pressed?: boolean
}

function TitlebarIconButton({
  label,
  pressed,
  className,
  children,
  ...props
}: TitlebarIconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-lg leading-none',
        'text-[var(--text-muted)] transition-colors',
        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-subtle)]',
        pressed && 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function PinnedSummaryGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      <circle cx="3.1" cy="5" r="1.35" fill="currentColor" />
      <rect x="6.1" y="4.25" width="7.1" height="1.5" rx="0.75" fill="currentColor" />
      <circle cx="3.1" cy="11" r="1.35" fill="currentColor" />
      <rect x="6.1" y="10.25" width="7.1" height="1.5" rx="0.75" fill="currentColor" />
    </svg>
  )
}

export function PinnedSummaryToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const visible = useUiStore((state) => state.pinnedSummaryVisible)
  const toggle = useUiStore((state) => state.togglePinnedSummaryVisible)
  const label = visible
    ? t('nav.hidePinnedSummary')
    : t('nav.showPinnedSummary')

  return (
    <TitlebarIconButton
      data-testid="pinned-summary-toggle"
      label={label}
      pressed={visible}
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
    >
      <PinnedSummaryGlyph />
    </TitlebarIconButton>
  )
}

export function BottomPanelToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const visible = useUiStore((state) => state.bottomPanelVisible)
  const toggle = useUiStore((state) => state.toggleBottomPanelVisible)
  const label = t('nav.toggleBottomPanel')

  return (
    <TitlebarIconButton
      data-testid="bottom-panel-toggle"
      label={label}
      pressed={visible}
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
    >
      <PanelBottom className="size-3.5" strokeWidth={1.75} aria-hidden />
    </TitlebarIconButton>
  )
}

export function RightSidebarToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const collapsed = useUiStore((state) => state.rightSidebarCollapsed)
  const toggle = useUiStore((state) => state.toggleRightSidebarCollapsed)
  const label = collapsed
    ? t('nav.expandRightSidebar')
    : t('nav.collapseRightSidebar')

  return (
    <TitlebarIconButton
      data-testid="right-sidebar-toggle"
      label={label}
      pressed={!collapsed}
      className={className}
      onClick={toggle}
    >
      <PanelRight className="size-3.5" strokeWidth={1.75} aria-hidden />
    </TitlebarIconButton>
  )
}

export function RightSidebarMaximizeToggle({ className }: { className?: string }) {
  const { t } = useTranslation()
  const maximized = useUiStore((state) => state.rightSidebarMaximized)
  const toggle = useUiStore((state) => state.toggleRightSidebarMaximized)
  const label = maximized
    ? t('nav.restoreRightSidebar')
    : t('nav.maximizeRightSidebar')

  return (
    <TitlebarIconButton
      data-testid="right-sidebar-maximize-toggle"
      label={label}
      pressed={maximized}
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
    >
      {maximized ? (
        <Minimize2 className="size-3.5" strokeWidth={1.75} aria-hidden />
      ) : (
        <Maximize2 className="size-3.5" strokeWidth={1.75} aria-hidden />
      )}
    </TitlebarIconButton>
  )
}

/**
 * Window-edge actions. Sidebar + bottom-panel stay here in every layout.
 * Pinned-summary joins them only while the right sidebar is closed.
 */
export function WindowToolbar({
  includePinnedSummary,
}: {
  includePinnedSummary: boolean
}) {
  const layout = useCurrentViewLayout()
  const isMobile = useIsMobileBrowser()
  const showBottomPanel = useSettingsStore(
    (state) => state.settings.showBottomPanel,
  )
  const terminalPosition = useSettingsStore(
    (state) => state.settings.terminalPosition,
  )
  const isBottomTerminal = showBottomPanel && terminalPosition === 'bottom'
  const rightSidebarCollapsed = useUiStore(
    (state) => state.rightSidebarCollapsed,
  )

  if (!layout.reserveWindowToolbar) {
    return null
  }

  return (
    <div
      data-testid="window-toolbar"
      data-no-drag
      className="pointer-events-none absolute top-0 right-0 z-30 flex h-[var(--titlebar-height)] items-center pr-2"
    >
      <div
        data-no-drag
        className="pointer-events-auto flex -translate-y-px items-center gap-0.5"
      >
        {includePinnedSummary ? <PinnedSummaryToggle /> : null}
        {!isMobile && !rightSidebarCollapsed ? (
          <RightSidebarMaximizeToggle className="mr-3" />
        ) : null}
        {isBottomTerminal ? <BottomPanelToggle /> : null}
        <RightSidebarToggle />
      </div>
    </div>
  )
}

