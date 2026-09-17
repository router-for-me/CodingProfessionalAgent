/**
 * Run-scoped adapter that projects AgentRunEvent streams into the canonical
 * ConversationEntry store. Framework-agnostic: accepts store actions/instance.
 *
 * Multiple adapters bound to the same store share a WeakMap-backed run
 * registry so late agent-start events cannot clobber an active run.
 */

import { TOOL_REJECTED_MESSAGE } from '../agent/approvals'
import type { AgentRunEvent, ToolResult } from '../agent/types'
import {
  deterministicToolResultId,
  normalizeToolCallId,
} from '../session/migration'
import type {
  AssistantEntry,
  CompactionEntry,
  ConversationEntry,
  DisplayToolStatus,
  ToolResultContentBlock,
  ToolResultEntry,
  UserEntry,
} from '../session/types'
import {
  useCompactionOverlayStore,
  type CompactionOverlayState,
} from '@/stores/compactionOverlayStore'
import {
  cloneOverlayDetails,
  cloneOverlayImages,
  useToolOverlayStore,
  type ToolOverlayImage,
  type ToolOverlayStore,
} from '@/stores/toolOverlayStore'

/** Fixed abort message emitted by AgentLoop for aborted tools. */
const ABORTED_TOOL_MESSAGE = 'Tool execution aborted'

export type PersistUrgency = 'none' | 'debounce' | 'immediate'

export interface ApplyAgentEventResult {
  changed: boolean
  urgency: PersistUrgency
  diagnostic?: string
}

export interface ConversationStoreActions {
  appendEntry: (entry: ConversationEntry) => void
  replaceEntry: (entry: ConversationEntry) => void
  removeEntry: (sessionId: string, entryId: string) => void
  getEntries: (sessionId: string) => ConversationEntry[]
  replaceSessionEntries: (
    sessionId: string,
    entries: readonly ConversationEntry[],
  ) => void
}

export interface ConversationStoreLike {
  getState: () => ConversationStoreActions
}

const NO_CHANGE: ApplyAgentEventResult = { changed: false, urgency: 'none' }

type StoreKey = object

type SessionRunMeta = {
  runId: string
  /** Entry ids present in the store when the run started. */
  baseIds: Set<string>
  /** Entry ids written by this adapter for the active run. */
  ownedIds: Set<string>
  /**
   * Pending tool results keyed by normalized call id (bounded by tool calls).
   * Map insertion order preserves source order for flush.
   */
  pendingToolResults: Map<string, ToolResultEntry>
}

type RunRegistry = {
  activeRunBySession: Map<string, string | null>
  /** error/aborted received; still accept same-run agent-end. */
  terminalPendingBySession: Map<string, string>
  /** Fully ended runs (after agent-end); reject late events. */
  endedRuns: Map<string, string>
  runMetaBySession: Map<string, SessionRunMeta>
}

const registries = new WeakMap<StoreKey, RunRegistry>()
/** Overlay instance bound per conversation store when not injected. */
const overlayByStore = new WeakMap<StoreKey, ToolOverlayStore>()

function stampCompletedAt(entry: AssistantEntry, now = Date.now()): AssistantEntry {
  if (entry.status === 'streaming') return entry
  if (typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt)) {
    return entry
  }
  return { ...entry, completedAt: now }
}

function stampEntryCompletedAt(entry: ConversationEntry): ConversationEntry {
  if (entry.kind !== 'assistant') return entry
  return stampCompletedAt(entry)
}

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

function buildToolResultEntry(
  sessionId: string,
  toolCallId: string,
  toolName: string,
  content: ToolResultContentBlock[],
  isError: boolean,
  existing?: ToolResultEntry,
): ToolResultEntry {
  return {
    id: existing?.id ?? deterministicToolResultId(sessionId, toolCallId),
    sessionId,
    createdAt: existing?.createdAt ?? Date.now(),
    kind: 'toolResult',
    version: 1,
    toolCallId,
    toolName,
    content: deepClone(content),
    isError,
  }
}

function canonicalToolContent(
  content: readonly ToolResultContentBlock[] | undefined,
): ToolResultContentBlock[] {
  if (!content) return []
  return content
    .filter(
      (block): block is ToolResultContentBlock =>
        block.type === 'text' || block.type === 'image',
    )
    .map((block) => deepClone(block))
}

