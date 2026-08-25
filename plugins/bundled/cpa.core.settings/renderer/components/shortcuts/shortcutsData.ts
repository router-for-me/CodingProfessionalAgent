import {
    isShortcutDifferentFromDefault as apiIsShortcutDifferentFromDefault,
    generateSavedShortcutsConfig as apiGenerateSavedShortcutsConfig,
    extractShortcutsOverrides as apiExtractShortcutsOverrides,
    normalizeSavedShortcutsConfig as apiNormalizeSavedShortcutsConfig,
    type ShortcutItem,
    type ShortcutKeyBinding,
    type SavedShortcutItem,
} from '@cpa/plugin-api'
import { DEFAULT_SHORTCUT_ITEMS } from '../../../shared/defaultShortcuts.js'

export * from '@cpa/plugin-api'
export { DEFAULT_SHORTCUT_ITEMS, IMPLEMENTED_SHORTCUT_IDS } from '../../../shared/defaultShortcuts.js'

export function isShortcutDifferentFromDefault(
    id: string,
    shortcuts: ShortcutKeyBinding[]
): boolean {
    return apiIsShortcutDifferentFromDefault(id, shortcuts, DEFAULT_SHORTCUT_ITEMS)
}

export function generateSavedShortcutsConfig(
    overrides?: Record<string, unknown> | SavedShortcutItem[]
): SavedShortcutItem[] {
    return apiGenerateSavedShortcutsConfig(overrides, DEFAULT_SHORTCUT_ITEMS)
}

export const generateShortcutsConfig = generateSavedShortcutsConfig

export function normalizeSavedShortcutsConfig(value: unknown): SavedShortcutItem[] {
    return apiNormalizeSavedShortcutsConfig(value, DEFAULT_SHORTCUT_ITEMS)
}

export const normalizeShortcutsConfig = normalizeSavedShortcutsConfig

export function extractShortcutsOverrides(
    value: unknown
): Record<string, ShortcutKeyBinding[]> {
    return apiExtractShortcutsOverrides(value, DEFAULT_SHORTCUT_ITEMS)
}

/**
 * Returns shortcut items dynamically read from actions merged with static defaults.
 */
export function getRegisteredShortcutItems(): ShortcutItem[] {
    const itemMap = new Map<string, ShortcutItem>()

    // Start with static items
    for (const item of DEFAULT_SHORTCUT_ITEMS) {
        itemMap.set(item.id, item)
    }

    return Array.from(itemMap.values())
}
