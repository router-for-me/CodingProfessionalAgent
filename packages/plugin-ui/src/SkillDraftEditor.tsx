import {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
    type ReactElement,
    type RefObject,
} from 'react'
import type { SkillTrigger } from '@cpa/plugin-api'
import { cn } from './cn.js'
import {
    parseSkillDraft,
    formatSkillDraftForClipboard,
    parseReferencedSkillDraft,
    formatSkillDisplayName,
    skillReferencesFromParts,
    serializeSkillDraft,
    SKILL_DRAFT_CLIPBOARD_MIME,
    writeSkillDraftClipboard,
    type SkillDraftPart,
    type SkillNameRef,
} from './skillDraft.js'

export interface SkillDraftEditorProps {
    value: string
    skills?: readonly SkillNameRef[]
    trigger?: SkillTrigger
    legacyValue?: boolean
    allowSlashToken?: boolean
    reservedSlashNames?: readonly string[]
    references?: readonly { start: number; name: string }[]
    disabled?: boolean
    placeholder?: string
    ariaLabel?: string
    testId?: string
    className?: string
    ariaControls?: string
    ariaExpanded?: boolean
    ariaActivedescendant?: string
    ariaAutocomplete?: 'list'
    role?: string
    onChange: (value: string, cursor: number) => void
    onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
    onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void
    editorRef?: RefObject<HTMLDivElement | null>
    cursor?: number
    maxHeight?: number
    minHeight?: number
    autoResize?: boolean
    autoFocus?: boolean
}

const ZWSP = '\u200b'
const DEFAULT_MAX_HEIGHT = 160
const DEFAULT_MIN_HEIGHT = 22
const MAX_HISTORY_LENGTH = 100
const TYPING_DEBOUNCE_MS = 500

interface HistoryEntry {
    value: string
    cursor: number
    references?: { start: number; name: string }[]
}

const BOX_ICON_PATHS = [
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
    'm3.3 7 8.7 5 8.7-5',
    'M12 22V12',
]

