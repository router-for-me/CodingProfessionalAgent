import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
    formatShortcutBinding,
    normalizeKeyName,
    type ShortcutKeyBinding,
} from './shortcutsData.js'

export function getKeyNameFromEvent(
    event: ReactKeyboardEvent | KeyboardEvent,
): string | null {
    const key = event.key
    // Ignore lone modifier keys
    if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(key)) {
        return null
    }

    if (event.code.startsWith('Key')) {
        return event.code.slice(3).toUpperCase()
    }
    if (event.code.startsWith('Digit')) {
        return event.code.slice(5)
    }

    switch (event.code) {
        case 'ArrowLeft':
            return 'ArrowLeft'
        case 'ArrowRight':
            return 'ArrowRight'
        case 'ArrowUp':
            return 'ArrowUp'
        case 'ArrowDown':
            return 'ArrowDown'
        case 'Enter':
            return 'Enter'
        case 'Escape':
            return 'Escape'
        case 'Tab':
            return 'Tab'
        case 'Space':
            return 'Space'
        case 'Backspace':
            return 'Backspace'
        case 'Delete':
            return 'Delete'
        case 'Backquote':
            return '`'
        case 'BracketLeft':
            return '['
        case 'BracketRight':
            return ']'
        case 'Comma':
            return ','
        case 'Period':
            return '.'
        case 'Slash':
            return '/'
        case 'Backslash':
            return '\\'
        case 'Semicolon':
            return ';'
        case 'Quote':
            return "'"
        case 'Minus':
            return '-'
        case 'Equal':
            return '='
        default:
            return normalizeKeyName(key)
    }
}

export function eventToShortcutBinding(
    event: ReactKeyboardEvent | KeyboardEvent,
): ShortcutKeyBinding | null {
    const keyName = getKeyNameFromEvent(event)
    if (!keyName) return null

    return {
        ctrl: Boolean(event.ctrlKey),
        alt: Boolean(event.altKey),
        shift: Boolean(event.shiftKey),
        meta: Boolean(event.metaKey),
        key: keyName,
    }
}

export function formatKeyEvent(
    event: ReactKeyboardEvent | KeyboardEvent,
): string | null {
    const binding = eventToShortcutBinding(event)
    if (!binding) return null
    return formatShortcutBinding(binding)
}
