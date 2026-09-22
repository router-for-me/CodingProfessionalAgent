import type { DisplayMessagePart } from '../types.js'

export type TFunction = (key: string, options?: any) => string

const SKILL_FILE = 'skill.md'

export type ToolActivityKind =
  | 'skill'
  | 'command'
  | 'read'
  | 'edit'
  | 'write'
  | 'ask'
  | 'other'

const TOOL_DISPLAY_ALIASES: Record<string, string> = {
  bash: 'shell',
  pwsh: 'shell',
  powershell: 'shell',
  ask_user: 'ask',
  manage_todo_list: 'todo',
  set_session_title: 'title',
  memory_search: 'memories_search',
  memory_store: 'memories_add_ad_hoc_note',
  send_input: 'send_message',
  delegate_agent: 'spawn_agent',
  subagent: 'spawn_agent',
}

const BUILTIN_TOOL_SUMMARIES: Record<
  string,
  { kind: ToolActivityKind; running: string; done: string }
> = {
  memories_list: {
    kind: 'read',
    running: 'tool.summary.listingMemories',
    done: 'tool.summary.listedMemories',
  },
  memories_read: {
    kind: 'read',
    running: 'tool.summary.readingMemory',
    done: 'tool.summary.readMemory',
  },
  memories_search: {
    kind: 'read',
    running: 'tool.summary.searchingMemories',
    done: 'tool.summary.searchedMemories',
  },
  memories_add_ad_hoc_note: {
    kind: 'write',
    running: 'tool.summary.writingMemory',
    done: 'tool.summary.wroteMemory',
  },
  web_search: {
    kind: 'other',
    running: 'tool.summary.searchingWeb',
    done: 'tool.summary.searchedWeb',
  },
  spawn_agent: {
    kind: 'other',
    running: 'tool.summary.spawningAgent',
    done: 'tool.summary.spawnedAgent',
  },
  send_message: {
    kind: 'other',
    running: 'tool.summary.sendingMessage',
    done: 'tool.summary.sentMessage',
  },
  stop_agent: {
    kind: 'other',
    running: 'tool.summary.stoppingAgent',
    done: 'tool.summary.stoppedAgent',
  },
  session_search: {
    kind: 'other',
    running: 'tool.summary.searchingSessions',
    done: 'tool.summary.searchedSessions',
  },
  session_create: {
    kind: 'other',
    running: 'tool.summary.creatingSession',
    done: 'tool.summary.createdSession',
  },
  create_session: {
    kind: 'other',
    running: 'tool.summary.creatingSession',
    done: 'tool.summary.createdSession',
  },
}

export interface ToolActivityPart {
  id: string
  name: string
  args: Record<string, unknown>
  status: string
}

export interface ToolActivitySummary {
  kind: ToolActivityKind
  text: string
  running: boolean
}

export type CompactToolCallPart = Extract<DisplayMessagePart, { type: 'tool_call' }>

export type CompactActivitySegment =
  | { type: 'tools'; parts: CompactToolCallPart[] }
  | { type: 'spawns'; parts: CompactToolCallPart[] }
  | { type: 'text'; text: string }

export function normalizeToolCallId(id: string): string {
  return id.split('|', 1)[0] ?? id
}

export function isSpawnAgentName(name: string): boolean {
  return name === 'spawn_agent'
}

export function isSkillRead(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (name !== 'read') return false
  const path = stringArg(args, 'path')
  if (!path) return false
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.endsWith(`/${SKILL_FILE}`) || normalized.endsWith(SKILL_FILE)
  )
}

export function skillDisplayName(args: Record<string, unknown>): string {
  const path = stringArg(args, 'path')
  if (!path) return 'skill'
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  if (last.toLowerCase() === SKILL_FILE && parts.length >= 2) {
    return humanizeToken(parts[parts.length - 2] ?? 'skill')
  }
  return humanizeToken(stripExtension(last) || 'skill')
}

export function fileNameFromArgs(args: Record<string, unknown>): string | undefined {
  const path = stringArg(args, 'path') ?? stringArg(args, 'file')
  if (!path) return undefined
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export function commandFromArgs(args: Record<string, unknown>): string | undefined {
  const command = stringArg(args, 'command') ?? stringArg(args, 'cmd')
  if (!command) return undefined
  const line = command.trim().split('\n')[0]?.trim() ?? ''
  if (!line) return undefined
  return line.length > 64 ? `${line.slice(0, 61)}…` : line
}

export function titleFromArgs(args: Record<string, unknown>): string | undefined {
  const title = stringArg(args, 'title')
  if (!title) return undefined
  const line = title.trim().split('\n')[0]?.trim() ?? ''
  if (!line) return undefined
  return line.length > 64 ? `${line.slice(0, 61)}…` : line
}

export function isToolRunning(status: string): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_approval'
  )
}

