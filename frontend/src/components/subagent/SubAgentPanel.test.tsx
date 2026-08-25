import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { rendererRegistry, RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { useTerminalStore } from '../../../../plugins/bundled/cpa.core.terminal/renderer/stores/terminalStore'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useCompactionOverlayStore } from '@/stores/compactionOverlayStore'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { createHostServices } from '@/application/services/createHostServices'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import { SubAgentPanel } from './SubAgentPanel'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
    useRouterState: () => null,
}))

const mockTerminalView = vi.fn(({ tabId }: { tabId: string }) => (
    <div data-testid={`terminal-view-${tabId}`} />
))

vi.mock('../../../../plugins/bundled/cpa.core.terminal/renderer/components/TerminalView', () => ({
    TerminalView: (props: any) => mockTerminalView(props),
}))

const agent = {
    id: 'ag-1',
    name: 'Kierkegaard',
    color: '#9b7dff',
    icon: 'sparkle' as const,
    parentSessionId: 'sess-1',
    sessionId: 'ag-1',
    modelId: 'test-model-pro',
    reasoningEffort: 'medium',
    status: 'running' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
}

beforeEach(async () => {
    await i18n.changeLanguage('en')
    useModelCatalogStore.setState({
        models: [
            {
                id: 'test-model-pro',
                label: 'Test Model Pro',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128_000,
                maxTokens: 16_384,
            },
        ],
    })
    mockTerminalView.mockImplementation(({ tabId }: { tabId: string }) => (
        <div data-testid={`terminal-view-${tabId}`} />
    ))
    await rendererPluginRuntime.activatePlugin('cpa.core.subagent')
    await rendererPluginRuntime.activatePlugin('cpa.core.terminal')
    await rendererPluginRuntime.activatePlugin('cpa.core.review')
    await rendererPluginRuntime.activatePlugin('cpa.core.file-manager')

    useUiStore.setState({
        rightSidebarWidth: null,
        rightSidebarCollapsed: false,
        rightSidebarMaximized: false,
        rightPanelOpenTabs: [],
        rightPanelActiveTab: null,
        rightPanelTabParams: {},
    })
    useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, showBottomPanel: true, terminalPosition: 'bottom' },
    })
    useTerminalStore.setState({
        tabs: [],
        activeTabId: null,
    })
    useSubAgentStore.setState({
        agents: [agent],
        openTabIdsByParent: {},
        focusedIdByParent: {},
    })
    useMessageStore.setState({ entriesBySession: {} })
    useCompactionOverlayStore.setState({ bySession: {} })

    createHostServices()
})

afterEach(async () => {
    setDefaultHostServices(null)
    await rendererPluginRuntime.reset()
    rendererRegistry.clear()
})

describe('SubAgentPanel', () => {
    it('renders selection window when the session has no sub-agents and no active tabs', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({ pendingSessionContext: { projectId: 'p-1', branch: null } })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-review')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-terminal')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-file-manager')).toBeInTheDocument()
    })

    it('hides file-manager and review options in selection window when no project is selected', () => {
        useProjectStore.setState({ projects: [] })
        useUiStore.setState({ pendingSessionContext: { projectId: null, branch: null } })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(screen.queryByTestId('right-sidebar-option-review')).not.toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-terminal')).toBeInTheDocument()
        expect(screen.queryByTestId('right-sidebar-option-file-manager')).not.toBeInTheDocument()
    })

    it('renders the list for the current parent session', () => {
        render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
        expect(screen.getByTestId('subagent-model-meta')).toHaveTextContent(
            'Test Model Pro · Medium'
        )
        expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()
        expect(screen.getByTestId('subagent-panel')).toHaveStyle({ width: '280px' })
    })

    it('uses the wider default when a conversation is open', () => {
        useSubAgentStore.setState({
            focusedIdByParent: { 'sess-1': 'ag-1' },
            openTabIdsByParent: { 'sess-1': ['ag-1'] },
        })
        render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getByTestId('subagent-panel')).toHaveStyle({ width: '420px' })
        expect(screen.getByTestId('context-usage-ring')).toBeInTheDocument()
    })

    it('isolates subagent tabs and content when switching sessionId props', () => {
        const agent2 = {
            id: 'ag-2',
            name: 'Nietzsche',
            color: '#ff7d9b',
            icon: 'sparkle' as const,
            parentSessionId: 'sess-2',
            sessionId: 'ag-2',
            modelId: 'cpa-mock-pro',
            reasoningEffort: 'medium',
            status: 'running' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        }
        useSubAgentStore.setState({
            agents: [agent, agent2],
            openTabIdsByParent: {
                'sess-1': ['ag-1'],
                'sess-2': ['ag-2'],
            },
            focusedIdByParent: {
                'sess-1': 'ag-1',
                'sess-2': 'ag-2',
            },
        })

        const { rerender } = render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getAllByText('Kierkegaard').length).toBeGreaterThan(0)
        expect(screen.queryByText('Nietzsche')).not.toBeInTheDocument()

        rerender(<SubAgentPanel sessionId="sess-2" />)
        expect(screen.getAllByText('Nietzsche').length).toBeGreaterThan(0)
        expect(screen.queryByText('Kierkegaard')).not.toBeInTheDocument()
    })
})

