import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Sparkles, X, cn, useTranslation, useWorkspaceVisible } from '@cpa/plugin-ui'
import type { ModelCatalogEntry, ModelReasoningOption, ModelSettingsConfig } from '@cpa/plugin-api'
import {
    PERIODIC_ELEMENTS,
    PERIODIC_SERIES_PLACEHOLDERS,
    extractGemini4VariantLabel,
    filterModelReasoningOptions,
    groupGemini4Models,
    type PeriodicElementDefinition,
} from '../utils/gemini4PeriodicTable.js'

export interface Gemini4PeriodicTablePickerProps {
    models: readonly ModelCatalogEntry[]
    currentModelId: string
    currentReasoningLevel: string
    modelSettings?: ModelSettingsConfig
    anchorElement?: HTMLElement | null
    ignoreOutsideClickElement?: HTMLElement | null
    preferredPlacement?: 'above' | 'below'
    onSelect: (selection: { model: ModelCatalogEntry; reasoningLevel: string }) => void
    onClose: () => void
    id?: string
    disabled?: boolean
    closeOnOutsideClick?: boolean
}

type InspectedTarget =
    | { kind: 'element'; elementNumber: number }
    | { kind: 'other'; modelId: string }

interface FloatingPosition {
    left: number
    top?: number
    bottom?: number
    maxWidth: number
    maxHeight: number
}

const VIEWPORT_GUTTER = 8
const TARGET_PANEL_WIDTH = 760

const DEFAULT_REASONING_LABELS: Record<string, string> = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    'extra-high': 'Extra high',
    max: 'Max',
    auto: 'Auto',
    default: 'Default',
}

function getReasoningOptionLabel(
    translate: (key: string, options?: { defaultValue?: string }) => string,
    option: ModelReasoningOption,
): string {
    const fallback = DEFAULT_REASONING_LABELS[option.id] ?? option.fallbackLabel ?? option.id
    if (!option.labelKey) return fallback
    return translate(option.labelKey, { defaultValue: fallback })
}

function resolveHorizontalAnchorElement(
    anchorElement: HTMLElement | null | undefined,
): HTMLElement | null {
    // Keep the periodic table horizontally centered in the conversation pane across all triggers
    if (anchorElement && typeof anchorElement.closest === 'function') {
        const workspaceContainer = anchorElement.closest(
            '[data-testid="workspace-content-container"]',
        ) as HTMLElement | null
        if (workspaceContainer && workspaceContainer.getBoundingClientRect().width > 0) {
            return workspaceContainer
        }
        const composerContainer = anchorElement.closest(
            '[data-element="composer-container"]',
        ) as HTMLElement | null
        if (composerContainer && composerContainer.getBoundingClientRect().width > 0) {
            return composerContainer
        }
        return anchorElement
    }
    if (typeof document !== 'undefined') {
        const workspaceContainer = document.querySelector(
            '[data-testid="workspace-content-container"]',
        ) as HTMLElement | null
        if (workspaceContainer && workspaceContainer.getBoundingClientRect().width > 0) {
            return workspaceContainer
        }
    }
    return anchorElement ?? null
}

