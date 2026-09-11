import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { DisplayMessage } from '../types.js'
import { MessageList } from './MessageList.js'

describe('MessageList inline skill menu containment', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it.each([false, true])('does not paint-contain user edit menus (compact=%s)', (compactActivity) => {
        const services = {
            skillUsage: {
                getAvailableSkills: () => skills,
            },
        }
        const skills = [{ name: 'gh-issue' }]
        const messages: DisplayMessage[] = [
            {
                kind: 'message', id: 'u1', sessionId: 's1', role: 'user',
                content: 'hello', parts: [{ type: 'text', text: 'hello' }], createdAt: 1000,
            },
            {
                kind: 'message', id: 'a1', sessionId: 's1', role: 'assistant',
                content: 'reply', parts: [{ type: 'text', text: 'reply' }], createdAt: 2000,
            },
        ]
        const { container } = render(
            <HostServicesProvider services={services as any}>
                <MessageList
                    compactActivity={compactActivity}
                    messages={messages}
                    onEditMessage={() => undefined}
                />
            </HostServicesProvider>,
        )
        fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
        const editor = screen.getByTestId('message-edit-input')
        editor.focus()
        editor.textContent = '$'
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        fireEvent.input(editor)
        const menu = screen.getByTestId('message-edit-skill-menu')
        // jsdom cannot paint; guard every ancestor against reintroducing paint containment.
        for (let parent = menu.parentElement; parent; parent = parent.parentElement) {
            expect(parent).not.toHaveClass('[content-visibility:auto]')
        }
        // Assistant rows retain the rendering optimization.
        expect(container.querySelector('[class*="content-visibility:auto"]')).not.toBeNull()
    })
})

