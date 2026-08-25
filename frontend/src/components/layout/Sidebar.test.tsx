import type { MouseEventHandler, ReactNode } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { rendererPluginRuntime } from '@/plugins/platform/RendererPluginRuntimeHost'
import { getHostServices } from '@/application/services/createHostServices'
import { setHostBridge } from '@/application/services/hostTransport'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { Sidebar } from './Sidebar'

const { clipboardSetTextMock, navigateMock, revealProjectPathMock } = vi.hoisted(() => ({
    clipboardSetTextMock: vi.fn(),
    navigateMock: vi.fn(),
    revealProjectPathMock: vi.fn(),
}))

beforeEach(() => {
    setHostBridge({
        ClipboardSetText: clipboardSetTextMock,
        RevealInFileManager: revealProjectPathMock,
    } as any)
    ;(window as any).__cpa_navigate = (to: any) => navigateMock(typeof to === 'string' ? { to } : to)
})

vi.mock('@/lib/projectReveal', () => ({
    revealProjectPath: revealProjectPathMock,
}))

vi.mock('@tanstack/react-router', () => ({
    Link: ({
        children,
        className,
        onClick,
        onContextMenu,
        params,
        title,
        to,
    }: {
        children: ReactNode
        className?: string
        onClick?: MouseEventHandler<HTMLAnchorElement>
        onContextMenu?: MouseEventHandler<HTMLAnchorElement>
        params?: { sessionId?: string }
        title?: string
        to: string
    }) => (
        <a
            className={className}
            href={params?.sessionId ? `/chat/${params.sessionId}` : to}
            onClick={onClick}
            onContextMenu={onContextMenu}
            title={title}
        >
            {children}
        </a>
    ),
    useNavigate: () => navigateMock,
    useRouterState: ({
        select,
    }: {
        select: (state: { location: { pathname: string } }) => unknown
    }) => select({ location: { pathname: '/' } }),
}))

beforeEach(async () => {
    getHostServices()
    await rendererPluginRuntime.activatePlugin('cpa.core.session-manager')
    await i18n.changeLanguage('en')
    clipboardSetTextMock.mockReset()
    clipboardSetTextMock.mockResolvedValue(undefined)
    navigateMock.mockReset()
    revealProjectPathMock.mockReset()
    revealProjectPathMock.mockResolvedValue(undefined)
    useProjectStore.setState({
        projects: [
            {
                id: 'project-1',
                name: 'Example Project',
                path: '/workspace/example',
                pinned: false,
                createdAt: 1,
                updatedAt: 2,
            },
        ],
    })
    useSessionStore.setState({
        currentSessionId: null,
        sessions: [
            {
                id: 'session-1',
                projectId: 'project-1',
                title: 'First Task',
                pinned: false,
                createdAt: 1,
                updatedAt: 2,
            },
            {
                id: 'session-2',
                projectId: 'project-1',
                branch: 'dev',
                title: 'Second Task',
                pinned: false,
                createdAt: 2,
                updatedAt: 3,
            },
        ],
    })
    useUiStore.setState({
        collapsedGroups: {},
        sidebarCollapsed: false,
        sidebarWidth: 272,
        settingsOpen: false,
        composerDraft: '',
        pendingSessionContext: { projectId: null, branch: null },
        toasts: [],
    })
})

afterEach(async () => {
    setHostBridge(null)
    await rendererPluginRuntime.reset()
    rendererRegistry.clear()
})

