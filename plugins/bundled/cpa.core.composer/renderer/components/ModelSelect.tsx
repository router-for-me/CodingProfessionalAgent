import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    ChevronDown,
    Zap,
    cn,
    useActiveRun,
    useHostServices,
    useModelCatalog,
    useSessions,
    useSettings,
    useTranslation,
    useUiState,
    useWorkspaceVisible,
} from '@cpa/plugin-ui'
import type { ModelReasoningOption, Speed } from '@cpa/plugin-api'
import { AdvancedMenu, type ActiveSubmenu } from './AdvancedMenu.js'
import { Gemini4PeriodicTablePicker } from './Gemini4PeriodicTablePicker.js'
import { ModelMenu } from './ModelMenu.js'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import { isGemini4Model, isGemini4PeriodicTableEnabled } from '../utils/gemini4PeriodicTable.js'
import {
    commitModelSelection,
    filterReasoningOptionsBySettings,
    getDefaultReasoningLevel,
    getSpeedOptions,
    MODEL_MENU_WIDTH_PX,
    normalizeModelPreferences,
    filterCatalogModels,
} from '../utils/modelMenuOptions.js'
import { sanitizeAriaId } from './SlashMenu.js'

export interface ModelSelectProps {
    className?: string
    disabled?: boolean
    sessionId?: string | null
    isRunning?: boolean
}