export function SkillDraftEditor({
    value,
    skills = [],
    trigger = '$',
    legacyValue = false,
    allowSlashToken = false,
    reservedSlashNames = [],
    references,
    disabled = false,
    placeholder,
    ariaLabel,
    testId = 'composer-input',
    className,
    ariaControls,
    ariaExpanded,
    ariaActivedescendant,
    ariaAutocomplete,
    role,
    onChange,
    onKeyDown,
    onPaste,
    editorRef,
    cursor,
    maxHeight = DEFAULT_MAX_HEIGHT,
    minHeight,
    autoResize = true,
    autoFocus = false,
}: SkillDraftEditorProps): ReactElement {
    const innerRef = useRef<HTMLDivElement>(null)
    const rootRef = editorRef ?? innerRef
    const minHeightRef = useRef<number | null>(minHeight ?? null)
    const lastEmittedRef = useRef(value)
    const composingRef = useRef(false)
    const [isComposing, setIsComposing] = useState(false)
    const skillsRef = useRef(skills)
    skillsRef.current = skills
    const triggerRef = useRef(trigger)
    triggerRef.current = trigger
    const reservedRef = useRef(reservedSlashNames)
    reservedRef.current = reservedSlashNames
    const onChangeRef = useRef(onChange)
    onChangeRef.current = onChange
    const cursorRef = useRef(cursor)
    cursorRef.current = cursor

    const historyRef = useRef<HistoryEntry[]>([{ value, cursor: cursor ?? value.length, references: references ? [...references] : undefined }])
    const historyIndexRef = useRef<number>(0)
    const lastTypingTimeRef = useRef<number>(0)
    const isApplyingHistoryRef = useRef<boolean>(false)

    useEffect(() => {
        if (autoFocus && !disabled) {
            const root = rootRef.current
            if (root) {
                root.focus()
                try {
                    const selection = window.getSelection()
                    if (selection && root.childNodes.length > 0) {
                        const range = document.createRange()
                        range.selectNodeContents(root)
                        range.collapse(false)
                        selection.removeAllRanges()
                        selection.addRange(range)
                    }
                } catch {}
            }
        }
    }, [autoFocus, disabled])

    const resize = () => {
        if (!autoResize) return
        adjustEditorHeight(rootRef.current, minHeightRef, maxHeight, minHeight)
    }

    const pushHistory = (
        nextValue: string,
        nextCursor: number,
        forceNew: boolean = false,
        explicitReferences?: { start: number; name: string }[],
    ) => {
        const now = Date.now()
        const history = historyRef.current
        const index = historyIndexRef.current
        const current = history[index]
        const references = explicitReferences ?? (rootRef.current ? skillReferencesFromParts(partsFromDom(rootRef.current)) : undefined)

        if (current && current.value === nextValue) {
            history[index] = { value: nextValue, cursor: nextCursor, references }
            return
        }

        const elapsed = now - lastTypingTimeRef.current
        lastTypingTimeRef.current = now
        const isTyping = !forceNew && elapsed < TYPING_DEBOUNCE_MS
        const isWordBoundary =
            nextValue.endsWith(' ') ||
            nextValue.endsWith('\n') ||
            (current && (current.value.endsWith(' ') || current.value.endsWith('\n')))

        if (isTyping && current && !isWordBoundary) {
            history[index] = { value: nextValue, cursor: nextCursor, references }
        } else {
            const nextHistory = history.slice(0, index + 1)
            nextHistory.push({ value: nextValue, cursor: nextCursor, references })
            if (nextHistory.length > MAX_HISTORY_LENGTH) {
                nextHistory.shift()
            }
            historyRef.current = nextHistory
            historyIndexRef.current = nextHistory.length - 1
        }
    }

    const applyHistoryEntry = (entry: HistoryEntry) => {
        const root = rootRef.current
        if (!root) return
        isApplyingHistoryRef.current = true
        lastEmittedRef.current = entry.value
        const parts = entry.references
            ? parseReferencedSkillDraft(entry.value, entry.references)
            : parseSkillDraft(entry.value, skillsRef.current, undefined, triggerRef.current, legacyValue)
        writeDraftDom(root, parts)
        setDraftCaret(root, entry.cursor)
        resize()
        onChangeRef.current(entry.value, Math.min(entry.cursor, entry.value.length))
    }

    const handleUndo = () => {
        if (historyIndexRef.current <= 0) return
        historyIndexRef.current -= 1
        const entry = historyRef.current[historyIndexRef.current]
        if (entry) {
            applyHistoryEntry(entry)
        }
    }

    const handleRedo = () => {
        if (historyIndexRef.current >= historyRef.current.length - 1) return
        historyIndexRef.current += 1
        const entry = historyRef.current[historyIndexRef.current]
        if (entry) {
            applyHistoryEntry(entry)
        }
    }

    const insertNewline = () => {
        if (disabled) return
        const root = rootRef.current
        if (!root) return

        const { start, end } = getSelectionOffsets(root)
        const currentText = readDraftDom(root).text
        const parts = replaceDraftParts(partsFromDom(root), start, end, '\n', skillsRef.current, triggerRef.current, false, reservedRef.current)
        const nextText = serializeSkillDraft(parts)
        const nextCursor = nextText.length - currentText.slice(end).length
        pushHistory(nextText, nextCursor, true, skillReferencesFromParts(parts))
        writeDraftDom(root, parts)
        setDraftCaret(root, nextCursor)
        resize()
        scrollToActivePosition(root)

        lastEmittedRef.current = nextText
        onChangeRef.current(nextText, nextCursor)
    }

    useLayoutEffect(() => {
        const root = rootRef.current
        if (!root) return

        if (isApplyingHistoryRef.current) {
            isApplyingHistoryRef.current = false
            resize()
            scrollToActivePosition(root)
            return
        }

        const referencesChanged = references !== undefined && !sameReferences(
            references,
            skillReferencesFromParts(partsFromDom(root)),
        )
        if (
            !referencesChanged &&
            value === lastEmittedRef.current &&
            root.childNodes.length > 0 &&
            (!value ? root.querySelector('br') === null : true)
        ) {
            resize()
            scrollToActivePosition(root)
            return
        }

        lastEmittedRef.current = value
        const nextCaret =
            typeof cursorRef.current === 'number' ? cursorRef.current : value.length
        const parts = references
            ? parseReferencedSkillDraft(value, references)
            : parseSkillDraft(value, skillsRef.current, undefined, trigger, legacyValue, reservedRef.current, allowSlashToken || legacyValue)
        writeDraftDom(root, parts)
        const canonical = serializeSkillDraft(parts)
        const canonicalCaret = canonical === value ? nextCaret : Math.min(
            serializeSkillDraft(parseSkillDraft(
                value.slice(0, nextCaret) + ' ', skillsRef.current, undefined,
                trigger, legacyValue, reservedRef.current, allowSlashToken || legacyValue,
            )).length - 1,
            canonical.length,
        )
        if (canonical !== value) {
            lastEmittedRef.current = canonical
            onChangeRef.current(canonical, canonicalCaret)
        }
        setDraftCaret(root, canonicalCaret)
        resize()
        scrollToActivePosition(root)

        const currentEntry = historyRef.current[historyIndexRef.current]
        if (!currentEntry || currentEntry.value !== value) {
            pushHistory(value, nextCaret, true)
        }
    }, [value, autoResize, maxHeight, minHeight, trigger, legacyValue, allowSlashToken, references])

    const emitFromDom = (forceNewHistory: boolean = false) => {
        const root = rootRef.current
        if (!root) return
        const read = readDraftDom(root)
        const parts = foldLiveParts(read.parts, skillsRef.current, triggerRef.current, read.cursor, reservedRef.current)
        const next = serializeSkillDraft(parts)
        const domNeedsTrailingZwsp =
            next.endsWith('\n') && !root.lastChild?.textContent?.endsWith(ZWSP)
        const domNeedsEmptyReset =
            !next && (root.querySelector('br') !== null || !hasContent(root))
        if (partsChanged(read.parts, parts) || domNeedsTrailingZwsp || domNeedsEmptyReset) {
            writeDraftDom(root, parts)
            setDraftCaret(root, read.cursor)
        }
        lastEmittedRef.current = next
        pushHistory(next, Math.min(read.cursor, next.length), forceNewHistory)
        onChangeRef.current(next, Math.min(read.cursor, next.length))
    }

    useEffect(() => {
        const root = rootRef.current
        if (!root) return

        const handleBeforeInput = (event: InputEvent) => {
            if (event.inputType === 'historyUndo') {
                event.preventDefault()
                handleUndo()
                return
            }
            if (event.inputType === 'historyRedo') {
                event.preventDefault()
                handleRedo()
                return
            }
        }

        root.addEventListener('beforeinput', handleBeforeInput as EventListener)
        return () => {
            root.removeEventListener('beforeinput', handleBeforeInput as EventListener)
        }
    }, [])

    return (
        <div
            ref={rootRef}
            data-testid={testId}
            data-value={value}
            data-placeholder={placeholder || undefined}
            aria-placeholder={placeholder || undefined}
            role={role ?? 'textbox'}
            aria-label={ariaLabel ?? placeholder}
            aria-multiline="true"
            aria-disabled={disabled}
            aria-controls={ariaControls}
            aria-expanded={ariaExpanded}
            aria-activedescendant={ariaActivedescendant}
            aria-autocomplete={ariaAutocomplete}
            contentEditable={!disabled}
            suppressContentEditableWarning
            className={cn(
                'max-h-40 min-h-[22px] min-w-0 flex-1 select-text overflow-x-hidden overflow-y-auto',
                'whitespace-pre-wrap break-words bg-transparent',
                'text-[16px] leading-6 sm:text-[14px] sm:leading-[22px] text-[var(--text-primary)]',
                'focus:outline-none focus:ring-0',
                disabled && 'opacity-60',
                !value && !isComposing &&
                    'relative before:pointer-events-none before:absolute before:top-0 before:left-0 before:text-[var(--text-muted)] before:content-[attr(data-placeholder)]',
                className,
            )}
            onInput={() => {
                resize()
                scrollToActivePosition(rootRef.current)
                if (composingRef.current) return
                emitFromDom()
            }}
            onCompositionStart={() => {
                composingRef.current = true
                setIsComposing(true)
                resize()
            }}
            onCompositionUpdate={() => {
                resize()
                scrollToActivePosition(rootRef.current)
            }}
            onCompositionEnd={() => {
                composingRef.current = false
                setIsComposing(false)
                resize()
                scrollToActivePosition(rootRef.current)
                emitFromDom(true)
            }}
            onKeyUp={() => {
                const root = rootRef.current
                if (!root) return
                onChangeRef.current(lastEmittedRef.current, caretSerializedOffset(root))
            }}
            onMouseUp={() => {
                const root = rootRef.current
                if (!root) return
                onChangeRef.current(lastEmittedRef.current, caretSerializedOffset(root))
            }}
            onKeyDown={(event) => {
                if (composingRef.current || event.nativeEvent?.isComposing || event.keyCode === 229) return
                if (isUndoShortcut(event)) {
                    event.preventDefault()
                    handleUndo()
                    return
                }
                if (isRedoShortcut(event)) {
                    event.preventDefault()
                    handleRedo()
                    return
                }
                if (event.key === 'Backspace' && tryDeleteChipBeforeCaret(rootRef.current)) {
                    event.preventDefault()
                    emitFromDom(true)
                    return
                }
                onKeyDown?.(event)
                if (
                    (event.key === 'Backspace' || event.key === 'Delete') &&
                    !event.defaultPrevented &&
                    !composingRef.current &&
                    !event.nativeEvent?.isComposing &&
                    event.keyCode !== 229
                ) {
                    if (isEditorEmpty(rootRef.current, value)) {
                        event.preventDefault()
                        return
                    }
                }
                if (
                    event.key === 'Enter' &&
                    !event.defaultPrevented &&
                    !composingRef.current &&
                    !event.nativeEvent?.isComposing &&
                    event.keyCode !== 229
                ) {
                    event.preventDefault()
                    insertNewline()
                }
            }}
            onCopy={(event) => handleClipboardCopy(event, rootRef.current, trigger)}
            onCut={(event) => {
                if (disabled) return
                const root = rootRef.current
                if (!root) return
                const { start, end } = getSelectionOffsets(root)
                if (start === end) return
                const selection = window.getSelection()
                const selected = selection?.rangeCount ? selection.getRangeAt(0).cloneContents() : null
                const selectedParts = selected ? partsFromDom(selected) : []
                if (event.clipboardData) {
                    writeSkillDraftClipboard(event.clipboardData, selectedParts, trigger)
                }
                event.preventDefault()
                const parts = replaceDraftParts(partsFromDom(root), start, end, '', skillsRef.current, triggerRef.current, false, reservedRef.current)
                const canonical = serializeSkillDraft(parts)
                const canonicalCursor = Math.min(start, canonical.length)
                pushHistory(canonical, canonicalCursor, true, skillReferencesFromParts(parts))
                writeDraftDom(root, parts)
                setDraftCaret(root, canonicalCursor)
                resize()
                lastEmittedRef.current = canonical
                onChangeRef.current(canonical, canonicalCursor)
            }}
            onPaste={(event) => {
                if (disabled) return
                onPaste?.(event)
                if (event.defaultPrevented) return
                const pasted = event.clipboardData?.getData('text/plain')
                if (pasted == null) return
                event.preventDefault()

                const root = rootRef.current
                if (!root) return

                const normalized = pasted.replace(/\r\n/g, '\n')
                const currentText = readDraftDom(root).text
                const { start, end } = getSelectionOffsets(root)

                const clipboardParts = readSkillClipboard(event.clipboardData, normalized, skillsRef.current)
                const parts = replaceDraftParts(partsFromDom(root), start, end, normalized, skillsRef.current, triggerRef.current, false, reservedRef.current, clipboardParts)
                const canonical = serializeSkillDraft(parts)
                const canonicalCursor = canonical.length - currentText.slice(end).length
                pushHistory(canonical, canonicalCursor, true, skillReferencesFromParts(parts))
                writeDraftDom(root, parts)
                setDraftCaret(root, canonicalCursor)
                resize()
                scrollToActivePosition(root)

                lastEmittedRef.current = canonical
                onChangeRef.current(canonical, Math.min(canonicalCursor, canonical.length))
            }}
            onMouseDown={(event) => {
                const chip = skillChipFromTarget(event.target)
                if (!chip) return
                event.preventDefault()
                selectNode(chip)
                rootRef.current?.focus()
            }}
        />
    )
}

