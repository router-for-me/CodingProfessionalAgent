import { memo } from 'react'
import { cn, useTranslation } from '@cpa/plugin-ui'
import { useElapsedMs } from '../utils/useElapsedMs.js'
import { formatElapsed } from '../utils/formatElapsed.js'

export interface TurnHeaderProps {
  startedAt: number
  completedAt?: number
  streaming: boolean
  status?: string
  interrupted?: boolean
  expanded?: boolean
  onToggle?: () => void
  className?: string
  pausedMs?: number
}

/**
 * CPA-style turn timer: "Processing 29s" while streaming, "Completed 4m 26s" when done,
 * or "Interrupted, ran for 10s" when interrupted.
 * Completed/interrupted label is clickable to expand/collapse the turn history.
 */
export const TurnHeader = memo(function TurnHeader({
  startedAt,
  completedAt,
  streaming,
  status,
  interrupted = false,
  expanded = false,
  onToggle,
  className,
  pausedMs = 0,
}: TurnHeaderProps) {
  const { t, i18n } = useTranslation()
  const elapsedMs = useElapsedMs(startedAt, completedAt, streaming, pausedMs)
  const time = formatElapsed(elapsedMs, i18n.resolvedLanguage)
  const isInterrupted =
    interrupted ||
    (!streaming &&
      (status === 'aborted' || status === 'streaming' || status === 'error'))
  const hasDuration =
    streaming ||
    (typeof completedAt === 'number' &&
      Number.isFinite(completedAt) &&
      elapsedMs >= 1000)
  const label = streaming
    ? t('turn.processing', { time })
    : isInterrupted
      ? hasDuration && time
        ? t('turn.interrupted', { time, defaultValue: `Interrupted, ran for ${time}` })
        : t('turn.interruptedBare', { defaultValue: 'Interrupted' })
      : hasDuration
        ? t('turn.completed', { time })
        : t('turn.completedBare')
  const clickable = !streaming && Boolean(onToggle)

  return (
    <div className={cn('mb-4', className)} data-testid="turn-header">
      {clickable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={label}
          onClick={onToggle}
          className={cn(
            'text-[12px] text-[var(--text-muted)]',
            'hover:text-[var(--text-secondary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
          )}
        >
          {label}
        </button>
      ) : (
        <div className="text-[12px] text-[var(--text-muted)]">{label}</div>
      )}
      <div className="mt-2 border-t border-[var(--border-subtle)]" />
    </div>
  )
})
