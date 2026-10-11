import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import {
    ArrowRight,
    Pencil,
    X,
    cn,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    useAskStore,
    defaultAskController,
} from '../shared/askStore.js'
import type { AskOption, AskRequest } from '../shared/types.js'

export interface AskOverlayProps {
    sessionId?: string
    className?: string
}

const ASK_CUSTOM_INPUT_LINE_HEIGHT_PX = 20
const ASK_CUSTOM_INPUT_MAX_LINES = 5

function syncAskCustomInputHeight(element: HTMLTextAreaElement): void {
    const computed = window.getComputedStyle(element)
    const parsedLineHeight = Number.parseFloat(computed.lineHeight)
    const lineHeight = Number.isFinite(parsedLineHeight) && parsedLineHeight > 0
        ? parsedLineHeight
        : ASK_CUSTOM_INPUT_LINE_HEIGHT_PX
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0
    const borderTop = Number.parseFloat(computed.borderTopWidth) || 0
    const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0
    const maxHeight = lineHeight * ASK_CUSTOM_INPUT_MAX_LINES + paddingTop + paddingBottom + borderTop + borderBottom

    element.style.height = 'auto'
    const nextHeight = Math.min(Math.max(element.scrollHeight, lineHeight), maxHeight)
    element.style.height = `${nextHeight}px`
    element.style.overflowX = 'hidden'
    element.style.overflowY = element.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden'
}

