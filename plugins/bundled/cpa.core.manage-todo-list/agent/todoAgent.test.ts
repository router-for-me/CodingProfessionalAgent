import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@cpa/plugin-api'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { AgentPluginRuntimeHost } from '../../../../frontend/src/plugins/platform/AgentPluginRuntimeHost'
import {
    manageTodoListAgentEntry,
    createManageTodoListTool,
    formatTodoListOutput,
    MANAGE_TODO_LIST_DESCRIPTION,
    MANAGE_TODO_LIST_PARAMETERS,
} from './index.js'
import {
    useTodoListStore,
    extractTodosFromEntries,
    __resetTodoListStoreForTests,
} from '../shared/todoStore.js'
import { AUTO_CLEAR_DELAY_MS, resetTodoOrchestration } from '../shared/todoOrchestration.js'
import type { TodoItem } from '../shared/types.js'
import manifest from '../manifest.json'

describe('cpa.core.manage-todo-list agent entry', () => {
    let runtimeHost: AgentPluginRuntimeHost
    let eventBus: PluginEventBus

    beforeEach(() => {
        __resetTodoListStoreForTests()
        eventBus = new PluginEventBus()
        runtimeHost = new AgentPluginRuntimeHost({ eventBus })
    })

    afterEach(() => {
        resetTodoOrchestration()
        vi.useRealTimers()
    })

    it('has valid manifest metadata', () => {
        expect(manifest.id).toBe('cpa.core.manage-todo-list')
        expect(manifest.name).toBe('Todo List Manager')
        expect(manifest.apiVersion).toBe('1.0.0')
        expect(manifest.entries.agent).toBe('./agent/index.ts')
        expect(manifest.entries.renderer).toBe('./renderer/index.tsx')
        expect(manifest.capabilities).toContain('sessions.read')
        expect(manifest.contributes['tool-factory']).toContain('todo')
        expect(manifest.contributes['floating']).toContain('todo-progress-bar')
        expect(manifest.contributes['chat-renderer']).toContain('manage-todo-list-tool-card')
    })

    it('activates and registers manage_todo_list tool-factory contribution', async () => {
        const registeredFactories: any[] = []
        const invoke = vi.fn(async () => ({ entries: writeHistory(initialTodos) }))
        const context: any = {
            manifest,
            generation: 1,
            capabilities: new Set(['sessions.read']),
            capabilityClient: { invoke },
            events: eventBus,
            register: vi.fn((reg) => {
                if (reg.kind === 'tool-factory') {
                    registeredFactories.push(reg.value)
                }
                return () => {}
            }),
            getService: vi.fn(),
        }

        await manageTodoListAgentEntry.activate(context)
        expect(registeredFactories).toHaveLength(1)

        const factory = registeredFactories[0]
        expect(factory.id).toBe('todo')
        expect(factory.name).toBe('todo')
        expect(factory.parameters).toBe(MANAGE_TODO_LIST_PARAMETERS)
        expect(factory.parameters.properties.operation.enum).toEqual(['write', 'update', 'read'])
        expect(factory.order).toBe(120)
        expect(factory.targets).toEqual(['main'])
        expect(factory.riskLevel).toBe('session')
        expect(factory.requiresApproval).toBe(false)
        expect(factory.approvalCategory).toBe('task-management')
        expect(MANAGE_TODO_LIST_DESCRIPTION).toContain('Plan tasks and present live work progress')
        expect(MANAGE_TODO_LIST_DESCRIPTION).toContain('proactively')
        const result = await factory.create().execute('registered-read', { operation: 'read' }, session)
        expect(result.details).toEqual(initialTodos)
        expect(invoke).toHaveBeenCalledExactlyOnceWith('session:get', [session.sessionId])
    })

    it.each([{}, null, undefined])('validates session:get responses at the registered tool boundary (%s)', async (payload) => {
        const invoke = vi.fn(async () => payload)
        const register = vi.fn()
        await manageTodoListAgentEntry.activate({ manifest, capabilityClient: { invoke }, register } as any)
        const tool: AgentTool = register.mock.calls[0]![0].value.create()
        const result = tool.execute('read', { operation: 'read' }, session)
        if (payload === null || payload === undefined) {
            await expect(result).resolves.toMatchObject({ details: [] })
            expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(true)
        } else {
            await expect(result).rejects.toThrow(/Invalid session payload returned for session "incremental".*Please retry/)
            expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(false)
        }
        expect(invoke).toHaveBeenCalledExactlyOnceWith('session:get', [session.sessionId])
    })

    it('rejects a registered cold read or update when the history capability is missing', async () => {
        const register = vi.fn()
        await manageTodoListAgentEntry.activate({ manifest, register } as any)
        const tool: AgentTool = register.mock.calls[0]![0].value.create()
        for (const args of [{ operation: 'read' }, { operation: 'update', add: [{ title: 'Do not overwrite history' }] }]) {
            await expect(tool.execute('missing-client', args, session)).rejects.toThrow(
                'Session history capability is unavailable; cannot safely load existing todos for session "incremental". Please retry.',
            )
        }
        expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(false)
        expect(useTodoListStore.getState().getTodos(session.sessionId)).toEqual([])
    })

    it('handles write operation and updates store', async () => {
        const tool = createManageTodoListTool()
        const items: TodoItem[] = [
            {
                id: 1,
                title: 'Check current project status',
                description: 'Check project code and status',
                status: 'completed',
            },
            {
                id: 2,
                title: 'Organize todos',
                description: 'Organize follow-up tasks',
                status: 'in-progress',
            },
            {
                id: 3,
                title: 'Execute core operation',
                description: 'Core logic implementation',
                status: 'not-started',
            },
        ]

        const result = await tool.execute(
            'call-1',
            { operation: 'write', todoList: items },
            { sessionId: 'test-session-1' } as any
        )

        const text = (result.content[0] as any).text
        expect(text).toBe([
            'Successfully updated todo list (3 items).',
            '',
            'Current todo list (3 items):',
            '1. [x] Check current project status (completed): Check project code and status',
            '2. [-] Organize todos (in-progress): Organize follow-up tasks',
            '3. [ ] Execute core operation (not-started): Core logic implementation',
        ].join('\n'))
        expect(result.displayMetadata).toEqual({ todoSnapshot: items, todoRevision: expect.any(Number), committedAt: expect.any(Number), isWrite: true })
        expect(result.details).toEqual(items)
        expect(text).toContain('1. [x] Check current project status (completed)')
        expect(text).toContain('2. [-] Organize todos (in-progress)')
        expect(text).toContain('3. [ ] Execute core operation (not-started)')

        const stored = useTodoListStore.getState().getTodos('test-session-1')
        expect(stored).toHaveLength(3)
        expect(stored[0]?.status).toBe('completed')
        expect(stored[1]?.status).toBe('in-progress')
        expect(stored[2]?.status).toBe('not-started')
    })

    it('handles read operation', async () => {
        const tool = createManageTodoListTool()

        const emptyResult = await tool.execute(
            'call-2',
            { operation: 'read' },
            { sessionId: 'test-session-2' } as any
        )
        expect((emptyResult.content[0] as any).text).toBe('Todo list is currently empty.')

        const items: TodoItem[] = [
            {
                id: 1,
                title: 'Task A',
                description: 'Desc A',
                status: 'completed',
            },
        ]
        useTodoListStore.getState().setTodos('test-session-2', items)

        const readResult = await tool.execute(
            'call-3',
            { operation: 'read' },
            { sessionId: 'test-session-2' } as any
        )
        expect((readResult.content[0] as any).text).toContain('Current todo list (1 items):')
        expect((readResult.content[0] as any).text).toContain('1. [x] Task A (completed): Desc A')
    })

    it('validates write operation parameters', async () => {
        const tool = createManageTodoListTool()

        await expect(
            tool.execute(
                'call-val-1',
                { operation: 'write' },
                { sessionId: 'session-val' } as any
            )
        ).rejects.toThrow('Missing or invalid "todoList" parameter')

        await expect(
            tool.execute(
                'call-val-2',
                { operation: 'write', todoList: 'not an array' },
                { sessionId: 'session-val' } as any
            )
        ).rejects.toThrow('Missing or invalid "todoList" parameter')

        await expect(
            tool.execute(
                'call-val-3',
                { operation: 'invalid_op' },
                { sessionId: 'session-val' } as any
            )
        ).rejects.toThrow('Invalid operation "invalid_op"')
    })

    it('formats todo list output cleanly', () => {
        expect(formatTodoListOutput([])).toBe('Todo list is currently empty.')

        const formatted = formatTodoListOutput([
            {
                id: 1,
                title: 'Step 1',
                description: 'Details',
                status: 'completed',
            },
            {
                id: 2,
                title: 'Step 2',
                description: '',
                status: 'in-progress',
            },
            {
                id: 3,
                title: 'Step 3',
                description: 'Remaining',
                status: 'not-started',
            },
        ])

        expect(formatted).toContain('Current todo list (3 items):')
        expect(formatted).toContain('1. [x] Step 1 (completed): Details')
        expect(formatted).toContain('2. [-] Step 2 (in-progress)')
        expect(formatted).toContain('3. [ ] Step 3 (not-started): Remaining')
    })
})

