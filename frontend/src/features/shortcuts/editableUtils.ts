/**
 * Utility functions to check for editable elements and determine whether
 * global keyboard shortcuts should yield to native input behavior.
 */

/**
 * Determine whether a DOM node or event target is inside an editable text area
 * (input, textarea, contenteditable, role="textbox").
 */
export function isEditableElement(target: EventTarget | null): boolean {
    if (!target) return false

    // Resolve element if target is a text node
    const element =
        target instanceof HTMLElement
            ? target
            : (target as Node).parentElement instanceof HTMLElement
            ? (target as Node).parentElement
            : null

    if (!element) return false

    // 1. Native input elements (except non-text controls like checkboxes, buttons, etc.)
    if (element instanceof HTMLInputElement) {
        const type = (element.type || 'text').toLowerCase()
        return ![
            'button',
            'checkbox',
            'radio',
            'range',
            'reset',
            'submit',
            'color',
            'file',
            'image',
        ].includes(type)
    }

    // 2. Native textarea elements
    if (element instanceof HTMLTextAreaElement) {
        return true
    }

    // 3. Traverse element and its ancestors for contenteditable or role="textbox"
    let curr: HTMLElement | null = element
    while (curr) {
        if (
            curr.isContentEditable ||
            curr.contentEditable === 'true' ||
            curr.contentEditable === 'plaintext-only' ||
            (curr.hasAttribute &&
                curr.hasAttribute('contenteditable') &&
                curr.getAttribute('contenteditable') !== 'false')
        ) {
            return true
        }
        if (curr.getAttribute && curr.getAttribute('role') === 'textbox') {
            return true
        }
        curr = curr.parentElement
    }

    return false
}

/**
 * Check if either the event target or the current active element is an editable target.
 */
export function isEventOrFocusInEditable(event: KeyboardEvent): boolean {
    if (isEditableElement(event.target)) {
        return true
    }
    if (
        typeof document !== 'undefined' &&
        document.activeElement &&
        isEditableElement(document.activeElement)
    ) {
        return true
    }
    return false
}

/**
 * Determine whether a keydown event inside an editable element represents
 * native text editing, navigation, selection, deletion, or IME composition
 * that must NOT be intercepted by global application shortcuts.
 */
export function shouldBypassGlobalShortcutInEditable(event: KeyboardEvent): boolean {
    // 1. IME composition (e.g. Chinese, Japanese, Korean candidate selection)
    if (event.isComposing || event.keyCode === 229) {
        return true
    }

    const key = event.key

    // 2. Cursor navigation and selection (Arrow keys, Home, End, PageUp, PageDown)
    // On macOS: Cmd+Left/Right (line start/end), Opt+Left/Right (word jump), Cmd+Up/Down (doc start/end),
    // plus Shift variations for text selection.
    // On Windows/Linux: Ctrl+Left/Right, Home/End, etc.
    const isNavigationKey =
        key === 'ArrowLeft' ||
        key === 'ArrowRight' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'Home' ||
        key === 'End' ||
        key === 'PageUp' ||
        key === 'PageDown'

    if (isNavigationKey) {
        return true
    }

    // 3. Deletion keys (Backspace, Delete with any modifier like Cmd/Opt/Ctrl)
    if (key === 'Backspace' || key === 'Delete') {
        return true
    }

    // 4. Standard text editing operations (Select All, Copy, Cut, Paste, Undo, Redo)
    const isModOnly = (event.metaKey || event.ctrlKey) && !event.altKey
    if (isModOnly) {
        const lowerKey = key.toLowerCase()
        if (
            lowerKey === 'a' || // Select All
            lowerKey === 'c' || // Copy
            lowerKey === 'v' || // Paste
            lowerKey === 'x' || // Cut
            lowerKey === 'z' || // Undo / Redo (with Shift)
            lowerKey === 'y' // Redo (Windows)
        ) {
            return true
        }
    }

    // 5. Plain character typing without Meta/Ctrl modifiers
    // Shift+Tab is explicitly used by the global cycle-reasoning-effort shortcut
    if (key === 'Tab' && event.shiftKey) {
        return false
    }

    // Escape is a control key used for canceling/stopping and should not be bypassed as plain text typing
    if (key === 'Escape') {
        return false
    }

    if (!event.metaKey && !event.ctrlKey) {
        return true
    }

    return false
}
