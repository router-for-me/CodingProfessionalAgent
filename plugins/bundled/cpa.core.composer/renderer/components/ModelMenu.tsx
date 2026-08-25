import { ChevronRight, Zap, cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelReasoningOption, ReasoningLevel, Speed } from '@cpa/plugin-api'

export interface ModelMenuProps {
    reasoningOptions: readonly ModelReasoningOption[]
    supportsFast: boolean
    reasoningLevel: ReasoningLevel
    speed: Speed
    onReasoningLevelChange: (reasoningLevel: ReasoningLevel) => void
    onSpeedChange: (speed: Speed) => void
    onOpenAdvanced: () => void
    catalogNotice?: string
    disabled?: boolean
    id?: string
    allowModelChange?: boolean
}

export function ModelMenu({
    reasoningOptions,
    supportsFast,
    reasoningLevel,
    speed,
    onReasoningLevelChange,
    onSpeedChange,
    onOpenAdvanced,
    catalogNotice,
    disabled = false,
    id = 'composer-model-menu',
    allowModelChange = true,
}: ModelMenuProps) {
    const { t } = useTranslation()
    const selectedOptionIndex = Math.max(
        reasoningOptions.findIndex(
            (option: any) =>
                option.id === reasoningLevel ||
                option.value === reasoningLevel ||
                option.requestValue === reasoningLevel,
        ),
        0,
    )
    const isFastEnabled = speed !== 'standard'
    const thumbSizePx = 24
    const thumbRadiusPx = thumbSizePx / 2
    const sliderStops = Math.max(reasoningOptions.length - 1, 1)
    const thumbCenter = `calc(${thumbRadiusPx}px + ${selectedOptionIndex} * (100% - ${thumbSizePx}px) / ${sliderStops})`

    return (
        <div
            id={id}
            role="menu"
            aria-label={t('composer.modelMenu', { defaultValue: 'Model menu' })}
            className={cn(
                'w-[234px] rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                'bg-[var(--bg-elevated)] p-2 shadow-lg',
            )}
        >
            {catalogNotice ? (
                <div
                    role="status"
                    className="px-2 pb-1 text-[11px] text-[var(--text-muted)]"
                >
                    {catalogNotice}
                </div>
            ) : null}
            {allowModelChange || supportsFast ? (
                <div
                    className={cn(
                        'flex items-center gap-2 px-1',
                        allowModelChange ? 'justify-between' : 'justify-end',
                    )}
                >
                    {allowModelChange ? (
                        <button
                            type="button"
                            role="menuitem"
                            disabled={disabled}
                            onClick={onOpenAdvanced}
                            className={cn(
                                'inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[12px]',
                                'text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)]',
                                'hover:text-[var(--text-primary)]',
                                'disabled:pointer-events-none disabled:opacity-50',
                            )}
                        >
                            <span>{t('composer.advanced', { defaultValue: 'Advanced' })}</span>
                            <ChevronRight className="size-3.5 text-[var(--text-muted)]" aria-hidden />
                        </button>
                    ) : null}
                    {supportsFast ? (
                        <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-label={t('composer.speed.fast', { defaultValue: 'Fast' })}
                            aria-checked={isFastEnabled}
                            disabled={disabled}
                            onClick={() => onSpeedChange(isFastEnabled ? 'standard' : 'fast')}
                            className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
                                'hover:bg-[var(--bg-sidebar-hover)]',
                                'disabled:pointer-events-none disabled:opacity-50',
                            )}
                        >
                            <Zap
                                className={cn(
                                    'size-3.5',
                                    isFastEnabled
                                        ? 'text-[var(--accent-blue)]'
                                        : 'text-[var(--text-muted)]',
                                )}
                                aria-hidden
                            />
                        </button>
                    ) : null}
                </div>
            ) : null}

            {reasoningOptions.length > 0 ? (
                <div className="px-2 pb-2 pt-2">
                    <div className="relative h-6">
                        <div
                            data-slider-track
                            className="absolute inset-x-0 top-1/2 z-0 h-5 -translate-y-1/2 rounded-full"
                            style={{
                                background: `linear-gradient(to right, var(--accent-blue) 0%, var(--accent-blue) ${thumbCenter}, var(--text-muted) ${thumbCenter}, var(--text-muted) 100%)`,
                            }}
                        />
                        <input
                            aria-label={t('composer.reasoning', { defaultValue: 'Reasoning effort' })}
                            type="range"
                            min={0}
                            max={reasoningOptions.length - 1}
                            step={1}
                            value={selectedOptionIndex}
                            disabled={disabled}
                            onChange={(event) => {
                                const option = reasoningOptions[Number(event.currentTarget.value)]
                                if (option) {
                                    onReasoningLevelChange(option.id || (option as any).value)
                                }
                            }}
                            className={cn(
                                'absolute inset-x-0 top-1/2 z-20 h-5 w-full -translate-y-1/2 appearance-none bg-transparent',
                                '[&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:rounded-full',
                                '[&::-webkit-slider-runnable-track]:bg-transparent',
                                '[&::-webkit-slider-thumb]:mt-[-2px] [&::-webkit-slider-thumb]:size-6',
                                '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
                                '[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md',
                                '[&::-moz-range-track]:h-5 [&::-moz-range-track]:rounded-full',
                                '[&::-moz-range-track]:bg-transparent',
                                '[&::-moz-range-thumb]:size-6 [&::-moz-range-thumb]:rounded-full',
                                '[&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white',
                                '[&::-moz-range-thumb]:shadow-md',
                            )}
                        />
                        <div
                            data-slider-tick-layer
                            className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-0"
                            aria-hidden
                        >
                            {reasoningOptions.map((option, index) => {
                                const isFilled = index < selectedOptionIndex
                                const isCurrent = index === selectedOptionIndex
                                return (
                                    <span
                                        key={option.id || (option as any).value || index}
                                        data-slider-tick
                                        style={{
                                            left: `calc(${thumbRadiusPx}px + ${index} * (100% - ${thumbSizePx}px) / ${sliderStops})`,
                                        }}
                                        className={cn(
                                            'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
                                            isFilled || isCurrent ? 'bg-white/80' : 'bg-white/35',
                                        )}
                                    />
                                )
                            })}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="px-3 py-3 text-[12px] text-[var(--text-muted)]">
                    {t('composer.modelCatalog.unavailable', { defaultValue: 'Unsupported' })}
                </div>
            )}
        </div>
    )
}
