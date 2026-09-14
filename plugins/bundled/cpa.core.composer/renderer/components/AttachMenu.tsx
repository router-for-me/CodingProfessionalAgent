import {
    createElement,
    isValidElement,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ComponentType,
    type ExoticComponent,
    type ReactElement,
    type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Paperclip, cn, useTranslation } from '@cpa/plugin-ui'
import type { AttachmentProvider } from '@cpa/plugin-api'

export type AttachMenuItemId = 'files' | (string & {})

export interface AttachMenuItem {
    id: AttachMenuItemId
    label: string
    description?: string
    icon: ReactElement
    provider?: AttachmentProvider
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

export const ATTACH_MENU_ITEMS = [{
    id: 'files' as AttachMenuItemId,
    labelKey: 'composer.attachMenu.filesAndFolders',
    defaultLabel: 'Files & Folders',
}]

const iconProps = {
    className: 'size-4 shrink-0 text-[var(--text-muted)]',
    'aria-hidden': true,
}

function isExoticIconComponent(icon: unknown): icon is ExoticComponent<any> {
    if (typeof icon !== 'object' || icon === null || !('$$typeof' in icon)) return false
    const marker = (icon as { $$typeof?: unknown }).$$typeof
    return marker === Symbol.for('react.forward_ref')
        || marker === Symbol.for('react.memo')
        || marker === Symbol.for('react.lazy')
}

function getProviderIcon(customIcon?: AttachmentProvider['icon']): ReactElement {
    if (isValidElement(customIcon)) return customIcon
    if (typeof customIcon === 'function' || isExoticIconComponent(customIcon)) {
        return createElement(customIcon as ComponentType<any>, iconProps)
    }
    return <Paperclip {...iconProps} />
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
    const [submenuProvider, setSubmenuProvider] = useState<AttachmentProvider | null>(null)
    const [position, setPosition] = useState<{ bottom: number; left: number } | null>(() => {
        if (!anchorRef?.current || typeof window === 'undefined') return null
        return computeAttachMenuPosition(anchorRef.current.getBoundingClientRect())
    })

    const updatePosition = useCallback(() => {
        if (!anchorRef?.current || typeof window === 'undefined') return
        setPosition(computeAttachMenuPosition(anchorRef.current.getBoundingClientRect()))
    }, [anchorRef])

    useLayoutEffect(() => { updatePosition() }, [updatePosition])
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

    const items: AttachMenuItem[] = providers.length > 0
        ? providers.map((provider) => ({
            id: provider.id,
            label: provider.labelKey ? t(provider.labelKey, { defaultValue: provider.label }) : provider.label,
            description: provider.descKey ? t(provider.descKey, { defaultValue: provider.description || '' }) : provider.description,
            icon: getProviderIcon(provider.icon),
            provider,
        }))
        : [{
            id: 'files',
            label: t('composer.attachMenu.filesAndFolders', { defaultValue: 'Files & Folders' }),
            icon: <Paperclip className="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden />,
        }]
    const safeIndex = items.length > 0 ? ((activeIndex % items.length) + items.length) % items.length : 0

    const activateItem = useCallback((item: AttachMenuItem | undefined) => {
        if (!item) return
        if (item.provider?.submenu) {
            setSubmenuProvider(item.provider)
            return
        }
        onSelect(item.id)
    }, [onSelect])

    useEffect(() => {
        if (!listRef.current || items.length === 0 || submenuProvider) return
        listRef.current.querySelector(`[data-attach-index="${safeIndex}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }, [safeIndex, items.length, submenuProvider])

    useEffect(() => {
        const onPointerDown = (event: globalThis.PointerEvent) => {
            const target = event.target as Element | null
            if (!listRef.current?.contains(target) && !target?.closest?.('[data-custom-select-menu]')) onClose()
        }
        document.addEventListener('pointerdown', onPointerDown)
        return () => document.removeEventListener('pointerdown', onPointerDown)
    }, [onClose])

    useEffect(() => {
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopImmediatePropagation()
                if (submenuProvider) setSubmenuProvider(null)
                else onClose()
                return
            }
            if (submenuProvider) {
                if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    event.stopImmediatePropagation()
                    setSubmenuProvider(null)
                }
                return
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                event.stopImmediatePropagation()
                const delta = event.key === 'ArrowDown' ? 1 : -1
                onActiveIndexChange((safeIndex + delta + items.length) % items.length)
                return
            }
            if (event.key === 'Enter' || event.key === 'Tab' || event.key === 'ArrowRight') {
                const item = items[safeIndex]
                if (!item || (event.key === 'ArrowRight' && !item.provider?.submenu)) return
                event.preventDefault()
                event.stopImmediatePropagation()
                activateItem(item)
            }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [activateItem, items, onActiveIndexChange, onClose, safeIndex, submenuProvider])

    const Submenu = submenuProvider?.submenu
    const menuContent = (
        <div
            id={id}
            ref={listRef}
            role={Submenu ? 'dialog' : 'listbox'}
            data-attach-menu-portal={position ? '' : undefined}
            aria-label={Submenu
                ? t(submenuProvider?.labelKey || '', { defaultValue: submenuProvider?.label || '' })
                : t('composer.attachMenu.title', { defaultValue: 'Attach' })}
            style={position ? { bottom: `${position.bottom}px`, left: `${position.left}px` } : undefined}
            className={cn(
                position ? 'fixed z-[70]' : 'absolute bottom-full left-0 z-[70] mb-2',
                'w-72 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-1.5 shadow-xl backdrop-blur-md',
                'animate-in fade-in-0 zoom-in-95',
                className,
            )}
        >
            {Submenu ? (
                <>
                    <button
                        type="button"
                        onClick={() => setSubmenuProvider(null)}
                        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]"
                    >
                        <ChevronLeft className="size-3.5" aria-hidden />
                        {t('common.back', { defaultValue: 'Back' })}
                    </button>
                    <Submenu onBack={() => setSubmenuProvider(null)} onClose={onClose} />
                </>
            ) : (
                <>
                    <div className="px-2.5 py-1 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                        {t('composer.attachMenu.title', { defaultValue: 'Attach' })}
                    </div>
                    <div className="space-y-0.5">
                        {items.map((item, index) => {
                            const isSelected = index === safeIndex
                            return <button
                                key={item.id}
                                type="button"
                                role="option"
                                aria-selected={isSelected}
                                aria-haspopup={item.provider?.submenu ? 'dialog' : undefined}
                                data-attach-index={index}
                                onMouseEnter={() => onActiveIndexChange(index)}
                                onMouseDown={(event) => { event.preventDefault(); activateItem(item) }}
                                className={cn(
                                    'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors active:scale-[0.98]',
                                    isSelected ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                                )}
                            >
                                <div className="mt-0.5">{item.icon}</div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-[13px] font-medium leading-tight">{item.label}</div>
                                    {item.description ? <div className="mt-0.5 text-[11px] leading-normal text-[var(--text-muted)]">{item.description}</div> : null}
                                </div>
                                {item.provider?.submenu ? <ChevronRight className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden /> : null}
                            </button>
                        })}
                    </div>
                </>
            )}
        </div>
    )
    return position && typeof document !== 'undefined' ? createPortal(menuContent, document.body) : menuContent
}
