import type { SkillReference, SkillTrigger } from '@cpa/plugin-api'

export const SKILL_DRAFT_CLIPBOARD_MIME = 'application/x-cpa-skill-draft+json'

export type SkillNameRef = { name: string }

export type SkillDraftPart =
    | { type: 'text'; text: string }
    | { type: 'skill'; name: string; displayName: string }

/** Title-case kebab/snake skill names for chip labels. */
export function formatSkillDisplayName(name: string): string {
    const raw = String(name ?? '').trim()
    if (!raw) return ''
    return raw
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
}

function knownSkillNames(skills: readonly SkillNameRef[]): Map<string, string> {
    const names = new Map<string, string>()
    for (const skill of skills) {
        const key = skill.name.toLowerCase()
        if (!names.has(key)) names.set(key, skill.name)
    }
    return names
}

function isBoundary(text: string, index: number): boolean {
    if (index === 0) return true
    const previous = text[index - 1]!
    return /[\s\p{P}]/u.test(previous) && !/[#$\/\\]/.test(previous)
}

function mergeAdjacentText(parts: SkillDraftPart[]): SkillDraftPart[] {
    const merged: SkillDraftPart[] = []
    for (const part of parts) {
        const prev = merged[merged.length - 1]
        if (part.type === 'text' && prev?.type === 'text') {
            prev.text += part.text
        } else {
            merged.push(part.type === 'text' ? { ...part } : part)
        }
    }
    return merged.filter((part) => part.type === 'skill' || part.text.length > 0)
}

/** Fold only the chosen trigger. Omit trigger for historical stored `$name` and `/skill:name` records. */
export function parseSkillDraft(
    text: string,
    skills: readonly SkillNameRef[] = [],
    liveCursor?: number,
    trigger?: SkillTrigger,
    allowLegacy = false,
    reservedSlashNames: readonly string[] = [],
    allowSlashToken = trigger === undefined || allowLegacy,
): SkillDraftPart[] {
    const value = String(text ?? '')
    if (!value) return []
    const names = knownSkillNames(skills)
    if (names.size === 0) return [{ type: 'text', text: value }]
    const firstNonWhitespace = value.length - value.trimStart().length

    const prefixes = trigger === undefined
        ? ['$', '/skill:']
        : [...(allowSlashToken ? ['/skill:'] : []), trigger, ...(allowLegacy && trigger !== '$' ? ['$'] : [])]
    const parts: SkillDraftPart[] = []
    let lastIndex = 0
    for (let index = 0; index < value.length; index += 1) {
        if (index < lastIndex || !isBoundary(value, index)) continue
        const prefix = prefixes.find((candidate) => value.startsWith(candidate, index))
        if (!prefix) continue
        const rest = value.slice(index + prefix.length)
        const token = /^[a-z0-9-]+/i.exec(rest)?.[0]
        if (!token) continue
        const end = index + prefix.length + token.length
        if (end < value.length && !/\s/u.test(value[end]!)) continue
        const canonical = names.get(token.toLowerCase())
        if (trigger === '/' && prefix === '/' && index === firstNonWhitespace &&
            reservedSlashNames.some((name) => name.toLowerCase() === token.toLowerCase())) continue
        if (!canonical || (liveCursor != null && liveCursor > index && liveCursor <= end)) continue
        if (index > lastIndex) parts.push({ type: 'text', text: value.slice(lastIndex, index) })
        parts.push({ type: 'skill', name: canonical, displayName: formatSkillDisplayName(canonical) })
        lastIndex = end
    }
    if (lastIndex < value.length) parts.push({ type: 'text', text: value.slice(lastIndex) })
    return mergeAdjacentText(parts)
}

export function serializeSkillDraft(parts: readonly SkillDraftPart[]): string {
    return parts.map((part) => part.type === 'text' ? part.text : `$${part.name}`).join('')
}

export function formatSkillDraftForClipboard(
    parts: readonly SkillDraftPart[],
    trigger: SkillTrigger,
): string {
    return parts.map((part) => part.type === 'text'
        ? part.text
        : `${trigger === '/' ? '/skill:' : trigger}${part.name}`).join('')
}

export function writeSkillDraftClipboard(
    clipboard: Pick<DataTransfer, 'setData'>,
    parts: readonly SkillDraftPart[],
    trigger: SkillTrigger,
): void {
    const text = formatSkillDraftForClipboard(parts, trigger)
    clipboard.setData('text/plain', text)
    if (parts.some((part) => part.type === 'skill')) {
        clipboard.setData(SKILL_DRAFT_CLIPBOARD_MIME, JSON.stringify({ text, trigger, parts }))
    }
}

export function skillReferencesFromParts(parts: readonly SkillDraftPart[]): SkillReference[] {
    const references: SkillReference[] = []
    let offset = 0
    for (const part of parts) {
        if (part.type === 'skill') references.push({ start: offset, name: part.name })
        offset += part.type === 'text' ? part.text.length : part.name.length + 1
    }
    return references
}

export function parseReferencedSkillDraft(
    text: string,
    references: readonly SkillReference[],
): SkillDraftPart[] {
    const parts: SkillDraftPart[] = []
    let offset = 0
    for (const ref of [...references].sort((a, b) => a.start - b.start)) {
        const token = `$${ref.name}`
        if (ref.start < offset || !text.startsWith(token, ref.start)) continue
        if (ref.start > offset) parts.push({ type: 'text', text: text.slice(offset, ref.start) })
        parts.push({ type: 'skill', name: ref.name, displayName: formatSkillDisplayName(ref.name) })
        offset = ref.start + token.length
    }
    if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) })
    return parts
}

