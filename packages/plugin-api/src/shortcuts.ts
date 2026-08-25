/**
* Keyboard Shortcuts Schema, Default Definitions, and Platform Normalizers
* Universal Plugin Platform
*/

export interface ShortcutKeyBinding {
    ctrl: boolean
    alt: boolean
    shift: boolean
    meta: boolean
    key: string
}

export interface SavedShortcutItem {
    id: string
    shortcuts: ShortcutKeyBinding[]
}

export interface ShortcutItem {
    id: string
    titleKey: string
    titleZh: string
    titleEn: string
    descKey: string
    descZh: string
    descEn: string
    defaultShortcuts: ShortcutKeyBinding[]
}

export type ShortcutsMap = Record<string, ShortcutKeyBinding[]>
export type ShortcutsConfig = SavedShortcutItem[] | ShortcutsMap


export const IMPLEMENTED_SHORTCUT_IDS = new Set<string>()

export const DEFAULT_SHORTCUT_ITEMS: ShortcutItem[] = []

export function normalizeKeyName(raw: string): string {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    const upper = trimmed.toUpperCase()
    switch (upper) {
        case '⏎':
        case 'ENTER':
        case 'RETURN':
            return 'Enter'
        case 'ESC':
        case 'ESCAPE':
            return 'Escape'
        case 'TAB':
            return 'Tab'
        case 'SPACE':
            return 'Space'
        case '⌫':
        case 'BACKSPACE':
            return 'Backspace'
        case 'DEL':
        case 'DELETE':
            return 'Delete'
        case 'LEFT':
        case 'ARROWLEFT':
            return 'ArrowLeft'
        case 'RIGHT':
        case 'ARROWRIGHT':
            return 'ArrowRight'
        case 'UP':
        case 'ARROWUP':
            return 'ArrowUp'
        case 'DOWN':
        case 'ARROWDOWN':
            return 'ArrowDown'
        default:
            return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed
    }
}

export function parseShortcutString(str: string): ShortcutKeyBinding | null {
    if (!str || typeof str !== 'string') return null
    const s = str.trim()
    if (!s) return null

    const hasCmdSymbol = s.includes('⌘')
    const hasCtrlSymbol = s.includes('⌃')
    const hasAltSymbol = s.includes('⌥')
    const hasShiftSymbol = s.includes('⇧')

    const lower = s.toLowerCase()
    const hasCmdWord = lower.includes('cmd') || lower.includes('meta') || lower.includes('command')
    const hasCtrlWord = lower.includes('ctrl') || lower.includes('control')
    const hasAltWord = lower.includes('alt') || lower.includes('option')
    const hasShiftWord = lower.includes('shift')

    const meta = hasCmdSymbol || hasCmdWord
    const ctrl = hasCtrlSymbol || hasCtrlWord
    const alt = hasAltSymbol || hasAltWord
    const shift = hasShiftSymbol || hasShiftWord

    let keyPart = s
        .replace(/[⌘⌃⌥⇧]/g, '')
        .replace(/\b(cmd|command|meta|ctrl|control|alt|option|shift)\b/gi, '')
        .replace(/[+\-\s]/g, '')

    if (!keyPart) {
        if (s.includes('+') && s.endsWith('+')) {
            keyPart = '+'
        } else if (s.includes('-') && s.endsWith('-')) {
            keyPart = '-'
        } else {
            return null
        }
    }

    const canonicalKey = normalizeKeyName(keyPart)
    if (!canonicalKey) return null

    return {
        ctrl,
        alt,
        shift,
        meta,
        key: canonicalKey,
    }
}

export function normalizeShortcutBinding(input: unknown): ShortcutKeyBinding | null {
    if (!input) return null
    if (typeof input === 'string') {
        return parseShortcutString(input)
    }
    if (
        typeof input === 'object' &&
        'key' in input &&
        typeof (input as Record<string, unknown>).key === 'string'
    ) {
        const obj = input as Record<string, unknown>
        const key = normalizeKeyName(String(obj.key))
        if (!key) return null
        return {
            ctrl: Boolean(obj.ctrl),
            alt: Boolean(obj.alt),
            shift: Boolean(obj.shift),
            meta: Boolean(obj.meta),
            key,
        }
    }
    return null
}

