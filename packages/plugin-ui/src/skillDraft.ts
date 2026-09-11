export type SkillNameRef = { name: string }

export type SkillDraftPart =
    | { type: 'text'; text: string }
    | { type: 'skill'; name: string; displayName: string }

// Keep token parsing, query detection, and insertion boundaries consistent.
const SKILL_TOKEN_RE = /(^|[\s\p{P}])(\$|\/skill:)([^\s]+)(?=\s|$)/gu

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

function knownSkillNames(
    skills: readonly SkillNameRef[],
): Map<string, string> {
    const names = new Map<string, string>()
    for (const skill of skills) {
        const key = skill.name.toLowerCase()
        if (!names.has(key)) names.set(key, skill.name)
    }
    return names
}

function shouldKeepLiveToken(
    tokenStart: number,
    tokenEnd: number,
    liveCursor: number | undefined,
): boolean {
    if (liveCursor == null) return false
    return liveCursor > tokenStart && liveCursor <= tokenEnd
}

function mergeAdjacentText(parts: SkillDraftPart[]): SkillDraftPart[] {
    const merged: SkillDraftPart[] = []
    for (const part of parts) {
        const prev = merged[merged.length - 1]
        if (part.type === 'text' && prev?.type === 'text') {
            prev.text += part.text
            continue
        }
        merged.push(part.type === 'text' ? { ...part } : part)
    }
    return merged.filter((part) => part.type === 'skill' || part.text.length > 0)
}

/** Fold exact `$name` / `/skill:name` tokens into inline skill parts. */
export function parseSkillDraft(
    text: string,
    skills: readonly SkillNameRef[] = [],
    liveCursor?: number,
): SkillDraftPart[] {
    const value = String(text ?? '')
    if (!value) return []

    const names = knownSkillNames(skills)
    if (names.size === 0) {
        return [{ type: 'text', text: value }]
    }

    const parts: SkillDraftPart[] = []
    let lastIndex = 0
    SKILL_TOKEN_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SKILL_TOKEN_RE.exec(value))) {
        const lead = match[1] ?? ''
        const prefix = match[2] ?? '$'
        const rawName = match[3] ?? ''
        const canonical = names.get(rawName.toLowerCase())
        if (!canonical) continue

        const tokenStart = match.index + lead.length
        const tokenEnd = tokenStart + prefix.length + rawName.length
        if (shouldKeepLiveToken(tokenStart, tokenEnd, liveCursor)) continue

        if (tokenStart > lastIndex) {
            parts.push({ type: 'text', text: value.slice(lastIndex, tokenStart) })
        }
        parts.push({
            type: 'skill',
            name: canonical,
            displayName: formatSkillDisplayName(canonical),
        })
        lastIndex = tokenEnd
    }

    if (lastIndex < value.length) {
        parts.push({ type: 'text', text: value.slice(lastIndex) })
    }

    return mergeAdjacentText(parts)
}

export function serializeSkillDraft(parts: readonly SkillDraftPart[]): string {
    let out = ''
    for (const part of parts) {
        out += part.type === 'text' ? part.text : `$${part.name}`
    }
    return out
}

export function skillDraftHasChip(parts: readonly SkillDraftPart[]): boolean {
    return parts.some((part) => part.type === 'skill')
}

function splitAtCaret(
    text: string,
    cursor?: number,
): { before: string; after: string } {
    const value = String(text ?? '')
    const max = value.length
    const raw = cursor ?? max
    const pos = raw < 0 ? 0 : raw > max ? max : raw
    return { before: value.slice(0, pos), after: value.slice(pos) }
}

/** Active `$query` token immediately before the caret, if any. */
export function getSkillQuery(text: string, cursor?: number): string | null {
    const { before } = splitAtCaret(text, cursor)
    const match = /(?:^|[\s\p{P}])\$([^\s]*)$/u.exec(before)
    if (!match) return null
    return match[1] ?? ''
}

function insertSkillToken(
    text: string,
    insertText: string,
    cursor?: number,
): { text: string; cursor: number } {
    const { before, after } = splitAtCaret(text, cursor)
    const nextBefore = before.replace(
        /(^|[\s\p{P}])\$[^\s]*$/u,
        (_match, prefix: string) => `${prefix}${insertText}`,
    )
    return { text: nextBefore + after, cursor: nextBefore.length }
}

/** Replace the active `$query` token with `$${skillName} `. */
export function insertSkillAtCaret(
    text: string,
    skillName: string,
    cursor?: number,
): { text: string; cursor: number } {
    return insertSkillToken(text, `$${skillName} `, cursor)
}

/** Replace the active `$query` token with an arbitrary insert string. */
export function replaceSkillToken(
    text: string,
    insertText: string,
    cursor?: number,
): string {
    return insertSkillToken(text, insertText, cursor).text
}
