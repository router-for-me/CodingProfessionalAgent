import { describe, expect, it, vi } from 'vitest'
import { SquarePlus } from '@cpa/plugin-ui'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ChatRendererContribution,
    PanelContribution,
} from '@cpa/plugin-api'
import { reviewRendererEntry, ReviewPanelContent } from './index.js'
import manifest from '../manifest.json'

describe('reviewRendererEntry', () => {
    it('defines a valid renderer entry for cpa.core.review', () => {
        expect(reviewRendererEntry.runtime).toBe('renderer')
        expect(typeof reviewRendererEntry.activate).toBe('function')
    })

    it('registers panel, actions, and chat renderer on activation', async () => {
        const mockUiService = {
            openRightPanelTab: vi.fn(),
            toggleRightSidebarCollapsed: vi.fn(),
        }

        const harness = createPluginTestHarness(reviewRendererEntry, {
            manifest: manifest as any,
            services: {
                ui: mockUiService,
                sessions: { getSnapshot: () => [{ id: 's1', projectId: 'p1' }] },
                projects: { getSnapshot: () => [{ id: 'p1', name: 'Project 1' }] },
            } as any,
        })

        await harness.activate()

        const panels = harness.getRegistered<PanelContribution>('panel')
        expect(panels).toHaveLength(1)
        const tab = panels[0].value
        expect(tab.id).toBe('review')
        expect(tab.pluginId).toBe('cpa.core.review')
        expect(tab.titleKey).toBe('rightSidebar.tabs.review')
        expect(tab.icon).toBe(SquarePlus)
        expect(tab.order).toBe(30)
        expect(tab.component).toBe(ReviewPanelContent)
        expect(tab.instancePolicy).toBe('single')

        // Selection card
        expect(tab.selectionCard).toEqual({
            labelKey: 'rightSidebar.selection.review',
            icon: SquarePlus,
            shortcutMac: '^⇧G',
            shortcutOther: 'Ctrl+Shift+G',
            requiresProject: true,
            order: 10,
        })

        // Shortcut
        expect(tab.shortcut?.mac).toBe('^⇧G')
        expect(tab.shortcut?.other).toBe('Ctrl+Shift+G')
        expect(
            tab.shortcut?.keyEventMatch?.(
                { ctrlKey: true, shiftKey: true, key: 'G' } as KeyboardEvent,
                { hasProject: true } as any,
            ),
        ).toBe(true)
        expect(
            tab.shortcut?.keyEventMatch?.(
                { ctrlKey: true, shiftKey: true, key: 'g' } as KeyboardEvent,
                { hasProject: true } as any,
            ),
        ).toBe(true)
        expect(
            tab.shortcut?.keyEventMatch?.(
                { ctrlKey: true, shiftKey: true, key: 'G' } as KeyboardEvent,
                { hasProject: false } as any,
            ),
        ).toBe(false)
        expect(
            tab.shortcut?.keyEventMatch?.(
                { ctrlKey: false, shiftKey: true, key: 'G' } as KeyboardEvent,
                { hasProject: true } as any,
            ),
        ).toBe(false)

        // isAvailable
        expect(tab.isAvailable?.({ activeSessionId: 's1', services: {
            sessions: { getSnapshot: () => [{ id: 's1', projectId: 'p1' }] },
            projects: { getSnapshot: () => [{ id: 'p1', name: 'Project 1' }] },
        } } as any)).toBe(true)
        expect(tab.isAvailable?.({ activeSessionId: 's-wt', services: {
            sessions: { getSnapshot: () => [{ id: 's-wt', worktreePath: '/tmp/wt' }] },
            projects: { getSnapshot: () => [] },
        } } as any)).toBe(true)
        expect(tab.isAvailable?.({ activeSessionId: 's2', services: {
            sessions: { getSnapshot: () => [] },
            projects: { getSnapshot: () => [] },
        } } as any)).toBe(false)

        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions).toHaveLength(2)
        expect(actions.map((a) => a.id).sort()).toEqual(['open-review-tab', 'toggle-review-panel'])

        // Test action handlers
        const openAction = actions.find((a) => a.id === 'open-review-tab')
        openAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.openRightPanelTab).toHaveBeenCalledWith('review')

        const toggleAction = actions.find((a) => a.id === 'toggle-review-panel')
        toggleAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.toggleRightSidebarCollapsed).toHaveBeenCalled()

        const chatRenderers = harness.getRegistered<ChatRendererContribution>('chat-renderer')
        expect(chatRenderers).toHaveLength(1)
        expect(chatRenderers[0].id).toBe('review-diff-tool-card')
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'review_diff' })).toBe(true)
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'git_diff' })).toBe(true)
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'other_tool' })).toBe(false)
    })
})
