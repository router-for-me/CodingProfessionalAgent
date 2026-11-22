export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
    id: number
    title: string
    description: string
    status: TodoStatus
}

export interface TodoUpdatePatch {
    id: number
    status?: TodoStatus
    title?: string
    description?: string
}

export interface TodoAddInput {
    title: string
    description?: string
    status?: TodoStatus
    id?: number
}

export interface TodoUpdateArguments {
    operation: 'update'
    updates?: TodoUpdatePatch[]
    add?: TodoAddInput[]
    removeIds?: number[]
}

export type TodoChangeRecord =
    | { kind: 'update'; id: number; fields: { status?: TodoStatus; title?: string; descriptionChanged?: boolean } }
    | { kind: 'remove'; id: number }
    | { kind: 'add'; id: number; title: string; status: TodoStatus }

export interface TodoListState {
    todosBySession: Record<string, TodoItem[]>
    hydratedSessions: Record<string, true>
    revisionsBySession: Record<string, number>
    observeRevision: (sessionId: string, revision: number) => void
    hasSessionState?: (sessionId: string) => boolean
    markSessionHydrated?: (sessionId: string) => void
    setTodos: (sessionId: string, todos: TodoItem[]) => void
    getTodos: (sessionId: string) => TodoItem[]
    clearTodos: (sessionId: string) => void
    clearAll: () => void
}