describe('Sidebar project groups', () => {
    it('opens the project editor from the context menu', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        fireEvent.contextMenu(screen.getByRole('button', { name: 'Example Project' }), {
            clientX: 32,
            clientY: 48,
        })
        const menu = screen.getByRole('menu', { name: 'Example Project' })
        await user.click(
            within(menu).getByRole('menuitem', { name: 'Edit project' }),
        )

        expect(
            screen.getByRole('dialog', { name: 'Edit project' }),
        ).toBeInTheDocument()
        expect(screen.getByRole('textbox', { name: 'Project name' })).toHaveValue(
            'Example Project',
        )
    })

    it('provides project actions and reveals the source path', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)
        const projectButton = screen.getByRole('button', { name: 'Example Project' })

        await user.hover(projectButton)
        expect(screen.queryByRole('menu', { name: 'Example Project' })).toBeNull()

        fireEvent.contextMenu(projectButton, { clientX: 32, clientY: 48 })
        const menu = screen.getByRole('menu', { name: 'Example Project' })
        expect(
            within(menu).getByRole('menuitem', { name: 'Pin project' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Show in Finder' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Edit project' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Remove project' }),
        ).toBeInTheDocument()

        await user.click(
            within(menu).getByRole('menuitem', { name: 'Show in Finder' }),
        )
        expect(revealProjectPathMock).toHaveBeenCalledWith('/workspace/example')
        expect(screen.queryByRole('menu', { name: 'Example Project' })).toBeNull()

        fireEvent.contextMenu(projectButton, { clientX: 32, clientY: 48 })
        await user.click(screen.getByRole('menuitem', { name: 'Pin project' }))
        expect(useProjectStore.getState().projects[0].pinned).toBe(true)
    })

    it('removes the project and keeps its chats uncategorized', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        fireEvent.contextMenu(screen.getByRole('button', { name: 'Example Project' }))
        await user.click(
            screen.getByRole('menuitem', { name: 'Remove project' }),
        )

        expect(useProjectStore.getState().projects).toHaveLength(0)
        expect(
            useSessionStore.getState().sessions.every(
                (session) => session.projectId === undefined,
            ),
        ).toBe(true)
    })

    it('keeps chat details interactive and edits the title inline', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        const chat = screen.getByTitle('Second Task')
        await user.hover(chat)

        const details = screen.getByRole('dialog', {
            name: 'Details for “Second Task”',
        })
        expect(within(details).getByText('Example Project')).toBeInTheDocument()
        expect(within(details).getByText('dev')).toBeInTheDocument()
        expect(within(details).getByText('No CI checks')).toBeInTheDocument()

        await user.hover(details)
        await user.click(
            within(details).getByRole('button', { name: 'Second Task' }),
        )
        const titleInput = within(details).getByRole('textbox', {
            name: 'Edit chat name',
        })
        fireEvent.mouseLeave(details)
        fireEvent.scroll(window)
        await new Promise((resolve) => setTimeout(resolve, 250))
        expect(titleInput).toBeInTheDocument()
        await user.clear(titleInput)
        await user.type(titleInput, 'Renamed Task{Enter}')

        expect(
            useSessionStore
                .getState()
                .sessions.find((session) => session.id === 'session-2')?.title,
        ).toBe('Renamed Task')
        expect(screen.getByTitle('Renamed Task')).toBeInTheDocument()

        fireEvent.mouseLeave(screen.getByRole('dialog'))
        await waitFor(() => {
            expect(screen.queryByRole('dialog')).toBeNull()
        })
    })

    it('immediately replaces the previous hover card when switching chats', () => {
        render(<Sidebar />)

        fireEvent.mouseEnter(screen.getByTitle('Second Task').parentElement!)
        expect(
            screen.getByRole('dialog', { name: 'Details for “Second Task”' }),
        ).toBeInTheDocument()

        fireEvent.mouseEnter(screen.getByTitle('First Task').parentElement!)

        expect(screen.queryAllByRole('dialog')).toHaveLength(1)
        expect(
            screen.getByRole('dialog', { name: 'Details for “First Task”' }),
        ).toBeInTheDocument()
        expect(
            screen.queryByRole('dialog', { name: 'Details for “Second Task”' }),
        ).toBeNull()
    })

    it('opens the chat context menu on right click', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        fireEvent.contextMenu(screen.getByTitle('Second Task'), {
            clientX: 160,
            clientY: 180,
        })

        const menu = screen.getByRole('menu', {
            name: 'Actions for “Second Task”',
        })
        expect(
            within(menu).getByRole('menuitem', { name: 'Pin chat' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Move to project' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', {
                name: 'Remove from Example Project',
            }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Rename chat' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Archive chat' }),
        ).toBeInTheDocument()
        expect(
            within(menu).getByRole('menuitem', { name: 'Mark as unread' }),
        ).toBeInTheDocument()

        await user.click(
            within(menu).getByRole('menuitem', { name: 'Mark as unread' }),
        )
        expect(
            useSessionStore
                .getState()
                .sessions.find((session) => session.id === 'session-2')?.unread,
        ).toBe(true)
    })

    it('copies chat details through the native clipboard', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        const actions = [
            ['Copy working directory', '/workspace/example'],
            ['Copy session ID', 'session-2'],
            [
                'Copy deep link',
                `${window.location.href.split('#')[0]}#/chat/session-2`,
            ],
        ] as const

        for (const [label, expectedValue] of actions) {
            fireEvent.contextMenu(screen.getByTitle('Second Task'))
            const menu = screen.getByRole('menu', {
                name: 'Actions for “Second Task”',
            })
            await user.click(
                within(menu).getByRole('menuitem', { name: label }),
            )
            await waitFor(() => {
                expect(clipboardSetTextMock).toHaveBeenLastCalledWith(
                    expectedValue,
                )
            })
            expect(screen.queryByRole('menu')).toBeNull()
        }

        expect(clipboardSetTextMock).toHaveBeenCalledTimes(3)
        const toasts = useUiStore.getState().toasts
        expect(toasts[toasts.length - 1]?.message).toBe('Copied to clipboard')
    })

    it('pins a chat from its hover actions', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        const row = screen.getByTitle('Second Task').parentElement
        expect(row).not.toBeNull()
        await user.click(
            within(row as HTMLElement).getByRole('button', {
                name: 'Pin chat',
            }),
        )

        expect(
            useSessionStore
                .getState()
                .sessions.find((session) => session.id === 'session-2')?.pinned,
        ).toBe(true)
        expect(
            within(
                screen.getByTitle('Second Task').parentElement as HTMLElement,
            ).getByRole('button', { name: 'Unpin' }),
        ).toBeInTheDocument()
    })

    it('archives a chat from its hover actions', async () => {
        const user = userEvent.setup()
        useSessionStore.setState({ currentSessionId: 'session-2' })
        render(<Sidebar />)

        const row = screen.getByTitle('Second Task').parentElement
        expect(row).not.toBeNull()
        await user.click(
            within(row as HTMLElement).getByRole('button', {
                name: 'Archive chat',
            }),
        )

        expect(
            useSessionStore
                .getState()
                .sessions.find((session) => session.id === 'session-2')
                ?.archivedAt,
        ).toEqual(expect.any(Number))
        expect(screen.queryByTitle('Second Task')).toBeNull()
        expect(navigateMock).toHaveBeenLastCalledWith({
            to: '/chat/$sessionId',
            params: { sessionId: 'session-1' },
        })
    })

    it('prepares a project chat without creating it', async () => {
        const user = userEvent.setup()
        render(<Sidebar />)

        const newChatBtn = screen.getByRole('button', {
            name: 'New chat in Example Project',
        })
        expect(newChatBtn).toHaveClass('opacity-0', 'group-hover:opacity-100')

        await user.click(newChatBtn)

        const state = useSessionStore.getState()
        expect(state.sessions).toHaveLength(2)
        expect(state.currentSessionId).toBeNull()
        expect(useUiStore.getState().pendingSessionContext).toEqual({
            projectId: 'project-1',
            branch: null,
        })
        expect(navigateMock).toHaveBeenLastCalledWith({ to: '/' })
    })

    it('prepares an uncategorized chat without adding a sidebar entry', async () => {
        const user = userEvent.setup()
        useSessionStore.setState({ currentSessionId: 'session-1' })
        useUiStore.setState({
            pendingSessionContext: {
                projectId: 'project-1',
                branch: 'feature/agent',
            },
        })
        render(<Sidebar />)

        await user.click(screen.getByRole('button', { name: 'New chat' }))

        const state = useSessionStore.getState()
        expect(state.sessions).toHaveLength(2)
        expect(state.currentSessionId).toBeNull()
        expect(useUiStore.getState().pendingSessionContext).toEqual({
            projectId: null,
            branch: null,
        })
        expect(navigateMock).toHaveBeenLastCalledWith({ to: '/' })
    })
})

