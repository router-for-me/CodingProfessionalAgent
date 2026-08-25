import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import {
  useTranslation,
  useHostServices,
  useSubAgents,
  cn,
} from '@cpa/plugin-ui'
import { SubAgentList } from './SubAgentList.js'

const PINNED_SUBAGENT_LIMIT = 5
const ITEM_SCROLL_STEP = 36

export interface PinnedSubAgentsSectionProps {
  sessionId?: string | null
}

/**
 * Collapsible pinned-summary section that lists active sub-agents with
 * avatar, model meta, context usage, and status — matching legacy main UX.
 */
export function PinnedSubAgentsSection({
  sessionId = null,
}: PinnedSubAgentsSectionProps) {
  const { t } = useTranslation()
  const services = useHostServices()
  const agents = useSubAgents(sessionId ?? undefined)
  const [agentsOpen, setAgentsOpen] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const hasOverflow = agents.length > PINNED_SUBAGENT_LIMIT
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(hasOverflow)

  const updateScrollState = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    setCanScrollUp(scrollTop > 1)
    if (scrollHeight > clientHeight && clientHeight > 0) {
      setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1)
    } else {
      setCanScrollDown(hasOverflow)
    }
  }, [hasOverflow])

  useEffect(() => {
    if (agentsOpen) {
      const timer = requestAnimationFrame(updateScrollState)
      return () => cancelAnimationFrame(timer)
    }
  }, [agentsOpen, agents.length, updateScrollState])

  const handleScroll = (direction: 'up' | 'down') => {
    const el = scrollContainerRef.current
    if (!el) return
    const delta = direction === 'up' ? -ITEM_SCROLL_STEP : ITEM_SCROLL_STEP
    if (typeof el.scrollBy === 'function') {
      el.scrollBy({
        top: delta,
        behavior: 'smooth',
      })
    } else {
      el.scrollTop += delta
      updateScrollState()
    }
  }

  if (!sessionId || agents.length === 0) {
    return null
  }

  return (
    <section className="border-t border-[var(--border-subtle)] px-2 py-2">
      <h2 className="mb-1">
        <button
          type="button"
          onClick={() => setAgentsOpen((open) => !open)}
          aria-expanded={agentsOpen}
          aria-controls="pinned-summary-subagents-content"
          className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none"
        >
          <span>{t('pinnedSummary.subagents')}</span>
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
              !agentsOpen && '-rotate-90',
            )}
            aria-hidden
          />
        </button>
      </h2>
      {agentsOpen ? (
        <div id="pinned-summary-subagents-content" className="flex flex-col">
          {hasOverflow ? (
            <button
              type="button"
              onClick={() => handleScroll('up')}
              disabled={!canScrollUp}
              aria-label={t('subagent.scrollUp', 'Scroll up')}
              data-testid="subagent-scroll-up"
              className={cn(
                'flex w-full items-center justify-center py-0.5 mb-0.5 rounded text-[var(--text-muted)] transition-colors',
                canScrollUp
                  ? 'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] cursor-pointer'
                  : 'opacity-25 cursor-not-allowed pointer-events-none',
              )}
            >
              <ChevronUp className="size-3.5" aria-hidden />
            </button>
          ) : null}
          <div
            ref={scrollContainerRef}
            onScroll={updateScrollState}
            className={cn(
              'overflow-y-auto pr-0.5',
              hasOverflow && 'max-h-[180px]',
            )}
          >
            <SubAgentList
              agents={agents}
              onSelect={(agentId) => {
                services?.subAgents?.openTab?.(sessionId, agentId)
                services?.ui?.openRightPanelTab?.('subagent', { activate: true })
                services?.ui?.setRightSidebarCollapsed?.(false)
              }}
            />
          </div>
          {hasOverflow ? (
            <button
              type="button"
              onClick={() => handleScroll('down')}
              disabled={!canScrollDown}
              aria-label={t('subagent.scrollDown', 'Scroll down')}
              data-testid="subagent-scroll-down"
              className={cn(
                'flex w-full items-center justify-center py-0.5 mt-0.5 rounded text-[var(--text-muted)] transition-colors',
                canScrollDown
                  ? 'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] cursor-pointer'
                  : 'opacity-25 cursor-not-allowed pointer-events-none',
              )}
            >
              <ChevronDown className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