function adjustEditorHeight(
    root: HTMLElement | null,
    minHeightRef: { current: number | null },
    maxHeight: number = DEFAULT_MAX_HEIGHT,
    explicitMinHeight?: number,
): void {
    if (!root) return
    root.style.height = 'auto'
    const measured = root.scrollHeight
    if (minHeightRef.current == null) {
        if (typeof explicitMinHeight === 'number' && explicitMinHeight > 0) {
            minHeightRef.current = explicitMinHeight
        } else {
            const computedMin = root.ownerDocument.defaultView?.getComputedStyle(root).minHeight
            const parsedMin = computedMin ? parseFloat(computedMin) : NaN
            const fallbackMin = !isNaN(parsedMin) && parsedMin > 0 ? parsedMin : DEFAULT_MIN_HEIGHT
            minHeightRef.current = Math.max(measured, fallbackMin)
        }
    }
    const minCap = minHeightRef.current ?? DEFAULT_MIN_HEIGHT
    const next = Math.min(Math.max(measured, minCap), maxHeight)
    root.style.height = `${next}px`
    root.style.overflowY = measured > maxHeight ? 'auto' : 'hidden'
}

function scrollToActivePosition(root: HTMLElement | null): void {
    if (!root) return
    const doScroll = () => {
        if (!root) return
        if (root.scrollHeight <= root.clientHeight) return

        try {
            const selection = window.getSelection()
            if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0)
                if (root.contains(range.commonAncestorContainer)) {
                    const rects = range.getClientRects()
                    const rect = rects.length > 0 ? rects[0] : range.getBoundingClientRect()
                    const rootRect = root.getBoundingClientRect()
                    if (rect && rootRect && rect.height > 0) {
                        if (rect.bottom > rootRect.bottom) {
                            root.scrollTop += (rect.bottom - rootRect.bottom) + 8
                            return
                        } else if (rect.top < rootRect.top) {
                            root.scrollTop -= (rootRect.top - rect.top) + 8
                            return
                        }
                    }
                }
            }

            const { end } = getSelectionOffsets(root)
            const currentText = readDraftDom(root).text
            if (end >= currentText.length - 1) {
                root.scrollTop = root.scrollHeight
            }
        } catch {
            root.scrollTop = root.scrollHeight
        }
    }

    doScroll()
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(doScroll)
    }
}