describe('Sidebar collapse animation', () => {
    it('starts at zero width when the sidebar is already collapsed', () => {
        useUiStore.setState({ sidebarCollapsed: true })
        const { container } = render(<Sidebar />)
        const aside = container.querySelector('aside')
        expect(aside).toHaveStyle({ width: '0px' })
        expect(aside).toHaveAttribute('data-state', 'closed')
    })

    it('animates width back when the sidebar is expanded', async () => {
        useUiStore.setState({ sidebarCollapsed: true })
        const { container } = render(<Sidebar />)
        const aside = container.querySelector('aside')

        useUiStore.setState({ sidebarCollapsed: false })
        await waitFor(() => {
            expect(aside).toHaveStyle({ width: '272px' })
        })
        expect(aside).toHaveAttribute('data-state', 'open')
    })
})

describe('Sidebar resize handle', () => {
    it('drags the divider to change sidebar width', () => {
        render(<Sidebar />)
        const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

        fireEvent.pointerDown(handle, { clientX: 272, button: 0 })
        fireEvent.pointerMove(window, { clientX: 360 })
        fireEvent.pointerUp(window)

        expect(useUiStore.getState().sidebarWidth).toBe(360)
        expect(handle.closest('aside')).toHaveStyle({ width: '360px' })
    })

    it('clamps dragged width to the allowed range', () => {
        render(<Sidebar />)
        const handle = screen.getByRole('separator', { name: 'Resize sidebar' })

        fireEvent.pointerDown(handle, { clientX: 272, button: 0 })
        fireEvent.pointerMove(window, { clientX: 80 })
        fireEvent.pointerUp(window)
        expect(useUiStore.getState().sidebarWidth).toBe(200)

        fireEvent.pointerDown(handle, { clientX: 200, button: 0 })
        fireEvent.pointerMove(window, { clientX: 800 })
        fireEvent.pointerUp(window)
        expect(useUiStore.getState().sidebarWidth).toBe(480)
    })
})

