import i18n from '@/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { HostServicesProvider } from '@cpa/plugin-ui'
import { manageTodoListRendererEntry } from './index.js'
import { TodoProgressBar } from './components/TodoProgressBar.js'
import {
    useTodoListStore,
    __resetTodoListStoreForTests,
} from '../shared/todoStore.js'
import {
    setSessionTodos,
    resetTodoOrchestration,
} from '../shared/todoOrchestration.js'
import type { SessionFileChanges } from '../shared/fileChanges.js'
import manifest from '../manifest.json'

describe('cpa.core.manage-todo-list renderer entry and TodoProgressBar', () => {
    let eventBus: PluginEventBus

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        resetTodoOrchestration()
        __resetTodoListStoreForTests()
        eventBus = new PluginEventBus()
    })

    afterEach(() => {
        resetTodoOrchestration()
        __resetTodoListStoreForTests()
    })

    it('has valid manifest and registers floating and chat renderer', async () => {
        const registeredFloatings: any[] = []
        const registeredChatRenderers: any[] = []
        const context: any = {
            manifest,
            generation: 1,
            capabilities: new Set(['sessions.read']),
            events: eventBus,
            register: vi.fn((reg) => {
                if (reg.kind === 'floating') {
                    registeredFloatings.push(reg.value)
                }
                if (reg.kind === 'chat-renderer') {
                    registeredChatRenderers.push(reg.value)
                }
                return () => {}
            }),
            getService: vi.fn(),
        }

        await manageTodoListRendererEntry.activate(context)

        expect(registeredFloatings).toHaveLength(1)
        expect(registeredFloatings[0].id).toBe('todo-progress-bar')
        expect(registeredFloatings[0].pluginId).toBe('cpa.core.manage-todo-list')
        expect(registeredFloatings[0].anchor).toBe('[data-element="composer-container"]')
        expect(registeredFloatings[0].placement).toBe('top-center')
        expect(registeredFloatings[0].offset).toEqual({ y: -8 })

        expect(registeredChatRenderers).toHaveLength(1)
        expect(registeredChatRenderers[0].id).toBe('manage-todo-list-tool-card')
        expect(registeredChatRenderers[0].priority).toBe(50)
        expect(
            registeredChatRenderers[0].matches({
                type: 'tool_call',
                name: 'todo',
            })
        ).toBe(true)
        expect(
            registeredChatRenderers[0].matches({
                type: 'tool_call',
                name: 'manage_todo_list',
            })
        ).toBe(true)
    })

    it('renders progress bar when todos exist in store and shows running icon when running', () => {
        useTodoListStore.getState().setTodos('sess-1', [
            { id: 1, title: 'Step 1', description: 'Desc 1', status: 'completed' },
            { id: 2, title: 'Step 2', description: 'Desc 2', status: 'in-progress' },
            { id: 3, title: 'Step 3', description: 'Desc 3', status: 'not-started' },
        ])

        const { rerender } = render(<TodoProgressBar sessionId="sess-1" isRunning={true} />)

        const pill = screen.getByTestId('todo-progress-pill')
        expect(pill).toBeInTheDocument()
        expect(pill).toHaveTextContent('Step 2 / 3')
        expect(screen.getByTestId('todo-pill-icon-running')).toBeInTheDocument()
        expect(screen.getByTestId('todo-pill-text-step')).toHaveTextContent('Step 2 / 3')

        // When interrupted or not running, the running spin icon should be hidden
        rerender(<TodoProgressBar sessionId="sess-1" isRunning={false} />)
        expect(screen.queryByTestId('todo-pill-icon-running')).not.toBeInTheDocument()
        expect(screen.getByTestId('todo-pill-text-step')).toHaveTextContent('Step 2 / 3')
    })

    it('hides running icon when session run state is idle, error, or interrupted', () => {
        useTodoListStore.getState().setTodos('sess-interrupted', [
            { id: 1, title: 'Step 1', description: 'Desc 1', status: 'completed' },
            { id: 2, title: 'Step 2', description: 'Desc 2', status: 'in-progress' },
        ])

        let listenerCallback: (() => void) | null = null
        let currentRunState = { isStreaming: true, activeRunId: 'run-1' }

        const mockServices = {
            chatMessages: {
                getEntries: () => [],
                getDisplayMessages: () => [],
                replaceSessionEntries: () => {},
                getAgentRunState: () => currentRunState,
                subscribeAgentRunState: (_sid: string, cb: () => void) => {
                    listenerCallback = cb
                    return () => {
                        listenerCallback = null
                    }
                },
            },
        }

        render(
            <HostServicesProvider services={mockServices as any}>
                <TodoProgressBar sessionId="sess-interrupted" />
            </HostServicesProvider>
        )

        // Currently running: running icon visible
        expect(screen.getByTestId('todo-pill-icon-running')).toBeInTheDocument()

        // Interrupted / stopped: isStreaming becomes false
        act(() => {
            currentRunState = { isStreaming: false, activeRunId: null }
            listenerCallback?.()
        })

        // Running icon must be hidden now
        expect(screen.queryByTestId('todo-pill-icon-running')).not.toBeInTheDocument()
    })

    it('hides running icon when activeRun status is error or idle and shows when running', () => {
        useTodoListStore.getState().setTodos('sess-active-run', [
            { id: 1, title: 'Step 1', description: 'Desc 1', status: 'completed' },
            { id: 2, title: 'Step 2', description: 'Desc 2', status: 'in-progress' },
        ])

        let runsListener: (() => void) | null = null
        let currentRun: any = { sessionId: 'sess-active-run', status: 'running' }

        const mockServices = {
            sessions: {
                getCurrentSessionId: () => 'sess-active-run',
                getActiveRun: () => currentRun,
                subscribeRuns: (cb: () => void) => {
                    runsListener = cb
                    return () => {
                        runsListener = null
                    }
                },
            },
        }

        render(
            <HostServicesProvider services={mockServices as any}>
                <TodoProgressBar sessionId="sess-active-run" />
            </HostServicesProvider>
        )

        // When activeRun status is running: icon is visible
        expect(screen.getByTestId('todo-pill-icon-running')).toBeInTheDocument()

        // When activeRun status becomes error (interrupted on failure): icon hidden
        act(() => {
            currentRun = { sessionId: 'sess-active-run', status: 'error', error: 'Connection lost' }
            runsListener?.()
        })
        expect(screen.queryByTestId('todo-pill-icon-running')).not.toBeInTheDocument()

        // When activeRun status becomes idle (stopped/interrupted): icon hidden
        act(() => {
            currentRun = { sessionId: 'sess-active-run', status: 'idle' }
            runsListener?.()
        })
        expect(screen.queryByTestId('todo-pill-icon-running')).not.toBeInTheDocument()
    })

    it('shows completed icon when all todos are completed', () => {
        useTodoListStore.getState().setTodos('sess-completed', [
            { id: 1, title: 'Step 1', description: '', status: 'completed' },
            { id: 2, title: 'Step 2', description: '', status: 'completed' },
        ])

        render(<TodoProgressBar sessionId="sess-completed" />)

        expect(screen.getByTestId('todo-pill-icon-completed')).toBeInTheDocument()
        expect(screen.queryByTestId('todo-pill-icon-running')).not.toBeInTheDocument()
    })

    it('renders popover on hover with all items', () => {
        useTodoListStore.getState().setTodos('sess-2', [
            { id: 1, title: 'Step 1', description: 'Desc 1', status: 'completed' },
            { id: 2, title: 'Step 2', description: 'Desc 2', status: 'in-progress' },
        ])

        render(<TodoProgressBar sessionId="sess-2" />)

        const container = screen.getByTestId('todo-progress-container')
        fireEvent.mouseEnter(container)

        const popover = screen.getByTestId('todo-progress-popover')
        expect(popover).toBeInTheDocument()
        expect(screen.getByTestId('todo-item-1')).toHaveTextContent('Step 1')
        expect(screen.getByTestId('todo-item-2')).toHaveTextContent('Step 2')
    })

    it('auto-clears todos when all items are completed after timer delay', () => {
        vi.useFakeTimers()

        setSessionTodos('auto-clear-session', [
            { id: 1, title: 'Task 1', description: '', status: 'completed' },
            { id: 2, title: 'Task 2', description: '', status: 'completed' },
        ])

        expect(useTodoListStore.getState().getTodos('auto-clear-session')).toHaveLength(2)

        vi.advanceTimersByTime(3999)
        expect(useTodoListStore.getState().getTodos('auto-clear-session')).toHaveLength(2)

        vi.advanceTimersByTime(2)
        expect(useTodoListStore.getState().getTodos('auto-clear-session')).toHaveLength(0)

        vi.useRealTimers()
    })

    it('restores TodoProgressBar from chat message entries after reload', async () => {
        const entries = [
            {
                id: 'm1',
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call-1',
                        name: 'manage_todo_list',
                        arguments: {
                            operation: 'write',
                            todoList: [
                                {
                                    id: 1,
                                    title: 'Restored task',
                                    description: 'from entries',
                                    status: 'in-progress',
                                },
                            ],
                        },
                    },
                ],
            },
        ]

        const chatMessages = {
            getEntries: vi.fn(() => entries),
            ensureSessionLoaded: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => {}),
        }

        render(
            <HostServicesProvider services={{ chatMessages } as any}>
                <TodoProgressBar sessionId="sess-restore" />
            </HostServicesProvider>,
        )

        expect(await screen.findByTestId('todo-progress-pill')).toBeInTheDocument()
        expect(screen.getByTestId('todo-pill-text-step')).toHaveTextContent('Step 1 / 1')
        expect(chatMessages.ensureSessionLoaded).toHaveBeenCalledWith('sess-restore')
        expect(chatMessages.getEntries).toHaveBeenCalledWith('sess-restore')
        expect(useTodoListStore.getState().getTodos('sess-restore')).toEqual([
            {
                id: 1,
                title: 'Restored task',
                description: 'from entries',
                status: 'in-progress',
            },
        ])
    })

    it('renders file changes independently when no todos exist', () => {
        const fileChanges: SessionFileChanges = {
            files: {
                'src/App.tsx': { path: 'src/App.tsx', additions: 88, deletions: 18 },
                'src/index.ts': { path: 'src/index.ts', additions: 12, deletions: 4 },
            },
            totalAdditions: 100,
            totalDeletions: 22,
            totalFilesChanged: 2,
        }

        render(<TodoProgressBar sessionId="sess-files" fileChanges={fileChanges} />)

        expect(screen.getByTestId('todo-progress-pill')).toBeInTheDocument()
        expect(screen.getByTestId('todo-pill-text-changes')).toHaveTextContent('2 files changed')
        expect(screen.getByText('+100')).toBeInTheDocument()
        expect(screen.getByText('-22')).toBeInTheDocument()
        expect(screen.queryByTestId('todo-pill-text-step')).not.toBeInTheDocument()
    })

    it('shows file change list in popover on hover together with todos', () => {
        useTodoListStore.getState().setTodos('sess-merged', [
            { id: 1, title: 'Initialize setup', description: '', status: 'completed' },
            { id: 2, title: 'Write tests', description: '', status: 'in-progress' },
        ])

        const fileChanges: SessionFileChanges = {
            files: {
                'src/main.ts': { path: 'src/main.ts', additions: 42, deletions: 5 },
            },
            totalAdditions: 42,
            totalDeletions: 5,
            totalFilesChanged: 1,
        }

        render(<TodoProgressBar sessionId="sess-merged" fileChanges={fileChanges} />)

        const container = screen.getByTestId('todo-progress-container')
        fireEvent.mouseEnter(container)

        expect(screen.getByTestId('todo-progress-popover')).toBeInTheDocument()
        expect(screen.getByText('Initialize setup')).toBeInTheDocument()
        expect(screen.getByText('Write tests')).toBeInTheDocument()
        expect(screen.getByTestId('popover-file-changes')).toBeInTheDocument()
        expect(screen.getByText('main.ts')).toBeInTheDocument()
        expect(screen.getByTestId('popover-file-item-src/main.ts')).toHaveAttribute('title', 'src/main.ts')
    })

    it('opens review tab when clicking file items or the progress pill', () => {
        const openRightPanelTab = vi.fn()
        const setRightSidebarCollapsed = vi.fn()
        const fileChanges: SessionFileChanges = {
            files: {
                'src/main.ts': { path: 'src/main.ts', additions: 10, deletions: 2 },
                'src/utils/math.ts': { path: 'src/utils/math.ts', additions: 5, deletions: 0 },
            },
            totalAdditions: 15,
            totalDeletions: 2,
            totalFilesChanged: 2,
        }

        render(
            <HostServicesProvider
                services={{
                    ui: {
                        openRightPanelTab,
                        setRightSidebarCollapsed,
                    },
                } as any}
            >
                <TodoProgressBar sessionId="sess-review" fileChanges={fileChanges} />
            </HostServicesProvider>,
        )

        fireEvent.click(screen.getByTestId('todo-progress-pill'))
        expect(openRightPanelTab).toHaveBeenCalledWith('review', {
            activate: true,
            params: undefined,
        })
        expect(setRightSidebarCollapsed).toHaveBeenCalledWith(false)

        fireEvent.mouseEnter(screen.getByTestId('todo-progress-container'))
        fireEvent.click(screen.getByTestId('popover-file-item-src/utils/math.ts'))

        expect(openRightPanelTab).toHaveBeenLastCalledWith('review', {
            activate: true,
            params: {
                selectedFilePath: 'src/utils/math.ts',
                timestamp: expect.any(Number),
            },
        })
    })

    it('extracts file changes from chat message entries via HostServices', async () => {
        const entries = [
            {
                id: 'm-edit',
                kind: 'assistant',
                content: [
                    {
                        type: 'toolCall',
                        id: 'call-edit',
                        name: 'edit',
                        arguments: {
                            path: 'src/entry.ts',
                            edits: [{ oldText: 'a\nb', newText: 'a\nb\nc\nd' }],
                        },
                        details: { additions: 2, deletions: 0 },
                    },
                ],
            },
        ]

        const chatMessages = {
            getEntries: vi.fn(() => entries),
            ensureSessionLoaded: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => {}),
        }

        render(
            <HostServicesProvider services={{ chatMessages } as any}>
                <TodoProgressBar sessionId="sess-extract" />
            </HostServicesProvider>,
        )

        expect(await screen.findByTestId('todo-progress-pill')).toBeInTheDocument()
        expect(screen.getByTestId('todo-pill-text-changes')).toHaveTextContent('1 files changed')
        expect(screen.getByText('+2')).toBeInTheDocument()

        fireEvent.mouseEnter(screen.getByTestId('todo-progress-container'))
        expect(screen.getByTestId('popover-file-item-src/entry.ts')).toBeInTheDocument()
        expect(screen.getByText('entry.ts')).toBeInTheDocument()
    })
})
