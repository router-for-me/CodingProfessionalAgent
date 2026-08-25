import { describe, expect, it, vi } from 'vitest'
import { Globe } from '@cpa/plugin-ui'
import { browserRendererEntry } from './index.js'

describe('cpa.core.browser renderer entry', () => {
    it('defines renderer runtime entry', () => {
        expect(browserRendererEntry.runtime).toBe('renderer')
        expect(typeof browserRendererEntry.activate).toBe('function')
    })

    it('registers panel tab contribution and actions on activate', () => {
        const registrations: Array<{ kind: string; id: string; value: any }> = []
        const emitFn = vi.fn()
        const mockContext = {
            manifest: { id: 'cpa.core.browser', name: 'Browser Preview', version: '1.0.0' },
            register: vi.fn((item) => {
                registrations.push(item)
                return () => {}
            }),
            events: {
                emit: emitFn,
                on: vi.fn(),
            },
            services: {
                ui: {
                    openRightPanelTab: vi.fn(),
                    toggleRightSidebarCollapsed: vi.fn(),
                },
            },
        }

        browserRendererEntry.activate(mockContext as any)

        // Panel
        const panel = registrations.find((r) => r.id === 'browser' && r.kind === 'panel')
        expect(panel).toBeDefined()
        expect(panel?.value.icon).toBe(Globe)
        expect(panel?.value.titleKey).toBe('rightSidebar.tabs.browser')
        expect(panel?.value.order).toBe(25)
        expect(panel?.value.selectionCard.shortcutMac).toBe('⌘T')

        // Shortcut match
        const match = panel?.value.shortcut.keyEventMatch
        expect(
            match({ metaKey: true, key: 't' } as KeyboardEvent, { hasProject: false }),
        ).toBe(true)
        expect(
            match({ ctrlKey: true, key: 'T' } as KeyboardEvent, { hasProject: true }),
        ).toBe(true)
        expect(
            match({ metaKey: true, shiftKey: true, key: 't' } as KeyboardEvent, { hasProject: false }),
        ).toBe(false)

        // Actions
        const openTabAction = registrations.find((r) => r.id === 'open-browser-tab')
        expect(openTabAction).toBeDefined()
        openTabAction?.value.handler()
        expect(mockContext.services.ui.openRightPanelTab).toHaveBeenCalledWith('browser')

        const togglePanelAction = registrations.find((r) => r.id === 'toggle-browser-panel')
        expect(togglePanelAction).toBeDefined()
        togglePanelAction?.value.handler()
        expect(mockContext.services.ui.toggleRightSidebarCollapsed).toHaveBeenCalled()

        const reloadAction = registrations.find((r) => r.id === 'reload-browser-page')
        expect(reloadAction).toBeDefined()
        reloadAction?.value.handler()
        expect(emitFn).toHaveBeenCalledWith('browser:reload')

        const backAction = registrations.find((r) => r.id === 'browser-back')
        expect(backAction).toBeDefined()
        backAction?.value.handler()
        expect(emitFn).toHaveBeenCalledWith('browser:back')

        const forwardAction = registrations.find((r) => r.id === 'browser-forward')
        expect(forwardAction).toBeDefined()
        forwardAction?.value.handler()
        expect(emitFn).toHaveBeenCalledWith('browser:forward')
    })
})
