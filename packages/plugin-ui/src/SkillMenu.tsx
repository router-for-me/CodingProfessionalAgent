import {
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type ReactElement,
} from 'react'
import { Box } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from './cn.js'
import { formatSkillDisplayName } from './skillDraft.js'

export type SkillSource = 'personal' | 'project'

export interface SkillSuggestion {
    id: string
    name: string
    displayName: string
    description: string
    insertText: string
    source: SkillSource
}

export interface ComposerSkillChip {
    name: string
    displayName: string
}

export interface PastedSkillChip extends ComposerSkillChip {
    args: string
}

export type SkillUsageCountsInput =
    | Record<string, number>
    | Map<string, number>
    | readonly { name: string; count: number }[]

export interface SkillSuggestionSkill {
    name: string
    description?: string
    filePath?: string
}

export interface BuildSkillSuggestionsInput {
    query: string
    skills: readonly SkillSuggestionSkill[]
    usageCounts?: SkillUsageCountsInput
}

export type SkillMenuPlacement = 'above' | 'below'

export interface VerticalMenuPlacement {
    placement: SkillMenuPlacement
    maxHeight: number
}

export const SKILL_MENU_LISTBOX_ID = 'skill-menu'

const MENU_VIEWPORT_PAD = 8
const MENU_GUTTER = 8
const MENU_MAX_HEIGHT = 288 // max-h-72
const MENU_MIN_HEIGHT = 96

/** Choose above/below based on remaining viewport space around the anchor. */
export function resolveVerticalMenuPlacement(
    anchor: Pick<DOMRect, 'top' | 'bottom'>,
    viewportHeight: number,
    options?: {
        preferred?: SkillMenuPlacement
        gutter?: number
        maxHeight?: number
        minHeight?: number
        minPreferredSpace?: number
    },
): VerticalMenuPlacement {
    const gutter = options?.gutter ?? MENU_GUTTER
    const pad = MENU_VIEWPORT_PAD
    const preferred = options?.preferred ?? 'below'
    const preferredMax = options?.maxHeight ?? MENU_MAX_HEIGHT
    const minHeight = options?.minHeight ?? MENU_MIN_HEIGHT
    const minPreferredSpace = options?.minPreferredSpace ?? 120

    const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - pad)
    const spaceAbove = Math.max(0, anchor.top - pad)

    let placement: SkillMenuPlacement
    if (preferred === 'below') {
        placement =
            spaceBelow >= minPreferredSpace || spaceBelow >= spaceAbove
                ? 'below'
                : 'above'
    } else {
        placement =
            spaceAbove >= minPreferredSpace || spaceAbove >= spaceBelow
                ? 'above'
                : 'below'
    }

    const available = placement === 'below' ? spaceBelow : spaceAbove
    const maxHeight = Math.max(
        minHeight,
        Math.min(preferredMax, Math.max(0, available - gutter)),
    )

    return { placement, maxHeight }
}

export interface SkillMenuProps {
    suggestions: readonly SkillSuggestion[]
    activeIndex: number
    onActiveIndexChange: (index: number) => void
    onSelect: (suggestion: SkillSuggestion) => void
    onClose: () => void
    className?: string
    id?: string
    testId?: string
    /** Prefer opening below the editor unless viewport space is tighter there. */
    preferredPlacement?: SkillMenuPlacement
}

function sanitizeAriaId(value: string): string {
    const cleaned = String(value ?? '')
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return cleaned || 'id'
}

export function skillOptionId(
    name: string,
    index = 0,
    prefix = 'skill-option',
): string {
    const escaped = sanitizeAriaId(String(name).toLowerCase())
    return `${sanitizeAriaId(prefix)}-${index}-${escaped}`
}

export function skillSourceFromPath(filePath: string): SkillSource {
    const normalized = String(filePath ?? '').replace(/\\/g, '/')
    return normalized.includes('/.cpa/skills/') ? 'project' : 'personal'
}

export function flattenSkillDescription(description: string): string {
    return String(description ?? '').replace(/\s+/g, ' ').trim()
}

export function getSkillUsageCount(
    name: string,
    usageCounts?: SkillUsageCountsInput,
): number {
    if (!usageCounts) return 0
    const lower = String(name ?? '').toLowerCase()
    if (usageCounts instanceof Map) {
        const val = usageCounts.get(lower) ?? usageCounts.get(name)
        return typeof val === 'number' && !isNaN(val) ? Math.max(0, val) : 0
    }
    if (Array.isArray(usageCounts)) {
        const item = usageCounts.find(
            (entry) => entry && String(entry.name ?? '').toLowerCase() === lower,
        )
        const val = item?.count
        return typeof val === 'number' && !isNaN(val) ? Math.max(0, val) : 0
    }
    const map = usageCounts as Record<string, number>
    const val = map[lower] ?? map[name]
    return typeof val === 'number' && !isNaN(val) ? Math.max(0, val) : 0
}

