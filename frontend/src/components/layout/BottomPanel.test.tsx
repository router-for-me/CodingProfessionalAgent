import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@/i18n'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'
import { BottomPanel } from './BottomPanel'

describe('BottomPanel', () => {
    beforeEach(() => {
        useUiStore.setState({
            bottomPanelVisible: false,
            bottomPanelHeight: 220,
            pendingSessionContext: { projectId: null, branch: null },
        })
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, showBottomPanel: true, terminalPosition: 'bottom' },
        })
    })

    afterEach(() => {
        rendererRegistry.clear()
    })

    it('stays closed until the panel is shown', () => {
        render(<BottomPanel />)
        expect(screen.queryByTestId('bottom-panel')).not.toBeInTheDocument()
    })

    it('renders slot contributions when visible', async () => {
        rendererRegistry.registerSlot('layout.bottom_panel.tabs', {
            id: 'mock-tabs',
            pluginId: 'test.plugin',
            order: 10,
            component: () => <div data-testid="mock-tabs">Mock Tabs</div>,
        })
        rendererRegistry.registerSlot('layout.bottom_panel.content', {
            id: 'mock-content',
            pluginId: 'test.plugin',
            order: 10,
            component: () => <div data-testid="mock-content">Mock Content</div>,
        })

        useUiStore.setState({ bottomPanelVisible: true })
        render(<BottomPanel />)

        expect(await screen.findByTestId('bottom-panel')).toBeInTheDocument()
        expect(screen.getByTestId('mock-tabs')).toBeInTheDocument()
        expect(screen.getByTestId('mock-content')).toBeInTheDocument()
    })

    it('returns null and renders nothing when showBottomPanel is false in settings', () => {
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, showBottomPanel: false, terminalPosition: 'bottom' },
        })
        const { container } = render(<BottomPanel />)
        expect(container.firstChild).toBeNull()
    })

    it('returns null and renders nothing when terminalPosition is right', () => {
        useSettingsStore.setState({
            settings: { ...DEFAULT_SETTINGS, showBottomPanel: true, terminalPosition: 'right' },
        })
        const { container } = render(<BottomPanel />)
        expect(container.firstChild).toBeNull()
    })
})