function canonicalToolDisplayKey(name: string): string {
  return TOOL_DISPLAY_ALIASES[name] ?? name
}

export function toolDisplayName(name: string, t: TFunction): string {
  const canonical = canonicalToolDisplayKey(name)
  const translated = t(`tool.display.${canonical}`, { defaultValue: '' })
  if (typeof translated === 'string' && translated.trim()) return translated
  return humanizeToken(name) || name
}

export function summarizeToolActivity(
  part: ToolActivityPart,
  t: TFunction,
): ToolActivitySummary {
  const running = isToolRunning(part.status)

  if (isSkillRead(part.name, part.args)) {
    return {
      kind: 'skill',
      running,
      text: t('tool.summary.skillRead', { name: skillDisplayName(part.args) }),
    }
  }

  if (
    part.name === 'bash' ||
    part.name === 'shell' ||
    part.name === 'pwsh' ||
    part.name === 'powershell'
  ) {
    const command = commandFromArgs(part.args)
    if (running && command) {
      return {
        kind: 'command',
        running,
        text: t('tool.summary.runningCommand', { command }),
      }
    }
    return {
      kind: 'command',
      running,
      text: t('tool.summary.loadedCommand'),
    }
  }

  if (part.name === 'read') {
    const name = fileNameFromArgs(part.args) ?? part.name
    return {
      kind: 'read',
      running,
      text: running
        ? t('tool.summary.readingFile', { name })
        : t('tool.summary.readFile', { name }),
    }
  }

  if (part.name === 'edit') {
    const name = fileNameFromArgs(part.args) ?? part.name
    return {
      kind: 'edit',
      running,
      text: running
        ? t('tool.summary.editingFile', { name })
        : t('tool.summary.editedFile', { name }),
    }
  }

  if (part.name === 'write') {
    const name = fileNameFromArgs(part.args) ?? part.name
    return {
      kind: 'write',
      running,
      text: running
        ? t('tool.summary.writingFile', { name })
        : t('tool.summary.wroteFile', { name }),
    }
  }

  if (part.name === 'ask' || part.name === 'ask_user') {
    const q = stringArg(part.args, 'question') ?? stringArg(part.args, 'prompt') ?? ''
    const shortQ = q.length > 40 ? `${q.slice(0, 37)}…` : q
    return {
      kind: 'ask',
      running,
      text: running
        ? (shortQ
            ? t('tool.summary.askingQuestion', { question: shortQ, defaultValue: `Asking ${shortQ}` })
            : t('tool.summary.waitingAnswer', { defaultValue: 'Waiting for your answer' }))
        : (shortQ
            ? t('tool.summary.askedQuestion', { question: shortQ, defaultValue: `Asked ${shortQ}` })
            : t('tool.summary.answered', { defaultValue: 'Answered' })),
    }
  }

  if (part.name === 'manage_todo_list' || part.name === 'todo') {
    const op = part.args?.operation === 'read' ? 'read' : 'write'
    return {
      kind: 'other',
      running,
      text: running
        ? (op === 'read'
            ? t('tool.summary.readingTodoList', { defaultValue: 'Reading todo list' })
            : t('tool.summary.updatingTodoList', { defaultValue: 'Updating todo list' }))
        : (op === 'read'
            ? t('tool.summary.readTodoList', { defaultValue: 'Read todo list' })
            : t('tool.summary.updatedTodoList', { defaultValue: 'Updated todo list' })),
    }
  }

  if (part.name === 'set_session_title' || part.name === 'title') {
    const title = titleFromArgs(part.args)
    return {
      kind: 'other',
      running,
      text: running
        ? (title
            ? t('tool.summary.settingSessionTitle', { title, defaultValue: `Setting title to ${title}` })
            : t('tool.summary.settingSessionTitleGeneric', { defaultValue: 'Setting title' }))
        : (title
            ? t('tool.summary.setSessionTitle', { title, defaultValue: `Set title to ${title}` })
            : t('tool.summary.setSessionTitleGeneric', { defaultValue: 'Set title' })),
    }
  }

  const builtin = BUILTIN_TOOL_SUMMARIES[canonicalToolDisplayKey(part.name)]
  if (builtin) {
    return {
      kind: builtin.kind,
      running,
      text: t(running ? builtin.running : builtin.done),
    }
  }

  const displayName = toolDisplayName(part.name, t)
  return {
    kind: 'other',
    running,
    text: running
      ? t('tool.summary.using', { name: displayName })
      : t('tool.summary.used', { name: displayName }),
  }
}

