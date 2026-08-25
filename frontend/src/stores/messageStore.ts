import { create } from 'zustand'
import { migrateLegacyMessages } from '@/features/agent-runtime/session/migration'
import { projectConversation } from '@/features/agent-runtime/session/projection'
import { emitMessageEvent } from '@/application/events/messageEvents'
import type {
  AssistantEntry,
  ConversationEntry,
  DisplayMessage,
  EntryStatus,
  StopReason,
  ToolResultEntry,
} from '@/features/agent-runtime/session/types'
import type { Message, MessagePart, ToolStatus } from '@/types/models'

export type ToolCallPartFields = {
  id?: string
  name?: string
  args?: Record<string, unknown>
  status?: ToolStatus
  result?: string
}

export type HydrateDiagnostic = {
  sessionId: string
  message: string
  code?: string
}

export const DEFAULT_MAX_CACHED_SESSIONS = 8

type EntriesBySession = Record<string, ConversationEntry[]>

let sessionAccessOrder: string[] = []
const retainedSessionCounts = new Map<string, number>()

/** Keep a mounted conversation in memory while other sessions stream concurrently. */
export function retainMessageSession(sessionId: string): () => void {
  if (!sessionId) return () => {}
  retainedSessionCounts.set(
    sessionId,
    (retainedSessionCounts.get(sessionId) ?? 0) + 1,
  )
  let released = false
  return () => {
    if (released) return
    released = true
    const next = (retainedSessionCounts.get(sessionId) ?? 1) - 1
    if (next > 0) retainedSessionCounts.set(sessionId, next)
    else retainedSessionCounts.delete(sessionId)
  }
}

function touchSessionAccess(sessionId: string): void {
  if (!sessionId) return
  const idx = sessionAccessOrder.indexOf(sessionId)
  if (idx !== -1) {
    sessionAccessOrder.splice(idx, 1)
  }
  sessionAccessOrder.push(sessionId)
}

function removeSessionAccess(sessionId: string): void {
  const idx = sessionAccessOrder.indexOf(sessionId)
  if (idx !== -1) {
    sessionAccessOrder.splice(idx, 1)
  }
}

export function resetMessageStoreAccessOrderForTests(): void {
  sessionAccessOrder = []
  retainedSessionCounts.clear()
}

interface MessageState {
  /** Single source of truth: canonical conversation entries by session. */
  entriesBySession: EntriesBySession
  maxCachedSessions: number
  setMaxCachedSessions: (max: number) => void
  appendEntry: (entry: ConversationEntry) => void
  replaceEntry: (entry: ConversationEntry) => void
  removeEntry: (sessionId: string, entryId: string) => void
  getEntries: (sessionId: string) => ConversationEntry[]
  getDisplayMessages: (sessionId: string) => DisplayMessage[]
  replaceSessionEntries: (
    sessionId: string,
    entries: readonly ConversationEntry[],
  ) => void
  removeSessionMessages: (sessionId: string) => void
  hydrate: (rawBySession: Record<string, unknown>) => void
  getHydrateDiagnostics: () => HydrateDiagnostic[]
  clearHydrateDiagnostics: () => void

  /**
   * Legacy compatibility (projection/migration only — not a second store).
   * Prefer appendEntry/getDisplayMessages for new agent runtime code.
   */
  appendMessage: (message: Message) => void
  patchMessage: (
    sessionId: string,
    messageId: string,
    patch: Partial<Message>,
  ) => void
  updateToolPart: (
    sessionId: string,
    messageId: string,
    toolId: string,
    patch: Partial<ToolCallPartFields>,
  ) => void
  getMessages: (sessionId: string) => Message[]
}

let hydrateDiagnostics: HydrateDiagnostic[] = []

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual(a[key], b[key])) return false
  }
  return true
}

function areEntriesEqual(
  a: readonly ConversationEntry[] | undefined,
  b: readonly ConversationEntry[],
): boolean {
  if (a === b) return true
  if (!a) return b.length === 0
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqual(a[i], b[i])) return false
  }
  return true
}

function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return seen.get(value as object) as T
  if (Array.isArray(value)) {
    const arr: unknown[] = []
    seen.set(value as object, arr)
    for (const item of value) arr.push(deepClone(item, seen))
    return arr as T
  }
  const out: Record<string, unknown> = {}
  seen.set(value as object, out)
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepClone(nested, seen)
  }
  return out as T
}