function computeFloatingPosition(
    anchorElement: HTMLElement | null | undefined,
    preferredPlacement: 'above' | 'below',
): FloatingPosition {
    const viewportWidth =
        (typeof window !== 'undefined' ? window.innerWidth : 0) ||
        (typeof document !== 'undefined' ? document.documentElement.clientWidth : 0) ||
        1024
    const viewportHeight =
        (typeof window !== 'undefined' ? window.innerHeight : 0) ||
        (typeof document !== 'undefined' ? document.documentElement.clientHeight : 0) ||
        768

    const availableWidth = Math.max(0, viewportWidth - VIEWPORT_GUTTER * 2)
    const maxWidth = availableWidth
    const panelWidth = Math.min(TARGET_PANEL_WIDTH, maxWidth)
    const availableHeight = Math.max(0, viewportHeight - VIEWPORT_GUTTER * 2)

    const horizontalTarget = resolveHorizontalAnchorElement(anchorElement)
    const horizontalRect =
        horizontalTarget && typeof horizontalTarget.getBoundingClientRect === 'function'
            ? horizontalTarget.getBoundingClientRect()
            : null
    const centeredLeft =
        horizontalRect && horizontalRect.width > 0
            ? horizontalRect.left + horizontalRect.width / 2 - panelWidth / 2
            : (viewportWidth - panelWidth) / 2
    const maxLeft = Math.max(VIEWPORT_GUTTER, viewportWidth - VIEWPORT_GUTTER - panelWidth)
    const left = Math.min(Math.max(VIEWPORT_GUTTER, Math.round(centeredLeft)), maxLeft)

    if (!anchorElement || typeof anchorElement.getBoundingClientRect !== 'function') {
        return {
            left,
            bottom: Math.min(VIEWPORT_GUTTER + 56, Math.max(VIEWPORT_GUTTER, viewportHeight - VIEWPORT_GUTTER)),
            maxWidth,
            maxHeight: availableHeight,
        }
    }

    const rect = anchorElement.getBoundingClientRect()
    const spaceAbove = Math.max(0, rect.top - VIEWPORT_GUTTER * 2)
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - VIEWPORT_GUTTER * 2)

    // If neither side of the anchor has meaningful room, expand across the viewport height so controls remain reachable
    if (spaceAbove < 160 && spaceBelow < 160 && availableHeight > Math.max(spaceAbove, spaceBelow)) {
        return {
            left,
            top: VIEWPORT_GUTTER,
            maxWidth,
            maxHeight: availableHeight,
        }
    }

    const placeAbove =
        preferredPlacement === 'above'
            ? spaceAbove >= 300 || spaceAbove >= spaceBelow
            : spaceBelow < 300 && spaceAbove > spaceBelow

    if (placeAbove) {
        const bottom = Math.min(
            Math.max(VIEWPORT_GUTTER, Math.round(viewportHeight - rect.top + VIEWPORT_GUTTER)),
            Math.max(VIEWPORT_GUTTER, viewportHeight - VIEWPORT_GUTTER),
        )
        const computedMaxHeight = Math.round(viewportHeight - bottom - VIEWPORT_GUTTER)
        return {
            left,
            bottom,
            maxWidth,
            maxHeight: Math.max(0, Math.min(availableHeight, computedMaxHeight)),
        }
    }

    const top = Math.min(
        Math.max(VIEWPORT_GUTTER, Math.round(rect.bottom + VIEWPORT_GUTTER)),
        Math.max(VIEWPORT_GUTTER, viewportHeight - VIEWPORT_GUTTER),
    )
    const computedMaxHeight = Math.round(viewportHeight - top - VIEWPORT_GUTTER)
    return {
        left,
        top,
        maxWidth,
        maxHeight: Math.max(0, Math.min(availableHeight, computedMaxHeight)),
    }
}

