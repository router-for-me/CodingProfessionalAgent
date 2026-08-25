import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
    Check,
    Pipette,
    RotateCcw,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'

export interface ColorPickerPillProps {
    value: string
    onChange: (color: string) => void
    ariaLabel: string
    defaultColor?: string
    presets?: string[]
}

const DEFAULT_COLOR_PALETTE = [
    '#339CFF', // CPA Accent Blue
    '#2563EB', // Blue 600
    '#3B82F6', // Blue 500
    '#0EA5E9', // Sky 500
    '#06B6D4', // Cyan 500
    '#14B8A6', // Teal 500
    '#10B981', // Emerald 500
    '#22C55E', // Green 500
    '#84CC16', // Lime 500
    '#EAB308', // Yellow 500
    '#F59E0B', // Amber 500
    '#F97316', // Orange 500
    '#EF4444', // Red 500
    '#EC4899', // Pink 500
    '#D946EF', // Fuchsia 500
    '#A855F7', // Purple 500
    '#8B5CF6', // Violet 500
    '#6366F1', // Indigo 500
    '#181818', // Dark Neutral
    '#0E0E0E', // Deep Dark
    '#1C1C1C', // Card Dark
    '#282828', // Charcoal
    '#71717A', // Zinc 500
    '#A1A1AA', // Zinc 400
    '#E4E4E7', // Zinc 200
    '#F4F4F5', // Zinc 100
    '#FFFFFF', // Pure White
]

function normalizeHex(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed) return null
    const hex = trimmed.startsWith('#') ? trimmed : `#${trimmed}`
    if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(hex)) {
        return hex.toUpperCase()
    }
    return null
}

