import type { MouseEventHandler, ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { viewRegistry } from '@/application/views/viewRegistry'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { getHostServices } from '@/application/services/createHostServices'
import { Clock, SquarePen } from '@cpa/plugin-ui'
import { SidebarNavTop } from './SidebarNavTop'

const { navigateMock } = vi.hoisted(() => ({
    navigateMock: vi.fn(),
}))

let mockPathname = '/'

vi.mock('@tanstack/react-router', () => ({
    Link: ({
        children,
        className,
        onClick,
        to,
    }: {
        children: ReactNode
        className?: string
        onClick?: MouseEventHandler<HTMLAnchorElement>
        to: string
    }) => (
        <a
            className={className}
            href={to}
            data-testid={`nav-link-${to.replace(/^\//, '')}`}
            onClick={onClick}
        >
            {children}
        </a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: mockPathname } }),
}))

function setupTestNavItems() {
    viewRegistry.registerNavigationItem({
        id: 'home',
        viewId: 'home',
        order: 10,
        labelKey: 'nav.newChat',
        icon: SquarePen,
        path: '/',
    })
    viewRegistry.registerNavigationItem({
        id: 'scheduled',
        viewId: 'scheduled',
        order: 40,
        labelKey: 'nav.scheduled',
        icon: Clock,
        path: '/scheduled',
    })
}

beforeEach(async () => {
    getHostServices()
    mockPathname = '/'
    navigateMock.mockReset()
    ;(window as any).__cpa_navigate = (to: any) => navigateMock(typeof to === 'string' ? { to } : to)
    viewRegistry.clear()
    setupTestNavItems()
    await i18n.changeLanguage('en')

    useSessionStore.setState({ currentSessionId: null, sessions: [] })
    useUiStore.setState({
        sidebarCollapsed: false,
        pendingSessionContext: { projectId: null, branch: null },
    })
})

afterEach(() => {
    viewRegistry.clear()
})

describe('SidebarNavTop navigation contributions', () => {
    it('renders navigation links derived from ViewRegistry', () => {
        render(<SidebarNavTop />)

        expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
        expect(screen.getByText('Scheduled')).toBeInTheDocument()
        expect(screen.queryByText('Pull Requests')).not.toBeInTheDocument()
        expect(screen.queryByText('Sites')).not.toBeInTheDocument()
        expect(screen.queryByText('Plugins')).not.toBeInTheDocument()
    })

    it('handles clicking on new chat to reset active session and pending context', async () => {
        const user = userEvent.setup()
        useSessionStore.setState({ currentSessionId: 'active-session-1' })
        useUiStore.setState({
            pendingSessionContext: {
                projectId: 'p1',
                branch: 'main',
            },
        })

        render(<SidebarNavTop />)

        await user.click(screen.getByRole('button', { name: 'New chat' }))

        expect(useSessionStore.getState().currentSessionId).toBeNull()
        expect(useUiStore.getState().pendingSessionContext).toEqual({
            projectId: null,
            branch: null,
        })
        expect(navigateMock).toHaveBeenCalledWith({ to: '/' })
    })

    it('highlights active navigation item based on route pathname', () => {
        mockPathname = '/scheduled'
        render(<SidebarNavTop />)

        const scheduledLink = screen.getByTestId('nav-link-scheduled')
        expect(scheduledLink.className).toContain('font-medium')
        expect(scheduledLink.className).toContain('bg-[var(--bg-sidebar-hover)]')
    })

    it('reacts dynamically when a new navigation contribution is registered', () => {
        const { unmount } = render(<SidebarNavTop />)
        expect(screen.queryByText('Custom View')).not.toBeInTheDocument()

        unmount()

        viewRegistry.registerView({
            id: 'custom-view',
            path: '/custom',
            component: () => null,
            layout: {
                showComposer: false,
                rightPanelMode: 'default',
                reserveWindowToolbar: true,
            },
        })

        viewRegistry.registerNavigationItem({
            id: 'custom-nav',
            viewId: 'custom-view',
            order: 25,
            labelKey: 'Custom View',
            icon: () => null,
        })

        render(<SidebarNavTop />)
        expect(screen.getByText('Custom View')).toBeInTheDocument()
        expect(screen.getByTestId('nav-link-custom')).toBeInTheDocument()
    })
})