export function Gemini4PeriodicTablePicker({
    models,
    currentModelId,
    currentReasoningLevel,
    modelSettings,
    anchorElement,
    ignoreOutsideClickElement = null,
    preferredPlacement = 'above',
    onSelect,
    onClose,
    id = 'gemini4-periodic-table-picker',
    disabled = false,
    closeOnOutsideClick = false,
}: Gemini4PeriodicTablePickerProps) {
    const { t, i18n } = useTranslation()
    const workspaceVisible = useWorkspaceVisible()
    const portalRef = useRef<HTMLDivElement>(null)
    const dialogRef = useRef<HTMLDivElement>(null)
    const headerRef = useRef<HTMLDivElement>(null)
    const inspectorRef = useRef<HTMLDivElement>(null)
    const pendingFocusInspectorRef = useRef(false)
    const [inspectorOverflowing, setInspectorOverflowing] = useState(false)

    const grouped = useMemo(() => groupGemini4Models(models), [models])

    const currentElementNumber = useMemo(() => {
        for (const group of grouped.elements) {
            if (group.models.some((m) => m.id === currentModelId)) {
                return group.element.number
            }
        }
        return null
    }, [grouped.elements, currentModelId])

    const initialTarget = useMemo<InspectedTarget | null>(() => {
        if (currentElementNumber !== null) {
            return { kind: 'element', elementNumber: currentElementNumber }
        }
        if (grouped.otherModels.some((m) => m.id === currentModelId)) {
            return { kind: 'other', modelId: currentModelId }
        }
        if (grouped.elements.length > 0) {
            return { kind: 'element', elementNumber: grouped.elements[0]!.element.number }
        }
        if (grouped.otherModels.length > 0) {
            return { kind: 'other', modelId: grouped.otherModels[0]!.id }
        }
        return null
    }, [currentElementNumber, grouped.elements, grouped.otherModels, currentModelId])

    const [inspectedTarget, setInspectedTarget] = useState<InspectedTarget | null>(initialTarget)
    const [lockedTarget, setLockedTarget] = useState<InspectedTarget | null>(null)
    const [selectedVariantByElement, setSelectedVariantByElement] = useState<Record<number, string>>(() => {
        if (currentElementNumber !== null) {
            return { [currentElementNumber]: currentModelId }
        }
        return {}
    })
    const [position, setPosition] = useState<FloatingPosition>(() =>
        computeFloatingPosition(anchorElement, preferredPlacement),
    )

    // Move keyboard focus inside the dialog when opened so Composer draft cannot absorb keystrokes
    useEffect(() => {
        if (!workspaceVisible || disabled) return
        let targetEl: HTMLElement | null = null
        if (initialTarget?.kind === 'element') {
            targetEl = portalRef.current?.querySelector(
                `[data-periodic-element="${initialTarget.elementNumber}"]`,
            ) as HTMLElement | null
        } else if (initialTarget?.kind === 'other') {
            const buttons = portalRef.current?.querySelectorAll('[data-other-model]')
            buttons?.forEach((node) => {
                if (!targetEl && node.getAttribute('data-other-model') === initialTarget.modelId) {
                    targetEl = node as HTMLElement
                }
            })
        }
        if (targetEl) {
            targetEl.focus({ preventScroll: true })
        } else {
            dialogRef.current?.focus({ preventScroll: true })
        }
    }, [workspaceVisible, disabled])

    // Keep inspected and locked targets valid if filtered models update
    useEffect(() => {
        if (lockedTarget) {
            if (lockedTarget.kind === 'element' && !grouped.elementMap.has(lockedTarget.elementNumber)) {
                setLockedTarget(null)
            } else if (lockedTarget.kind === 'other' && !grouped.otherModels.some((m) => m.id === lockedTarget.modelId)) {
                setLockedTarget(null)
            }
        }
        if (!inspectedTarget) {
            if (initialTarget) setInspectedTarget(initialTarget)
            return
        }
        if (inspectedTarget.kind === 'element') {
            if (!grouped.elementMap.has(inspectedTarget.elementNumber)) {
                setInspectedTarget(initialTarget)
            }
        } else if (!grouped.otherModels.some((m) => m.id === inspectedTarget.modelId)) {
            setInspectedTarget(initialTarget)
        }
    }, [inspectedTarget, lockedTarget, grouped.elementMap, grouped.otherModels, initialTarget])

    const updatePosition = useCallback(() => {
        setPosition(computeFloatingPosition(anchorElement, preferredPlacement))
    }, [anchorElement, preferredPlacement])

    useLayoutEffect(() => {
        if (!workspaceVisible) return
        updatePosition()
        window.addEventListener('resize', updatePosition)
        window.addEventListener('scroll', updatePosition, true)
        const observer =
            typeof ResizeObserver !== 'undefined'
                ? new ResizeObserver(updatePosition)
                : null
        if (observer) {
            if (anchorElement) observer.observe(anchorElement)
            const horizontalTarget = resolveHorizontalAnchorElement(anchorElement)
            if (horizontalTarget && horizontalTarget !== anchorElement) {
                observer.observe(horizontalTarget)
            }
        }
        return () => {
            observer?.disconnect()
            window.removeEventListener('resize', updatePosition)
            window.removeEventListener('scroll', updatePosition, true)
        }
    }, [workspaceVisible, updatePosition, anchorElement])

    useEffect(() => {
        if (!workspaceVisible) return
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
            }
        }
        document.addEventListener('keydown', handleKeyDown, true)
        return () => {
            document.removeEventListener('keydown', handleKeyDown, true)
        }
    }, [workspaceVisible, onClose])

    useEffect(() => {
        if (!closeOnOutsideClick || !workspaceVisible) return
        const handlePointerDown = (event: PointerEvent | MouseEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (portalRef.current?.contains(target)) return
            if (ignoreOutsideClickElement?.contains(target)) return
            if (target instanceof Element && target.closest('.cpa-mac-scrollbar')) return
            onClose()
        }
        document.addEventListener('pointerdown', handlePointerDown, true)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true)
        }
    }, [closeOnOutsideClick, workspaceVisible, ignoreOutsideClickElement, onClose])

    const inspectedElementGroup =
        inspectedTarget?.kind === 'element'
            ? grouped.elementMap.get(inspectedTarget.elementNumber) ?? null
            : null

    const inspectedOtherModel =
        inspectedTarget?.kind === 'other'
            ? grouped.otherModels.find((m) => m.id === inspectedTarget.modelId) ?? null
            : null

    const activeVariants = inspectedElementGroup?.models ?? []
    const activeVariantModel: ModelCatalogEntry | null = useMemo(() => {
        if (inspectedElementGroup) {
            const chosenId = selectedVariantByElement[inspectedElementGroup.element.number]
            return (
                activeVariants.find((m) => m.id === chosenId) ??
                activeVariants.find((m) => m.id === currentModelId) ??
                activeVariants[0] ??
                null
            )
        }
        return inspectedOtherModel
    }, [inspectedElementGroup, activeVariants, selectedVariantByElement, currentModelId, inspectedOtherModel])

    const variantDisplayLabels = useMemo(() => {
        if (!inspectedElementGroup) return new Map<string, string>()
        const rawLabels = activeVariants.map((variant) => ({
            id: variant.id,
            raw:
                extractGemini4VariantLabel(variant, inspectedElementGroup.element) ??
                t('composer.gemini4PeriodicTable.defaultVariant', { defaultValue: 'Default' }),
        }))
        const counts = new Map<string, number>()
        for (const item of rawLabels) {
            counts.set(item.raw, (counts.get(item.raw) ?? 0) + 1)
        }
        const map = new Map<string, string>()
        for (const item of rawLabels) {
            map.set(
                item.id,
                (counts.get(item.raw) ?? 0) > 1 ? `${item.raw} (${item.id})` : item.raw,
            )
        }
        return map
    }, [inspectedElementGroup, activeVariants, t])

    const reasoningOptions = useMemo(
        () => filterModelReasoningOptions(activeVariantModel ?? undefined, modelSettings),
        [activeVariantModel, modelSettings],
    )

    const updateOverflowLayout = useCallback(() => {
        const headerHeight = headerRef.current?.getBoundingClientRect().height ?? 0
        const inspectorHeight = inspectorRef.current?.getBoundingClientRect().height ?? 0
        // Keep at least ~120px for the periodic table body when pinned; otherwise let the whole dialog scroll
        const nextOverflow =
            headerHeight + inspectorHeight > 0 &&
            headerHeight + inspectorHeight + 120 > position.maxHeight
        setInspectorOverflowing((prev) => (prev === nextOverflow ? prev : nextOverflow))
    }, [position.maxHeight])

    useLayoutEffect(() => {
        if (!workspaceVisible) return
        updateOverflowLayout()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(updateOverflowLayout)
        if (headerRef.current) observer.observe(headerRef.current)
        if (inspectorRef.current) observer.observe(inspectorRef.current)
        return () => observer.disconnect()
    }, [
        workspaceVisible,
        updateOverflowLayout,
        position.maxWidth,
        activeVariantModel?.id,
        activeVariants.length,
        reasoningOptions.length,
    ])

    const useWholeDialogScroll = position.maxHeight < 360 || inspectorOverflowing

    useEffect(() => {
        if (!pendingFocusInspectorRef.current || !workspaceVisible || disabled) return
        pendingFocusInspectorRef.current = false
        const firstControl = inspectorRef.current?.querySelector(
            'button:not(:disabled)',
        ) as HTMLElement | null
        if (!firstControl) return
        firstControl.focus({ preventScroll: !useWholeDialogScroll })
        if (useWholeDialogScroll && typeof firstControl.scrollIntoView === 'function') {
            firstControl.scrollIntoView({ block: 'nearest' })
        }
    }, [
        inspectedTarget,
        activeVariantModel,
        reasoningOptions.length,
        workspaceVisible,
        disabled,
        useWholeDialogScroll,
    ])

    const activeGridElementNumber =
        inspectedTarget?.kind === 'element' && grouped.elementMap.has(inspectedTarget.elementNumber)
            ? inspectedTarget.elementNumber
            : (grouped.elements[0]?.element.number ?? null)

    const isZhLocale = (i18n?.language ?? '').toLowerCase().startsWith('zh')

    const handleGridKeyDown = (
        event: React.KeyboardEvent<HTMLButtonElement>,
        element: PeriodicElementDefinition,
    ) => {
        if (grouped.elements.length === 0) return
        const ordered = grouped.elements
        const currentIndex = ordered.findIndex((g) => g.element.number === element.number)
        if (currentIndex < 0) return

        let nextIndex = -1
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            nextIndex = (currentIndex + 1) % ordered.length
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            nextIndex = (currentIndex - 1 + ordered.length) % ordered.length
        } else if (event.key === 'Home') {
            nextIndex = 0
        } else if (event.key === 'End') {
            nextIndex = ordered.length - 1
        }
        if (nextIndex >= 0) {
            event.preventDefault()
            const nextEl = ordered[nextIndex]!.element
            const nextTarget: InspectedTarget = { kind: 'element', elementNumber: nextEl.number }
            setLockedTarget(null)
            setInspectedTarget(nextTarget)
            const btn = portalRef.current?.querySelector(
                `[data-periodic-element="${nextEl.number}"]`,
            ) as HTMLElement | null
            btn?.focus()
        }
    }

    if (!workspaceVisible || typeof document === 'undefined') {
        return null
    }

    return createPortal(
        <div
            ref={portalRef}
            data-model-menu-portal
            className="fixed z-[70]"
            style={{
                left: `${position.left}px`,
                top: position.top !== undefined ? `${position.top}px` : undefined,
                bottom: position.bottom !== undefined ? `${position.bottom}px` : undefined,
                width: `${Math.min(TARGET_PANEL_WIDTH, position.maxWidth)}px`,
                maxWidth: `${position.maxWidth}px`,
            }}
        >
            <div
                ref={dialogRef}
                id={id}
                role="dialog"
                tabIndex={-1}
                aria-modal="false"
                aria-label={t('composer.gemini4PeriodicTable.title', {
                    defaultValue: 'Model periodic table',
                })}
                style={{ maxHeight: `${position.maxHeight}px` }}
                className={cn(
                    'flex flex-col rounded-2xl border border-[var(--border-subtle)] outline-none',
                    useWholeDialogScroll ? 'overflow-y-auto' : 'overflow-hidden',
                    'bg-[var(--bg-elevated)]/95 text-[var(--text-primary)] shadow-2xl backdrop-blur-xl',
                    'font-[inherit] select-none',
                )}
            >
                {/* Header */}
                <div
                    ref={headerRef}
                    data-testid="gemini4-periodic-header"
                    className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5"
                >
                    <div className="flex items-center gap-2">
                        <Sparkles className="size-4 shrink-0 text-[var(--accent-blue)]" aria-hidden />
                        <span className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                            {t('composer.gemini4PeriodicTable.title', {
                                defaultValue: 'Model periodic table',
                            })}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('common.close', { defaultValue: 'Close' })}
                        className={cn(
                            'inline-flex size-6 items-center justify-center rounded-md transition-colors cursor-pointer',
                            'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                        )}
                    >
                        <X className="size-3.5" aria-hidden />
                    </button>
                </div>

                {/* Body */}
                <div
                    className={cn(
                        'px-3.5 py-3 space-y-3',
                        useWholeDialogScroll ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto',
                    )}
                >
                    {/* 18-Column Periodic Table Matrix */}
                    <div className="overflow-x-auto pb-1">
                        <div
                            className="relative grid gap-1 min-w-[720px]"
                            style={{
                                gridTemplateColumns: 'repeat(18, minmax(0, 1fr))',
                                gridTemplateRows: 'repeat(9, minmax(32px, auto))',
                            }}
                        >
                            {/* Center Gemini 4 Title & Release Status Legend */}
                            <div
                                style={{ gridColumn: '3 / span 10', gridRow: '2 / span 2' }}
                                className="flex flex-col items-center justify-center px-2 text-center pointer-events-none"
                            >
                                <div className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)] font-[inherit]">
                                    Gemini 4
                                </div>
                                <div className="mt-1 flex flex-wrap items-center justify-center gap-3 text-[11px] text-[var(--text-secondary)]">
                                    <span className="inline-flex items-center gap-1.5">
                                        <span
                                            className="size-1.5 rounded-full bg-[var(--accent-blue)]"
                                            aria-hidden
                                        />
                                        <span>
                                            {t('composer.gemini4PeriodicTable.released', {
                                                count: grouped.releasedCount,
                                                defaultValue: `${grouped.releasedCount} released`,
                                            })}
                                        </span>
                                    </span>
                                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                                        <span
                                            className="size-1.5 rounded-full border border-current opacity-80"
                                            aria-hidden
                                        />
                                        <span>
                                            {t('composer.gemini4PeriodicTable.comingSoon', {
                                                defaultValue: 'Coming soon',
                                            })}
                                        </span>
                                    </span>
                                </div>
                            </div>

                            {/* Series Range Placeholders (Ln under 57-71, An under 89-103) */}
                            {PERIODIC_SERIES_PLACEHOLDERS.map((placeholder) => (
                                <div
                                    key={placeholder.id}
                                    style={{ gridColumn: placeholder.col, gridRow: placeholder.row }}
                                    aria-hidden="true"
                                    className={cn(
                                        'flex h-8 flex-col items-center justify-center overflow-hidden rounded-md border font-[inherit]',
                                        'border-[var(--border-subtle)]/50 bg-[var(--bg-card)]/30 text-[var(--text-muted)]/75',
                                    )}
                                >
                                    <span className="text-[8px] leading-none whitespace-nowrap tracking-tighter tabular-nums opacity-85">
                                        {placeholder.label}
                                    </span>
                                    <span className="mt-0.5 text-[10px] leading-none whitespace-nowrap font-medium">
                                        {placeholder.seriesLabel}
                                    </span>
                                </div>
                            ))}

                            {/* 118 Chemical Elements */}
                            {PERIODIC_ELEMENTS.map((element) => {
                                const group = grouped.elementMap.get(element.number)
                                const isReleased = Boolean(group && group.models.length > 0)
                                const isCurrentElement = currentElementNumber === element.number
                                const isInspected =
                                    inspectedTarget?.kind === 'element' &&
                                    inspectedTarget.elementNumber === element.number

                                const elementDisplayName = isZhLocale
                                    ? `${element.name} (${element.zhName})`
                                    : element.name

                                return (
                                    <button
                                        key={element.number}
                                        type="button"
                                        data-periodic-element={element.number}
                                        data-released={isReleased ? 'true' : 'false'}
                                        disabled={!isReleased || disabled}
                                        tabIndex={
                                            isReleased && !disabled
                                                ? element.number === activeGridElementNumber
                                                    ? 0
                                                    : -1
                                                : undefined
                                        }
                                        aria-disabled={!isReleased || disabled ? 'true' : undefined}
                                        aria-pressed={isReleased ? isInspected : undefined}
                                        style={{ gridColumn: element.col, gridRow: element.row }}
                                        title={
                                            isReleased
                                                ? `${element.number} ${elementDisplayName} — Gemini 4 ${element.name}`
                                                : `${element.number} ${elementDisplayName} (${t('composer.gemini4PeriodicTable.comingSoon', { defaultValue: 'Coming soon' })})`
                                        }
                                        onMouseEnter={() => {
                                            if (!isReleased || disabled || lockedTarget) return
                                            setInspectedTarget({
                                                kind: 'element',
                                                elementNumber: element.number,
                                            })
                                        }}
                                        onFocus={() => {
                                            if (!isReleased || disabled) return
                                            setLockedTarget(null)
                                            setInspectedTarget({
                                                kind: 'element',
                                                elementNumber: element.number,
                                            })
                                        }}
                                        onClick={() => {
                                            if (!isReleased || disabled) return
                                            const nextTarget: InspectedTarget = {
                                                kind: 'element',
                                                elementNumber: element.number,
                                            }
                                            pendingFocusInspectorRef.current = true
                                            setLockedTarget(nextTarget)
                                            setInspectedTarget(nextTarget)
                                        }}
                                        onKeyDown={(event) => {
                                            if (!isReleased) return
                                            handleGridKeyDown(event, element)
                                        }}
                                        className={cn(
                                            'relative flex h-8 flex-col items-center justify-center overflow-hidden rounded-md border px-0.5 transition-all font-[inherit]',
                                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/60',
                                            !isReleased
                                                ? 'border-[var(--border-subtle)]/40 bg-[var(--bg-card)]/35 text-[var(--text-muted)]/55 cursor-not-allowed'
                                                : isInspected
                                                    ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)]/20 text-[var(--text-primary)] ring-1 ring-[var(--accent-blue)]/50 cursor-pointer shadow-xs'
                                                    : isCurrentElement
                                                        ? 'border-[var(--accent-blue)]/70 bg-[var(--accent-blue)]/12 text-[var(--text-primary)] cursor-pointer'
                                                        : 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:border-[var(--accent-blue)]/60 hover:bg-[var(--bg-sidebar-hover)] cursor-pointer',
                                        )}
                                    >
                                        <span className="self-start pl-0.5 text-[8px] leading-none opacity-75">
                                            {element.number}
                                        </span>
                                        <span className="text-[11px] font-medium leading-tight">
                                            {element.symbol}
                                        </span>
                                        {isReleased ? (
                                            <span
                                                className={cn(
                                                    'absolute top-1 right-1 size-1 rounded-full',
                                                    isCurrentElement || isInspected
                                                        ? 'bg-[var(--accent-blue)]'
                                                        : 'bg-[var(--text-secondary)]/70',
                                                )}
                                                aria-hidden
                                            />
                                        ) : null}
                                    </button>
                                )
                            })}
                        </div>
                    </div>

                    {/* Other Unmapped Gemini 4 Models */}
                    {grouped.otherModels.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5">
                            <span className="text-[11px] text-[var(--text-muted)] font-[inherit]">
                                {t('composer.gemini4PeriodicTable.otherModels', {
                                    defaultValue: 'Other models',
                                })}
                            </span>
                            {grouped.otherModels.map((model) => {
                                const isInspectedOther =
                                    inspectedTarget?.kind === 'other' &&
                                    inspectedTarget.modelId === model.id
                                const isCurrent = model.id === currentModelId
                                return (
                                    <button
                                        key={model.id}
                                        type="button"
                                        data-other-model={model.id}
                                        disabled={disabled}
                                        aria-pressed={isInspectedOther}
                                        onMouseEnter={() => {
                                            if (disabled || lockedTarget) return
                                            setInspectedTarget({
                                                kind: 'other',
                                                modelId: model.id,
                                            })
                                        }}
                                        onFocus={() => {
                                            if (disabled || lockedTarget) return
                                            setInspectedTarget({
                                                kind: 'other',
                                                modelId: model.id,
                                            })
                                        }}
                                        onClick={() => {
                                            if (disabled) return
                                            const options = filterModelReasoningOptions(model, modelSettings)
                                            if (options.length === 0) {
                                                onSelect({
                                                    model,
                                                    reasoningLevel: 'off',
                                                })
                                                return
                                            }
                                            const nextTarget: InspectedTarget = {
                                                kind: 'other',
                                                modelId: model.id,
                                            }
                                            pendingFocusInspectorRef.current = true
                                            setLockedTarget(nextTarget)
                                            setInspectedTarget(nextTarget)
                                        }}
                                        className={cn(
                                            'inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] transition-colors cursor-pointer font-[inherit]',
                                            'disabled:pointer-events-none disabled:opacity-50',
                                            isInspectedOther
                                                ? 'border-[var(--accent-blue)] bg-[var(--accent-blue)]/18 text-[var(--text-primary)]'
                                                : isCurrent
                                                    ? 'border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/10 text-[var(--text-primary)]'
                                                    : 'border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                        )}
                                    >
                                        <span>{model.label || model.id}</span>
                                        {isCurrent ? (
                                            <Check className="size-3 text-[var(--accent-blue)]" aria-hidden />
                                        ) : null}
                                    </button>
                                )
                            })}
                        </div>
                    ) : null}
                </div>

                {/* Always-visible Docked Element / Model Detail & Thinking Level Inspector */}
                {activeVariantModel ? (
                    <div
                        ref={inspectorRef}
                        data-testid="gemini4-periodic-inspector"
                        className="relative z-[71] shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3.5 py-2.5"
                    >
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]/90 p-3 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                    {inspectedElementGroup ? (
                                        <div className="flex size-10 shrink-0 flex-col items-center justify-center rounded-lg border border-[var(--accent-blue)]/40 bg-[var(--accent-blue)]/15 text-[var(--text-primary)]">
                                            <span className="text-[9px] leading-none opacity-80">
                                                {inspectedElementGroup.element.number}
                                            </span>
                                            <span className="mt-0.5 text-[14px] font-semibold leading-none">
                                                {inspectedElementGroup.element.symbol}
                                            </span>
                                        </div>
                                    ) : (
                                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)]">
                                            <Sparkles className="size-4 text-[var(--accent-blue)]" aria-hidden />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                                            {activeVariantModel.label || activeVariantModel.id}
                                        </div>
                                        <div className="mt-0.5 truncate text-[11px] text-[var(--text-muted)] font-[inherit]">
                                            {activeVariantModel.description || activeVariantModel.id}
                                        </div>
                                    </div>
                                </div>

                                {/* Thinking Level Selector */}
                                <div className="flex max-w-full flex-col items-start gap-1.5 sm:items-end">
                                    <span className="text-[11px] text-[var(--text-secondary)] font-[inherit]">
                                        {t('composer.gemini4PeriodicTable.thinkingLevel', {
                                            defaultValue: 'Thinking level',
                                        })}
                                    </span>
                                    {reasoningOptions.length > 0 ? (
                                        <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-0.5">
                                            {reasoningOptions.map((option) => {
                                                const isActiveOption =
                                                    activeVariantModel.id === currentModelId &&
                                                    option.id === currentReasoningLevel
                                                const label = getReasoningOptionLabel(t, option)
                                                return (
                                                    <button
                                                        key={option.id}
                                                        type="button"
                                                        disabled={disabled}
                                                        aria-pressed={isActiveOption}
                                                        onClick={() => {
                                                            if (disabled) return
                                                            onSelect({
                                                                model: activeVariantModel,
                                                                reasoningLevel: option.id,
                                                            })
                                                        }}
                                                        className={cn(
                                                            'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer font-[inherit]',
                                                            'disabled:pointer-events-none disabled:opacity-50',
                                                            isActiveOption
                                                                ? 'border-[var(--accent-blue)]/70 bg-[var(--accent-blue)]/20 text-[var(--text-primary)] shadow-xs'
                                                                : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                                        )}
                                                    >
                                                        <span>{label}</span>
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => {
                                                if (disabled) return
                                                onSelect({
                                                    model: activeVariantModel,
                                                    reasoningLevel: 'off',
                                                })
                                            }}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent-blue)]/40',
                                                'bg-[var(--accent-blue)]/15 px-3 py-1 text-[11px] font-medium text-[var(--text-primary)]',
                                                'hover:bg-[var(--accent-blue)]/25 transition-colors cursor-pointer font-[inherit]',
                                                'disabled:pointer-events-none disabled:opacity-50',
                                            )}
                                        >
                                            {activeVariantModel.id === currentModelId ? (
                                                <Check className="size-3 text-[var(--accent-blue)]" aria-hidden />
                                            ) : null}
                                            <span>
                                                {t('composer.gemini4PeriodicTable.selectModel', {
                                                    defaultValue: 'Use this model',
                                                })}
                                            </span>
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Multi-Variant Switcher when multiple catalog models map to the same element */}
                            {inspectedElementGroup && activeVariants.length > 1 ? (
                                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--border-subtle)]/70 pt-2">
                                    <span className="mr-1 text-[11px] text-[var(--text-muted)] font-[inherit]">
                                        {t('composer.gemini4PeriodicTable.variants', {
                                            defaultValue: 'Variant',
                                        })}
                                        :
                                    </span>
                                    {activeVariants.map((variant) => {
                                        const isSelectedVariant = variant.id === activeVariantModel.id
                                        const variantLabel =
                                            variantDisplayLabels.get(variant.id) ??
                                            variant.label ??
                                            variant.id
                                        return (
                                            <button
                                                key={variant.id}
                                                type="button"
                                                aria-pressed={isSelectedVariant}
                                                onClick={() =>
                                                    setSelectedVariantByElement((prev) => ({
                                                        ...prev,
                                                        [inspectedElementGroup.element.number]: variant.id,
                                                    }))
                                                }
                                                className={cn(
                                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition-colors cursor-pointer font-[inherit]',
                                                    isSelectedVariant
                                                        ? 'border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/15 text-[var(--text-primary)]'
                                                        : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                                )}
                                            >
                                                <span>{variantLabel}</span>
                                                {variant.id === currentModelId ? (
                                                    <Check
                                                        className="size-3 text-[var(--accent-blue)]"
                                                        aria-hidden
                                                    />
                                                ) : null}
                                            </button>
                                        )
                                    })}
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>,
        document.body,
    )
}
