import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { viewRegistry } from '@/application/views/viewRegistry'
import { PluginViewHost } from '@/application/views/PluginViewHost'

describe('Dynamic Router and PluginViewHost Integration', () => {
    beforeEach(() => {
        viewRegistry.clear()
    })

    it('renders null or fallback when route component is not registered', () => {
        render(
            <PluginViewHost
                path="/scheduled"
                fallback={<div data-testid="fallback-scheduled">Scheduled Not Ready</div>}
            />,
        )

        expect(screen.getByTestId('fallback-scheduled')).toBeInTheDocument()
        expect(screen.queryByTestId('dynamic-scheduled-content')).toBeNull()
    })

    it('dynamically reacts and renders when a plugin registers a view component', async () => {
        const { rerender } = render(
            <PluginViewHost
                path="/scheduled"
                fallback={<div data-testid="fallback">Empty</div>}
            />,
        )

        expect(screen.queryByTestId('dynamic-scheduled-content')).toBeNull()

        // Plugin registers view at runtime
        act(() => {
            viewRegistry.registerView({
                id: 'scheduled',
                path: '/scheduled',
                component: () => (
                    <div data-testid="dynamic-scheduled-content">
                        Scheduled Tasks Plugin Loaded
                    </div>
                ),
                layout: {
                    showComposer: false,
                    rightPanelMode: 'hidden',
                    reserveWindowToolbar: false,
                },
            })
        })

        rerender(
            <PluginViewHost
                path="/scheduled"
                fallback={<div data-testid="fallback">Empty</div>}
            />,
        )

        expect(screen.getByTestId('dynamic-scheduled-content')).toBeInTheDocument()
        expect(screen.getByText('Scheduled Tasks Plugin Loaded')).toBeInTheDocument()
    })

    it('recovers dynamically when a view contribution is unregistered', () => {
        let unregister: () => void

        act(() => {
            unregister = viewRegistry.registerView({
                id: 'custom-view',
                path: '/custom',
                component: () => <div data-testid="custom-view">Custom Content</div>,
                layout: {
                    showComposer: false,
                    rightPanelMode: 'default',
                    reserveWindowToolbar: true,
                },
            })
        })

        const { rerender } = render(
            <PluginViewHost
                path="/custom"
                fallback={<div data-testid="fallback-custom">Custom View Inactive</div>}
            />,
        )

        expect(screen.getByTestId('custom-view')).toBeInTheDocument()

        act(() => {
            unregister!()
        })

        rerender(
            <PluginViewHost
                path="/custom"
                fallback={<div data-testid="fallback-custom">Custom View Inactive</div>}
            />,
        )

        expect(screen.queryByTestId('custom-view')).toBeNull()
        expect(screen.getByTestId('fallback-custom')).toBeInTheDocument()
    })
})
