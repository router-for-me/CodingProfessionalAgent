import { describe, expect, it, vi } from 'vitest'
import { SquareTerminal } from '@cpa/plugin-ui'
import { terminalRendererEntry, useTerminalStore } from './index.js'
import { TerminalPanelContent } from './components/TerminalPanelContent.js'
import { TerminalBottomTabs } from './components/TerminalBottomTabs.js'
import { getTerminalCapabilityClient } from './utils/capability.js'

describe('cpa.core.terminal renderer entry', () => {
    it('defines renderer runtime entry', () => {
        expect(terminalRendererEntry.runtime).toBe('renderer')
        expect(typeof terminalRendererEntry.activate).toBe('function')
    })

    it('registers slot contributions, panel tab, and actions on activate and cleans up on deactivate', () => {
        const registrations: Array<{ kind: string; id: string; target?: string; value: any }> = []
        const capabilityClient = {
            has: vi.fn(() => true),
            invoke: vi.fn(),
            subscribe: vi.fn(() => () => {}),
        }
        const mockContext = {
            manifest: { id: 'cpa.core.terminal', name: 'Terminal', version: '1.0.0' },
            capabilityClient,
            register: vi.fn((item) => {
                registrations.push(item)
                return () => {}
            }),
            services: {
                ui: {
                    toggleBottomPanelVisible: vi.fn(),
                    openRightPanelTab: vi.fn(),
                },
            },
        }

        terminalRendererEntry.activate(mockContext as any)
        expect(getTerminalCapabilityClient()).toBe(capabilityClient)

        // 1. Content slot
        const contentSlot = registrations.find((r) => r.id === 'terminal-content')
        expect(contentSlot).toBeDefined()
        expect(contentSlot?.target).toBe('layout.bottom_panel.content')
        expect(contentSlot?.value.component).toBe(TerminalPanelContent)

        // 2. Tabs slot
        const tabsSlot = registrations.find((r) => r.id === 'terminal-bottom-tabs')
        expect(tabsSlot).toBeDefined()
        expect(tabsSlot?.target).toBe('layout.bottom_panel.tabs')
        expect(tabsSlot?.value.component).toBe(TerminalBottomTabs)

        // 3. Panel
        const panelReg = registrations.find((r) => r.id === 'terminal' && r.kind === 'panel')
        expect(panelReg).toBeDefined()
        expect(panelReg?.value.icon).toBe(SquareTerminal)
        expect(panelReg?.value.titleKey).toBe('rightSidebar.selection.terminal')
        expect(panelReg?.value.shortcut.mac).toBe('^`')

        // 4. Actions
        const toggleAction = registrations.find((r) => r.id === 'toggle-bottom-panel')
        expect(toggleAction).toBeDefined()
        toggleAction?.value.handler()
        expect(mockContext.services.ui.toggleBottomPanelVisible).toHaveBeenCalled()

        const openAction = registrations.find((r) => r.id === 'open-terminal')
        expect(openAction).toBeDefined()
        openAction?.value.handler()
        expect(mockContext.services.ui.openRightPanelTab).toHaveBeenCalledWith('terminal')

        // Test panel onOpen
        useTerminalStore.setState({ tabs: [], activeTabId: null })
        panelReg?.value.onOpen({ services: mockContext.services, activeSessionId: null })
        expect(useTerminalStore.getState().tabs).toHaveLength(1)
        expect(useTerminalStore.getState().tabs[0]?.location).toBe('right')

        // Deactivate cleans up store and capability client
        terminalRendererEntry.deactivate?.({} as any)
        expect(useTerminalStore.getState().tabs).toHaveLength(0)
        expect(getTerminalCapabilityClient()).toBeNull()
    })
})