/** Visible turn body: text or non-skill tools. Skill reads stay folded. */
export function hasVisibleTurnContent(
  parts: readonly DisplayMessagePart[] | undefined,
  content = '',
): boolean {
  if (content.trim()) return true
  if (!parts || parts.length === 0) return false
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim()) return true
    if (part.type !== 'tool_call') continue
    if (isSpawnAgentName(part.name)) return true
    if (!isSkillRead(part.name, part.args)) return true
  }
  return false
}

/** Last assistant narrative after the final tool/thinking block. */
export function trailingAssistantText(
  parts: readonly DisplayMessagePart[] | undefined,
  fallback = '',
): string {
  if (!parts || parts.length === 0) return fallback
  let start = 0
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type === 'tool_call' || part.type === 'thinking') {
      start = index + 1
    }
  }
  const chunks: string[] = []
  for (let index = start; index < parts.length; index += 1) {
    const part = parts[index]
    if (part.type === 'text' && part.text) chunks.push(part.text)
  }
  if (chunks.length > 0) return chunks.join('')
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type === 'text' && part.text.trim()) return part.text
  }
  return fallback
}

export function resolvePartGroupKey(
  part: DisplayMessagePart,
  renderers?: readonly any[],
): string | undefined {
  if (renderers && renderers.length > 0) {
    const candidates = renderers.filter((r) => {
      const target = r.target ?? r.scope
      if (target && target !== 'part') return false
      try {
        return typeof r.matches === 'function' && r.matches(part)
      } catch {
        return false
      }
    })
    candidates.sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    const matched = candidates[0]
    if (matched) {
      if (typeof matched.groupKey === 'function') {
        return matched.groupKey(part)
      }
      if (typeof matched.groupKey === 'string') {
        return matched.groupKey
      }
    }
  }
  if (part.type === 'tool_call') {
    if (isSpawnAgentName(part.name)) return 'spawns'
    return 'tools'
  }
  return undefined
}

/**
 * Fold consecutive tool calls for compact activity.
 * Thinking and blank text do not split a run; only body text or spawn_agent does.
 */
export function groupCompactActivityParts(
  parts: readonly DisplayMessagePart[],
  options?: {
    renderers?: readonly any[]
    getGroupKey?: (part: DisplayMessagePart) => string | undefined
  },
): CompactActivitySegment[] {
  const segments: CompactActivitySegment[] = []
  let index = 0
  const getGroup = (p: DisplayMessagePart) =>
    options?.getGroupKey ? options.getGroupKey(p) : resolvePartGroupKey(p, options?.renderers)

  while (index < parts.length) {
    const part = parts[index]
    if (!part || isCompactActivityGap(part)) {
      index += 1
      continue
    }
    if (part.type === 'text') {
      segments.push({ type: 'text', text: part.text })
      index += 1
      continue
    }
    const currentGroupKey = getGroup(part)
    if (currentGroupKey === 'spawns' || currentGroupKey === 'subagent') {
      const group: CompactToolCallPart[] = []
      while (index < parts.length) {
        const next = parts[index]
        if (!next || isCompactActivityGap(next)) {
          index += 1
          continue
        }
        const nextKey = getGroup(next)
        if (next.type === 'tool_call' && (nextKey === 'spawns' || nextKey === 'subagent')) {
          group.push(next)
          index += 1
          continue
        }
        break
      }
      if (group.length > 0) segments.push({ type: 'spawns', parts: group })
      continue
    }
    const group: CompactToolCallPart[] = []
    while (index < parts.length) {
      const next = parts[index]
      if (!next || isCompactActivityGap(next)) {
        index += 1
        continue
      }
      const nextKey = getGroup(next)
      if (next.type === 'tool_call' && nextKey !== 'spawns' && nextKey !== 'subagent') {
        group.push(next)
        index += 1
        continue
      }
      break
    }
    if (group.length > 0) segments.push({ type: 'tools', parts: group })
  }
  return segments
}

function isCompactActivityGap(part: DisplayMessagePart): boolean {
  if (part.type === 'thinking') return true
  return part.type === 'text' && !part.text.trim()
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stripExtension(name: string): string {
  return name.replace(/\.md$/i, '')
}

function humanizeToken(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}
