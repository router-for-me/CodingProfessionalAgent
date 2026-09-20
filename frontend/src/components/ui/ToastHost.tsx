import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useUiStore, type ToastItem } from '@/stores/uiStore'

const AUTO_DISMISS_MS = 3200

/**
 * Global toast stack renderer bound to uiStore.toasts.
 */
export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const { t } = useTranslation()
  const dismissToast = useUiStore((s) => s.dismissToast)

  useEffect(() => {
    if (toast.action) return
    const timer = window.setTimeout(() => {
      dismissToast(toast.id)
    }, AUTO_DISMISS_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [dismissToast, toast.id, toast.action])

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex items-center gap-2 rounded-[var(--radius-card)]',
        'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2.5 shadow-lg',
        'text-[13px] text-[var(--text-primary)]',
      )}
    >
      <p className="min-w-0 flex-1 leading-snug">{toast.message}</p>
      {toast.action && (
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 font-[inherit] hover:bg-[var(--bg-sidebar-hover)]"
          onClick={toast.action.run}
        >
          {toast.action.label}
        </button>
      )}
      {!toast.action && <button
        type="button"
        aria-label={t('settings.close')}
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md',
          'text-[var(--text-muted)] transition-colors',
          'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
        )}
        onClick={() => dismissToast(toast.id)}
      >
        <X className="size-3.5" />
      </button>}
    </div>
  )
}
