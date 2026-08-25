import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import { sessionManagerRendererEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.session-manager renderer entry', () => {
    it('registers settings, slots, composer controls, and actions on activation', async () => {
        const harness = createPluginTestHarness(sessionManagerRendererEntry, {
            manifest,
        })

        await harness.activate()

        const settings = harness.getRegistered('settings')
        expect(settings.map((s) => s.id)).toEqual(['archived'])

        const slots = harness.getRegistered('slot')
        expect(slots.map((s) => s.id).sort()).toEqual([
            'sidebar-nav-top',
            'sidebar-session-list',
            'titlebar-left-sidebar-toggle',
            'titlebar-right-controls',
            'titlebar-session-title',
        ])

        const composer = harness.getRegistered('composer')
        expect(composer.map((c) => c.id).sort()).toEqual([
            'branch-picker',
            'environment-picker',
            'project-picker',
            'work-location-picker',
        ])

        const actions = harness.getRegistered('action')
        expect(actions.map((a) => a.id).sort()).toEqual([
            'archive-chat',
            'fork-chat',
            'mark-as-unread',
            'new-chat',
            'new-standalone-chat',
            'next-chat',
            'previous-chat',
            'switch-chat',
            'toggle-pin',
            'user.invite',
        ])
    })

    it('handles new-chat action and emits composer:focus event', async () => {
        const harness = createPluginTestHarness(sessionManagerRendererEntry, {
            manifest,
        })
        await harness.activate()

        const actions = harness.getRegistered('action')
        const newChatAction = actions.find((a) => a.id === 'new-chat')?.value as any
        expect(newChatAction).toBeDefined()

        const mockSetCurrentSessionId = vi.fn()
        const mockSetPendingSessionContext = vi.fn()
        const mockCloseSettings = vi.fn()
        const mockCloseSearch = vi.fn()
        const mockEmitEvent = vi.fn()
        const mockNavigate = vi.fn()

        const actionCtx = {
            services: {
                sessions: {
                    getCurrentSessionId: () => 'sess-1',
                    getSnapshot: () => [
                        { id: 'sess-1', projectId: 'proj-1', branch: 'feat' },
                    ],
                    setCurrentSessionId: mockSetCurrentSessionId,
                },
                projects: {
                    getSnapshot: () => [{ id: 'proj-1', name: 'Proj 1' }],
                },
                ui: {
                    setPendingSessionContext: mockSetPendingSessionContext,
                    closeSettings: mockCloseSettings,
                    closeSearch: mockCloseSearch,
                    emitEvent: mockEmitEvent,
                },
            },
            navigate: mockNavigate,
        }

        newChatAction.handler(actionCtx)

        expect(mockSetCurrentSessionId).toHaveBeenCalledWith(null)
        expect(mockSetPendingSessionContext).toHaveBeenCalledWith(
            expect.objectContaining({
                projectId: 'proj-1',
                branch: 'feat',
            }),
        )
        expect(mockCloseSettings).toHaveBeenCalled()
        expect(mockCloseSearch).toHaveBeenCalled()
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
        expect(mockEmitEvent).toHaveBeenCalledWith('composer:focus')
    })
})