function joinToolText(
  content: readonly ToolResultContentBlock[] | undefined,
): string {
  if (!content) return ''
  const chunks: string[] = []
  for (const block of content) {
    if (block.type === 'text') chunks.push(block.text)
  }
  return chunks.join('')
}

function extractOverlayImages(
  content: readonly ToolResultContentBlock[] | undefined,
): ToolOverlayImage[] | undefined {
  if (!content) return undefined
  const images: ToolOverlayImage[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') {
      continue
    }
    images.push({ data: block.data, mimeType: block.mimeType })
  }
  // Absent image blocks → undefined (no-change for tool-update merge).
  if (images.length === 0) return undefined
  return cloneOverlayImages(images)
}

/**
 * Deterministic live status for tool-end:
 * approval reject fixed text → rejected;
 * abort fixed text → aborted;
 * otherwise isError → error; else done.
 */
export function classifyToolEndStatus(
  result: ToolResult | undefined,
  isError: boolean,
): DisplayToolStatus {
  const text = joinToolText(result?.content)
  if (text === TOOL_REJECTED_MESSAGE || text.includes(TOOL_REJECTED_MESSAGE)) {
    return 'rejected'
  }
  if (text === ABORTED_TOOL_MESSAGE || text.includes(ABORTED_TOOL_MESSAGE)) {
    return 'aborted'
  }
  if (isError || result?.isError) return 'error'
  return 'done'
}

export interface AgentEventAdapterOptions {
  /**
   * Per-runtime overlay instance. When omitted, the default singleton is used
   * (ChatView / messageStore compatibility) and also cached on the store key.
   */
  overlayStore?: ToolOverlayStore
  compactionStore?: {
    getState: () => Pick<
      CompactionOverlayState,
      'setCompacting' | 'clearSessions' | 'clearAll'
    >
  }
}

/**
 * Resolve overlay store: explicit inject wins; else WeakMap-bound instance for
 * this conversation store, falling back to the default singleton export.
 */
export function resolveOverlayStoreFor(
  store: ConversationStoreLike | ConversationStoreActions,
  options?: AgentEventAdapterOptions,
): ToolOverlayStore {
  if (options?.overlayStore) return options.overlayStore
  const key = registryKeyFor(store)
  const existing = overlayByStore.get(key)
  if (existing) return existing
  // Default shared instance so ChatView can subscribe without wiring.
  overlayByStore.set(key, useToolOverlayStore)
  return useToolOverlayStore
}

/** Bind a custom default overlay for a conversation store (Task18 / tests). */
export function bindOverlayStoreFor(
  store: ConversationStoreLike | ConversationStoreActions,
  overlayStore: ToolOverlayStore,
): void {
  overlayByStore.set(registryKeyFor(store), overlayStore)
}

function patchToolOverlay(
  overlayStore: ToolOverlayStore,
  sessionId: string,
  runId: string,
  toolCallId: string,
  patch: {
    status?: DisplayToolStatus
    partialOutput?: string | null
    details?: unknown | null
    resultImages?: ToolOverlayImage[] | null
  },
): void {
  overlayStore.getState().patch(sessionId, toolCallId, runId, {
    status: patch.status,
    partialOutput: patch.partialOutput,
    details:
      patch.details === null
        ? null
        : patch.details === undefined
          ? undefined
          : (cloneOverlayDetails(patch.details) ?? null),
    resultImages:
      patch.resultImages === null
        ? null
        : patch.resultImages === undefined
          ? undefined
          : (cloneOverlayImages(patch.resultImages) ?? []),
  })
}

function latchTerminalOverlay(
  overlayStore: ToolOverlayStore,
  sessionId: string,
  runId: string,
  toolCallId: string,
  fields: {
    status: DisplayToolStatus
    partialOutput?: string
    details?: unknown
    resultImages?: ToolOverlayImage[]
  },
): void {
  overlayStore.getState().replaceTerminal(sessionId, toolCallId, runId, {
    status: fields.status,
    // Final tool-end always clears streaming partial unless a final string is given.
    partialOutput:
      typeof fields.partialOutput === 'string' ? fields.partialOutput : undefined,
    details: cloneOverlayDetails(fields.details),
    // Empty list is intentional — UI falls back to canonical images.
    resultImages: fields.resultImages ?? [],
  })
}

function registryKeyFor(
  store: ConversationStoreLike | ConversationStoreActions,
): StoreKey {
  if ('getState' in store && typeof store.getState === 'function') {
    return store as object
  }
  return store as object
}

