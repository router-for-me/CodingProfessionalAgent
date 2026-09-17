import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SubAgentRecord } from '@cpa/plugin-api'

const pluginMessageHostCalls: Array<Record<string, unknown>> = []

vi.mock('@cpa/plugin-ui', async () => {
  const actual = await vi.importActual<typeof import('@cpa/plugin-ui')>('@cpa/plugin-ui')
  return {
    ...actual,
    PluginMessageHost: (props: Record<string, unknown>) => {
      pluginMessageHostCalls.push(props)
      const message = (props.message ?? props.value) as { id?: string } | undefined
      return (
        <div data-testid={`plugin-message-${message?.id ?? 'unknown'}`}>
          {props.compactActivity ? 'compact' : 'full'}
        </div>
      )
    },
    useDisplayMessages: () => (globalThis as any).__subagentTestMessages ?? [],
    useToolOverlays: () => ({}),
    useIsCompacting: () => false,
    useChatRenderers: () => [],
    useTranslation: () => ({
      t: (key: string, fallback?: string) => fallback ?? key,
      i18n: { language: 'zh-CN' },
    }),
    useHostServices: () => ({
      chatMessages: {
        ensureSessionLoaded: vi.fn(),
        getEntries: () => [],
        subscribeMessages: () => () => {},
      },
      models: {
        getModels: () => [],
      },
      sessions: {
        getSessions: () => [],
        getActiveSessionId: () => null,
        getActiveModelId: () => null,
      },
    }),
  }
})

vi.mock('./ContextUsageRingAdapter.js', () => ({
  ContextUsageRing: () => <div data-testid="context-usage-ring" />,
}))

vi.mock('./SubAgentMetaText.js', () => ({
  SubAgentMetaText: () => <span data-testid="subagent-meta" />,
}))

import {
  mergeAssistantMessages,
  SubAgentConversation,
} from './SubAgentConversation.js'

const runningAgent: SubAgentRecord = {
  id: 'ag-1',
  name: 'Explorer',
  color: '#9b7dff',
  icon: 'sparkle',
  parentSessionId: 'parent-1',
  sessionId: 'ag-1',
  modelId: 'm',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
}

function assistant(
  id: string,
  createdAt: number,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    kind: 'message',
    id,
    sessionId: 'ag-1',
    role: 'assistant',
    content: '',
    parts: [],
    status,
    createdAt,
    ...extra,
  }
}

describe('mergeAssistantMessages', () => {
  it('concatenates parts across assistant stages in one turn', () => {
    const merged = mergeAssistantMessages(
      [
        assistant('a1', 20, 'done', {
          parts: [{ type: 'text', text: 'first' }],
          content: 'first',
        }),
        assistant('a2', 40, 'done', {
          completedAt: 80,
          parts: [
            {
              type: 'tool_call',
              id: 't1',
              name: 'bash',
              args: { command: 'ls' },
              status: 'running',
            },
          ],
          content: '',
        }),
      ],
      10,
    )

    expect(merged.createdAt).toBe(10)
    expect(merged.completedAt).toBe(80)
    expect(merged.status).toBe('done')
    expect(merged.parts).toHaveLength(2)
    expect(merged.parts[1]).toMatchObject({ type: 'tool_call', id: 't1' })
  })

  it('stays streaming while the live turn is still active', () => {
    const merged = mergeAssistantMessages(
      [
        assistant('a1', 20, 'done', {
          completedAt: 30,
          parts: [
            {
              type: 'tool_call',
              id: 't1',
              name: 'bash',
              args: { command: 'ls' },
              status: 'running',
            },
          ],
        }),
      ],
      10,
      true,
    )

    expect(merged.status).toBe('streaming')
    expect(merged.completedAt).toBeUndefined()
    expect(merged.parts).toHaveLength(1)
  })

  it('keeps earlier tool calls when a later empty streaming stage arrives', () => {
    const merged = mergeAssistantMessages(
      [
        assistant('a1', 20, 'done', {
          parts: [
            {
              type: 'tool_call',
              id: 't1',
              name: 'read',
              args: { path: 'a.ts' },
              status: 'done',
            },
          ],
        }),
        assistant('a2', 40, 'streaming', {
          content: '',
          parts: [],
        }),
      ],
      10,
      true,
    )

    expect(merged.status).toBe('streaming')
    expect(merged.parts).toEqual([
      expect.objectContaining({ type: 'tool_call', id: 't1', name: 'read' }),
    ])
  })

  it('does not stay streaming when live is false even if an assistant message has streaming status', () => {
    const merged = mergeAssistantMessages(
      [
        assistant('a1', 20, 'streaming', {
          content: 'final answer',
          parts: [{ type: 'text', text: 'final answer' }],
        }),
      ],
      10,
      false,
      undefined,
      5000,
    )

    expect(merged.status).toBe('done')
    expect(merged.completedAt).toBe(5000)
    expect(merged.content).toBe('final answer')
  })
})

