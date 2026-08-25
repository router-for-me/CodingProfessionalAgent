import { describe, expect, it, beforeEach } from 'vitest'
import {
    ViewRegistry,
    viewRegistry,
    DEFAULT_VIEW_LAYOUT,
    matchRoutePattern,
} from './viewRegistry'

describe('ViewRegistry', () => {
    let registry: ViewRegistry

    beforeEach(() => {
        registry = new ViewRegistry()
    })

    it('initializes completely empty without hardcoded core views', () => {
        expect(registry.listViews()).toEqual([])
        expect(registry.listNavigationItems()).toEqual([])
        expect(viewRegistry.listViews()).toEqual([])
    })

    it('matches route patterns and extracts parameters accurately', () => {
        expect(matchRoutePattern('/chat/$sessionId', '/chat/sess-123')).toEqual({
            matches: true,
            params: { sessionId: 'sess-123' },
        })

        expect(matchRoutePattern('/external/:itemId/details', '/external/42/details')).toEqual({
            matches: true,
            params: { itemId: '42' },
        })

        expect(matchRoutePattern('/docs/*', '/docs/api/v1/endpoints')).toEqual({
            matches: true,
            params: { splat: 'api/v1/endpoints', '*': 'api/v1/endpoints', '$': 'api/v1/endpoints' },
        })

        expect(matchRoutePattern('/items', '/other')).toEqual({
            matches: false,
            params: {},
        })
    })

    it('registers, matches and unregisters views dynamically', () => {
        const dummyComponent = () => null

        const unregister = registry.registerView({
            id: 'dashboard',
            path: '/dashboard/$tab',
            component: dummyComponent,
            layout: {
                showComposer: false,
                rightPanelMode: 'hidden',
                reserveWindowToolbar: false,
            },
        })

        expect(registry.listViews()).toHaveLength(1)
        expect(registry.getView('dashboard')).toBeDefined()

        const match = registry.matchViewAndParams('/dashboard/metrics')
        expect(match).toBeDefined()
        expect(match?.view.id).toBe('dashboard')
        expect(match?.params).toEqual({ tab: 'metrics' })

        const layout = registry.getLayoutForPath('/dashboard/metrics')
        expect(layout).toEqual({
            showComposer: false,
            rightPanelMode: 'hidden',
            reserveWindowToolbar: false,
        })

        unregister()

        expect(registry.listViews()).toHaveLength(0)
        expect(registry.matchView('/dashboard/metrics')).toBeUndefined()
        expect(registry.getLayoutForPath('/dashboard/metrics')).toEqual(DEFAULT_VIEW_LAYOUT)
    })

    it('registers, sorts, and unregisters navigation items dynamically', () => {
        const IconMock = () => null

        const unregister1 = registry.registerNavigationItem({
            id: 'settings',
            viewId: 'settings',
            order: 50,
            labelKey: 'nav.settings',
            icon: IconMock,
        })

        const unregister2 = registry.registerNavigationItem({
            id: 'home',
            viewId: 'home',
            order: 10,
            labelKey: 'nav.newChat',
            icon: IconMock,
        })

        const items = registry.listNavigationItems()
        expect(items).toHaveLength(2)
        expect(items[0].id).toBe('home')
        expect(items[1].id).toBe('settings')

        unregister2()
        expect(registry.listNavigationItems()).toHaveLength(1)
        expect(registry.listNavigationItems()[0].id).toBe('settings')

        unregister1()
        expect(registry.listNavigationItems()).toHaveLength(0)
    })

    it('notifies subscribers on register, unregister and clear', () => {
        let callCount = 0
        const unsubscribe = registry.subscribe(() => {
            callCount++
        })

        const unregister = registry.registerView({
            id: 'test',
            path: '/test',
            component: () => null,
            layout: DEFAULT_VIEW_LAYOUT,
        })
        expect(callCount).toBe(1)

        unregister()
        expect(callCount).toBe(2)

        registry.clear()
        expect(callCount).toBe(3)

        unsubscribe()
        registry.registerView({
            id: 'test2',
            path: '/test2',
            component: () => null,
            layout: DEFAULT_VIEW_LAYOUT,
        })
        expect(callCount).toBe(3)
    })
})
