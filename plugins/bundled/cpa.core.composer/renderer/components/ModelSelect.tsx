import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    ChevronDown,
    cn,
    useActiveRun,
    useHostServices,
    useSessions,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import type { ModelCatalogEntry, ModelReasoningOption, Speed } from '@cpa/plugin-api'
import { AdvancedMenu, type ActiveSubmenu } from './AdvancedMenu.js'
import { ModelMenu } from './ModelMenu.js'
import {
    getDefaultReasoningLevel,
    getReasoningOptions,
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
    const reactId = useId()
    const idSuffix = sanitizeAriaId(reactId)
    const modelMenuId = `model-menu-${idSuffix}`
    const triggerDescriptionId = `model-trigger-desc-${idSuffix}`

    const services = useHostServices()
    const settings = useSettings()
    const selectedModelId = settings.modelId
    const selectedReasoningLevel = settings.reasoningLevel ?? 'off'
    const selectedSpeed = settings.speed ?? 'standard'
    const modelSettings = settings.modelSettings

    const currentSessions = useSessions()
    const sessionRuntimeSettings = sessionId
        ? currentSessions.find((session: any) => session.id === sessionId)
        : undefined

    const modelId = sessionRuntimeSettings?.modelId ?? selectedModelId
    const reasoningLevel =
        (sessionRuntimeSettings?.reasoningEffort as ModelReasoningOption['id'] | undefined) ??
        selectedReasoningLevel
    const speed = (sessionRuntimeSettings?.speed as Speed | undefined) ?? selectedSpeed

    const setModelId = (id: string) => services?.settings?.setModelId?.(id)
    const setReasoningLevel = (level: string) => services?.settings?.setReasoningLevel?.(level)
    const setSpeed = (spd: Speed) => services?.settings?.setSpeed?.(spd)
    const setSessionRuntimeSettings = (
        sId: string,
        opts: { modelId?: string; reasoningEffort?: string; speed?: Speed },
    ) => services?.sessions?.setSessionRuntimeSettings?.(sId, opts)

    const rawCatalogModels = (services?.models?.getModels?.() ?? []) as ModelCatalogEntry[]
    const catalogStatus = services?.models?.getStatus?.() ?? 'ready'
    const catalogError = services?.models?.getError?.() ?? null

    const [open, setOpen] = useState(false)
    const [view, setView] = useState<'quick' | 'advanced'>('quick')
    const [activeSubmenu, setActiveSubmenu] = useState<ActiveSubmenu>(null)
    const [compactWidth, setCompactWidth] = useState<number | undefined>(undefined)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const measureRef = useRef<HTMLSpanElement>(null)

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        setMenuPosition(computeModelMenuPosition(trigger.getBoundingClientRect()))
    }, [])

    useLayoutEffect(() => {
        if (!open) return
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
    }, [open, updatePosition])

    const activeRun = useActiveRun(sessionId ?? undefined)
    const isRemoteRunning = Boolean(sessionId && activeRun && activeRun.status !== 'idle')
    const isSessionRunning = Boolean(isRunning || isRemoteRunning)

    const filteredCatalogModels = useMemo(
        () => filterCatalogModels(rawCatalogModels, modelSettings),
        [rawCatalogModels, modelSettings],
    )
    const catalogModels =
        filteredCatalogModels.length > 0 ? filteredCatalogModels : rawCatalogModels
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

    const reasoningOptions = current ? getReasoningOptions(current) : []
    const speedOptions = current ? getSpeedOptions(current.supportsFast) : []
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
        catalogStatus as any,
        rawCatalogModels.length,
        catalogError,
    )

    useEffect(() => {
        if (catalogModels.length === 0 || disabled) return

        if (!matchedModel) {
            const firstModel = catalogModels[0]
            const defaultReasoning = getDefaultReasoningLevel(firstModel)
            const defaultSpeed =
                firstModel.supportsFast && speed === 'fast' ? 'fast' : 'standard'
            setModelId(firstModel.id)
            setReasoningLevel(defaultReasoning)
            setSpeed(defaultSpeed)
            if (sessionId) {
                setSessionRuntimeSettings(sessionId, {
                    modelId: firstModel.id,
                    reasoningEffort: defaultReasoning,
                    speed: defaultSpeed,
                })
            }
            return
        }

        const normalized = normalizeModelPreferences(matchedModel, reasoningLevel, speed)
        let changed = false
        if (normalized.reasoningLevel !== reasoningLevel) {
            setReasoningLevel(normalized.reasoningLevel)
            changed = true
        }
        if (normalized.speed !== speed) {
            setSpeed(normalized.speed)
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
        catalogModels,
        matchedModel,
        modelId,
        reasoningLevel,
        speed,
        sessionId,
        disabled,
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
    }, [currentModelLabel, currentReasoningLabel])

    useEffect(() => {
        if (disabled && !isSessionRunning) setOpen(false)
    }, [disabled, isSessionRunning])

    useEffect(() => {
        if (isSessionRunning && view === 'advanced') {
            setView('quick')
            setActiveSubmenu(null)
        }
    }, [isSessionRunning, view])

    useEffect(() => {
        if (!open) {
            setView('quick')
            setActiveSubmenu(null)
        }
    }, [open])

    useEffect(() => {
        if (!open) return
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
    }, [open])

    const handleModelChange = (nextModelId: string) => {
        const nextModel =
            catalogModels.find((model) => model.id === nextModelId) ?? current
        if (!nextModel) return
        const normalized = normalizeModelPreferences(
            nextModel,
            reasoningLevel,
            speed,
        )
        setModelId(nextModelId)
        setReasoningLevel(normalized.reasoningLevel)
        setSpeed(normalized.speed)
        if (sessionId) {
            setSessionRuntimeSettings(sessionId, {
                modelId: nextModelId,
                reasoningEffort: normalized.reasoningLevel,
                speed: normalized.speed,
            })
        }
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
        setSpeed(nextSpeed)
        if (sessionId) {
            setSessionRuntimeSettings(sessionId, {
                modelId: matchedModel?.id ?? modelId,
                reasoningEffort: reasoningLevel,
                speed: nextSpeed,
            })
        }
    }

    return (
        <div ref={rootRef} className={cn('relative w-max shrink-0', className)}>
            <button
                ref={triggerRef}
                type="button"
                disabled={isTriggerDisabled}
                style={{ width: open ? `${MODEL_MENU_WIDTH_PX}px` : compactWidth ? `${compactWidth}px` : undefined }}
                className={cn(
                    'inline-flex w-max items-center justify-center gap-1 rounded-full px-[10px] py-1.5 text-[12px]',
                    'text-[var(--text-secondary)] transition-[width,background-color,color] duration-200 ease-out',
                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                    open && 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                    'disabled:pointer-events-none disabled:opacity-50',
                )}
                aria-label={t('composer.model', { defaultValue: 'Model' })}
                aria-describedby={triggerDescriptionId}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? modelMenuId : undefined}
                onClick={() => {
                    if (isTriggerDisabled) return
                    if (!open && triggerRef.current) {
                        setMenuPosition(
                            computeModelMenuPosition(
                                triggerRef.current.getBoundingClientRect(),
                            ),
                        )
                    }
                    setOpen((prev) => !prev)
                }}
            >
                <span className="truncate">{currentModelLabel}</span>
                {currentReasoningLabel ? (
                    <span className="shrink-0">{currentReasoningLabel}</span>
                ) : null}
                <span id={triggerDescriptionId} className="sr-only">
                    {currentModelLabel} {currentReasoningLabel}
                </span>
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
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
                <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden />
            </span>

            {open && current && typeof document !== 'undefined'
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
                                  catalogNotice={catalogNotice}
                                  disabled={disabled}
                              />
                          )}
                      </div>,
                      document.body,
                  )
                : null}
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
    status: 'idle' | 'loading' | 'ready' | 'error',
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