export function getDisplayKeyName(key: string): string {
    const upper = key.toUpperCase()
    switch (upper) {
        case 'ENTER':
        case 'RETURN':
        case '⏎':
            return '⏎'
        case 'ESCAPE':
        case 'ESC':
            return 'Esc'
        case 'TAB':
            return 'Tab'
        case 'SPACE':
            return 'Space'
        case 'BACKSPACE':
        case '⌫':
            return '⌫'
        case 'DELETE':
        case 'DEL':
            return 'Del'
        case 'ARROWLEFT':
        case 'LEFT':
            return 'Left'
        case 'ARROWRIGHT':
        case 'RIGHT':
            return 'Right'
        case 'ARROWUP':
        case 'UP':
            return 'Up'
        case 'ARROWDOWN':
        case 'DOWN':
            return 'Down'
        default:
            return key
    }
}

export const formatShortcutKey = formatShortcutBinding

export function formatShortcutBinding(
    binding: ShortcutKeyBinding,
    isMac = true
): string {
    const keyDisplay = getDisplayKeyName(binding.key)
    if (isMac) {
        const parts: string[] = []
        if (binding.ctrl) parts.push('⌃')
        if (binding.alt) parts.push('⌥')
        if (binding.shift) parts.push('⇧')
        if (binding.meta) parts.push('⌘')
        return parts.join('') + keyDisplay
    } else {
        const parts: string[] = []
        if (binding.ctrl || binding.meta) parts.push('Ctrl')
        if (binding.alt) parts.push('Alt')
        if (binding.shift) parts.push('Shift')
        parts.push(keyDisplay)
        return parts.join('+')
    }
}

export function areShortcutBindingsEqual(
    a: ShortcutKeyBinding | null | undefined,
    b: ShortcutKeyBinding | null | undefined
): boolean {
    if (!a || !b) return a === b
    return (
        Boolean(a.ctrl) === Boolean(b.ctrl) &&
        Boolean(a.alt) === Boolean(b.alt) &&
        Boolean(a.shift) === Boolean(b.shift) &&
        Boolean(a.meta) === Boolean(b.meta) &&
        a.key.toUpperCase() === b.key.toUpperCase()
    )
}

export function areShortcutListsEqual(
    a: ShortcutKeyBinding[] | null | undefined,
    b: ShortcutKeyBinding[] | null | undefined
): boolean {
    if (!a || !b) return a === b
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (!areShortcutBindingsEqual(a[i], b[i])) {
            return false
        }
    }
    return true
}

export function isShortcutDifferentFromDefault(
    id: string,
    shortcuts: ShortcutKeyBinding[],
    defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS
): boolean {
    const defaultItem = defaultItems.find((item) => item.id === id)
    if (!defaultItem) {
        return shortcuts.length > 0
    }
    return !areShortcutListsEqual(shortcuts, defaultItem.defaultShortcuts)
}

/**
* Builds SavedShortcutItem[] containing only entries that differ from system defaults.
* Note: Only id and shortcuts fields are included in each saved item.
*/
export function generateSavedShortcutsConfig(
    overrides?: Record<string, unknown> | SavedShortcutItem[],
    defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS
): SavedShortcutItem[] {
    if (!overrides) return []

    const result: SavedShortcutItem[] = []

    if (Array.isArray(overrides)) {
        for (const rawItem of overrides as unknown[]) {
            if (rawItem && typeof rawItem === 'object' && 'id' in rawItem && typeof (rawItem as Record<string, unknown>).id === 'string') {
                const itemObj = rawItem as Record<string, unknown>
                const id = String(itemObj.id)
                const rawShortcuts =
                    'shortcuts' in itemObj
                        ? itemObj.shortcuts
                        : 'defaultShortcuts' in itemObj
                            ? itemObj.defaultShortcuts
                            : undefined
                if (Array.isArray(rawShortcuts)) {
                    const shortcuts = rawShortcuts
                        .map((s) => normalizeShortcutBinding(s))
                        .filter((s): s is ShortcutKeyBinding => s !== null)
                    if (isShortcutDifferentFromDefault(id, shortcuts, defaultItems)) {
                        result.push({
                            id,
                            shortcuts,
                        })
                    }
                }
            }
        }
        return result
    }

    if (typeof overrides === 'object') {
        for (const [id, raw] of Object.entries(overrides)) {
            if (Array.isArray(raw)) {
                const shortcuts = raw
                    .map((s) => normalizeShortcutBinding(s))
                    .filter((s): s is ShortcutKeyBinding => s !== null)

                if (isShortcutDifferentFromDefault(id, shortcuts, defaultItems)) {
                    result.push({
                        id,
                        shortcuts,
                    })
                }
            }
        }
        return result
    }

    return []
}