export function ColorPickerPill({
    value,
    onChange,
    ariaLabel,
    defaultColor = '#339CFF',
    presets = DEFAULT_COLOR_PALETTE,
}: ColorPickerPillProps) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [draftHex, setDraftHex] = useState(value)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)
    const nativeColorInputRef = useRef<HTMLInputElement>(null)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(
        null,
    )

    useEffect(() => {
        setDraftHex(value)
    }, [value])

    const updatePosition = useCallback(() => {
        if (!buttonRef.current) return
        const rect = buttonRef.current.getBoundingClientRect()
        const popoverWidth = 240
        const popoverHeight = 280
        const padding = 8

        let left = rect.right - popoverWidth
        if (left < padding) left = padding
        if (left + popoverWidth > window.innerWidth - padding) {
            left = window.innerWidth - popoverWidth - padding
        }

        let top = rect.bottom + 6
        if (top + popoverHeight > window.innerHeight - padding) {
            top = Math.max(padding, rect.top - popoverHeight - 6)
        }

        setPosition({ top, left })
    }, [])

    useEffect(() => {
        if (!open) return
        updatePosition()
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (
                buttonRef.current?.contains(target) ||
                popoverRef.current?.contains(target)
            ) {
                return
            }
            setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                setOpen(false)
            }
        }
        window.addEventListener('pointerdown', onPointerDown)
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('resize', updatePosition)
        window.addEventListener('scroll', updatePosition, true)
        return () => {
            window.removeEventListener('pointerdown', onPointerDown)
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('resize', updatePosition)
            window.removeEventListener('scroll', updatePosition, true)
        }
    }, [open, updatePosition])

    const commitHex = (hex: string) => {
        const norm = normalizeHex(hex)
        if (norm) {
            onChange(norm)
            setDraftHex(norm)
        } else {
            setDraftHex(value)
        }
    }

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            commitHex(draftHex)
            setOpen(false)
        }
    }

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-label={ariaLabel}
                aria-haspopup="dialog"
                aria-expanded={open}
                className={cn(
                    'group inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)]',
                    'bg-[var(--bg-sidebar-hover)] px-2 py-1 transition-colors',
                    'hover:border-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                )}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span
                    className="size-4 shrink-0 rounded-full border border-black/20 shadow-xs"
                    style={{ backgroundColor: value }}
                />
                <span className="font-mono text-[11px] text-[var(--text-primary)] uppercase">
                    {value}
                </span>
            </button>

            {open && position && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={popoverRef}
                          role="dialog"
                          aria-label={ariaLabel}
                          style={{ top: position.top, left: position.left }}
                          className={cn(
                              'fixed z-[90] w-[240px] rounded-xl border border-[var(--border-subtle)]',
                              'bg-[var(--bg-elevated)] p-3 shadow-xl backdrop-blur-md',
                              'animate-in fade-in zoom-in-95 duration-100',
                          )}
                      >
                          {/* Top Controls: Preset swatch grid */}
                          <div className="grid grid-cols-6 gap-1.5 pb-3 border-b border-[var(--border-subtle)]">
                              {presets.map((color) => {
                                  const isSelected =
                                      normalizeHex(color) === normalizeHex(value)
                                  return (
                                      <button
                                          key={color}
                                          type="button"
                                          title={color}
                                          aria-label={color}
                                          className={cn(
                                              'relative size-7 rounded-md border border-black/15 transition-transform',
                                              'hover:scale-110 focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]',
                                              isSelected &&
                                                  'ring-2 ring-[var(--accent-blue)] ring-offset-1 ring-offset-[var(--bg-elevated)]',
                                          )}
                                          style={{ backgroundColor: color }}
                                          onClick={() => {
                                              onChange(color)
                                              setDraftHex(color)
                                          }}
                                      >
                                          {isSelected ? (
                                              <Check
                                                  className={cn(
                                                      'absolute inset-0 m-auto size-3.5',
                                                      color.toUpperCase() === '#FFFFFF' ||
                                                          color.toUpperCase() === '#F4F4F5' ||
                                                          color.toUpperCase() === '#E4E4E7'
                                                          ? 'text-black'
                                                          : 'text-white',
                                                  )}
                                              />
                                          ) : null}
                                      </button>
                                  )
                              })}
                          </div>

                          {/* Custom Hex + Native Eyedropper input */}
                          <div className="mt-3 flex items-center gap-2">
                              <div className="relative flex-1">
                                  <input
                                      type="text"
                                      value={draftHex}
                                      maxLength={9}
                                      placeholder="#339CFF"
                                      aria-label={`${ariaLabel} hex input`}
                                      className={cn(
                                          'w-full rounded-md border border-[var(--border-subtle)]',
                                          'bg-[var(--bg-sidebar)] px-2 py-1 font-mono text-[12px]',
                                          'text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)] uppercase',
                                      )}
                                      onChange={(e) => setDraftHex(e.target.value)}
                                      onBlur={() => commitHex(draftHex)}
                                      onKeyDown={handleKeyDown}
                                  />
                              </div>

                              <button
                                  type="button"
                                  title={t('settings.appearance.colorPicker.eyedropper')}
                                  aria-label={t('settings.appearance.colorPicker.eyedropper')}
                                  className={cn(
                                      'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                                      'bg-[var(--bg-sidebar)] text-[var(--text-secondary)] transition-colors',
                                      'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                  )}
                                  onClick={() => nativeColorInputRef.current?.click()}
                              >
                                  <Pipette className="size-3.5" />
                                  <input
                                      ref={nativeColorInputRef}
                                      type="color"
                                      value={normalizeHex(value)?.slice(0, 7) || '#339CFF'}
                                      className="sr-only"
                                      onChange={(e) => {
                                          onChange(e.target.value.toUpperCase())
                                          setDraftHex(e.target.value.toUpperCase())
                                      }}
                                  />
                              </button>

                              <button
                                  type="button"
                                  title={t('settings.appearance.resetColor', 'Reset')}
                                  aria-label={t('settings.appearance.resetColor', 'Reset')}
                                  className={cn(
                                      'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)]',
                                      'bg-[var(--bg-sidebar)] text-[var(--text-secondary)] transition-colors',
                                      'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                  )}
                                  onClick={() => {
                                      onChange(defaultColor)
                                      setDraftHex(defaultColor)
                                  }}
                              >
                                  <RotateCcw className="size-3.5" />
                              </button>
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    )
}