describe('SubAgentPanel collapse animation', () => {
    it('starts at zero width when the right sidebar is already collapsed', () => {
        useUiStore.setState({ rightSidebarCollapsed: true })
        render(<SubAgentPanel sessionId="sess-1" />)
        const panel = screen.getByTestId('subagent-panel')
        expect(panel).toHaveStyle({ width: '0px' })
        expect(panel).toHaveAttribute('data-state', 'closed')
    })

    it('animates width back when the right sidebar is expanded', async () => {
        useUiStore.setState({ rightSidebarCollapsed: true })
        render(<SubAgentPanel sessionId="sess-1" />)
        const panel = screen.getByTestId('subagent-panel')

        useUiStore.setState({ rightSidebarCollapsed: false })
        await waitFor(() => {
            expect(panel).toHaveStyle({ width: '280px' })
        })
        expect(panel).toHaveAttribute('data-state', 'open')
    })
})

describe('SubAgentPanel resize handle', () => {
    it('applies transition class when not dragging and disables transition during drag', () => {
        render(<SubAgentPanel sessionId="sess-1" />)
        const panel = screen.getByTestId('subagent-panel')
        expect(panel.className).toContain('transition-[width,flex]')

        const handle = screen.getByRole('separator', { name: 'Resize right sidebar' })
        const viewportWidth = window.innerWidth

        fireEvent.pointerDown(handle, { clientX: viewportWidth - 280, button: 0 })
        expect(panel.className).not.toContain('transition-[width,flex]')

        fireEvent.pointerMove(window, { clientX: viewportWidth - 360 })
        expect(panel.className).not.toContain('transition-[width,flex]')

        fireEvent.pointerUp(window)
        expect(panel.className).toContain('transition-[width,flex]')
    })

    it('drags the left divider to change panel width', () => {
        render(<SubAgentPanel sessionId="sess-1" />)
        const handle = screen.getByRole('separator', { name: 'Resize right sidebar' })
        const viewportWidth = window.innerWidth

        fireEvent.pointerDown(handle, { clientX: viewportWidth - 280, button: 0 })
        fireEvent.pointerMove(window, { clientX: viewportWidth - 360 })
        fireEvent.pointerUp(window)

        expect(useUiStore.getState().rightSidebarWidth).toBe(360)
        expect(handle.closest('aside')).toHaveStyle({ width: '360px' })
    })

    it('clamps dragged width to the allowed range', () => {
        render(<SubAgentPanel sessionId="sess-1" />)
        const handle = screen.getByRole('separator', { name: 'Resize right sidebar' })
        const viewportWidth = window.innerWidth

        fireEvent.pointerDown(handle, { clientX: viewportWidth - 280, button: 0 })
        fireEvent.pointerMove(window, { clientX: viewportWidth - 80 })
        fireEvent.pointerUp(window)
        expect(useUiStore.getState().rightSidebarWidth).toBe(240)

        fireEvent.pointerDown(handle, { clientX: viewportWidth - 240, button: 0 })
        fireEvent.pointerMove(window, { clientX: viewportWidth - 800 })
        fireEvent.pointerUp(window)
        expect(useUiStore.getState().rightSidebarWidth).toBe(640)
    })
})

