import { useMemo, useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { agentsForParent, useSubAgentStore } from '@/stores/subAgentStore'
import { useFileChangeStore } from '@/stores/fileChangeStore'
import { useUiStore } from '@/stores/uiStore'
import { rendererRegistry } from '@/plugins/platform/rendererRegistry'
import { PinnedSummary } from './PinnedSummary'
import { PinnedSummaryToggle } from './WindowToolbar'

/**
 * Host-side stub for the plugin-owned pinned.summary.subagents slot.
 * Keeps PinnedSummary host tests independent of concrete plugin imports.
 */
function MockPinnedSubAgentsSection({ sessionId }: { sessionId?: string | null }) {
  const allAgents = useSubAgentStore((state) => state.agents)
  const openTab = useSubAgentStore((state) => state.openTab)
  const openRightPanelTab = useUiStore((state) => state.openRightPanelTab)
  const setRightSidebarCollapsed = useUiStore((state) => state.setRightSidebarCollapsed)
  const [open, setOpen] = useState(true)
  const agents = useMemo(
    () => (sessionId ? agentsForParent(allAgents, sessionId) : []),
    [allAgents, sessionId],
  )

  if (!sessionId || agents.length === 0) return null

  return (
    <section className="border-t border-[var(--border-subtle)] px-2 py-2">
      <h2 className="mb-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="pinned-summary-subagents-content"
          className="flex w-full items-center justify-between px-2 py-0.5 text-left text-[12px]"
        >
          <span>Subagents</span>
        </button>
      </h2>
      {open ? (
        <div id="pinned-summary-subagents-content" data-testid="subagent-list">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                openTab(sessionId, agent.id)
                openRightPanelTab('subagent', { activate: true })
                setRightSidebarCollapsed(false)
              }}
            >
              {agent.name}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

let unregisterPinnedSubagentsSlot: (() => void) | undefined

function mockRect(
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect)
}

function renderWithTranscript() {
  return render(
    <>
      <div data-testid="message-list-content">transcript</div>
      <PinnedSummary sessionId="sess-1" />
      <PinnedSummaryToggle />
      <button type="button">outside</button>
    </>,
  )
}

function AppShellLikeHarness() {
  const visible = useUiStore((state) => state.pinnedSummaryVisible)
  return (
    <>
      <div data-testid="message-list-content">transcript</div>
      {visible ? <PinnedSummary sessionId="sess-1" /> : null}
      <PinnedSummaryToggle />
      <button type="button">outside</button>
    </>
  )
}

function asDomRect(rect: {
  left: number
  top: number
  width: number
  height: number
}): DOMRect {
  return {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect
}

function mockOverlappingRects() {
  mockRect(screen.getByTestId('pinned-summary'), {
    left: 500,
    top: 20,
    width: 280,
    height: 300,
  })
  mockRect(screen.getByTestId('message-list-content'), {
    left: 100,
    top: 0,
    width: 768,
    height: 800,
  })
}

function userEntry(
  sessionId: string,
  id: string,
  text: string,
): ConversationEntry {
  return {
    id,
    sessionId,
    kind: 'user',
    version: 1,
    createdAt: 1,
    content: [{ type: 'text', text }],
  }
}

function setSessionTodoEntries(sessionId: string, todos: any[]) {
  useMessageStore.setState({
    entriesBySession: {
      ...useMessageStore.getState().entriesBySession,
      [sessionId]: [
        {
          id: `msg-todo-${sessionId}`,
          sessionId,
          createdAt: Date.now(),
          kind: 'assistant',
          status: 'done',
          content: [
            {
              type: 'toolCall',
              id: `call-todo-${sessionId}`,
              name: 'manage_todo_list',
              arguments: {
                operation: 'write',
                todoList: todos,
              },
            },
          ],
        } as any,
      ],
    },
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  unregisterPinnedSubagentsSlot?.()
  unregisterPinnedSubagentsSlot = rendererRegistry.registerSlot('pinned.summary.subagents', {
    id: 'pinned-summary-subagents-test',
    pluginId: 'test',
    order: 10,
    component: MockPinnedSubAgentsSection as any,
  })

  useMessageStore.setState({ entriesBySession: {} })
  useProjectStore.setState({
    projects: [
      {
        id: 'project-1',
        name: 'CLIProxyAPI',
        path: '/workspace/CLIProxyAPI',
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  useSessionStore.setState({
    currentSessionId: 'sess-1',
    sessions: [
      {
        id: 'sess-1',
        projectId: 'project-1',
        branch: 'dev',
        title: 'Dispatch model for arithmetic',
        pinned: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  })
  useSubAgentStore.setState({
    agents: [
      {
        id: 'ag-1',
        name: 'Kierkegaard',
        color: '#9b7dff',
        icon: 'sparkle',
        parentSessionId: 'sess-1',
        sessionId: 'ag-1',
        modelId: 'm',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    openTabIdsByParent: {},
    focusedIdByParent: {},
  })
  useUiStore.setState({
    rightSidebarCollapsed: true,
    pinnedSummaryVisible: true,
    pendingSessionContext: { projectId: null, branch: null },
  })
})

afterEach(() => {
  unregisterPinnedSubagentsSlot?.()
  unregisterPinnedSubagentsSlot = undefined
  vi.restoreAllMocks()
})

describe('PinnedSummary', () => {
  it('renders environment and sub-agent sections without sources', () => {
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.getByText('Environment')).toBeInTheDocument()
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('CLIProxyAPI')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('Subagents')).toBeInTheDocument()
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
    expect(screen.queryByText('Sources')).not.toBeInTheDocument()
  })

  it('hides the sources section when the current session has no invoked skills', () => {
    useMessageStore.getState().replaceSessionEntries('sess-1', [
      userEntry('sess-1', 'u1', 'plain question'),
    ])
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.queryByText('Sources')).not.toBeInTheDocument()
    expect(screen.queryByText('No sources')).not.toBeInTheDocument()
  })

  it('hides the sources section on a new chat with no session', () => {
    useMessageStore.getState().replaceSessionEntries('sess-1', [
      userEntry('sess-1', 'u1', '$gh-issue 4937'),
    ])
    render(<PinnedSummary sessionId={null} />)

    expect(screen.queryByText('Sources')).not.toBeInTheDocument()
    expect(screen.queryByText('Gh Issue')).not.toBeInTheDocument()
    expect(screen.queryByText('gh-issue')).not.toBeInTheDocument()
  })

  it('lists only skills invoked in the current session by display name', () => {
    useMessageStore.getState().replaceSessionEntries('sess-1', [
      userEntry('sess-1', 'u1', '$gh-issue 4937'),
      userEntry('sess-1', 'u2', '/skill:fix-issue please'),
    ])
    useMessageStore.getState().replaceSessionEntries('sess-2', [
      userEntry('sess-2', 'u3', '$cpa-plugin-pr-audit 12'),
    ])
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByText('Gh Issue')).toBeInTheDocument()
    expect(screen.getByText('Fix Issue')).toBeInTheDocument()
    expect(screen.queryByText('gh-issue')).not.toBeInTheDocument()
    expect(screen.queryByText('fix-issue')).not.toBeInTheDocument()
    expect(screen.queryByText('Cpa Plugin Pr Audit')).not.toBeInTheDocument()
  })

  it('opens the sub-agent sidebar when a listed agent is selected', async () => {
    const user = userEvent.setup()
    render(<PinnedSummary sessionId="sess-1" />)

    await user.click(screen.getByText('Kierkegaard'))

    expect(useSubAgentStore.getState().focusedIdByParent['sess-1']).toBe('ag-1')
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
    expect(useUiStore.getState().rightPanelActiveTab).toBe('subagent')
  })

  it('switches to subagent tab when right sidebar is already open on review page and an agent is selected', async () => {
    const user = userEvent.setup()
    useUiStore.setState({
      rightSidebarCollapsed: false,
      rightPanelActiveTab: 'review',
      rightPanelOpenTabs: ['review'],
    })
    render(<PinnedSummary sessionId="sess-1" />)

    await user.click(screen.getByText('Kierkegaard'))

    expect(useSubAgentStore.getState().focusedIdByParent['sess-1']).toBe('ag-1')
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
    expect(useUiStore.getState().rightPanelActiveTab).toBe('subagent')
  })

  it('hides the sub-agent section when the session has no sub-agents', () => {
    useSubAgentStore.setState({ agents: [] })
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.queryByText('Subagents')).not.toBeInTheDocument()
    expect(screen.queryByText('No subagents')).not.toBeInTheDocument()
  })

  it('hides on any click when it overlaps the message list and restores the toggle', async () => {
    const user = userEvent.setup()
    renderWithTranscript()
    mockOverlappingRects()

    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await user.click(screen.getByRole('button', { name: 'outside' }))

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('stays visible on click when it does not overlap the message list', async () => {
    const user = userEvent.setup()
    renderWithTranscript()

    mockRect(screen.getByTestId('pinned-summary'), {
      left: 1100,
      top: 20,
      width: 280,
      height: 300,
    })
    mockRect(screen.getByTestId('message-list-content'), {
      left: 200,
      top: 0,
      width: 768,
      height: 800,
    })

    await user.click(screen.getByRole('button', { name: 'outside' }))

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('does not hide on click when the message list is not mounted', async () => {
    const user = userEvent.setup()
    render(
      <>
        <PinnedSummary sessionId="sess-1" />
        <button type="button">outside</button>
      </>,
    )

    await user.click(screen.getByRole('button', { name: 'outside' }))

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
  })

  it('can open even when the expanded card would cover the transcript', async () => {
    useUiStore.setState({ pinnedSummaryVisible: false })
    const user = userEvent.setup()
    render(<AppShellLikeHarness />)

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const testId = this.getAttribute('data-testid')
        if (testId === 'pinned-summary') {
          return asDomRect({ left: 500, top: 20, width: 280, height: 300 })
        }
        if (testId === 'message-list-content') {
          return asDomRect({ left: 100, top: 0, width: 768, height: 800 })
        }
        return asDomRect({ left: 0, top: 0, width: 0, height: 0 })
      },
    )

    await user.click(screen.getByTestId('pinned-summary-toggle'))

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
    expect(screen.getByTestId('pinned-summary')).toBeInTheDocument()
    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('does not reopen when the overlapping card is dismissed via the toggle', async () => {
    const user = userEvent.setup()
    renderWithTranscript()
    mockOverlappingRects()

    await user.click(screen.getByTestId('pinned-summary-toggle'))

    expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('keeps sub-agent selection when an overlapping click dismisses the card', async () => {
    const user = userEvent.setup()
    renderWithTranscript()
    mockOverlappingRects()

    await user.click(screen.getByText('Kierkegaard'))

    expect(useSubAgentStore.getState().focusedIdByParent['sess-1']).toBe('ag-1')
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
    expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
    expect(screen.getByTestId('pinned-summary-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('renders todo items and progress when session has todos', () => {
    setSessionTodoEntries('sess-1', [
      {
        id: 1,
        title: 'Initialize project structure',
        description: 'Create directory layout',
        status: 'completed',
      },
      {
        id: 2,
        title: 'Implement feature A',
        description: 'Add core logic',
        status: 'in-progress',
      },
      {
        id: 3,
        title: 'Write tests',
        description: 'Cover all edge cases',
        status: 'not-started',
      },
    ])

    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.getByTestId('pinned-summary-todos')).toBeInTheDocument()
    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByTestId('pinned-summary-todo-progress').textContent).toBe('2/3')
    expect(screen.getByText('Initialize project structure')).toBeInTheDocument()
    expect(screen.getByText('Implement feature A')).toBeInTheDocument()
    expect(screen.getByText('Write tests')).toBeInTheDocument()
    expect(screen.getByTestId('todo-status-completed')).toBeInTheDocument()
    expect(screen.getByTestId('todo-status-in-progress')).toBeInTheDocument()
    expect(screen.getByTestId('todo-status-not-started')).toBeInTheDocument()
  })

  it('starts counting steps from 1 when all todos are not-started', () => {
    setSessionTodoEntries('sess-1', [
      {
        id: 1,
        title: 'Step one',
        description: 'First step',
        status: 'not-started',
      },
      {
        id: 2,
        title: 'Step two',
        description: 'Second step',
        status: 'not-started',
      },
    ])

    render(<PinnedSummary sessionId="sess-1" />)
    expect(screen.getByTestId('pinned-summary-todo-progress').textContent).toBe('1/2')
  })

  it('renders worktree layout with base branch and worktree branch when session is in worktree mode', () => {
    useSessionStore.setState({
      currentSessionId: 'sess-wt',
      sessions: [
        {
          id: 'sess-wt',
          projectId: 'project-1',
          branch: 'codex/feat-test',
          baseBranch: 'main',
          workLocation: 'worktree',
          worktreePath: '/worktrees/CLIProxyAPI-feat-test',
          title: 'Worktree session',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    render(<PinnedSummary sessionId="sess-wt" />)

    // Row 1 shows 'Worktree' instead of 'Local'
    expect(screen.getByText('Worktree')).toBeInTheDocument()
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.getByText('CLIProxyAPI')).toBeInTheDocument()

    // GitBranch row shows original checkout branch
    expect(screen.getByText('main')).toBeInTheDocument()

    // GitFork row shows worktree branch
    expect(screen.getByText('codex/feat-test')).toBeInTheDocument()
  })

  it('renders worktree row when pending session context has workLocation worktree', () => {
    useUiStore.setState({
      pendingSessionContext: {
        projectId: 'project-1',
        branch: 'codex/pending-branch',
        workLocation: 'worktree',
      },
    })

    render(<PinnedSummary sessionId={null} />)

    expect(screen.getByText('Worktree')).toBeInTheDocument()
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.getByText('codex/pending-branch')).toBeInTheDocument()
  })

  it('hides the todo section when session has no todos', () => {
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.queryByTestId('pinned-summary-todos')).not.toBeInTheDocument()
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument()
  })

  it('renders changes row with +0 -0 when session has no file changes', () => {
    useFileChangeStore.getState().clearAll()
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.getByText('Changes')).toBeInTheDocument()
    expect(screen.getByTestId('pinned-summary-changes-stats')).toHaveTextContent('+0 -0')
  })

  it('renders changes row with +additions and -deletions when session has file changes', () => {
    useFileChangeStore.getState().recordChange('sess-1', {
      path: 'src/main.ts',
      additions: 88,
      deletions: 18,
    })
    render(<PinnedSummary sessionId="sess-1" />)

    expect(screen.getByText('Changes')).toBeInTheDocument()
    const stats = screen.getByTestId('pinned-summary-changes-stats')
    expect(stats).toHaveTextContent('+88')
    expect(stats).toHaveTextContent('-18')
  })

  it('allows collapsing and expanding the environment section', async () => {
    const user = userEvent.setup()
    render(<PinnedSummary sessionId="sess-1" />)

    const envButton = screen.getByRole('button', { name: /Environment/i })
    expect(envButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('CLIProxyAPI')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()

    await user.click(envButton)

    expect(envButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('CLIProxyAPI')).not.toBeInTheDocument()
    expect(screen.queryByText('dev')).not.toBeInTheDocument()

    await user.click(envButton)

    expect(envButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('CLIProxyAPI')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
  })

  it('allows collapsing and expanding the sub-agents section', async () => {
    const user = userEvent.setup()
    render(<PinnedSummary sessionId="sess-1" />)

    const subAgentButton = screen.getByRole('button', { name: /Subagents/i })
    expect(subAgentButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()

    await user.click(subAgentButton)

    expect(subAgentButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Kierkegaard')).not.toBeInTheDocument()

    await user.click(subAgentButton)

    expect(subAgentButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Kierkegaard')).toBeInTheDocument()
  })

  it('allows collapsing and expanding the todos section while keeping progress visible', async () => {
    const user = userEvent.setup()
    setSessionTodoEntries('sess-1', [
      {
        id: 1,
        title: 'Initialize project structure',
        description: 'Create directory layout',
        status: 'completed',
      },
    ])

    render(<PinnedSummary sessionId="sess-1" />)

    const todoButton = screen.getByRole('button', { name: /Tasks/i })
    expect(todoButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Initialize project structure')).toBeInTheDocument()
    expect(screen.getByTestId('pinned-summary-todo-progress')).toHaveTextContent('1/1')

    await user.click(todoButton)

    expect(todoButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Initialize project structure')).not.toBeInTheDocument()
    expect(screen.getByTestId('pinned-summary-todo-progress')).toHaveTextContent('1/1')

    await user.click(todoButton)

    expect(todoButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Initialize project structure')).toBeInTheDocument()
  })

  it('allows collapsing and expanding the sources section', async () => {
    const user = userEvent.setup()
    useMessageStore.getState().replaceSessionEntries('sess-1', [
      userEntry('sess-1', 'u1', '$gh-issue 4937'),
    ])

    render(<PinnedSummary sessionId="sess-1" />)

    const sourcesButton = screen.getByRole('button', { name: /Sources/i })
    expect(sourcesButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Gh Issue')).toBeInTheDocument()

    await user.click(sourcesButton)

    expect(sourcesButton).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Gh Issue')).not.toBeInTheDocument()

    await user.click(sourcesButton)

    expect(sourcesButton).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Gh Issue')).toBeInTheDocument()
  })

  it('opens review tab in right sidebar when clicking changes summary row', async () => {
    const user = userEvent.setup()
    useUiStore.setState({ rightSidebarCollapsed: true, rightPanelActiveTab: null, rightPanelOpenTabs: [] })
    useFileChangeStore.getState().recordChange('sess-1', {
      path: 'src/main.ts',
      additions: 10,
      deletions: 2,
    })

    render(<PinnedSummary sessionId="sess-1" />)

    const changesRow = screen.getByTestId('pinned-summary-changes-row')
    expect(changesRow).toBeInTheDocument()

    await user.click(changesRow)

    expect(useUiStore.getState().rightPanelActiveTab).toBe('review')
    expect(useUiStore.getState().rightPanelOpenTabs).toContain('review')
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
  })
})