export function ModelSelect({
    className,
    disabled = false,
    sessionId,
    isRunning = false,
}: ModelSelectProps) {
    const { t } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const reactId = useId()
    const idSuffix = sanitizeAriaId(reactId)
    const modelMenuId = `model-menu-${idSuffix}`
    const periodicPickerId = `gemini4-periodic-picker-${idSuffix}`
    const triggerDescriptionId = `model-trigger-desc-${idSuffix}`

    const services = useHostServices()
    const settings = useSettings()
    const selectedModelId = settings.modelId
    const selectedReasoningLevel = settings.reasoningLevel ?? 'off'
    const selectedSpeed = settings.speed ?? 'standard'
    const modelSettings = settings.modelSettings

    const currentSessions = useSessions()
    const uiState = useUiState()
    const hasSharedUiState = uiState !== null && uiState !== undefined
    const uiPendingSpeed = hasSharedUiState
        ? (uiState?.pendingSessionContext?.speed as Speed | undefined)
        : undefined
    const [pendingSpeed, setPendingSpeed] = useState<Speed | undefined>(
        () => services?.ui?.getPendingSessionContext?.().speed,
    )
    const activePendingSpeed = !sessionId
        ? hasSharedUiState
            ? uiPendingSpeed
            : pendingSpeed
        : undefined
    const sessionRuntimeSettings = sessionId
        ? currentSessions.find((session: any) => session.id === sessionId)
        : undefined

    const modelId = sessionRuntimeSettings?.modelId ?? selectedModelId
    const reasoningLevel =
        (sessionRuntimeSettings?.reasoningEffort as ModelReasoningOption['id'] | undefined) ??
        selectedReasoningLevel
    const speed =
        (sessionRuntimeSettings?.speed as Speed | undefined) ??
        activePendingSpeed ??
        selectedSpeed

    const setReasoningLevel = (level: string) => services?.settings?.setReasoningLevel?.(level)
    const setSessionRuntimeSettings = (
        sId: string,
        opts: { modelId?: string; reasoningEffort?: string; speed?: Speed },
    ) => services?.sessions?.setSessionRuntimeSettings?.(sId, opts)

    const {
        models: rawCatalogModels,
        status: catalogStatus,
        error: catalogError,
    } = useModelCatalog()

    const [open, setOpen] = useState(false)
    const [gemini4PickerOpen, setGemini4PickerOpen] = useState(false)
    const [view, setView] = useState<'quick' | 'advanced'>('quick')
    const [activeSubmenu, setActiveSubmenu] = useState<ActiveSubmenu>(null)
    const [compactWidth, setCompactWidth] = useState<number | undefined>(undefined)
    const [isFolding, setIsFolding] = useState(false)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const measureRef = useRef<HTMLSpanElement>(null)
    const prevOpenRef = useRef(open)
    const wasOpenLayoutRef = useRef(open)
    const isClosing = (prevOpenRef.current && !open) || isFolding

    useLayoutEffect(() => {
        const wasOpen = wasOpenLayoutRef.current
        wasOpenLayoutRef.current = open
        if (!wasOpen && open && triggerRef.current) {
            const trigger = triggerRef.current
            const startWidth =
                compactWidth ??
                Math.ceil(measureRef.current?.getBoundingClientRect().width ?? 0)
            if (startWidth > 0 && !isFolding) {
                trigger.style.transition = 'none'
                trigger.style.width = `${startWidth}px`
                void trigger.offsetWidth
                trigger.style.transition = ''
                trigger.style.width = `${MODEL_MENU_WIDTH_PX}px`
            }
        }
    }, [open, compactWidth, isFolding])

    useEffect(() => {
        if (prevOpenRef.current && !open) {
            setIsFolding(true)
            prevOpenRef.current = open
            const timer = setTimeout(() => {
                setIsFolding(false)
            }, 220)
            return () => clearTimeout(timer)
        }
        if (open) {
            setIsFolding(false)
        }
        prevOpenRef.current = open
    }, [open])

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        setMenuPosition(computeModelMenuPosition(trigger.getBoundingClientRect()))
    }, [])

    useLayoutEffect(() => {
        if (!open || !workspaceVisible) return
        updatePosition()

        let rafId: number | null = null
        const startTime = performance.now()
        const duration = 250

        const tick = () => {
            updatePosition()
            if (performance.now() - startTime < duration) {
                rafId = requestAnimationFrame(tick)
            } else {
                rafId = null
                updatePosition()
            }
        }
        rafId = requestAnimationFrame(tick)

        const handleReposition = () => updatePosition()
        window.addEventListener('resize', handleReposition)
        window.addEventListener('scroll', handleReposition, true)
        return () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId)
            }
            window.removeEventListener('resize', handleReposition)
            window.removeEventListener('scroll', handleReposition, true)
        }
    }, [open, workspaceVisible, updatePosition])

    const activeRun = useActiveRun(sessionId ?? undefined)
    const isRemoteRunning = Boolean(sessionId && activeRun && activeRun.status !== 'idle')
    const isSessionRunning = Boolean(isRunning || isRemoteRunning)

    const catalogModels = useMemo(
        () => filterCatalogModels(rawCatalogModels, modelSettings),
        [rawCatalogModels, modelSettings],
    )
    const isTriggerDisabled =
        (!isSessionRunning && disabled) || catalogModels.length === 0
    const matchedModel = (
        disabled && !isSessionRunning ? rawCatalogModels : catalogModels
    ).find((model) => model.id === modelId)
    const current =
        matchedModel ?? (disabled && !isSessionRunning ? undefined : catalogModels[0])
    const currentModelLabel =
        disabled && !isSessionRunning
            ? matchedModel?.label ?? modelId
            : matchedModel?.label ??
              catalogModels[0]?.label ??
              (modelId || t('composer.modelCatalog.noModels', { defaultValue: 'No models available' }))

    const reasoningOptions = current ? filterReasoningOptionsBySettings(current, modelSettings) : []
    const speedOptions = current ? getSpeedOptions(current.supportsFast) : []
    const isFastEnabled = Boolean(current?.supportsFast && speed !== 'standard')
    const currentReasoning = reasoningOptions.find(
        (option) => option.id === reasoningLevel,
    )
    const currentReasoningLabel = currentReasoning
        ? getReasoningLabel(t, currentReasoning)
        : current && reasoningOptions.length > 0
            ? t('composer.modelCatalog.unavailable', { defaultValue: 'Unsupported' })
            : ''

    const catalogNotice = getCatalogNotice(
        t,
        catalogStatus,
        rawCatalogModels.length,
        catalogError,
    )

    useEffect(() => {
        if ((catalogStatus !== 'ready' && catalogStatus !== 'success') ||
            catalogError || catalogModels.length === 0 || disabled) return

        if (!matchedModel) {
            const firstModel = catalogModels[0]
            commitModelSelection({
                model: firstModel,
                requestedReasoningLevel: getDefaultReasoningLevel(firstModel),
                currentSpeed: speed,
                modelSettings,
                sessionId,
                services,
                onPendingSpeedChange: setPendingSpeed,
            })
            return
        }

        const normalized = normalizeModelPreferences(
            matchedModel,
            reasoningLevel,
            speed,
            modelSettings,
        )
        let changed = false
        if (normalized.reasoningLevel !== reasoningLevel) {
            setReasoningLevel(normalized.reasoningLevel)
            changed = true
        }
        if (normalized.speed !== speed) {
            if (!sessionId) {
                setPendingSpeed(normalized.speed)
                const pendingContext = services?.ui?.getPendingSessionContext?.()
                services?.ui?.setPendingSessionContext?.({
                    ...pendingContext,
                    speed: normalized.speed,
                })
            }
            changed = true
        }
        if (changed && sessionId) {
            setSessionRuntimeSettings(sessionId, {
                modelId: matchedModel.id,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
    }, [
        catalogStatus,
        catalogError,
        catalogModels,
        matchedModel,
        modelId,
        reasoningLevel,
        speed,
        modelSettings,
        sessionId,
        disabled,
        activePendingSpeed,
        services,
    ])

    useLayoutEffect(() => {
        const el = measureRef.current
        if (!el) return
        const updateWidth = () => {
            const measured = Math.ceil(el.getBoundingClientRect().width)
            if (measured > 0) {
                setCompactWidth(measured)
            }
        }
        updateWidth()
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver(updateWidth)
            observer.observe(el)
            return () => observer.disconnect()
        }
    }, [currentModelLabel, currentReasoningLabel, isFastEnabled])

    useEffect(() => {
        if (!sessionId) {
            setPendingSpeed(services?.ui?.getPendingSessionContext?.()?.speed)
        }
    }, [sessionId, services])

    useEffect(() => {
        if (disabled && !isSessionRunning) {
            setOpen(false)
            setGemini4PickerOpen(false)
        }
    }, [disabled, isSessionRunning])

    useEffect(() => {
        if (isSessionRunning) {
            setGemini4PickerOpen(false)
            if (view === 'advanced') {
                setView('quick')
                setActiveSubmenu(null)
            }
        }
    }, [isSessionRunning, view])

    useEffect(() => {
        if (!open) {
            setView('quick')
            setActiveSubmenu(null)
        }
    }, [open])

    useEffect(() => {
        if (!open || !workspaceVisible) return
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target
            const clickedPortal =
                target instanceof Element &&
                target.closest('[data-model-menu-portal]') !== null
            if (!rootRef.current?.contains(target as Node) && !clickedPortal) {
                setOpen(false)
            }
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open, workspaceVisible])

    const gemini4GroupingEnabled = useMemo(
        () =>
            isGemini4PeriodicTableEnabled(modelSettings) &&
            catalogModels.some(isGemini4Model),
        [modelSettings, catalogModels],
    )

    useEffect(() => {
        if (gemini4PickerOpen && !gemini4GroupingEnabled) {
            setGemini4PickerOpen(false)
        }
    }, [gemini4PickerOpen, gemini4GroupingEnabled])

    useEffect(() => {
        const visibleOpen = gemini4PickerOpen && workspaceVisible
        rendererEventBus.emit('composer:periodic-picker-visibility', {
            open: visibleOpen,
            source: 'model-select',
        })
        return () => {
            if (visibleOpen) {
                rendererEventBus.emit('composer:periodic-picker-visibility', {
                    open: false,
                    source: 'model-select',
                })
            }
        }
    }, [gemini4PickerOpen, workspaceVisible])

    useEffect(() => {
        const unsub = rendererEventBus.on(
            'composer:model-picker-opened',
            (payload: any) => {
                if (payload?.source !== 'model-select') {
                    setOpen(false)
                    setGemini4PickerOpen(false)
                }
            },
        )
        return () => {
            unsub()
        }
    }, [])

    const handleModelChange = (nextModelId: string) => {
        const nextModel =
            catalogModels.find((model) => model.id === nextModelId) ?? current
        if (!nextModel) return
        commitModelSelection({
            model: nextModel,
            requestedReasoningLevel: reasoningLevel,
            currentSpeed: speed,
            modelSettings,
            sessionId,
            services,
            onPendingSpeedChange: setPendingSpeed,
        })
    }

    const handleReasoningLevelChange = (nextReasoningLevel: string) => {
        setReasoningLevel(nextReasoningLevel)
        if (sessionId) {
            setSessionRuntimeSettings(sessionId, {
                modelId: matchedModel?.id ?? modelId,
                reasoningEffort: nextReasoningLevel,
                speed,
            })
        }
    }

    const handleSpeedChange = (nextSpeed: Speed) => {
        if (sessionId) {
            setSessionRuntimeSettings(sessionId, {
                modelId: matchedModel?.id ?? modelId,
                reasoningEffort: reasoningLevel,
                speed: nextSpeed,
            })
            return
        }

        setPendingSpeed(nextSpeed)
        const pendingContext = services?.ui?.getPendingSessionContext?.()
        services?.ui?.setPendingSessionContext?.({
            ...pendingContext,
            speed: nextSpeed,
        })
    }

    return (
        <div ref={rootRef} className={cn('relative w-max shrink-0', className)}>
            <button
                ref={triggerRef}
                type="button"
                disabled={isTriggerDisabled}
                style={{
                    width: open
                        ? `${MODEL_MENU_WIDTH_PX}px`
                        : isClosing && compactWidth
                            ? `${compactWidth}px`
                            : undefined,
                }}
                className={cn(
                    'inline-flex w-max items-center justify-center gap-1 rounded-full px-[10px] py-1.5 font-[inherit] text-[12px]',
                    'text-[var(--text-secondary)] transition-[width,background-color,color] duration-200 ease-out',
                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                    (open || gemini4PickerOpen) && 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    'disabled:pointer-events-none disabled:opacity-50',
                )}
                aria-label={t('composer.model', { defaultValue: 'Model' })}
                aria-describedby={triggerDescriptionId}
                aria-haspopup={gemini4PickerOpen ? 'dialog' : 'menu'}
                aria-expanded={(open || gemini4PickerOpen) && workspaceVisible}
                aria-controls={
                    gemini4PickerOpen && workspaceVisible
                        ? periodicPickerId
                        : open && workspaceVisible
                            ? modelMenuId
                            : undefined
                }
                onClick={() => {
                    if (isTriggerDisabled) return
                    if (gemini4PickerOpen) {
                        setGemini4PickerOpen(false)
                        return
                    }
                    const nextOpen = !open
                    if (nextOpen && triggerRef.current) {
                        const rect = triggerRef.current.getBoundingClientRect()
                        const startWidth = compactWidth ?? Math.ceil(rect.width)
                        if (startWidth > 0 && !isFolding) {
                            triggerRef.current.style.width = `${startWidth}px`
                            void triggerRef.current.offsetWidth
                        }
                        setMenuPosition(computeModelMenuPosition(rect))
                        rendererEventBus.emit('composer:model-picker-opened', { source: 'model-select' })
                    }
                    setOpen(nextOpen)
                }}
            >
                <span className="truncate">{currentModelLabel}</span>
                {currentReasoningLabel ? (
                    <span className="shrink-0">{currentReasoningLabel}</span>
                ) : null}
                {isFastEnabled ? (
                    <Zap className="size-3 translate-y-px shrink-0 text-[var(--accent-blue)]" aria-hidden />
                ) : null}
                <span id={triggerDescriptionId} className="sr-only">
                    {currentModelLabel} {currentReasoningLabel}
                    {isFastEnabled ? ` ${t('composer.speed.fast', { defaultValue: 'Fast' })}` : ''}
                </span>
                <ChevronDown
                    className={cn(
                        'size-3 shrink-0 opacity-70 transition-transform duration-200 ease-out',
                        open && 'rotate-180',
                    )}
                    aria-hidden
                />
            </button>

            {/* Hidden element for measuring natural compact width */}
            <span
                ref={measureRef}
                aria-hidden="true"
                className="pointer-events-none invisible absolute left-0 top-0 -z-50 inline-flex w-max items-center justify-center gap-1 rounded-full px-[10px] py-1.5 text-[12px]"
            >
                <span className="truncate">{currentModelLabel}</span>
                {currentReasoningLabel ? (
                    <span className="shrink-0">{currentReasoningLabel}</span>
                ) : null}
                {isFastEnabled ? (
                    <Zap className="size-3 translate-y-px shrink-0 text-[var(--accent-blue)]" aria-hidden />
                ) : null}
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
            </span>

            {open && workspaceVisible && current && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          data-model-menu-portal
                          className="fixed z-[70]"
                          style={{
                              bottom: `${
                                  (
                                      menuPosition ??
                                      (triggerRef.current
                                          ? computeModelMenuPosition(
                                                triggerRef.current.getBoundingClientRect(),
                                            )
                                          : { bottom: 8, right: 8 })
                                  ).bottom
                              }px`,
                              right: `${
                                  (
                                      menuPosition ??
                                      (triggerRef.current
                                          ? computeModelMenuPosition(
                                                triggerRef.current.getBoundingClientRect(),
                                            )
                                          : { bottom: 8, right: 8 })
                                  ).right
                              }px`,
                              width: `${MODEL_MENU_WIDTH_PX}px`,
                          }}
                      >
                          {view === 'quick' || isSessionRunning ? (
                              <ModelMenu
                                  id={modelMenuId}
                                  reasoningOptions={reasoningOptions}
                                  supportsFast={current.supportsFast}
                                  reasoningLevel={reasoningLevel}
                                  speed={speed}
                                  onReasoningLevelChange={handleReasoningLevelChange}
                                  onSpeedChange={handleSpeedChange}
                                  catalogNotice={catalogNotice}
                                  onOpenAdvanced={() => {
                                      if (isSessionRunning) return
                                      setView('advanced')
                                      setActiveSubmenu(null)
                                  }}
                                  allowModelChange={!isSessionRunning}
                                  disabled={!isSessionRunning && disabled}
                              />
                          ) : (
                              <AdvancedMenu
                                  id={modelMenuId}
                                  models={catalogModels}
                                  modelId={modelId}
                                  supportsFast={current.supportsFast}
                                  reasoningOptions={reasoningOptions}
                                  speedOptions={speedOptions}
                                  reasoningLevel={reasoningLevel}
                                  speed={speed}
                                  activeSubmenu={activeSubmenu}
                                  onModelChange={handleModelChange}
                                  onReasoningLevelChange={handleReasoningLevelChange}
                                  onSpeedChange={handleSpeedChange}
                                  onSubmenuChange={setActiveSubmenu}
                                  onBackToQuick={() => {
                                      setView('quick')
                                      setActiveSubmenu(null)
                                  }}
                                  enableGemini4Grouping={gemini4GroupingEnabled}
                                  onOpenGemini4Group={() => {
                                      if (disabled || isSessionRunning) return
                                      setActiveSubmenu(null)
                                      setOpen(false)
                                      setGemini4PickerOpen(true)
                                      rendererEventBus.emit('composer:model-picker-opened', { source: 'model-select' })
                                  }}
                                  catalogNotice={catalogNotice}
                                  disabled={disabled}
                              />
                          )}
                      </div>,
                      document.body,
                  )
                : null}

            {gemini4PickerOpen && workspaceVisible && !isSessionRunning ? (
                <Gemini4PeriodicTablePicker
                    id={periodicPickerId}
                    models={catalogModels}
                    currentModelId={modelId}
                    currentReasoningLevel={reasoningLevel}
                    modelSettings={modelSettings}
                    anchorElement={
                        (triggerRef.current?.closest('[data-element="composer-container"]') as HTMLElement | null) ??
                        triggerRef.current
                    }
                    ignoreOutsideClickElement={triggerRef.current}
                    preferredPlacement="above"
                    closeOnOutsideClick
                    disabled={disabled}
                    onSelect={({ model, reasoningLevel: nextReasoning }) => {
                        commitModelSelection({
                            model,
                            requestedReasoningLevel: nextReasoning,
                            currentSpeed: speed,
                            modelSettings,
                            sessionId,
                            services,
                            onPendingSpeedChange: setPendingSpeed,
                        })
                        setGemini4PickerOpen(false)
                        setOpen(false)
                    }}
                    onClose={() => setGemini4PickerOpen(false)}
                />
            ) : null}
        </div>
    )
}

