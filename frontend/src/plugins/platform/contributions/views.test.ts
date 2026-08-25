import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
    ViewRegistry,
    DEFAULT_VIEW_LAYOUT,
} from '@/application/views/viewRegistry'
import {
    selectViews,
    selectNavigationItems,
    selectCurrentView,
    selectViewLayout,
    useViews,
    useNavigationItems,
    useCurrentView,
    useCurrentViewLayout,
} from './views'

describe('views contribution selectors and hooks', () => {
    let registry: ViewRegistry

    beforeEach(() => {
        registry = new ViewRegistry()
        registry.registerView({
            id: 'home',
            path: '/',
            component: () => null,
            layout: {
                showComposer: true,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })
        registry.registerView({
            id: 'chat',
            path: '/chat/$sessionId',
            component: () => null,
            layout: {
                showComposer: true,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })
        registry.registerView({
            id: 'scheduled',
            path: '/scheduled',
            component: () => null,
            layout: {
                showComposer: false,
                rightPanelMode: 'hidden',
                reserveWindowToolbar: false,
            },
        })
        registry.registerNavigationItem({
            id: 'home',
            viewId: 'home',
            order: 10,
            labelKey: 'nav.newChat',
            icon: () => null,
        })
        registry.registerNavigationItem({
            id: 'scheduled',
            viewId: 'scheduled',
            order: 20,
            labelKey: 'nav.scheduled',
            icon: () => null,
        })
    })

    it('selects all views and navigation items correctly', () => {
        const views = selectViews(registry)
        expect(views).toHaveLength(3)

        const navItems = selectNavigationItems(registry)
        expect(navItems).toHaveLength(2)
        expect(navItems[0].id).toBe('home')
        expect(navItems[1].id).toBe('scheduled')
    })

    it('selects current view and layout matching given path', () => {
        const scheduledView = selectCurrentView('/scheduled', registry)
        expect(scheduledView?.id).toBe('scheduled')

        const scheduledLayout = selectViewLayout('/scheduled', registry)
        expect(scheduledLayout).toEqual({
            showComposer: false,
            rightPanelMode: 'hidden',
            reserveWindowToolbar: false,
        })

        const unknownLayout = selectViewLayout('/unknown', registry)
        expect(unknownLayout).toEqual(DEFAULT_VIEW_LAYOUT)
    })

    it('useViews and useNavigationItems hooks return reactive snapshots', () => {
        const { result: viewsResult } = renderHook(() => useViews(registry))
        expect(viewsResult.current).toHaveLength(3)

        const { result: navResult } = renderHook(() => useNavigationItems(registry))
        expect(navResult.current).toHaveLength(2)

        act(() => {
            registry.registerView({
                id: 'extra',
                path: '/extra',
                component: () => null,
                layout: DEFAULT_VIEW_LAYOUT,
            })
        })

        expect(viewsResult.current).toHaveLength(4)
    })

    it('useCurrentView and useCurrentViewLayout hooks return active view metadata', () => {
        const { result: viewResult } = renderHook(() =>
            useCurrentView('/chat/session-xyz', registry)
        )
        expect(viewResult.current?.id).toBe('chat')

        const { result: layoutResult } = renderHook(() =>
            useCurrentViewLayout('/chat/session-xyz', registry)
        )
        expect(layoutResult.current).toEqual({
            showComposer: true,
            rightPanelMode: 'default',
            reserveWindowToolbar: true,
        })
    })
})