function cloneEntry<T>(value: T): T {
  return deepClone(value)
}

function cloneEntries(entries: readonly ConversationEntry[]): ConversationEntry[] {
  return entries.map((entry) => cloneEntry(entry))
}

function createEntriesMap(
  seed?: EntriesBySession | null,
): EntriesBySession {
  const map = Object.create(null) as EntriesBySession
  if (!seed) return map
  for (const key of Reflect.ownKeys(seed)) {
    if (typeof key !== 'string' && typeof key !== 'symbol') continue
    const sessionId = String(key)
    const value = (seed as Record<string | symbol, ConversationEntry[]>)[key]
    map[sessionId] = value
  }
  return map
}

function freezeSessionEntries(
  entries: ConversationEntry[],
): ConversationEntry[] {
  // Freeze array + top-level entries so accidental component mutation fails.
  for (const entry of entries) {
    Object.freeze(entry)
  }
  return Object.freeze(entries) as ConversationEntry[]
}

function setSessionEntriesWithLru(
  state: MessageState,
  sessionId: string,
  entries: ConversationEntry[],
): { nextState: Partial<MessageState>; evictedSessionIds: string[] } {
  touchSessionAccess(sessionId)
  const next = createEntriesMap(state.entriesBySession)
  next[sessionId] = freezeSessionEntries(entries)

  const max = state.maxCachedSessions || DEFAULT_MAX_CACHED_SESSIONS
  const allKeys = Object.keys(next)
  const evictedSessionIds: string[] = []

  if (allKeys.length > max) {
    for (const candidateId of [...sessionAccessOrder]) {
      if (allKeys.length - evictedSessionIds.length <= max) break
      if (candidateId === sessionId) continue // Protect current touched session
      if (retainedSessionCounts.has(candidateId)) continue
      const candidateEntries = next[candidateId]
      if (!candidateEntries) continue

      // Protect session if it is actively streaming
      const last = candidateEntries[candidateEntries.length - 1]
      if (last && 'status' in last && (last as { status?: string }).status === 'streaming') continue

      delete next[candidateId]
      removeSessionAccess(candidateId)
      evictedSessionIds.push(candidateId)
    }
  }

  return {
    nextState: { entriesBySession: next },
    evictedSessionIds,
  }
}

function setSessionEntries(
  state: MessageState,
  sessionId: string,
  entries: ConversationEntry[],
): Partial<MessageState> {
  return setSessionEntriesWithLru(state, sessionId, entries).nextState
}

function ownSessionEntries(
  map: EntriesBySession,
  sessionId: string,
): ConversationEntry[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, sessionId)) {
    return undefined
  }
  return map[sessionId]
}

function mapDisplayToolStatus(status: string): ToolStatus {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'awaiting_approval') return 'awaiting_approval'
  if (status === 'rejected') return 'rejected'
  if (status === 'error') return 'error'
  if (status === 'aborted') return 'aborted'
  return 'done'
}

function displayToLegacyMessages(display: DisplayMessage[]): Message[] {
  const messages: Message[] = []
  for (const item of display) {
    if (item.kind !== 'message') continue
    const parts: MessagePart[] | undefined = item.parts
      ? item.parts
          .map((part): MessagePart | null => {
            if (part.type === 'text') return { type: 'text', text: part.text }
            if (part.type === 'tool_call') {
              const status: ToolStatus = mapDisplayToolStatus(part.status)
              return {
                type: 'tool_call',
                id: part.id,
                name: part.name,
                args: part.args,
                status,
                result: part.result,
              }
            }
            // thinking / other display-only parts are not legacy MessagePart.
            return null
          })
          .filter((part): part is MessagePart => part !== null)
      : undefined
    messages.push({
      id: item.id,
      sessionId: item.sessionId,
      role: item.role,
      content: item.content,
      parts,
      status: item.status,
      createdAt: item.createdAt,
    })
  }
  return messages
}

function migrateSession(
  sessionId: string,
  value: unknown,
): { entries: ConversationEntry[]; diagnostic?: HydrateDiagnostic } {
  try {
    if (value == null) {
      return {
        entries: [],
        diagnostic: {
          sessionId,
          message: 'Session payload was null/undefined; hydrated as empty',
          code: 'null_payload',
        },
      }
    }
    if (!Array.isArray(value)) {
      return {
        entries: [],
        diagnostic: {
          sessionId,
          message: 'Session payload was not an array; hydrated as empty',
          code: 'invalid_payload',
        },
      }
    }
    return {
      entries: migrateLegacyMessages(sessionId, value, { mode: 'restart' }),
    }
  } catch (error) {
    return {
      entries: [],
      diagnostic: {
        sessionId,
        message:
          error instanceof Error
            ? error.message
            : 'Unknown migration failure',
        code: 'migration_throw',
      },
    }
  }
}

