import type { MouseEventHandler, ReactNode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { viewRegistry } from '@/application/views/viewRegistry'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { AppShell } from './AppShell'

const { navigateMock } = vi.hoisted(() => ({
    navigateMock: vi.fn(),
}))

let mockPathname = '/'

vi.mock('@tanstack/react-router', () => ({
    Outlet: () => <div data-testid="outlet-fallback">Outlet Content</div>,
    Link: ({
        children,
        className,
        onClick,
        onContextMenu,
        params,
        title,
        to,
    }: {
        children: ReactNode
        className?: string
        onClick?: MouseEventHandler<HTMLAnchorElement>
        onContextMenu?: MouseEventHandler<HTMLAnchorElement>
        params?: { sessionId?: string }
        title?: string
        to: string
    }) => (
        <a
            className={className}
            href={params?.sessionId ? `/chat/${params.sessionId}` : to}
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title}
        >
            {children}
        </a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: mockPathname } }),
}))

vi.mock('@/features/agent/useAgentStream', () => ({
    useAgentStream: () => ({
        send: vi.fn(),
        stop: vi.fn(),
        isStreaming: false,
        runStatus: 'idle',
        supportsImages: true,
        skills: [],
        prompts: [],
        compact: vi.fn(),
    }),
}))

beforeEach(async () => {
    mockPathname = '/'
    navigateMock.mockReset()

    await rendererPluginRuntime.activateAll()

    useProjectStore.setState({ projects: [] })
    useSessionStore.setState({ sessions: [], currentSessionId: null })
    useSubAgentStore.setState({
        agents: [],
        openTabIdsByParent: {},
        focusedIdByParent: {},
    })
    useUiStore.setState({
        sidebarCollapsed: false,
        rightSidebarCollapsed: false,
        rightSidebarMaximized: false,
        pinnedSummaryVisible: false,
        bottomPanelVisible: false,
        settingsOpen: false,
        toasts: [],
    })
})

afterEach(async () => {
    await rendererPluginRuntime.reset()
    rendererRegistry.clear()
})