function getRegistry(key: StoreKey): RunRegistry {
  let reg = registries.get(key)
  if (!reg) {
    reg = {
      activeRunBySession: new Map(),
      terminalPendingBySession: new Map(),
      endedRuns: new Map(),
      runMetaBySession: new Map(),
    }
    registries.set(key, reg)
  }
  return reg
}

function entrySessionMismatch(
  entry: ConversationEntry | undefined,
  sessionId: string,
): boolean {
  return Boolean(entry && entry.sessionId !== sessionId)
}

function findToolResult(
  entries: readonly ConversationEntry[],
  toolCallId: string,
): ToolResultEntry | undefined {
  const normalized = normalizeToolCallId(toolCallId)
  return entries.find(
    (entry): entry is ToolResultEntry =>
      entry.kind === 'toolResult' &&
      (entry.toolCallId === toolCallId ||
        normalizeToolCallId(entry.toolCallId) === normalized),
  )
}

function assistantHasToolCall(
  entry: ConversationEntry,
  toolCallId: string,
): entry is AssistantEntry {
  if (entry.kind !== 'assistant') return false
  const normalized = normalizeToolCallId(toolCallId)
  return entry.content.some(
    (block) =>
      block.type === 'toolCall' &&
      (block.id === toolCallId ||
        normalizeToolCallId(block.id) === normalized),
  )
}

function findOwningAssistant(
  entries: readonly ConversationEntry[],
  toolCallId: string,
): AssistantEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (assistantHasToolCall(entry, toolCallId)) {
      return entry
    }
  }
  return undefined
}

/**
 * Insert a tool result immediately after its assistant and any existing
 * results for that assistant, ordered by assistant toolCall order.
 */
function insertToolResultOrdered(
  entries: readonly ConversationEntry[],
  toolResult: ToolResultEntry,
): ConversationEntry[] {
  const assistant = findOwningAssistant(entries, toolResult.toolCallId)
  if (!assistant) {
    return [...entries, toolResult]
  }

  const assistantIndex = entries.findIndex((entry) => entry.id === assistant.id)
  if (assistantIndex === -1) {
    return [...entries, toolResult]
  }

  const toolOrder = assistant.content
    .filter((block) => block.type === 'toolCall')
    .map((block) =>
      block.type === 'toolCall' ? normalizeToolCallId(block.id) : '',
    )
  const targetNorm = normalizeToolCallId(toolResult.toolCallId)
  const targetOrder = toolOrder.indexOf(targetNorm)

  // Region of consecutive tool results after the assistant.
  let regionEnd = assistantIndex + 1
  while (
    regionEnd < entries.length &&
    entries[regionEnd].kind === 'toolResult'
  ) {
    regionEnd += 1
  }

  const region = entries.slice(assistantIndex + 1, regionEnd) as ToolResultEntry[]
  let insertAt = region.length
  if (targetOrder >= 0) {
    insertAt = region.length
    for (let i = 0; i < region.length; i += 1) {
      const existingNorm = normalizeToolCallId(region[i].toolCallId)
      const existingOrder = toolOrder.indexOf(existingNorm)
      if (existingOrder === -1 || existingOrder > targetOrder) {
        insertAt = i
        break
      }
    }
  }

  const next = entries.slice()
  next.splice(assistantIndex + 1 + insertAt, 0, toolResult)
  return next
}