function sameReferences(
    left: readonly { start: number; name: string }[],
    right: readonly { start: number; name: string }[],
): boolean {
    return left.length === right.length && left.every((ref, index) =>
        ref.start === right[index]?.start && ref.name === right[index]?.name)
}

function replaceDraftParts(
    parts: readonly SkillDraftPart[],
    start: number,
    end: number,
    inserted: string,
    skills: readonly SkillNameRef[],
    trigger: SkillTrigger,
    allowLegacy = false,
    reservedSlashNames: readonly string[] = [],
    insertedParts?: readonly SkillDraftPart[],
): SkillDraftPart[] {
    const before: SkillDraftPart[] = []
    const after: SkillDraftPart[] = []
    let offset = 0
    for (const part of parts) {
        const length = part.type === 'skill' ? part.name.length + 1 : part.text.length
        if (offset + length <= start) before.push(part)
        else if (offset >= end) after.push(part)
        else if (part.type === 'text') {
            if (start > offset) before.push({ type: 'text', text: part.text.slice(0, start - offset) })
            if (end < offset + length) after.push({ type: 'text', text: part.text.slice(end - offset) })
        }
        offset += length
    }
    const prefix = before.at(-1)?.type === 'text' ? before.pop() as { type: 'text'; text: string } : null
    const suffix = after[0]?.type === 'text' ? after.shift() as { type: 'text'; text: string } : null
    if (insertedParts) {
        return [...before, ...(prefix ? [prefix] : []), ...insertedParts,
            ...(suffix ? [suffix] : []), ...after]
    }
    const segments: SkillDraftPart[] = [
        ...(prefix ? [prefix] : []),
        ...(insertedParts ?? [{ type: 'text' as const, text: inserted }]),
        ...(suffix ? [suffix] : []),
    ]
    const middle: SkillDraftPart[] = []
    for (const segment of segments) {
        if (segment.type === 'skill') {
            middle.push(segment)
            continue
        }
        const previous = middle.at(-1)
        if (previous?.type === 'text') previous.text += segment.text
        else middle.push({ ...segment })
    }
    const folded = middle.flatMap((part, index) => part.type === 'skill' ? [part] : parseSkillDraft(
        part.text, skills, undefined, trigger, allowLegacy,
        index === 0 && before.every((previous) => previous.type === 'text' && !previous.text.trim())
            ? reservedSlashNames : [], false,
    ))
    return [...before, ...folded, ...after]
}