describe('SubAgentConversation live tool visibility', () => {
  it('passes a merged streaming assistant message that retains earlier tool calls', () => {
    pluginMessageHostCalls.length = 0
    ;(globalThis as any).__subagentTestMessages = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 'ag-1',
        role: 'user',
        content: 'inspect files',
        status: 'done',
        createdAt: 10,
      },
      assistant('a1', 20, 'done', {
        completedAt: 25,
        parts: [
          {
            type: 'tool_call',
            id: 't1',
            name: 'bash',
            args: { command: 'ls -la' },
            status: 'running',
          },
        ],
      }),
      assistant('a2', 30, 'streaming', {
        content: '',
        parts: [],
      }),
    ]

    render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    expect(screen.getByTestId('plugin-message-a1')).toBeInTheDocument()

    const assistantCall = pluginMessageHostCalls.find((call) => {
      const message = call.message as { role?: string; parts?: unknown[] }
      return message?.role === 'assistant'
    })

    expect(assistantCall).toBeTruthy()
    expect(assistantCall?.isRunActive).toBe(true)
    expect(assistantCall?.compactActivity).toBe(true)
    expect(assistantCall?.message).toMatchObject({
      id: 'a1',
      status: 'streaming',
      parts: [
        expect.objectContaining({
          type: 'tool_call',
          id: 't1',
          name: 'bash',
          status: 'running',
        }),
      ],
    })
    expect((assistantCall?.message as { completedAt?: number }).completedAt).toBeUndefined()
  })

  it('renders completed non-streaming assistant message when subagent is completed even if message was left streaming', () => {
    pluginMessageHostCalls.length = 0
    ;(globalThis as any).__subagentTestMessages = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 'ag-1',
        role: 'user',
        content: 'run review',
        status: 'done',
        createdAt: 1000,
      },
      assistant('a1', 2000, 'streaming', {
        content: 'Review finished with RESOLVED',
        parts: [{ type: 'text', text: 'Review finished with RESOLVED' }],
      }),
    ]

    const completedAgent: SubAgentRecord = {
      ...runningAgent,
      status: 'completed',
      completedAt: 45000,
      updatedAt: 45000,
    }

    render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={completedAgent}
        onBack={() => undefined}
      />,
    )

    expect(screen.getByTestId('plugin-message-a1')).toBeInTheDocument()

    const assistantCall = pluginMessageHostCalls.find((call) => {
      const message = call.message as { role?: string; parts?: unknown[] }
      return message?.role === 'assistant'
    })

    expect(assistantCall).toBeTruthy()
    expect(assistantCall?.isRunActive).toBe(false)
    expect(assistantCall?.message).toMatchObject({
      id: 'a1',
      status: 'done',
      completedAt: 45000,
      content: 'Review finished with RESOLVED',
    })
  })
})