/**
* Backwards compatibility alias for generateSavedShortcutsConfig.
*/
export const generateShortcutsConfig = generateSavedShortcutsConfig

/**
* Normalizes shortcuts input into SavedShortcutItem[] containing only diffs from defaults.
*/
export function normalizeSavedShortcutsConfig(
    value: unknown,
    defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS
): SavedShortcutItem[] {
    if (Array.isArray(value)) {
        return generateSavedShortcutsConfig(value as SavedShortcutItem[], defaultItems)
    }

    if (value && typeof value === 'object') {
        return generateSavedShortcutsConfig(value as Record<string, unknown>, defaultItems)
    }

    return []
}

/**
* Backwards compatibility alias for normalizeSavedShortcutsConfig.
*/
export const normalizeShortcutsConfig = normalizeSavedShortcutsConfig

/**
* Extracts overrides map Record<string, ShortcutKeyBinding[]> containing only diffs from defaults
* from SavedShortcutItem[] or ShortcutsMap.
*/
export function extractShortcutsOverrides(
    value: unknown,
    defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS
): Record<string, ShortcutKeyBinding[]> {
    const overrides: Record<string, ShortcutKeyBinding[]> = {}
    if (Array.isArray(value)) {
        for (const item of value) {
            if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
                if (Array.isArray(item.shortcuts)) {
                    const shortcuts = item.shortcuts
                        .map((s: unknown) => normalizeShortcutBinding(s))
                        .filter((s: unknown): s is ShortcutKeyBinding => s !== null)
                    if (isShortcutDifferentFromDefault(item.id, shortcuts, defaultItems)) {
                        overrides[item.id] = shortcuts
                    }
                }
            }
        }
        return overrides
    }

    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (Array.isArray(v)) {
                const shortcuts = v
                    .map((s: unknown) => normalizeShortcutBinding(s))
                    .filter((s: unknown): s is ShortcutKeyBinding => s !== null)
                if (isShortcutDifferentFromDefault(k, shortcuts, defaultItems)) {
                    overrides[k] = shortcuts
                }
            }
        }
        return overrides
    }

    return overrides
}

export interface KeyboardEventLike {
        key: string
        code?: string
        metaKey?: boolean
        ctrlKey?: boolean
        altKey?: boolean
        shiftKey?: boolean
}

/**
* Determine if the runtime platform is macOS.
*/
export function isMacPlatform(): boolean {
        if (typeof navigator === 'undefined') return false
        return (
                /mac|iphone|ipad|ipod/i.test(navigator.platform || '') ||
                /mac/i.test(navigator.userAgent || '')
        )
}

/**
* Normalizes a key identifier to compare against KeyboardEvent.
*/
export function matchKeyPart(event: KeyboardEventLike, keyPart: string): boolean {
        const raw = keyPart.trim()
        if (!raw) return false

        const upper = raw.toUpperCase()
        const eventKeyUpper = event.key.toUpperCase()

        // 1. Single character / letter / digit / punctuation
        if (raw.length === 1) {
                if (eventKeyUpper === upper) return true
                if (event.code === `Key${upper}` || event.code === `Digit${upper}`) return true
                if (event.key === raw) return true
                return false
        }

        // 2. Special symbols / named keys
        switch (upper) {
                case '⏎':
                case 'ENTER':
                case 'RETURN':
                        return event.key === 'Enter' || event.code === 'Enter'
                case 'ESC':
                case 'ESCAPE':
                        return event.key === 'Escape' || event.code === 'Escape'
                case 'TAB':
                        return event.key === 'Tab' || event.code === 'Tab'
                case 'SPACE':
                        return event.key === ' ' || event.code === 'Space'
                case '⌫':
                case 'BACKSPACE':
                        return event.key === 'Backspace' || event.code === 'Backspace'
                case 'DEL':
                case 'DELETE':
                        return event.key === 'Delete' || event.code === 'Delete'
                case 'LEFT':
                case 'ARROWLEFT':
                        return event.key === 'ArrowLeft' || event.code === 'ArrowLeft'
                case 'RIGHT':
                case 'ARROWRIGHT':
                        return event.key === 'ArrowRight' || event.code === 'ArrowRight'
                case 'UP':
                case 'ARROWUP':
                        return event.key === 'ArrowUp' || event.code === 'ArrowUp'
                case 'DOWN':
                case 'ARROWDOWN':
                        return event.key === 'ArrowDown' || event.code === 'ArrowDown'
                default:
                        return event.key.toLowerCase() === raw.toLowerCase()
        }
}