interface MenuPosition {
    bottom: number
    right: number
}

function computeModelMenuPosition(triggerRect: DOMRect): MenuPosition {
    const spaceRight = window.innerWidth - triggerRect.right
    const maxRight = Math.max(8, window.innerWidth - MODEL_MENU_WIDTH_PX - 8)
    const right = Math.min(Math.max(8, spaceRight), maxRight)
    const bottom = Math.max(8, window.innerHeight - triggerRect.top + 8)
    return { bottom, right }
}

function getReasoningLabel(
    translate: (key: string, options?: { defaultValue?: string }) => string,
    option: ModelReasoningOption,
): string {
    const defaultLabels: Record<string, string> = {
        off: 'Off',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Very High',
        'extra-high': 'Very High',
        max: 'Max',
        auto: 'Auto',
        default: 'Default',
    }
    const defaultLabel = defaultLabels[option.id] ?? (option as any).fallbackLabel ?? option.id
    if (!option.labelKey) return defaultLabel
    return translate(option.labelKey, {
        defaultValue: defaultLabel,
    })
}

function getCatalogNotice(
    translate: (key: string, options?: { defaultValue?: string }) => string,
    status: 'idle' | 'loading' | 'ready' | 'success' | 'error',
    modelCount: number,
    error: string | null,
): string | undefined {
    if (status === 'loading')
        return translate('composer.modelCatalog.loading', { defaultValue: 'Loading models...' })
    if (status === 'error' && error)
        return translate('composer.modelCatalog.error', { defaultValue: error })
    if (modelCount === 0)
        return translate('composer.modelCatalog.noModels', { defaultValue: 'No models available' })
    return undefined
}