describe('Sidebar mobile browser behavior', () => {
    const originalUserAgent = navigator.userAgent
    const originalMaxTouchPoints = navigator.maxTouchPoints
    const originalInnerWidth = window.innerWidth

    beforeEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
            configurable: true,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
            value: 5,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: 390,
            configurable: true,
        })
    })

    afterEach(() => {
        Object.defineProperty(navigator, 'userAgent', {
            value: originalUserAgent,
            configurable: true,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
            value: originalMaxTouchPoints,
            configurable: true,
        })
        Object.defineProperty(window, 'innerWidth', {
            value: originalInnerWidth,
            configurable: true,
        })
    })

    it('renders hidden aside when sidebarCollapsed is true on mobile', () => {
        useUiStore.setState({ sidebarCollapsed: true })
        const { container } = render(<Sidebar />)
        const aside = container.querySelector('aside')
        expect(aside).toHaveAttribute('data-state', 'closed')
        expect(aside).toHaveAttribute('aria-hidden', 'true')
        expect(aside).toHaveClass('hidden')
    })

    it('renders full-screen sidebar when sidebarCollapsed is false on mobile without resize handle', () => {
        useUiStore.setState({ sidebarCollapsed: false })
        const { container } = render(<Sidebar />)
        const aside = container.querySelector('aside')
        expect(aside).toHaveAttribute('data-state', 'open')
        expect(aside).toHaveAttribute('data-mobile', 'true')
        expect(aside).toHaveClass('fixed', 'inset-0', 'z-50', 'w-full', 'h-full')
        expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull()
    })

    it('renders project new chat button with opacity-100 on mobile by default', () => {
        useUiStore.setState({ sidebarCollapsed: false })
        render(<Sidebar />)

        const newChatBtn = screen.getByRole('button', {
            name: 'New chat in Example Project',
        })
        expect(newChatBtn).toHaveClass('opacity-100')
        expect(newChatBtn).not.toHaveClass('opacity-0')
    })

    it('collapses sidebar when clicking the collapse sidebar button in mobile sidebar', async () => {
        const user = userEvent.setup()
        useUiStore.setState({ sidebarCollapsed: false })
        render(<Sidebar />)

        const toggleBtn = screen.getByRole('button', { name: 'Collapse sidebar' })
        await user.click(toggleBtn)

        expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })

    it('collapses mobile sidebar on Escape key press', () => {
        useUiStore.setState({ sidebarCollapsed: false })
        render(<Sidebar />)

        fireEvent.keyDown(window, { key: 'Escape' })
        expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })
})

