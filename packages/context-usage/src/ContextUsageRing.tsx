import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import {
    cn,
    useHostServices,
    useSettings,
    useTranslation,
    UsageRing,
    type AppSettings,
} from '@cpa/plugin-ui'
import {
    computeContextUsageBreakdown,
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    DEFAULT_CONTEXT_WINDOW,
} from './tokenEstimate.js'

const EMPTY_ENTRIES: readonly any[] = []

export interface ContextUsageRingProps {
    sessionId?: string
    modelId?: string
    agent?: { id?: string; sessionId?: string; modelId?: string }
    size?: number
    strokeWidth?: number
    className?: string
    testId?: string
    disabled?: boolean
    isRunning?: boolean
    forceShow?: boolean
}

export function ContextUsageRing(props: ContextUsageRingProps): ReactElement | null {
    const settings = useSettings()
    const showContextUsage = props.forceShow ?? settings?.editor?.showContextUsage ?? true

    if (!showContextUsage) {
        return null
    }

    return <ContextUsageRingInner {...props} settings={settings} />
}

interface ContextUsageRingInnerProps extends ContextUsageRingProps {
    settings?: AppSettings
}

function ContextUsageRingInner({
    sessionId,
    modelId,
    agent,
    size = 16,
    strokeWidth = 2,
    className,
    testId = 'context-usage-ring',
    settings,
}: ContextUsageRingInnerProps): ReactElement {
    const { t } = useTranslation()
    const tooltipId = useId()
    const services = useHostServices()

    const currentSessions = services?.sessions?.getSnapshot?.() ?? EMPTY_ENTRIES
    const activeSessionId = services?.sessions?.getCurrentSessionId?.() ?? null
    const currentSettings = services?.settings?.getSnapshot?.() ?? settings
    const activeModelId = settings?.modelId ?? currentSettings?.modelId
    const compactionThresholdPercent =
        settings?.compactionThresholdPercent ??
        currentSettings?.compactionThresholdPercent ??
        DEFAULT_COMPACTION_THRESHOLD_PERCENT
    const catalogModels = services?.models?.getModels?.() ?? []

    const targetSessionId =
        agent?.sessionId ||
        agent?.id ||
        (sessionId !== undefined ? (sessionId || null) : activeSessionId)
    const targetSession = targetSessionId
        ? currentSessions.find((session: any) => session.id === targetSessionId)
        : undefined
    const targetModelId = agent?.modelId || modelId || targetSession?.modelId || activeModelId

    const matchedModel = catalogModels.find((m: any) => m.id === targetModelId) ?? catalogModels[0]
    const contextWindow = matchedModel?.contextWindow || DEFAULT_CONTEXT_WINDOW

    const [entries, setEntries] = useState<readonly any[]>(() => {
        if (!targetSessionId || !services?.chatMessages) return EMPTY_ENTRIES
        return services.chatMessages.getEntries(targetSessionId)
    })

    useEffect(() => {
        if (targetSessionId && services?.chatMessages?.ensureSessionLoaded) {
            void services.chatMessages.ensureSessionLoaded(targetSessionId)
        }
    }, [targetSessionId, services?.chatMessages])

    useEffect(() => {
        if (!targetSessionId || !services?.chatMessages) {
            setEntries(EMPTY_ENTRIES)
            return
        }
        const update = () => {
            if (!services?.chatMessages) return
            const current = services.chatMessages.getEntries(targetSessionId)
            setEntries(current)
        }
        update()
        if (services.chatMessages.subscribeMessages) {
            return services.chatMessages.subscribeMessages(targetSessionId, update)
        }
    }, [targetSessionId, services?.chatMessages])

    const breakdown = computeContextUsageBreakdown(
        entries,
        contextWindow,
        compactionThresholdPercent,
    )

    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<{
        left: number
        top?: number
        bottom?: number
    }>({
        left: 0,
        bottom: 0,
    })

    const triggerRef = useRef<HTMLSpanElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hoveredRef = useRef(false)

    const cancelClose = useCallback(() => {
        if (closeTimerRef.current !== null) {
            clearTimeout(closeTimerRef.current)
            closeTimerRef.current = null
        }
    }, [])

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        const rect = trigger.getBoundingClientRect()
        const POPUP_WIDTH = 260
        const ESTIMATED_HEIGHT = 220
        const margin = 8

        let left = Math.round(rect.left + rect.width / 2 - POPUP_WIDTH / 2)
        left = Math.max(margin, Math.min(left, window.innerWidth - POPUP_WIDTH - margin))

        const placeAbove = rect.top >= ESTIMATED_HEIGHT + margin + 8

        if (placeAbove) {
            const bottom = Math.round(window.innerHeight - rect.top + 8)
            setPosition({ left, bottom })
        } else {
            const top = Math.round(rect.bottom + 8)
            setPosition({ left, top })
        }
    }, [])

    const handleOpen = useCallback(() => {
        cancelClose()
        hoveredRef.current = true
        updatePosition()
        setOpen(true)
    }, [cancelClose, updatePosition])

    const handleClose = useCallback(() => {
        cancelClose()
        hoveredRef.current = false
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null
            if (!hoveredRef.current) {
                setOpen(false)
            }
        }, 120)
    }, [cancelClose])

    useEffect(() => {
        if (!open) return
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                hoveredRef.current = false
                setOpen(false)
            }
        }
        const handleReposition = () => {
            updatePosition()
        }
        window.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleReposition)
        window.addEventListener('scroll', handleReposition, true)
        return () => {
            window.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleReposition)
            window.removeEventListener('scroll', handleReposition, true)
        }
    }, [open, updatePosition])

    useEffect(() => {
        return () => {
            cancelClose()
        }
    }, [cancelClose])

    return (
        <>
            <span
                ref={triggerRef}
                data-testid={testId}
                role="button"
                tabIndex={0}
                aria-describedby={open ? tooltipId : undefined}
                aria-label={t('contextUsage.used', {
                    percent: breakdown.percentLabel,
                    defaultValue: `Context: ${breakdown.percentLabel} used`,
                })}
                className={cn(
                    'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full p-0.5',
                    'text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/50',
                    className,
                )}
                onMouseEnter={handleOpen}
                onMouseLeave={handleClose}
                onFocus={handleOpen}
                onBlur={handleClose}
                onClick={(e) => {
                    e.stopPropagation()
                }}
            >
                <UsageRing
                    size={size}
                    strokeWidth={strokeWidth}
                    percent={breakdown.percentUsed}
                    testId="usage-ring"
                />
            </span>

            {open && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={popoverRef}
                          id={tooltipId}
                          role="tooltip"
                          aria-label={t('contextUsage.tooltipLabel', {
                              defaultValue: 'Context usage details',
                          })}
                          data-testid="context-usage-popover"
                          className={cn(
                              'fixed z-50 w-[260px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3.5 shadow-2xl',
                              'text-[var(--text-primary)] backdrop-blur-md',
                          )}
                          style={{
                              left: `${position.left}px`,
                              ...(position.top !== undefined ? { top: `${position.top}px` } : {}),
                              ...(position.bottom !== undefined ? { bottom: `${position.bottom}px` } : {}),
                          }}
                          onMouseEnter={handleOpen}
                          onMouseLeave={handleClose}
                          onClick={(e) => e.stopPropagation()}
                      >
                          <div className="flex items-center gap-3">
                              <UsageRing
                                  size={32}
                                  strokeWidth={3.5}
                                  percent={breakdown.percentUsed}
                              />
                              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                                  {t('contextUsage.used', {
                                      percent: breakdown.percentLabel,
                                      defaultValue: `Context: ${breakdown.percentLabel} used`,
                                  })}
                              </span>
                          </div>

                          <div className="mt-2.5 mb-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sidebar-hover)]">
                              <div
                                  className="h-full rounded-full bg-[var(--accent-blue)] transition-all duration-300"
                                  style={{
                                      width: `${Math.min(100, Math.max(0, breakdown.percentUsed))}%`,
                                  }}
                              />
                          </div>

                          <div className="flex flex-col gap-1.5 text-[12px]">
                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-zinc-200" />
                                      <span>{t('contextUsage.totalTokens', { defaultValue: 'Total tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {breakdown.totalTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                                      <span>{t('contextUsage.inputTokens', { defaultValue: 'Input tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {breakdown.inputTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-blue-400" />
                                      <span>{t('contextUsage.outputTokens', { defaultValue: 'Output tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {breakdown.outputTokens.toLocaleString()}
                                  </span>
                              </div>

                              {breakdown.cacheReadTokens > 0 && (
                                  <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                      <div className="flex items-center gap-2">
                                          <span className="size-2 shrink-0 rounded-full bg-cyan-400" />
                                          <span>{t('contextUsage.cacheReadTokens', { defaultValue: 'Cache read tokens' })}</span>
                                      </div>
                                      <span className="font-mono text-[var(--text-primary)]">
                                          {breakdown.cacheReadTokens.toLocaleString()}
                                      </span>
                                  </div>
                              )}

                              {breakdown.cacheWriteTokens > 0 && (
                                  <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                      <div className="flex items-center gap-2">
                                          <span className="size-2 shrink-0 rounded-full bg-purple-400" />
                                          <span>{t('contextUsage.cacheWriteTokens', { defaultValue: 'Cache creation tokens' })}</span>
                                      </div>
                                      <span className="font-mono text-[var(--text-primary)]">
                                          {breakdown.cacheWriteTokens.toLocaleString()}
                                      </span>
                                  </div>
                              )}

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-amber-400" />
                                      <span>{t('contextUsage.compactionWindow', { defaultValue: 'Compaction window' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {breakdown.compactionWindow.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-zinc-500" />
                                      <span>{t('contextUsage.contextWindow', { defaultValue: 'Context window' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {breakdown.contextWindow.toLocaleString()}
                                  </span>
                              </div>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    )
}
