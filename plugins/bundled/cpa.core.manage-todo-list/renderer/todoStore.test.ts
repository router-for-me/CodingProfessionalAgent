import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    extractTodosFromEntries,
    extractTodosFromLiveOverlays,
    resolveActiveTodos,
    useTodoListStore,
    __resetTodoListStoreForTests,
} from '../shared/todoStore.js'
import { AUTO_CLEAR_DELAY_MS, resetTodoOrchestration, setSessionTodos, syncTodosFromEntries } from '../shared/todoOrchestration.js'
import { validateTodoSnapshot } from '../shared/todoPatch.js'
import type { TodoItem } from '../shared/types.js'

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

const todos: TodoItem[] = [
    { id: 1, title: 'Plan', description: 'Plan details', status: 'in-progress' },
    { id: 4, title: 'Verify', description: 'Verify details', status: 'not-started' },
]

function directCall(id: string, args: unknown) {
    return { kind: 'assistant', status: 'done', parts: [{ type: 'tool_call', id, toolName: 'todo', args }] }
}

function directResult(id: string, todoSnapshot?: unknown, isError = false, todoRevision?: number) {
    const displayMetadata = todoSnapshot !== undefined || todoRevision !== undefined ? { todoSnapshot, todoRevision } : undefined
    return { kind: 'toolResult', toolCallId: id, toolName: 'todo', isError, displayMetadata }
}

function codeResult(...nestedTools: Record<string, unknown>[]) {
    return { kind: 'toolResult', toolName: 'exec', displayMetadata: { nestedTools } }
}

function overlay(toolCallId: string, updatedAt: number, ...nestedTools: Record<string, unknown>[]) {
    return { toolCallId, updatedAt, details: { nestedTools } }
}

