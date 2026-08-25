import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { AgentPluginRuntimeHost } from '../../../../frontend/src/plugins/platform/AgentPluginRuntimeHost'
import {
    manageTodoListAgentEntry,
    createManageTodoListTool,
    formatTodoListOutput,
    MANAGE_TODO_LIST_DESCRIPTION,
    MANAGE_TODO_LIST_PARAMETERS,
    MANAGE_TODO_LIST_TOOL_NAME,
} from './index.js'
import {
    useTodoListStore,
    __resetTodoListStoreForTests,
} from '../shared/todoStore.js'
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
        __resetTodoListStoreForTests()
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
        const context: any = {
            manifest,
            generation: 1,
            capabilities: new Set(['sessions.read']),
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
        expect(factory.order).toBe(120)
        expect(factory.targets).toEqual(['main'])
        expect(factory.riskLevel).toBe('session')
        expect(factory.requiresApproval).toBe(false)
        expect(factory.approvalCategory).toBe('task-management')
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
        expect(text).toContain('Successfully updated todo list (3 items)')
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
