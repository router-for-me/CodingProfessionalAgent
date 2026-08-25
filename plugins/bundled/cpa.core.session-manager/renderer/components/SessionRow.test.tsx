import type { MouseEventHandler, ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { getHostServices } from '@/application/services/createHostServices'
import { SessionRow } from './SessionRow'

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
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
      onClick={(e) => {
        e.preventDefault()
        onClick?.(e)
      }}
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

function StoreBackedSessionRow() {
  const session = useSessionStore((state) =>
    state.sessions.find((candidate) => candidate.id === 'session-cpa'),
  )
  return session ? <SessionRow session={session} /> : null
}

describe('SessionRow', () => {
  const originalUserAgent = navigator.userAgent
  const originalMaxTouchPoints = navigator.maxTouchPoints
  const originalInnerWidth = window.innerWidth

  const testSession = {
    id: 'session-cpa',
    projectId: 'project-1',
    branch: 'main',
    title: 'CPA Directory Query',
    pinned: false,
    unread: true,
    createdAt: 1000,
    updatedAt: 2000,
  }

  beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
    navigateMock.mockReset()
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
      manuallyMarkedUnreadSessionIds: [],
      sessions: [testSession],
    })
    useSessionRunStore.setState({
      activeRuns: {},
    })
    useUiStore.setState({
      sidebarCollapsed: false,
      toasts: [],
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

  describe('desktop environment', () => {
    beforeEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        configurable: true,
      })
      Object.defineProperty(navigator, 'maxTouchPoints', {
        value: 0,
        configurable: true,
      })
      Object.defineProperty(window, 'innerWidth', {
        value: 1280,
        configurable: true,
      })
    })

    it('shows hover details card on mouse enter and allows clicking', async () => {
      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      const link = screen.getByTitle('CPA Directory Query')
      await user.hover(link)

      expect(
        screen.getByRole('dialog', { name: 'Details for “CPA Directory Query”' }),
      ).toBeInTheDocument()

      await user.click(link)
      expect(useSessionStore.getState().currentSessionId).toBe('session-cpa')
      expect(
        Boolean(
          useSessionStore
            .getState()
            .sessions.find((s) => s.id === 'session-cpa')?.unread,
        ),
      ).toBe(false)
    })

    it('renders localized session age in hover card instead of raw i18n keys', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'))

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(
        <SessionRow
          session={{
            ...testSession,
            updatedAt: Date.now() - 5 * 60 * 1000,
          }}
        />,
      )

      const link = screen.getByTitle('CPA Directory Query')
      await user.hover(link)

      const hoverCard = screen.getByRole('dialog', {
        name: 'Details for “CPA Directory Query”',
      })
      expect(hoverCard).toHaveTextContent('5m')
      expect(hoverCard).not.toHaveTextContent('session.ageMinutes')
      expect(hoverCard).not.toHaveTextContent('session.age.minutes')

      vi.useRealTimers()
    })

    it('renders running indicator when session is actively running in sessionRunStore', () => {
      useSessionRunStore.getState().setRun('session-cpa', {
        sessionId: 'session-cpa',
        runId: 'run-1',
        status: 'running',
        clientId: 'remote',
        updatedAt: Date.now(),
      })

      render(<SessionRow session={testSession} />)
      const indicator = screen.getByTestId('session-running-indicator')
      expect(indicator).toBeInTheDocument()
      expect(indicator).toHaveAttribute('role', 'status')
      expect(indicator).toHaveAttribute('aria-label', 'Running')
      expect(screen.getByTitle('Running')).toBeInTheDocument()

      const titleSpan = screen.getByText('CPA Directory Query')
      expect(titleSpan).toHaveClass('min-w-0', 'truncate')
      expect(titleSpan).not.toHaveClass('flex-1')
      expect(titleSpan.compareDocumentPosition(indicator)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it('shows running badge in hover card when session is running', async () => {
      useSessionRunStore.getState().setRun('session-cpa', {
        sessionId: 'session-cpa',
        runId: 'run-1',
        status: 'running',
        clientId: 'remote',
        updatedAt: Date.now(),
      })

      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      const link = screen.getByTitle('CPA Directory Query')
      await user.hover(link)

      expect(screen.getByTestId('session-running-badge')).toBeInTheDocument()
      expect(screen.getByTestId('session-running-badge')).toHaveTextContent('Running')
    })

    it('renders blue unread indicator for normal unread and red unread indicator for error unread when not actively viewing', () => {
      useSessionStore.setState({ currentSessionId: null })
      // 1. Normal unread (blue)
      const { rerender } = render(<SessionRow session={{ ...testSession, unread: true }} />)
      let indicator = screen.getByTestId('session-unread-indicator')
      expect(indicator).toBeInTheDocument()
      expect(indicator.className).toContain('bg-[var(--accent-blue')

      // 2. Error unread (red)
      rerender(<SessionRow session={{ ...testSession, unread: 'error' }} />)
      indicator = screen.getByTestId('session-unread-indicator')
      expect(indicator).toBeInTheDocument()
      expect(indicator.className).toContain('bg-[var(--accent-red')
    })

    it('does NOT render activity-driven unread indicator when actively viewing the session', () => {
      useSessionStore.setState({ currentSessionId: testSession.id })
      render(<SessionRow session={{ ...testSession, unread: true }} />)
      expect(screen.queryByTestId('session-unread-indicator')).not.toBeInTheDocument()
    })

    it('shows a blue unread indicator after manually marking the current session unread', async () => {
      const user = userEvent.setup()
      useSessionStore.setState({
        currentSessionId: testSession.id,
        sessions: [{ ...testSession, unread: undefined }],
      })
      render(<StoreBackedSessionRow />)

      fireEvent.contextMenu(screen.getByTitle('CPA Directory Query'), {
        clientX: 100,
        clientY: 100,
      })
      await user.click(screen.getByRole('menuitem', { name: 'Mark as unread' }))

      const indicator = screen.getByTestId('session-unread-indicator')
      expect(indicator).toHaveClass('bg-[var(--accent-blue,#3b82f6)]')
      expect(useSessionStore.getState().manuallyMarkedUnreadSessionIds).toContain(
        testSession.id,
      )
    })

    it('renders worktree indicator at right 2nd and running/unread indicators at far right in correct order', () => {
      useSessionStore.setState({ currentSessionId: null })
      useSessionRunStore.getState().setRun('session-cpa', {
        sessionId: 'session-cpa',
        runId: 'run-1',
        status: 'running',
        clientId: 'remote',
        updatedAt: Date.now(),
      })

      const worktreeSession = {
        ...testSession,
        workLocation: 'worktree' as const,
        unread: true,
      }

      render(<SessionRow session={worktreeSession} />)

      const worktreeIndicator = screen.getByTestId('session-worktree-indicator')
      const runningIndicator = screen.getByTestId('session-running-indicator')
      const unreadIndicator = screen.getByTestId('session-unread-indicator')

      expect(worktreeIndicator).toBeInTheDocument()
      expect(runningIndicator).toBeInTheDocument()
      expect(unreadIndicator).toBeInTheDocument()

      // Verify DOM ordering: worktree (right 2nd) precedes running/unread (far right)
      expect(
        worktreeIndicator.compareDocumentPosition(runningIndicator),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(
        runningIndicator.compareDocumentPosition(unreadIndicator),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it('forks the entire session into a new session when "Continue in new chat" is clicked', async () => {
      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      fireEvent.contextMenu(screen.getByTitle('CPA Directory Query'), {
        clientX: 100,
        clientY: 100,
      })

      const menuItem = screen.getByTestId('session-menu-continue-chat')
      expect(menuItem).toHaveTextContent('Continue in new chat')
      await user.click(menuItem)

      const sessions = useSessionStore.getState().sessions
      const forkedSession = sessions.find((s) => s.id !== testSession.id)
      expect(forkedSession).toBeDefined()
      expect(forkedSession?.title).toBe('CPA Directory Query (Fork)')
      expect(forkedSession?.projectId).toBe(testSession.projectId)
      expect(forkedSession?.branch).toBe(testSession.branch)

      expect(useSessionStore.getState().currentSessionId).toBe(forkedSession?.id)
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/chat/$sessionId',
        params: { sessionId: forkedSession?.id },
      })
      expect(useUiStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Forked new session from current point',
          }),
        ]),
      )
    })

    it('opens ContinueInWorktreeModal and completes worktree fork when "Continue in new worktree" is clicked and confirmed', async () => {
      const user = userEvent.setup()
      const setupSpy = vi.spyOn(getHostServices().worktrees, 'setup').mockResolvedValue({
        ok: true,
        worktreePath: '/workspaces/sample-project/wt-1',
        branch: 'main',
      })
      render(<SessionRow session={testSession} />)

      fireEvent.contextMenu(screen.getByTitle('CPA Directory Query'), {
        clientX: 100,
        clientY: 100,
      })

      const worktreeMenuItem = screen.getByTestId('session-menu-continue-worktree')
      expect(worktreeMenuItem).toHaveTextContent('Continue in new worktree')
      await user.click(worktreeMenuItem)

      // Modal should be open
      expect(screen.getByRole('dialog', { name: 'Continue in new worktree' })).toBeInTheDocument()
      expect(screen.getByTestId('worktree-modal-branch')).toHaveTextContent('main')

      // Click confirm button
      const confirmBtn = screen.getByTestId('confirm-worktree-fork-btn')
      await user.click(confirmBtn)

      expect(setupSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceTreePath: '/workspace/example',
          branch: 'main',
        }),
      )

      // Forked session should be in sessionStore with workLocation worktree
      const sessions = useSessionStore.getState().sessions
      const forkedSession = sessions.find((s) => s.id !== testSession.id)
      expect(forkedSession).toBeDefined()
      expect(forkedSession?.title).toBe('CPA Directory Query (Fork)')
      expect(forkedSession?.workLocation).toBe('worktree')
      expect(forkedSession?.branch).toBe('main')

      expect(useSessionStore.getState().currentSessionId).toBe(forkedSession?.id)
      expect(navigateMock).toHaveBeenCalledWith({
        to: '/chat/$sessionId',
        params: { sessionId: forkedSession?.id },
      })
      expect(useUiStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Forked new session from current point',
          }),
        ]),
      )
    })

    it('shows error toast if worktree creation fails but still navigates to forked session', async () => {
      const user = userEvent.setup()
      vi.spyOn(getHostServices().worktrees, 'setup').mockResolvedValue({
        ok: false,
        error: 'Git checkout failed: branch already exists',
      })
      render(<SessionRow session={testSession} />)

      fireEvent.contextMenu(screen.getByTitle('CPA Directory Query'), {
        clientX: 100,
        clientY: 100,
      })

      const worktreeMenuItem = screen.getByTestId('session-menu-continue-worktree')
      await user.click(worktreeMenuItem)

      const confirmBtn = screen.getByTestId('confirm-worktree-fork-btn')
      await user.click(confirmBtn)

      expect(useUiStore.getState().toasts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Git checkout failed: branch already exists',
          }),
        ]),
      )

      const sessions = useSessionStore.getState().sessions
      const forkedSession = sessions.find((s) => s.id !== testSession.id)
      expect(forkedSession).toBeDefined()
      expect(useSessionStore.getState().currentSessionId).toBe(forkedSession?.id)
    })
  })

  describe('mobile browser environment', () => {
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

    it('does NOT show hover details card when clicked, directly selects session and closes sidebar', async () => {
      useUiStore.setState({ sidebarCollapsed: false })
      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      const link = screen.getByTitle('CPA Directory Query')
      // Simulate click / tap on mobile
      await user.click(link)

      // Detail hover card dialog must NEVER be shown on mobile
      expect(
        screen.queryByRole('dialog', { name: 'Details for “CPA Directory Query”' }),
      ).toBeNull()

      // Should mark session as read and switch current session
      expect(useSessionStore.getState().currentSessionId).toBe('session-cpa')
      expect(
        Boolean(
          useSessionStore
            .getState()
            .sessions.find((s) => s.id === 'session-cpa')?.unread,
        ),
      ).toBe(false)

      // Sidebar should be collapsed to switch view directly to chat window
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })

    it('does NOT open hover details on hover in mobile browser', async () => {
      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      const link = screen.getByTitle('CPA Directory Query')
      await user.hover(link)

      expect(
        screen.queryByRole('dialog', { name: 'Details for “CPA Directory Query”' }),
      ).toBeNull()
    })

    it('collapses sidebar on mobile when session is forked', async () => {
      useUiStore.setState({ sidebarCollapsed: false })
      const user = userEvent.setup()
      render(<SessionRow session={testSession} />)

      fireEvent.contextMenu(screen.getByTitle('CPA Directory Query'), {
        clientX: 100,
        clientY: 100,
      })

      const menuItem = screen.getByTestId('session-menu-continue-chat')
      await user.click(menuItem)

      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    })
  })
})
