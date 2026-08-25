import { useCallback, useSyncExternalStore } from 'react'
import i18n from '@/i18n'
import type {
    SettingsGroupContribution,
    SettingsSectionContribution,
    SettingsSubItem,
} from '@cpa/plugin-api'
import { rendererRegistry, RendererRegistry } from '../rendererRegistry'

export type {
    SettingsGroupContribution,
    SettingsSectionContribution,
    SettingsSubItem,
}

export interface SettingsNavGroup {
    id: string
    order: number
    labelKey: string
    sections: readonly SettingsSectionContribution[]
}

export interface MatchedSettingsSection {
    section: SettingsSectionContribution
    matchedItems: readonly SettingsSubItem[]
}

let cachedNav: {
    groups: readonly SettingsGroupContribution[]
    sections: readonly SettingsSectionContribution[]
    result: readonly SettingsNavGroup[]
} | null = null

/**
 * Returns all registered settings groups sorted by their order.
 */
export function selectSettingsGroups(
    registry: RendererRegistry = rendererRegistry
): readonly SettingsGroupContribution[] {
    return registry
        .getSettingsGroups()
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/**
 * Returns all registered settings sections sorted by their order.
 */
export function selectSettingsSections(
    registry: RendererRegistry = rendererRegistry
): readonly SettingsSectionContribution[] {
    return registry
        .getSettingsSections()
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/**
 * Selects structured settings navigation groups and sections from registry.
 * Maintains referential stability across React renders unless registry changes.
 */
export function selectSettingsNavigation(
    registry: RendererRegistry = rendererRegistry
): readonly SettingsNavGroup[] {
    const groups = registry.getSettingsGroups()
    const sections = registry.getSettingsSections()

    if (
        cachedNav &&
        cachedNav.groups === groups &&
        cachedNav.sections === sections
    ) {
        return cachedNav.result
    }

    const sortedGroups = groups
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    const sortedSections = sections
        .slice()
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

    const groupMap = new Map<string, SettingsSectionContribution[]>()
    for (const group of sortedGroups) {
        groupMap.set(group.id, [])
    }

    const unassigned: SettingsSectionContribution[] = []
    for (const section of sortedSections) {
        if (section.groupId && groupMap.has(section.groupId)) {
            groupMap.get(section.groupId)!.push(section)
        } else {
            unassigned.push(section)
        }
    }

    const result: SettingsNavGroup[] = sortedGroups.map((g) =>
        Object.freeze({
            id: g.id,
            order: g.order ?? 100,
            labelKey: g.labelKey,
            sections: Object.freeze(groupMap.get(g.id) ?? []),
        })
    )

    if (unassigned.length > 0) {
        result.push(
            Object.freeze({
                id: 'extensions',
                order: Number.MAX_SAFE_INTEGER,
                labelKey: 'settings.nav.group.extensions',
                sections: Object.freeze(unassigned),
            })
        )
    }

    const frozenResult = Object.freeze(result)
    cachedNav = { groups, sections, result: frozenResult }
    return frozenResult
}

/**
 * Resolves all available translated strings for a translation key across all configured languages.
 */
export function getTranslationsAcrossLanguages(
    key: string,
    t?: (key: string, options?: any) => string,
    i18nInstance: any = i18n
): string[] {
    const results = new Set<string>()
    if (!key) return []

    // 1. Direct translation function if provided
    if (typeof t === 'function') {
        try {
            const direct = t(key, { defaultValue: '' })
            if (direct && direct !== key) {
                results.add(direct.trim().toLowerCase())
            }
        } catch {
            // Ignore translation error
        }
    }

    // 2. Check languages in i18nInstance
    if (i18nInstance) {
        const languages = new Set<string>(['zh-CN', 'en'])
        if (Array.isArray(i18nInstance.languages)) {
            for (const lang of i18nInstance.languages) {
                languages.add(lang)
            }
        }
        if (i18nInstance.store?.data) {
            for (const lang of Object.keys(i18nInstance.store.data)) {
                languages.add(lang)
            }
        }

        for (const lng of languages) {
            try {
                const res = i18nInstance.getResource?.(lng, 'translation', key)
                if (typeof res === 'string' && res.trim().length > 0) {
                    results.add(res.trim().toLowerCase())
                }
            } catch {
                // Ignore lookup error
            }

            if (typeof i18nInstance.t === 'function') {
                try {
                    const translated = i18nInstance.t(key, { lng, defaultValue: '' })
                    if (typeof translated === 'string' && translated.trim().length > 0 && translated !== key) {
                        results.add(translated.trim().toLowerCase())
                    }
                } catch {
                    // Ignore translation error
                }
            }
        }
    }

    return Array.from(results)
}

/**
 * Checks if a sub-item matches the search query across all languages, keywords, and descriptions.
 */
export function matchSettingsSubItem(
    item: SettingsSubItem,
    query: string,
    t?: (key: string, options?: any) => string,
    i18nInstance: any = i18n
): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true

    if (item.id.toLowerCase().includes(q)) return true
    if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return true

    const labelTranslations = getTranslationsAcrossLanguages(item.labelKey, t, i18nInstance)
    if (labelTranslations.some((text) => text.includes(q))) return true

    if (item.descriptionKey) {
        const descTranslations = getTranslationsAcrossLanguages(item.descriptionKey, t, i18nInstance)
        if (descTranslations.some((text) => text.includes(q))) return true
    }

    return false
}

/**
 * Searches and returns matching settings sections along with their matching sub-items.
 * Searches across all languages, labels, descriptions, and keywords.
 */
export function searchSettingsSections(
    sections: readonly SettingsSectionContribution[],
    query: string,
    t?: (key: string, options?: any) => string,
    i18nInstance: any = i18n
): readonly MatchedSettingsSection[] {
    const q = query.trim().toLowerCase()
    if (!q) {
        return sections.map((section) => ({
            section,
            matchedItems: section.items ? [...section.items] : [],
        }))
    }

    const results: MatchedSettingsSection[] = []

    for (const section of sections) {
        // Find matching sub-items
        const matchedItems = (section.items ?? []).filter((item) =>
            matchSettingsSubItem(item, q, t, i18nInstance)
        )

        // Check if section itself matches
        let sectionMatches = false
        if (section.id.toLowerCase().includes(q)) {
            sectionMatches = true
        } else if (section.keywords?.some((k) => k.toLowerCase().includes(q))) {
            sectionMatches = true
        } else {
            const labelTranslations = getTranslationsAcrossLanguages(section.labelKey, t, i18nInstance)
            if (labelTranslations.some((text) => text.includes(q))) {
                sectionMatches = true
            }
        }

        if (sectionMatches || matchedItems.length > 0) {
            results.push({
                section,
                matchedItems,
            })
        }
    }

    return results
}

/**
 * Filters settings navigation groups based on search query matching label, section ID,
 * keywords, or sub-items across all supported languages.
 */
export function filterSettingsNavigation(
    groups: readonly SettingsNavGroup[],
    query: string,
    t: (key: string, options?: any) => string,
    i18nInstance: any = i18n
): readonly SettingsNavGroup[] {
    const q = query.trim().toLowerCase()
    if (!q) return groups

    return groups
        .map((group) => ({
            ...group,
            sections: group.sections.filter((section) => {
                if (section.id.toLowerCase().includes(q)) return true
                if (section.keywords?.some((k) => k.toLowerCase().includes(q))) return true

                const labelTranslations = getTranslationsAcrossLanguages(section.labelKey, t, i18nInstance)
                if (labelTranslations.some((text) => text.includes(q))) return true

                if (section.items && section.items.some((item) => matchSettingsSubItem(item, q, t, i18nInstance))) {
                    return true
                }

                return false
            }),
        }))
        .filter((group) => group.sections.length > 0)
}

/**
 * React hook subscribing to settings navigation groups and sections.
 */
export function useSettingsNavigation(
    registry: RendererRegistry = rendererRegistry
): readonly SettingsNavGroup[] {
    const subscribe = useCallback(
        (listener: () => void) => {
            const un1 = registry.subscribe('settings', listener)
            const un2 = registry.subscribe('settings-group', listener)
            return () => {
                un1()
                un2()
            }
        },
        [registry]
    )

    const getSnapshot = useCallback(
        () => selectSettingsNavigation(registry),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to all settings section contributions.
 */
export function useSettingsSections(
    registry: RendererRegistry = rendererRegistry
): readonly SettingsSectionContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('settings', listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getSettingsSections(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook finding a specific settings section by ID.
 */
export function useSettingsSection(
    sectionId: string,
    registry: RendererRegistry = rendererRegistry
): SettingsSectionContribution | undefined {
    const sections = useSettingsSections(registry)
    return sections.find((s) => s.id === sectionId)
}
