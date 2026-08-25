import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ExternalLink, Puzzle, Search, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
    filterSettingsNavigation,
    searchSettingsSections,
    useSettingsNavigation,
    useSettingsSections,
} from '@/plugins/platform/contributions/settings'
import { cn } from '@/lib/cn'
import { useUiStore } from '@/stores/uiStore'
import { SettingsPlaceholderSection } from './SettingsPlaceholderSection'

/**
 * Full-screen settings shell matching CPA: left nav + content pane.
 * Driven entirely by plugin contributions registered in the contribution registry.
 */
export function SettingsPanel() {
    const { t, i18n } = useTranslation()
    const open = useUiStore((s) => s.settingsOpen)
    const settingsSection = useUiStore((s) => s.settingsSection)
    const setSettingsOpen = useUiStore((s) => s.setSettingsOpen)
    const pushToast = useUiStore((s) => s.pushToast)
    const sidebarWidth = useUiStore((s) => s.sidebarWidth)

    const navigation = useSettingsNavigation()
    const registeredSections = useSettingsSections()

    const defaultSectionId = navigation[0]?.sections[0]?.id ?? registeredSections[0]?.id ?? ''
    const [selectedSection, setSelectedSection] = useState<string>('')
    const [query, setQuery] = useState('')
    const contentRef = useRef<HTMLDivElement>(null)

    // Effective section falls back to first registered section if current selection is invalid
    const effectiveSectionId =
        (selectedSection && registeredSections.some((s) => s.id === selectedSection))
            ? selectedSection
            : defaultSectionId

    const activeSection = registeredSections.find((item) => item.id === effectiveSectionId)
    const ActiveComponent = activeSection?.component

    // Reset scroll container to top whenever settings panel opens or effective section changes
    useEffect(() => {
        if (open && contentRef.current) {
            contentRef.current.scrollTop = 0
        }
    }, [open, effectiveSectionId])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (open && event.key === 'Escape' && !event.defaultPrevented) {
                event.preventDefault()
                setSettingsOpen(false)
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open, setSettingsOpen])

    useEffect(() => {
        if (!open) {
            setSelectedSection('')
            setQuery('')
        } else if (settingsSection && registeredSections.some((s) => s.id === settingsSection)) {
            setSelectedSection(settingsSection)
        } else if (!selectedSection && defaultSectionId) {
            setSelectedSection(defaultSectionId)
        }
    }, [open, settingsSection, defaultSectionId, registeredSections])

    const isSearching = query.trim().length > 0

    const filteredGroups = useMemo(() => {
        return filterSettingsNavigation(navigation, query, t, i18n)
    }, [navigation, query, t, i18n])

    const matchedSections = useMemo(() => {
        if (!isSearching) return []
        return searchSettingsSections(registeredSections, query, t, i18n)
    }, [isSearching, registeredSections, query, t, i18n])

    if (!open) return null

    const handleSelect = (id: string, external?: boolean) => {
        if (external) {
            pushToast(t('toast.comingSoon'))
            return
        }
        setSelectedSection(id)
        useUiStore.setState({ settingsSection: id, settingsParams: undefined })
    }

    const handleSelectSubItem = (sectionId: string, itemId: string, external?: boolean) => {
        if (external) {
            pushToast(t('toast.comingSoon'))
            return
        }
        setSelectedSection(sectionId)
        useUiStore.setState({ settingsSection: sectionId, settingsParams: undefined })

        requestAnimationFrame(() => {
            setTimeout(() => {
                const el =
                    document.getElementById(`setting-${itemId}`) ||
                    document.querySelector(`[data-setting-id="${itemId}"]`) ||
                    document.getElementById(itemId)
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    el.classList.add('ring-2', 'ring-[var(--accent-blue)]/60', 'rounded-lg')
                    setTimeout(() => {
                        el.classList.remove('ring-2', 'ring-[var(--accent-blue)]/60', 'rounded-lg')
                    }, 1800)
                }
            }, 100)
        })
    }

    return (
        <div
            className="fixed inset-0 z-50 flex bg-[var(--bg-app)] text-[var(--text-primary)] select-none"
            role="dialog"
            aria-modal="true"
            aria-label={t('settings.title')}
        >
            <aside
                className="flex h-full shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-sidebar)]"
                style={{ width: sidebarWidth }}
            >
                <div
                    data-drag-region
                    className="flex h-11 shrink-0 items-end px-3 pb-1"
                />

                <div className="px-3 pb-2">
                    <button
                        type="button"
                        className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
                            'text-[var(--text-secondary)] transition-colors',
                            'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]'
                        )}
                        onClick={() => setSettingsOpen(false)}
                    >
                        <ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                        <span>{t('settings.back')}</span>
                    </button>
                </div>

                <div className="px-3 pb-3">
                    <label className="relative block">
                        <Search
                            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                            aria-hidden
                        />
                        <input
                            type="search"
                            value={query}
                            placeholder={t('settings.search')}
                            className={cn(
                                'w-full rounded-full border border-[var(--border-subtle)]',
                                'bg-[var(--bg-app)] py-1.5 pl-8 pr-8 text-[12px]',
                                'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
                                'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/30',
                                '[&::-webkit-search-cancel-button]:hidden'
                            )}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        {query ? (
                            <button
                                type="button"
                                aria-label={t('common.clear', { defaultValue: 'Clear' })}
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                                onClick={() => setQuery('')}
                            >
                                <XCircle className="size-3.5" aria-hidden />
                            </button>
                        ) : null}
                    </label>
                </div>

                <nav
                    className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
                    aria-label={t('settings.title')}
                >
                    {isSearching ? (
                        matchedSections.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                {matchedSections.map((matched) => {
                                    const Icon = matched.section.icon ?? Puzzle
                                    const isSectionActive =
                                        !(matched.section as any).external &&
                                        effectiveSectionId === matched.section.id

                                    return (
                                        <div key={matched.section.id} className="mb-2">
                                            <button
                                                type="button"
                                                className={cn(
                                                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
                                                    isSectionActive && matched.matchedItems.length === 0
                                                        ? 'bg-[var(--bg-sidebar-hover)] font-medium text-[var(--text-primary)]'
                                                        : 'text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]'
                                                )}
                                                onClick={() =>
                                                    handleSelect(
                                                        matched.section.id,
                                                        (matched.section as any).external
                                                    )
                                                }
                                            >
                                                <Icon
                                                    className="size-3.5 shrink-0 opacity-80"
                                                    aria-hidden
                                                />
                                                <span className="min-w-0 flex-1 truncate font-medium">
                                                    {t(matched.section.labelKey, {
                                                        defaultValue: matched.section.labelKey,
                                                    })}
                                                </span>
                                                {(matched.section as any).external ? (
                                                    <ExternalLink
                                                        className="size-3 shrink-0 opacity-60"
                                                        aria-hidden
                                                    />
                                                ) : null}
                                            </button>

                                            {matched.matchedItems.length > 0 ? (
                                                <div className="mt-0.5 flex flex-col gap-0.5">
                                                    {matched.matchedItems.map((subItem) => (
                                                        <button
                                                            key={subItem.id}
                                                            type="button"
                                                            className={cn(
                                                                'flex w-full items-center rounded-md pl-[34px] pr-2.5 py-1 text-left text-[13px] transition-colors',
                                                                'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]'
                                                            )}
                                                            onClick={() =>
                                                                handleSelectSubItem(
                                                                    matched.section.id,
                                                                    subItem.id,
                                                                    (matched.section as any).external
                                                                )
                                                            }
                                                        >
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {t(subItem.labelKey, {
                                                                    defaultValue: subItem.labelKey,
                                                                })}
                                                            </span>
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : null}
                                        </div>
                                    )
                                })}
                            </div>
                        ) : (
                            <p className="px-2.5 py-4 text-[12px] text-[var(--text-muted)]">
                                {t('settings.search.empty')}
                            </p>
                        )
                    ) : (
                        filteredGroups.map((group) => (
                            <div key={group.id} className="mb-3">
                                <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium tracking-wide text-[var(--text-muted)]">
                                    {t(group.labelKey, { defaultValue: group.labelKey })}
                                </div>
                                <div className="flex flex-col gap-0.5">
                                    {group.sections.map((item) => {
                                        const Icon = item.icon ?? Puzzle
                                        const active =
                                            !(item as any).external &&
                                            effectiveSectionId === item.id
                                        return (
                                            <button
                                                key={item.id}
                                                type="button"
                                                className={cn(
                                                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors',
                                                    active
                                                        ? 'bg-[var(--bg-sidebar-hover)] font-medium text-[var(--text-primary)]'
                                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]'
                                                )}
                                                onClick={() =>
                                                    handleSelect(item.id, (item as any).external)
                                                }
                                            >
                                                <Icon
                                                    className="size-3.5 shrink-0 opacity-80"
                                                    aria-hidden
                                                />
                                                <span className="min-w-0 flex-1 truncate">
                                                    {t(item.labelKey, {
                                                        defaultValue: item.labelKey,
                                                    })}
                                                </span>
                                                {(item as any).external ? (
                                                    <ExternalLink
                                                        className="size-3 shrink-0 opacity-60"
                                                        aria-hidden
                                                    />
                                                ) : null}
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </nav>
            </aside>

            <main
                className={cn(
                    'relative min-w-0 flex-1 bg-[var(--bg-app)]',
                    'flex h-full flex-col overflow-hidden'
                )}
            >
                <div data-drag-region className="h-11 shrink-0" />
                <div ref={contentRef} className="relative min-h-0 flex-1 overflow-y-auto">
                    {ActiveComponent ? (
                        <ActiveComponent />
                    ) : (
                        <SettingsPlaceholderSection
                            sectionId={effectiveSectionId}
                            labelKey={activeSection?.labelKey}
                        />
                    )}
                </div>
            </main>
        </div>
    )
}