describe('SubAgentConversation stick-to-bottom scrolling', () => {
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

  function userMessage(id: string, text: string) {
    return {
      kind: 'message',
      id,
      sessionId: 'ag-1',
      role: 'user',
      content: text,
      status: 'done',
      createdAt: 10,
    }
  }

  function streamingAssistant(id: string, text: string) {
    return assistant(id, 20, 'streaming', {
      content: text,
      parts: [{ type: 'text', text }],
    })
  }

  it('does not follow streaming content after the user scrolls away from the bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    ;(globalThis as any).__subagentTestMessages = [userMessage('u1', 'one')]

    const { rerender } = render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    const scroller = screen.getByTestId('subagent-message-list')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 600
    fireEvent.scroll(scroller)

    scroller.scrollTop = 20
    fireEvent.scroll(scroller)

    ;(globalThis as any).__subagentTestMessages = [
      userMessage('u1', 'one'),
      streamingAssistant('a1', 'streaming response'),
    ]
    rerender(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(20)
  })

  it('keeps following streaming content while pinned to the bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    ;(globalThis as any).__subagentTestMessages = [userMessage('u1', 'one')]

    const { rerender } = render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    const scroller = screen.getByTestId('subagent-message-list')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 760
    fireEvent.scroll(scroller)

    ;(globalThis as any).__subagentTestMessages = [
      userMessage('u1', 'one'),
      streamingAssistant('a1', 'streaming response'),
    ]
    rerender(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(800)
  })

  it('resumes following after the user returns to the bottom', () => {
    const metrics = { scrollHeight: 800, clientHeight: 200 }
    ;(globalThis as any).__subagentTestMessages = [userMessage('u1', 'one')]

    const { rerender } = render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    const scroller = screen.getByTestId('subagent-message-list')
    mockScroller(scroller, metrics)
    scroller.scrollTop = 20
    fireEvent.scroll(scroller)

    scroller.scrollTop = 760
    fireEvent.scroll(scroller)

    ;(globalThis as any).__subagentTestMessages = [
      userMessage('u1', 'one'),
      streamingAssistant('a1', 'more content'),
    ]
    rerender(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    expect(scroller.scrollTop).toBe(800)
  })
})

describe('SubAgentConversation follow-up messages', () => {
  it('renders multiple user messages from spawn and send_message across turns', () => {
    pluginMessageHostCalls.length = 0
    ;(globalThis as any).__subagentTestMessages = [
      {
        kind: 'message',
        id: 'u1',
        sessionId: 'ag-1',
        role: 'user',
        content: 'Initial prompt from spawn_agent',
        status: 'done',
        createdAt: 100,
      },
      assistant('a1', 200, 'done', {
        content: 'Reply to initial prompt',
        parts: [{ type: 'text', text: 'Reply to initial prompt' }],
      }),
      {
        kind: 'message',
        id: 'u2',
        sessionId: 'ag-1',
        role: 'user',
        content: 'Follow-up message from send_message',
        status: 'done',
        createdAt: 300,
      },
      assistant('a2', 400, 'streaming', {
        content: 'Reply to follow-up',
        parts: [{ type: 'text', text: 'Reply to follow-up' }],
      }),
    ]

    render(
      <SubAgentConversation
        sessionId="parent-1"
        agent={runningAgent}
        onBack={() => undefined}
      />,
    )

    // Verify both the initial user message and follow-up user message are rendered
    expect(screen.getByTestId('plugin-message-u1')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-message-u2')).toBeInTheDocument()

    const u1Call = pluginMessageHostCalls.find((call) => (call.message as any)?.id === 'u1')
    const u2Call = pluginMessageHostCalls.find((call) => (call.message as any)?.id === 'u2')

    expect(u1Call?.message).toMatchObject({
      role: 'user',
      content: 'Initial prompt from spawn_agent',
    })
    expect(u2Call?.message).toMatchObject({
      role: 'user',
      content: 'Follow-up message from send_message',
    })
  })
})
