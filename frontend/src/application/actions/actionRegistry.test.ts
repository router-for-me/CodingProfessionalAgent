import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    ActionContribution,
    ActionContext,
    ActionExecutionContext,
    HostServices,
} from '@cpa/plugin-api'
import { ActionRegistry } from './actionRegistry'

describe('ActionRegistry', () => {
    let registry: ActionRegistry
    let mockServices: HostServices
    let defaultContext: ActionContext

    beforeEach(() => {
        registry = new ActionRegistry()
        mockServices = {
            sessions: {} as any,
            projects: {} as any,
            settings: {} as any,
            worktrees: {} as any,
            hooks: {} as any,
            navigation: {} as any,
            notifications: {} as any,
            schedule: {} as any,
            skillUsage: {} as any,
            persistence: {} as any,
        }
        defaultContext = {
            services: mockServices,
            pathname: '/chat/123',
        }
    })

    it('drives shortcut menu and slash placement from one action', async () => {
        const handler = vi.fn()
        registry.register({
            id: 'session.new',
            title: 'New session',
            handler,
            defaultShortcuts: ['Meta+N'],
            placements: [
                { surface: 'menu.user', order: 10 },
                { surface: 'composer.slash', order: 10 },
            ],
        })

        expect(registry.listForSurface('menu.user', defaultContext).map((item) => item.id)).toEqual(['session.new'])
        expect(registry.listForSurface('composer.slash', defaultContext).map((item) => item.id)).toEqual(['session.new'])
    })

    it('registers, lists, gets, and unregisters actions', () => {
        const action: ActionContribution = {
            id: 'test.action',
            title: 'Test Action',
            handler: vi.fn(),
        }

        const unregister = registry.register(action)
        expect(registry.get('test.action')).toEqual(action)
        expect(registry.list()).toHaveLength(1)

        unregister()
        expect(registry.get('test.action')).toBeUndefined()
        expect(registry.list()).toHaveLength(0)
    })

    it('sorts actions in listForSurface by placement order ascending', () => {
        registry.register({
            id: 'action.second',
            title: 'Second',
            handler: vi.fn(),
            placements: [{ surface: 'menu.user', order: 20 }],
        })
        registry.register({
            id: 'action.first',
            title: 'First',
            handler: vi.fn(),
            placements: [{ surface: 'menu.user', order: 10 }],
        })
        registry.register({
            id: 'action.third',
            title: 'Third',
            handler: vi.fn(),
            placements: [{ surface: 'menu.user', order: 30 }],
        })

        const items = registry.listForSurface('menu.user', defaultContext)
        expect(items.map((i) => i.id)).toEqual(['action.first', 'action.second', 'action.third'])
    })

    it('filters out invisible actions in listForSurface', () => {
        registry.register({
            id: 'action.visible',
            title: 'Visible',
            handler: vi.fn(),
            visible: () => true,
            placements: [{ surface: 'menu.user', order: 10 }],
        })
        registry.register({
            id: 'action.hidden',
            title: 'Hidden',
            handler: vi.fn(),
            visible: () => false,
            placements: [{ surface: 'menu.user', order: 20 }],
        })

        const items = registry.listForSurface('menu.user', defaultContext)
        expect(items.map((i) => i.id)).toEqual(['action.visible'])
    })

    it('isolates exceptions in visible predicate gracefully', () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        registry.register({
            id: 'action.throwing',
            title: 'Throwing',
            handler: vi.fn(),
            visible: () => {
                throw new Error('Boom in visible')
            },
            placements: [{ surface: 'menu.user', order: 10 }],
        })
        registry.register({
            id: 'action.safe',
            title: 'Safe',
            handler: vi.fn(),
            visible: () => true,
            placements: [{ surface: 'menu.user', order: 20 }],
        })

        const items = registry.listForSurface('menu.user', defaultContext)
        expect(items.map((i) => i.id)).toEqual(['action.safe'])
        consoleSpy.mockRestore()
    })

    it('executes registered action handler with execution context', async () => {
        const handler = vi.fn().mockResolvedValue(undefined)
        registry.register({
            id: 'action.run',
            title: 'Run Action',
            handler,
        })

        const execContext: ActionExecutionContext = {
            ...defaultContext,
            source: 'shortcut',
        }

        await registry.execute('action.run', execContext)
        expect(handler).toHaveBeenCalledWith(execContext)
    })

    it('throws or handles execution of unknown action', async () => {
        await expect(registry.execute('unknown.action', {
            ...defaultContext,
            source: 'api',
        })).rejects.toThrow('Action "unknown.action" not found')
    })

    it('does not execute if enabled predicate returns false', async () => {
        const handler = vi.fn()
        registry.register({
            id: 'action.disabled',
            title: 'Disabled Action',
            handler,
            enabled: () => false,
        })

        await registry.execute('action.disabled', {
            ...defaultContext,
            source: 'slash',
        })
        expect(handler).not.toHaveBeenCalled()
    })

    it('isolates exceptions in enabled predicate gracefully', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const handler = vi.fn()
        registry.register({
            id: 'action.throwing.enabled',
            title: 'Throwing Enabled',
            handler,
            enabled: () => {
                throw new Error('Boom in enabled')
            },
        })

        await registry.execute('action.throwing.enabled', {
            ...defaultContext,
            source: 'shortcut',
        })
        expect(handler).not.toHaveBeenCalled()
        consoleSpy.mockRestore()
    })

    it('provides referential stability for getSnapshot when no mutations occur', () => {
        registry.register({
            id: 'action.a',
            title: 'Action A',
            handler: vi.fn(),
            placements: [{ surface: 'menu.user', order: 10 }],
        })

        const snapshot1 = registry.list()
        const snapshot2 = registry.list()
        expect(snapshot1).toBe(snapshot2)

        const surface1 = registry.listForSurface('menu.user')
        const surface2 = registry.listForSurface('menu.user')
        expect(surface1).toBe(surface2)

        // Mutate registry
        registry.register({
            id: 'action.b',
            title: 'Action B',
            handler: vi.fn(),
            placements: [{ surface: 'menu.user', order: 20 }],
        })

        const snapshot3 = registry.list()
        expect(snapshot3).not.toBe(snapshot1)
        expect(snapshot3).toHaveLength(2)

        const surface3 = registry.listForSurface('menu.user')
        expect(surface3).not.toBe(surface1)
        expect(surface3).toHaveLength(2)
    })

    it('initializes completely empty without hardcoded core actions', () => {
        expect(registry.list()).toEqual([])
        expect(registry.listForSurface('menu.user')).toEqual([])
    })

    it('notifies subscribers on register and unregister', () => {
        const listener = vi.fn()
        const unsub = registry.subscribe(listener)

        const unregisterAction = registry.register({
            id: 'action.sub',
            title: 'Sub',
            handler: vi.fn(),
        })
        expect(listener).toHaveBeenCalledTimes(1)

        unregisterAction()
        expect(listener).toHaveBeenCalledTimes(2)

        unsub()
        registry.register({
            id: 'action.sub2',
            title: 'Sub 2',
            handler: vi.fn(),
        })
        expect(listener).toHaveBeenCalledTimes(2)
    })
})
