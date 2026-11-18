import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { cn, useTranslation } from '@cpa/plugin-ui'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { SettingsRow } from './SettingsControls.js'

const LABEL = 'settings.personalization.systemPromptEnhancement.appliedModels'
const checkboxRow = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--bg-sidebar-hover)]'
const checkboxStyle = 'size-4 shrink-0 cursor-pointer accent-[var(--accent-blue)] focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)]'

export function SystemPromptEnhancementAppliedModels({
    models,
    value,
    onChange,
}: {
    models: readonly ModelCatalogEntry[]
    value: string[] | null | undefined
    onChange: (ids: string[] | null) => void
}) {
    const { t } = useTranslation()
    const label = t(LABEL)
    const popupId = useId()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const filter = query.trim().toLowerCase()
    const visibleModels = filter
        ? models.filter(({ id, label }) => label?.toLowerCase().includes(filter) || id.toLowerCase().includes(filter))
        : models
    const selected = new Set(value ?? [])
    const all = value == null
    const summary = all
        ? t(LABEL + '.all')
        : selected.size > 0
            ? t(LABEL + '.selected', { count: selected.size })
            : t(LABEL + '.none')

    useLayoutEffect(() => {
        const trigger = triggerRef.current
        const popup = popupRef.current
        if (!open || !trigger || !popup) return

        const positionPopup = () => {
            const { top, right, bottom } = trigger.getBoundingClientRect()
            const padding = 8
            const gap = 6
            const width = Math.min(304, window.innerWidth - 2 * padding)
            const below = window.innerHeight - bottom - gap - padding
            const above = top - gap - padding
            const maxHeight = 320
            const openAbove = below < maxHeight && above > below
            Object.assign(popup.style, {
                left: Math.max(padding, Math.min(right - width, window.innerWidth - width - padding)) + 'px',
                top: openAbove ? '' : Math.max(padding, bottom + gap) + 'px',
                bottom: openAbove ? Math.max(padding, window.innerHeight - top + gap) + 'px' : '',
                width: width + 'px',
                maxHeight: Math.min(maxHeight, openAbove ? above : below) + 'px',
            })
        }
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Node && !trigger.contains(target) && !popup.contains(target)) setOpen(false)
        }

        positionPopup()
        searchRef.current?.focus({ preventScroll: true })
        document.addEventListener('pointerdown', closeOnOutsidePointer)
        window.addEventListener('resize', positionPopup)
        window.addEventListener('scroll', positionPopup, true)
        return () => {
            document.removeEventListener('pointerdown', closeOnOutsidePointer)
            window.removeEventListener('resize', positionPopup)
            window.removeEventListener('scroll', positionPopup, true)
        }
    }, [open])

    const toggleModel = (id: string) => {
        // Individual edits are explicit; only the bulk control enables dynamic selection.
        const current = value ?? models.map((model) => model.id)
        onChange(all || selected.has(id) ? current.filter((modelId) => modelId !== id) : [...current, id])
    }

    const handlePopupKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Tab') {
            event.stopPropagation()
            const inputs = event.currentTarget.querySelectorAll('input')
            const edge = event.shiftKey ? searchRef.current : inputs[inputs.length - 1]
            if (event.target !== edge) return
        } else if (event.key !== 'Escape') {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
    }

    const searchLabel = t(LABEL + '.search')

    return (
        <SettingsRow
            id="systemPromptEnhancementAppliedModels"
            title={label}
            description={t(LABEL + '.desc')}
            inheritTypography
            control={
                <>
                    <button
                        ref={triggerRef}
                        type="button"
                        aria-label={label + ': ' + summary}
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        aria-controls={open ? popupId : undefined}
                        className={cn(
                            'flex max-w-[240px] items-center gap-1.5 rounded-lg border border-[var(--border-subtle)]',
                            'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] text-[var(--text-primary)]',
                            'cursor-pointer hover:bg-[var(--bg-sidebar)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                        )}
                        onClick={() => {
                            setQuery('')
                            setOpen(!open)
                        }}
                    >
                        <span className="truncate">{summary}</span>
                        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                    </button>
                    {open && createPortal(
                        <div
                            ref={popupRef}
                            id={popupId}
                            role="dialog"
                            aria-label={label}
                            className={cn(
                                'fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)]',
                                'bg-[var(--bg-elevated)] font-[inherit] text-[length:calc(var(--ui-font-size)-2px)] text-[var(--text-primary)] shadow-xl',
                            )}
                            onKeyDown={handlePopupKeyDown}
                            onBlur={(event) => {
                                const next = event.relatedTarget
                                if (next instanceof Node && next !== triggerRef.current && !event.currentTarget.contains(next)) {
                                    setOpen(false)
                                }
                            }}
                        >
                            <div className="shrink-0 space-y-1 border-b border-[var(--border-subtle)] p-2">
                                <input
                                    ref={searchRef}
                                    type="search"
                                    aria-label={searchLabel}
                                    placeholder={searchLabel}
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    className={cn(
                                        'w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] px-2 py-1.5',
                                        'font-[inherit] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)]',
                                    )}
                                />
                                <label className={checkboxRow}>
                                    <input
                                        type="checkbox"
                                        ref={(input) => {
                                            if (input) input.indeterminate = !all && selected.size > 0
                                        }}
                                        className={checkboxStyle}
                                        checked={all}
                                        onChange={() => onChange(all ? [] : null)}
                                    />
                                    {t(LABEL + '.all')}
                                </label>
                            </div>
                            <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
                                {visibleModels.length > 0 ? visibleModels.map((model) => (
                                    <label key={model.id} className={checkboxRow} title={model.id}>
                                        <input
                                            type="checkbox"
                                            className={checkboxStyle}
                                            checked={all || selected.has(model.id)}
                                            onChange={() => toggleModel(model.id)}
                                        />
                                        <span className="truncate">{model.label || model.id}</span>
                                    </label>
                                )) : (
                                    <p role="status" className="px-2 py-1.5 text-[var(--text-muted)]">
                                        {t(models.length ? LABEL + '.noMatches' : 'settings.personalization.systemPromptEnhancement.noModels')}
                                    </p>
                                )}
                            </div>
                        </div>,
                        document.body,
                    )}
                </>
            }
        />
    )
}
