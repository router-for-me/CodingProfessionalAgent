import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ComponentType,
    type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn.js'

export interface CustomSelectOption<T extends string> {
    value: T
    label: string
}

export interface CustomSelectProps<T extends string> {
    value: T
    options: CustomSelectOption<T>[]
    onChange: (value: T) => void
    ariaLabel: string
    icon?: ComponentType<{ className?: string }>
    disabled?: boolean
    fullWidth?: boolean
    className?: string
    triggerClassName?: string
    align?: 'left' | 'right'
}

interface MenuPosition {
    minWidth: number
    maxWidth: number
    maxHeight: number
    top?: number
    bottom?: number
    left?: number
    right?: number
}

const MENU_GUTTER = 4
const VIEWPORT_PAD = 8
const MENU_MAX_HEIGHT = 240

/** Custom select-only combobox that never uses a native <select>. */
export function CustomSelect<T extends string>({
    value,
    options,
    onChange,
    ariaLabel,
    icon: Icon,
    disabled = false,
    fullWidth = false,
    className,
    triggerClassName,
    align,
}: CustomSelectProps<T>) {
    const reactId = useId()
    const idSuffix = toAriaId(reactId)
    const listboxId = `custom-select-${idSuffix}`
    const [open, setOpen] = useState(false)
    const [activeIndex, setActiveIndex] = useState(0)
    const [position, setPosition] = useState<MenuPosition | null>(null)
    const rootRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)

    const selectedIndex = Math.max(
        0,
        options.findIndex((option) => option.value === value),
    )
    const selected = options[selectedIndex] ?? options[0]
    const selectedLabel = selected?.label ?? ''

    const optionIds = useMemo(
        () => options.map((option) => `${listboxId}-${toAriaId(option.value)}`),
        [listboxId, options],
    )

    const updatePosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger) return
        setPosition(computeMenuPosition(trigger.getBoundingClientRect(), align))
    }, [align])

    const close = useCallback(() => {
        setOpen(false)
    }, [])

    const openMenu = useCallback(() => {
        if (disabled) return
        setActiveIndex(selectedIndex)
        updatePosition()
        setOpen(true)
    }, [disabled, selectedIndex, updatePosition])

    useEffect(() => {
        if (disabled) setOpen(false)
    }, [disabled])

    useLayoutEffect(() => {
        if (!open) return
        updatePosition()
    }, [open, updatePosition, options.length])

    useEffect(() => {
        if (!open) return

        const onPointerDown = (event: Event) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) {
                return
            }
            setOpen(false)
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            setOpen(false)
        }
        const onReposition = () => updatePosition()

        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onReposition)
        window.addEventListener('scroll', onReposition, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('mousedown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('resize', onReposition)
            window.removeEventListener('scroll', onReposition, true)
        }
    }, [open, updatePosition])

    useEffect(() => {
        if (!open) return
        const optionId = optionIds[activeIndex]
        if (!optionId) return
        document.getElementById(optionId)?.scrollIntoView?.({ block: 'nearest' })
    }, [activeIndex, open, optionIds])

    const selectIndex = (index: number) => {
        const option = options[index]
        if (!option) return
        onChange(option.value)
        setOpen(false)
        triggerRef.current?.focus()
    }

    const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return

        if (!open) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                openMenu()
            }
            return
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault()
            setActiveIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)))
            return
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) => Math.max(index - 1, 0))
            return
        }
        if (event.key === 'Home') {
            event.preventDefault()
            setActiveIndex(0)
            return
        }
        if (event.key === 'End') {
            event.preventDefault()
            setActiveIndex(Math.max(options.length - 1, 0))
            return
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectIndex(activeIndex)
        }
    }

    return (
        <div
            ref={rootRef}
            className={cn('relative', fullWidth && 'block w-full', className)}
        >
            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-label={ariaLabel}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? listboxId : undefined}
                aria-activedescendant={open ? optionIds[activeIndex] : undefined}
                aria-autocomplete="none"
                disabled={disabled}
                className={cn(
                    'inline-flex items-center gap-1.5 text-left outline-none',
                    'disabled:pointer-events-none disabled:opacity-50',
                    fullWidth && 'w-full',
                    triggerClassName,
                )}
                onClick={() => {
                    if (open) close()
                    else openMenu()
                }}
                onKeyDown={handleTriggerKeyDown}
            >
                {Icon ? (
                    <Icon className="size-3.5 shrink-0 text-[var(--text-secondary)]" />
                ) : null}
                <span className={cn('truncate', fullWidth && 'min-w-0 flex-1')}>
                    {selectedLabel}
                </span>
                <ChevronDown
                    className="size-3.5 shrink-0 text-[var(--text-muted)]"
                    aria-hidden
                />
            </button>

            {open && position && typeof document !== 'undefined'
                ? createPortal(
                    <div
                        ref={menuRef}
                        id={listboxId}
                        role="listbox"
                        aria-label={ariaLabel}
                        data-custom-select-menu=""
                        className={cn(
                            'fixed z-[70] overflow-y-auto rounded-[var(--radius-card)]',
                            'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] py-1 shadow-lg',
                        )}
                        style={{
                            left: position.left,
                            right: position.right,
                            minWidth: position.minWidth,
                            maxWidth: position.maxWidth,
                            maxHeight: position.maxHeight,
                            top: position.top,
                            bottom: position.bottom,
                        }}
                    >
                        {options.map((option, index) => {
                            const selectedOption = option.value === value
                            const active = index === activeIndex
                            return (
                                <button
                                    key={option.value}
                                    id={optionIds[index]}
                                    type="button"
                                    role="option"
                                    tabIndex={-1}
                                    aria-selected={selectedOption}
                                    className={cn(
                                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]',
                                        active
                                            ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                            : 'text-[var(--text-secondary)]',
                                    )}
                                    onMouseEnter={() => setActiveIndex(index)}
                                    onClick={() => selectIndex(index)}
                                >
                                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                                    {selectedOption ? (
                                        <Check
                                            className="size-3.5 shrink-0 text-[var(--accent-blue)]"
                                            aria-hidden
                                        />
                                    ) : null}
                                </button>
                            )
                        })}
                    </div>,
                    document.body,
                )
                : null}
        </div>
    )
}

function computeMenuPosition(trigger: DOMRect, align?: 'left' | 'right'): MenuPosition {
    const spaceBelow = window.innerHeight - trigger.bottom - VIEWPORT_PAD
    const spaceAbove = trigger.top - VIEWPORT_PAD
    const placement =
        spaceBelow < 120 && spaceAbove > spaceBelow ? 'top' : 'bottom'
    const available = placement === 'bottom' ? spaceBelow : spaceAbove
    const maxHeight = Math.max(
        96,
        Math.min(MENU_MAX_HEIGHT, available - MENU_GUTTER),
    )
    const maxWidth = window.innerWidth - VIEWPORT_PAD * 2
    const alignEnd =
        align === 'right'
            ? true
            : align === 'left'
              ? false
              : trigger.left + trigger.width / 2 > window.innerWidth / 2
    const horizontal = alignEnd
        ? { right: Math.max(VIEWPORT_PAD, window.innerWidth - trigger.right) }
        : { left: Math.max(VIEWPORT_PAD, trigger.left) }
    const vertical =
        placement === 'bottom'
            ? { top: trigger.bottom + MENU_GUTTER }
            : { bottom: window.innerHeight - trigger.top + MENU_GUTTER }

    return {
        minWidth: trigger.width,
        maxWidth,
        maxHeight,
        ...horizontal,
        ...vertical,
    }
}

function toAriaId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'id'
}