function foldLiveParts(
    parts: readonly SkillDraftPart[],
    skills: readonly SkillNameRef[],
    trigger: SkillTrigger,
    cursor?: number,
    reservedSlashNames: readonly string[] = [],
): SkillDraftPart[] {
    let offset = 0
    let hasLeadingContent = false
    return parts.flatMap((part) => {
        if (part.type === 'skill') {
            offset += part.name.length + 1
            hasLeadingContent = true
            return [part]
        }
        const parsed = parseSkillDraft(
            part.text,
            skills,
            cursor == null ? undefined : cursor - offset,
            trigger,
            false,
            hasLeadingContent ? [] : reservedSlashNames,
            false,
        )
        offset += part.text.length
        if (part.text.trim()) hasLeadingContent = true
        return parsed
    })
}

function partsChanged(
    left: readonly SkillDraftPart[],
    right: readonly SkillDraftPart[],
): boolean {
    if (left.length !== right.length) return true
    return left.some((part, index) => {
        const other = right[index]
        if (!other || part.type !== other.type) return true
        if (part.type === 'text' && other.type === 'text') {
            return part.text !== other.text
        }
        return part.type === 'skill' && other.type === 'skill'
            ? part.name !== other.name
            : true
    })
}

function writeDraftDom(root: HTMLElement, parts: readonly SkillDraftPart[]): void {
    const nodes: Node[] = []
    if (parts.length === 0 || parts[0]?.type === 'skill') {
        nodes.push(document.createTextNode(ZWSP))
    }
    for (const [index, part] of parts.entries()) {
        if (part.type === 'text') {
            const isLast = index === parts.length - 1
            const textToRender =
                isLast && part.text.endsWith('\n')
                    ? part.text + ZWSP
                    : part.text || ZWSP
            nodes.push(document.createTextNode(textToRender))
            continue
        }
        nodes.push(createChipNode(part))
        const next = parts[index + 1]
        if (!next || next.type === 'skill') {
            nodes.push(document.createTextNode(ZWSP))
        }
    }
    root.replaceChildren(...nodes)
}