describe('SubAgentPanel conversation display', () => {
    it('uses the same compact turn grouping as the main agent', () => {
        useSubAgentStore.setState({
            agents: [{ ...agent, status: 'completed' }],
            focusedIdByParent: { 'sess-1': 'ag-1' },
            openTabIdsByParent: { 'sess-1': ['ag-1'] },
        })
        useMessageStore.getState().replaceSessionEntries('ag-1', [
            userEntry('u1', 10, 'hello'),
            assistantEntry('a1', 20, 30, 'first'),
            assistantEntry('a2', 40, 70_000, 'final'),
        ])

        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('subagent-message-list')).toBeInTheDocument()
        expect(screen.getByTestId('subagent-model-meta')).toHaveTextContent(
            'Test Model Pro · Medium'
        )
        expect(screen.getAllByTestId('turn-header')).toHaveLength(1)
        expect(screen.getByTestId('turn-header')).toHaveTextContent('Completed 1m 9s')
        expect(screen.getByText('final')).toBeInTheDocument()
        expect(screen.queryByText('first')).not.toBeInTheDocument()
    })

    it('shows the processed timer while the sub-agent is still running', () => {
        useSubAgentStore.setState({
            agents: [{ ...agent, status: 'running' }],
            focusedIdByParent: { 'sess-1': 'ag-1' },
            openTabIdsByParent: { 'sess-1': ['ag-1'] },
        })
        useMessageStore.getState().replaceSessionEntries('ag-1', [
            userEntry('u1', Date.now(), 'hello'),
        ])

        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('turn-header')).toHaveTextContent('Processed 0s')
    })

    it('shows the compacting divider while the sub-agent is summarizing', () => {
        useSubAgentStore.setState({
            agents: [{ ...agent, status: 'running' }],
            focusedIdByParent: { 'sess-1': 'ag-1' },
            openTabIdsByParent: { 'sess-1': ['ag-1'] },
        })
        useMessageStore.getState().replaceSessionEntries('ag-1', [
            userEntry('u1', Date.now(), 'hello'),
        ])
        useCompactionOverlayStore.getState().setCompacting('ag-1', true)

        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('turn-header')).toHaveTextContent('Processed 0s')
        expect(
            screen.getByRole('status', { name: /Compacting context/i })
        ).toBeInTheDocument()
    })

    it('renders custom extension content when registered in layout.right_panel.content slot', () => {
        rendererRegistry.registerSlot('layout.right_panel.content', {
            id: 'custom-subagent',
            pluginId: 'custom.plugin',
            order: 100,
            component: ({ sessionId }: { sessionId?: string }) => (
                <div data-testid="custom-right-panel-content">
                    Custom Panel {sessionId}
                </div>
            ),
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('custom-right-panel-content')).toBeInTheDocument()
        expect(screen.getByText('Custom Panel sess-1')).toBeInTheDocument()
    })

    it('coexists with custom slot contributions in layout.right_panel.content', () => {
        rendererRegistry.registerSlot('layout.right_panel.content', {
            id: 'custom-subagent-widget',
            pluginId: 'custom.plugin',
            order: 20,
            component: () => (
                <div data-testid="custom-subagent-widget">
                    Custom SubAgent Widget
                </div>
            ),
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
        expect(screen.getByTestId('custom-subagent-widget')).toBeInTheDocument()
    })
})

describe('SubAgentPanel selection window and tabs', () => {
    it('opens right terminal when clicking terminal option from selection view', () => {
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        fireEvent.click(screen.getByTestId('right-sidebar-option-terminal'))

        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0].location).toBe('right')
        expect(screen.getByText('Terminal')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-new-tab')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-view-' + useTerminalStore.getState().tabs[0].id)).toBeInTheDocument()
    })

    it('opens review and file-manager tabs dynamically from selection view and closes them', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({ pendingSessionContext: { projectId: 'p-1', branch: null } })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)

        // Open review
        fireEvent.click(screen.getByTestId('right-sidebar-option-review'))
        expect(screen.getByTestId('right-sidebar-review-view')).toBeInTheDocument()
        expect(screen.getByTestId('review-tab-close')).toBeInTheDocument()

        // Close review -> returns to selection view
        fireEvent.click(screen.getByTestId('review-tab-close'))
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()

        // Open file-manager
        fireEvent.click(screen.getByTestId('right-sidebar-option-file-manager'))
        expect(screen.getByTestId('right-sidebar-files-view')).toBeInTheDocument()
        expect(screen.getByTestId('file-manager-tab-close')).toBeInTheDocument()

        // Close file-manager -> returns to selection view
        fireEvent.click(screen.getByTestId('file-manager-tab-close'))
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
    })

    it('clicking new tab (+) button displays selection view and creates terminal only upon user choice', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({ pendingSessionContext: { projectId: 'p-1', branch: null } })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)

        // Open review first
        fireEvent.click(screen.getByTestId('right-sidebar-option-review'))
        expect(screen.getByTestId('right-sidebar-review-view')).toBeInTheDocument()
        expect(screen.getByTestId('terminal-new-tab')).toBeInTheDocument()

        // Click (+) button
        fireEvent.click(screen.getByTestId('terminal-new-tab'))

        // Selection view is displayed, and no terminal tab created yet
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(useTerminalStore.getState().tabs).toHaveLength(0)

        // User selects terminal
        fireEvent.click(screen.getByTestId('right-sidebar-option-terminal'))

        // Now terminal tab is created and active
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(screen.getByTestId('terminal-view-' + useTerminalStore.getState().tabs[0].id)).toBeInTheDocument()
    })

    it('maintains separate terminal tabs for right sidebar and bottom panel simultaneously', () => {
        // Create an existing bottom tab
        useTerminalStore.getState().addTab({
            title: 'Bottom Terminal',
            cwd: '/bottom',
            location: 'bottom',
        })

        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })
        render(<SubAgentPanel sessionId="sess-1" />)

        // Right sidebar starts with selection view because the existing tab belongs to bottom
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()

        // Open terminal in right sidebar
        fireEvent.click(screen.getByTestId('right-sidebar-option-terminal'))

        const allTabs = useTerminalStore.getState().tabs
        expect(allTabs).toHaveLength(2)
        expect(allTabs[0].location).toBe('bottom')
        expect(allTabs[1].location).toBe('right')

        // Right sidebar renders its own right-tab view only
        expect(screen.getByTestId('terminal-view-' + allTabs[1].id)).toBeInTheDocument()
        expect(screen.queryByTestId('terminal-view-' + allTabs[0].id)).not.toBeInTheDocument()
    })

    it('applies maximized styles and hides resize handle when rightSidebarMaximized is true', () => {
        useUiStore.setState({ rightSidebarCollapsed: false, rightSidebarMaximized: true })
        render(<SubAgentPanel sessionId="sess-1" />)

        const panel = screen.getByTestId('subagent-panel')
        expect(panel).toHaveAttribute('data-maximized', 'true')
        expect(screen.queryByLabelText(/resize right sidebar/i)).not.toBeInTheDocument()
    })

    it('renders sidebar toggle when rightSidebarMaximized and left sidebar is collapsed', () => {
        useUiStore.setState({ rightSidebarCollapsed: false, rightSidebarMaximized: true, sidebarCollapsed: true })
        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
    })

    it('does not render sidebar toggle in panel when left sidebar is open', () => {
        useUiStore.setState({ rightSidebarCollapsed: false, rightSidebarMaximized: true, sidebarCollapsed: false })
        render(<SubAgentPanel sessionId="sess-1" />)

        expect(screen.queryByRole('button', { name: /expand sidebar/i })).not.toBeInTheDocument()
    })

    it('responds to global keyboard shortcuts for registered tabs', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: 'p-1', branch: null },
            rightSidebarCollapsed: false,
        })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        // Trigger review shortcut: Ctrl+Shift+G
        fireEvent.keyDown(window, {
            key: 'G',
            ctrlKey: true,
            shiftKey: true,
        })
        expect(screen.getByTestId('right-sidebar-review-view')).toBeInTheDocument()

        // Trigger file-manager shortcut: Cmd+P
        fireEvent.keyDown(window, {
            key: 'p',
            metaKey: true,
        })
        expect(screen.getByTestId('right-sidebar-files-view')).toBeInTheDocument()
    })

    it('ignores shortcuts when user is typing in input or textarea elements', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: 'p-1', branch: null },
            rightSidebarCollapsed: false,
            rightPanelOpenTabs: [],
            rightPanelActiveTab: null,
        })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        render(
            <div>
                <input data-testid="test-input" />
                <SubAgentPanel sessionId="sess-1" />
            </div>
        )

        const input = screen.getByTestId('test-input')
        fireEvent.keyDown(input, {
            key: 'G',
            ctrlKey: true,
            shiftKey: true,
        })

        expect(screen.queryByTestId('right-sidebar-review-view')).not.toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
    })

    it('triggers terminal tab shortcut to bootstrap right terminal session and open panel tab', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: 'p-1', branch: null },
            rightSidebarCollapsed: true,
            rightPanelOpenTabs: [],
            rightPanelActiveTab: null,
        })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        fireEvent.keyDown(window, {
            key: '`',
            ctrlKey: true,
        })

        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0].location).toBe('right')
    })

    it('switches to remaining open tab when closing the last terminal tab instead of forcing null', () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: 'p-1', branch: null },
            rightPanelOpenTabs: ['review', 'terminal'],
            rightPanelActiveTab: 'terminal',
        })
        useTerminalStore.setState({
            tabs: [
                {
                    id: 'term-1',
                    title: 'Terminal 1',
                    cwd: '/test',
                    location: 'right',
                },
            ],
            activeTabId: 'term-1',
            activeTabIdByLocation: { right: 'term-1', bottom: null },
        })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        const closeBtn = screen.getByTestId('terminal-tab-close-term-1')
        fireEvent.click(closeBtn)

        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        expect(useUiStore.getState().rightPanelOpenTabs).toEqual(['review'])
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        expect(screen.getByTestId('right-sidebar-review-view')).toBeInTheDocument()
    })

    it('listens to EventBus right-panel:open-tab and right-panel:close-tab events', async () => {
        useProjectStore.setState({
            projects: [{ id: 'p-1', name: 'TestProj', path: '/test', pinned: false, createdAt: 1, updatedAt: 1 }],
        })
        useUiStore.setState({
            pendingSessionContext: { projectId: 'p-1', branch: null },
            rightSidebarCollapsed: true,
            rightPanelOpenTabs: [],
            rightPanelActiveTab: null,
        })
        useSubAgentStore.setState({
            agents: [],
            openTabIdsByParent: {},
            focusedIdByParent: {},
        })

        render(<SubAgentPanel sessionId="sess-1" />)

        // Test open review via EventBus
        act(() => {
            rendererPluginRuntime.eventBus.emit('right-panel:open-tab', { tabId: 'review' })
        })
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
        expect(await screen.findByTestId('right-sidebar-review-view')).toBeInTheDocument()

        // Test open terminal via EventBus
        act(() => {
            rendererPluginRuntime.eventBus.emit('right-panel:open-tab', { tabId: 'terminal' })
        })
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0].location).toBe('right')

        // Test close tab via EventBus
        act(() => {
            rendererPluginRuntime.eventBus.emit('right-panel:close-tab', { tabId: 'terminal' })
        })
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
    })

    it('isolates crashing panel tab component with SlotErrorBoundary fallback', () => {
        const customRegistry = new RendererRegistry()
        const CrashingTab = () => {
            throw new Error('Panel tab boom')
        }
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        customRegistry.registerPanelTab({
            id: 'broken-tab',
            pluginId: 'broken.plugin',
            title: 'Broken Tab',
            icon: () => null,
            component: CrashingTab,
        })

        useUiStore.setState({
            rightPanelOpenTabs: ['broken-tab'],
            rightPanelActiveTab: 'broken-tab',
        })

        render(<SubAgentPanel sessionId="sess-1" registry={customRegistry} />)

        expect(screen.getByTestId('slot-error-broken-tab')).toBeInTheDocument()
        expect(screen.getByText('Plugin error (broken-tab)')).toBeInTheDocument()
        consoleSpy.mockRestore()
    })

    it('isolates crashing terminal content with SlotErrorBoundary fallback', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        mockTerminalView.mockImplementation(() => {
            throw new Error('Terminal exploded')
        })

        useTerminalStore.setState({
            tabs: [
                {
                    id: 'term-broken',
                    title: 'Crashing Terminal',
                    cwd: '/test',
                    location: 'right',
                },
            ],
            activeTabId: 'term-broken',
            activeTabIdByLocation: { right: 'term-broken', bottom: null },
        })
        useUiStore.setState({
            rightPanelOpenTabs: ['terminal'],
            rightPanelActiveTab: 'terminal',
        })

        render(<SubAgentPanel sessionId="sess-1" />)
        expect(screen.getByTestId('slot-error-terminal')).toBeInTheDocument()
        expect(screen.getByText('Plugin error (terminal)')).toBeInTheDocument()
        expect(screen.getByTestId('subagent-panel')).toBeInTheDocument()
        consoleSpy.mockRestore()
    })
})

