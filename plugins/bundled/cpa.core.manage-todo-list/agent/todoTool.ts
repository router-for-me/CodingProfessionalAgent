import type { AgentTool, ToolExecutionContext, ToolResult } from '@cpa/plugin-api'
import { useTodoListStore } from '../shared/todoStore.js'
import { setSessionTodos } from '../shared/todoOrchestration.js'
import type { TodoItem, TodoStatus } from '../shared/types.js'

export const MANAGE_TODO_LIST_TOOL_NAME = 'todo'
export const TODO_TOOL_NAME = 'todo'

export const MANAGE_TODO_LIST_DESCRIPTION =
    'Track task progress. Operations: "write" (replace with full todoList) or "read" (view list). Set status to "in-progress" before starting a task, and "completed" when finished.'

export const MANAGE_TODO_LIST_PARAMETERS = {
    type: 'object',
    properties: {
        operation: {
            type: 'string',
            enum: ['write', 'read'],
            description: '"write" to replace entire todo list, "read" to retrieve current list.',
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
                        type: 'string',
                        enum: ['not-started', 'in-progress', 'completed'],
                        description: 'Task state: "not-started" | "in-progress" | "completed".',
                    },
                },
                required: ['id', 'title', 'description', 'status'],
            },
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

export function createManageTodoListTool(): AgentTool {
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
            _toolCallId: string,
            args: Record<string, unknown>,
            toolContext: ToolExecutionContext
        ): Promise<ToolResult> {
            const operation = args.operation
            const sessionId = resolveSessionId(toolContext)

            if (operation === 'read') {
                const todos = useTodoListStore.getState().getTodos(sessionId)
                const text = formatTodoListOutput(todos)
                return {
                    content: [{ type: 'text', text }],
                    details: todos,
                    isError: false,
                }
            }

            if (operation === 'write') {
                const rawList = args.todoList
                if (!Array.isArray(rawList)) {
                    throw new Error(
                        'Missing or invalid "todoList" parameter. An array of todo items is required for write operation.'
                    )
                }

                const validatedTodos: TodoItem[] = []
                for (let i = 0; i < rawList.length; i++) {
                    const item = rawList[i]
                    if (!item || typeof item !== 'object') {
                        throw new Error(`Todo item at index ${i} is invalid.`)
                    }
                    const raw = item as Record<string, unknown>
                    const id = typeof raw.id === 'number' ? raw.id : i + 1
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

                setSessionTodos(sessionId, validatedTodos)
                const text = `Successfully updated todo list (${validatedTodos.length} items).\n\n${formatTodoListOutput(validatedTodos)}`
                return {
                    content: [{ type: 'text', text }],
                    details: validatedTodos,
                    isError: false,
                }
            }

            throw new Error(
                `Invalid operation "${String(operation)}". Supported operations: "write", "read".`
            )
        },
    }
}
