import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    extractTodosFromEntries,
    useTodoListStore,
    __resetTodoListStoreForTests,
} from '../shared/todoStore.js'
import { syncTodosFromEntries } from '../shared/todoOrchestration.js'

describe('todoStore & extraction from session entries (cpa.core.manage-todo-list)', () => {
    beforeEach(() => {
        __resetTodoListStoreForTests()
    })

    afterEach(() => {
        __resetTodoListStoreForTests()
    })

    describe('extractTodosFromEntries', () => {
        it('returns null for empty or invalid entries', () => {
            expect(extractTodosFromEntries([])).toBeNull()
            expect(extractTodosFromEntries(null)).toBeNull()
            expect(extractTodosFromEntries(undefined)).toBeNull()
        })

        it('extracts validated todo items from an entry with todo or manage_todo_list toolCall', () => {
            const entries: any[] = [
                {
                    id: 'msg-1',
                    sessionId: 'sess-1',
                    createdAt: 1000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-1',
                            name: 'todo',
                            arguments: {
                                operation: 'write',
                                todoList: [
                                    {
                                        id: 1,
                                        title: 'Task One',
                                        description: 'First step',
                                        status: 'completed',
                                    },
                                    {
                                        id: 2,
                                        title: 'Task Two',
                                        description: 'Second step',
                                        status: 'in-progress',
                                    },
                                    {
                                        id: 3,
                                        title: 'Task Three',
                                        description: 'Third step',
                                        status: 'not-started',
                                    },
                                ],
                            },
                        },
                    ],
                },
            ]

            const todos = extractTodosFromEntries(entries)
            expect(todos).toEqual([
                {
                    id: 1,
                    title: 'Task One',
                    description: 'First step',
                    status: 'completed',
                },
                {
                    id: 2,
                    title: 'Task Two',
                    description: 'Second step',
                    status: 'in-progress',
                },
                {
                    id: 3,
                    title: 'Task Three',
                    description: 'Third step',
                    status: 'not-started',
                },
            ])
        })

        it('extracts latest write operation when multiple manage_todo_list calls exist', () => {
            const entries: any[] = [
                {
                    id: 'msg-1',
                    sessionId: 'sess-1',
                    createdAt: 1000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-1',
                            name: 'manage_todo_list',
                            arguments: {
                                operation: 'write',
                                todoList: [
                                    { id: 1, title: 'Old Task 1', description: '', status: 'in-progress' },
                                ],
                            },
                        },
                    ],
                },
                {
                    id: 'msg-2',
                    sessionId: 'sess-1',
                    createdAt: 2000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-2',
                            name: 'manage_todo_list',
                            arguments: {
                                operation: 'read',
                            },
                        },
                    ],
                },
                {
                    id: 'msg-3',
                    sessionId: 'sess-1',
                    createdAt: 3000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-3',
                            name: 'manage_todo_list',
                            arguments: {
                                operation: 'write',
                                todoList: [
                                    { id: 1, title: 'Updated Task 1', description: '', status: 'completed' },
                                    { id: 2, title: 'Updated Task 2', description: '', status: 'in-progress' },
                                ],
                            },
                        },
                    ],
                },
            ]

            const todos = extractTodosFromEntries(entries)
            expect(todos).toEqual([
                { id: 1, title: 'Updated Task 1', description: '', status: 'completed' },
                { id: 2, title: 'Updated Task 2', description: '', status: 'in-progress' },
            ])
        })

        it('ignores failed/error tool results', () => {
            const entries: any[] = [
                {
                    id: 'msg-1',
                    sessionId: 'sess-1',
                    createdAt: 1000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-failed',
                            name: 'manage_todo_list',
                            arguments: {
                                operation: 'write',
                                todoList: [{ id: 1, title: 'Failed Task', description: '', status: 'in-progress' }],
                            },
                        },
                    ],
                },
                {
                    id: 'res-1',
                    sessionId: 'sess-1',
                    createdAt: 1100,
                    kind: 'toolResult',
                    toolCallId: 'call-failed',
                    isError: true,
                    content: [{ type: 'text', text: 'Operation failed' }],
                },
            ]

            expect(extractTodosFromEntries(entries)).toBeNull()
        })
    })

    describe('useTodoListStore operations', () => {
        it('sets and gets todos per session', () => {
            useTodoListStore.getState().setTodos('session-a', [
                { id: 1, title: 'Task A', description: '', status: 'not-started' },
            ])

            expect(useTodoListStore.getState().getTodos('session-a')).toEqual([
                { id: 1, title: 'Task A', description: '', status: 'not-started' },
            ])
            expect(useTodoListStore.getState().getTodos('session-b')).toEqual([])

            useTodoListStore.getState().clearTodos('session-a')
            expect(useTodoListStore.getState().getTodos('session-a')).toEqual([])
        })
    })
})
