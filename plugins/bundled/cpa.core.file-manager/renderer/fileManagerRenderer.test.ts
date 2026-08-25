import { describe, expect, it, vi } from 'vitest'
import { Folder } from '@cpa/plugin-ui'
import { fileManagerRendererEntry } from './index.js'

describe('cpa.core.file-manager renderer entry', () => {
    it('defines renderer runtime entry', () => {
        expect(fileManagerRendererEntry.runtime).toBe('renderer')
        expect(typeof fileManagerRendererEntry.activate).toBe('function')
    })

    it('registers panel contribution, actions, and event handlers on activate', () => {
        const registrations: Array<{ kind: string; id: string; value: any }> = []
        let openFileListener: ((payload: any) => void) | null = null
        const mockContext = {
            manifest: { id: 'cpa.core.file-manager', name: 'File Manager', version: '1.0.0' },
            register: vi.fn((item) => {
                registrations.push(item)
                return () => {}
            }),
            events: {
                emit: vi.fn(),
                on: vi.fn((event, handler) => {
                    if (event === 'file-manager:open-file') {
                        openFileListener = handler
                    }
                    return () => {}
                }),
            },
            services: {
                ui: {
                    openRightPanelTab: vi.fn(),
                    getPendingSessionContext: () => ({ projectId: 'proj-1' }),
                },
                projects: {
                    getSnapshot: () => [{ id: 'proj-1', name: 'Project 1', path: '/path' }],
                },
                sessions: {
                    getSnapshot: () => [],
                },
            },
        }

        fileManagerRendererEntry.activate(mockContext as any)

        // Panel
        const panel = registrations.find((r) => r.id === 'file-manager' && r.kind === 'panel')
        expect(panel).toBeDefined()
        expect(panel?.value.icon).toBe(Folder)
        expect(panel?.value.titleKey).toBe('rightSidebar.tabs.files')
        expect(panel?.value.order).toBe(40)
        expect(panel?.value.selectionCard.requiresProject).toBe(true)

        // Shortcut
        expect(panel?.value.shortcut.mac).toBe('⌘P')
        expect(panel?.value.shortcut.other).toBe('Ctrl+P')
        expect(
            panel?.value.shortcut.keyEventMatch(
                { metaKey: true, key: 'p' } as KeyboardEvent,
                { hasProject: true },
            ),
        ).toBe(true)
        expect(
            panel?.value.shortcut.keyEventMatch(
                { metaKey: true, key: 'p' } as KeyboardEvent,
                { hasProject: false },
            ),
        ).toBe(false)

        // isAvailable
        expect(panel?.value.isAvailable({ services: mockContext.services, activeSessionId: null })).toBe(true)

        // Events
        expect(openFileListener).toBeDefined()
        openFileListener?.({
            path: '/path/src/index.ts',
            name: 'index.ts',
            relativePath: 'src/index.ts',
        })
        expect(mockContext.services.ui.openRightPanelTab).toHaveBeenCalledWith('file-manager', {
            activate: true,
            params: {
                activeFilePath: '/path/src/index.ts',
                name: 'index.ts',
                relativePath: 'src/index.ts',
            },
        })

        // Actions
        const searchAction = registrations.find((r) => r.id === 'search-files')
        expect(searchAction).toBeDefined()
        searchAction?.value.handler()
        expect(mockContext.services.ui.openRightPanelTab).toHaveBeenCalledWith('file-manager')
    })
})