function reconcileAgentEnd(
  current: readonly ConversationEntry[],
  authoritative: readonly ConversationEntry[],
  meta: SessionRunMeta | undefined,
): ConversationEntry[] {
  if (!meta || current.length === 0) {
    return authoritative.map((entry) => stampEntryCompletedAt(deepClone(entry)))
  }

  const baseIds = meta.baseIds
  const ownedIds = meta.ownedIds
  const currentById = new Map(current.map((entry) => [entry.id, entry]))

  // Base entries the run never owned may have concurrent external edits.
  const protectedIds = new Set<string>()
  for (const entry of current) {
    if (baseIds.has(entry.id) && !ownedIds.has(entry.id)) {
      protectedIds.add(entry.id)
    }
  }

  const authById = new Map<string, ConversationEntry>()
  for (const entry of authoritative) {
    authById.set(entry.id, entry)
  }

  const result: ConversationEntry[] = []
  const seen = new Set<string>()
  let authCursor = 0

  const drainAuthUpTo = (targetId: string) => {
    while (authCursor < authoritative.length) {
      const authEntry = authoritative[authCursor]
      authCursor++
      if (seen.has(authEntry.id)) continue

      // External deletion check
      if (
        baseIds.has(authEntry.id) &&
        !ownedIds.has(authEntry.id) &&
        !currentById.has(authEntry.id)
      ) {
        continue
      }

      if (protectedIds.has(authEntry.id)) {
        const local = currentById.get(authEntry.id)
        result.push(deepClone(local ?? authEntry))
      } else {
        result.push(stampEntryCompletedAt(deepClone(authEntry)))
      }
      seen.add(authEntry.id)

      if (authEntry.id === targetId) break
    }
  }

  // Walk through current to preserve the interleaving of external additions (e.g. queued user messages)
  for (const entry of current) {
    if (seen.has(entry.id)) continue

    const isExternalAddition = !baseIds.has(entry.id) && !ownedIds.has(entry.id)
    if (isExternalAddition) {
      result.push(deepClone(entry))
      seen.add(entry.id)
      continue
    }

    if (authById.has(entry.id)) {
      drainAuthUpTo(entry.id)
    }
  }

  // Drain any remaining authoritative entries
  while (authCursor < authoritative.length) {
    const authEntry = authoritative[authCursor]
    authCursor++
    if (seen.has(authEntry.id)) continue

    if (
      baseIds.has(authEntry.id) &&
      !ownedIds.has(authEntry.id) &&
      !currentById.has(authEntry.id)
    ) {
      continue
    }

    if (protectedIds.has(authEntry.id)) {
      const local = currentById.get(authEntry.id)
      result.push(deepClone(local ?? authEntry))
    } else {
      result.push(stampEntryCompletedAt(deepClone(authEntry)))
    }
    seen.add(authEntry.id)
  }

  return result
}

function collectKnownToolCallIds(
  entries: readonly ConversationEntry[],
): Set<string> {
  const known = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'assistant') continue
    for (const block of entry.content) {
      if (block.type === 'toolCall') {
        known.add(normalizeToolCallId(block.id))
      }
    }
  }
  return known
}

/**
 * Append a tool result after its owning assistant and any existing consecutive
 * tool results — preserves arrival order (no toolCall reordering).
 */
function appendToolResultAfterAssistantRegion(
  entries: readonly ConversationEntry[],
  toolResult: ToolResultEntry,
): ConversationEntry[] {
  const assistant = findOwningAssistant(entries, toolResult.toolCallId)
  if (!assistant) {
    return [...entries, toolResult]
  }

  const assistantIndex = entries.findIndex((entry) => entry.id === assistant.id)
  if (assistantIndex === -1) {
    return [...entries, toolResult]
  }

  // Region of consecutive tool results after the assistant.
  let regionEnd = assistantIndex + 1
  while (
    regionEnd < entries.length &&
    entries[regionEnd].kind === 'toolResult'
  ) {
    regionEnd += 1
  }

  const next = entries.slice()
  next.splice(regionEnd, 0, toolResult)
  return next
}

/**
 * Terminal fallback flush (agent-end without authoritative entries).
 * Preserves pending Map insertion/source order; first-wins dedupe against
 * existing store results. Does NOT re-sort by assistant toolCall order.
 */
function flushPendingToolResults(
  actions: ConversationStoreActions,
  sessionId: string,
  meta: SessionRunMeta,
): boolean {
  if (meta.pendingToolResults.size === 0) return false
  let list = actions.getEntries(sessionId)
  let changed = false
  // Map iteration is insertion/source order (first normalized id wins).
  for (const buffered of meta.pendingToolResults.values()) {
    if (findToolResult(list, buffered.toolCallId)) continue
    list = appendToolResultAfterAssistantRegion(list, buffered)
    meta.ownedIds.add(buffered.id)
    changed = true
  }
  meta.pendingToolResults.clear()
  if (changed) {
    actions.replaceSessionEntries(sessionId, list)
  }
  return changed
}

/**
 * Create a run-scoped agent event adapter bound to a Zustand-like store.
 * Active run is tracked per sessionId; late events from older runs are ignored.
 * Overlay state is per options.overlayStore / WeakMap-bound instance — dispose
 * only clears this adapter's overlay instance (not other runtimes).
 */