describe('incremental todo replay', () => {
    const write = directCall('write', { operation: 'write', todoList: todos })
    const firstUpdate = { operation: 'update', updates: [{ id: 1, status: 'completed' }], add: [{ title: 'Document' }] }
    const secondUpdate = { operation: 'update', updates: [{ id: 5, status: 'in-progress' }], removeIds: [4] }
    const afterFirst: TodoItem[] = [
        { ...todos[0], status: 'completed' }, todos[1],
        { id: 5, title: 'Document', description: '', status: 'not-started' },
    ]
    const afterSecond: TodoItem[] = [afterFirst[0], { ...afterFirst[2], status: 'in-progress' }]

    afterEach(() => {
        resetTodoOrchestration()
        vi.useRealTimers()
    })

    it('uses a normalized direct snapshot once even when the result follows another mutation', () => {
        const entries = [
            directCall('first|fc', { operation: 'update', removeIds: [999] }),
            directCall('second', JSON.stringify(secondUpdate)),
            directResult('first|result', afterFirst),
            directResult('second|result'),
        ]
        expect(extractTodosFromEntries(entries)).toEqual(afterSecond)
    })

    it('does not apply an inline patch twice when a legacy history puts the result before its call', () => {
        const args = { operation: 'update', add: [{ title: 'Append only once' }] }
        const result = { ...directResult('patch'), displayMetadata: { todoRevision: 10, todoPatch: args } }
        expect(extractTodosFromEntries([write, result, directCall('patch', args)])?.map(({ title }) => title))
            .toEqual(['Plan', 'Verify', 'Append only once'])
    })

    it('restores an orphaned snapshot after compaction, including an empty list', () => {
        expect(extractTodosFromEntries([directResult('first|fc', afterFirst)])).toEqual(afterFirst)
        expect(extractTodosFromEntries([write, directResult('first|fc', [])])).toEqual([])
    })

    it('replays legacy direct and nested update arguments in either order', () => {
        expect(extractTodosFromEntries([
            write,
            directCall('first', firstUpdate),
            directResult('first'),
            codeResult({ name: 'todo', status: 'done', args: JSON.stringify(secondUpdate) }),
        ])).toEqual(afterSecond)
        expect(extractTodosFromEntries([
            codeResult({ name: 'manage_todo_list', args: { operation: 'write', todoList: todos } }),
            codeResult({ toolName: 'todo', arguments: firstUpdate }),
            directCall('second', secondUpdate),
            directResult('second'),
        ])).toEqual(afterSecond)
    })

    it('uses nested details before args and replays later updates', () => {
        expect(extractTodosFromEntries([
            codeResult(
                { name: 'todo', status: 'done', details: { todoSnapshot: afterFirst }, args: { operation: 'write', todoList: [] } },
                { name: 'todo', status: 'done', details: [{}], args: secondUpdate },
            ),
        ])).toEqual(afterSecond)
    })

    it('skips failed, pending and invalid mutations without losing a valid earlier state', () => {
        const ignoredUpdates = ['error', 'rejected', 'aborted', 'running', 'awaiting_approval'].map((status) => ({
            name: 'todo', status, details: [], args: { operation: 'update', removeIds: [1] },
        }))
        expect(extractTodosFromEntries([
            write,
            directCall('failed|fc', { operation: 'update', removeIds: [4] }),
            directResult('failed', [], true),
            codeResult(...ignoredUpdates, { name: 'todo', args: secondUpdate }),
            { ...directCall('unfinished', firstUpdate), status: 'streaming' },
        ])).toEqual(todos)
        expect(extractTodosFromEntries([directCall('no-anchor', secondUpdate), directResult('no-anchor')])).toBeNull()
        const newPlan = directCall('new-plan', { operation: 'update', add: [{ title: 'New task' }] })
        expect(extractTodosFromEntries([newPlan])).toBeNull()
        expect(extractTodosFromEntries([write, newPlan])).toEqual(todos)
        expect(extractTodosFromEntries([newPlan, directResult('new-plan')]))
            .toEqual([{ id: 1, title: 'New task', description: '', status: 'not-started' }])
    })

    it('ignores stale or invalid overlay records and seeds update-only replay from entries', () => {
        const entries = [write, directResult('write', todos, false, 9), directCall('first', firstUpdate), directResult('first', undefined, false, 10), { ...codeResult(), toolCallId: 'settled|fc' }]
        expect(extractTodosFromLiveOverlays(entries, {
            live: overlay('live', 10, { name: 'todo', status: 'done', args: secondUpdate }),
            malformed: overlay('bad', 20, { name: 'todo', args: { operation: 'update', removeIds: [999] } }),
            pending: overlay('pending', 30, { name: 'todo', status: 'running', args: secondUpdate }),
            settled: overlay('settled', 40, { name: 'todo', details: [] }),
            older: overlay('older', 1, { name: 'todo', displayMetadata: { todoSnapshot: [], todoRevision: 8 } }),
        })).toEqual(afterSecond)
        expect(extractTodosFromLiveOverlays(null, {
            snapshot: overlay('snapshot', 20, { name: 'todo', details: afterFirst }, { name: 'todo', args: secondUpdate }),
        })).toEqual(afterSecond)
    })

    it('drops settled revisions and deduplicates equally versioned live records by updatedAt', () => {
        const exec = { kind: 'assistant', content: [{ type: 'toolCall', id: 'exec|fc', name: 'exec' }] }
        const entries = [exec, write, directResult('write', todos, false, 10)]
        const nested = (todoSnapshot: TodoItem[], todoRevision: number) => ({
            name: 'todo', status: 'done', details: { todoSnapshot, todoRevision },
        })
        expect(extractTodosFromLiveOverlays(entries, {
            stale: overlay('exec', 500, nested(afterFirst, 9)),
        })).toBeNull()
        expect(resolveActiveTodos(entries, {
            stale: overlay('exec', 500, nested(afterFirst, 9)),
        }).state?.todos).toEqual(todos)
        expect(extractTodosFromLiveOverlays(entries, {
            equal: overlay('exec', 900, nested(afterFirst, 10)),
        })).toBeNull()
        expect(extractTodosFromLiveOverlays(entries, {
            stale: overlay('exec', 500, nested(afterFirst, 11)),
            newer: overlay('other', 20, nested(afterFirst, 12)),
            tie: overlay('tie', 30, nested(afterSecond, 12)),
        })).toEqual(afterSecond)
    })

    it.each([[undefined, undefined], [10, undefined], [undefined, 10]])(
        'falls back to the parent index for mixed/legacy revisions (%s / %s)',
        (settledRevision, liveRevision) => {
            const exec = { kind: 'assistant', content: [{ type: 'toolCall', id: 'exec|fc', name: 'exec' }] }
            const settledWrite = directResult('write', todos, false, settledRevision)
            const overlays = { live: overlay('exec', 500, { name: 'todo', details: { todoSnapshot: afterFirst, todoRevision: liveRevision } }) }
            expect(resolveActiveTodos([exec, write, settledWrite], overlays).state?.todos).toEqual(todos)
            expect(resolveActiveTodos([write, settledWrite, exec], overlays).state?.todos).toEqual(afterFirst)
        },
    )

    it('uses newer settled mutations as the baseline for lightweight live deltas', () => {
        const entries = [directResult('settled', afterFirst, false, 10)]
        const overlays = { live: overlay('exec', 3,
            { name: 'todo', details: { todoSnapshot: todos, todoRevision: 9 } },
            { name: 'todo', args: secondUpdate, details: { snapshotOmitted: true, todoRevision: 11, completedAt: 50 } },
        ) }
        expect(resolveActiveTodos(entries, overlays)).toMatchObject({
            state: { todos: afterSecond, revision: 11, completedAt: 50 }, maxRevision: 11,
        })
    })

    it('keeps chronological settled writes after clock rollback and filters the older live parent', () => {
        const exec = { kind: 'assistant', content: [{ type: 'toolCall', id: 'exec|fc', name: 'exec' }] }
        const replacement = { ...directResult('write', todos, false, 10), displayMetadata: { todoSnapshot: todos, todoRevision: 10, isWrite: true } }
        const entries = [directResult('old', afterFirst, false, 20), exec, directCall('write', { preview: '', truncated: true }), replacement]
        const overlays = { old: overlay('exec', 800, { name: 'todo', displayMetadata: { todoSnapshot: afterSecond, todoRevision: 21 } }) }
        expect(extractTodosFromEntries(entries)).toEqual(todos)
        expect(resolveActiveTodos(entries, overlays)).toMatchObject({ state: { todos, revision: 10 }, maxRevision: 20 })
    })

    it.each([false, true])('replays actual commit order across parents even when B settles first (large: %s)', (large) => {
        const original = [{ ...todos[0]!, description: large ? 'x'.repeat(50_000) : '' }]
        const aTitle = 'Append A'
        const bTitle = 'Append B'
        const append = (id: number, title: string): TodoItem => ({ id, title, status: 'not-started', description: '' })
        const afterA = [...original, append(2, aTitle)]
        const afterB = [...afterA, append(3, bTitle)]
        const parent = (id: string) => ({ kind: 'assistant', content: [{ type: 'toolCall', id: `${id}|fc`, name: 'exec' }] })
        const result = (id: string, nested: Record<string, unknown>) => ({ ...codeResult(nested), toolCallId: id })
        const record = (todoRevision: number, title: string, todoSnapshot: TodoItem[]) => ({
            name: 'todo', status: 'done', displayMetadata: large
                ? { todoRevision, todoPatch: { operation: 'update', add: [{ title }] } }
                : { todoRevision, todoSnapshot },
        })
        const mutationA = record(10, aTitle, afterA)
        const mutationB = record(11, bTitle, afterB)
        const bSettled = [directResult('base', original, false, 9), parent('exec-a'), parent('exec-b'), result('exec-b', mutationB)]
        const overlays = { a: overlay('exec-a', 90, mutationA) }
        expect(resolveActiveTodos(bSettled, overlays).state?.todos).toEqual(afterB)
        expect(extractTodosFromEntries([...bSettled, result('exec-a', mutationA)])).toEqual(afterB)
        syncTodosFromEntries('out-of-order', bSettled, overlays, true)
        expect(useTodoListStore.getState().getTodos('out-of-order')).toEqual(afterB)
    })

    it('prefers a snapshot over a patch for the same replay revision', () => {
        const settled = { ...codeResult({ name: 'todo', displayMetadata: {
            todoRevision: 11, todoPatch: { operation: 'update', add: [{ title: 'Patch fallback' }] },
        } }), toolCallId: 'settled' }
        const overlays = { live: overlay('other', 1, { name: 'todo', displayMetadata: { todoRevision: 11, todoSnapshot: afterFirst } }) }
        expect(resolveActiveTodos([write, settled], overlays).state?.todos).toEqual(afterFirst)
    })

    it('orders nested mutations within the same settled parent by revision', () => {
        expect(extractTodosFromEntries([codeResult(
            { name: 'todo', displayMetadata: { todoSnapshot: afterSecond, todoRevision: 11 } },
            { name: 'todo', displayMetadata: { todoSnapshot: afterFirst, todoRevision: 10 } },
        )])).toEqual(afterSecond)
    })

    it('merges versioned live patches from all running parents on a large base', () => {
        const largeBase = [{ ...todos[0]!, description: 'x'.repeat(50_000) }]
        const nested = (title: string, todoRevision: number) => ({
            name: 'todo', status: 'done', args: { preview: '', truncated: true },
            displayMetadata: { todoRevision, todoPatch: { operation: 'update', add: [{ title }] } },
        })
        const entries = [directResult('base', largeBase, false, 20)]
        const overlays = {
            a: overlay('parent-a', 500, nested('Append A', 21)),
            b: overlay('parent-b', 100, nested('Append B', 22)),
            duplicate: overlay('parent-duplicate', 50, nested('Duplicate A', 21)),
            stale: overlay('parent-stale', 900, nested('Already settled', 20)),
        }
        const expected = [
            ...largeBase,
            { id: 2, title: 'Append A', status: 'not-started', description: '' },
            { id: 3, title: 'Append B', status: 'not-started', description: '' },
        ]
        expect(extractTodosFromLiveOverlays(entries, overlays)).toEqual(expected)
        syncTodosFromEntries('parallel', entries, overlays, true)
        expect(useTodoListStore.getState().getTodos('parallel')).toEqual(expected)
    })

    it.each(['resetBase', 'committedAt', 'createdAt'])('resets a completed baseline before a snapshot-omitted add (%s)', (reason) => {
        const finished = [{ id: 4, title: 'Archived', description: '', status: 'completed' }]
        const completedAt = 1000
        const add = ['New plan', 'Step two', 'Step three'].map((title) => ({ title, description: 'x'.repeat(16_310) }))
        const nested = {
            name: 'todo', status: 'done', args: { preview: '', truncated: true },
            displayMetadata: {
                todoRevision: 22, todoPatch: { operation: 'update', add },
                ...(reason === 'resetBase' ? { resetBase: true, committedAt: 1001 } : {}),
                ...(reason === 'committedAt' ? { committedAt: completedAt + AUTO_CLEAR_DELAY_MS } : {}),
            },
        }
        const entries = [
            { ...directResult('finished', finished, false, 21), createdAt: completedAt },
            { ...codeResult(nested), createdAt: reason === 'createdAt' ? completedAt + AUTO_CLEAR_DELAY_MS : 1001 },
        ]
        expect(extractTodosFromEntries(entries)).toEqual(add.map((item, index) => ({ id: index + 1, ...item, status: 'not-started' })))
    })

    it('replays a live add after the settled completion deadline rather than reusing its archived base', () => {
        const entries = [{ ...directResult('finish', [{ ...todos[1], status: 'completed' }], false, 20), createdAt: 1000 }]
        const overlays = { live: overlay('exec', 6000, {
            name: 'todo', displayMetadata: { todoRevision: 21, committedAt: 5000, todoPatch: { operation: 'update', add: [{ title: 'New' }] } },
        }) }
        expect(extractTodosFromLiveOverlays(entries, overlays)).toEqual([{ id: 1, title: 'New', description: '', status: 'not-started' }])
    })

    it('accepts defensive snapshot copies and rejects malformed snapshots', () => {
        const snapshot = validateTodoSnapshot(todos)
        expect(snapshot).toEqual(todos)
        expect(snapshot).not.toBe(todos)
        expect(snapshot?.[0]).not.toBe(todos[0])
        expect(validateTodoSnapshot({ todoSnapshot: [] })).toEqual([])
        for (const invalid of [null, {}, { id: 0 }, { id: 1.5 }, { title: ' ' }, { description: undefined }, { status: 'COMPLETED' }]) {
            const raw = invalid && Object.keys(invalid).length ? { ...todos[0], ...invalid } : invalid
            expect(validateTodoSnapshot([raw])).toBeNull()
        }
    })

    it('does not replay pending direct updates into the running tool state', () => {
        const sessionId = 'active'
        useTodoListStore.getState().setTodos(sessionId, todos)
        const pending = directCall('first|fc', firstUpdate)
        syncTodosFromEntries(sessionId, [write, pending], undefined, true)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual(todos)
        syncTodosFromEntries(sessionId, [write, pending, directResult('first', afterFirst)], undefined, true)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual(afterFirst)
    })

    it('does not overwrite newer local mutations with lagging Code Mode overlays', () => {
        const sessionId = 'parallel'
        const { todoRevision } = setSessionTodos(sessionId, afterSecond)
        syncTodosFromEntries(sessionId, [write], {
            exec: overlay('exec', 1, { name: 'todo', status: 'done', details: afterFirst }),
        }, true)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual(afterSecond)
        syncTodosFromEntries(sessionId, [write], {
            exec: overlay('exec', 1, { name: 'todo', status: 'done', details: { todoSnapshot: afterFirst, todoRevision: todoRevision + 1 } }),
        }, true)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual(afterFirst)
    })

    it.each([false, true])('resumes a historical completion timer or archives it when expired (%s)', (expired) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
        const sessionId = 'reload'
        const completed = todos.map((item): TodoItem => ({ ...item, status: 'completed' }))
        const completedAt = Date.now()
        const revision = completedAt + 10_000
        const entries = [{ ...directResult('complete', completed, false, revision), createdAt: completedAt }]
        vi.advanceTimersByTime(expired ? AUTO_CLEAR_DELAY_MS + 1 : 2800)
        syncTodosFromEntries(sessionId, entries)
        const store = useTodoListStore.getState()
        expect(store.revisionsBySession[sessionId]).toBe(revision)
        expect(store.getTodos(sessionId)).toEqual(expired ? [] : completed)
        if (!expired) {
            vi.advanceTimersByTime(1100)
            syncTodosFromEntries(sessionId, entries)
            expect(store.getTodos(sessionId)).toEqual(completed)
            vi.advanceTimersByTime(100)
            expect(store.getTodos(sessionId)).toEqual([])
        }
        expect(setSessionTodos(sessionId, todos).todoRevision).toBe(revision + 1)
    })

    it('retains hydration after auto-clear and does not extend the timer on unchanged replay', () => {
        vi.useFakeTimers()
        const sessionId = 'completed'
        const completed = todos.map((item): TodoItem => ({ ...item, status: 'completed' }))
        const entries = [directResult('complete', completed)]
        setSessionTodos(sessionId, completed)
        vi.advanceTimersByTime(3000)
        syncTodosFromEntries(sessionId, entries)
        vi.advanceTimersByTime(1000)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual([])
        syncTodosFromEntries(sessionId, entries)
        expect(useTodoListStore.getState().getTodos(sessionId)).toEqual([])
        expect(useTodoListStore.getState().hasSessionState(sessionId)).toBe(true)
        useTodoListStore.getState().clearAll()
        expect(useTodoListStore.getState().hasSessionState(sessionId)).toBe(false)
    })
})
