import { describe, expect, it, vi } from 'vitest'
import { browserRendererEntry } from './index.js'

describe('browser plugin integration and lifecycle tests', () => {
    it('registers panel and actions and handles events correctly', () => {
        const registrations: Array<{ kind: string; id: string; value: any }> = []
        const emittedEvents: Array<{ event: string; payload?: any }> = []
        const eventListeners: Record<string, ((...args: any[]) => void)[]> = {}

        const mockContext = {
            manifest: {
                id: 'cpa.core.browser',
                name: 'Browser Preview',
                version: '1.0.0',
            },
            register: vi.fn((item) => {
                registrations.push(item)
                return () => {
                    const idx = registrations.indexOf(item)
                    if (idx >= 0) registrations.splice(idx, 1)
                }
            }),
            events: {
                emit: vi.fn((event: string, payload?: any) => {
                    emittedEvents.push({ event, payload })
                    eventListeners[event]?.forEach((cb) => cb(payload))
                }),
                on: vi.fn((event: string, handler: (...args: any[]) => void) => {
                    if (!eventListeners[event]) eventListeners[event] = []
                    eventListeners[event]!.push(handler)
                    return () => {
                        const list = eventListeners[event]
                        if (list) {
                            const idx = list.indexOf(handler)
                            if (idx >= 0) list.splice(idx, 1)
                        }
                    }
                }),
            },
            services: {
                ui: {
                    openRightPanelTab: vi.fn(),
                    toggleRightSidebarCollapsed: vi.fn(),
                },
            },
        }

        browserRendererEntry.activate(mockContext as any)

        expect(registrations.filter((r) => r.kind === 'panel')).toHaveLength(1)
        expect(registrations.filter((r) => r.kind === 'action')).toHaveLength(7)

        // Trigger action
        const reloadAction = registrations.find((r) => r.id === 'reload-browser-page')
        reloadAction?.value.handler()
        expect(mockContext.events.emit).toHaveBeenCalledWith('browser:reload')

        const backAction = registrations.find((r) => r.id === 'browser-back')
        backAction?.value.handler()
        expect(mockContext.events.emit).toHaveBeenCalledWith('browser:back')
    })
})