export function AskOverlay({ sessionId: propSessionId, className }: AskOverlayProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const currentSessionId = services?.sessions?.getCurrentSessionId?.() ?? ''
    const effectiveSessionId = propSessionId || currentSessionId || ''

    const request: AskRequest | undefined = useAskStore(
        useCallback(
            (state) => (effectiveSessionId ? state.requestsBySession[effectiveSessionId] : undefined),
            [effectiveSessionId]
        )
    )

    const [isCustomActive, setIsCustomActive] = useState(false)
    const [customText, setCustomText] = useState('')
    const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const [now, setNow] = useState(Date.now)
    const countdownDeadline = request?.countdownDeadline

    useEffect(() => {
        if (countdownDeadline === undefined) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [countdownDeadline])

    const cancelCountdown = useCallback(() => {
        if (!request || !effectiveSessionId) return
        useAskStore.getState().cancelCountdown(effectiveSessionId, request.toolCallId)
    }, [request, effectiveSessionId])

    const activateCustom = () => {
        cancelCountdown()
        setIsCustomActive(true)
    }

    // Reset local state whenever request changes
    useEffect(() => {
        setIsCustomActive(false)
        setCustomText('')
        setSelectedIndex(null)
    }, [request?.id])

    // Focus input when custom mode is activated
    useEffect(() => {
        if (isCustomActive) {
            inputRef.current?.focus()
        }
    }, [isCustomActive])

    useLayoutEffect(() => {
        const element = inputRef.current
        if (!isCustomActive || !element) return

        let lastWidth = -1
        const measure = () => {
            syncAskCustomInputHeight(element)
            lastWidth = element.clientWidth
        }
        measure()

        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(() => {
            if (element.clientWidth === lastWidth) return
            measure()
        })
        observer.observe(element)
        return () => observer.disconnect()
    }, [isCustomActive, customText])

    const handleSelectOption = useCallback(
        (option: AskOption, index: number) => {
            if (!request || !effectiveSessionId) return
            defaultAskController.submitAnswer(effectiveSessionId, request.toolCallId, {
                type: 'selected',
                option,
                index,
            })
            useAskStore.getState().setRequest(effectiveSessionId, null)
        },
        [request, effectiveSessionId]
    )

    const handleCustomSubmit = useCallback(
        (e?: React.FormEvent) => {
            e?.preventDefault()
            if (!request || !effectiveSessionId) return
            const trimmed = customText.trim()
            if (!trimmed) return
            defaultAskController.submitAnswer(effectiveSessionId, request.toolCallId, {
                type: 'custom',
                text: trimmed,
            })
            useAskStore.getState().setRequest(effectiveSessionId, null)
        },
        [request, effectiveSessionId, customText]
    )

    const handleSkip = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation()
            if (!request || !effectiveSessionId) return
            defaultAskController.submitAnswer(effectiveSessionId, request.toolCallId, {
                type: 'skipped',
            })
            useAskStore.getState().setRequest(effectiveSessionId, null)
        },
        [request, effectiveSessionId]
    )

    const handleCancel = useCallback(() => {
        if (!request || !effectiveSessionId) return
        defaultAskController.cancel(effectiveSessionId, request.toolCallId)
        useAskStore.getState().setRequest(effectiveSessionId, null)
    }, [request, effectiveSessionId])

    // Keyboard shortcuts: 1-9 to select options when not typing in input
    useEffect(() => {
        if (!request || isCustomActive) return

        const handleKeyDown = (e: KeyboardEvent) => {
            // Ignore if event target is an input / textarea / contenteditable
            const target = e.target as HTMLElement | null
            if (
                target?.tagName === 'INPUT' ||
                target?.tagName === 'TEXTAREA' ||
                target?.isContentEditable
            ) {
                return
            }

            if (e.key === 'Escape') {
                e.preventDefault()
                handleCancel()
                return
            }

            const num = parseInt(e.key, 10)
            if (!isNaN(num) && num >= 1 && num <= request.options.length) {
                const opt = request.options[num - 1]
                if (opt) {
                    e.preventDefault()
                    handleSelectOption(opt, num - 1)
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [request, isCustomActive, handleCancel, handleSelectOption])

    if (!request) {
        return null
    }

    const defaultCustomPrompt =
        request.customPrompt ||
        t('ask.customPromptDefault', {
            defaultValue: 'No, and tell CPA what to do differently',
        })

    const skipLabel = t('ask.skip', { defaultValue: 'Skip' })
    const remainingSeconds = Math.max(0, Math.ceil(((countdownDeadline ?? now) - now) / 1000))
    const countdownTime = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`

    return (
        <div
            data-testid="ask-overlay-container"
            onKeyDownCapture={cancelCountdown}
            className={cn(
                'w-[min(768px,calc(100vw-3rem))] max-w-3xl select-none',
                'rounded-[var(--radius-composer,20px)] border border-[var(--border-composer,#333333)] bg-[#1e1e1e] p-4 sm:p-5',
                'shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-md',
                'transition-all duration-200 animate-in fade-in zoom-in-95',
                className
            )}
        >
            {/* Header: Question and Close button */}
            <div className="flex items-start justify-between gap-3">
                <div
                    data-testid="ask-question-text"
                    className="text-[15px] sm:text-base font-medium text-neutral-100 leading-snug break-words flex-1"
                >
                    {request.question}
                </div>
                <button
                    type="button"
                    data-testid="ask-close-button"
                    aria-label={t('ask.close', { defaultValue: 'Close' })}
                    onClick={handleCancel}
                    className={cn(
                        'rounded-lg p-1 text-neutral-400 transition-colors',
                        'hover:bg-neutral-800 hover:text-neutral-200',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
                    )}
                >
                    <X className="size-4.5 shrink-0" aria-hidden />
                </button>
            </div>

            {countdownDeadline !== undefined ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span data-testid="ask-countdown">
                        {t('ask.countdown', {
                            time: countdownTime,
                            defaultValue: 'Auto-selecting the recommended option in {{time}}',
                        })}
                    </span>
                    <button
                        type="button"
                        data-testid="ask-cancel-countdown-button"
                        onClick={cancelCountdown}
                        className="rounded-full border border-[var(--border-subtle)] px-2 py-1 hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--text-muted)]"
                    >
                        {t('ask.cancelCountdown', { defaultValue: 'Cancel countdown' })}
                    </button>
                </div>
            ) : null}

            {/* Options List */}
            <div className="mt-3.5 flex flex-col gap-1.5" data-testid="ask-options-list">
                {request.options.map((option, index) => {
                    const isSelected = selectedIndex === index
                    return (
                        <button
                            key={`${index}-${option.title}`}
                            type="button"
                            data-testid={`ask-option-${index + 1}`}
                            onClick={() => handleSelectOption(option, index)}
                            onMouseEnter={() => setSelectedIndex(index)}
                            onMouseLeave={() => setSelectedIndex(null)}
                            className={cn(
                                'group flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-all duration-150 cursor-pointer',
                                isSelected
                                    ? 'bg-[#2a2a2a] text-neutral-100'
                                    : 'bg-transparent text-neutral-200 hover:bg-[#282828]'
                            )}
                        >
                            <div className="flex items-start gap-3 min-w-0 flex-1 pr-2">
                                {/* Number Badge */}
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#333333] text-xs font-semibold text-neutral-300 mt-0.5">
                                    {index + 1}
                                </span>
                                {/* Title and Description */}
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-[13.5px] sm:text-sm font-medium text-neutral-100 leading-tight truncate">
                                        {option.title}
                                        {option.recommended ? (
                                            <span
                                                data-testid="ask-option-recommended-badge"
                                                className="ml-2 inline-block rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-xs font-[inherit] text-[var(--text-secondary)]"
                                            >
                                                {t('ask.recommended', { defaultValue: 'Recommended' })}
                                            </span>
                                        ) : null}
                                    </span>
                                    {option.description ? (
                                        <span className="mt-1 text-[12px] sm:text-[12.5px] text-neutral-400 leading-relaxed break-words">
                                            {option.description}
                                        </span>
                                    ) : null}
                                </div>
                            </div>

                            {/* Arrow icon on hover / selected */}
                            <div className="flex items-center shrink-0 pl-1">
                                {isSelected ? (
                                    <ArrowRight
                                        className="size-4 text-neutral-400 transition-transform group-hover:translate-x-0.5"
                                        aria-hidden
                                    />
                                ) : (
                                    <span className="size-4" />
                                )}
                            </div>
                        </button>
                    )
                })}

                {/* Custom input or freeform row */}
                {request.allowCustom ? (
                    isCustomActive ? (
                        /* Active custom input mode */
                        <form
                            onSubmit={handleCustomSubmit}
                            data-testid="ask-custom-active-container"
                            className={cn(
                                'mt-1 flex w-full items-end gap-2.5 rounded-2xl border border-blue-500/80 bg-[#141414] px-3.5 py-2',
                                'ring-1 ring-blue-500/40 shadow-inner transition-all'
                            )}
                        >
                            <div className="flex size-6 shrink-0 items-center justify-center self-start rounded-full bg-[#2a2a2a] text-neutral-300">
                                <Pencil className="size-3" aria-hidden />
                            </div>
                            <textarea
                                ref={inputRef}
                                rows={1}
                                wrap="soft"
                                data-testid="ask-custom-input"
                                value={customText}
                                onChange={(e) => {
                                    cancelCountdown()
                                    setCustomText(e.target.value)
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        if (customText.trim().length === 0) {
                                            setIsCustomActive(false)
                                        }
                                        return
                                    }
                                    const nativeKeyCode = 'keyCode' in e.nativeEvent ? e.nativeEvent.keyCode : 0
                                    const isImeEnter = e.nativeEvent.isComposing || nativeKeyCode === 229
                                    if (e.key === 'Enter' && !e.shiftKey && !isImeEnter) {
                                        e.preventDefault()
                                        handleCustomSubmit()
                                    }
                                }}
                                placeholder={t('ask.inputPlaceholder', {
                                    defaultValue: 'Enter answer...',
                                })}
                                className="min-h-5 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent py-0.5 text-sm leading-5 text-neutral-100 placeholder-neutral-500 outline-none select-text [overflow-wrap:anywhere]"
                            />
                            {request.allowSkip ? (
                                <button
                                    type="button"
                                    data-testid="ask-custom-skip-button"
                                    onClick={handleSkip}
                                    className="mb-0.5 shrink-0 self-end rounded-full bg-[#2e2e2e] px-3 py-1 text-xs font-medium text-neutral-300 hover:bg-[#3d3d3d] transition-colors cursor-pointer"
                                >
                                    {skipLabel}
                                </button>
                            ) : null}
                        </form>
                    ) : (
                        /* Inactive custom prompt mode */
                        <div
                            role="button"
                            tabIndex={0}
                            data-testid="ask-custom-inactive-row"
                            onClick={activateCustom}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    activateCustom()
                                }
                            }}
                            className={cn(
                                'mt-1 flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left transition-all duration-150 cursor-pointer',
                                'bg-transparent text-neutral-300 hover:bg-[#282828]'
                            )}
                        >
                            <div className="flex items-center gap-3 min-w-0 flex-1 pr-2">
                                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#333333] text-neutral-300">
                                    <Pencil className="size-3.5" aria-hidden />
                                </span>
                                <span className="text-[13px] sm:text-sm text-neutral-300 truncate">
                                    {defaultCustomPrompt}
                                </span>
                            </div>

                            {request.allowSkip ? (
                                <button
                                    type="button"
                                    data-testid="ask-inactive-skip-button"
                                    onClick={handleSkip}
                                    className="shrink-0 rounded-full bg-[#333333] px-3 py-1 text-xs font-medium text-neutral-300 hover:bg-[#444444] transition-colors cursor-pointer"
                                >
                                    {skipLabel}
                                </button>
                            ) : null}
                        </div>
                    )
                ) : null}
            </div>
        </div>
    )
}
