import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useUiStore } from '@/stores/uiStore'
import {
    executeArchiveChatAction,
    executeCycleReasoningEffortAction,
    executeFocusMainChatInputAction,
    executeForkChatAction,
    executeMarkAsUnreadAction,
    executeNewChatAction,
    executeNewStandaloneChatAction,
    executeNextChatAction,
    executeNextModelAction,
    executeOpenFolderAction,
    executeOpenModelSelectorAction,
    executeOpenSettingsAction,
    executePreviousChatAction,
    executePreviousModelAction,
    executeToggleBottomPanelAction,
    executeTogglePinAction,
    executeToggleSidebarAction,
    executeStopExecutionAction,
    isEditableElement,
    isEventOrFocusInEditable,
    shouldBypassGlobalShortcutInEditable,
    useAppKeyboardShortcuts,
} from './useAppKeyboardShortcuts'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'

describe('useAppKeyboardShortcuts and executeNewChatAction', () => {
    const mockNavigate = vi.fn()

    beforeEach(async () => {
        vi.clearAllMocks()
        await rendererPluginRuntime.activateAll()
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-1',
                    name: 'Project 1',
                    path: '/path/1',
                    pinned: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
                {
                    id: 'proj-2',
                    name: 'Project 2',
                    path: '/path/2',
                    pinned: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            ],
        })
        useSessionStore.setState({
            manuallyMarkedUnreadSessionIds: [],
            sessions: [
                {
                    id: 'session-bound',
                    title: 'Bound Session',
                    pinned: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                    projectId: 'proj-1',
                    branch: 'feature/auth',
                },
                {
                    id: 'session-unbound',
                    title: 'Unbound Session',
                    pinned: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                    projectId: undefined,
                    branch: undefined,
                },
            ],
            currentSessionId: null,
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: null, branch: null },
            settingsOpen: false,
            sidebarCollapsed: false,
        })
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                shortcuts: {},
            },
        })
        useSessionRunStore.setState({ activeRuns: {} })
    })

    describe('executeNewStandaloneChatAction', () => {
        it('always creates an unbound new chat (projectId: null, branch: null) even when currently in a project session', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            useUiStore.setState({
                pendingSessionContext: { projectId: 'proj-1', branch: 'feature/auth' },
                settingsOpen: true,
                searchOpen: true,
                rightSidebarMaximized: true,
            })

            executeNewStandaloneChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: null,
                branch: null,
            })
            expect(useUiStore.getState().settingsOpen).toBe(false)
            expect(useUiStore.getState().searchOpen).toBe(false)
            expect(useUiStore.getState().rightSidebarMaximized).toBe(false)
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })
    })

    describe('executeNewChatAction', () => {
        it('creates a bound new chat when current active session has a project and branch', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })

            executeNewChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-1',
                branch: 'feature/auth',
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('retains last used worktree and environment settings when creating new chat in a project via shortcut', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'session-wt',
                        title: 'Worktree Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 2000,
                        projectId: 'proj-1',
                        branch: 'feature/wt',
                        workLocation: 'worktree',
                        environmentId: 'env-node-backend',
                    },
                ],
                currentSessionId: 'session-wt',
            })

            executeNewChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-1',
                branch: 'feature/wt',
                workLocation: 'worktree',
                environmentId: 'env-node-backend',
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('creates a bound new chat when pending context has a project and branch', () => {
            useSessionStore.setState({ currentSessionId: null })
            useUiStore.setState({
                pendingSessionContext: {
                    projectId: 'proj-2',
                    branch: 'main',
                },
            })

            executeNewChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-2',
                branch: 'main',
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('creates an unbound new chat when current session has no project', () => {
            useSessionStore.setState({ currentSessionId: 'session-unbound' })

            executeNewChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: null,
                branch: null,
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('creates an unbound new chat when current project is no longer in projects store', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'deleted-proj-session',
                        title: 'Test',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                        projectId: 'non-existent-proj',
                        branch: 'main',
                    },
                ],
                currentSessionId: 'deleted-proj-session',
            })

            executeNewChatAction(mockNavigate)

            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: null,
                branch: null,
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('closes settings panel if open when creating new chat', () => {
            useUiStore.setState({ settingsOpen: true })

            executeNewChatAction(mockNavigate)

            expect(useUiStore.getState().settingsOpen).toBe(false)
        })

        it('emits composer:focus on defaultEventBus when creating new chat', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:focus', listener)

            executeNewChatAction(mockNavigate)

            expect(listener).toHaveBeenCalledTimes(1)
            unsub()
        })
    })

    describe('executeNextChatAction and executePreviousChatAction', () => {
        beforeEach(() => {
            useProjectStore.setState({
                projects: [
                    {
                        id: 'proj-alpha',
                        name: 'Alpha Project',
                        pinned: true,
                        createdAt: 1000,
                        updatedAt: 3000,
                    },
                    {
                        id: 'proj-beta',
                        name: 'Beta Project',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 2000,
                    },
                ],
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-pinned',
                        title: 'Pinned Chat',
                        pinned: true,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                    {
                        id: 'sess-alpha-1',
                        title: 'Alpha Chat 1',
                        pinned: false,
                        projectId: 'proj-alpha',
                        createdAt: 1200,
                        updatedAt: 1200,
                    },
                    {
                        id: 'sess-beta-1',
                        title: 'Beta Chat 1',
                        pinned: false,
                        projectId: 'proj-beta',
                        createdAt: 1300,
                        updatedAt: 1300,
                    },
                    {
                        id: 'sess-uncat',
                        title: 'Uncategorized Chat',
                        pinned: false,
                        createdAt: 1400,
                        updatedAt: 1400,
                    },
                ],
                currentSessionId: null,
            })
        })

        it('switches across projects sequentially: pinned -> alpha -> beta -> uncategorized', () => {
            // Start at pinned session
            useSessionStore.setState({ currentSessionId: 'sess-pinned' })

            // Next -> Alpha Chat 1
            executeNextChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-alpha-1')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-alpha-1' },
            })

            // Next -> Beta Chat 1 (crossing project boundary)
            executeNextChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-beta-1')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-beta-1' },
            })

            // Next -> Uncategorized Chat
            executeNextChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-uncat')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-uncat' },
            })

            // Next -> wraps around to Pinned Chat
            executeNextChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-pinned')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-pinned' },
            })
        })

        it('switches backwards across projects with executePreviousChatAction', () => {
            useSessionStore.setState({ currentSessionId: 'sess-pinned' })

            // Previous from first -> wraps around to Uncategorized Chat
            executePreviousChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-uncat')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-uncat' },
            })

            // Previous -> Beta Chat 1
            executePreviousChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-beta-1')

            // Previous -> Alpha Chat 1
            executePreviousChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-alpha-1')
        })

        it('switches to first session when currently not in any session', () => {
            useSessionStore.setState({ currentSessionId: null })

            executeNextChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-pinned')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-pinned' },
            })
        })

        it('switches to last session when currently not in any session with previous action', () => {
            useSessionStore.setState({ currentSessionId: null })

            executePreviousChatAction(mockNavigate)
            expect(useSessionStore.getState().currentSessionId).toBe('sess-uncat')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-uncat' },
            })
        })

        it('does nothing when session list is empty', () => {
            useSessionStore.setState({ sessions: [], currentSessionId: null })

            executeNextChatAction(mockNavigate)
            expect(mockNavigate).not.toHaveBeenCalled()

            executePreviousChatAction(mockNavigate)
            expect(mockNavigate).not.toHaveBeenCalled()
        })
    })

    describe('executeToggleBottomPanelAction', () => {
        it('toggles bottomPanelVisible in uiStore', () => {
            useUiStore.setState({ bottomPanelVisible: false })

            executeToggleBottomPanelAction()
            expect(useUiStore.getState().bottomPanelVisible).toBe(true)

            executeToggleBottomPanelAction()
            expect(useUiStore.getState().bottomPanelVisible).toBe(false)
        })
    })

    describe('executeToggleSidebarAction', () => {
        it('toggles sidebarCollapsed in uiStore', () => {
            useUiStore.setState({ sidebarCollapsed: false })

            executeToggleSidebarAction()
            expect(useUiStore.getState().sidebarCollapsed).toBe(true)

            executeToggleSidebarAction()
            expect(useUiStore.getState().sidebarCollapsed).toBe(false)
        })
    })

    describe('executeOpenSettingsAction', () => {
        it('toggles settingsOpen in uiStore', () => {
            useUiStore.setState({ settingsOpen: false })

            executeOpenSettingsAction()
            expect(useUiStore.getState().settingsOpen).toBe(true)

            executeOpenSettingsAction()
            expect(useUiStore.getState().settingsOpen).toBe(false)
        })
    })

    describe('executeCycleReasoningEffortAction', () => {
        it('cycles through model reasoning levels and wraps around at the maximum', () => {
            useModelCatalogStore.setState({
                models: [
                    {
                        id: 'test-model',
                        label: 'Test Model',
                        supportsFast: false,
                        reasoningLevels: [
                            { id: 'low', requestValue: 'low' },
                            { id: 'medium', requestValue: 'medium' },
                            { id: 'high', requestValue: 'high' },
                        ],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                ],
                status: 'ready',
                error: null,
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'test-model',
                    reasoningLevel: 'low',
                },
            })

            // low -> medium
            const res1 = executeCycleReasoningEffortAction()
            expect(res1).toBe('medium')
            expect(useSettingsStore.getState().settings.reasoningLevel).toBe('medium')

            // medium -> high
            const res2 = executeCycleReasoningEffortAction()
            expect(res2).toBe('high')
            expect(useSettingsStore.getState().settings.reasoningLevel).toBe('high')

            // high -> low (wrap around)
            const res3 = executeCycleReasoningEffortAction()
            expect(res3).toBe('low')
            expect(useSettingsStore.getState().settings.reasoningLevel).toBe('low')
        })

        it('updates active session reasoning effort when cycling reasoning shortcut', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-shortcuts',
                        title: 'Shortcuts Session',
                        pinned: false,
                        modelId: 'test-model',
                        reasoningEffort: 'low',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-shortcuts',
            })

            const res = executeCycleReasoningEffortAction()
            expect(res).toBe('medium')

            const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-shortcuts')
            expect(session?.reasoningEffort).toBe('medium')
        })
    })

    describe('executeNextModelAction and executePreviousModelAction', () => {
        beforeEach(() => {
            useModelCatalogStore.setState({
                models: [
                    {
                        id: 'model-1',
                        label: 'Model 1',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                    {
                        id: 'model-2',
                        label: 'Model 2',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                    {
                        id: 'model-3',
                        label: 'Model 3',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                ],
                status: 'ready',
                error: null,
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'model-1',
                },
            })
        })

        it('switches to next model without cycling past the last model', () => {
            // model-1 -> model-2
            const res1 = executeNextModelAction()
            expect(res1).toBe('model-2')
            expect(useSettingsStore.getState().settings.modelId).toBe('model-2')

            // model-2 -> model-3
            const res2 = executeNextModelAction()
            expect(res2).toBe('model-3')
            expect(useSettingsStore.getState().settings.modelId).toBe('model-3')

            // model-3 is the last model: should NOT cycle wrap around
            const res3 = executeNextModelAction()
            expect(res3).toBeNull()
            expect(useSettingsStore.getState().settings.modelId).toBe('model-3')
        })

        it('switches to previous model without cycling past the first model', () => {
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'model-3',
                },
            })

            // model-3 -> model-2
            const res1 = executePreviousModelAction()
            expect(res1).toBe('model-2')
            expect(useSettingsStore.getState().settings.modelId).toBe('model-2')

            // model-2 -> model-1
            const res2 = executePreviousModelAction()
            expect(res2).toBe('model-1')
            expect(useSettingsStore.getState().settings.modelId).toBe('model-1')

            // model-1 is the first model: should NOT cycle wrap around
            const res3 = executePreviousModelAction()
            expect(res3).toBeNull()
            expect(useSettingsStore.getState().settings.modelId).toBe('model-1')
        })

        it('updates active session runtime settings when switching models with shortcut', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-shortcuts',
                        title: 'Shortcuts Session',
                        pinned: false,
                        modelId: 'model-1',
                        reasoningEffort: 'low',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-shortcuts',
            })

            const res = executeNextModelAction()
            expect(res).toBe('model-2')

            const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-shortcuts')
            expect(session?.modelId).toBe('model-2')
        })

        it('disallows switching next/previous model when current session is running', () => {
            useModelCatalogStore.setState({
                models: [
                    { id: 'model-1', label: 'Model 1', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                    { id: 'model-2', label: 'Model 2', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096 },
                ],
                status: 'ready',
                error: null,
            })
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-running',
                        title: 'Running Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                        modelId: 'model-1',
                    },
                ],
                currentSessionId: 'sess-running',
            })
            useSessionRunStore.getState().setRun('sess-running', {
                sessionId: 'sess-running',
                runId: 'run-1',
                status: 'running',
                clientId: 'c1',
                updatedAt: Date.now(),
            })

            expect(executeNextModelAction()).toBeNull()
            expect(executePreviousModelAction()).toBeNull()

            const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-running')
            expect(session?.modelId).toBe('model-1')
        })
    })

    describe('executeOpenModelSelectorAction', () => {
        it('emits composer:toggle-model-selector event on defaultEventBus', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:toggle-model-selector', listener)

            executeOpenModelSelectorAction()
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })

        it('does not emit composer:toggle-model-selector event when current session is running', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:toggle-model-selector', listener)

            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-running',
                        title: 'Running Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
                currentSessionId: 'sess-running',
            })
            useSessionRunStore.getState().setRun('sess-running', {
                sessionId: 'sess-running',
                runId: 'run-1',
                status: 'running',
                clientId: 'c1',
                updatedAt: Date.now(),
            })

            executeOpenModelSelectorAction()
            expect(listener).not.toHaveBeenCalled()

            unsub()
        })
    })

    describe('executeArchiveChatAction', () => {
        it('archives the current session and navigates to the next newest session', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Session 1',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                    {
                        id: 'sess-2',
                        title: 'Session 2',
                        pinned: false,
                        createdAt: 2000,
                        updatedAt: 2000,
                    },
                ],
                currentSessionId: 'sess-2',
            })

            executeArchiveChatAction(mockNavigate)

            const sessions = useSessionStore.getState().sessions
            expect(sessions.find((s) => s.id === 'sess-2')?.archivedAt).toBeDefined()
            expect(useSessionStore.getState().currentSessionId).toBe('sess-1')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'sess-1' },
            })
        })

        it('archives the only active session and navigates to /', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-only',
                        title: 'Only Session',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
                currentSessionId: 'sess-only',
            })

            executeArchiveChatAction(mockNavigate)

            const sessions = useSessionStore.getState().sessions
            expect(sessions.find((s) => s.id === 'sess-only')?.archivedAt).toBeDefined()
            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('does nothing when there is no active session', () => {
            useSessionStore.setState({ currentSessionId: null })

            executeArchiveChatAction(mockNavigate)

            expect(mockNavigate).not.toHaveBeenCalled()
        })
    })

    describe('useAppKeyboardShortcuts hook', () => {
        it('responds to default Meta+N shortcut to create new chat', () => {
            const focusSpy = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:focus', focusSpy)
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'n',
                code: 'KeyN',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-1',
                branch: 'feature/auth',
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
            expect(focusSpy).toHaveBeenCalled()
            unsub()
        })

        it('responds to default Option+Meta+O shortcut to create new standalone chat', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'o',
                code: 'KeyO',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: null,
                branch: null,
            })
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('responds to default Shift+Meta+O shortcut to create new chat', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'o',
                code: 'KeyO',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useUiStore.getState().pendingSessionContext).toEqual({
                projectId: 'proj-1',
                branch: 'feature/auth',
            })
        })

        it('responds to custom shortcut when configured in settings', () => {
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    shortcuts: {
                        'new-chat': [
                            { ctrl: false, alt: true, shift: false, meta: true, key: 'N' },
                        ],
                    },
                },
            })
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            // Old shortcut Meta+N should no longer trigger
            const eventOld = new KeyboardEvent('keydown', {
                key: 'n',
                code: 'KeyN',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventOld)
            expect(eventOld.defaultPrevented).toBe(false)
            expect(mockNavigate).not.toHaveBeenCalled()

            // Custom shortcut Alt+Meta+N should trigger
            const eventCustom = new KeyboardEvent('keydown', {
                key: 'n',
                code: 'KeyN',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventCustom)
            expect(eventCustom.defaultPrevented).toBe(true)
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('ignores event when default is already prevented', () => {
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'n',
                code: 'KeyN',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            event.preventDefault()
            window.dispatchEvent(event)

            expect(mockNavigate).not.toHaveBeenCalled()
        })

        it('responds to next-chat shortcuts (Shift+Meta+] and Option+Meta+Right)', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event1 = new KeyboardEvent('keydown', {
                key: ']',
                code: 'BracketRight',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event1)

            expect(event1.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBe('session-unbound')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'session-unbound' },
            })

            const event2 = new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBe('session-bound')
        })

        it('responds to previous-chat shortcuts (Shift+Meta+[ and Option+Meta+Left)', () => {
            useSessionStore.setState({ currentSessionId: 'session-bound' })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event1 = new KeyboardEvent('keydown', {
                key: '[',
                code: 'BracketLeft',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event1)

            expect(event1.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBe('session-unbound')
            expect(mockNavigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: 'session-unbound' },
            })

            const event2 = new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                code: 'ArrowLeft',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().currentSessionId).toBe('session-bound')
        })

        it('responds to toggle-bottom-panel shortcut (Meta+J)', () => {
            useUiStore.setState({ bottomPanelVisible: false })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'j',
                code: 'KeyJ',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useUiStore.getState().bottomPanelVisible).toBe(true)

            // Press again to toggle back
            const event2 = new KeyboardEvent('keydown', {
                key: 'j',
                code: 'KeyJ',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useUiStore.getState().bottomPanelVisible).toBe(false)
        })

        it('responds to archive-chat shortcut (Shift+Meta+A)', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-active',
                        title: 'Active Chat',
                        pinned: false,
                        createdAt: 1000,
                        updatedAt: 1000,
                    },
                ],
                currentSessionId: 'sess-active',
            })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'a',
                code: 'KeyA',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(
                useSessionStore.getState().sessions.find((s) => s.id === 'sess-active')
                    ?.archivedAt
            ).toBeDefined()
            expect(useSessionStore.getState().currentSessionId).toBeNull()
            expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        })

        it('responds to toggle-sidebar shortcut (Meta+B)', () => {
            useUiStore.setState({ sidebarCollapsed: false })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'b',
                code: 'KeyB',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useUiStore.getState().sidebarCollapsed).toBe(true)

            // Press again to toggle back
            const event2 = new KeyboardEvent('keydown', {
                key: 'b',
                code: 'KeyB',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useUiStore.getState().sidebarCollapsed).toBe(false)
        })

        it('responds to settings shortcut (Meta+,) to toggle settings panel', () => {
            useUiStore.setState({ settingsOpen: false })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: ',',
                code: 'Comma',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useUiStore.getState().settingsOpen).toBe(true)

            const event2 = new KeyboardEvent('keydown', {
                key: ',',
                code: 'Comma',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useUiStore.getState().settingsOpen).toBe(false)
        })

        it('responds to cycle-reasoning-effort shortcut (Shift+Tab) to cycle reasoning effort', () => {
            useModelCatalogStore.setState({
                models: [
                    {
                        id: 'test-model-cycle',
                        label: 'Test Model',
                        supportsFast: false,
                        reasoningLevels: [
                            { id: 'low', requestValue: 'low' },
                            { id: 'high', requestValue: 'high' },
                        ],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                ],
                status: 'ready',
                error: null,
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'test-model-cycle',
                    reasoningLevel: 'low',
                },
            })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.reasoningLevel).toBe('high')

            // Cycle again -> wraps to low
            const event2 = new KeyboardEvent('keydown', {
                key: 'Tab',
                code: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event2)

            expect(event2.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.reasoningLevel).toBe('low')
        })

        it('responds to next-model (Ctrl+P) and previous-model (Ctrl+Shift+P) shortcuts', () => {
            useModelCatalogStore.setState({
                models: [
                    {
                        id: 'model-a',
                        label: 'Model A',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                    {
                        id: 'model-b',
                        label: 'Model B',
                        supportsFast: false,
                        reasoningLevels: [],
                        input: ['text'],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                ],
                status: 'ready',
                error: null,
            })
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    modelId: 'model-a',
                },
            })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            // Trigger next-model with Ctrl+P
            const eventNext = new KeyboardEvent('keydown', {
                key: 'p',
                code: 'KeyP',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventNext)

            expect(eventNext.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.modelId).toBe('model-b')

            // Trigger next again on the last model: remains model-b
            const eventNextLast = new KeyboardEvent('keydown', {
                key: 'p',
                code: 'KeyP',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventNextLast)
            expect(eventNextLast.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.modelId).toBe('model-b')

            // Trigger previous-model with Ctrl+Shift+P
            const eventPrev = new KeyboardEvent('keydown', {
                key: 'p',
                code: 'KeyP',
                ctrlKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventPrev)

            expect(eventPrev.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.modelId).toBe('model-a')

            // Trigger previous again on the first model: remains model-a
            const eventPrevFirst = new KeyboardEvent('keydown', {
                key: 'p',
                code: 'KeyP',
                ctrlKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(eventPrevFirst)
            expect(eventPrevFirst.defaultPrevented).toBe(true)
            expect(useSettingsStore.getState().settings.modelId).toBe('model-a')
        })

        it('responds to open-model-selector shortcut (Ctrl+Shift+M)', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:toggle-model-selector', listener)
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'm',
                code: 'KeyM',
                ctrlKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })

        it('responds to open-folder shortcut (Cmd/Ctrl+O)', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:open-folder', listener)
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'o',
                code: 'KeyO',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })

        it('responds to toggle-pin shortcut (Alt+Cmd/Ctrl+P)', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-1',
            })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'p',
                code: 'KeyP',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().sessions[0]?.pinned).toBe(true)
        })

        it('responds to mark-as-unread shortcut (Shift+Cmd/Ctrl+U)', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        unread: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-1',
            })
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'u',
                code: 'KeyU',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(useSessionStore.getState().sessions[0]?.unread).toBe(true)
        })

        it('responds to focus-main-chat-input default shortcut (Cmd/Ctrl+I)', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:focus', listener)
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const event = new KeyboardEvent('keydown', {
                key: 'i',
                code: 'KeyI',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })
    })

    describe('executeOpenFolderAction', () => {
        it('emits composer:open-folder event on defaultEventBus', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:open-folder', listener)

            executeOpenFolderAction()
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })
    })

    describe('executeTogglePinAction', () => {
        it('toggles pinned state on the current active session', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-1',
            })

            const result1 = executeTogglePinAction()
            expect(result1).toBe(true)
            expect(useSessionStore.getState().sessions[0]?.pinned).toBe(true)

            const result2 = executeTogglePinAction()
            expect(result2).toBe(false)
            expect(useSessionStore.getState().sessions[0]?.pinned).toBe(false)
        })

        it('returns null when no active session is selected', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: null,
            })

            const result = executeTogglePinAction()
            expect(result).toBeNull()
            expect(useSessionStore.getState().sessions[0]?.pinned).toBe(false)
        })

        it('returns null when active session is archived', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-archived',
                        title: 'Archived Session',
                        pinned: false,
                        archivedAt: Date.now(),
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-archived',
            })

            const result = executeTogglePinAction()
            expect(result).toBeNull()
            expect(useSessionStore.getState().sessions[0]?.pinned).toBe(false)
        })
    })

    describe('executeMarkAsUnreadAction', () => {
        it('marks current active session as unread', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        unread: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-1',
            })

            const result = executeMarkAsUnreadAction()
            expect(result).toBe('sess-1')
            expect(useSessionStore.getState().sessions[0]?.unread).toBe(true)
            expect(useSessionStore.getState().manuallyMarkedUnreadSessionIds).toContain('sess-1')
        })

        it('returns null when no active session is selected', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Test Session',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: null,
            })

            const result = executeMarkAsUnreadAction()
            expect(result).toBeNull()
            expect(useSessionStore.getState().sessions[0]?.unread).toBeUndefined()
        })

        it('returns null when active session is archived', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-archived',
                        title: 'Archived Session',
                        pinned: false,
                        archivedAt: Date.now(),
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-archived',
            })

            const result = executeMarkAsUnreadAction()
            expect(result).toBeNull()
            expect(useSessionStore.getState().sessions[0]?.unread).toBeUndefined()
        })
    })

    describe('executeForkChatAction', () => {
        it('forks current active session', () => {
            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-1',
                        title: 'Original Session',
                        projectId: 'proj-1',
                        branch: 'main',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-1',
            })

            const navigate = vi.fn()
            const result = executeForkChatAction(navigate)
            expect(result).toBeTruthy()
            expect(result).not.toBe('sess-1')
            expect(useSessionStore.getState().sessions).toHaveLength(2)
            expect(navigate).toHaveBeenCalledWith({
                to: '/chat/$sessionId',
                params: { sessionId: result! },
            })
        })

        it('returns null when no active session is selected', () => {
            useSessionStore.setState({
                sessions: [],
                currentSessionId: null,
            })

            const result = executeForkChatAction()
            expect(result).toBeNull()
        })
    })

    describe('executeFocusMainChatInputAction', () => {
        it('emits composer:focus event on defaultEventBus and resets overlay states', () => {
            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:focus', listener)

            useUiStore.setState({
                settingsOpen: true,
                searchOpen: true,
                rightSidebarMaximized: true,
            })

            executeFocusMainChatInputAction()

            expect(listener).toHaveBeenCalledTimes(1)
            expect(useUiStore.getState().settingsOpen).toBe(false)
            expect(useUiStore.getState().searchOpen).toBe(false)
            expect(useUiStore.getState().rightSidebarMaximized).toBe(false)

            unsub()
        })
    })

    describe('useAppKeyboardShortcuts fork-chat shortcut', () => {
        it('triggers fork-chat shortcut on keydown', () => {
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    shortcuts: {
                        'fork-chat': [
                            { ctrl: false, alt: false, shift: true, meta: true, key: 'D' },
                        ],
                    },
                },
            })

            useSessionStore.setState({
                sessions: [
                    {
                        id: 'sess-fork-test',
                        title: 'Fork Shortcut Test',
                        pinned: false,
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                currentSessionId: 'sess-fork-test',
            })

            const navigate = vi.fn()
            renderHook(() => useAppKeyboardShortcuts(navigate))

            const event = new KeyboardEvent('keydown', {
                key: 'D',
                metaKey: true,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(navigate).toHaveBeenCalled()
        })

        it('triggers focus-main-chat-input shortcut with custom keybinding', () => {
            useSettingsStore.setState({
                settings: {
                    ...useSettingsStore.getState().settings,
                    shortcuts: {
                        'focus-main-chat-input': [
                            { ctrl: false, alt: true, shift: false, meta: true, key: 'I' },
                        ],
                    },
                },
            })

            const listener = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('composer:focus', listener)
            renderHook(() => useAppKeyboardShortcuts())

            const event = new KeyboardEvent('keydown', {
                key: 'i',
                code: 'KeyI',
                metaKey: true,
                altKey: true,
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(listener).toHaveBeenCalledTimes(1)

            unsub()
        })
    })

    describe('editable input handling and native shortcut bypass', () => {
        it('identifies input, textarea, contenteditable, and role=textbox as editable elements', () => {
            const textInput = document.createElement('input')
            textInput.type = 'text'
            expect(isEditableElement(textInput)).toBe(true)

            const checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            expect(isEditableElement(checkbox)).toBe(false)

            const button = document.createElement('input')
            button.type = 'button'
            expect(isEditableElement(button)).toBe(false)

            const textarea = document.createElement('textarea')
            expect(isEditableElement(textarea)).toBe(true)

            const contentEditableDiv = document.createElement('div')
            contentEditableDiv.contentEditable = 'true'
            expect(isEditableElement(contentEditableDiv)).toBe(true)

            const innerSpan = document.createElement('span')
            contentEditableDiv.appendChild(innerSpan)
            expect(isEditableElement(innerSpan)).toBe(true)

            const roleTextbox = document.createElement('div')
            roleTextbox.setAttribute('role', 'textbox')
            expect(isEditableElement(roleTextbox)).toBe(true)

            const regularDiv = document.createElement('div')
            expect(isEditableElement(regularDiv)).toBe(false)
            expect(isEditableElement(null)).toBe(false)

            const keyEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft' })
            Object.defineProperty(keyEvent, 'target', { value: textInput })
            expect(isEventOrFocusInEditable(keyEvent)).toBe(true)

            const divKeyEvent = new KeyboardEvent('keydown', { key: 'ArrowLeft' })
            Object.defineProperty(divKeyEvent, 'target', { value: regularDiv })
            expect(isEventOrFocusInEditable(divKeyEvent)).toBe(false)
        })

        it('bypasses cursor navigation shortcuts (Cmd+Left, Cmd+Right, Cmd+Up, Cmd+Down, Opt+Left) in editable elements', () => {
            const cmdLeft = new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                code: 'ArrowLeft',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdLeft)).toBe(true)

            const cmdRight = new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdRight)).toBe(true)

            const cmdUp = new KeyboardEvent('keydown', {
                key: 'ArrowUp',
                code: 'ArrowUp',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdUp)).toBe(true)

            const cmdDown = new KeyboardEvent('keydown', {
                key: 'ArrowDown',
                code: 'ArrowDown',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdDown)).toBe(true)

            const optLeft = new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                code: 'ArrowLeft',
                altKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(optLeft)).toBe(true)

            const backspace = new KeyboardEvent('keydown', {
                key: 'Backspace',
                code: 'Backspace',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(backspace)).toBe(true)

            const selectAll = new KeyboardEvent('keydown', {
                key: 'a',
                code: 'KeyA',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(selectAll)).toBe(true)

            const undo = new KeyboardEvent('keydown', {
                key: 'z',
                code: 'KeyZ',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(undo)).toBe(true)

            const plainTyping = new KeyboardEvent('keydown', {
                key: 'h',
                code: 'KeyH',
            })
            expect(shouldBypassGlobalShortcutInEditable(plainTyping)).toBe(true)

            // Non-editing global commands like Cmd+K, Cmd+N, Cmd+B should NOT be bypassed
            const cmdK = new KeyboardEvent('keydown', {
                key: 'k',
                code: 'KeyK',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdK)).toBe(false)

            const cmdN = new KeyboardEvent('keydown', {
                key: 'n',
                code: 'KeyN',
                metaKey: true,
            })
            expect(shouldBypassGlobalShortcutInEditable(cmdN)).toBe(false)

            const escapeKey = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
            })
            expect(shouldBypassGlobalShortcutInEditable(escapeKey)).toBe(false)
        })

        it('preserves native Cmd+Left and Cmd+Right in SkillDraftEditor contenteditable textbox without triggering browser-back/forward', () => {
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const container = document.createElement('div')
            container.dataset.testid = 'composer-input'
            container.setAttribute('role', 'textbox')
            container.contentEditable = 'true'
            document.body.appendChild(container)
            container.focus()

            const browserBackSpy = vi.fn()
            const unsub = rendererPluginRuntime.eventBus.on('browser:back', browserBackSpy)

            // Dispatch Cmd+Left on the contenteditable textbox
            const eventCmdLeft = new KeyboardEvent('keydown', {
                key: 'ArrowLeft',
                code: 'ArrowLeft',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            container.dispatchEvent(eventCmdLeft)

            expect(eventCmdLeft.defaultPrevented).toBe(false)
            expect(browserBackSpy).not.toHaveBeenCalled()

            // Dispatch Cmd+Right on the contenteditable textbox
            const browserForwardSpy = vi.fn()
            const unsub2 = rendererPluginRuntime.eventBus.on('browser:forward', browserForwardSpy)

            const eventCmdRight = new KeyboardEvent('keydown', {
                key: 'ArrowRight',
                code: 'ArrowRight',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            container.dispatchEvent(eventCmdRight)

            expect(eventCmdRight.defaultPrevented).toBe(false)
            expect(browserForwardSpy).not.toHaveBeenCalled()

            // However, Cmd+B (toggle sidebar) while inside editor should still work as a global shortcut
            useUiStore.setState({ sidebarCollapsed: false })
            const eventCmdB = new KeyboardEvent('keydown', {
                key: 'b',
                code: 'KeyB',
                metaKey: true,
                bubbles: true,
                cancelable: true,
            })
            container.dispatchEvent(eventCmdB)

            expect(eventCmdB.defaultPrevented).toBe(true)
            expect(useUiStore.getState().sidebarCollapsed).toBe(true)

            unsub()
            unsub2()
            document.body.removeChild(container)
        })

        it('bypasses shortcuts during IME composition inside inputs', () => {
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const input = document.createElement('input')
            document.body.appendChild(input)
            input.focus()

            const event = new KeyboardEvent('keydown', {
                key: 'Enter',
                keyCode: 229,
                isComposing: true,
                bubbles: true,
                cancelable: true,
            })
            input.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(false)
            document.body.removeChild(input)
        })

        it('responds to stop-execution shortcut (Escape) and emits composer:stop event', () => {
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const stopSpy = vi.fn()
            const unsub = rendererEventBus.on('composer:stop', stopSpy)

            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(stopSpy).toHaveBeenCalled()

            unsub()
        })

        it('does NOT bypass Escape key in editable element, allowing stop-execution shortcut to fire', () => {
            renderHook(() => useAppKeyboardShortcuts(mockNavigate))

            const textarea = document.createElement('textarea')
            document.body.appendChild(textarea)
            textarea.focus()

            const stopSpy = vi.fn()
            const unsub = rendererEventBus.on('composer:stop', stopSpy)

            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            })
            textarea.dispatchEvent(event)

            expect(event.defaultPrevented).toBe(true)
            expect(stopSpy).toHaveBeenCalled()

            unsub()
            document.body.removeChild(textarea)
        })

        it('executeStopExecutionAction emits composer:stop event', () => {
            const stopSpy = vi.fn()
            const unsub = rendererEventBus.on('composer:stop', stopSpy)

            executeStopExecutionAction()

            expect(stopSpy).toHaveBeenCalled()
            unsub()
        })
    })
})