const session = { sessionId: 'incremental' }
const initialTodos: TodoItem[] = [
    { id: 1, title: 'Inspect', description: 'Inspect details', status: 'in-progress' },
    { id: 3, title: 'Implement', description: 'Implement details', status: 'not-started' },
    { id: 7, title: 'Verify', description: 'Verify details', status: 'not-started' },
]

function writeHistory(todos: TodoItem[]) {
    return [{
        kind: 'assistant',
        content: [{ type: 'toolCall', id: 'historic-write', name: 'todo', arguments: { operation: 'write', todoList: todos } }],
    }]
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => { resolve = done })
    return { promise, resolve }
}

describe('incremental todo tool', () => {
    const tool = createManageTodoListTool()
    const update = (patch: Record<string, unknown>) => tool.execute('patch', { operation: 'update', ...patch }, session)
    const current = () => useTodoListStore.getState().getTodos(session.sessionId)

    beforeEach(() => resetTodoOrchestration())
    afterEach(() => {
        resetTodoOrchestration()
        vi.useRealTimers()
    })

    it('updates a single status and then batches status updates', async () => {
        useTodoListStore.getState().setTodos(session.sessionId, initialTodos)
        const one = await update({ updates: [{ id: 1, status: 'completed' }] })
        expect(one.content).toEqual([{ type: 'text', text: 'Updated todo list (1/3 completed):\n~ #1: status -> completed' }])
        const batch = await update({ updates: [{ id: 7, status: 'in-progress' }, { id: 3, status: 'completed' }] })
        expect(batch.content).toEqual([{ type: 'text', text: 'Updated todo list (2/3 completed, 1 in-progress):\n~ #7: status -> in-progress\n~ #3: status -> completed' }])
        expect(current().map(({ id, status }) => [id, status])).toEqual([[1, 'completed'], [3, 'completed'], [7, 'in-progress']])
        expect(batch.displayMetadata).toEqual({ todoSnapshot: current(), todoRevision: expect.any(Number), committedAt: expect.any(Number) })
        expect(batch.details).toEqual(current())
        expect(batch.displayMetadata?.todoRevision).toBeGreaterThan(one.displayMetadata?.todoRevision as number)
    })

    it('preserves untouched fields and omits long descriptions from the receipt', async () => {
        useTodoListStore.getState().setTodos(session.sessionId, initialTodos)
        const description = 'Detailed acceptance criterion. '.repeat(200)
        const result = await update({ updates: [{ id: 1, title: '  Review "plan"  ' }, { id: 3, description }] })
        expect(result.content).toEqual([{
            type: 'text',
            text: ['Updated todo list (0/3 completed, 1 in-progress):', `~ #1: title -> ${JSON.stringify('Review "plan"')}`, '~ #3: description updated'].join('\n'),
        }])
        expect(current()).toEqual([
            { ...initialTodos[0], title: 'Review "plan"' },
            { ...initialTodos[1], description },
            initialTodos[2],
        ])
    })

    it('combines updates, removals and additions with monotonic automatic IDs', async () => {
        useTodoListStore.getState().setTodos(session.sessionId, initialTodos)
        const result = await update({
            updates: [{ id: 3, status: 'in-progress' }],
            removeIds: [7],
            add: [{ title: '  First add  ' }, { id: 10, title: 'Explicit add', description: 'Acceptance criteria', status: 'completed' }, { title: 'Last add' }],
        })
        expect(current()).toEqual([
            initialTodos[0], { ...initialTodos[1], status: 'in-progress' },
            { id: 8, title: 'First add', description: '', status: 'not-started' },
            { id: 10, title: 'Explicit add', description: 'Acceptance criteria', status: 'completed' },
            { id: 11, title: 'Last add', description: '', status: 'not-started' },
        ])
        expect(result.content).toEqual([{
            type: 'text',
            text: [
                'Updated todo list (1/5 completed, 2 in-progress):', '~ #3: status -> in-progress', '- #7: removed',
                '+ #8: First add (not-started)', '+ #10: Explicit add (completed)', '+ #11: Last add (not-started)',
            ].join('\n'),
        }])
    })

    it('allows explicit reuse of a removed ID, and can remove the entire list', async () => {
        useTodoListStore.getState().setTodos(session.sessionId, initialTodos)
        await update({ removeIds: [3], add: [{ id: 3, title: 'Replacement' }] })
        expect(current().map(({ id }) => id)).toEqual([1, 7, 3])
        const result = await update({ removeIds: [1, 3, 7] })
        expect(result.content[0]).toMatchObject({ text: 'Updated todo list (0 items remaining):\n- #1: removed\n- #3: removed\n- #7: removed' })
        expect(result.displayMetadata).toEqual({ todoSnapshot: [], todoRevision: expect.any(Number), committedAt: expect.any(Number) })
    })

    it.each<[Record<string, unknown>, string]>([
        [{}, 'must be non-empty'],
        [{ updates: [] }, 'must be non-empty'],
        [{ updates: {} }, '"updates" must be an array'],
        [{ add: null }, '"add" must be an array'],
        [{ removeIds: '1' }, '"removeIds" must be an array'],
        [{ updates: [{ id: '1', status: 'completed' }] }, 'positive integer id'],
        [{ updates: [{ id: 1 }] }, 'must include status, title, or description'],
        [{ updates: [{ id: 1, status: 'COMPLETED' }] }, 'status must be'],
        [{ updates: [{ id: 1, title: ' ' }] }, 'title must be a non-empty string'],
        [{ updates: [{ id: 1, description: null }] }, 'description must be a string'],
        [{ updates: [{ id: 1, title: 'Valid' }, { id: 1, title: 'Duplicate' }] }, 'Duplicate ID #1 in "updates"'],
        [{ removeIds: [1, 1] }, 'Duplicate ID #1 in "removeIds"'],
        [{ removeIds: [1.5] }, 'positive integer'],
        [{ updates: [{ id: 1, title: 'Both' }], removeIds: [1] }, 'Cannot update and remove ID #1'],
        [{ updates: [{ id: 1, title: 'Valid' }, { id: 9, title: 'Missing' }], removeIds: [12] }, 'Todo IDs not found: #9, #12. Available IDs: 1, 3, 7. Call operation: "read"'],
        [{ add: [['Not plain']] }, 'plain object'],
        [{ add: [{}] }, 'title must be a non-empty string'],
        [{ add: [{ title: 'Bad description', description: 123 }] }, 'description must be a string'],
        [{ add: [{ title: 'Bad status', status: 'done' }] }, 'status must be'],
        [{ add: [{ id: 0, title: 'Bad ID' }] }, 'positive integer'],
        [{ updates: [{ id: 1, title: 'Do not commit' }], add: [{ id: 3, title: 'Existing' }] }, 'ID #3 already exists'],
        [{ add: [{ title: 'Automatically #8' }, { id: 8, title: 'Duplicate' }] }, 'ID #8 already exists'],
    ])('rejects invalid patch %j atomically', async (patch, message) => {
        useTodoListStore.getState().setTodos(session.sessionId, initialTodos)
        await expect(update(patch)).rejects.toThrow(message)
        expect(current()).toEqual(initialTodos)
    })

    it('loads persisted todos once, without replaying the in-flight direct patch', async () => {
        const patch = { operation: 'update', add: [{ title: 'Fresh item' }] }
        const loadSessionEntries = vi.fn(async () => [
            ...writeHistory(initialTodos),
            { kind: 'assistant', status: 'done', content: [{ type: 'toolCall', id: 'patch|fc', name: 'todo', arguments: patch }] },
        ])
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const result = await coldTool.execute('patch', patch, session)
        expect(result.displayMetadata?.todoSnapshot).toEqual([...initialTodos, { id: 8, title: 'Fresh item', description: '', status: 'not-started' }])
        const read = await coldTool.execute('read', { operation: 'read' }, session)
        expect(read.details).toEqual(result.displayMetadata?.todoSnapshot)
        expect(loadSessionEntries).toHaveBeenCalledExactlyOnceWith(session.sessionId)
    })

    it('hydrates on read but does not resurrect or re-fetch an archived list', async () => {
        const loadSessionEntries = vi.fn(async (id: string) => writeHistory(
            id === 'archived' ? initialTodos.map((item) => ({ ...item, status: 'completed' })) : initialTodos,
        ))
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const read = await coldTool.execute('read', { operation: 'read' }, session)
        expect(read.details).toEqual(initialTodos)
        const archived = { sessionId: 'archived' }
        expect((await coldTool.execute('archive-read', { operation: 'read' }, archived)).details).toEqual([])
        await expect(coldTool.execute('old-update', { operation: 'update', removeIds: [1] }, archived))
            .rejects.toThrow('currently empty (or all previous tasks were completed). Call operation: "write" to create a new list, or operation: "update" with add.')
        expect(loadSessionEntries.mock.calls).toEqual([[session.sessionId], ['archived']])
    })

    it('serializes concurrent updates across tool instances and continues after an error', async () => {
        const loadSessionEntries = vi.fn(async () => writeHistory(initialTodos))
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const [first, , second] = await Promise.all([
            coldTool.execute('first', { operation: 'update', add: [{ title: 'First' }] }, session),
            expect(update({ removeIds: [999] })).rejects.toThrow('Todo IDs not found: #999.'),
            update({ updates: [{ id: 8, status: 'in-progress' }], add: [{ title: 'Second' }] }),
        ])
        expect(first.isError).toBe(false)
        expect(second.isError).toBe(false)
        expect(current()).toEqual([
            ...initialTodos,
            { id: 8, title: 'First', description: '', status: 'in-progress' },
            { id: 9, title: 'Second', description: '', status: 'not-started' },
        ])
        expect(loadSessionEntries).toHaveBeenCalledTimes(1)
    })

    it.each(['read', 'update'])('fails %s with a retryable error when persisted history is temporarily unavailable', async (operation) => {
        const loadSessionEntries = vi.fn(async () => writeHistory(initialTodos))
            .mockRejectedValueOnce(new Error('Storage unavailable'))
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const args = { operation, ...(operation === 'update' && { add: [{ title: 'Follow-up' }] }) }
        await expect(coldTool.execute('failed', args, session))
            .rejects.toThrow('Failed to load existing todo list for session "incremental": Storage unavailable. Please retry.')
        expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(false)
        expect(current()).toEqual([])
        const retried = await coldTool.execute('retry', args, session)
        expect(retried.isError).toBe(false)
        expect(current()).toEqual(operation === 'read'
            ? initialTodos
            : [...initialTodos, { id: 8, title: 'Follow-up', description: '', status: 'not-started' }])
        expect(loadSessionEntries).toHaveBeenCalledTimes(2)
    })

    it.each([['read', 'signal'], ['update', 'cancellationSignal']] as const)(
        'aborts %s during hydration through %s without restoring or mutating the store',
        async (operation, signalKey) => {
            const controller = new AbortController()
            const history = deferred<ReturnType<typeof writeHistory>>()
            const loadStarted = deferred<void>()
            const loadSessionEntries = vi.fn(() => {
                loadStarted.resolve()
                return history.promise
            })
            const coldTool = createManageTodoListTool({ loadSessionEntries })
            const args = { operation, ...(operation === 'update' && { add: [{ title: 'Do not commit' }] }) }
            const result = coldTool.execute('cancel', args, { ...session, [signalKey]: controller.signal })
            const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
            await loadStarted.promise
            controller.abort()
            history.resolve(writeHistory(initialTodos))
            await rejected
            expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(false)
            expect(current()).toEqual([])
        },
    )

    it('does not run an aborted queued write or an already-aborted operation', async () => {
        const controller = new AbortController()
        const history = deferred<ReturnType<typeof writeHistory>>()
        const coldTool = createManageTodoListTool({ loadSessionEntries: () => history.promise })
        const read = coldTool.execute('load', { operation: 'read' }, session)
        const args = { operation: 'write', todoList: [] }
        const queued = coldTool.execute('queued', args, { ...session, signal: controller.signal })
        const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
        controller.abort()
        await expect(coldTool.execute('pre-aborted', args, { ...session, cancellationSignal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' })
        history.resolve(writeHistory(initialTodos))
        await expect(read).resolves.toMatchObject({ details: initialTodos })
        await rejected
        expect(current()).toEqual(initialTodos)
        expect(useTodoListStore.getState().revisionsBySession[session.sessionId]).toBeUndefined()
    })

    it('rejects ambiguous updates and removals without changing legacy duplicate IDs', async () => {
        const duplicateTodos = [...initialTodos, { ...initialTodos[0]!, title: 'Legacy duplicate' }]
        await tool.execute('write', { operation: 'write', todoList: duplicateTodos }, session)
        await expect(update({ updates: [{ id: 3, title: 'Do not commit' }, { id: 1, title: 'Ambiguous' }] }))
            .rejects.toThrow('Ambiguous duplicate todo IDs in current list: #1. Call operation: "write"')
        await expect(update({ removeIds: [7, 1] })).rejects.toThrow('Ambiguous duplicate todo IDs in current list: #1.')
        expect(current()).toEqual(duplicateTodos)
        await update({ updates: [{ id: 3, title: 'Unique' }] })
        expect(current().map(({ title }) => title)).toEqual(['Inspect', 'Unique', 'Verify', 'Legacy duplicate'])
    })

    it.each([25_000, 71_000])('keeps array details and a bounded patch on large lists (%s characters)', async (size) => {
        vi.useFakeTimers()
        const committedAt = Date.now()
        const largeTodos = [{ ...initialTodos[0]!, description: '验'.repeat(size) }, initialTodos[1]!]
        const write = await tool.execute('large', { operation: 'write', todoList: largeTodos }, session)
        expect(write.details).toEqual(largeTodos)
        expect(write.displayMetadata?.todoSnapshot).toEqual(size === 25_000 ? largeTodos : undefined)
        const description = 'x'.repeat(7000)
        const args = { operation: 'update', updates: [
            { id: 1, status: 'completed' }, { id: 3, description, title: '  Reviewed  ', extra: 'not replay data' },
        ] }
        const result = await tool.execute('patch', args, session)
        const expected = [{ ...largeTodos[0], status: 'completed' }, { ...largeTodos[1], title: 'Reviewed', description }]
        expect(result.details).toEqual(expected)
        expect((await tool.execute('read', { operation: 'read' }, session)).details).toEqual(expected)
        expect(result.displayMetadata).toEqual({
            todoRevision: (write.displayMetadata?.todoRevision as number) + 1,
            committedAt,
            todoPatch: { operation: 'update', updates: [{ id: 1, status: 'completed' }, { id: 3, description, title: 'Reviewed' }] },
        })
        const nested = { name: 'todo', status: 'done', args: { preview: '', truncated: true }, displayMetadata: result.displayMetadata }
        expect(new TextEncoder().encode(JSON.stringify(nested)).byteLength).toBeLessThan(65_536)
        expect(extractTodosFromEntries([
            ...writeHistory(largeTodos),
            { kind: 'toolResult', toolName: 'todo', toolCallId: 'historic-write', displayMetadata: write.displayMetadata },
            { kind: 'toolResult', toolName: 'exec', displayMetadata: { nestedTools: [nested] } },
        ])).toEqual(expected)
    })

    it('marks an empty base even when the add is too large to inline as a snapshot', async () => {
        const add = Array.from({ length: 900 }, (_, index) => ({ title: `Follow-up task ${index}` }))
        const result = await update({ add })
        expect(result.details).toHaveLength(add.length)
        expect(result.displayMetadata).toEqual({
            resetBase: true, todoRevision: expect.any(Number), committedAt: expect.any(Number),
            todoPatch: { operation: 'update', add },
        })
    })

    it.each([{}, undefined])('rejects malformed direct loader results without marking the session hydrated (%s)', async (payload) => {
        const loadSessionEntries = vi.fn(async () => payload as unknown as null)
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        await expect(coldTool.execute('patch', { operation: 'update', add: [{ title: 'New task' }] }, session))
            .rejects.toThrow(/Invalid session entries payload.*Please retry/)
        expect(useTodoListStore.getState().hasSessionState(session.sessionId)).toBe(false)
    })

    it('seeds a cold write from the historical revision floor after clock rollback', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(2000)
        const old = await tool.execute('old', { operation: 'write', todoList: initialTodos }, session)
        const oldEntry = { kind: 'toolResult', toolName: 'todo', toolCallId: 'old', displayMetadata: old.displayMetadata }
        resetTodoOrchestration()
        vi.setSystemTime(1000)
        const loadSessionEntries = vi.fn(async () => [oldEntry])
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const written = await coldTool.execute('new', { operation: 'write', todoList: [] }, session)
        expect(loadSessionEntries).toHaveBeenCalledExactlyOnceWith(session.sessionId)
        expect(written.displayMetadata).toMatchObject({ todoRevision: (old.displayMetadata?.todoRevision as number) + 1, committedAt: 1000, isWrite: true })
        expect(extractTodosFromEntries([oldEntry, { kind: 'toolResult', toolName: 'todo', toolCallId: 'new', displayMetadata: written.displayMetadata }])).toEqual([])
    })

    it('allows a full replacement when loading the historical revision fails', async () => {
        const loadSessionEntries = vi.fn(async () => { throw new Error('History temporarily unavailable') })
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        const written = await coldTool.execute('full-replacement', { operation: 'write', todoList: initialTodos }, session)
        expect(loadSessionEntries).toHaveBeenCalledExactlyOnceWith(session.sessionId)
        expect(written.details).toEqual(initialTodos)
        expect(current()).toEqual(initialTodos)
    })

    it.each([false, true])('rejects an unpersistable 80 KiB update before any store mutation (cold: %s)', async (cold) => {
        if (!cold) await tool.execute('seed', { operation: 'write', todoList: initialTodos }, session)
        const loadSessionEntries = vi.fn(async () => writeHistory(initialTodos))
        const receiver = cold ? createManageTodoListTool({ loadSessionEntries }) : tool
        const before = useTodoListStore.getState()
        const result = receiver.execute('too-large', {
            operation: 'update', updates: [{ id: 1, description: 'x'.repeat(80 * 1024) }],
        }, session)
        await expect(result).rejects.toThrow('Todo update payload exceeds the 48 KiB persistence limit; keep todo titles and descriptions concise.')
        expect(useTodoListStore.getState()).toBe(before)
        expect(current()).toEqual(cold ? [] : initialTodos)
    })

    it.each(['untouched', 'reopen', 'expired'])('restores the completion deadline on cold start (%s)', async (scenario) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
        const completedAt = Date.now()
        const oneTodo = [initialTodos[0]!]
        const write = await tool.execute('write', { operation: 'write', todoList: oneTodo }, session)
        const finish = await update({ updates: [{ id: 1, status: 'completed' }] })
        expect(finish.details).toEqual([{ ...oneTodo[0], status: 'completed' }])
        expect(finish.displayMetadata).toMatchObject({ completedAt, committedAt: completedAt })
        const revision = finish.displayMetadata?.todoRevision as number
        expect(revision).toBe((write.displayMetadata?.todoRevision as number) + 1)
        const entries = [{ kind: 'toolResult', toolName: 'todo', toolCallId: 'finish', displayMetadata: finish.displayMetadata }]
        resetTodoOrchestration()
        vi.advanceTimersByTime(scenario === 'expired' ? AUTO_CLEAR_DELAY_MS + 1 : 3000)
        const coldTool = createManageTodoListTool({ loadSessionEntries: async () => entries })
        const hydrated = await coldTool.execute('read', { operation: 'read' }, session)
        if (scenario === 'expired') {
            expect(hydrated.details).toEqual([])
            expect(useTodoListStore.getState().revisionsBySession[session.sessionId]).toBe(revision)
            return
        }
        expect(hydrated.details).toEqual(finish.displayMetadata?.todoSnapshot)
        if (scenario === 'reopen') {
            const reopened = await coldTool.execute('reopen', { operation: 'update', updates: [{ id: 1, status: 'in-progress' }] }, session)
            expect(reopened.displayMetadata?.todoRevision).toBeGreaterThan(revision)
            expect(reopened.displayMetadata).not.toHaveProperty('completedAt')
            vi.advanceTimersByTime(AUTO_CLEAR_DELAY_MS)
            expect(current()).toEqual(oneTodo)
        } else {
            vi.advanceTimersByTime(999)
            expect(current()).toHaveLength(1)
            vi.advanceTimersByTime(1)
            expect(current()).toEqual([])
        }
    })

    it('keeps revisions monotonic after hydration even if the local clock is behind', async () => {
        const todoRevision = Date.now() + 60_000
        const entries = [{ kind: 'toolResult', toolName: 'todo', toolCallId: 'old', displayMetadata: { todoSnapshot: initialTodos, todoRevision } }]
        const coldTool = createManageTodoListTool({ loadSessionEntries: async () => entries })
        const result = await coldTool.execute('new', { operation: 'update', add: [{ title: 'New' }] }, session)
        expect(result.displayMetadata?.todoRevision).toBe(todoRevision + 1)
    })

    it('reads only the revision floor on write and does not resurrect an auto-cleared list', async () => {
        vi.useFakeTimers()
        const loadSessionEntries = vi.fn(async () => writeHistory(initialTodos))
        const coldTool = createManageTodoListTool({ loadSessionEntries })
        await coldTool.execute('write', { operation: 'write', todoList: [initialTodos[0]] }, session)
        await coldTool.execute('finish', { operation: 'update', updates: [{ id: 1, status: 'completed' }] }, session)
        vi.advanceTimersByTime(3999)
        expect(current()).toHaveLength(1)
        vi.advanceTimersByTime(1)
        expect(current()).toEqual([])
        await expect(coldTool.execute('old-update', { operation: 'update', updates: [{ id: 1, status: 'in-progress' }] }, session))
            .rejects.toThrow('Todo IDs not found: #1.')
        expect((await coldTool.execute('new-update', { operation: 'update', add: [{ title: 'New plan' }] }, session)).displayMetadata?.todoSnapshot)
            .toEqual([{ id: 1, title: 'New plan', description: '', status: 'not-started' }])
        expect(loadSessionEntries).toHaveBeenCalledExactlyOnceWith(session.sessionId)
    })
})