function createChipNode(part: Extract<SkillDraftPart, { type: 'skill' }>): HTMLElement {
    const chip = document.createElement('span')
    chip.contentEditable = 'false'
    chip.dataset.testid = 'composer-skill-chip'
    chip.dataset.skillName = part.name
    chip.className =
        'inline-flex shrink-0 items-center gap-1 align-bottom text-[16px] leading-6 sm:text-[14px] sm:leading-[22px] text-[var(--accent-blue)] select-none'
    chip.setAttribute('aria-label', part.displayName)

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.75')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    icon.setAttribute('class', 'size-3.5 shrink-0')
    for (const d of BOX_ICON_PATHS) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        icon.appendChild(path)
    }
    chip.appendChild(icon)

    const label = document.createElement('span')
    label.className = 'font-medium'
    label.textContent = part.displayName
    chip.appendChild(label)
    return chip
}

function readDraftDom(root: HTMLElement): {
    text: string
    cursor: number
    parts: SkillDraftPart[]
} {
    if (!hasContent(root)) {
        return { text: '', cursor: 0, parts: [] }
    }
    const parts = partsFromDom(root)
    const text = serializeSkillDraft(parts)
    return { text, cursor: caretSerializedOffset(root), parts }
}

function hasContent(root: Node | null): boolean {
    if (!root) return false
    if (root.nodeType === Node.TEXT_NODE) {
        return (root.textContent ?? '').split(ZWSP).join('').length > 0
    }
    if ('querySelector' in root && typeof (root as Element).querySelector === 'function') {
        if ((root as Element).querySelector('[data-skill-name]')) {
            return true
        }
    }
    for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const val = (node.textContent ?? '').split(ZWSP).join('')
            if (val.length > 0) return true
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement
            if (el.dataset.skillName) return true
            if (el.tagName !== 'BR' && hasContent(el)) {
                return true
            }
        }
    }
    return false
}

