import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { viewRegistry } from './viewRegistry'
import { PluginViewHost } from './PluginViewHost'

describe('PluginViewHost Component', () => {
    beforeEach(() => {
        viewRegistry.clear()
    })

    it('renders an arbitrary contributed path through the catch-all host', async () => {
        const ExternalDetailView = ({ itemId }: { itemId?: string }) => (
            <div data-testid="external-item-view">External Item ID: {itemId}</div>
        )

        viewRegistry.registerView({
            id: 'external.dashboard',
            path: '/external/$itemId',
            component: ExternalDetailView,
            layout: {
                showComposer: false,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        render(<PluginViewHost path="/external/42" />)
        expect(await screen.findByTestId('external-item-view')).toBeInTheDocument()
        expect(screen.getByText('External Item ID: 42')).toBeInTheDocument()
    })

    it('renders splat and colon routes correctly', async () => {
        const SplatView = ({ splat, section }: { splat?: string; section?: string }) => (
            <div data-testid="splat-view">
                Section: {section}, Splat: {splat}
            </div>
        )

        viewRegistry.registerView({
            id: 'docs.splat',
            path: '/docs/:section/*',
            component: SplatView,
            layout: {
                showComposer: false,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        render(<PluginViewHost path="/docs/guides/getting-started/quickstart" />)
        expect(await screen.findByTestId('splat-view')).toBeInTheDocument()
        expect(screen.getByText('Section: guides, Splat: getting-started/quickstart')).toBeInTheDocument()
    })

    it('starts empty and renders fallback when no matching view is registered', () => {
        expect(viewRegistry.listViews()).toHaveLength(0)

        render(
            <PluginViewHost
                path="/unknown-route"
                fallback={<div data-testid="not-found">Not Found</div>}
            />,
        )

        expect(screen.getByTestId('not-found')).toBeInTheDocument()
    })

    it('reacts dynamically to registration and unregistration of views', () => {
        const { rerender } = render(
            <PluginViewHost
                path="/dynamic-page"
                fallback={<div data-testid="empty-state">No View Registered</div>}
            />,
        )

        expect(screen.getByTestId('empty-state')).toBeInTheDocument()

        let unregister: () => void
        act(() => {
            unregister = viewRegistry.registerView({
                id: 'dynamic-page',
                path: '/dynamic-page',
                component: () => <div data-testid="dynamic-content">Dynamic Content Loaded</div>,
                layout: {
                    showComposer: true,
                    rightPanelMode: 'default',
                    reserveWindowToolbar: true,
                },
            })
        })

        rerender(
            <PluginViewHost
                path="/dynamic-page"
                fallback={<div data-testid="empty-state">No View Registered</div>}
            />,
        )

        expect(screen.getByTestId('dynamic-content')).toBeInTheDocument()

        act(() => {
            unregister!()
        })

        rerender(
            <PluginViewHost
                path="/dynamic-page"
                fallback={<div data-testid="empty-state">No View Registered</div>}
            />,
        )

        expect(screen.queryByTestId('dynamic-content')).toBeNull()
        expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    })

    it('isolates component errors inside the view error boundary', () => {
        const CrashingView = () => {
            throw new Error('Exploded during render')
        }

        viewRegistry.registerView({
            id: 'crasher',
            path: '/crash-test',
            component: CrashingView,
            layout: {
                showComposer: false,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        render(
            <PluginViewHost
                path="/crash-test"
                fallback={<div data-testid="crash-fallback">Safe Error Fallback</div>}
            />,
        )

        expect(screen.getByTestId('crash-fallback')).toBeInTheDocument()
    })
})
