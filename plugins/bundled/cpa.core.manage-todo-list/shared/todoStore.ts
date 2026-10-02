import { create } from 'zustand'
import type { TodoItem, TodoListState, TodoStatus } from './types.js'

const todosEntriesCache = new WeakMap<
    readonly (Record<string, unknown>)[],
    TodoItem[] | null
>()

const TODO_TOOL_NAMES = new Set(['todo', 'manage_todo_list'])

function parseArguments(rawArgs: unknown): Record<string, unknown> | null {
    if (typeof rawArgs === 'string') {
        try {
            rawArgs = JSON.parse(rawArgs)
        } catch {
            return null
        }
    }
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        return null
    }
    return rawArgs as Record<string, unknown>
}

function validateTodoList(rawList: readonly unknown[]): TodoItem[] {
    const validatedTodos: TodoItem[] = []
    for (let index = 0; index < rawList.length; index++) {
        const item = rawList[index]
        if (!item || typeof item !== 'object') continue
        const raw = item as Record<string, unknown>
        const id = typeof raw.id === 'number' ? raw.id : index + 1
        const title =
            typeof raw.title === 'string' && raw.title.trim().length > 0
                ? raw.title.trim()
                : `Task ${id}`
        const description = typeof raw.description === 'string' ? raw.description : ''
        const statusStr = String(raw.status ?? '').toLowerCase()
        const status: TodoStatus =
            statusStr === 'completed' ||
            statusStr === 'in-progress' ||
            statusStr === 'not-started'
                ? statusStr
                : 'not-started'
        validatedTodos.push({ id, title, description, status })
    }
    return validatedTodos
}

/** Returns the written list, or null when the payload is not a todo write. */
function todosFromWriteArguments(rawArgs: unknown): TodoItem[] | null {
    const argsObj = parseArguments(rawArgs)
    if (!argsObj || argsObj.operation !== 'write' || !Array.isArray(argsObj.todoList)) {
        return null
    }
    return validateTodoList(argsObj.todoList)
}

function todosFromContentBlocks(
    entry: Record<string, unknown>,
    errorToolCallIds: ReadonlySet<string>,
): TodoItem[] | null {
    const content = (entry.content ?? entry.parts) as unknown[] | undefined
    if (!Array.isArray(content)) return null

    for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index] as Record<string, unknown> | undefined
        if (!block) continue

        const blockType = block.type
        const name = block.name ?? block.toolName
        const callId = String(block.id ?? '')
        if (callId && errorToolCallIds.has(callId)) continue
        if (
            (blockType !== 'toolCall' && blockType !== 'tool_call') ||
            !TODO_TOOL_NAMES.has(String(name))
        ) {
            continue
        }

        const todos = todosFromWriteArguments(block.arguments ?? block.args)
        if (todos !== null) return todos
    }
    return null
}

/**
 * Code Mode runs `todo` inside `exec` and records the call on the parent tool
 * result instead of as a top-level assistant tool call.
 */
function todosFromNestedTools(entry: Record<string, unknown>): TodoItem[] | null {
    const metadata = entry.displayMetadata
    if (!metadata || typeof metadata !== 'object') return null
    const nested = (metadata as Record<string, unknown>).nestedTools
    if (!Array.isArray(nested)) return null

    for (let index = nested.length - 1; index >= 0; index--) {
        const record = nested[index]
        if (!record || typeof record !== 'object') continue
        const raw = record as Record<string, unknown>
        const name = raw.name ?? raw.toolName
        if (!TODO_TOOL_NAMES.has(String(name))) continue
        if (String(raw.status ?? '') === 'error') continue

        const todos = todosFromWriteArguments(raw.args ?? raw.arguments)
        if (todos !== null) return todos
    }
    return null
}

/**
 * Extracts the latest active todo items from a session's conversation entries or legacy messages.
 * Scans backward for the most recent `todo` / `manage_todo_list` write, including writes
 * nested inside a Code Mode tool result.
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

    // Collect error tool result IDs so failed/rejected tool calls are skipped.
    const errorToolCallIds = new Set<string>()
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index] as Record<string, unknown> | undefined
        if (!entry || entry.kind !== 'toolResult') continue
        const toolCallId = String(entry.toolCallId || '')
        if (entry.isError === true && toolCallId) {
            errorToolCallIds.add(toolCallId)
        }
    }

    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index] as Record<string, unknown> | undefined
        if (!entry || entry.status === 'streaming') continue

        const fromContent = todosFromContentBlocks(entry, errorToolCallIds)
        if (fromContent !== null) {
            todosEntriesCache.set(entries, fromContent)
            return fromContent
        }

        const fromNested = todosFromNestedTools(entry)
        if (fromNested !== null) {
            todosEntriesCache.set(entries, fromNested)
            return fromNested
        }
    }

    todosEntriesCache.set(entries, null)
    return null
}

function normalizeToolCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

/**
 * Reads todo writes from overlays whose parent tool has not finished.
 * Finished parents are ignored so a stale exec overlay cannot hide a later write.
 */
export function extractTodosFromLiveOverlays(
    entries: readonly (Record<string, unknown>)[] | undefined | null,
    overlays: Readonly<Record<string, unknown>> | undefined | null,
): TodoItem[] | null {
    if (!overlays) return null

    const settled = new Set<string>()
    if (Array.isArray(entries)) {
        for (const entry of entries) {
            if (!entry || entry.kind !== 'toolResult') continue
            const toolCallId = String(entry.toolCallId || '')
            if (toolCallId) settled.add(normalizeToolCallId(toolCallId))
        }
    }

    let best: { at: number; todos: TodoItem[] } | null = null
    for (const overlay of Object.values(overlays)) {
        if (!overlay || typeof overlay !== 'object') continue
        const raw = overlay as Record<string, unknown>
        const toolCallId = String(raw.toolCallId || '')
        if (!toolCallId || settled.has(normalizeToolCallId(toolCallId))) continue
        const todos = todosFromNestedTools({ displayMetadata: raw.details })
        if (todos === null) continue
        const at = Number(raw.updatedAt) || 0
        if (!best || at >= best.at) best = { at, todos }
    }
    return best ? best.todos : null
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