function isEditorEmpty(root: HTMLElement | null, value: string): boolean {
    if (value && value.length > 0) return false
    if (!root) return true
    return !hasContent(root)
}

export function readSkillDraftParts(root: HTMLElement | null): SkillDraftPart[] {
    return root ? partsFromDom(root) : []
}

function partsFromDom(root: Node): SkillDraftPart[] {
    if (!hasContent(root)) {
        return []
    }
    const parts: SkillDraftPart[] = []
    for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const value = (node.textContent ?? '').split(ZWSP).join('')
            if (value) parts.push({ type: 'text', text: value })
            continue
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const el = node as HTMLElement
        if (el.tagName === 'BR') {
            parts.push({ type: 'text', text: '\n' })
            continue
        }
        const name = el.dataset.skillName
        if (!name) {
            const nested = partsFromDom(el)
            parts.push(...nested)
            continue
        }
        parts.push({
            type: 'skill',
            name,
            displayName: el.getAttribute('aria-label') || name,
        })
    }
    return parts
}

function caretSerializedOffset(root: HTMLElement): number {
    if (!hasContent(root)) return 0
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
        return serializeSkillDraft(partsFromDom(root)).length
    }
    const range = selection.getRangeAt(0).cloneRange()
    range.collapse(true)
    range.setStart(root, 0)
    return serializeNode(range.cloneContents()).length
}

function setDraftCaret(root: HTMLElement, offset: number): void {
    const selection = window.getSelection()
    if (!selection) return
    const remaining = Math.max(0, offset)
    const point = findCaretPoint(root, remaining)
    if (!point) return
    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
}

function findCaretPoint(
    root: Node,
    remaining: number,
): { node: Node; offset: number } | null {
    let rem = remaining
    for (const node of root.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const raw = node.textContent ?? ''
            const visible = raw.split(ZWSP).join('')
            if (rem <= visible.length) {
                return { node, offset: visibleOffsetToRaw(raw, rem) }
            }
            rem -= visible.length
            continue
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        const el = node as HTMLElement
        if (el.tagName === 'BR') {
            if (rem <= 1) {
                return nextTextPoint(el)
            }
            rem -= 1
            continue
        }
        if (el.dataset.skillName) {
            const token = `$${el.dataset.skillName}`
            if (rem <= token.length) {
                return nextTextPoint(el)
            }
            rem -= token.length
            continue
        }
        const nested = findCaretPoint(node, rem)
        if (nested) return nested
        rem -= serializeNode(node).length
    }
    const last = lastTextPoint(root)
    return last
}

function visibleOffsetToRaw(raw: string, visibleOffset: number): number {
    let visible = 0
    for (let index = 0; index < raw.length; index += 1) {
        if (visible === visibleOffset) return index
        if (raw[index] !== ZWSP) visible += 1
    }
    return raw.length
}

function nextTextPoint(el: HTMLElement): { node: Node; offset: number } | null {
    let node: Node | null = el.nextSibling
    while (node) {
        if (node.nodeType === Node.TEXT_NODE) return { node, offset: 0 }
        node = node.nextSibling
    }
    return lastTextPoint(el.parentNode)
}

function lastTextPoint(root: Node | null): { node: Node; offset: number } | null {
    if (!root) return null
    for (let index = root.childNodes.length - 1; index >= 0; index -= 1) {
        const node = root.childNodes[index]
        if (node?.nodeType === Node.TEXT_NODE) {
            return { node, offset: node.textContent?.length ?? 0 }
        }
    }
    return null
}

function serializeNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
        return (node.textContent ?? '').split(ZWSP).join('')
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
        let out = ''
        for (const child of node.childNodes) out += serializeNode(child)
        return out
    }
    const el = node as HTMLElement
    if (el.tagName === 'BR') return '\n'
    if (el.dataset.skillName) return `$${el.dataset.skillName}`
    let out = ''
    for (const child of node.childNodes) out += serializeNode(child)
    return out
}

