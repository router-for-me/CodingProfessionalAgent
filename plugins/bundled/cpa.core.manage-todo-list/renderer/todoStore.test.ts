import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    extractTodosFromEntries,
    extractTodosFromLiveOverlays,
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

        it('extracts a Code Mode todo write recorded on the parent exec result', () => {
            const entries: any[] = [
                {
                    id: 'msg-exec',
                    sessionId: 'sess-1',
                    createdAt: 1000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-exec',
                            name: 'exec',
                            arguments: { source: 'await tools.todo({ operation: "write", todoList: [] })' },
                        },
                    ],
                },
                {
                    id: 'res-exec',
                    sessionId: 'sess-1',
                    createdAt: 1100,
                    kind: 'toolResult',
                    toolCallId: 'call-exec',
                    toolName: 'exec',
                    isError: false,
                    content: [{ type: 'text', text: 'Cell completed.' }],
                    displayMetadata: {
                        nestedTools: [
                            {
                                id: 'nested-old',
                                type: 'tool_call',
                                name: 'todo',
                                status: 'done',
                                args: {
                                    operation: 'write',
                                    todoList: [{ id: 1, title: 'Old', description: '', status: 'in-progress' }],
                                },
                            },
                            {
                                id: 'nested-bash',
                                type: 'tool_call',
                                name: 'bash',
                                status: 'done',
                                args: { command: 'pwd' },
                            },
                            {
                                id: 'nested-new',
                                type: 'tool_call',
                                name: 'todo',
                                status: 'done',
                                args: JSON.stringify({
                                    operation: 'write',
                                    todoList: [
                                        { id: 1, title: 'Nested Task', description: 'From code mode', status: 'in-progress' },
                                    ],
                                }),
                            },
                        ],
                    },
                },
            ]

            expect(extractTodosFromEntries(entries)).toEqual([
                { id: 1, title: 'Nested Task', description: 'From code mode', status: 'in-progress' },
            ])
        })

        it('ignores a failed direct todo call and keeps the earlier nested write', () => {
            const entries: any[] = [
                {
                    id: 'res-exec',
                    sessionId: 'sess-1',
                    createdAt: 1100,
                    kind: 'toolResult',
                    toolCallId: 'call-exec',
                    isError: false,
                    content: [{ type: 'text', text: 'ok' }],
                    displayMetadata: {
                        nestedTools: [
                            {
                                name: 'todo',
                                status: 'done',
                                args: {
                                    operation: 'write',
                                    todoList: [{ id: 1, title: 'Still active', description: '', status: 'in-progress' }],
                                },
                            },
                        ],
                    },
                },
                {
                    id: 'msg-direct',
                    sessionId: 'sess-1',
                    createdAt: 2000,
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-direct',
                            name: 'todo',
                            arguments: {
                                operation: 'write',
                                todoList: [{ id: 1, title: 'Rejected', description: '', status: 'completed' }],
                            },
                        },
                    ],
                },
                {
                    id: 'res-direct',
                    sessionId: 'sess-1',
                    createdAt: 2100,
                    kind: 'toolResult',
                    toolCallId: 'call-direct',
                    isError: true,
                    content: [{ type: 'text', text: 'Unknown tool: todo' }],
                },
            ]

            expect(extractTodosFromEntries(entries)).toEqual([
                { id: 1, title: 'Still active', description: '', status: 'in-progress' },
            ])
        })

        it('skips an errored nested todo write', () => {
            const entries: any[] = [
                {
                    id: 'res-exec',
                    kind: 'toolResult',
                    isError: false,
                    content: [],
                    displayMetadata: {
                        nestedTools: [
                            {
                                name: 'todo',
                                status: 'error',
                                args: {
                                    operation: 'write',
                                    todoList: [{ id: 1, title: 'Failed nested', description: '', status: 'in-progress' }],
                                },
                            },
                        ],
                    },
                },
            ]

            expect(extractTodosFromEntries(entries)).toBeNull()
        })
    })

    describe('extractTodosFromLiveOverlays', () => {
        const runningTodo = {
            call_exec: {
                toolCallId: 'call_exec',
                updatedAt: 20,
                details: {
                    nestedTools: [
                        {
                            name: 'todo',
                            status: 'done',
                            args: {
                                operation: 'write',
                                todoList: [{ id: 1, title: 'Older live', description: '', status: 'not-started' }],
                            },
                        },
                        {
                            name: 'todo',
                            status: 'done',
                            args: {
                                operation: 'write',
                                todoList: [{ id: 1, title: 'Current live', description: '', status: 'in-progress' }],
                            },
                        },
                    ],
                },
            },
        }

        it('uses the latest write from an exec that has not finished', () => {
            const entries = [
                {
                    kind: 'assistant',
                    status: 'done',
                    content: [{ type: 'toolCall', id: 'call_exec|fc', name: 'exec', arguments: { source: '' } }],
                },
            ]
            expect(extractTodosFromLiveOverlays(entries, runningTodo)).toEqual([
                { id: 1, title: 'Current live', description: '', status: 'in-progress' },
            ])
        })

        it('ignores a settled exec overlay so a later entry write wins', () => {
            const entries = [
                {
                    kind: 'toolResult',
                    toolCallId: 'call_exec|fc',
                    isError: false,
                    content: [],
                    displayMetadata: {
                        nestedTools: [
                            {
                                name: 'todo',
                                status: 'done',
                                args: {
                                    operation: 'write',
                                    todoList: [{ id: 1, title: 'Finished exec', description: '', status: 'completed' }],
                                },
                            },
                        ],
                    },
                },
                {
                    kind: 'assistant',
                    status: 'done',
                    content: [
                        {
                            type: 'toolCall',
                            id: 'call-direct',
                            name: 'todo',
                            arguments: {
                                operation: 'write',
                                todoList: [{ id: 1, title: 'Direct follow-up', description: '', status: 'in-progress' }],
                            },
                        },
                    ],
                },
            ]
            expect(extractTodosFromLiveOverlays(entries, runningTodo)).toBeNull()
            syncTodosFromEntries('sess-live', entries as any, runningTodo)
            expect(useTodoListStore.getState().getTodos('sess-live')).toEqual([
                { id: 1, title: 'Direct follow-up', description: '', status: 'in-progress' },
            ])
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
