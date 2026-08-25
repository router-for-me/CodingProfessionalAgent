export type TodoStatus = 'not-started' | 'in-progress' | 'completed'

export interface TodoItem {
    id: number
    title: string
    description: string
    status: TodoStatus
}

export interface TodoListState {
    todosBySession: Record<string, TodoItem[]>
    setTodos: (sessionId: string, todos: TodoItem[]) => void
    getTodos: (sessionId: string) => TodoItem[]
    clearTodos: (sessionId: string) => void
    clearAll: () => void
}
