import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ChevronUp, cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelCatalogEntry, ModelReasoningOption, ReasoningLevel, Speed } from '@cpa/plugin-api'
import { FALLBACK_MODEL_CATALOG, type ActiveSubmenu } from '../types.js'
import { ModelOptionsMenu } from './ModelOptionsMenu.js'
import { ReasoningMenu } from './ReasoningMenu.js'
import { SpeedMenu } from './SpeedMenu.js'
import { resolveSubmenuPlacement, type SubmenuPlacement } from '../utils/submenuPlacement.js'
import { getSpeedOptions, type SpeedOption } from '../utils/modelMenuOptions.js'
import { sanitizeAriaId } from './SlashMenu.js'

export { type ActiveSubmenu }

const DEFAULT_REASONING_OPTIONS: readonly ModelReasoningOption[] = []

export interface AdvancedMenuProps {
    models?: readonly ModelCatalogEntry[]
    modelId: string
    supportsFast?: boolean
    reasoningOptions?: readonly ModelReasoningOption[]
    speedOptions?: readonly SpeedOption[]
    reasoningLevel: ReasoningLevel
    speed: Speed
    activeSubmenu: ActiveSubmenu
    onModelChange: (modelId: string) => void
    onReasoningLevelChange: (reasoningLevel: ReasoningLevel) => void
    onSpeedChange: (speed: Speed) => void
    onSubmenuChange: (submenu: ActiveSubmenu) => void
    onBackToQuick: () => void
    catalogNotice?: string
    id?: string
    disabled?: boolean
}