/**
* Checks whether a KeyboardEvent matches a given shortcut descriptor (ShortcutKeyBinding or string).
*/
export function matchShortcut(
        event: KeyboardEventLike,
        shortcut: ShortcutKeyBinding | string
): boolean {
        if (!shortcut) return false

        const binding: ShortcutKeyBinding | null =
                typeof shortcut === 'string'
                        ? parseShortcutString(shortcut)
                        : normalizeShortcutBinding(shortcut)

        if (!binding) return false

        const isMac = isMacPlatform()

        if (binding.meta && !binding.ctrl) {
                if (isMac) {
                        if (!event.metaKey || event.ctrlKey) return false
                } else {
                        // On non-Mac, allow either Meta or Ctrl to trigger Cmd-based shortcuts
                        if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)) {
                                return false
                        }
                }
        } else if (binding.meta && binding.ctrl) {
                if (!event.metaKey || !event.ctrlKey) return false
        } else if (!binding.meta && binding.ctrl) {
                if (event.metaKey || !event.ctrlKey) return false
        } else {
                if (event.metaKey || event.ctrlKey) return false
        }

        if (Boolean(event.altKey) !== binding.alt) return false
        if (Boolean(event.shiftKey) !== binding.shift) return false

        return matchKeyPart(event, binding.key)
}

/**
* Returns the effective shortcut array for a given shortcut item id,
* taking custom overrides into account.
*/
export function getEffectiveShortcuts(
        shortcutId: string,
        customShortcuts?: Record<string, ShortcutKeyBinding[] | unknown> | null,
        defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS,
        fallbackShortcuts?: readonly (ShortcutKeyBinding | string)[]
): ShortcutKeyBinding[] {
        if (
                customShortcuts &&
                Object.prototype.hasOwnProperty.call(customShortcuts, shortcutId)
        ) {
                const raw = customShortcuts[shortcutId]
                if (Array.isArray(raw)) {
                        return raw
                                .map((s) => normalizeShortcutBinding(s))
                                .filter((s): s is ShortcutKeyBinding => s !== null)
                }
                return []
        }
        const defaultItem = defaultItems.find(
                (item) => item.id === shortcutId
        )
        if (defaultItem) {
                return defaultItem.defaultShortcuts
        }
        if (fallbackShortcuts && fallbackShortcuts.length > 0) {
                return fallbackShortcuts
                        .map((s) => (typeof s === "string" ? parseShortcutString(s) : normalizeShortcutBinding(s)))
                        .filter((s): s is ShortcutKeyBinding => s !== null)
        }
        return []
}

/**
* Checks whether a KeyboardEvent matches any active shortcut for the given shortcut id.
*/
export function matchesShortcutId(
        event: KeyboardEventLike,
        shortcutId: string,
        customShortcuts?: Record<string, ShortcutKeyBinding[] | unknown> | null,
        defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS,
        fallbackShortcuts?: readonly (ShortcutKeyBinding | string)[]
): boolean {
        const shortcuts = getEffectiveShortcuts(shortcutId, customShortcuts, defaultItems, fallbackShortcuts)
        if (shortcuts.length === 0) return false
        return shortcuts.some((sc) => matchShortcut(event, sc))
}

/**
* Formats the primary effective shortcut for a given item id into a display string.
*/
export function getEffectiveShortcutDisplayString(
    shortcutId: string,
    customShortcuts?: Record<string, ShortcutKeyBinding[] | unknown> | null,
    isMac = true,
    defaultItems: ShortcutItem[] = DEFAULT_SHORTCUT_ITEMS,
    fallbackShortcuts?: readonly (ShortcutKeyBinding | string)[]
): string | null {
    const shortcuts = getEffectiveShortcuts(shortcutId, customShortcuts, defaultItems, fallbackShortcuts)
    if (shortcuts.length === 0) return null
    return formatShortcutBinding(shortcuts[0], isMac)
}
