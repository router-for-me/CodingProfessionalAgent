import { hasPendingDirectTodoWrites, resolveActiveTodos, useTodoListStore } from './todoStore.js'
import { AUTO_CLEAR_DELAY_MS } from './todoPatch.js'
import type { TodoItem } from './types.js'

export { AUTO_CLEAR_DELAY_MS }

const clearTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()
const localRevisions = new WeakMap<TodoItem[], number>()

function allCompleted(todos: readonly TodoItem[]): boolean {
    return todos.length > 0 && todos.every(({ status }) => status === 'completed')
}

export function getTodoCompletionGraceMs(todos: readonly TodoItem[], completedAt: number | undefined): number | undefined {
    if (!allCompleted(todos)) return undefined
    return completedAt !== undefined ? AUTO_CLEAR_DELAY_MS - (Date.now() - completedAt) : 0
}

export function prepareTodoCommit(
    sessionId: string, todos: readonly TodoItem[], revisionFloor = 0,
): { todoRevision: number; committedAt: number; completedAt?: number } {
    const committedAt = Date.now()
    const previous = useTodoListStore.getState().revisionsBySession[sessionId]
    const todoRevision = Math.max(committedAt, Math.max(typeof previous === 'number' ? previous : 0, revisionFloor) + 1)
    if (!Number.isSafeInteger(todoRevision)) throw new Error('Cannot allocate the next todo revision.')
    return { todoRevision, committedAt, ...(allCompleted(todos) ? { completedAt: committedAt } : {}) }
}

export function setSessionTodos(sessionId: string, todos: TodoItem[], metadata = prepareTodoCommit(sessionId, todos)) {
    if (sessionId) {
        useTodoListStore.getState().observeRevision(sessionId, metadata.todoRevision)
        applySessionTodos(sessionId, todos, metadata.completedAt !== undefined ? AUTO_CLEAR_DELAY_MS : 0)
        const stored = useTodoListStore.getState().todosBySession[sessionId]
        if (stored) localRevisions.set(stored, metadata.todoRevision)
    }
    return metadata
}

function cancelClearTimer(sessionId: string): void {
    const timer = clearTimerBySession.get(sessionId)
    if (timer !== undefined) {
        clearTimeout(timer)
        clearTimerBySession.delete(sessionId)
    }
}

function applySessionTodos(sessionId: string, todos: TodoItem[], remainingMs: number): void {
    cancelClearTimer(sessionId)
    useTodoListStore.getState().setTodos(sessionId, todos)
    if (remainingMs > 0) {
        const timer = setTimeout(() => {
            clearTimerBySession.delete(sessionId)
            useTodoListStore.getState().clearTodos(sessionId)
        }, remainingMs)
        clearTimerBySession.set(sessionId, timer)
    }
}

export function clearSessionTodos(sessionId: string): void {
    if (!sessionId) return
    cancelClearTimer(sessionId)
    useTodoListStore.getState().clearTodos(sessionId)
}

export function resetTodoOrchestration(): void {
    for (const timer of clearTimerBySession.values()) clearTimeout(timer)
    clearTimerBySession.clear()
    useTodoListStore.getState().clearAll()
}

export function restoreSessionTodos(sessionId: string, resolution: ReturnType<typeof resolveActiveTodos>): void {
    if (!sessionId) return
    const { state, maxRevision } = resolution
    const store = useTodoListStore.getState()
    store.observeRevision(sessionId, maxRevision)
    if (!state) {
        clearSessionTodos(sessionId)
        return
    }

    const { todos, completedAt } = state
    const current = store.todosBySession[sessionId]
    const unchanged = current?.length === todos.length && current.every((item, index) => {
        const next = todos[index]
        return item.id === next?.id && item.title === next.title &&
            item.description === next.description && item.status === next.status
    })
    const remainingMs = getTodoCompletionGraceMs(todos, completedAt)
    if (unchanged && (remainingMs === undefined || clearTimerBySession.has(sessionId))) return
    if (remainingMs !== undefined && remainingMs <= 0) {
        clearSessionTodos(sessionId)
        return
    }
    applySessionTodos(sessionId, todos, remainingMs ?? 0)
}

/** Synchronizes the store using the same settled/live ordering as the pinned summary. */
export function syncTodosFromEntries(
    sessionId: string,
    entries: readonly Record<string, unknown>[] | undefined | null,
    overlays?: Readonly<Record<string, unknown>> | null,
    isRunning = false,
): void {
    if (!sessionId) return
    const resolution = resolveActiveTodos(entries, overlays)
    const store = useTodoListStore.getState()
    const current = store.todosBySession[sessionId]
    if (isRunning) {
        store.observeRevision(sessionId, resolution.maxRevision)
        const localRevision = current && localRevisions.get(current)
        // Live events can lag the colocated agent or include a queued legacy write.
        if (localRevision !== undefined && localRevision > (resolution.state?.revision ?? 0)) return
        if (entries && hasPendingDirectTodoWrites(entries)) return
    } else if (current) {
        localRevisions.delete(current)
    }
    restoreSessionTodos(sessionId, resolution)
}