export function createAgentEventAdapter(
  store: ConversationStoreLike | ConversationStoreActions,
  options?: AgentEventAdapterOptions,
): {
  apply: (event: AgentRunEvent) => ApplyAgentEventResult
  getActiveRunId: (sessionId: string) => string | null
  getOverlayStore: () => ToolOverlayStore
  reset: () => void
  dispose: () => void
} {
  const key = registryKeyFor(store)
  const registry = getRegistry(key)
  const overlayStore = resolveOverlayStoreFor(store, options)
  const compactionStore = options?.compactionStore ?? useCompactionOverlayStore
  // Sessions this adapter has written overlays for — dispose clears only these
  // when the overlay instance might be shared; private instances use clearAll.
  const ownedOverlaySessions = new Set<string>()
  const ownedCompactionSessions = new Set<string>()
  const injectedOverlay = Boolean(options?.overlayStore)

  const setCompacting = (sessionId: string, compacting: boolean): void => {
    ownedCompactionSessions.add(sessionId)
    compactionStore.getState().setCompacting(sessionId, compacting)
  }

  const actionsOf = (): ConversationStoreActions => {
    if ('getState' in store && typeof store.getState === 'function') {
      return store.getState()
    }
    return store as ConversationStoreActions
  }

  const touchOverlaySession = (sessionId: string): void => {
    ownedOverlaySessions.add(sessionId)
  }

  const isActive = (sessionId: string, runId: string): boolean => {
    const active = registry.activeRunBySession.get(sessionId)
    if (active === undefined || active === null) return false
    return active === runId
  }

  const isTerminalPending = (sessionId: string, runId: string): boolean =>
    registry.terminalPendingBySession.get(sessionId) === runId

  const isFullyEnded = (sessionId: string, runId: string): boolean =>
    registry.endedRuns.get(sessionId) === runId &&
    registry.activeRunBySession.get(sessionId) !== runId

  const canAcceptRunEvent = (sessionId: string, runId: string): boolean => {
    if (isFullyEnded(sessionId, runId)) return false
    if (isTerminalPending(sessionId, runId)) {
      // Only agent-end may continue after error/aborted terminal-pending.
      return false
    }
    const active = registry.activeRunBySession.get(sessionId)
    if (active === runId) return true
    // If active !== runId, but active is empty or was from an ended/pending run, auto-bootstrap to runId:
    const isEmptyOrEndedOrPending =
      !active ||
      registry.endedRuns.get(sessionId) === active ||
      registry.terminalPendingBySession.get(sessionId) === active
    if (isEmptyOrEndedOrPending) {
      touchOverlaySession(sessionId)
      overlayStore.getState().clearSession(sessionId)
      registry.activeRunBySession.set(sessionId, runId)
      if (registry.terminalPendingBySession.get(sessionId) === active) {
        registry.terminalPendingBySession.delete(sessionId)
      }
      const existing = actionsOf().getEntries(sessionId)
      registry.runMetaBySession.set(sessionId, {
        runId,
        baseIds: new Set(existing.map((e) => e.id)),
        ownedIds: new Set(),
        pendingToolResults: new Map(),
      })
      return true
    }
    return false
  }

  const markOwned = (sessionId: string, entryId: string): void => {
    const meta = registry.runMetaBySession.get(sessionId)
    if (meta) meta.ownedIds.add(entryId)
  }

  const apply = (event: AgentRunEvent): ApplyAgentEventResult => {
    const { sessionId, runId } = event
    const actions = actionsOf()

    switch (event.type) {
      case 'agent-start': {
        const active = registry.activeRunBySession.get(sessionId)
        const pending = registry.terminalPendingBySession.get(sessionId)
        if (active === runId || registry.endedRuns.get(sessionId) === runId) {
          return NO_CHANGE
        }
        // Task15 single-active: ignore late start while another run is live.
        if (
          active &&
          active !== runId &&
          active !== null &&
          !pending
        ) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: `ignored late agent-start run=${runId}; active=${active}`,
          }
        }

        const baseIds = new Set(
          actions.getEntries(sessionId).map((entry) => entry.id),
        )
        registry.activeRunBySession.set(sessionId, runId)
        registry.terminalPendingBySession.delete(sessionId)
        registry.runMetaBySession.set(sessionId, {
          runId,
          baseIds,
          ownedIds: new Set(),
          pendingToolResults: new Map(),
        })
        // Clear previous live overlays for this session; final cards keep
        // canonical resultImages via projection.
        touchOverlaySession(sessionId)
        overlayStore.getState().clearSession(sessionId)
        setCompacting(sessionId, false)
        return NO_CHANGE
      }

      case 'agent-end': {
        const active = registry.activeRunBySession.get(sessionId)
        const pending = registry.terminalPendingBySession.get(sessionId)
        const accept =
          active === runId ||
          pending === runId ||
          (active === null && pending === runId)
        if (!accept) return NO_CHANGE
        if (
          registry.endedRuns.get(sessionId) === runId &&
          active !== runId &&
          pending !== runId
        ) {
          return NO_CHANGE
        }

        let changed = false
        const meta = registry.runMetaBySession.get(sessionId)

        if (event.entries) {
          // Validate all entries belong to this session.
          const mismatched = event.entries.some((entry) =>
            entrySessionMismatch(entry, sessionId),
          )
          if (mismatched) {
            registry.activeRunBySession.set(sessionId, null)
            registry.terminalPendingBySession.delete(sessionId)
            registry.endedRuns.set(sessionId, runId)
            registry.runMetaBySession.delete(sessionId)
            setCompacting(sessionId, false)
            return {
              changed: false,
              urgency: 'none',
              diagnostic: 'agent-end entries sessionId mismatch; ignored',
            }
          }

          // Authoritative snapshot owns tool results; drop any pending buffer.
          meta?.pendingToolResults.clear()
          const current = actions.getEntries(sessionId)
          const merged = reconcileAgentEnd(current, event.entries, meta)
          actions.replaceSessionEntries(sessionId, merged)
          changed = true
        } else if (meta && meta.pendingToolResults.size > 0) {
          // Terminal-pending agent-end without entries: flush buffered tools
          // in source order when an owning assistant exists; otherwise drop.
          const list = actions.getEntries(sessionId)
          const hasAssistant = list.some((entry) => entry.kind === 'assistant')
          if (hasAssistant) {
            changed = flushPendingToolResults(actions, sessionId, meta) || changed
          } else {
            meta.pendingToolResults.clear()
            registry.activeRunBySession.set(sessionId, null)
            registry.terminalPendingBySession.delete(sessionId)
            registry.endedRuns.set(sessionId, runId)
            registry.runMetaBySession.delete(sessionId)
            setCompacting(sessionId, false)
            return {
              changed: false,
              urgency: 'none',
              diagnostic: 'agent-end dropped pending tools without assistant',
            }
          }
        }

        registry.activeRunBySession.set(sessionId, null)
        registry.terminalPendingBySession.delete(sessionId)
        registry.endedRuns.set(sessionId, runId)
        registry.runMetaBySession.delete(sessionId)
        setCompacting(sessionId, false)
        return changed
          ? { changed: true, urgency: 'immediate' }
          : NO_CHANGE
      }

      case 'aborted':
      case 'error': {
        if (!isActive(sessionId, runId)) return NO_CHANGE
        // Mark terminal-pending: still accept same-run agent-end reconcile.
        // Do not clear active ownership until agent-end (or next agent-start).
        registry.terminalPendingBySession.set(sessionId, runId)
        setCompacting(sessionId, false)
        return NO_CHANGE
      }

      case 'user-entry': {
        if (event.entry) {
          const existing = actions.getEntries(sessionId)
          const existingIndex = existing.findIndex((e) => e.id === event.entry!.id)
          if (existingIndex === -1) {
            actions.appendEntry(deepClone(event.entry) as UserEntry)
            markOwned(sessionId, event.entry.id)
            return { changed: true, urgency: 'none' }
          }
          const isTrailingAndIdentical =
            existingIndex === existing.length - 1 &&
            deepEqual(existing[existingIndex], event.entry)
          if (isTrailingAndIdentical) {
            markOwned(sessionId, event.entry.id)
            return NO_CHANGE
          }
          touchOverlaySession(sessionId)
          overlayStore.getState().clearSession(sessionId)
          const isPendingActivation = Boolean((existing[existingIndex] as any).pendingStatus)
          const updatedEntry = deepClone(event.entry) as UserEntry
          const kept = isPendingActivation
            ? existing.map((e, idx) => (idx === existingIndex ? updatedEntry : e))
            : [...existing.slice(0, existingIndex), updatedEntry]
          actions.replaceSessionEntries(sessionId, kept)
          const meta = registry.runMetaBySession.get(sessionId)
          if (meta) {
            meta.baseIds = new Set(kept.map((e) => e.id))
            meta.ownedIds.add(event.entry.id)
          }
          return { changed: true, urgency: 'none' }
        }
        return NO_CHANGE
      }

      case 'assistant-start': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        if (entrySessionMismatch(event.entry, sessionId)) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: 'assistant-start entry sessionId mismatch',
          }
        }
        const entry = deepClone(event.entry) as AssistantEntry
        actions.replaceEntry(entry)
        markOwned(sessionId, entry.id)
        return { changed: true, urgency: 'debounce' }
      }

      case 'assistant-update': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        if (entrySessionMismatch(event.entry, sessionId)) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: 'assistant-update entry sessionId mismatch',
          }
        }
        // The store owns the defensive clone; avoid copying the growing snapshot twice per token.
        const entry = stampCompletedAt(event.entry)
        actions.replaceEntry(entry)
        markOwned(sessionId, entry.id)
        return { changed: true, urgency: 'debounce' }
      }

      case 'assistant-end': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        if (entrySessionMismatch(event.entry, sessionId)) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: 'assistant-end entry sessionId mismatch',
          }
        }
        const entry = stampCompletedAt(deepClone(event.entry) as AssistantEntry)
        actions.replaceEntry(entry)
        markOwned(sessionId, entry.id)

        // Flush pending tool results that belong to this assistant.
        const meta = registry.runMetaBySession.get(sessionId)
        let changed = true
        if (meta && meta.pendingToolResults.size > 0) {
          let list = actions.getEntries(sessionId)
          const flushedNormIds: string[] = []
          for (const [normId, buffered] of meta.pendingToolResults) {
            if (!assistantHasToolCall(entry, buffered.toolCallId)) {
              continue
            }
            flushedNormIds.push(normId)
            if (findToolResult(list, buffered.toolCallId)) {
              continue
            }
            list = insertToolResultOrdered(list, buffered)
            markOwned(sessionId, buffered.id)
          }
          for (const normId of flushedNormIds) {
            meta.pendingToolResults.delete(normId)
          }
          actions.replaceSessionEntries(sessionId, list)
          changed = true
        }

        return { changed, urgency: 'immediate' }
      }

      case 'tool-approval-required': {
        // Runtime-only: update ephemeral overlay; never write ConversationEntry.
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        touchOverlaySession(sessionId)
        patchToolOverlay(overlayStore, sessionId, runId, event.toolCallId, {
          status: 'awaiting_approval',
        })
        return NO_CHANGE
      }

      case 'tool-start': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        touchOverlaySession(sessionId)
        patchToolOverlay(overlayStore, sessionId, runId, event.toolCallId, {
          status: 'running',
        })
        return NO_CHANGE
      }

      case 'tool-update': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        // tool-update may refresh partial/details/images (not latched like terminal).
        const partialOutput = joinToolText(event.result?.content) || undefined
        const updateImages = extractOverlayImages(event.result?.content)
        touchOverlaySession(sessionId)
        patchToolOverlay(overlayStore, sessionId, runId, event.toolCallId, {
          status: 'running',
          partialOutput:
            partialOutput !== undefined ? partialOutput : undefined,
          details:
            event.result?.details !== undefined
              ? event.result.details
              : undefined,
          resultImages: updateImages !== undefined ? updateImages : undefined,
        })
        return NO_CHANGE
      }

      case 'retrying':
      case 'diagnostic': {
        // Runtime-only signals: never write scratch fields into ConversationEntry.
        return NO_CHANGE
      }

      case 'compaction-start': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        setCompacting(sessionId, true)
        return NO_CHANGE
      }

      case 'tool-end': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE

        if (event.entry && entrySessionMismatch(event.entry, sessionId)) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: 'tool-end entry sessionId mismatch',
          }
        }

        const list = actions.getEntries(sessionId)
        const knownIds = collectKnownToolCallIds(list)
        const normCallId = normalizeToolCallId(event.toolCallId)
        if (!knownIds.has(normCallId)) {
          // Only accept call ids known by an active assistant; never buffer unknowns.
          return {
            changed: false,
            urgency: 'none',
            diagnostic: `ignored unknown tool call id=${event.toolCallId}`,
          }
        }

        // Duplicate normalized terminal: first-wins for BOTH store and overlay.
        // Check canonical existing + pending before latching overlay.
        const existing = findToolResult(list, event.toolCallId)
        const meta = registry.runMetaBySession.get(sessionId)
        if (existing || meta?.pendingToolResults.has(normCallId)) {
          return NO_CHANGE
        }

        // First terminal latches overlay; later terminals (raw/suffix alias) ignored.
        const endStatus = classifyToolEndStatus(
          event.result,
          Boolean(event.isError ?? event.result?.isError),
        )
        const endImages =
          extractOverlayImages(event.result?.content) ??
          extractOverlayImages(event.entry?.content) ??
          []
        touchOverlaySession(sessionId)
        latchTerminalOverlay(overlayStore, sessionId, runId, event.toolCallId, {
          status: endStatus,
          // Missing/undefined partial → explicit clear; final text would set.
          partialOutput: undefined,
          // Missing details → explicit clear (not merge-keep).
          details: event.result?.details,
          resultImages: endImages,
        })

        let entry: ToolResultEntry
        if (event.entry) {
          // Preserve provided entry identity/content; still force session scope.
          entry = {
            ...deepClone(event.entry),
            sessionId,
          }
        } else {
          entry = buildToolResultEntry(
            sessionId,
            event.toolCallId,
            event.toolName,
            canonicalToolContent(event.result?.content),
            Boolean(event.isError ?? event.result?.isError),
          )
        }

        const owner = findOwningAssistant(list, entry.toolCallId)
        if (owner && owner.status === 'streaming') {
          // Assistant not yet stable: buffer until assistant-end / agent-end.
          meta?.pendingToolResults.set(normCallId, entry)
          return NO_CHANGE
        }

        const next = insertToolResultOrdered(list, entry)
        actions.replaceSessionEntries(sessionId, next)
        markOwned(sessionId, entry.id)
        return { changed: true, urgency: 'immediate' }
      }

      case 'compaction-end': {
        if (!canAcceptRunEvent(sessionId, runId)) return NO_CHANGE
        setCompacting(sessionId, false)
        if (!event.entry) return NO_CHANGE
        if (entrySessionMismatch(event.entry, sessionId)) {
          return {
            changed: false,
            urgency: 'none',
            diagnostic: 'compaction-end entry sessionId mismatch',
          }
        }
        const existing = actions
          .getEntries(sessionId)
          .find(
            (entry) =>
              entry.kind === 'compaction' && entry.id === event.entry!.id,
          )
        if (existing) return NO_CHANGE
        const entry = deepClone(event.entry) as CompactionEntry
        actions.appendEntry(entry)
        markOwned(sessionId, entry.id)
        return { changed: true, urgency: 'immediate' }
      }

      default: {
        // Exhaustive guard for future event kinds.
        return NO_CHANGE
      }
    }
  }

  const reset = (): void => {
    registry.activeRunBySession.clear()
    registry.terminalPendingBySession.clear()
    registry.endedRuns.clear()
    registry.runMetaBySession.clear()
    // Dispose only this adapter's overlay data — never wipe another runtime's instance.
    if (injectedOverlay) {
      overlayStore.getState().clearAll()
    } else {
      overlayStore
        .getState()
        .clearSessions([...ownedOverlaySessions])
      // Shared default: also clearAll when this is the only consumer path in tests.
      // Owned-session clear is the production-safe path; clearAll keeps prior
      // single-adapter dispose semantics when no sessions were tracked yet.
      if (ownedOverlaySessions.size === 0) {
        overlayStore.getState().clearAll()
      }
    }
    ownedOverlaySessions.clear()
    compactionStore.getState().clearSessions([...ownedCompactionSessions])
    ownedCompactionSessions.clear()
  }

  return {
    apply,
    getActiveRunId: (sessionId: string) =>
      registry.activeRunBySession.get(sessionId) ?? null,
    getOverlayStore: () => overlayStore,
    reset,
    dispose: reset,
  }
}

/** Test helper: drop shared registry for a store key. */
export function __resetAgentEventAdapterRegistryForTests(
  store: ConversationStoreLike | ConversationStoreActions,
): void {
  const key = registryKeyFor(store)
  const reg = registries.get(key)
  if (reg) {
    reg.activeRunBySession.clear()
    reg.terminalPendingBySession.clear()
    reg.endedRuns.clear()
    reg.runMetaBySession.clear()
  }
  overlayByStore.delete(key)
  useToolOverlayStore.getState().clearAll()
}