function matchesSkillQuery(query: string, name: string): boolean {
    if (!query) return true
    const q = query.toLowerCase()
    const skillName = name.toLowerCase()
    return skillName.startsWith(q) || skillName.includes(q)
}

export function buildSkillSuggestions(
    input: BuildSkillSuggestionsInput,
): SkillSuggestion[] {
    const query = (input.query ?? '').toLowerCase()
    const seen = new Set<string>()
    const skills = [...input.skills].sort((a, b) => {
        const countA = getSkillUsageCount(a.name, input.usageCounts)
        const countB = getSkillUsageCount(b.name, input.usageCounts)
        if (countB !== countA) {
            return countB - countA
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    const items: SkillSuggestion[] = []
    for (const skill of skills) {
        const key = skill.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        if (!matchesSkillQuery(query, skill.name)) continue
        items.push({
            id: skillOptionId(skill.name, items.length),
            name: skill.name,
            displayName: formatSkillDisplayName(skill.name),
            description: skill.description ?? '',
            insertText: `$${skill.name} `,
            source: skillSourceFromPath(skill.filePath ?? ''),
        })
    }
    return items
}

export function composeSkillDraft(
    chip: Pick<ComposerSkillChip, 'name'> | null | undefined,
    draft: string,
): string {
    if (!chip) return draft
    const rest = draft.trim()
    return rest ? `$${chip.name} ${rest}` : `$${chip.name}`
}

export function isSkillChipSelected(
    chip: Pick<ComposerSkillChip, 'name'> | null | undefined,
    draft: string,
    selectionStart: number,
    selectionEnd: number,
    explicit = false,
): boolean {
    if (!chip) return false
    if (draft.length === 0) return explicit
    return selectionStart === 0 && selectionEnd === draft.length
}

export function skillInputClipboardText(
    chip: Pick<ComposerSkillChip, 'name'> | null | undefined,
    draft: string,
): string {
    return composeSkillDraft(chip, draft)
}

export function writeSkillInputClipboard(
    event: {
        preventDefault: () => void
        clipboardData: DataTransfer | null
    },
    chip: Pick<ComposerSkillChip, 'name'> | null | undefined,
    draft: string,
): boolean {
    if (!event.clipboardData) return false
    event.preventDefault()
    event.clipboardData.setData(
        'text/plain',
        skillInputClipboardText(chip, draft),
    )
    return true
}

export function matchPastedSkillChip(
    text: string,
    skills: readonly { name: string }[],
): PastedSkillChip | null {
    const trimmed = String(text ?? '').trim()
    if (!trimmed.startsWith('$')) return null

    const rest = trimmed.slice(1)
    const ws = rest.search(/\s/)
    const token = ws === -1 ? rest : rest.slice(0, ws)
    if (!token) return null

    const key = token.toLowerCase()
    const skill = skills.find((entry) => entry.name.toLowerCase() === key)
    if (!skill) return null

    const args = ws === -1 ? '' : rest.slice(ws + 1).replace(/^\s+/, '')
    return {
        name: skill.name,
        displayName: formatSkillDisplayName(skill.name),
        args,
    }
}

export function foldSkillInputPaste(input: {
    pasted: string
    skills: readonly { name: string }[]
    chip: ComposerSkillChip | null
    draft: string
    selectionStart: number
    selectionEnd: number
    chipSelected?: boolean
}): { chip: ComposerSkillChip | null; draft: string } | null {
    const allSelected =
        input.selectionStart === 0 && input.selectionEnd === input.draft.length
    if (!allSelected) return null

    const chipSelected = isSkillChipSelected(
        input.chip,
        input.draft,
        input.selectionStart,
        input.selectionEnd,
        input.chipSelected,
    )
    const matched = matchPastedSkillChip(input.pasted, input.skills)
    if (matched && (!input.chip || chipSelected)) {
        return {
            chip: { name: matched.name, displayName: matched.displayName },
            draft: matched.args,
        }
    }
    if (input.chip && chipSelected) {
        return { chip: null, draft: input.pasted }
    }
    return null
}

export function isTypingReplacementKey(event: {
    key: string
    metaKey: boolean
    ctrlKey: boolean
    altKey: boolean
}): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    return event.key.length === 1
}

export function scrollOptionIntoView(
    list: HTMLElement,
    option: HTMLElement,
): void {
    const listRect = list.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.bottom > listRect.bottom) {
        list.scrollTop += optionRect.bottom - listRect.bottom
        return
    }
    if (optionRect.top < listRect.top) {
        list.scrollTop -= listRect.top - optionRect.top
    }
}

export interface SkillChipProps {
    name?: string
    displayName?: string
    className?: string
    selected?: boolean
    onSelect?: () => void
}

export function SkillChip({
    name = '',
    displayName,
    className,
    selected = false,
    onSelect,
}: SkillChipProps): ReactElement {
    const { t } = useTranslation()
    const label = displayName || name
    return (
        <span
            data-testid="composer-skill-chip"
            data-skill-name={name}
            data-selected={selected ? 'true' : undefined}
            onMouseDown={
                onSelect
                    ? (event) => {
                          event.preventDefault()
                          onSelect()
                      }
                    : undefined
            }
            className={cn(
                'inline-flex shrink-0 items-center gap-1 align-bottom',
                'text-[16px] leading-6 sm:text-[14px] sm:leading-[22px] text-[var(--accent-blue)] select-none',
                selected && 'rounded-sm bg-[var(--accent-blue)]/20',
                onSelect && 'cursor-text',
                className,
            )}
            aria-label={t('skill.chip', {
                name: label,
                defaultValue: `Skill: ${label}`,
            })}
        >
            <Box className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="font-medium">{label}</span>
        </span>
    )
}

export function SkillMenu({
    suggestions,
    activeIndex,
    onActiveIndexChange,
    onSelect,
    onClose,
    className,
    id = SKILL_MENU_LISTBOX_ID,
    testId = SKILL_MENU_LISTBOX_ID,
    preferredPlacement = 'below',
}: SkillMenuProps): ReactElement | null {
    const { t } = useTranslation()
    const listRef = useRef<HTMLDivElement>(null)
    const [placement, setPlacement] = useState<SkillMenuPlacement>(preferredPlacement)
    const [maxHeight, setMaxHeight] = useState(MENU_MAX_HEIGHT)
    const safeIndex =
        suggestions.length === 0
            ? 0
            : ((activeIndex % suggestions.length) + suggestions.length) %
              suggestions.length
    const active = suggestions[safeIndex]

    useLayoutEffect(() => {
        const updatePlacement = () => {
            const list = listRef.current
            if (!list) return
            const anchor =
                list.offsetParent instanceof HTMLElement
                    ? list.offsetParent
                    : list.parentElement
            if (!anchor) return
            const next = resolveVerticalMenuPlacement(
                anchor.getBoundingClientRect(),
                window.innerHeight,
                { preferred: preferredPlacement },
            )
            setPlacement(next.placement)
            setMaxHeight(next.maxHeight)
        }

        updatePlacement()
        window.addEventListener('resize', updatePlacement)
        window.addEventListener('scroll', updatePlacement, true)
        return () => {
            window.removeEventListener('resize', updatePlacement)
            window.removeEventListener('scroll', updatePlacement, true)
        }
    }, [preferredPlacement, suggestions.length])

    useLayoutEffect(() => {
        const list = listRef.current
        const option = active ? document.getElementById(active.id) : null
        if (!list || !option) return
        scrollOptionIntoView(list, option)
    }, [active?.id])

    if (suggestions.length === 0 || !active) return null

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            onActiveIndexChange((safeIndex + 1) % suggestions.length)
            return
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault()
            onActiveIndexChange(
                (safeIndex - 1 + suggestions.length) % suggestions.length,
            )
            return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault()
            onSelect(active)
            return
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
        }
    }

    return (
        <div
            ref={listRef}
            id={id}
            data-testid={testId}
            data-placement={placement}
            role="listbox"
            tabIndex={-1}
            aria-label={t('skill.menuLabel', { defaultValue: 'Skills' })}
            aria-activedescendant={active.id}
            onKeyDown={handleKeyDown}
            style={{ maxHeight }}
            className={cn(
                'absolute left-0 right-0 z-[60] overflow-y-auto',
                placement === 'above'
                    ? 'bottom-full mb-2'
                    : 'top-full mt-2',
                'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                'bg-[var(--bg-elevated)] py-1 shadow-lg',
                className,
            )}
        >
            {suggestions.map((item, index) => {
                const selected = index === safeIndex
                return (
                    <button
                        key={item.id}
                        id={item.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseDown={(event) => {
                            event.preventDefault()
                            onActiveIndexChange(index)
                            onSelect(item)
                        }}
                        className={cn(
                            'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                            selected
                                ? 'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)]'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]',
                        )}
                    >
                        <Box
                            className="size-3.5 shrink-0 text-[var(--text-muted)]"
                            strokeWidth={1.75}
                            aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px]">
                            <span className="font-medium text-[var(--text-primary)]">
                                {item.displayName}
                            </span>
                            {item.description ? (
                                <span className="text-[var(--text-muted)]">
                                    {' '}
                                    {flattenSkillDescription(item.description)}
                                </span>
                            ) : null}
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                            {t(`skill.source.${item.source}`, {
                                defaultValue:
                                    item.source === 'project' ? 'Project' : 'Personal',
                            })}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
