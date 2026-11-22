import { create } from 'zustand'
import { AUTO_CLEAR_DELAY_MS, tryApplyTodoUpdate, validateTodoList, validateTodoSnapshot } from './todoPatch.js'
import type { TodoItem, TodoListState } from './types.js'

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
    maxRevision: number
    callIndices: Map<string, number>
    results: Map<string, { entry: Record<string, unknown>; index: number }>
}

const todosEntriesCache = new WeakMap<readonly Record<string, unknown>[], TodoHistory>()

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
    settled: boolean, createdAt?: unknown, observeRevision?: (revision: number) => void,
): TodoMutation[] {
    if (!Array.isArray(metadata?.nestedTools)) return []
    const events: TodoMutation[] = []
    for (const record of metadata.nestedTools) {
        const raw = asRecord(record)
        if (!raw || !TODO_TOOL_NAMES.has(String(raw.name ?? raw.toolName))) continue
        if (INCOMPLETE_NESTED_STATUSES.has(String(raw.status))) continue
        const primary = asRecord(raw.displayMetadata)
        const position = mutationPosition(entryIndex, callEntryIndex, settled, { ...asRecord(raw.details), ...primary }, raw.createdAt ?? createdAt)
        if (position.revision !== undefined) observeRevision?.(position.revision)
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
    entries: readonly Record<string, unknown>[] | undefined | null,
    activeToolCallId?: string,
): TodoHistory {
    const history: TodoHistory = { events: [], maxRevision: 0, callIndices: new Map(), results: new Map() }
    if (!Array.isArray(entries) || entries.length === 0) return history
    const cached = activeToolCallId ? undefined : todosEntriesCache.get(entries)
    if (cached) return cached

    const activeId = normalizeToolCallId(activeToolCallId)
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
    const observeRevision = (revision: number) => { history.maxRevision = Math.max(history.maxRevision, revision) }
    for (const [index, entry] of entries.entries()) {
        if (!entry || entry.status === 'streaming') continue
        const calls = toolCalls(entry)
        // The running assistant can already be persisted before its tools execute.
        const activeBatch = activeId && calls.some((block) => normalizeToolCallId(block.id) === activeId)
        for (const block of calls) {
            const id = normalizeToolCallId(block.id)
            if (!TODO_TOOL_NAMES.has(String(block.name ?? block.toolName))) continue
            const result = history.results.get(id)
            if (result?.entry.isError === true || (activeBatch && !result)) continue
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
            if (position.revision !== undefined) observeRevision(position.revision)
            if (!consumedResults.has(id)) {
                const event = mutationFromResult(undefined, metadata, undefined, position)
                if (event) orphanCandidates.push({ id, event })
            }
        }
        for (const event of nestedMutations(metadata, index, callEntryIndex, true, entry.createdAt, observeRevision)) events.push(event)
    }

    for (const { id, event } of orphanCandidates) {
        if (!consumedResults.has(id)) events.push(event)
    }
    for (const event of events) observeRevision(event.revision ?? 0)
    events.sort((a, b) => a.entryIndex - b.entryIndex)
    history.epoch = findResetEpoch(events)
    history.events = events.slice(history.epoch?.eventIndex ?? 0)
    if (!activeToolCallId) todosEntriesCache.set(entries, history)
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
    let maxRevision = history.maxRevision
    for (const event of events) {
        if (event.revision === undefined) continue
        maxRevision = Math.max(maxRevision, event.revision)
        const previous = byRevision.get(event.revision)
        if (!previous || (event.kind === 'snapshot' && previous.kind === 'update') ||
            (event.kind === previous.kind && (event.settled || !previous.settled))) {
            byRevision.set(event.revision, event)
        }
    }
    const ordered = events.filter((event) => event.revision === undefined || byRevision.get(event.revision) === event)
    orderByRevision(ordered)
    const state = replayMutations(ordered)
    const liveEvents = new Set(live)
    return { state, maxRevision, hasLive: ordered.some((event) => liveEvents.has(event)) }
}

export function resolveActiveTodos(
    entries: readonly Record<string, unknown>[] | undefined | null,
    overlays?: Readonly<Record<string, unknown>> | null,
    activeToolCallId?: string,
): { state: TodoReplayState | null; maxRevision: number } {
    return replayHistory(extractTodoHistory(entries, activeToolCallId), overlays)
}

export function extractTodosFromEntries(entries: readonly Record<string, unknown>[] | undefined | null): TodoItem[] | null {
    return resolveActiveTodos(entries).state?.todos ?? null
}

export function extractTodosFromLiveOverlays(
    entries: readonly Record<string, unknown>[] | undefined | null,
    overlays: Readonly<Record<string, unknown>> | undefined | null,
): TodoItem[] | null {
    const { state, hasLive } = replayHistory(extractTodoHistory(entries), overlays)
    return hasLive ? state?.todos ?? null : null
}

export function hasPendingDirectTodoWrites(entries: readonly Record<string, unknown>[]): boolean {
    const { results } = extractTodoHistory(entries)
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        if (entry?.kind !== 'assistant') continue
        if (entry.stopReason !== 'toolUse') return false
        return toolCalls(entry).some((call) =>
            TODO_TOOL_NAMES.has(String(call.name ?? call.toolName)) &&
            !results.has(normalizeToolCallId(call.id)) &&
            parseArguments(call.arguments ?? call.args)?.operation === 'write')
    }
    return false
}

export const useTodoListStore = create<Required<TodoListState>>((set, get) => ({
    todosBySession: {},
    hydratedSessions: {},
    revisionsBySession: {},

    observeRevision: (sessionId, revision) => {
        if (!sessionId || !Number.isSafeInteger(revision) || revision <= 0) return
        set((state) => {
            const previous = state.revisionsBySession[sessionId]
            return typeof previous === 'number' && revision <= previous
                ? state
                : { revisionsBySession: { ...state.revisionsBySession, [sessionId]: revision } }
        })
    },

    setTodos: (sessionId: string, todos: TodoItem[]) => {
        if (!sessionId) return
        const defensiveCopy = todos.map((item) => ({ ...item }))
        set((state) => ({
            todosBySession: { ...state.todosBySession, [sessionId]: defensiveCopy },
            hydratedSessions: { ...state.hydratedSessions, [sessionId]: true },
        }))
    },

    getTodos: (sessionId: string) => {
        if (!sessionId) return []
        const list = get().todosBySession[sessionId]
        return Array.isArray(list) ? list.map((item) => ({ ...item })) : []
    },

    clearTodos: (sessionId: string) => {
        if (!sessionId) return
        set((state) => {
            if (!Object.prototype.hasOwnProperty.call(state.todosBySession, sessionId) && state.hydratedSessions[sessionId] === true) return state
            const next = { ...state.todosBySession }
            delete next[sessionId]
            return { todosBySession: next, hydratedSessions: { ...state.hydratedSessions, [sessionId]: true } }
        })
    },

    hasSessionState: (sessionId: string) => {
        const { hydratedSessions, todosBySession } = get()
        return hydratedSessions[sessionId] === true || Object.prototype.hasOwnProperty.call(todosBySession, sessionId)
    },

    markSessionHydrated: (sessionId: string) => {
        if (!sessionId) return
        set((state) => state.hydratedSessions[sessionId] === true
            ? state
            : { hydratedSessions: { ...state.hydratedSessions, [sessionId]: true } })
    },

    clearAll: () => {
        set({ todosBySession: {}, hydratedSessions: {}, revisionsBySession: {} })
    },
}))

export function __resetTodoListStoreForTests(): void {
    useTodoListStore.getState().clearAll()
}
