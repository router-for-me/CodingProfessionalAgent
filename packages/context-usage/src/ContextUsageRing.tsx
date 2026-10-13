import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
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
    computeSessionTotalUsageBreakdown,
    DEFAULT_COMPACTION_THRESHOLD_PERCENT,
    DEFAULT_CONTEXT_WINDOW,
} from './tokenEstimate.js'

const EMPTY_ENTRIES: readonly any[] = []

function formatCacheRate(cacheReadTokens: number, totalTokens: number): string {
    if (totalTokens <= 0 || cacheReadTokens <= 0) {
        return '0.00%'
    }
    return `${((cacheReadTokens / totalTokens) * 100).toFixed(2)}%`
}

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
    onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void
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
    onClick,
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
    const isAllEnabled = currentSettings?.modelSettings?.enableAll !== false
    const customConfig = !isAllEnabled && matchedModel?.id
        ? currentSettings?.modelSettings?.models?.[matchedModel.id]
        : undefined
    const overrideContextWindow =
        typeof customConfig?.contextWindow === 'number' &&
        Number.isFinite(customConfig.contextWindow) &&
        customConfig.contextWindow > 0
            ? Math.floor(customConfig.contextWindow)
            : undefined
    const contextWindow = overrideContextWindow ?? matchedModel?.contextWindow ?? DEFAULT_CONTEXT_WINDOW

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

    const contextBreakdown = computeContextUsageBreakdown(
        entries,
        contextWindow,
        compactionThresholdPercent,
    )
    const totalBreakdown = computeSessionTotalUsageBreakdown(
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

    const estimatedHeight =
        300 +
        (contextBreakdown.cacheReadTokens > 0 ? 48 : 0) +
        (contextBreakdown.cacheWriteTokens > 0 ? 24 : 0) +
        (totalBreakdown.cacheReadTokens > 0 ? 48 : 0) +
        (totalBreakdown.cacheWriteTokens > 0 ? 24 : 0)

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        const rect = trigger.getBoundingClientRect()
        const POPUP_WIDTH = 290
        const margin = 8
        const gap = 8

        const measuredHeight =
            popoverRef.current?.offsetHeight ||
            popoverRef.current?.getBoundingClientRect().height ||
            0
        const popupHeight = measuredHeight > 0 ? measuredHeight : estimatedHeight

        let left = Math.round(rect.left + rect.width / 2 - POPUP_WIDTH / 2)
        left = Math.max(margin, Math.min(left, window.innerWidth - POPUP_WIDTH - margin))

        const placeAbove = rect.top >= popupHeight + margin + gap

        const next = placeAbove
            ? { left, bottom: Math.round(window.innerHeight - rect.top + gap) }
            : { left, top: Math.round(rect.bottom + gap) }

        setPosition((prev) => {
            if (
                prev.left === next.left &&
                prev.top === next.top &&
                prev.bottom === next.bottom
            ) {
                return prev
            }
            return next
        })
    }, [estimatedHeight])

    useLayoutEffect(() => {
        if (!open) return
        updatePosition()
    }, [open, updatePosition])

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
                    percent: contextBreakdown.percentLabel,
                    defaultValue: `Context: ${contextBreakdown.percentLabel} used`,
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
                    setOpen(false)
                    onClick?.(e)
                }}
            >
                <UsageRing
                    size={size}
                    strokeWidth={strokeWidth}
                    percent={contextBreakdown.percentUsed}
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
                              'fixed z-50 w-[290px] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3.5 shadow-2xl',
                              'text-[var(--text-primary)] backdrop-blur-md',
                          )}
                          style={{
                              left: `${position.left}px`,
                              ...(position.top !== undefined ? { top: `${position.top}px` } : {}),
                              ...(position.bottom !== undefined ? { bottom: `${position.bottom}px` } : {}),
                          }}
                          onMouseEnter={handleOpen}
                          onMouseLeave={handleClose}
                          onFocus={handleOpen}
                          onClick={(e) => e.stopPropagation()}
                      >
                          <div className="flex items-center gap-3">
                              <UsageRing
                                  size={32}
                                  strokeWidth={3.5}
                                  percent={contextBreakdown.percentUsed}
                              />
                              <span className="text-[13px] font-medium text-[var(--text-primary)]">
                                  {t('contextUsage.used', {
                                      percent: contextBreakdown.percentLabel,
                                      defaultValue: `Context: ${contextBreakdown.percentLabel} used`,
                                  })}
                              </span>
                          </div>

                          <div className="mt-2.5 mb-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sidebar-hover)]">
                              <div
                                  className="h-full rounded-full bg-[var(--accent-blue)] transition-all duration-300"
                                  style={{
                                      width: `${Math.min(100, Math.max(0, contextBreakdown.percentUsed))}%`,
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
                                      {contextBreakdown.totalTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                                      <span>{t('contextUsage.inputTokens', { defaultValue: 'Input tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {contextBreakdown.inputTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-blue-400" />
                                      <span>{t('contextUsage.outputTokens', { defaultValue: 'Output tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {contextBreakdown.outputTokens.toLocaleString()}
                                  </span>
                              </div>

                              {contextBreakdown.cacheReadTokens > 0 && (
                                  <>
                                      <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                          <div className="flex items-center gap-2">
                                              <span className="size-2 shrink-0 rounded-full bg-cyan-400" />
                                              <span>{t('contextUsage.cacheReadTokens', { defaultValue: 'Cache read tokens' })}</span>
                                          </div>
                                          <span className="font-mono text-[var(--text-primary)]">
                                              {contextBreakdown.cacheReadTokens.toLocaleString()}
                                          </span>
                                      </div>

                                      <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                          <div className="flex items-center gap-2">
                                              <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
                                              <span>{t('contextUsage.cacheRate', { defaultValue: 'Cache rate' })}</span>
                                          </div>
                                          <span className="font-mono text-[var(--text-primary)]">
                                              {formatCacheRate(contextBreakdown.cacheReadTokens, contextBreakdown.totalTokens)}
                                          </span>
                                      </div>
                                  </>
                              )}

                              {contextBreakdown.cacheWriteTokens > 0 && (
                                  <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                      <div className="flex items-center gap-2">
                                          <span className="size-2 shrink-0 rounded-full bg-purple-400" />
                                          <span>{t('contextUsage.cacheWriteTokens', { defaultValue: 'Cache creation tokens' })}</span>
                                      </div>
                                      <span className="font-mono text-[var(--text-primary)]">
                                          {contextBreakdown.cacheWriteTokens.toLocaleString()}
                                      </span>
                                  </div>
                              )}

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-amber-400" />
                                      <span>{t('contextUsage.compactionWindow', { defaultValue: 'Compaction window' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {contextBreakdown.compactionWindow.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-zinc-500" />
                                      <span>{t('contextUsage.contextWindow', { defaultValue: 'Context window' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {contextBreakdown.contextWindow.toLocaleString()}
                                  </span>
                              </div>

                              <div
                                  data-testid="context-usage-total-divider"
                                  className="my-1.5 border-t border-[var(--border-subtle)]"
                              />

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-zinc-200" />
                                      <span>{t('contextUsage.sessionTotalTokens', { defaultValue: 'Session total tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {totalBreakdown.totalTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                                      <span>{t('contextUsage.sessionInputTokens', { defaultValue: 'Session input tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {totalBreakdown.inputTokens.toLocaleString()}
                                  </span>
                              </div>

                              <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                  <div className="flex items-center gap-2">
                                      <span className="size-2 shrink-0 rounded-full bg-blue-400" />
                                      <span>{t('contextUsage.sessionOutputTokens', { defaultValue: 'Session output tokens' })}</span>
                                  </div>
                                  <span className="font-mono text-[var(--text-primary)]">
                                      {totalBreakdown.outputTokens.toLocaleString()}
                                  </span>
                              </div>

                              {totalBreakdown.cacheReadTokens > 0 && (
                                  <>
                                      <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                          <div className="flex items-center gap-2">
                                              <span className="size-2 shrink-0 rounded-full bg-cyan-400" />
                                              <span>{t('contextUsage.sessionCacheReadTokens', { defaultValue: 'Session cache read tokens' })}</span>
                                          </div>
                                          <span className="font-mono text-[var(--text-primary)]">
                                              {totalBreakdown.cacheReadTokens.toLocaleString()}
                                          </span>
                                      </div>

                                      <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                          <div className="flex items-center gap-2">
                                              <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
                                              <span>{t('contextUsage.sessionCacheRate', { defaultValue: 'Session cache rate' })}</span>
                                          </div>
                                          <span className="font-mono text-[var(--text-primary)]">
                                              {formatCacheRate(totalBreakdown.cacheReadTokens, totalBreakdown.totalTokens)}
                                          </span>
                                      </div>
                                  </>
                              )}

                              {totalBreakdown.cacheWriteTokens > 0 && (
                                  <div className="flex items-center justify-between text-[var(--text-secondary)]">
                                      <div className="flex items-center gap-2">
                                          <span className="size-2 shrink-0 rounded-full bg-purple-400" />
                                          <span>{t('contextUsage.sessionCacheWriteTokens', { defaultValue: 'Session cache creation tokens' })}</span>
                                      </div>
                                      <span className="font-mono text-[var(--text-primary)]">
                                          {totalBreakdown.cacheWriteTokens.toLocaleString()}
                                      </span>
                                  </div>
                              )}
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    )
}
