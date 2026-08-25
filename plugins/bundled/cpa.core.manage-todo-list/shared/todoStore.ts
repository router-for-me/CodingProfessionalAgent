import { create } from 'zustand'
import type { TodoItem, TodoListState, TodoStatus } from './types.js'

const todosEntriesCache = new WeakMap<
    readonly (Record<string, unknown>)[],
    TodoItem[] | null
>()

/**
 * Extracts the latest active todo items from a session's conversation entries or legacy messages.
 * Scans backward from newest entry to find the most recent `manage_todo_list` write operation.
 */
export function extractTodosFromEntries(
    entries: readonly (Record<string, unknown>)[] | undefined | null
): TodoItem[] | null {
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return null
    }

    const cached = todosEntriesCache.get(entries)
    if (cached !== undefined) {
        return cached
    }

    // Collect error tool result IDs so failed/rejected tool calls are skipped
    const errorToolCallIds = new Set<string>()
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as Record<string, unknown> | undefined
        if (!entry) continue
        if (entry.kind === 'toolResult') {
            const toolCallId = String(entry.toolCallId || '')
            if (entry.isError === true && toolCallId) {
                errorToolCallIds.add(toolCallId)
            }
        }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as Record<string, unknown> | undefined
        if (!entry) continue

        // Skip incomplete streaming entries - wait until tool call completely finishes
        if (entry.status === 'streaming') {
            continue
        }

        // Check content blocks (canonical entries) or parts (legacy messages)
        const content = (entry.content ?? entry.parts) as unknown[] | undefined
        if (!Array.isArray(content)) continue

        for (let j = content.length - 1; j >= 0; j--) {
            const block = content[j] as Record<string, unknown> | undefined
            if (!block) continue

            const blockType = block.type
            const name = block.name ?? block.toolName
            const callId = String(block.id ?? '')

            if (callId && errorToolCallIds.has(callId)) {
                continue
            }
            if (
                (blockType === 'toolCall' || blockType === 'tool_call') &&
                (name === 'todo' || name === 'manage_todo_list')
            ) {
                let rawArgs = block.arguments ?? block.args
                if (typeof rawArgs === 'string') {
                    try {
                        rawArgs = JSON.parse(rawArgs)
                    } catch {
                        rawArgs = null
                    }
                }

                if (rawArgs && typeof rawArgs === 'object') {
                    const argsObj = rawArgs as Record<string, unknown>
                    if (argsObj.operation === 'write' && Array.isArray(argsObj.todoList)) {
                        const rawList = argsObj.todoList
                        const validatedTodos: TodoItem[] = []
                        for (let k = 0; k < rawList.length; k++) {
                            const item = rawList[k]
                            if (!item || typeof item !== 'object') continue
                            const raw = item as Record<string, unknown>
                            const id = typeof raw.id === 'number' ? raw.id : k + 1
                            const title =
                                typeof raw.title === 'string' && raw.title.trim().length > 0
                                    ? raw.title.trim()
                                    : `Task ${id}`
                            const description =
                                typeof raw.description === 'string' ? raw.description : ''
                            const statusStr = String(raw.status ?? '').toLowerCase()
                            const status: TodoStatus =
                                statusStr === 'completed' ||
                                statusStr === 'in-progress' ||
                                statusStr === 'not-started'
                                    ? statusStr
                                    : 'not-started'

                            validatedTodos.push({
                                id,
                                title,
                                description,
                                status,
                            })
                        }
                        todosEntriesCache.set(entries, validatedTodos)
                        return validatedTodos
                    }
                }
            }
        }
    }

    todosEntriesCache.set(entries, null)
    return null
}

export const useTodoListStore = create<TodoListState>((set, get) => ({
    todosBySession: {},

    setTodos: (sessionId: string, todos: TodoItem[]) => {
        if (!sessionId) return
        const defensiveCopy = todos.map((item) => ({ ...item }))
        set((state) => ({
            todosBySession: {
                ...state.todosBySession,
                [sessionId]: defensiveCopy,
            },
        }))
    },

    getTodos: (sessionId: string) => {
        if (!sessionId) return []
        const list = get().todosBySession[sessionId]
        return list ? list.map((item) => ({ ...item })) : []
    },

    clearTodos: (sessionId: string) => {
        if (!sessionId) return
        set((state) => {
            if (!(sessionId in state.todosBySession)) return state
            const next = { ...state.todosBySession }
            delete next[sessionId]
            return { todosBySession: next }
        })
    },

    clearAll: () => {
        set({ todosBySession: {} })
    },
}))

export function __resetTodoListStoreForTests(): void {
    useTodoListStore.getState().clearAll()
}
