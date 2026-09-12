import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactElement,
    type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, cn, useTranslation } from '@cpa/plugin-ui'
import type { AttachmentProvider } from '@cpa/plugin-api'

export type AttachMenuItemId = 'files' | (string & {})

export interface AttachMenuItem {
    id: AttachMenuItemId
    label: string
    description?: string
    icon: ReactElement
}

export interface AttachMenuProps {
    activeIndex: number
    onActiveIndexChange: (index: number) => void
    onSelect: (id: AttachMenuItemId) => void
    onClose: () => void
    id?: string
    className?: string
    providers?: readonly AttachmentProvider[]
    anchorRef?: RefObject<HTMLElement | null>
}

export const ATTACH_MENU_ID = 'composer-attach-menu'

export function computeAttachMenuPosition(anchorRect: DOMRect): { bottom: number; left: number } {
    const bottom = Math.max(0, window.innerHeight - anchorRect.top + 8)
    let left = anchorRect.left
    if (typeof window !== 'undefined' && left + 288 > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - 288 - 8)
    }
    return { bottom, left: Math.max(8, left) }
}

export const ATTACH_MENU_ITEMS: {
    id: AttachMenuItemId
    labelKey: string
    descKey?: string
    defaultLabel: string
    defaultDesc?: string
}[] = [
    {
        id: 'files',
        labelKey: 'composer.attachMenu.filesAndFolders',
        defaultLabel: 'Files & Folders',
    },
]

function getProviderIcon(_id: string, customIcon?: any): ReactElement {
    if (customIcon) {
        if (typeof customIcon === 'function') {
            const CustomIcon = customIcon
            return <CustomIcon className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        }
        return customIcon
    }
    return <Paperclip className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
}

export function AttachMenu({
    activeIndex,
    onActiveIndexChange,
    onSelect,
    onClose,
    id = ATTACH_MENU_ID,
    className,
    providers = [],
    anchorRef,
}: AttachMenuProps) {
    const { t } = useTranslation()
    const listRef = useRef<HTMLDivElement>(null)

    const [position, setPosition] = useState<{ bottom: number; left: number } | null>(() => {
        if (!anchorRef?.current || typeof window === 'undefined') return null
        return computeAttachMenuPosition(anchorRef.current.getBoundingClientRect())
    })

    const updatePosition = useCallback(() => {
        if (!anchorRef?.current || typeof window === 'undefined') return
        setPosition(computeAttachMenuPosition(anchorRef.current.getBoundingClientRect()))
    }, [anchorRef])

    useLayoutEffect(() => {
        updatePosition()
    }, [updatePosition])

    useEffect(() => {
        if (!anchorRef?.current) return
        const onReposition = () => updatePosition()
        window.addEventListener('resize', onReposition)
        window.addEventListener('scroll', onReposition, true)
        return () => {
            window.removeEventListener('resize', onReposition)
            window.removeEventListener('scroll', onReposition, true)
        }
    }, [anchorRef, updatePosition])

    const items: AttachMenuItem[] =
        providers.length > 0
            ? providers.map((provider) => ({
                  id: provider.id,
                  label: provider.labelKey
                      ? t(provider.labelKey, { defaultValue: provider.label })
                      : provider.label,
                  description: provider.descKey
                      ? t(provider.descKey, { defaultValue: provider.description || '' })
                      : provider.description,
                  icon: getProviderIcon(provider.id, provider.icon),
              }))
            : [
                  {
                      id: 'files',
                      label: t('composer.attachMenu.filesAndFolders', { defaultValue: 'Files & Folders' }),
                      icon: <Paperclip className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />,
                  },
              ]

    const safeIndex =
        items.length > 0
            ? ((activeIndex % items.length) + items.length) % items.length
            : 0

    useEffect(() => {
        if (!listRef.current || items.length === 0) return
        const activeElem = listRef.current.querySelector(
            `[data-attach-index="${safeIndex}"]`,
        )
        if (activeElem && typeof activeElem.scrollIntoView === 'function') {
            activeElem.scrollIntoView({ block: 'nearest' })
        }
    }, [safeIndex, items.length])

    useEffect(() => {
        const onPointerDown = (event: globalThis.MouseEvent | globalThis.PointerEvent) => {
            if (!listRef.current?.contains(event.target as Node)) {
                onClose()
            }
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown)
        }
    }, [onClose])

    const menuContent = (
        <div
            id={id}
            ref={listRef}
            role="listbox"
            data-attach-menu-portal={position ? '' : undefined}
            aria-label={t('composer.attachMenu.title', { defaultValue: 'Attach' })}
            style={
                position
                    ? {
                          bottom: `${position.bottom}px`,
                          left: `${position.left}px`,
                      }
                    : undefined
            }
            className={cn(
                position
                    ? 'fixed z-[70]'
                    : 'absolute bottom-full left-0 z-[70] mb-2',
                'w-72 rounded-[var(--radius-card)]',
                'border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-xl backdrop-blur-md',
                'animate-in fade-in-0 zoom-in-95',
                className,
            )}
        >
            <div className="px-2.5 py-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                {t('composer.attachMenu.title', { defaultValue: 'Attach' })}
            </div>

            <div className="space-y-0.5">
                {items.map((item, index) => {
                    const isSelected = index === safeIndex
                    return (
                        <button
                            key={item.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            data-attach-index={index}
                            onMouseEnter={() => onActiveIndexChange(index)}
                            onMouseDown={(e) => {
                                e.preventDefault()
                                onSelect(item.id)
                            }}
                            className={cn(
                                'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                                isSelected
                                    ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                            )}
                        >
                            <div className="mt-0.5">{item.icon}</div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[13px] font-medium leading-tight">
                                    {item.label}
                                </div>
                                {item.description ? (
                                    <div className="mt-0.5 text-[11px] leading-normal text-[var(--text-muted)]">
                                        {item.description}
                                    </div>
                                ) : null}
                            </div>
                        </button>
                    )
                })}
            </div>
        </div>
    )

    if (position && typeof document !== 'undefined') {
        return createPortal(menuContent, document.body)
    }

    return menuContent
}