export function normalizeSkillDraft(
    parts: readonly SkillDraftPart[],
    skills: readonly SkillNameRef[],
    trigger: SkillTrigger,
    reservedSlashNames: readonly string[] = [],
): { text: string; references: SkillReference[] } {
    let hasLeadingContent = false
    const folded = parts.flatMap((part) => {
        if (part.type === 'skill') {
            hasLeadingContent = true
            return [part]
        }
        const parsed = parseSkillDraft(part.text, skills, undefined, trigger, false,
            hasLeadingContent ? [] : reservedSlashNames, false)
        if (part.text.trim()) hasLeadingContent = true
        return parsed
    })
    return { text: serializeSkillDraft(folded), references: skillReferencesFromParts(folded) }
}

export function skillDraftHasChip(parts: readonly SkillDraftPart[]): boolean {
    return parts.some((part) => part.type === 'skill')
}

function splitAtCaret(text: string, cursor?: number): { before: string; after: string } {
    const value = String(text ?? '')
    const pos = Math.max(0, Math.min(cursor ?? value.length, value.length))
    return { before: value.slice(0, pos), after: value.slice(pos) }
}

/** Active query immediately before the caret, for the selected trigger only. */
export function getSkillQuery(text: string, cursor?: number, trigger: SkillTrigger = '$'): string | null {
    const { before } = splitAtCaret(text, cursor)
    for (let index = before.length - 1; index >= 0; index -= 1) {
        if (before[index] !== trigger || !isBoundary(before, index)) continue
        const query = before.slice(index + 1)
        if (/^[a-z0-9-]*$/i.test(query)) return query
    }
    return null
}

function insertSkillToken(
    text: string,
    insertText: string,
    cursor?: number,
    trigger: SkillTrigger = '$',
): { text: string; cursor: number } {
    const { before, after } = splitAtCaret(text, cursor)
    const query = getSkillQuery(text, cursor, trigger)
    const nextBefore = query === null
        ? before
        : before.slice(0, before.length - query.length - 1) + insertText
    return { text: nextBefore + after, cursor: nextBefore.length }
}

/** Replace the active trigger token with a canonical `$name` chip token. */
export function insertSkillAtCaret(
    text: string,
    skillName: string,
    cursor?: number,
    trigger: SkillTrigger = '$',
): { text: string; cursor: number } {
    return insertSkillToken(text, `${trigger}${skillName} `, cursor, trigger)
}

export function insertSkillInParts(
    parts: readonly SkillDraftPart[],
    skillName: string,
    cursor: number,
    trigger: SkillTrigger,
): { text: string; cursor: number; references: SkillReference[] } | null {
    const text = serializeSkillDraft(parts)
    const query = getSkillQuery(text, cursor, trigger)
    if (query === null) return null
    const start = cursor - query.length - 1
    const end = Math.max(start, Math.min(cursor, text.length))
    const token = `$${skillName}`
    const previous = skillReferencesFromParts(parts)
    if (previous.some((ref) => ref.start < end && ref.start + ref.name.length + 1 > start)) return null
    const delta = token.length + 1 - (end - start)
    return {
        text: text.slice(0, start) + token + ' ' + text.slice(end),
        cursor: start + token.length + 1,
        references: [
            ...previous.filter((ref) => ref.start < start),
            { start, name: skillName },
            ...previous.filter((ref) => ref.start >= end).map((ref) => ({ ...ref, start: ref.start + delta })),
        ],
    }
}

export function replaceSkillToken(
    text: string,
    insertText: string,
    cursor?: number,
    trigger: SkillTrigger = '$',
): string {
    return insertSkillToken(text, insertText, cursor, trigger).text
}
