import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileEdit, Folder, GitBranch, GitFork, Monitor, Puzzle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { collectInvokedSkills } from '@/components/chat/skillPresentation'
import { useAgentStream } from '@/features/agent/useAgentStream'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { readGitRepoWithDefaultFs } from '@/lib/gitBranches'
import { getProjectPaths } from '@/lib/projectPaths'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import {
  useFileChangeStore,
  syncFileChangesFromEntries,
  EMPTY_SESSION_CHANGES,
} from '@/stores/fileChangeStore'
import { useToolOverlayStore } from '@/stores/toolOverlayStore'
import { useUiStore } from '@/stores/uiStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { usePanelTabs } from '@/plugins/registry/usePanelTabs'
import { ExtensionSlot } from '@/plugins/registry/ExtensionSlot'

export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
  id: number
  title: string
  description: string
  status: TodoStatus
}

// Keep todo replay aligned with the plugin without importing its implementation.
function isValidTodoStatus(value: unknown): value is TodoStatus {
  return value === 'not-started' || value === 'in-progress' || value === 'completed'
}

function validateTodoList(rawList: readonly unknown[]): TodoItem[] {
  const todos: TodoItem[] = []
  for (let index = 0; index < rawList.length; index++) {
    const item = rawList[index]
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const id = typeof raw.id === 'number' ? raw.id : index + 1
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Task ${id}`
    const description = typeof raw.description === 'string' ? raw.description : ''
    const status = String(raw.status ?? '').toLowerCase()
    todos.push({ id, title, description, status: isValidTodoStatus(status) ? status : 'not-started' })
  }
  return todos
}

function isPositiveTodoId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isNonEmptyTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateTodoSnapshot(raw: unknown): TodoItem[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).todoSnapshot
      : null
  if (!Array.isArray(list)) return null

  const todos: TodoItem[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const { id, title, description, status } = item as Record<string, unknown>
    if (!isPositiveTodoId(id) || !isNonEmptyTitle(title) || typeof description !== 'string' || !isValidTodoStatus(status)) {
      return null
    }
    todos.push({ id, title, description, status })
  }
  return todos
}

function todoFields(raw: Record<string, unknown>): Partial<Omit<TodoItem, 'id'>> | null {
  const { status, title, description } = raw
  const fields: Partial<Omit<TodoItem, 'id'>> = {}
  if (status !== undefined) {
    if (!isValidTodoStatus(status)) return null
    fields.status = status
  }
  if (title !== undefined) {
    if (!isNonEmptyTitle(title)) return null
    fields.title = title.trim()
  }
  if (description !== undefined) {
    if (typeof description !== 'string') return null
    fields.description = description
  }
  return fields
}

function tryApplyTodoUpdate(current: readonly TodoItem[], args: Record<string, unknown>): TodoItem[] | null {
  const { updates = [], add = [], removeIds = [] } = args
  if (!Array.isArray(updates) || !Array.isArray(add) || !Array.isArray(removeIds)) return null
  if (!updates.length && !add.length && !removeIds.length) return null

  const occurrences = new Map<number, number>()
  for (const { id } of current) occurrences.set(id, (occurrences.get(id) ?? 0) + 1)
  const currentIds = new Set(occurrences.keys())
  const patches = new Map<number, Partial<Omit<TodoItem, 'id'>>>()
  for (const item of updates) {
    if (!isPlainObject(item) || !isPositiveTodoId(item.id)) return null
    const { id } = item
    if (occurrences.get(id) !== 1 || patches.has(id)) return null
    const fields = todoFields(item)
    if (!fields || Object.keys(fields).length === 0) return null
    patches.set(id, fields)
  }

  const removed = new Set<number>()
  for (const id of removeIds) {
    if (!isPositiveTodoId(id) || occurrences.get(id) !== 1 || removed.has(id) || patches.has(id)) return null
    removed.add(id)
  }

  let maxId = 0
  for (const id of currentIds) {
    if (id > maxId) maxId = id
  }
  const occupiedIds = new Set([...currentIds].filter((id) => !removed.has(id)))
  const added: TodoItem[] = []
  for (const item of add) {
    if (!isPlainObject(item)) return null
    const fields = todoFields(item)
    if (!fields?.title) return null
    const id = item.id === undefined ? maxId + 1 : item.id
    if (!isPositiveTodoId(id) || occupiedIds.has(id) || (item.id === undefined && id <= maxId)) return null
    added.push({ id, title: fields.title, description: fields.description ?? '', status: fields.status ?? 'not-started' })
    occupiedIds.add(id)
    maxId = Math.max(maxId, id)
  }

  return current
    .filter(({ id }) => !removed.has(id))
    .map((item) => ({ ...item, ...patches.get(item.id) }))
    .concat(added)
}

const AUTO_CLEAR_DELAY_MS = 4000
const TODO_TOOL_NAMES = new Set(['todo', 'manage_todo_list'])
const INCOMPLETE_NESTED_STATUSES = new Set(['error', 'rejected', 'aborted', 'running', 'awaiting_approval'])

interface MutationPosition {
  entryIndex: number
  callEntryIndex?: number
  settled: boolean
  revision?: number
  completedAt?: number
  committedAt?: number
  createdAt?: number
  resetBase?: boolean
  isWrite?: boolean
}

interface TodoReplayState extends MutationPosition {
  todos: TodoItem[]
}

type TodoMutation = MutationPosition & (
  | { kind: 'snapshot'; todos: TodoItem[] }
  | { kind: 'update'; args: Record<string, unknown> }
)

interface ResetEpoch {
  eventIndex: number
  callEntryIndex: number
  revision?: number
  rolledBack: boolean
}

interface TodoHistory {
  events: TodoMutation[]
  epoch?: ResetEpoch
  callIndices: Map<string, number>
  results: Map<string, { entry: Record<string, unknown>; index: number }>
}

const todosEntriesCache = new WeakMap<readonly ConversationEntry[], TodoHistory>()

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseArguments(rawArgs: unknown): Record<string, unknown> | null {
  if (typeof rawArgs === 'string') {
    try {
      rawArgs = JSON.parse(rawArgs)
    } catch {
      return null
    }
  }
  return asRecord(rawArgs)
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function mutationPosition(
  entryIndex: number, callEntryIndex: number | undefined, settled: boolean, metadata: unknown, createdAt?: unknown,
): MutationPosition {
  const fields = asRecord(metadata)
  const revision = fields?.todoRevision
  return {
    entryIndex, callEntryIndex, settled,
    revision: typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : undefined,
    completedAt: timestamp(fields?.completedAt) ?? timestamp(createdAt),
    committedAt: timestamp(fields?.committedAt),
    createdAt: timestamp(createdAt),
    resetBase: fields?.resetBase === true,
    isWrite: fields?.isWrite === true,
  }
}

function mutationFromResult(
  rawArgs: unknown, metadata: Record<string, unknown> | null, details: unknown, position: MutationPosition,
): TodoMutation | null {
  const args = parseArguments(rawArgs)
  if (args?.operation === 'read') return null
  const legacyMetadata = asRecord(details)
  const snapshot = validateTodoSnapshot(metadata?.todoSnapshot)
  if (snapshot !== null) return { ...position, kind: 'snapshot', todos: snapshot, isWrite: position.isWrite || args?.operation === 'write' }
  const patch = parseArguments(metadata?.todoPatch ?? legacyMetadata?.todoPatch)
  if (patch?.operation === 'update') return { ...position, kind: 'update', args: patch }
  const legacySnapshot = validateTodoSnapshot(details)
  if (legacySnapshot !== null) return { ...position, kind: 'snapshot', todos: legacySnapshot, isWrite: position.isWrite || args?.operation === 'write' }
  if (args?.operation === 'write' && Array.isArray(args.todoList)) {
    return { ...position, kind: 'snapshot', todos: validateTodoList(args.todoList), isWrite: true }
  }
  return args?.operation === 'update' ? { ...position, kind: 'update', args } : null
}

function nestedMutations(
  metadata: Record<string, unknown> | null, entryIndex: number, callEntryIndex: number | undefined,
  settled: boolean, createdAt?: unknown,
): TodoMutation[] {
  if (!Array.isArray(metadata?.nestedTools)) return []
  const events: TodoMutation[] = []
  for (const record of metadata.nestedTools) {
    const raw = asRecord(record)
    if (!raw || !TODO_TOOL_NAMES.has(String(raw.name ?? raw.toolName))) continue
    if (INCOMPLETE_NESTED_STATUSES.has(String(raw.status))) continue
    const primary = asRecord(raw.displayMetadata)
    const position = mutationPosition(entryIndex, callEntryIndex, settled, { ...asRecord(raw.details), ...primary }, raw.createdAt ?? createdAt)
    const event = mutationFromResult(raw.args ?? raw.arguments, primary, raw.details, position)
    if (event) events.push(event)
  }
  return events
}

function findResetEpoch(events: readonly TodoMutation[]): ResetEpoch | undefined {
  // An earlier call whose result appears later was still in flight at the write.
  const earliestLaterCall: number[] = []
  let earliest = Infinity
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    earliestLaterCall[index] = earliest
    if (event?.settled && event.callEntryIndex !== undefined) earliest = Math.min(earliest, event.callEntryIndex)
  }

  let epoch: ResetEpoch | undefined
  let priorResultIndex = -1
  let priorRevision = 0
  for (const [index, event] of events.entries()) {
    if (!event.settled) continue
    const { callEntryIndex, revision } = event
    if (event.kind === 'snapshot' && event.isWrite && callEntryIndex !== undefined &&
      callEntryIndex > priorResultIndex && callEntryIndex <= (earliestLaterCall[index] ?? Infinity)) {
      epoch = { eventIndex: index, callEntryIndex, revision, rolledBack: revision !== undefined && revision < priorRevision }
    }
    priorResultIndex = event.entryIndex
    priorRevision = Math.max(priorRevision, revision ?? 0)
  }
  return epoch
}

function orderByRevision(events: TodoMutation[]): void {
  // Result order can differ from commit order; legacy mutations keep their chronological slots.
  const versioned = events.filter((event) => event.revision !== undefined)
  versioned.sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0))
  let index = 0
  for (let slot = 0; slot < events.length; slot++) {
    const event = versioned[index]
    if (events[slot]?.revision !== undefined && event) {
      events[slot] = event
      index++
    }
  }
}

function replayMutations(events: readonly TodoMutation[]): TodoReplayState | null {
  let index = events.length - 1
  for (; index >= 0; index--) {
    if (events[index]?.kind === 'snapshot') break
  }
  const anchor = events[index]
  let state: TodoReplayState | null = anchor?.kind === 'snapshot'
    ? { ...anchor, todos: anchor.todos.map((item) => ({ ...item })) }
    : null
  for (index++; index < events.length; index++) {
    const event = events[index]
    if (event?.kind !== 'update') continue
    const eventAt = event.committedAt ?? event.createdAt
    const expired = state?.completedAt !== undefined && eventAt !== undefined &&
      eventAt - state.completedAt >= AUTO_CLEAR_DELAY_MS &&
      state.todos.length > 0 && state.todos.every(({ status }) => status === 'completed')
    const baseline = event.resetBase || expired ? [] : state?.todos ?? []
    const todos = tryApplyTodoUpdate(baseline, event.args)
    if (todos !== null) state = { ...event, todos }
  }
  return state
}

function normalizeToolCallId(id: unknown): string {
  return String(id ?? '').split('|', 1)[0] ?? ''
}

function toolCalls(entry: Record<string, unknown>): Record<string, unknown>[] {
  const content = entry.content ?? entry.parts
  if (!Array.isArray(content)) return []
  return content.map(asRecord).filter((block): block is Record<string, unknown> =>
    block?.type === 'toolCall' || block?.type === 'tool_call')
}

function extractTodoHistory(
  entries: readonly ConversationEntry[],
): TodoHistory {
  const history: TodoHistory = { events: [], callIndices: new Map(), results: new Map() }
  if (!Array.isArray(entries) || entries.length === 0) return history
  const cached = todosEntriesCache.get(entries)
  if (cached) return cached

  for (const [index, entry] of entries.entries()) {
    if (!entry || entry.status === 'streaming') continue
    for (const call of toolCalls(entry)) {
      const callId = normalizeToolCallId(call.id)
      if (callId) history.callIndices.set(callId, index)
    }
    if (entry.kind !== 'toolResult') continue
    const id = normalizeToolCallId(entry.toolCallId)
    if (id && history.results.get(id)?.entry.isError !== true) history.results.set(id, { entry, index })
  }

  const events: TodoMutation[] = []
  const consumedResults = new Set<string>()
  const orphanCandidates: { id: string; event: TodoMutation }[] = []
  for (const [index, entry] of entries.entries()) {
    if (!entry || entry.status === 'streaming') continue
    const calls = toolCalls(entry)
    for (const block of calls) {
      const id = normalizeToolCallId(block.id)
      if (!TODO_TOOL_NAMES.has(String(block.name ?? block.toolName))) continue
      const result = history.results.get(id)
      if (result?.entry.isError === true) continue
      const metadata = asRecord(result?.entry.displayMetadata)
      const position = mutationPosition(result?.index ?? index, index, !!result, metadata, result?.entry.createdAt)
      const event = mutationFromResult(block.arguments ?? block.args, metadata, undefined, position)
      if (!event || (event.kind === 'update' && !result)) continue
      events.push(event)
      if (result) consumedResults.add(id)
    }

    if (entry.kind !== 'toolResult') continue
    const metadata = asRecord(entry.displayMetadata)
    const id = normalizeToolCallId(entry.toolCallId)
    const callEntryIndex = history.callIndices.get(id)
    if (entry.isError !== true && history.results.get(id)?.entry.isError !== true &&
      TODO_TOOL_NAMES.has(String(entry.toolName ?? entry.name))) {
      const position = mutationPosition(index, callEntryIndex, true, metadata, entry.createdAt)
      if (!consumedResults.has(id)) {
        const event = mutationFromResult(undefined, metadata, undefined, position)
        if (event) orphanCandidates.push({ id, event })
      }
    }
    for (const event of nestedMutations(metadata, index, callEntryIndex, true, entry.createdAt)) events.push(event)
  }

  for (const { id, event } of orphanCandidates) {
    if (!consumedResults.has(id)) events.push(event)
  }
  events.sort((a, b) => a.entryIndex - b.entryIndex)
  history.epoch = findResetEpoch(events)
  history.events = events.slice(history.epoch?.eventIndex ?? 0)
  todosEntriesCache.set(entries, history)
  return history
}

function inActiveEpoch(event: TodoMutation, history: TodoHistory): boolean {
  const { epoch } = history
  const { callEntryIndex, revision } = event
  if (epoch && (callEntryIndex === undefined || callEntryIndex < epoch.callEntryIndex)) {
    if (revision !== undefined && epoch.revision !== undefined) {
      if (epoch.rolledBack || revision <= epoch.revision) return false
    } else if (callEntryIndex !== undefined) {
      return false
    }
  }
  const last = history.events[history.events.length - 1]
  // Legacy events without comparable revisions can only be ordered by their transcript positions.
  return !last || callEntryIndex === undefined || callEntryIndex >= last.entryIndex ||
    (revision !== undefined && last.revision !== undefined)
}

function collectLiveMutations(
  history: TodoHistory, overlays: Readonly<Record<string, unknown>> | undefined | null,
): TodoMutation[] {
  if (!overlays) return []
  const candidates: { at: number; events: TodoMutation[] }[] = []
  for (const overlay of Object.values(overlays)) {
    const raw = asRecord(overlay)
    if (!raw) continue
    const id = normalizeToolCallId(raw.toolCallId)
    if (!id || history.results.has(id)) continue
    const callEntryIndex = history.callIndices.get(id)
    const events = nestedMutations(asRecord(raw.details), callEntryIndex ?? -1, callEntryIndex, false, raw.createdAt)
      .filter((event) => inActiveEpoch(event, history))
    if (events.length) candidates.push({ at: Number(raw.updatedAt) || 0, events })
  }
  candidates.sort((a, b) => a.at - b.at)
  return candidates.flatMap(({ events }) => events)
}

function replayHistory(history: TodoHistory, overlays?: Readonly<Record<string, unknown>> | null) {
  const live = collectLiveMutations(history, overlays)
  const events = history.events.concat(live)
  const byRevision = new Map<number, TodoMutation>()
  for (const event of events) {
    if (event.revision === undefined) continue
    const previous = byRevision.get(event.revision)
    if (!previous || (event.kind === 'snapshot' && previous.kind === 'update') ||
      (event.kind === previous.kind && (event.settled || !previous.settled))) {
      byRevision.set(event.revision, event)
    }
  }
  const ordered = events.filter((event) => event.revision === undefined || byRevision.get(event.revision) === event)
  orderByRevision(ordered)
  return replayMutations(ordered)
}

function resolveActiveTodos(entries: readonly ConversationEntry[], overlays: Readonly<Record<string, unknown>>): TodoItem[] | null {
  return replayHistory(extractTodoHistory(entries), overlays)?.todos ?? null
}

const EMPTY_ENTRIES: ConversationEntry[] = []
const EMPTY_TODOS: TodoItem[] = []
const EMPTY_OVERLAYS: Readonly<Record<string, unknown>> = Object.freeze({})

function rectsOverlap(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function isPinnedSummaryToggle(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest('[data-testid="pinned-summary-toggle"]'))
  )
}

export function PinnedSummary({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation()
  const sessions = useSessionStore((state) => state.sessions)
  const projects = useProjectStore((state) => state.projects)
  const pending = useUiStore((state) => state.pendingSessionContext)
  const setRightSidebarCollapsed = useUiStore(
    (state) => state.setRightSidebarCollapsed,
  )
  const openRightPanelTab = useUiStore((state) => state.openRightPanelTab)
  const panelTabs = usePanelTabs()
  const setPinnedSummaryVisible = useUiStore(
    (state) => state.setPinnedSummaryVisible,
  )
  const rootRef = useRef<HTMLElement>(null)
  const { skills } = useAgentStream()
  const entries = useMessageStore((state) =>
    sessionId
      ? (state.entriesBySession[sessionId] ?? EMPTY_ENTRIES)
      : EMPTY_ENTRIES,
  )
  const overlays = useToolOverlayStore((state) =>
    sessionId ? (state.bySession[sessionId] ?? EMPTY_OVERLAYS) : EMPTY_OVERLAYS,
  )
  const invokedSkills = useMemo(
    () => collectInvokedSkills(entries, skills),
    [entries, skills],
  )

  const session = useMemo(
    () => sessions.find((item) => item.id === sessionId) ?? null,
    [sessions, sessionId],
  )
  const worktreeSetup = useWorktreeSetupStore((state) =>
    sessionId ? state.setups[sessionId] : undefined,
  )
  const isWorktree = session
    ? session.workLocation === 'worktree' ||
      Boolean(session.worktreePath) ||
      Boolean(worktreeSetup)
    : pending.workLocation === 'worktree'
  const worktreePath =
    session?.worktreePath ||
    session?.worktreeSetup?.worktreePath ||
    worktreeSetup?.worktreePath
  const worktreeBranch =
    session?.branch ||
    session?.worktreeSetup?.branch ||
    worktreeSetup?.branch ||
    pending.branch

  const projectId = session?.projectId ?? pending.projectId
  const branch = session?.branch ?? pending.branch
  const project = useMemo(
    () => projects.find((item) => item.id === projectId) ?? null,
    [projects, projectId],
  )
  const projectPath = project ? (getProjectPaths(project)[0] ?? '') : ''

  const [projectRepoBranch, setProjectRepoBranch] = useState<string | null>(null)
  const [envOpen, setEnvOpen] = useState(true)
  const [todosOpen, setTodosOpen] = useState(true)
  const [sourcesOpen, setSourcesOpen] = useState(true)

  useEffect(() => {
    if (!projectPath) {
      setProjectRepoBranch(null)
      return
    }
    let cancelled = false
    void readGitRepoWithDefaultFs([projectPath])
      .then((info) => {
        if (!cancelled) {
          setProjectRepoBranch(info?.current ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectRepoBranch(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const originBranch =
    session?.baseBranch ||
    session?.worktreeSetup?.baseBranch ||
    worktreeSetup?.baseBranch ||
    projectRepoBranch ||
    t('pinnedSummary.noBranch')

  const workingBranch = branch || projectRepoBranch || t('pinnedSummary.noBranch')

  const fileChanges = useFileChangeStore((state) =>
    sessionId
      ? (state.changesBySession[sessionId] ?? EMPTY_SESSION_CHANGES)
      : EMPTY_SESSION_CHANGES,
  )
  const todos = useMemo(
    () => resolveActiveTodos(entries, overlays) ?? EMPTY_TODOS,
    [entries, overlays],
  )
  const currentStep = useMemo(() => {
    const totalCount = todos.length
    if (totalCount === 0) return 0
    const completedCount = todos.filter((item) => item.status === 'completed').length
    const inProgressIndex = todos.findIndex((item) => item.status === 'in-progress')

    if (inProgressIndex !== -1) {
      return inProgressIndex + 1
    }
    if (completedCount === totalCount) {
      return totalCount
    }
    return Math.min(completedCount + 1, totalCount)
  }, [todos])

  useEffect(() => {
    if (!sessionId) return
    const currentChanges = useFileChangeStore.getState().changesBySession[sessionId]
    if (!currentChanges) {
      const currentEntries = useMessageStore.getState().getEntries(sessionId)
      if (currentEntries && currentEntries.length > 0) {
        syncFileChangesFromEntries(sessionId, currentEntries)
      }
    }
  }, [sessionId])

  // When the floating card covers the transcript, treat it as a popover:
  // any later click dismisses it and restores the toggle pressed style.
  // The toggle owns open/close so its own click must not dismiss the card.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    const onClick = (event: MouseEvent) => {
      if (isPinnedSummaryToggle(event.target)) return
      const messageList = document.querySelector(
        '[data-testid="message-list-content"]',
      )
      if (!(messageList instanceof HTMLElement)) return
      if (
        !rectsOverlap(
          root.getBoundingClientRect(),
          messageList.getBoundingClientRect(),
        )
      ) {
        return
      }
      setPinnedSummaryVisible(false)
    }

    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [setPinnedSummaryVisible])

  return (
    <aside
      ref={rootRef}
      data-testid="pinned-summary"
      className={cn(
        'pointer-events-auto w-[280px] overflow-hidden rounded-2xl',
        'border border-[var(--border-subtle)] bg-[var(--bg-elevated)]',
        'shadow-[0_12px_40px_rgba(0,0,0,0.35)]',
      )}
    >
      <section className="px-3 pt-2.5 pb-2">
        <h2 className="mb-1">
          <button
            type="button"
            onClick={() => setEnvOpen((open) => !open)}
            aria-expanded={envOpen}
            aria-controls="pinned-summary-env-content"
            className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
          >
            <span>{t('pinnedSummary.environment')}</span>
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                !envOpen && '-rotate-90',
              )}
              aria-hidden
            />
          </button>
        </h2>
        {envOpen ? (
          <div id="pinned-summary-env-content">
            <SummaryRow
              icon={FileEdit}
              label={t('pinnedSummary.changes', 'Changes')}
              data-testid="pinned-summary-changes-row"
              onClick={() => {
                const changesTabId = panelTabs.find((p) => p.id.includes('review') || p.id.includes('changes') || p.id.includes('diff'))?.id ?? 'review'
                openRightPanelTab(changesTabId, { activate: true })
                setRightSidebarCollapsed(false)
              }}
              detail={
                fileChanges.totalAdditions > 0 || fileChanges.totalDeletions > 0 ? (
                  <span
                    data-testid="pinned-summary-changes-stats"
                    className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold"
                  >
                    {fileChanges.totalAdditions > 0 ? (
                      <span className="text-[var(--accent-green)]">
                        +{fileChanges.totalAdditions}
                      </span>
                    ) : null}
                    {fileChanges.totalDeletions > 0 ? (
                      <span className="text-[#f87171]">
                        -{fileChanges.totalDeletions}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span
                    data-testid="pinned-summary-changes-stats"
                    className="font-mono text-[11.5px] text-[var(--text-muted)] font-normal"
                  >
                    +0 -0
                  </span>
                )
              }
            />
            <SummaryRow
              icon={Monitor}
              label={
                isWorktree
                  ? t('pinnedSummary.worktree', 'Worktree')
                  : t('pinnedSummary.local')
              }
              detail={project?.name ?? t('pinnedSummary.noProject')}
            />
            {projectPath ? <SummaryRow icon={Folder} label={projectPath} /> : null}
            <SummaryRow
              icon={GitBranch}
              label={isWorktree ? originBranch : workingBranch}
            />
            {isWorktree ? (
              <SummaryRow
                icon={GitFork}
                label={worktreeBranch || t('pinnedSummary.noBranch')}
                title={worktreePath || undefined}
              />
            ) : null}
          </div>
        ) : null}
      </section>

      <ExtensionSlot
        name="pinned.summary.subagents"
        props={{ sessionId }}
      />

      {todos.length > 0 && sessionId ? (
        <section
          data-testid="pinned-summary-todos"
          className="border-t border-[var(--border-subtle)] px-3 pt-2 pb-2.5"
        >
          <div className="mb-1">
            <h2>
              <button
                type="button"
                onClick={() => setTodosOpen((open) => !open)}
                aria-expanded={todosOpen}
                aria-controls="pinned-summary-todos-content"
                className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
              >
                <span>{t('pinnedSummary.todos')}</span>
                <div className="flex items-center gap-1.5">
                  <span
                    data-testid="pinned-summary-todo-progress"
                    className="text-[11px] text-[var(--text-muted)] font-normal"
                  >
                    {currentStep}/{todos.length}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                      !todosOpen && '-rotate-90',
                    )}
                    aria-hidden
                  />
                </div>
              </button>
            </h2>
          </div>
          {todosOpen ? (
            <ul id="pinned-summary-todos-content" className="flex flex-col gap-1">
              {todos.map((todo) => (
                <li
                  key={todo.id}
                  data-testid={`pinned-summary-todo-${todo.id}`}
                  className="flex items-center gap-2 rounded-lg px-1 py-0.5 text-[13px]"
                >
                  <TodoStatusIcon status={todo.status} />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      todo.status === 'completed' &&
                        'text-[var(--text-muted)]',
                      todo.status === 'in-progress' &&
                        'font-medium text-[var(--text-primary)]',
                      todo.status === 'not-started' &&
                        'text-[var(--text-secondary)]',
                    )}
                    title={
                      todo.description
                        ? `${todo.title} - ${todo.description}`
                        : todo.title
                    }
                  >
                    {todo.title}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {invokedSkills.length > 0 ? (
        <section className="border-t border-[var(--border-subtle)] px-3 pt-2 pb-2.5">
          <h2 className="mb-1">
            <button
              type="button"
              onClick={() => setSourcesOpen((open) => !open)}
              aria-expanded={sourcesOpen}
              aria-controls="pinned-summary-sources-content"
              className="flex w-full cursor-pointer items-center justify-between px-1 py-0.5 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] select-none rounded"
            >
              <span>{t('pinnedSummary.sources')}</span>
              <ChevronDown
                className={cn(
                  'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
                  !sourcesOpen && '-rotate-90',
                )}
                aria-hidden
              />
            </button>
          </h2>
          {sourcesOpen ? (
            <ul id="pinned-summary-sources-content" className="flex flex-col gap-0.5">
              {invokedSkills.map((skill) => (
                <li
                  key={skill.name}
                  className="flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-[var(--text-primary)]"
                >
                  <Puzzle
                    className="size-3.5 shrink-0 text-[var(--text-muted)]"
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  <span className="truncate">{skill.displayName}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </aside>
  )
}

function TodoStatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'completed') {
    return (
      <span
        data-testid="todo-status-completed"
        className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-500/60 bg-neutral-700/40 text-[9px] font-bold text-neutral-300 select-none"
      >
        ✓
      </span>
    )
  }
  if (status === 'in-progress') {
    return (
      <span
        data-testid="todo-status-in-progress"
        className="flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-neutral-200 bg-transparent select-none"
      />
    )
  }
  return (
    <span
      data-testid="todo-status-not-started"
      className="flex size-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-600 bg-transparent select-none"
    />
  )
}

function SummaryRow({
  icon: Icon,
  label,
  detail,
  title,
  onClick,
  'data-testid': testId,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>
  label: string
  detail?: React.ReactNode
  title?: string
  onClick?: () => void
  'data-testid'?: string
}) {
  const isClickable = Boolean(onClick)
  return (
    <div
      title={title}
      data-testid={testId}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        'flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] text-[var(--text-primary)]',
        isClickable &&
          'cursor-pointer transition-colors hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/40',
      )}
    >
      <Icon
        className="size-3.5 shrink-0 text-[var(--text-muted)]"
        strokeWidth={1.75}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail ? (
        <div className="max-w-[46%] truncate text-[12px] text-[var(--text-muted)]">
          {detail}
        </div>
      ) : null}
    </div>
  )
}
