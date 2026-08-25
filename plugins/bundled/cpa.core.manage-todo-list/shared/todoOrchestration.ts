import { useTodoListStore, extractTodosFromEntries } from './todoStore.js'
import type { TodoItem } from './types.js'

const clearTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Orchestrates updating the todo list with auto-clear delay when all items are completed.
 */
export function setSessionTodos(sessionId: string, todos: TodoItem[]): void {
    if (!sessionId) return

    const existingTimer = clearTimerBySession.get(sessionId)
    if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
        clearTimerBySession.delete(sessionId)
    }

    useTodoListStore.getState().setTodos(sessionId, todos)

    const isAllCompleted = todos.length > 0 && todos.every((t) => t.status === 'completed')
    if (isAllCompleted) {
        const timer = setTimeout(() => {
            useTodoListStore.getState().clearTodos(sessionId)
            clearTimerBySession.delete(sessionId)
        }, 4000)
        clearTimerBySession.set(sessionId, timer)
    }
}

/**
 * Clears session todos and cancels any active auto-clear timers.
 */
export function clearSessionTodos(sessionId: string): void {
    if (!sessionId) return
    const existingTimer = clearTimerBySession.get(sessionId)
    if (existingTimer !== undefined) {
        clearTimeout(existingTimer)
        clearTimerBySession.delete(sessionId)
    }
    useTodoListStore.getState().clearTodos(sessionId)
}

/**
 * Cancels all active auto-clear timers and resets in-memory todos.
 */
export function resetTodoOrchestration(): void {
    for (const timer of clearTimerBySession.values()) {
        clearTimeout(timer)
    }
    clearTimerBySession.clear()
    useTodoListStore.getState().clearAll()
}

/**
 * Synchronizes the in-memory TodoListStore for a session from its conversation entries.
 */
export function syncTodosFromEntries(
    sessionId: string,
    entries: readonly (Record<string, unknown>)[] | undefined | null
): void {
    if (!sessionId) return
    if (!entries || entries.length === 0) {
        clearSessionTodos(sessionId)
        return
    }
    const extracted = extractTodosFromEntries(entries)
    if (extracted !== null) {
        const isAllCompleted =
            extracted.length > 0 && extracted.every((t) => t.status === 'completed')

        if (isAllCompleted) {
            const isCountingDown = clearTimerBySession.has(sessionId)
            if (!isCountingDown) {
                clearSessionTodos(sessionId)
                return
            }
        }

        setSessionTodos(sessionId, extracted)
    } else {
        clearSessionTodos(sessionId)
    }
}
