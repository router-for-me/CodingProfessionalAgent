import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPanelContent } from './TerminalPanelContent.js'
import { useTerminalStore } from '../stores/terminalStore.js'

vi.mock('./TerminalView.js', () => ({
    TerminalView: ({ tabId, active, visible }: { tabId: string; active: boolean; visible: boolean }) => (
        <div
            data-testid={`terminal-view-${tabId}`}
            data-active={String(active)}
            data-visible={String(visible)}
        />
    ),
}))

describe('TerminalPanelContent', () => {
    beforeEach(() => {
        useTerminalStore.setState({
            tabs: [
                { id: 'tab-1', title: 'Bottom Tab 1', cwd: '/workspace', location: 'bottom' },
                { id: 'tab-2', title: 'Right Tab 2', cwd: '/workspace', location: 'right' },
            ],
            activeTabId: 'tab-1',
            activeTabIdByLocation: { bottom: 'tab-1', right: 'tab-2' },
        })
    })

    it('renders bottom location tabs only when location is bottom', () => {
        const { queryByTestId } = render(<TerminalPanelContent location="bottom" visible={true} />)
        expect(queryByTestId('terminal-view-tab-1')).toBeInTheDocument()
        expect(queryByTestId('terminal-view-tab-2')).not.toBeInTheDocument()
    })

    it('renders right location tabs only when location is right', () => {
        const { queryByTestId } = render(<TerminalPanelContent location="right" visible={true} />)
        expect(queryByTestId('terminal-view-tab-2')).toBeInTheDocument()
        expect(queryByTestId('terminal-view-tab-1')).not.toBeInTheDocument()
    })
})