function mapLegacyStatus(status: unknown): EntryStatus | undefined {
  if (status === 'streaming' || status === 'running') return 'streaming'
  if (status === 'done') return 'done'
  if (status === 'error') return 'error'
  if (status === 'aborted') return 'aborted'
  return undefined
}

function stopReasonForStatus(status: EntryStatus): StopReason {
  if (status === 'streaming') return 'pending'
  if (status === 'error') return 'error'
  if (status === 'aborted') return 'aborted'
  return 'stop'
}

/**
 * Lossless patch of a canonical assistant/user entry from legacy fields.
 * Preserves images, tool args, usage, responseId, and other metadata.
 */
function applyLegacyPatchToEntry(
  target: ConversationEntry,
  patch: Partial<Message>,
): ConversationEntry[] {
  if (target.kind === 'user') {
    const next = cloneEntry(target)
    if (typeof patch.content === 'string') {
      const textBlocks = next.content.filter((block) => block.type === 'text')
      const nonText = next.content.filter((block) => block.type !== 'text')
      if (textBlocks.length === 0) {
        next.content = [{ type: 'text', text: patch.content }, ...nonText]
      } else {
        next.content = [
          { type: 'text', text: patch.content },
          ...textBlocks.slice(1),
          ...nonText,
        ]
      }
    }
    return [next]
  }

  if (target.kind !== 'assistant') {
    return [cloneEntry(target)]
  }

  const next: AssistantEntry = cloneEntry(target)
  const status = mapLegacyStatus(patch.status)
  if (status) {
    next.status = status
    next.stopReason = stopReasonForStatus(status)
  }

  if (typeof patch.content === 'string') {
    const content = next.content.slice()
    const textIdx = content.findIndex((block) => block.type === 'text')
    if (textIdx >= 0) {
      content[textIdx] = { type: 'text', text: patch.content }
    } else {
      content.unshift({ type: 'text', text: patch.content })
    }
    // Keep images / thinking / toolCalls that display projection cannot round-trip.
    next.content = content
  }

  if (Array.isArray(patch.parts)) {
    const preservedNonToolNonText = next.content.filter(
      (block) =>
        block.type === 'image' ||
        block.type === 'thinking' ||
        (block.type !== 'text' && block.type !== 'toolCall'),
    )
    const nextContent: AssistantEntry['content'] = []
    const producedToolIds = new Set<string>()

    for (const part of patch.parts) {
      if (!part || typeof part !== 'object') continue
      if (part.type === 'text' && typeof part.text === 'string') {
        nextContent.push({ type: 'text', text: part.text })
        continue
      }
      if (part.type === 'tool_call' && typeof part.id === 'string') {
        producedToolIds.add(part.id)
        const existing = next.content.find(
          (block) => block.type === 'toolCall' && block.id === part.id,
        )
        const args =
          part.args && typeof part.args === 'object'
            ? deepClone(part.args)
            : existing && existing.type === 'toolCall'
              ? deepClone(existing.arguments)
              : {}
        nextContent.push({
          type: 'toolCall',
          id: part.id,
          name:
            typeof part.name === 'string'
              ? part.name
              : existing && existing.type === 'toolCall'
                ? existing.name
                : 'tool',
          arguments: args,
        })
      }
    }

    // Preserve image/thinking blocks the legacy parts array cannot express.
    for (const block of preservedNonToolNonText) {
      nextContent.push(cloneEntry(block))
    }
    // Preserve tool calls missing from patch.parts (should be rare).
    for (const block of next.content) {
      if (
        block.type === 'toolCall' &&
        !producedToolIds.has(block.id) &&
        !nextContent.some(
          (item) => item.type === 'toolCall' && item.id === block.id,
        )
      ) {
        nextContent.push(cloneEntry(block))
      }
    }
    next.content = nextContent
  }

  // responseId / usage / api / provider / model are never cleared by patch.
  return [next]
}