function readSkillClipboard(
    clipboard: DataTransfer | undefined,
    text: string,
    skills: readonly SkillNameRef[],
): SkillDraftPart[] | undefined {
    const serialized = clipboard?.getData(SKILL_DRAFT_CLIPBOARD_MIME)
    if (!serialized) return undefined
    try {
        const payload = JSON.parse(serialized) as {
            text?: unknown
            trigger?: unknown
            parts?: unknown
        }
        if (payload.text !== text || !['$', '#', '/'].includes(String(payload.trigger)) ||
            !Array.isArray(payload.parts) || payload.parts.length > text.length + 1) return undefined
        const parts: SkillDraftPart[] = []
        for (const part of payload.parts) {
            if (part?.type === 'text' && typeof part.text === 'string') {
                parts.push({ type: 'text', text: part.text })
            } else if (part?.type === 'skill' && typeof part.name === 'string') {
                const match = skills.find((skill) => skill.name.toLowerCase() === part.name.toLowerCase())
                if (!match) return undefined
                parts.push({ type: 'skill', name: match.name, displayName: formatSkillDisplayName(match.name) })
            } else return undefined
        }
        if (formatSkillDraftForClipboard(parts, payload.trigger as SkillTrigger) !== text) return undefined
        return parts
    } catch {
        return undefined
    }
}

function handleClipboardCopy(
    event: ClipboardEvent<HTMLDivElement>,
    root: HTMLElement | null,
    trigger: SkillTrigger,
): void {
    if (!root) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    if (!root.contains(range.commonAncestorContainer)) return
    const selected = range.cloneContents()
    if (!selected.querySelector('[data-skill-name]')) return
    if (!event.clipboardData) return
    event.preventDefault()
    writeSkillDraftClipboard(event.clipboardData, partsFromDom(selected), trigger)
}

function isUndoShortcut(event: KeyboardEvent<HTMLElement>): boolean {
    if (event.altKey) return false
    const hasMod = event.metaKey || event.ctrlKey
    return hasMod && !event.shiftKey && (event.key === 'z' || event.key === 'Z')
}

function isRedoShortcut(event: KeyboardEvent<HTMLElement>): boolean {
    if (event.altKey) return false
    const hasMod = event.metaKey || event.ctrlKey
    if (hasMod && event.shiftKey && (event.key === 'z' || event.key === 'Z')) return true
    if (event.ctrlKey && !event.shiftKey && (event.key === 'y' || event.key === 'Y')) return true
    return false
}

function getSelectionOffsets(root: HTMLElement): { start: number; end: number } {
    if (!hasContent(root)) return { start: 0, end: 0 }
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
        const len = serializeSkillDraft(partsFromDom(root)).length
        return { start: len, end: len }
    }
    const range = selection.getRangeAt(0)
    const startRange = range.cloneRange()
    startRange.collapse(true)
    startRange.setStart(root, 0)
    const start = serializeNode(startRange.cloneContents()).length

    const endRange = range.cloneRange()
    endRange.collapse(false)
    endRange.setStart(root, 0)
    const end = serializeNode(endRange.cloneContents()).length

    return { start: Math.min(start, end), end: Math.max(start, end) }
}

function skillChipFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null
    const chip = target.closest('[data-skill-name]')
    return chip instanceof HTMLElement ? chip : null
}

function tryDeleteChipBeforeCaret(root: HTMLElement | null): boolean {
    if (!root) return false
    const chips = [...root.querySelectorAll<HTMLElement>('[data-skill-name]')]
    if (chips.length === 0) return false

    const serialized = serializeSkillDraft(partsFromDom(root))
    const onlyChip = /^\$[^\s]+\s*$/.test(serialized) && chips.length === 1
    const selection = window.getSelection()
    const node = selection?.anchorNode ?? null
    const offset = selection?.anchorOffset ?? 0

    if (node?.nodeType === Node.TEXT_NODE && root.contains(node)) {
        const before = (node.textContent ?? '').slice(0, offset)
        if (before.replace(/[\u200b\s]/g, '').length === 0) {
            let prev: Node | null = node.previousSibling
            while (
                prev &&
                prev.nodeType === Node.TEXT_NODE &&
                !(prev.textContent ?? '').replace(/[\u200b\s]/g, '')
            ) {
                prev = prev.previousSibling
            }
            if (prev instanceof HTMLElement && prev.dataset.skillName) {
                prev.remove()
                return true
            }
        }
    }

    if (onlyChip) {
        chips[0]?.remove()
        return true
    }
    return false
}

function selectNode(node: Node): void {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNode(node)
    selection.removeAllRanges()
    selection.addRange(range)
}
