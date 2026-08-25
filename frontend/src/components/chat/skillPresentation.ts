import {
  parseSkillCommand,
  type Skill,
} from '@cpa/plugin-sdk'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

export interface SkillPresentation {
  name: string
  displayName: string
  args: string
}

export function formatSkillDisplayName(name: string): string {
  if (!name) return ''
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export type SkillDraftPart =
  | { type: 'text'; text: string }
  | { type: 'skill'; name: string; displayName: string }

const SKILL_TOKEN_RE = /(^|\s)(\$|\/skill:)([^\s]+)(?=\s|$)/g

function knownSkillNames(
  skills: readonly { name: string }[],
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

export function parseSkillDraft(
  text: string,
  skills: readonly { name: string }[] = [],
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
  entries: readonly ConversationEntry[],
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
    if (entry.kind !== 'user') continue
    for (const block of entry.content) {
      if (block.type !== 'text') continue
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
