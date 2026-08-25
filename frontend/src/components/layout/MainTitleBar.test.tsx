import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { MainTitleBar, type MainTitleBarProps } from './MainTitleBar'

describe('MainTitleBar', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    const originalUserAgent = navigator.userAgent

    afterEach(async () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        await rendererPluginRuntime.reset()
        rendererRegistry.clear()
    })

    it('hosts the pinned-summary toggle when the right sidebar is open', () => {
        render(
            <MainTitleBar
                leftSidebarCollapsed={false}
                showPinnedSummaryToggle
                reserveWindowToolbar={false}
                sessionTitle="Dispatch model for arithmetic"
            />,
        )

        expect(screen.getByText('Dispatch model for arithmetic')).toBeInTheDocument()
        expect(screen.getByTestId('pinned-summary-toggle')).toBeInTheDocument()
        expect(
            screen.queryByTestId('right-sidebar-toggle'),
        ).not.toBeInTheDocument()
    })

    it('leaves the window-edge trio to WindowToolbar when the sidebar is closed', () => {
        render(
            <MainTitleBar
                leftSidebarCollapsed={false}
                showPinnedSummaryToggle={false}
                reserveWindowToolbar
                sessionTitle="Dispatch model for arithmetic"
            />,
        )

        expect(screen.queryByTestId('pinned-summary-toggle')).not.toBeInTheDocument()
        expect(
            screen.queryByTestId('right-sidebar-toggle'),
        ).not.toBeInTheDocument()
    })

    it('renders left sidebar toggle fallback when leftSidebarCollapsed is true', () => {
        render(
            <MainTitleBar
                leftSidebarCollapsed={true}
                showPinnedSummaryToggle={false}
                reserveWindowToolbar={true}
                sessionTitle="Test Session"
            />,
        )

        expect(
            screen.getByRole('button', { name: /sidebar/i }),
        ).toBeInTheDocument()
        expect(screen.getByText('Test Session')).toBeInTheDocument()
    })

    it('renders custom slot contributions for titlebar left, center, and right slots', () => {
        rendererRegistry.registerSlot<MainTitleBarProps>(
            'layout.titlebar.left',
            {
                id: 'custom-left',
                pluginId: 'test.plugin',
                component: (props) => (
                    <div data-testid="custom-titlebar-left">
                        Custom Left (collapsed: {String(props.leftSidebarCollapsed)})
                    </div>
                ),
            },
        )
        rendererRegistry.registerSlot<MainTitleBarProps>(
            'layout.titlebar.center',
            {
                id: 'custom-center',
                pluginId: 'test.plugin',
                component: (props) => (
                    <div data-testid="custom-titlebar-center">
                        Custom Center: {props.sessionTitle}
                    </div>
                ),
            },
        )
        rendererRegistry.registerSlot<MainTitleBarProps>(
            'layout.titlebar.right',
            {
                id: 'custom-right',
                pluginId: 'test.plugin',
                component: () => (
                    <div data-testid="custom-titlebar-right">Custom Right</div>
                ),
            },
        )

        render(
            <MainTitleBar
                leftSidebarCollapsed={true}
                showPinnedSummaryToggle={true}
                reserveWindowToolbar={false}
                sessionTitle="Plugin Title"
            />,
        )

        expect(screen.getByTestId('custom-titlebar-left')).toHaveTextContent(
            'Custom Left (collapsed: true)',
        )
        expect(screen.getByTestId('custom-titlebar-center')).toHaveTextContent(
            'Custom Center: Plugin Title',
        )
        expect(screen.getByTestId('custom-titlebar-right')).toHaveTextContent(
            'Custom Right',
        )
    })

    it('appends external titlebar contributions without wiping out core chrome items', async () => {
        await rendererPluginRuntime.activateAll()

        rendererRegistry.registerSlot<MainTitleBarProps>(
            'layout.titlebar.right',
            {
                id: 'external-widget',
                pluginId: 'ext.plugin',
                order: 5,
                component: () => (
                    <div data-testid="external-titlebar-widget">Ext Widget</div>
                ),
            },
        )

        render(
            <MainTitleBar
                leftSidebarCollapsed={true}
                showPinnedSummaryToggle={true}
                reserveWindowToolbar={false}
                sessionTitle="Core Session"
            />,
        )

        // Core items should all be present
        expect(screen.getByText('Core Session')).toBeInTheDocument()
        expect(screen.getByTestId('pinned-summary-toggle')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /sidebar/i })).toBeInTheDocument()

        // External widget should also be present
        expect(screen.getByTestId('external-titlebar-widget')).toBeInTheDocument()
        expect(screen.getByTestId('external-titlebar-widget')).toHaveTextContent('Ext Widget')
    })

    it('renders sidebar toggle fallback without traffic light spacer in browser mode', () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const { container } = render(
            <MainTitleBar
                leftSidebarCollapsed={true}
                showPinnedSummaryToggle={false}
                reserveWindowToolbar={true}
                sessionTitle="Test"
            />,
        )

        expect(
            screen.getByRole('button', { name: /sidebar/i }),
        ).toBeInTheDocument()
        const trafficSpacer = container.querySelector('div[style*="--traffic-lights-pad"]')
        expect(trafficSpacer).toBeNull()
    })

    it('renders sidebar toggle fallback with traffic light spacer in Electron mode', () => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 Electron/34.2.0 Chrome/120.0.0.0 Safari/537.36',
            configurable: true,
        })

        const { container } = render(
            <MainTitleBar
                leftSidebarCollapsed={true}
                showPinnedSummaryToggle={false}
                reserveWindowToolbar={true}
                sessionTitle="Test"
            />,
        )

        expect(
            screen.getByRole('button', { name: /sidebar/i }),
        ).toBeInTheDocument()
        const trafficSpacer = container.querySelector('div[style*="--traffic-lights-pad"]')
        expect(trafficSpacer).toBeInTheDocument()
    })
})
