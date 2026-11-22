import type { AgentTool, ToolExecutionContext, ToolResult } from '@cpa/plugin-api'
import { resolveActiveTodos, useTodoListStore } from '../shared/todoStore.js'
import { getTodoCompletionGraceMs, prepareTodoCommit, restoreSessionTodos, setSessionTodos } from '../shared/todoOrchestration.js'
import { applyTodoUpdate, formatTodoUpdateOutput, validateTodoList } from '../shared/todoPatch.js'
import type { TodoItem, TodoUpdateArguments } from '../shared/types.js'

export const MANAGE_TODO_LIST_TOOL_NAME = 'todo'
export const TODO_TOOL_NAME = 'todo'

export const MANAGE_TODO_LIST_DESCRIPTION =
    'Plan tasks and present live work progress to the user. Use proactively as much as possible for any coding, investigation, or multi-step work: create a task plan upfront, mark the active step "in-progress" before starting, mark steps "completed" immediately when finished, and keep the list updated as work evolves. Operations: "write" creates a new list or replaces the entire todoList when restructuring the plan. Prefer "update" for incremental changes: change status, title, or description via updates, append items via add, and/or remove items via removeIds without resending unchanged items. "read" shows the full current list with descriptions.'

const statusSchema = { type: 'string', enum: ['not-started', 'in-progress', 'completed'] }

export const MANAGE_TODO_LIST_PARAMETERS = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: ['write', 'update', 'read'],
            description: '"write" to create or replace the entire list; prefer "update" for incremental changes; "read" to retrieve the full list with descriptions.',
        },
        todoList: {
            type: 'array',
            description: 'Full list of todo items (required for "write").',
            items: {
                type: 'object',
                properties: {
                    id: {
                        type: 'number',
                        description: 'Sequential identifier starting from 1.',
                    },
                    title: {
                        type: 'string',
                        description: 'Concise task label (3-7 words).',
                    },
                    description: {
                        type: 'string',
                        description: 'Task details or acceptance criteria.',
                    },
                    status: {
                        ...statusSchema,
                        description: 'Task state: "not-started" | "in-progress" | "completed".',
                    },
                },
                required: ['id', 'title', 'status'],
            },
        },
        updates: {
            type: 'array',
            description: 'Existing items to change for "update". Include at least one field besides id.',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'number', description: 'Existing positive integer item ID.' },
                    status: statusSchema,
                    title: { type: 'string' },
                    description: { type: 'string' },
                },
                required: ['id'],
            },
        },
        add: {
            type: 'array',
            description: 'New items to append for "update". Omit id to allocate it automatically.',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    status: statusSchema,
                    id: { type: 'number', description: 'Optional unused positive integer ID.' },
                },
                required: ['title'],
            },
        },
        removeIds: {
            type: 'array',
            description: 'Existing positive integer item IDs to remove for "update".',
            items: { type: 'number' },
        },
    },
    required: ['operation'],
}

export function formatTodoListOutput(todos: TodoItem[]): string {
    if (todos.length === 0) {
        return 'Todo list is currently empty.'
    }
    const lines = todos.map((item) => {
        const marker =
            item.status === 'completed'
                ? '[x]'
                : item.status === 'in-progress'
                  ? '[-]'
                  : '[ ]'
        return `${item.id}. ${marker} ${item.title} (${item.status})${item.description ? `: ${item.description}` : ''}`
    })
    return `Current todo list (${todos.length} items):\n${lines.join('\n')}`
}

function resolveSessionId(context: unknown): string {
    if (context && typeof context === 'object') {
        const ctx = context as Record<string, unknown>
        if (typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) {
            return ctx.sessionId
        }
    }
    return 'default'
}

export interface CreateManageTodoListToolOptions {
    loadSessionEntries?: (sessionId: string) => Promise<readonly Record<string, unknown>[] | null>
}

const MAX_DISPLAY_METADATA_BYTES = 48 * 1024
const MAX_WRITE_DISPLAY_METADATA_BYTES = 200 * 1024
const sessionQueue = new Map<string, Promise<unknown>>()

function throwIfAborted(toolContext: ToolExecutionContext): void {
    if (toolContext?.signal?.aborted || toolContext?.cancellationSignal?.aborted) {
        const error = new Error('Todo operation aborted.')
        error.name = 'AbortError'
        throw error
    }
}

function jsonBytes(value: Record<string, unknown>): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function commitTodos(
    sessionId: string, todos: TodoItem[], text: string, revisionFloor: number,
    update?: { todoPatch: TodoUpdateArguments; resetBase: boolean },
): ToolResult {
    const commit = prepareTodoCommit(sessionId, todos, revisionFloor)
    const metadata = { ...commit, ...(update ? (update.resetBase ? { resetBase: true } : {}) : { isWrite: true }) }
    const snapshot = { ...metadata, todoSnapshot: todos }
    const limit = update ? MAX_DISPLAY_METADATA_BYTES : MAX_WRITE_DISPLAY_METADATA_BYTES
    let displayMetadata: Record<string, unknown> = metadata
    if (jsonBytes(snapshot) <= limit) {
        displayMetadata = snapshot
    } else if (update) {
        const patchMetadata = { ...metadata, todoPatch: update.todoPatch }
        if (jsonBytes(patchMetadata) > MAX_DISPLAY_METADATA_BYTES) {
            throw new Error('Todo update payload exceeds the 48 KiB persistence limit; keep todo titles and descriptions concise.')
        }
        displayMetadata = patchMetadata
    }
    setSessionTodos(sessionId, todos, commit)
    return { content: [{ type: 'text', text }], details: todos, displayMetadata, isError: false }
}