describe('MessageList compact thinking placeholder', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('shows the processed timer before the first visible assistant token', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: now,
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.queryByTestId('turn-thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.getByTestId('turn-header')).toHaveTextContent('Processed 0s')
  })

  it('keeps the processed timer while a streaming assistant has no visible tokens', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: now,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: now,
        parts: [{ type: 'thinking', thinking: 'planning' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.queryByTestId('turn-thinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Thinking')).not.toBeInTheDocument()
    expect(screen.getByTestId('turn-header')).toHaveTextContent('Processed 0s')
  })

  it('uses one turn header for every assistant stage in a request', () => {
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: 10,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'first',
        status: 'done',
        createdAt: 20,
        completedAt: 30,
        parts: [{ type: 'text', text: 'first' }],
      },
      {
        kind: 'message',
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: 'final',
        status: 'done',
        createdAt: 40,
        completedAt: 70_000,
        parts: [{ type: 'text', text: 'final' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getAllByTestId('turn-header')).toHaveLength(1)
    expect(screen.getByTestId('turn-header')).toHaveTextContent('Completed 1m 9s')
    expect(screen.getByText('final')).toBeInTheDocument()
    expect(screen.queryByText('first')).not.toBeInTheDocument()
  })

  it('keeps the original processed timer while compacting', () => {
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: Date.now(),
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        isCompacting
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('turn-header')
    const pending = screen.getByRole('status', { name: 'Compacting context' })
    expect(header).toHaveTextContent('Processed 0s')
    expect(pending).toHaveTextContent('Compacting context')
    expect(screen.queryByRole('separator', { name: 'Context compacted' })).not.toBeInTheDocument()
    expect(
      header.compareDocumentPosition(pending) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('shows the compacting divider in the completed-divider slot', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: now - 20_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'before',
        status: 'done',
        createdAt: now - 10_000,
        completedAt: now - 5_000,
        parts: [{ type: 'text', text: 'before' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        isCompacting
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('turn-header')
    const pending = screen.getByRole('status', { name: 'Compacting context' })
    expect(screen.getAllByTestId('turn-header')).toHaveLength(1)
    expect(header).toHaveTextContent('Processed')
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Context compacted' })).not.toBeInTheDocument()
    expect(
      screen.getByText('before').compareDocumentPosition(pending) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the original turn timer above a compaction divider', () => {
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: 10_000,
      },
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: 20_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'result',
        status: 'done',
        createdAt: 25_000,
        completedAt: 40_000, // 40_000 - 10_000 = 30 seconds
        parts: [{ type: 'text', text: 'result' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('turn-header')
    const divider = screen.getByRole('separator', { name: 'Context compacted' })
    expect(header).toHaveTextContent('Completed 30s')
    expect(screen.getAllByTestId('turn-header')).toHaveLength(1)
    expect(
      header.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('does not start a second processed timer below compaction', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'hello',
        parts: [{ type: 'text', text: 'hello' }],
        createdAt: now - 90_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'before',
        status: 'done',
        createdAt: now - 80_000,
        completedAt: now - 40_000,
        parts: [{ type: 'text', text: 'before' }],
      },
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: now - 30_000,
      },
      {
        kind: 'message',
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: 'after',
        status: 'streaming',
        createdAt: now - 10_000,
        parts: [{ type: 'text', text: 'after' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('turn-header')
    const divider = screen.getByRole('separator', { name: 'Context compacted' })
    expect(screen.getAllByTestId('turn-header')).toHaveLength(1)
    expect(header).toHaveTextContent('Processed')
    expect(header).toHaveTextContent('1m')
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(
      header.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      divider.compareDocumentPosition(screen.getByText('after')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('aggregates tool messages into a single activity stack per stage and renders exactly one action bar in turns with compaction', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'fix issue',
        parts: [{ type: 'text', text: 'fix issue' }],
        createdAt: now - 50_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: now - 45_000,
        parts: [
          {
            type: 'tool_call',
            id: 'tc1',
            name: 'read',
            args: { path: 'file1.go' },
            status: 'done',
            result: 'package main',
          },
        ],
      },
      {
        kind: 'message',
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: now - 40_000,
        parts: [
          {
            type: 'tool_call',
            id: 'tc2',
            name: 'edit',
            args: { path: 'file1.go' },
            status: 'done',
            result: 'ok',
          },
        ],
      },
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: now - 30_000,
      },
      {
        kind: 'message',
        id: 'a3',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: now - 20_000,
        parts: [
          {
            type: 'tool_call',
            id: 'tc3',
            name: 'bash',
            args: { command: 'go test' },
            status: 'done',
            result: 'PASS',
          },
        ],
      },
      {
        kind: 'message',
        id: 'a4',
        sessionId: 's1',
        role: 'assistant',
        content: 'All tests pass!',
        status: 'done',
        createdAt: now - 10_000,
        completedAt: now,
        parts: [{ type: 'text', text: 'All tests pass!' }],
      },
    ]

    render(
      <MessageList
        compactActivity
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    // 1. Exactly one turn header
    expect(screen.getAllByTestId('turn-header')).toHaveLength(1)

    // 2. In collapsed mode, only 1 action bar at the bottom
    expect(screen.getAllByTestId('assistant-message-actions')).toHaveLength(1)

    // Click turn-header toggle to expand history
    const toggleButton = screen.getByTestId('turn-header').querySelector('button')!
    expect(toggleButton).toBeTruthy()
    fireEvent.click(toggleButton)

    // 3. When expanded, exactly one action bar at the bottom, NOT one per message!
    expect(screen.getAllByTestId('assistant-message-actions')).toHaveLength(1)

    // 4. Consecutive tools in stage 1 (a1, a2) are aggregated into 1 ToolActivityStack,
    //    and stage 2 has 1 ToolActivityStack for tc3. Total = 2 (one before compaction, one after).
    expect(screen.getAllByTestId('tool-activity')).toHaveLength(2)

    // 5. Compaction divider is rendered
    expect(screen.getByRole('separator', { name: 'Context compacted' })).toBeInTheDocument()
  })

  it('does not shimmer completed tools before compaction even when the turn is actively streaming', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'fix bug',
        parts: [{ type: 'text', text: 'fix bug' }],
        createdAt: now - 30_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: now - 20_000,
        parts: [
          {
            type: 'tool_call',
            id: 'call_1788754918705408000_966|fc_call_1788754918705408000_966',
            name: 'read',
            args: { path: 'file1.ts' },
            status: 'done',
            result: 'const x = 1',
          },
        ],
      },
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: now - 10_000,
      },
      {
        kind: 'message',
        id: 'a2',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: now - 5_000,
        parts: [
          {
            type: 'tool_call',
            id: 'tc-active',
            name: 'bash',
            args: { command: 'pnpm test' },
            status: 'running',
          },
        ],
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    // Two tool activity stacks: one before compaction, one after
    const toolActivities = screen.getAllByTestId('tool-activity')
    expect(toolActivities).toHaveLength(2)

    const latestLabels = screen.getAllByTestId('tool-activity-latest')
    expect(latestLabels).toHaveLength(2)

    // The tool before compaction is completed and cut by compaction -> must NOT shimmer
    expect(latestLabels[0]?.className).not.toContain('animate-text-shimmer')

    // The active tool after compaction is currently running -> SHOULD shimmer
    expect(latestLabels[1]?.className).toContain('animate-text-shimmer')
  })

  it('does not shimmer completed tools when currently compacting (isCompacting=true)', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'fix bug',
        parts: [{ type: 'text', text: 'fix bug' }],
        createdAt: now - 20_000,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done',
        createdAt: now - 10_000,
        parts: [
          {
            type: 'tool_call',
            id: 'call_finished',
            name: 'edit',
            args: { path: 'file1.ts' },
            status: 'done',
            result: 'ok',
          },
        ],
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        isCompacting
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    // The completed tool before compaction divider must NOT shimmer
    const latestLabel = screen.getByTestId('tool-activity-latest')
    expect(latestLabel.className).not.toContain('animate-text-shimmer')
  })
})

describe('MessageList stick-to-bottom', () => {
  function userMessage(id: string, text: string): DisplayMessage {
    return {
      kind: 'message',
      id,
      sessionId: 's1',
      role: 'user',
      content: text,
      parts: [{ type: 'text', text }],
      createdAt: 1,
    }
  }

  function mockScroller(
    element: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number },
  ) {
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => metrics.scrollHeight,
    })
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get: () => metrics.clientHeight,
    })
  }

  function assistantMessage(id: string, text: string): DisplayMessage {
    return {
      kind: 'message',
      id,
      sessionId: 's1',
      role: 'assistant',
      content: text,
      status: 'streaming',
      parts: [{ type: 'text', text }],
      createdAt: 2,
    }
  }

  it('does not follow streaming assistant content after the user scrolls away from the bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    const { rerender } = render(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )
    const scroller = screen.getByTestId('message-list-scroller')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 600
    fireEvent.scroll(scroller)

    scroller.scrollTop = 20
    fireEvent.scroll(scroller)

    rerender(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one'), assistantMessage('a1', 'streaming response')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(20)
  })

  it('jumps to bottom when user sends a new message even if scrolled away from bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    const { rerender } = render(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )
    const scroller = screen.getByTestId('message-list-scroller')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 600
    fireEvent.scroll(scroller)

    scroller.scrollTop = 20
    fireEvent.scroll(scroller)

    rerender(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one'), userMessage('u2', 'two')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(800)
  })

  it('resumes following after the user returns to the bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    const { rerender } = render(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )
    const scroller = screen.getByTestId('message-list-scroller')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 20
    fireEvent.scroll(scroller)

    scroller.scrollTop = 760
    fireEvent.scroll(scroller)

    rerender(
      <MessageList
        sessionKey="s1"
        messages={[userMessage('u1', 'one'), userMessage('u2', 'two')]}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(800)
  })

  it('resets the turn timer from zero when an edited user message is resent', () => {
    const resentAt = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'edited prompt',
        parts: [{ type: 'text', text: 'edited prompt' }],
        createdAt: resentAt,
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const header = screen.getByTestId('turn-header')
    expect(header).toHaveTextContent('Processed 0s')
  })

  it('forwards retry action to onRetryMessage in compact mode', () => {
    const onRetryMock = vi.fn()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'do something',
        parts: [{ type: 'text', text: 'do something' }],
        createdAt: 10,
      },
      {
        kind: 'message',
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'error',
        errorMessage: 'Network connection failed',
        createdAt: 20,
      },
    ]

    render(
      <MessageList
        compactActivity
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onRetryMessage={onRetryMock}
      />,
    )

    expect(screen.getByText('Network connection failed')).toBeInTheDocument()
    const retryButton = screen.getByRole('button', { name: /Retry/i })
    fireEvent.click(retryButton)
    expect(onRetryMock).toHaveBeenCalledWith('a1')
  })

  it('windows older turns when turns count exceeds threshold and expands on button click', () => {
    const messages: DisplayMessage[] = Array.from({ length: 6 }, (_, i) => ({
      kind: 'message',
      id: `u${i + 1}`,
      sessionId: 's1',
      role: 'user',
      content: `User turn ${i + 1}`,
      parts: [{ type: 'text', text: `User turn ${i + 1}` }],
      createdAt: 1000 + i * 10,
    }))

    render(
      <MessageList
        compactActivity
        messages={messages}
        maxInitialTurns={3}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    const expandButton = screen.getByTestId('load-earlier-turns-button')
    expect(expandButton).toBeInTheDocument()
    expect(expandButton).toHaveTextContent('3')

    expect(screen.queryByText('User turn 1')).not.toBeInTheDocument()
    expect(screen.queryByText('User turn 2')).not.toBeInTheDocument()
    expect(screen.queryByText('User turn 3')).not.toBeInTheDocument()
    expect(screen.getByText('User turn 4')).toBeInTheDocument()
    expect(screen.getByText('User turn 5')).toBeInTheDocument()
    expect(screen.getByText('User turn 6')).toBeInTheDocument()

    fireEvent.click(expandButton)

    expect(screen.queryByTestId('load-earlier-turns-button')).not.toBeInTheDocument()
    expect(screen.getByText('User turn 1')).toBeInTheDocument()
    expect(screen.getByText('User turn 2')).toBeInTheDocument()
    expect(screen.getByText('User turn 3')).toBeInTheDocument()
    expect(screen.getByText('User turn 4')).toBeInTheDocument()
    expect(screen.getByText('User turn 5')).toBeInTheDocument()
    expect(screen.getByText('User turn 6')).toBeInTheDocument()
  })

  it('keeps prior assistant turn live and does not render pending-assistant-turn when user message has pendingStatus', () => {
    const now = Date.now()
    const messages: DisplayMessage[] = [
      {
        kind: 'message',
        id: 'u0',
        sessionId: 's1',
        role: 'user',
        content: 'first request',
        parts: [{ type: 'text', text: 'first request' }],
        createdAt: now - 5000,
      },
      {
        kind: 'message',
        id: 'a0',
        sessionId: 's1',
        role: 'assistant',
        content: '',
        status: 'done', // LLM request finished, tool executing
        createdAt: now - 4000,
        parts: [
          {
            type: 'tool_call',
            id: 'call_bash',
            name: 'bash',
            args: { command: 'sleep 5' },
            status: 'running',
          },
        ],
      },
      {
        kind: 'message',
        id: 'u-steer',
        sessionId: 's1',
        role: 'user',
        content: 'steer message while tool running',
        pendingStatus: 'steer',
        parts: [{ type: 'text', text: 'steer message while tool running' }],
        createdAt: now - 1000,
      },
    ]

    render(
      <MessageList
        compactActivity
        isRunActive
        messages={messages}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    // Exactly one TurnHeader should be rendered (for the active assistant turn a0), not two!
    const turnHeaders = screen.getAllByTestId('turn-header')
    expect(turnHeaders).toHaveLength(1)

    // The active assistant turn must NOT show completed text
    expect(turnHeaders[0]).not.toHaveTextContent('Completed')

    // Actions toolbar must NOT appear prematurely while prior turn is still running
    expect(screen.queryByTestId('assistant-message-actions')).not.toBeInTheDocument()
  })
})
