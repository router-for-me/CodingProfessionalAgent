import {
    formatSkillDisplayName,
    getSkillQuery,
    insertSkillAtCaret,
    parseSkillDraft,
    serializeSkillDraft,
    skillDraftHasChip,
    type SkillDraftPart,
} from '@cpa/plugin-ui'

export type {
    SkillDraftPart,
}

export {
    formatSkillDisplayName,
    getSkillQuery,
    insertSkillAtCaret,
    parseSkillDraft,
    serializeSkillDraft,
    skillDraftHasChip,
}

export interface Skill {
    name: string
    displayName?: string
    description?: string
    body?: string
    [key: string]: unknown
}

export interface SkillPresentation {
    name: string
    displayName: string
    args: string
}

export function parseSkillCommand(
    text: string,
): { skillName: string; args: string } | null {
    if (text.startsWith('/skill:')) {
        const rest = text.slice('/skill:'.length)
        const spaceIndex = rest.indexOf(' ')
        const skillName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
        const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1)
        return skillName ? { skillName, args } : null
    }
    if (text.startsWith('$')) {
        const rest = text.slice(1)
        const spaceIndex = rest.indexOf(' ')
        const skillName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
        const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1)
        return skillName ? { skillName, args } : null
    }
    return null
}

/** Fold `$name` / `/skill:name` commands and already-expanded skill bodies. */
export function matchSkillPresentation(
    text: string,
    skills: readonly Skill[] = [],
): SkillPresentation | null {
    const trimmed = text.trim()
    if (!trimmed) return null

    const parsed = parseSkillCommand(trimmed)
    if (parsed) {
        return {
            name: parsed.skillName,
            displayName: formatSkillDisplayName(parsed.skillName),
            args: parsed.args.trim(),
        }
    }

    for (const skill of skills) {
        if (!skill.body) continue
        if (trimmed === skill.body) {
            return {
                name: skill.name,
                displayName: formatSkillDisplayName(skill.name),
                args: '',
            }
        }
        const prefix = `${skill.body}\n\nUser: `
        if (trimmed.startsWith(prefix)) {
            return {
                name: skill.name,
                displayName: formatSkillDisplayName(skill.name),
                args: trimmed.slice(prefix.length),
            }
        }
    }

    return null
}

export function skillPresentationCommand(presentation: SkillPresentation): string {
    return presentation.args
        ? `$${presentation.name} ${presentation.args}`
        : `$${presentation.name}`
}

/** Unique skills invoked in this conversation, in first-seen order. */
export function collectInvokedSkills(
    entries: readonly any[],
    skills: readonly Skill[] = [],
): SkillPresentation[] {
    const seen = new Set<string>()
    const invoked: SkillPresentation[] = []
    const add = (name: string, displayName: string, args = '') => {
        const key = name.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        invoked.push({ name, displayName, args })
    }
    for (const entry of entries) {
        if (entry?.kind !== 'user') continue
        const content = entry.content ?? []
        for (const block of content) {
            if (block?.type !== 'text') continue
            const parts = parseSkillDraft(block.text, skills)
            let foundInline = false
            for (const part of parts) {
                if (part.type !== 'skill') continue
                foundInline = true
                add(part.name, part.displayName)
            }
            if (foundInline) continue
            const presentation = matchSkillPresentation(block.text, skills)
            if (!presentation) continue
            add(presentation.name, presentation.displayName, presentation.args)
        }
    }
    return invoked
}