export function createManageTodoListTool({ loadSessionEntries }: CreateManageTodoListToolOptions = {}): AgentTool {
    async function loadTodoHistory(sessionId: string, toolCallId: string, toolContext: ToolExecutionContext) {
        if (!loadSessionEntries || useTodoListStore.getState().hasSessionState(sessionId)) return null
        let entries: readonly Record<string, unknown>[] | null
        try {
            entries = await loadSessionEntries(sessionId)
            if (entries !== null && !Array.isArray(entries)) throw new Error('Invalid session entries payload')
        } catch (error) {
            throwIfAborted(toolContext)
            const message = error instanceof Error ? error.message : String(error)
            const reason = `Failed to load existing todo list for session "${sessionId}": ${message.replace(/\.$/, '')}`
            throw new Error(message.endsWith('Please retry.') ? message : `${reason}. Please retry.`)
        }
        throwIfAborted(toolContext)
        return resolveActiveTodos(entries, undefined, toolCallId)
    }

    async function executeOperation(
        sessionId: string, toolCallId: string, args: Record<string, unknown>, toolContext: ToolExecutionContext,
    ): Promise<ToolResult> {
        throwIfAborted(toolContext)
        const operation = args.operation
        if (operation === 'read' || operation === 'update') {
            const history = await loadTodoHistory(sessionId, toolCallId, toolContext)
            throwIfAborted(toolContext)
            const store = useTodoListStore.getState()
            if (operation === 'read') {
                if (history && !store.hasSessionState(sessionId)) restoreSessionTodos(sessionId, history)
                const current = useTodoListStore.getState().getTodos(sessionId)
                return {
                    content: [{ type: 'text', text: formatTodoListOutput(current) }],
                    details: current,
                    isError: false,
                }
            }

            let current = store.getTodos(sessionId)
            const restored = history?.state
            if (!store.hasSessionState(sessionId) && restored &&
                (getTodoCompletionGraceMs(restored.todos, restored.completedAt) ?? 1) > 0) {
                current = restored.todos
            }
            const { nextTodos, changes, normalizedPatch } = applyTodoUpdate(current, args)
            return commitTodos(sessionId, nextTodos, formatTodoUpdateOutput(nextTodos, changes), history?.maxRevision ?? 0, {
                todoPatch: normalizedPatch, resetBase: current.length === 0,
            })
        }

        if (operation === 'write') {
            const rawList = args.todoList
            if (!Array.isArray(rawList)) {
                throw new Error(
                    'Missing or invalid "todoList" parameter. An array of todo items is required for write operation.'
                )
            }
            for (const [index, item] of rawList.entries()) {
                if (!item || typeof item !== 'object') throw new Error(`Todo item at index ${index} is invalid.`)
            }

            const validatedTodos = validateTodoList(rawList)
            const text = `Successfully updated todo list (${validatedTodos.length} items).\n\n${formatTodoListOutput(validatedTodos)}`
            let revisionFloor = 0
            try {
                revisionFloor = (await loadTodoHistory(sessionId, toolCallId, toolContext))?.maxRevision ?? 0
            } catch {
                // A full replacement does not depend on reading the previous list.
            }
            throwIfAborted(toolContext)
            return commitTodos(sessionId, validatedTodos, text, revisionFloor)
        }

        throw new Error(
            `Invalid operation "${String(operation)}". Supported operations: "write", "update", "read".`
        )
    }

    return {
        name: MANAGE_TODO_LIST_TOOL_NAME,
        label: MANAGE_TODO_LIST_TOOL_NAME,
        description: MANAGE_TODO_LIST_DESCRIPTION,
        parameters: MANAGE_TODO_LIST_PARAMETERS,
        targetAgent: 'main',
        validate(input: unknown): Record<string, unknown> {
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                return input as Record<string, unknown>
            }
            return {}
        },
        async execute(
            toolCallId: string,
            args: Record<string, unknown>,
            toolContext: ToolExecutionContext
        ): Promise<ToolResult> {
            throwIfAborted(toolContext)
            const sessionId = resolveSessionId(toolContext)
            const run = () => executeOperation(sessionId, toolCallId, args, toolContext)
            const execution = (sessionQueue.get(sessionId) ?? Promise.resolve()).then(run, run)
            sessionQueue.set(sessionId, execution)
            try {
                return await execution
            } finally {
                if (sessionQueue.get(sessionId) === execution) sessionQueue.delete(sessionId)
            }
        },
    }
}