export const useMessageStore = create<MessageState>((set, get) => ({
  entriesBySession: createEntriesMap(),
  maxCachedSessions: DEFAULT_MAX_CACHED_SESSIONS,

  setMaxCachedSessions: (max: number) => {
    set({ maxCachedSessions: Math.max(1, max) })
  },

  appendEntry: (entry) => {
    const sessionId = entry.sessionId
    let evicted: string[] = []
    set((state) => {
      const list = ownSessionEntries(state.entriesBySession, sessionId) ?? []
      const res = setSessionEntriesWithLru(state, sessionId, [
        ...list,
        cloneEntry(entry),
      ])
      evicted = res.evictedSessionIds
      return res.nextState
    })
    const entries = ownSessionEntries(get().entriesBySession, sessionId)
    if (entries) {
      emitMessageEvent({ type: 'entries-updated', sessionId, entries })
    }
    for (const evictedId of evicted) {
      emitMessageEvent({ type: 'session-evicted', sessionId: evictedId })
    }
  },

  replaceEntry: (entry) => {
    const sessionId = entry.sessionId
    let evicted: string[] = []
    set((state) => {
      const list = ownSessionEntries(state.entriesBySession, sessionId) ?? []
      const index = list.findIndex((item) => item.id === entry.id)
      const next = cloneEntry(entry)
      if (index === -1) {
        // Explicit upsert: missing id is appended so streaming start races are safe.
        // If there are pending user messages waiting to run, insert the active run's entry
        // before the first pending message so current run's items stay contiguous.
        const firstPendingIndex = list.findIndex(
          (item) => item.kind === 'user' && Boolean((item as any).pendingStatus),
        )
        const nextList =
          firstPendingIndex !== -1
            ? [
                ...list.slice(0, firstPendingIndex),
                next,
                ...list.slice(firstPendingIndex),
              ]
            : [...list, next]
        const res = setSessionEntriesWithLru(state, sessionId, nextList)
        evicted = res.evictedSessionIds
        return res.nextState
      }
      const updated = list.slice()
      updated[index] = next
      const res = setSessionEntriesWithLru(state, sessionId, updated)
      evicted = res.evictedSessionIds
      return res.nextState
    })
    const entries = ownSessionEntries(get().entriesBySession, sessionId)
    if (entries) {
      // Avoid expensive full-history file-diff & todo-parsing on high-frequency streaming text chunks
      // and prevent partial tool call arguments from triggering premature half-updates before completion
      const isStreamingAssistant =
        entry.kind === 'assistant' && entry.status === 'streaming'
      emitMessageEvent({
        type: 'entries-updated',
        sessionId,
        entries,
        skipExpensiveProjections: isStreamingAssistant,
      })
    }
    for (const evictedId of evicted) {
      emitMessageEvent({ type: 'session-evicted', sessionId: evictedId })
    }
  },

  removeEntry: (sessionId, entryId) => {
    set((state) => {
      const list = ownSessionEntries(state.entriesBySession, sessionId)
      if (!list) return state
      const next = list.filter((entry) => entry.id !== entryId)
      if (next.length === list.length) return state
      return setSessionEntries(state, sessionId, next)
    })
    const entries = ownSessionEntries(get().entriesBySession, sessionId)
    emitMessageEvent({
      type: 'entries-updated',
      sessionId,
      entries: entries ?? [],
    })
  },

  getEntries: (sessionId) => {
    const entries = ownSessionEntries(get().entriesBySession, sessionId)
    if (entries && entries.length > 0) {
      touchSessionAccess(sessionId)
      return cloneEntries(entries)
    }
    return []
  },

  getDisplayMessages: (sessionId) => {
    const entries = ownSessionEntries(get().entriesBySession, sessionId)
    if (entries && entries.length > 0) {
      touchSessionAccess(sessionId)
      return projectConversation(entries)
    }
    return []
  },

  replaceSessionEntries: (sessionId, entries) => {
    let evicted: string[] = []
    set((state) => {
      const existing = ownSessionEntries(state.entriesBySession, sessionId)
      if (areEntriesEqual(existing, entries)) {
        touchSessionAccess(sessionId)
        return state
      }
      const res = setSessionEntriesWithLru(state, sessionId, cloneEntries(entries))
      evicted = res.evictedSessionIds
      return res.nextState
    })
    emitMessageEvent({ type: 'entries-updated', sessionId, entries })
    for (const evictedId of evicted) {
      emitMessageEvent({ type: 'session-evicted', sessionId: evictedId })
    }
  },

  removeSessionMessages: (sessionId) => {
    removeSessionAccess(sessionId)
    set((state) => {
      if (!Object.prototype.hasOwnProperty.call(state.entriesBySession, sessionId)) {
        return state
      }
      const next = createEntriesMap(state.entriesBySession)
      delete next[sessionId]
      return { entriesBySession: next }
    })
    emitMessageEvent({ type: 'session-cleared', sessionId })
  },

  hydrate: (rawBySession) => {
    const next = createEntriesMap()
    const diagnostics: HydrateDiagnostic[] = []
    const source =
      rawBySession && typeof rawBySession === 'object' ? rawBySession : {}

    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== 'string') continue
      const sessionId = key
      const value = (source as Record<string, unknown>)[sessionId]
      const result = migrateSession(sessionId, value)
      next[sessionId] = freezeSessionEntries(result.entries)
      if (result.diagnostic) diagnostics.push(result.diagnostic)
      emitMessageEvent({ type: 'entries-updated', sessionId, entries: result.entries })
    }

    hydrateDiagnostics = diagnostics
    set({ entriesBySession: next })
  },

  getHydrateDiagnostics: () => hydrateDiagnostics.slice(),

  clearHydrateDiagnostics: () => {
    hydrateDiagnostics = []
  },

  appendMessage: (message) => {
    // Live mode preserves streaming status for in-flight legacy bridges.
    const migrated = migrateLegacyMessages(message.sessionId, [message], {
      mode: 'live',
    })
    for (const entry of migrated) {
      get().appendEntry(entry)
    }
  },

  patchMessage: (sessionId, messageId, patch) => {
    const entries = ownSessionEntries(get().entriesBySession, sessionId) ?? []
    const target = entries.find((entry) => entry.id === messageId)
    if (!target) return

    const remigrated = applyLegacyPatchToEntry(target, patch)
    if (remigrated.length === 0) return

    set((state) => {
      const list = ownSessionEntries(state.entriesBySession, sessionId) ?? []
      const index = list.findIndex((entry) => entry.id === messageId)
      if (index === -1) {
        return setSessionEntries(state, sessionId, [
          ...list,
          ...cloneEntries(remigrated),
        ])
      }
      const updated = list.slice()
      updated[index] = cloneEntry(remigrated[0])
      return setSessionEntries(state, sessionId, updated)
    })
  },

  updateToolPart: (sessionId, messageId, toolId, patch) => {
    const entries = ownSessionEntries(get().entriesBySession, sessionId) ?? []
    const target = entries.find(
      (entry) => entry.kind === 'assistant' && entry.id === messageId,
    )
    if (!target || target.kind !== 'assistant') return

    // Preserve unrelated blocks (images, other tools, usage, responseId).
    const content = target.content.map((block) => {
      if (block.type !== 'toolCall' || block.id !== toolId) return block
      return {
        ...block,
        name: patch.name ?? block.name,
        arguments: patch.args ? deepClone(patch.args) : block.arguments,
      }
    })
    get().replaceEntry({
      ...target,
      content,
      // Preserve responseId/usage/model metadata via spread of target.
    })

    if (
      typeof patch.result === 'string' ||
      patch.status === 'done' ||
      patch.status === 'rejected'
    ) {
      const existing = entries.find(
        (entry): entry is ToolResultEntry =>
          entry.kind === 'toolResult' && entry.toolCallId === toolId,
      )
      const resultEntry: ConversationEntry = {
        id: existing?.id ?? `${messageId}:tool:${toolId}`,
        sessionId,
        createdAt: existing?.createdAt ?? Date.now(),
        kind: 'toolResult',
        version: 1,
        toolCallId: toolId,
        toolName:
          (content.find(
            (block) => block.type === 'toolCall' && block.id === toolId,
          ) as { name?: string } | undefined)?.name ??
          (existing && existing.kind === 'toolResult' ? existing.toolName : 'tool'),
        content:
          typeof patch.result === 'string' && patch.result
            ? [{ type: 'text', text: patch.result }]
            : existing && existing.kind === 'toolResult'
              ? existing.content
              : [],
        isError: patch.status === 'rejected',
      }
      if (existing) get().replaceEntry(resultEntry)
      else get().appendEntry(resultEntry)
    }
  },

  getMessages: (sessionId) =>
    displayToLegacyMessages(
      projectConversation(
        ownSessionEntries(get().entriesBySession, sessionId) ?? [],
      ),
    ),
}))
