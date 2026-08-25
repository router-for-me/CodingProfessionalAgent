import { cn, useTranslation } from '@cpa/plugin-ui'

export interface CompactionDividerProps {
  className?: string
  /** True while this session is still summarizing context. */
  pending?: boolean
  message?: any
  value?: any
}

/**
 * Visual separator for a CompactionEntry. Not a chat bubble.
 * Pending uses the same divider slot and flips to the completed label after.
 */
export function CompactionDivider(props: CompactionDividerProps) {
  const { className } = props
  const pending = props.pending ?? props.value?.pending ?? props.message?.pending ?? false
  const { t } = useTranslation()
  const label = pending
    ? t('message.contextCompacting')
    : t('message.contextCompacted')

  return (
    <div
      role={pending ? 'status' : 'separator'}
      aria-live={pending ? 'polite' : undefined}
      aria-label={label}
      data-testid={pending ? 'compaction-progress' : 'compaction-divider'}
      className={cn(
        'flex items-center gap-3 py-2 text-[12px] text-[var(--text-muted)]',
        className,
      )}
    >
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
      <span className="shrink-0 tracking-wide">{label}</span>
      <div className="h-px flex-1 bg-[var(--border-subtle)]" />
    </div>
  )
}