describe('AppShell host slot skeleton', () => {
    it('renders host structure with default slots (workspace.main outlet and workspace.composer)', () => {
        render(<AppShell />)

        expect(screen.getByTestId('main-titlebar')).toBeInTheDocument()
        expect(screen.getByTestId('window-toolbar')).toBeInTheDocument()
        expect(screen.getByTestId('outlet-fallback')).toBeInTheDocument()
        expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    })

    it('renders pinned summary overlay when pinnedSummaryVisible is true', () => {
        mockPathname = '/chat/session-123'
        useSessionStore.setState({
            sessions: [
                {
                    id: 'session-123',
                    title: 'Session Title',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        useUiStore.setState({ pinnedSummaryVisible: true })

        render(<AppShell />)

        expect(screen.getByTestId('pinned-summary')).toBeInTheDocument()
    })

    it('renders SubAgentPanel when chat session has subagents', () => {
        mockPathname = '/chat/session-123'
        useSubAgentStore.setState({
            agents: [
                {
                    id: 'agent-1',
                    sessionId: 'child-session-1',
                    parentSessionId: 'session-123',
                    name: 'Subagent A',
                    color: 'blue',
                    icon: 'sparkle',
                    modelId: 'test-model',
                    status: 'running',
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })

        render(<AppShell />)

        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        expect(within(screen.getByTestId('subagent-panel')).getByText('Subagent A')).toBeInTheDocument()
    })

    it('automatically activates pinnedSummaryVisible when entering a session without worktree error', () => {
        mockPathname = '/chat/session-456'
        useSessionStore.setState({
            sessions: [
                {
                    id: 'session-456',
                    title: 'Session 456',
                    pinned: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        useUiStore.setState({ pinnedSummaryVisible: false })

        render(<AppShell />)

        expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
        expect(screen.getByTestId('pinned-summary')).toBeInTheDocument()
        expect(screen.getByTestId('pinned-summary-toggle')).toBeInTheDocument()
    })

    it('preserves manual pinnedSummaryVisible state (false) when session has explicit override', () => {
        mockPathname = '/chat/session-closed-override'
        useSessionStore.setState({
            sessions: [
                {
                    id: 'session-closed-override',
                    title: 'Closed Override Session',
                    pinned: false,
                    pinnedSummaryVisible: false,
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
        })
        useUiStore.setState({ pinnedSummaryVisible: true })

        render(<AppShell />)

        expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
        expect(screen.queryByTestId('pinned-summary')).not.toBeInTheDocument()
        expect(screen.getByTestId('pinned-summary-toggle')).toBeInTheDocument()
        expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute('aria-pressed', 'false')
    })

    it('hides pinned-summary-toggle and deactivates summary on new chat home page', () => {
        mockPathname = '/'
        useUiStore.setState({ pinnedSummaryVisible: true })

        render(<AppShell />)

        expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
        expect(screen.queryByTestId('pinned-summary-toggle')).not.toBeInTheDocument()
        expect(screen.queryByTestId('pinned-summary')).not.toBeInTheDocument()
    })

    it('renders right sidebar selection window on home page when expanded without tabs', () => {
        useProjectStore.setState({
            projects: [{ id: 'proj-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({ pendingSessionContext: { projectId: 'proj-1', branch: null } })

        render(<AppShell />)

        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-review')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-terminal')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-file-manager')).toBeInTheDocument()
    })

    it('renders custom slot contributions for workspace.main, workspace.composer, and workspace.overlay', async () => {
        await rendererPluginRuntime.reset()
        rendererRegistry.clear()

        viewRegistry.registerView({
            id: 'home',
            path: '/',
            component: () => null,
            layout: { showComposer: true, rightPanelMode: 'default', reserveWindowToolbar: true },
        })

        rendererRegistry.registerSlot('workspace.main', {
            id: 'custom-main',
            pluginId: 'test-plugin',
            component: () => <div data-testid="custom-main-view">Custom Main View</div>,
        })
        rendererRegistry.registerSlot('workspace.composer', {
            id: 'custom-composer',
            pluginId: 'test-plugin',
            component: () => <div data-testid="custom-composer-view">Custom Composer View</div>,
        })
        rendererRegistry.registerSlot('workspace.overlay', {
            id: 'custom-overlay',
            pluginId: 'test-plugin',
            component: () => <div data-testid="custom-overlay-view">Custom Overlay View</div>,
        })

        render(<AppShell />)

        expect(screen.getByTestId('custom-main-view')).toHaveTextContent('Custom Main View')
        expect(screen.queryByTestId('outlet-fallback')).not.toBeInTheDocument()
        expect(screen.getByTestId('custom-composer-view')).toHaveTextContent('Custom Composer View')
        expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument()
        expect(screen.getByTestId('custom-overlay-view')).toHaveTextContent('Custom Overlay View')
    })

    it('hides main and sets aria-hidden when right sidebar is maximized', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: false,
            maximized: true,
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

        const main = screen.getByRole('main', { hidden: true })
        expect(main).toHaveAttribute('aria-hidden', 'true')
        expect(main.className).toContain('opacity-0')
    })

    it('shows main when right sidebar is not maximized', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: false,
            maximized: false,
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

        const main = screen.getByRole('main')
        expect(main).toHaveAttribute('aria-hidden', 'false')
        expect(main.className).toContain('opacity-100')
    })

    it('restores right sidebar state when switching between sessions in AppShell', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        const s2 = useSessionStore.getState().createSession({ title: 'Session 2' })

        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: false,
            activeTab: 'terminal',
            openTabs: ['terminal'],
        })
        useSessionStore.getState().setSessionRightSidebar(s2, {
            collapsed: true,
            activeTab: 'review',
            openTabs: ['review'],
        })

        mockPathname = `/chat/${s1}`
        const { rerender } = render(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['terminal'])

        mockPathname = `/chat/${s2}`
        rerender(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['review'])
    })

    it('restores right sidebar state when switching between sessions', async () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        const s2 = useSessionStore.getState().createSession({ title: 'Session 2' })

        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: false,
            activeTab: 'terminal',
            openTabs: ['terminal'],
        })
        useSessionStore.getState().setSessionRightSidebar(s2, {
            collapsed: true,
            activeTab: 'review',
            openTabs: ['review'],
        })

        // Switch to s1
        useSessionStore.getState().setCurrentSession(s1)
        useUiStore.getState().restoreForSession(useSessionStore.getState().sessions.find(s => s.id === s1)?.rightSidebar)
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')

        // Switch to s2
        useSessionStore.getState().setCurrentSession(s2)
        useUiStore.getState().restoreForSession(useSessionStore.getState().sessions.find(s => s.id === s2)?.rightSidebar)
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
    })

    it('restores right sidebar width and preserves transition animation when switching sessions with different sidebar widths', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        const s2 = useSessionStore.getState().createSession({ title: 'Session 2' })

        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: false,
            width: 320,
        })
        useSessionStore.getState().setSessionRightSidebar(s2, {
            collapsed: false,
            width: 480,
        })

        mockPathname = `/chat/${s1}`
        const { rerender } = render(<AppShell />)

        const panel = screen.getByTestId('subagent-panel')
        expect(panel).toHaveStyle({ width: '320px' })
        expect(panel.className).toContain('transition-[width,flex]')

        mockPathname = `/chat/${s2}`
        rerender(<AppShell />)

        expect(panel).toHaveStyle({ width: '480px' })
        expect(panel.className).toContain('transition-[width,flex]')
    })

    it('resets right sidebar state cleanly when navigating from a session back to home', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: true,
            maximized: true,
            activeTab: 'terminal',
            openTabs: ['terminal'],
        })

        mockPathname = `/chat/${s1}`
        const { rerender } = render(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightSidebarMaximized).toBe(true)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['terminal'])

        mockPathname = '/'
        rerender(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightSidebarMaximized).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBeNull()
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual([])
    })

    it('resets right sidebar state cleanly when navigating to a session without saved rightSidebar state', () => {
        const s1 = useSessionStore.getState().createSession({ title: 'Session 1' })
        const s2 = useSessionStore.getState().createSession({ title: 'Session 2' })

        useSessionStore.getState().setSessionRightSidebar(s1, {
            collapsed: true,
            maximized: true,
            activeTab: 'review',
            openTabs: ['review'],
        })

        mockPathname = `/chat/${s1}`
        const { rerender } = render(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightSidebarMaximized).toBe(true)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['review'])

        mockPathname = `/chat/${s2}`
        rerender(<AppShell />)

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
        expect(useUiStore.getState().rightSidebarMaximized).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBeNull()
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual([])
    })

    it('triggers new-chat shortcut to create a bound new chat when project and branch are active', () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'proj-shell',
                    name: 'Shell Proj',
                    path: '/path/shell',
                    pinned: false,
                    createdAt: 1000,
                    updatedAt: 1000,
                },
            ],
        })
        const s1 = useSessionStore.getState().createSession({
            title: 'Active Session',
            projectId: 'proj-shell',
            branch: 'feat/shortcut',
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

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
            projectId: 'proj-shell',
            branch: 'feat/shortcut',
        })
        expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    })

    it('triggers new-chat shortcut to create an unbound new chat when no project is active', () => {
        const s1 = useSessionStore.getState().createSession({
            title: 'Unbound Session',
            projectId: undefined,
            branch: undefined,
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

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
            projectId: null,
            branch: null,
        })
        expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    })

    it('triggers next-chat and previous-chat shortcuts to switch between sessions', () => {
        const s1 = useSessionStore.getState().createSession({
            title: 'Chat 1',
            projectId: undefined,
            branch: undefined,
        })
        const s2 = useSessionStore.getState().createSession({
            title: 'Chat 2',
            projectId: undefined,
            branch: undefined,
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

        // Trigger next-chat with Shift+Meta+]
        const nextEvent = new KeyboardEvent('keydown', {
            key: ']',
            code: 'BracketRight',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        })
        window.dispatchEvent(nextEvent)

        expect(nextEvent.defaultPrevented).toBe(true)
        expect(navigateMock).toHaveBeenCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId: s2 },
        })

        // Trigger previous-chat with Shift+Meta+[
        const prevEvent = new KeyboardEvent('keydown', {
            key: '[',
            code: 'BracketLeft',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        })
        window.dispatchEvent(prevEvent)

        expect(prevEvent.defaultPrevented).toBe(true)
        expect(navigateMock).toHaveBeenCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId: s1 },
        })
    })

    it('triggers toggle-bottom-panel shortcut (Meta+J) to toggle bottomPanelVisible', () => {
        useUiStore.setState({ bottomPanelVisible: false })
        render(<AppShell />)

        const event = new KeyboardEvent('keydown', {
            key: 'j',
            code: 'KeyJ',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(useUiStore.getState().bottomPanelVisible).toBe(true)

        const event2 = new KeyboardEvent('keydown', {
            key: 'j',
            code: 'KeyJ',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event2)
        })

        expect(event2.defaultPrevented).toBe(true)
        expect(useUiStore.getState().bottomPanelVisible).toBe(false)
    })

    it('triggers archive-chat shortcut (Shift+Meta+A) to archive active session', () => {
        const s1 = useSessionStore.getState().createSession({
            title: 'Chat to Archive',
            projectId: undefined,
            branch: undefined,
        })
        mockPathname = `/chat/${s1}`
        render(<AppShell />)

        const event = new KeyboardEvent('keydown', {
            key: 'a',
            code: 'KeyA',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(
            useSessionStore.getState().sessions.find((s) => s.id === s1)?.archivedAt
        ).toBeDefined()
        expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    })

    it('triggers toggle-sidebar shortcut (Meta+B) to toggle sidebarCollapsed', () => {
        useUiStore.setState({ sidebarCollapsed: false })
        render(<AppShell />)

        const event = new KeyboardEvent('keydown', {
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(useUiStore.getState().sidebarCollapsed).toBe(true)

        const event2 = new KeyboardEvent('keydown', {
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event2)
        })

        expect(event2.defaultPrevented).toBe(true)
        expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    })

    it('triggers settings shortcut (Meta+,) to toggle settingsOpen', () => {
        useUiStore.setState({ settingsOpen: false })
        render(<AppShell />)

        const event = new KeyboardEvent('keydown', {
            key: ',',
            code: 'Comma',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(useUiStore.getState().settingsOpen).toBe(true)

        const event2 = new KeyboardEvent('keydown', {
            key: ',',
            code: 'Comma',
            metaKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event2)
        })

        expect(event2.defaultPrevented).toBe(true)
        expect(useUiStore.getState().settingsOpen).toBe(false)
    })

    it('hides the composer and quick model picker while settings is open without losing their state', () => {
        render(<AppShell />)

        const input = screen.getByTestId('composer-input')
        const modelShortcut = new KeyboardEvent('keydown', {
            key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
        })
        act(() => window.dispatchEvent(modelShortcut))

        const picker = document.getElementById('composer-quick-model-picker')
        expect(modelShortcut.defaultPrevented).toBe(true)
        expect(picker).toBeVisible()

        const settingsShortcut = () => new KeyboardEvent('keydown', {
            key: ',', code: 'Comma', metaKey: true, bubbles: true, cancelable: true,
        })
        act(() => window.dispatchEvent(settingsShortcut()))

        expect(screen.getByRole('dialog', { name: /设置|settings/i })).toBeVisible()
        expect(input).not.toBeVisible()
        expect(picker).not.toBeVisible()
        expect(input.closest('[inert]')).toHaveAttribute('aria-hidden', 'true')
        fireEvent.pointerDown(screen.getByRole('dialog', { name: /设置|settings/i }))

        act(() => window.dispatchEvent(settingsShortcut()))

        expect(screen.queryByRole('dialog', { name: /设置|settings/i })).not.toBeInTheDocument()
        expect(input).toBeVisible()
        expect(picker).toBeVisible()
    })

    it('hides a portaled composer model menu until settings closes', () => {
        useModelCatalogStore.setState({
            models: [{
                id: 'model-shell', label: 'Shell Model', supportsFast: false,
                reasoningLevels: [], input: ['text'], contextWindow: 128000, maxTokens: 4096,
            }],
            status: 'ready',
            error: null,
        })
        render(<AppShell />)

        const modelButton = screen.getByRole('button', { name: /模型|Model/ })
        act(() => modelButton.click())
        expect(document.querySelector('[data-model-menu-portal]')).toBeInTheDocument()

        act(() => useUiStore.getState().setSettingsOpen(true))
        expect(document.querySelector('[data-model-menu-portal]')).not.toBeInTheDocument()

        act(() => useUiStore.getState().setSettingsOpen(false))
        expect(document.querySelector('[data-model-menu-portal]')).toBeInTheDocument()
    })

    it('triggers cycle-reasoning-effort shortcut (Shift+Tab) to cycle reasoning level', () => {
        useModelCatalogStore.setState({
            models: [
                {
                    id: 'model-shell-cycle',
                    label: 'Shell Model',
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
                modelId: 'model-shell-cycle',
                reasoningLevel: 'low',
            },
        })
        render(<AppShell />)

        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            code: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(event)
        })

        expect(event.defaultPrevented).toBe(true)
        expect(useSettingsStore.getState().settings.reasoningLevel).toBe('high')
    })

    it('triggers next-model (Ctrl+P) and previous-model (Ctrl+Shift+P) shortcuts', () => {
        useModelCatalogStore.setState({
            models: [
                {
                    id: 'model-shell-1',
                    label: 'Shell Model 1',
                    supportsFast: false,
                    reasoningLevels: [],
                    input: ['text'],
                    contextWindow: 128000,
                    maxTokens: 4096,
                },
                {
                    id: 'model-shell-2',
                    label: 'Shell Model 2',
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
                modelId: 'model-shell-1',
            },
        })
        render(<AppShell />)

        const eventNext = new KeyboardEvent('keydown', {
            key: 'p',
            code: 'KeyP',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(eventNext)
        })

        expect(eventNext.defaultPrevented).toBe(true)
        expect(useSettingsStore.getState().settings.modelId).toBe('model-shell-2')

        const eventPrev = new KeyboardEvent('keydown', {
            key: 'p',
            code: 'KeyP',
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        })
        act(() => {
            window.dispatchEvent(eventPrev)
        })

        expect(eventPrev.defaultPrevented).toBe(true)
        expect(useSettingsStore.getState().settings.modelId).toBe('model-shell-1')
    })

    it('hides subagent right panel when on /scheduled route with rightPanelMode: hidden', () => {
        mockPathname = '/scheduled'
        useSessionStore.setState({ sessions: [], currentSessionId: null })

        render(<AppShell />)

        expect(screen.queryByTestId('subagent-panel')).not.toBeInTheDocument()
    })

    it('hides composer container when view layout specifies showComposer: false', () => {
        mockPathname = '/scheduled'
        render(<AppShell />)

        expect(screen.queryByTestId('composer-input')).not.toBeInTheDocument()
    })

    it('hides window toolbar when view layout specifies reserveWindowToolbar: false', () => {
        mockPathname = '/scheduled'
        render(<AppShell />)

        expect(screen.queryByTestId('window-toolbar')).not.toBeInTheDocument()
    })
})


