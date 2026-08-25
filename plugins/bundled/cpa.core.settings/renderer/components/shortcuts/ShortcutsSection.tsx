import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
    Pencil,
    Search,
    Trash2,
    Zap,
    cn,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import { SettingsServiceToken, parseShortcutString } from '@cpa/plugin-api'
import { useAllActions } from '@/plugins/platform/contributions/actions'
import { formatKeyEvent } from './formatKey.js'
import { ShortcutEditDialog } from './ShortcutEditDialog.js'
import { DEFAULT_SHORTCUT_ITEMS, IMPLEMENTED_SHORTCUT_IDS } from '../../../shared/defaultShortcuts.js'
import {
    areShortcutListsEqual,
    formatShortcutBinding,
    normalizeShortcutBinding,
    type ShortcutItem,
    type ShortcutKeyBinding,
} from './shortcutsData.js'

export function ShortcutsSection() {
    const { t } = useTranslation()
    const settingsService = useHostService(SettingsServiceToken)
    const settings = useSettings()

    const customShortcuts = settings.shortcuts
    const setAppearance = (partial: any) => settingsService?.setAppearance?.(partial)
    const registeredActions = useAllActions()

    const allShortcutItems = useMemo(() => {
        const itemsMap = new Map<string, ShortcutItem>()
        for (const item of DEFAULT_SHORTCUT_ITEMS) {
            itemsMap.set(item.id, item)
        }
        for (const action of registeredActions) {
            const hasDefaultShortcuts = Boolean(
                action.defaultShortcuts && action.defaultShortcuts.length > 0,
            )
            const isKnownItem = itemsMap.has(action.id)
            if (!hasDefaultShortcuts && !isKnownItem) {
                continue
            }

            const defaultShortcuts: ShortcutKeyBinding[] = action.defaultShortcuts
                ? action.defaultShortcuts
                      .map((s) => (typeof s === 'string' ? parseShortcutString(s) : normalizeShortcutBinding(s)))
                      .filter((s): s is ShortcutKeyBinding => s !== null)
                : itemsMap.get(action.id)?.defaultShortcuts ?? []

            const existing = itemsMap.get(action.id)
            itemsMap.set(action.id, {
                id: action.id,
                titleKey: action.title,
                descKey: action.description ?? existing?.descKey ?? '',
                titleZh: existing?.titleZh ?? action.title,
                descZh: existing?.descZh ?? action.description ?? '',
                titleEn: existing?.titleEn ?? action.title,
                descEn: existing?.descEn ?? action.description ?? '',
                defaultShortcuts,
            })
        }
        return Array.from(itemsMap.values())
    }, [registeredActions])

    const [query, setQuery] = useState('')
    const [isShortcutSearchActive, setIsShortcutSearchActive] = useState(false)
    const searchInputRef = useRef<HTMLInputElement>(null)
    const [editingItem, setEditingItem] = useState<{
        item: ShortcutItem
        index: number
    } | null>(null)
    const listContainerRef = useRef<HTMLDivElement>(null)

    // Forward wheel scrolling to list container when wheel events occur outside the list in <main>
    useEffect(() => {
        const listEl = listContainerRef.current
        if (!listEl) return

        const mainEl = listEl.closest('main')
        if (!mainEl) return

        const handleWheel = (event: WheelEvent) => {
            // If the wheel event target is inside the list, native scrolling handles it
            if (listEl.contains(event.target as Node)) {
                return
            }

            // Do not scroll list when interacting with open modals, dropdowns, or menus
            const targetEl = event.target as Element | null
            if (targetEl?.closest?.('[role="dialog"], [role="listbox"], [role="menu"]')) {
                return
            }

            let deltaY = event.deltaY
            if (event.deltaMode === 1) {
                // DOM_DELTA_LINE
                deltaY *= 16
            } else if (event.deltaMode === 2) {
                // DOM_DELTA_PAGE
                deltaY *= listEl.clientHeight
            }

            if (deltaY !== 0) {
                listEl.scrollTop += deltaY
            }
        }

        mainEl.addEventListener('wheel', handleWheel, { passive: true })
        return () => {
            mainEl.removeEventListener('wheel', handleWheel)
        }
    }, [])

    // Merge default shortcuts with custom overrides
    const getShortcutsForItem = (item: ShortcutItem): ShortcutKeyBinding[] => {
        if (customShortcuts && Object.prototype.hasOwnProperty.call(customShortcuts, item.id)) {
            const raw = customShortcuts[item.id]
            if (Array.isArray(raw)) {
                return raw
                    .map((s) => normalizeShortcutBinding(s))
                    .filter((s): s is ShortcutKeyBinding => s !== null)
            }
            return []
        }
        return item.defaultShortcuts
    }

    const handleSaveShortcuts = (itemId: string, newShortcuts: ShortcutKeyBinding[]) => {
        const defaultItem = allShortcutItems.find((i) => i.id === itemId)
        const next = { ...customShortcuts }
        if (defaultItem && areShortcutListsEqual(newShortcuts, defaultItem.defaultShortcuts)) {
            delete next[itemId]
        } else {
            next[itemId] = newShortcuts
        }
        setAppearance({ shortcuts: next })
    }

    const handleDeleteShortcut = (itemId: string, shortcutIndex: number) => {
        const item = allShortcutItems.find((i) => i.id === itemId)
        if (!item) return
        const current = getShortcutsForItem(item)
        const next = current.filter((_, idx) => idx !== shortcutIndex)
        handleSaveShortcuts(itemId, next)
    }

    const handleToggleShortcutSearch = () => {
        const nextState = !isShortcutSearchActive
        setIsShortcutSearchActive(nextState)
        if (nextState) {
            setQuery('')
            setTimeout(() => {
                searchInputRef.current?.focus()
            }, 0)
        }
    }

    const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (!isShortcutSearchActive) return

        // Pressing Escape exits shortcut capture or clears query
        if (event.key === 'Escape') {
            event.preventDefault()
            if (query) {
                setQuery('')
            } else {
                setIsShortcutSearchActive(false)
            }
            return
        }

        // Pressing Backspace clears the current shortcut query
        if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault()
            setQuery('')
            return
        }

        const formatted = formatKeyEvent(event)
        if (formatted) {
            event.preventDefault()
            event.stopPropagation()
            setQuery(formatted)
        }
    }

    const filteredItems = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return allShortcutItems

        if (isShortcutSearchActive) {
            return allShortcutItems.filter((item) => {
                const shortcuts = getShortcutsForItem(item)
                return shortcuts.some((sc) =>
                    formatShortcutBinding(sc).toLowerCase().includes(q),
                )
            })
        }

        return allShortcutItems.filter((item) => {
            const title = t(item.titleKey, { defaultValue: item.titleZh }).toLowerCase()
            const desc = t(item.descKey, { defaultValue: item.descZh }).toLowerCase()
            const shortcuts = getShortcutsForItem(item)
            const shortcutText = shortcuts
                .map((sc) => formatShortcutBinding(sc))
                .join(' ')
                .toLowerCase()

            return (
                title.includes(q) ||
                desc.includes(q) ||
                item.titleZh.toLowerCase().includes(q) ||
                item.descZh.toLowerCase().includes(q) ||
                item.titleEn.toLowerCase().includes(q) ||
                item.descEn.toLowerCase().includes(q) ||
                shortcutText.includes(q) ||
                item.id.toLowerCase().includes(q)
            )
        })
    }, [query, isShortcutSearchActive, customShortcuts, allShortcutItems, t])

    return (
        <div className="flex h-full w-full flex-1 flex-col overflow-hidden">
            {/* Fixed Header (Title & Search Bar) - strictly fixed at the top, does NOT scroll */}
            <div className="shrink-0">
                <div className="mx-auto w-full max-w-[760px] px-8 pt-8 pb-4 space-y-5">
                    {/* Header Title */}
                    <div>
                        <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                            {t('settings.shortcuts.title')}
                        </h1>
                    </div>

                    {/* Search Bar */}
                    <div className="relative flex items-center">
                        <Search
                            className="pointer-events-none absolute left-3.5 size-4 text-[var(--text-muted)]"
                            aria-hidden
                        />
                        <input
                            ref={searchInputRef}
                            type="search"
                            value={query}
                            readOnly={isShortcutSearchActive}
                            placeholder={
                                isShortcutSearchActive
                                    ? t('settings.shortcuts.pressKeysToFilter')
                                    : t('settings.shortcuts.searchPlaceholder')
                            }
                            aria-label={t('settings.shortcuts.searchPlaceholder')}
                            onKeyDown={isShortcutSearchActive ? handleSearchKeyDown : undefined}
                            onChange={(e) => setQuery(e.target.value)}
                            className={cn(
                                'w-full rounded-xl border border-[var(--border-subtle)]',
                                'bg-[var(--bg-card)] py-2.5 pl-10 pr-11 text-[13px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/50',
                                isShortcutSearchActive &&
                                    'border-[var(--accent-blue)]/60 ring-1 ring-[var(--accent-blue)]/30 font-mono',
                            )}
                        />
                        <button
                            type="button"
                            aria-pressed={isShortcutSearchActive}
                            onClick={handleToggleShortcutSearch}
                            title={t('settings.shortcuts.searchByShortcut')}
                            aria-label={t('settings.shortcuts.searchByShortcut')}
                            className={cn(
                                'absolute right-2.5 flex items-center justify-center rounded-md p-1.5 transition-colors',
                                isShortcutSearchActive
                                    ? 'bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] border border-[var(--accent-blue)]/50 shadow-xs'
                                    : 'border border-white/10 bg-white/5 text-[var(--text-muted)] hover:bg-white/10 hover:text-[var(--text-primary)] hover:border-white/20',
                            )}
                        >
                            <Zap className="size-3.5" aria-hidden />
                        </button>
                    </div>
                </div>
            </div>

            {/* Scrollable Shortcuts List Container - full width overflow-y-auto so wheel works everywhere in <main> */}
            <div
                ref={listContainerRef}
                className="min-h-0 flex-1 w-full overflow-y-auto"
            >
                <div className="mx-auto w-full max-w-[760px] px-8 pb-12 select-none">
                    <div className="overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
                        {filteredItems.length === 0 ? (
                            <div className="px-6 py-12 text-center text-[13px] text-[var(--text-muted)]">
                                {t('settings.shortcuts.empty')}
                            </div>
                        ) : (
                            <div className="divide-y divide-[var(--border-subtle)]/40">
                                {filteredItems.map((item) => {
                                    const shortcuts = getShortcutsForItem(item)
                                    const isUnassigned = shortcuts.length === 0
                                    const isImplemented = IMPLEMENTED_SHORTCUT_IDS.has(item.id)

                                    return (
                                        <div
                                            key={item.id}
                                            className="flex items-start justify-between gap-4 px-5 py-3.5 sm:px-6 sm:py-4 transition-colors hover:bg-white/[0.015]"
                                        >
                                            {/* Left: Title & Description */}
                                            <div className="min-w-0 flex-1">
                                                <div
                                                    className={cn(
                                                        'text-[13.5px] font-medium leading-snug',
                                                        isImplemented
                                                            ? 'text-[var(--text-primary)]'
                                                            : 'text-[var(--text-muted)]',
                                                    )}
                                                >
                                                    {t(item.titleKey, { defaultValue: item.titleZh })}
                                                </div>
                                                <div className="mt-0.5 text-[12px] text-[var(--text-muted)] leading-relaxed">
                                                    {t(item.descKey, { defaultValue: item.descZh })}
                                                </div>
                                            </div>

                                            {/* Right: Shortcut Keys & Actions */}
                                            <div className="flex shrink-0 items-center justify-end">
                                                {isUnassigned ? (
                                                    <div className="flex items-center gap-1.5 pt-0.5">
                                                        <span className="text-[12.5px] text-[var(--text-muted)] select-none">
                                                            {t('settings.shortcuts.unassigned')}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            aria-label={`Edit ${item.titleZh}`}
                                                            onClick={() =>
                                                                setEditingItem({
                                                                    item,
                                                                    index: -1,
                                                                })
                                                            }
                                                            className="rounded p-1 text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors"
                                                        >
                                                            <Pencil className="size-3.5" />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="flex flex-col items-end gap-2 pt-0.5">
                                                        {shortcuts.map((sc, scIdx) => {
                                                            const formatted = formatShortcutBinding(sc)
                                                            return (
                                                                <div
                                                                    key={`${item.id}-${scIdx}-${formatted}`}
                                                                    className="flex items-center gap-1.5"
                                                                >
                                                                    <kbd className="inline-flex items-center justify-center rounded-md bg-white/10 px-2 py-0.5 text-[11.5px] font-medium font-mono text-[var(--text-primary)] border border-white/5 tracking-wider select-none shadow-xs">
                                                                        {formatted}
                                                                    </kbd>
                                                                    <button
                                                                        type="button"
                                                                        aria-label={`Edit ${item.titleZh} shortcut ${formatted}`}
                                                                        onClick={() =>
                                                                            setEditingItem({
                                                                                item,
                                                                                index: scIdx,
                                                                            })
                                                                        }
                                                                        className="rounded p-1 text-[var(--text-muted)] hover:bg-white/5 hover:text-[var(--text-primary)] transition-colors"
                                                                    >
                                                                        <Pencil className="size-3.5" />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        aria-label={`Delete ${item.titleZh} shortcut ${formatted}`}
                                                                        onClick={() =>
                                                                            handleDeleteShortcut(item.id, scIdx)
                                                                        }
                                                                        className="rounded p-1 text-[var(--text-muted)] hover:bg-white/5 hover:text-red-400 transition-colors"
                                                                    >
                                                                        <Trash2 className="size-3.5" />
                                                                    </button>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Edit Dialog */}
            {editingItem ? (
                <ShortcutEditDialog
                    item={editingItem.item}
                    index={editingItem.index}
                    currentShortcuts={getShortcutsForItem(editingItem.item)}
                    isOpen={true}
                    onClose={() => setEditingItem(null)}
                    onSave={(newShortcuts) =>
                        handleSaveShortcuts(editingItem.item.id, newShortcuts)
                    }
                />
            ) : null}
        </div>
    )
}