export function AdvancedMenu({
    models = FALLBACK_MODEL_CATALOG,
    modelId,
    supportsFast = false,
    reasoningOptions = DEFAULT_REASONING_OPTIONS,
    speedOptions: providedSpeedOptions,
    reasoningLevel,
    speed,
    activeSubmenu,
    onModelChange,
    onReasoningLevelChange,
    onSpeedChange,
    onSubmenuChange,
    onBackToQuick,
    catalogNotice,
    id = 'composer-advanced-menu',
    disabled = false,
}: AdvancedMenuProps) {
    const { t } = useTranslation()
    const reactId = useId()
    const idSuffix = sanitizeAriaId(reactId)
    const modelTriggerId = `model-submenu-trigger-${idSuffix}`
    const modelSubmenuId = `model-submenu-${idSuffix}`
    const reasoningTriggerId = `reasoning-submenu-trigger-${idSuffix}`
    const reasoningSubmenuId = `reasoning-submenu-${idSuffix}`
    const speedTriggerId = `speed-submenu-trigger-${idSuffix}`
    const speedSubmenuId = `speed-submenu-${idSuffix}`
    const backId = `advanced-back-${idSuffix}`

    const speedOptions = providedSpeedOptions ?? getSpeedOptions(supportsFast)
    const activeVisibleSubmenu =
        activeSubmenu === 'speed' && !supportsFast ? null : activeSubmenu
    const panelRef = useRef<HTMLDivElement>(null)
    const submenuRef = useRef<HTMLDivElement>(null)
    const [submenuPlacement, setSubmenuPlacement] = useState<SubmenuPlacement>({
        side: 'right',
        left: 8,
        top: 8,
        width: 190,
        maxHeight: 0,
    })

    useLayoutEffect(() => {
        if (!activeVisibleSubmenu) return

        const updateSubmenuSide = () => {
            const panel = panelRef.current
            if (!panel) return
            const anchor = panel.getBoundingClientRect()
            const submenuElement = submenuRef.current?.firstElementChild
            const measuredSubmenu = submenuElement?.getBoundingClientRect()
            const submenuScrollHeight =
                submenuElement instanceof HTMLElement ? submenuElement.scrollHeight : 0
            const submenuRect = {
                width: measuredSubmenu?.width || 190,
                height: Math.max(submenuScrollHeight, measuredSubmenu?.height ?? 0),
            }
            const viewport = {
                innerWidth: window.innerWidth || document.documentElement.clientWidth,
                innerHeight: window.innerHeight || document.documentElement.clientHeight,
            }
            setSubmenuPlacement(resolveSubmenuPlacement(anchor, submenuRect, viewport))
        }

        updateSubmenuSide()
        window.addEventListener('resize', updateSubmenuSide)
        return () => window.removeEventListener('resize', updateSubmenuSide)
    }, [activeVisibleSubmenu])

    const currentModelLabel =
        models.find((option) => option.id === modelId)?.label ??
        modelId ??
        models[0]?.label ??
        t('composer.modelCatalog.noModels', { defaultValue: 'No models available' })

    const currentReasoning = reasoningOptions.find(
        (option: any) =>
            option.value === reasoningLevel ||
            option.id === reasoningLevel ||
            option.requestValue === reasoningLevel,
    )
    const currentReasoningLabel = currentReasoning
        ? (currentReasoning as any).labelKey
            ? t((currentReasoning as any).labelKey, {
                  defaultValue:
                      (currentReasoning as any).fallbackLabel ??
                      (currentReasoning as any).label ??
                      (currentReasoning as any).value ??
                      (currentReasoning as any).id,
              })
            : (currentReasoning as any).fallbackLabel ??
              (currentReasoning as any).label ??
              (currentReasoning as any).value ??
              (currentReasoning as any).id
        : t('composer.modelCatalog.unavailable', { defaultValue: 'Unavailable' })

    const currentSpeedOption = speedOptions.find((option) => option.id === speed)
    const currentSpeedLabel = currentSpeedOption?.labelKey
        ? t(currentSpeedOption.labelKey, { defaultValue: currentSpeedOption.id })
        : t('composer.speed.standard', { defaultValue: 'Standard' })

    return (
        <div
            ref={panelRef}
            id={id}
            role="menu"
            aria-label={t('composer.advanced', { defaultValue: 'Advanced' })}
            aria-disabled={disabled || undefined}
            className="relative w-[234px] rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-2 shadow-lg"
        >
            {catalogNotice ? (
                <div
                    role="status"
                    className="px-2 pb-1 text-[11px] text-[var(--text-muted)]"
                >
                    {catalogNotice}
                </div>
            ) : null}
            <AdvancedRow
                id={modelTriggerId}
                submenuId={modelSubmenuId}
                label={t('composer.model', { defaultValue: 'Model' })}
                value={currentModelLabel}
                isExpanded={activeSubmenu === 'model'}
                disabled={disabled}
                onActivate={() => {
                    if (disabled) return
                    onSubmenuChange('model')
                }}
            />
            <AdvancedRow
                id={reasoningTriggerId}
                submenuId={reasoningSubmenuId}
                label={t('composer.reasoning', { defaultValue: 'Reasoning' })}
                value={currentReasoningLabel}
                isExpanded={activeSubmenu === 'reasoning'}
                disabled={disabled}
                onActivate={() => {
                    if (disabled) return
                    onSubmenuChange('reasoning')
                }}
            />
            {supportsFast ? (
                <AdvancedRow
                    id={speedTriggerId}
                    submenuId={speedSubmenuId}
                    label={t('composer.speed', { defaultValue: 'Speed' })}
                    value={currentSpeedLabel}
                    isExpanded={activeSubmenu === 'speed'}
                    disabled={disabled}
                    onActivate={() => {
                        if (disabled) return
                        onSubmenuChange('speed')
                    }}
                />
            ) : null}

            <div
                role="separator"
                className="my-1 border-t border-[var(--border-subtle)]"
            />
            <button
                id={backId}
                type="button"
                role="menuitem"
                aria-label={t('composer.advanced', { defaultValue: 'Advanced' })}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                onClick={() => {
                    if (disabled) return
                    onBackToQuick()
                }}
                className={cn(
                    'flex w-full items-center gap-0.5 rounded-md px-2 py-2 text-left text-[13px]',
                    'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                    'hover:text-[var(--text-primary)]',
                    'disabled:pointer-events-none disabled:opacity-50',
                )}
            >
                <span>{t('composer.advanced', { defaultValue: 'Advanced' })}</span>
                <ChevronUp className="size-3.5 text-[var(--text-muted)]" aria-hidden />
            </button>

            {activeVisibleSubmenu && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={submenuRef}
                          data-model-menu-portal
                          data-side={submenuPlacement.side}
                          className="fixed z-[70] w-[190px]"
                          style={{
                              position: 'fixed',
                              left: `${submenuPlacement.left}px`,
                              top: `${submenuPlacement.top}px`,
                              width: `${submenuPlacement.width}px`,
                              maxHeight: `${submenuPlacement.maxHeight}px`,
                          }}
                      >
                          {activeVisibleSubmenu === 'model' ? (
                              <ModelOptionsMenu
                                  id={modelSubmenuId}
                                  ariaLabelledBy={modelTriggerId}
                                  models={models}
                                  modelId={modelId}
                                  maxHeight={submenuPlacement.maxHeight}
                                  disabled={disabled}
                                  onSelect={(nextModelId) => {
                                      if (disabled) return
                                      onModelChange(nextModelId)
                                      onSubmenuChange(null)
                                  }}
                              />
                          ) : null}
                          {activeVisibleSubmenu === 'reasoning' ? (
                              <ReasoningMenu
                                  id={reasoningSubmenuId}
                                  options={reasoningOptions}
                                  reasoningLevel={reasoningLevel}
                                  maxHeight={submenuPlacement.maxHeight}
                                  disabled={disabled}
                                  onSelect={(next) => {
                                      if (disabled) return
                                      onReasoningLevelChange(next as ReasoningLevel)
                                  }}
                              />
                          ) : null}
                          {activeVisibleSubmenu === 'speed' ? (
                              <SpeedMenu
                                  id={speedSubmenuId}
                                  ariaLabelledBy={speedTriggerId}
                                  options={speedOptions}
                                  speed={speed}
                                  maxHeight={submenuPlacement.maxHeight}
                                  disabled={disabled}
                                  onSelect={(nextSpeed) => {
                                      if (disabled) return
                                      onSpeedChange(nextSpeed)
                                      onSubmenuChange(null)
                                  }}
                              />
                          ) : null}
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    )
}

function AdvancedRow({
    id,
    submenuId,
    label,
    value,
    isExpanded,
    disabled = false,
    onActivate,
}: {
    id: string
    submenuId: string
    label: string
    value: string
    isExpanded: boolean
    disabled?: boolean
    onActivate: () => void
}) {
    return (
        <button
            id={id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? submenuId : undefined}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            onMouseEnter={() => {
                if (disabled) return
                onActivate()
            }}
            onFocus={() => {
                if (disabled) return
                onActivate()
            }}
            onClick={() => {
                if (disabled) return
                onActivate()
            }}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px]',
                'text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                'disabled:pointer-events-none disabled:opacity-50',
                isExpanded && 'bg-[var(--bg-sidebar-hover)]',
            )}
        >
            <span className="shrink-0">{label}</span>
            <span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--text-muted)]">
                {value}
            </span>
            <ChevronRight className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        </button>
    )
}
