import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { Star } from 'lucide-react'
import { rendererRegistry, RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { useTerminalStore } from '../../../../plugins/bundled/cpa.core.terminal/renderer/stores/terminalStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { RightSidebarSelectionView } from './RightSidebarSelectionView'

beforeEach(async () => {
    await i18n.changeLanguage('en')
    await rendererPluginRuntime.activatePlugin('cpa.core.terminal')
    await rendererPluginRuntime.activatePlugin('cpa.core.review')
    await rendererPluginRuntime.activatePlugin('cpa.core.file-manager')

    useProjectStore.setState({
        projects: [
            {
                id: 'p-1',
                name: 'Test Project',
                path: '/test/path',
                pinned: false,
                createdAt: 1,
                updatedAt: 1,
            },
        ],
    })
    useSessionStore.setState({ sessions: [], currentSessionId: null })
    useUiStore.setState({
        pendingSessionContext: { projectId: 'p-1', branch: null },
        rightPanelOpenTabs: [],
        rightPanelActiveTab: null,
        rightSidebarCollapsed: false,
    })
    useTerminalStore.setState({ tabs: [], activeTabId: null })
})

afterEach(async () => {
    await rendererPluginRuntime.reset()
    rendererRegistry.clear()
})

describe('RightSidebarSelectionView', () => {
    it('renders all registered option buttons with labels and shortcuts when project is active', () => {
        render(<RightSidebarSelectionView />)

        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-review')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-terminal')).toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-file-manager')).toBeInTheDocument()

        expect(screen.getByTestId('right-sidebar-option-review')).toHaveTextContent('Review')
        expect(screen.getByTestId('right-sidebar-option-terminal')).toHaveTextContent('Terminal')
        expect(screen.getByTestId('right-sidebar-option-file-manager')).toHaveTextContent('Files')
    })

    it('triggers openRightPanelTab and creates a right terminal tab when clicking terminal option', () => {
        render(<RightSidebarSelectionView />)

        fireEvent.click(screen.getByTestId('right-sidebar-option-terminal'))

        expect(useUiStore.getState().rightPanelOpenTabs).toContain('terminal')
        expect(useUiStore.getState().rightPanelActiveTab).toBe('terminal')
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0].location).toBe('right')
    })

    it('triggers openRightPanelTab when clicking review and file-manager options', () => {
        render(<RightSidebarSelectionView />)

        fireEvent.click(screen.getByTestId('right-sidebar-option-review'))
        expect(useUiStore.getState().rightPanelOpenTabs).toContain('review')
        expect(useUiStore.getState().rightPanelActiveTab).toBe('review')

        fireEvent.click(screen.getByTestId('right-sidebar-option-file-manager'))
        expect(useUiStore.getState().rightPanelOpenTabs).toContain('file-manager')
        expect(useUiStore.getState().rightPanelActiveTab).toBe('file-manager')
    })

    it('hides options requiring project when no project is selected', () => {
        useProjectStore.setState({ projects: [] })
        useUiStore.setState({ pendingSessionContext: { projectId: null, branch: null } })

        render(<RightSidebarSelectionView />)

        expect(screen.getByTestId('right-sidebar-selection-view')).toBeInTheDocument()
        expect(screen.queryByTestId('right-sidebar-option-review')).not.toBeInTheDocument()
        expect(screen.getByTestId('right-sidebar-option-terminal')).toBeInTheDocument()
        expect(screen.queryByTestId('right-sidebar-option-file-manager')).not.toBeInTheDocument()
    })

    it('sorts selection cards by selectionCard.order', () => {
        const customRegistry = new RendererRegistry()
        customRegistry.registerPanelTab({
            id: 'tab-z',
            pluginId: 'test.z',
            title: 'Tab Z',
            icon: Star,
            order: 100,
            component: () => null,
            selectionCard: {
                labelKey: 'Tab Z',
                order: 50,
            },
        })
        customRegistry.registerPanelTab({
            id: 'tab-a',
            pluginId: 'test.a',
            title: 'Tab A',
            icon: Star,
            order: 10,
            component: () => null,
            selectionCard: {
                labelKey: 'Tab A',
                order: 10,
            },
        })

        render(<RightSidebarSelectionView registry={customRegistry} />)

        const buttons = screen.getAllByRole('button')
        expect(buttons[0]).toHaveTextContent('Tab A')
        expect(buttons[1]).toHaveTextContent('Tab Z')
    })

    it('calls onSelectTab callback when option is clicked', () => {
        const onSelectTab = vi.fn()
        render(<RightSidebarSelectionView onSelectTab={onSelectTab} />)

        fireEvent.click(screen.getByTestId('right-sidebar-option-review'))
        expect(onSelectTab).toHaveBeenCalledWith('review')
    })
})