describe('SubAgentPanel mobile browser behavior', () => {
    const originalUserAgent = navigator.userAgent
    const originalMaxTouchPoints = navigator.maxTouchPoints
    const originalInnerWidth = window.innerWidth

    beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
            configurable: true,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
            value: 5,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: 390,
            configurable: true,
        })
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
            value: originalMaxTouchPoints,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: originalInnerWidth,
            configurable: true,
        })
    })

    it('renders hidden aside when rightSidebarCollapsed is true on mobile', () => {
        useUiStore.setState({ rightSidebarCollapsed: true })
        const { container } = render(<SubAgentPanel sessionId="sess-1" />)
        const aside = container.querySelector('aside')
        expect(aside).toHaveAttribute('data-state', 'closed')
        expect(aside).toHaveAttribute('aria-hidden', 'true')
        expect(aside).toHaveClass('hidden')
    })

    it('renders full-screen right sidebar when rightSidebarCollapsed is false on mobile without resize handle', () => {
        useUiStore.setState({ rightSidebarCollapsed: false })
        const { container } = render(<SubAgentPanel sessionId="sess-1" />)
        const aside = container.querySelector('aside')
        expect(aside).toHaveAttribute('data-state', 'open')
        expect(aside).toHaveAttribute('data-mobile', 'true')
        expect(aside).toHaveClass('fixed', 'inset-0', 'z-50', 'w-full', 'h-full')
        expect(screen.queryByRole('separator', { name: 'Resize right sidebar' })).toBeNull()
        expect(screen.getByRole('button', { name: /collapse sidebar|expand sidebar/i })).toBeInTheDocument()
        expect(screen.getByTestId('bottom-panel-toggle')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-toggle')).toBeInTheDocument()
    })

    it('collapses mobile right sidebar when clicking right-sidebar-toggle button', () => {
        useUiStore.setState({ rightSidebarCollapsed: false })
        render(<SubAgentPanel sessionId="sess-1" />)

        fireEvent.click(screen.getByTestId('right-sidebar-toggle'))
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
    })

    it('collapses mobile right sidebar on Escape key press', () => {
        useUiStore.setState({ rightSidebarCollapsed: false })
        render(<SubAgentPanel sessionId="sess-1" />)

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
    })
})


function userEntry(
    id: string,
    createdAt: number,
    text: string
): ConversationEntry {
    return {
        kind: 'user',
        id,
        sessionId: 'ag-1',
        version: 1,
        createdAt,
        content: [{ type: 'text', text }],
    }
}

function assistantEntry(
    id: string,
    createdAt: number,
    completedAt: number,
    text: string
): ConversationEntry {
    return {
        kind: 'assistant',
        id,
        sessionId: 'ag-1',
        version: 1,
        createdAt,
        completedAt,
        status: 'done',
        stopReason: 'stop',
        content: [{ type: 'text', text }],
    }
}
