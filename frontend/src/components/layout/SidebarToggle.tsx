import { PanelLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/uiStore'

interface SidebarToggleProps {
  className?: string
}

/**
 * Toggle control for collapsing / expanding the primary sidebar.
 * Sized to sit cleanly beside the 12px macOS traffic lights.
 */
export function SidebarToggle({ className }: SidebarToggleProps) {
  const { t } = useTranslation()
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebarCollapsed = useUiStore((s) => s.toggleSidebarCollapsed)

  return (
    <button
      type="button"
      aria-label={
        sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')
      }
      aria-pressed={sidebarCollapsed}
      title={
        sidebarCollapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')
      }
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md',
        'text-[var(--text-muted)] transition-colors',
        'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-subtle)]',
        className,
      )}
      onClick={toggleSidebarCollapsed}
    >
      <PanelLeft className="size-3.5" strokeWidth={1.75} aria-hidden />
    </button>
  )
}
