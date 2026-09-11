import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { HostServicesProvider } from '@cpa/plugin-ui'
import type { DisplayChatMessage } from '../types.js'
import {
  AssistantMessageRenderer,
  AssistantText,
  MessageItem,
  UserMessageRenderer,
} from './MessageItem.js'

function setContentEditableValue(element: HTMLElement, value: string) {
    element.focus()
    element.textContent = value
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    fireEvent.input(element)
}

describe('MessageItem user actions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  const message: DisplayChatMessage = {
    kind: 'message',
    id: 'u1',
    sessionId: 's1',
    role: 'user',
    content: 'Original content',
    parts: [{ type: 'text', text: 'Original content' }],
    createdAt: 1000,
  }

  it('copies user text to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <MessageItem
        message={message}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onEditMessage={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Copy/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Original content'))
  })

  it('restores original content when edit is cancelled', () => {
    render(
      <MessageItem
        message={message}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onEditMessage={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const input = screen.getByTestId('message-edit-input')
    setContentEditableValue(input, 'Temporary edit')
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))

    expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument()
    expect(screen.getByText('Original content')).toBeInTheDocument()
  })

  it('submits edited text when saved', async () => {
    const onEditMessage = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageItem
        message={message}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onEditMessage={onEditMessage}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const input = screen.getByTestId('message-edit-input')
    setContentEditableValue(input, 'Updated content')
    fireEvent.click(screen.getByRole('button', { name: /Send/i }))

    await waitFor(() => {
      expect(onEditMessage).toHaveBeenCalledWith('u1', 'Updated content')
    })
    expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument()
  })

  it('renders skill chip in user message bubble', () => {
    render(
      <MessageItem
        message={{
          ...message,
          content: '$gh-issue 4937',
          parts: [{ type: 'text', text: '$gh-issue 4937' }],
        }}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('user-skill-chip')).toBeInTheDocument()
    expect(screen.getByText('Gh Issue')).toBeInTheDocument()
  })

  it('converts $skill tokens to chips when editing a historical message', () => {
    const skills = [
      {
        name: 'gh-issue',
        description: 'Triage',
        filePath: '/skills/gh-issue/SKILL.md',
        baseDir: '/skills/gh-issue',
      },
    ]
    const hostServices = {
      skillUsage: {
        getAvailableSkills: () => skills,
      },
    }

    render(
      <HostServicesProvider services={hostServices as any}>
        <MessageItem
          message={{
            ...message,
            content: '$gh-issue 4793',
            parts: [{ type: 'text', text: '$gh-issue 4793' }],
          }}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
          onEditMessage={() => undefined}
        />
      </HostServicesProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }))

    const editor = screen.getByTestId('message-edit-input')
    expect(screen.getByTestId('composer-skill-chip')).toHaveTextContent('Gh Issue')
    expect(editor).toHaveAttribute('data-value', '$gh-issue 4793')
  })

  it.each(['', '你是做什么的？'])('shows a skill menu after "%s" in the edit box', (prefix) => {
    const skills = [
      {
        name: 'gh-issue',
        description: 'Triage GitHub issues',
        filePath: '/skills/gh-issue/SKILL.md',
        baseDir: '/skills/gh-issue',
      },
      {
        name: 'fix-issue',
        description: 'Fix an issue',
        filePath: '/skills/fix-issue/SKILL.md',
        baseDir: '/skills/fix-issue',
      },
    ]
    const hostServices = {
      skillUsage: {
        getAvailableSkills: () => skills,
      },
    }

    render(
      <HostServicesProvider services={hostServices as any}>
        <MessageItem
          message={message}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
          onEditMessage={() => undefined}
        />
      </HostServicesProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const editor = screen.getByTestId('message-edit-input')
    setContentEditableValue(editor, `${prefix}$`)

    const menu = screen.getByTestId('message-edit-skill-menu')
    expect(menu).toBeInTheDocument()
    expect(menu).toHaveAttribute('role', 'listbox')
    expect(menu).toHaveAttribute('aria-label', 'Skills')
    expect(screen.getByRole('option', { name: /Gh Issue/i })).toHaveTextContent(
      'Triage GitHub issues',
    )
    expect(screen.getByRole('option', { name: /Fix Issue/i })).toHaveTextContent(
      'Fix an issue',
    )
    expect(screen.getAllByText('Personal').length).toBeGreaterThan(0)
    expect(screen.queryByText('$gh-issue')).not.toBeInTheDocument()

    fireEvent.mouseDown(screen.getByRole('option', { name: /Gh Issue/i }))
    expect(editor).toHaveAttribute('data-value', `${prefix}$gh-issue `)
    expect(screen.queryByTestId('message-edit-skill-menu')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer-skill-chip')).toHaveTextContent('Gh Issue')
  })

    it('uses published skills when the edit service has an empty catalog', () => {
        vi.stubGlobal('__cpaComposerSkills', [{ name: 'gh-issue' }])
        try {
            render(
                <HostServicesProvider services={{ skillUsage: { getAvailableSkills: () => [] } } as any}>
                    <MessageItem message={message} onEditMessage={() => undefined} />
                </HostServicesProvider>,
            )
            fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
            const editor = screen.getByTestId('message-edit-input')
            setContentEditableValue(editor, '')
            setContentEditableValue(editor, '$')
            expect(screen.getByTestId('message-edit-skill-menu')).toBeInTheDocument()
            fireEvent.keyDown(editor, { key: 'Enter' })
            expect(editor).toHaveAttribute('data-value', '$gh-issue ')
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('refreshes an open edit query when skills arrive and clears removed skills', () => {
        let skills: readonly { name: string }[] = []
        const listeners = new Set<() => void>()
        const services = {
            skillUsage: {
                getAvailableSkills: () => skills,
                subscribeAvailableSkills: (listener: () => void) => {
                    listeners.add(listener)
                    return () => listeners.delete(listener)
                },
            },
        }
        const { unmount } = render(
            <HostServicesProvider services={services as any}>
                <MessageItem message={message} onEditMessage={() => undefined} />
            </HostServicesProvider>,
        )
        fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
        setContentEditableValue(screen.getByTestId('message-edit-input'), '$')
        expect(screen.queryByTestId('message-edit-skill-menu')).not.toBeInTheDocument()
        act(() => {
            skills = [{ name: 'gh-issue' }]
            listeners.forEach((listener) => listener())
        })
        expect(screen.getByTestId('message-edit-skill-menu')).toBeInTheDocument()
        act(() => {
            skills = []
            listeners.forEach((listener) => listener())
        })
        expect(screen.queryByTestId('message-edit-skill-menu')).not.toBeInTheDocument()
        unmount()
        expect(listeners.size).toBe(0)
    })

  it('keeps arrow-key selection when the skill menu opens below', () => {
    const skills = [
      {
        name: 'gh-issue',
        description: 'Triage GitHub issues',
        filePath: '/skills/gh-issue/SKILL.md',
      },
      {
        name: 'fix-issue',
        description: 'Fix an issue',
        filePath: '/skills/fix-issue/SKILL.md',
      },
    ]
    const hostServices = {
      skillUsage: {
        getAvailableSkills: () => skills,
      },
    }

    render(
      <HostServicesProvider services={hostServices as any}>
        <MessageItem
          message={message}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
          onEditMessage={() => undefined}
        />
      </HostServicesProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }))
    const editor = screen.getByTestId('message-edit-input')
    setContentEditableValue(editor, '$')

    // Sorted alphabetically when usage counts are equal: fix-issue first.
    expect(screen.getByRole('option', { name: /Fix Issue/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    fireEvent.keyDown(editor, { key: 'ArrowDown' })
    // SkillDraftEditor emits onKeyUp cursor updates; selection must survive that.
    fireEvent.keyUp(editor, { key: 'ArrowDown' })

    expect(screen.getByRole('option', { name: /Gh Issue/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('option', { name: /Fix Issue/i })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('renders recall icon button instead of copy/edit for queued/pending user message', async () => {
    const dequeueMessage = vi.fn().mockResolvedValue({ text: 'Content to recall' })
    const setComposerDraft = vi.fn()
    const pushToast = vi.fn()
    const hostServices: Partial<HostServices> = {
      chatMessages: {
        dequeueMessage,
      } as any,
      ui: {
        setComposerDraft,
        pushToast,
      } as any,
    }

    const queuedMessage: DisplayChatMessage = {
      ...message,
      id: 'u-queued-1',
      pendingStatus: 'queue',
    }

    render(
      <HostServicesProvider services={hostServices as HostServices}>
        <MessageItem
          message={queuedMessage}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
          onEditMessage={() => undefined}
        />
      </HostServicesProvider>,
    )

    // Recall button must be rendered
    const recallBtn = screen.getByRole('button', { name: /recall/i })
    expect(recallBtn).toBeInTheDocument()

    // Copy and Edit buttons must NOT be rendered
    expect(screen.queryByRole('button', { name: /Copy/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit$/i })).not.toBeInTheDocument()

    // Clicking recall button triggers dequeueMessage and setComposerDraft
    fireEvent.click(recallBtn)
    await waitFor(() => {
      expect(dequeueMessage).toHaveBeenCalledWith('s1', 'u-queued-1')
      expect(setComposerDraft).toHaveBeenCalledWith('s1', 'Content to recall')
      expect(pushToast).toHaveBeenCalled()
    })
  })
})

describe('MessageItem assistant actions', () => {
  const message: DisplayChatMessage = {
    kind: 'message',
    id: 'a1',
    sessionId: 's1',
    role: 'assistant',
    content: 'Answer result',
    parts: [{ type: 'text', text: 'Answer result' }],
    status: 'done',
    createdAt: 1000,
  }

  it('copies assistant result text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    render(
      <MessageItem
        message={message}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    fireEvent.click(screen.getByTestId('message-copy-result-btn'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Answer result'))
  })

  it('handles fork session click', async () => {
    const onFork = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageItem
        message={message}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onFork={onFork}
      />,
    )

    fireEvent.click(screen.getByTestId('message-fork-btn'))
    await waitFor(() => expect(onFork).toHaveBeenCalled())
  })

  it('renders error card and handles retry when message status is error', () => {
    const onRetry = vi.fn().mockResolvedValue(undefined)
    render(
      <MessageItem
        message={{
          ...message,
          status: 'error',
          errorMessage: 'Network timeout',
        } as any}
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByTestId('message-error-card')).toBeInTheDocument()
    expect(screen.getByText('Network timeout')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('renders thinking block and tool activity stack in compact activity when expanded', () => {
    render(
      <MessageItem
        message={{
          ...message,
          parts: [
            { type: 'thinking', thinking: 'Thinking process' },
            {
              type: 'tool_call',
              id: 't1',
              name: 'read',
              args: { path: 'main.go' },
              status: 'done',
            },
            { type: 'text', text: 'Done' },
          ],
        }}
        compactActivity
        forceExpanded
        onApproveTool={() => undefined}
        onRejectTool={() => undefined}
      />,
    )

    expect(screen.getByTestId('tool-activity')).toBeInTheDocument()
  })
})

describe('MessageItem contribution rendering and custom override dispatching', () => {
  it('dispatches custom message renderer contribution when matched', () => {
    const customUserMessage: DisplayChatMessage = {
      kind: 'message',
      id: 'custom-u1',
      sessionId: 's1',
      role: 'user',
      content: 'Custom User Content',
      parts: [{ type: 'text', text: 'Custom User Content' }],
      createdAt: 1000,
    }

    const hostServices: Partial<HostServices> = {
      rendererContributions: {
        getSlotContributions: () => [],
        getChatRenderers: () => [
          {
            id: 'custom-user-renderer',
            priority: 10,
            matches: (msg: any) => msg?.id === 'custom-u1',
            component: ({ value }: { value: any }) => (
              <div data-testid="custom-user-rendered-message">
                Custom Renderer: {value.content}
              </div>
            ),
          },
        ],
      },
    }

    render(
      <HostServicesProvider services={hostServices as HostServices}>
        <MessageItem
          message={customUserMessage}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('custom-user-rendered-message')).toHaveTextContent(
      'Custom Renderer: Custom User Content',
    )
  })

  it('dispatches custom part renderer contribution when matched in non-compact mode', () => {
    const messageWithCustomTool: DisplayChatMessage = {
      kind: 'message',
      id: 'a-custom-tool',
      sessionId: 's1',
      role: 'assistant',
      content: '',
      parts: [
        {
          type: 'tool_call',
          id: 'custom_call_1',
          name: 'special_tool',
          args: { query: 'special' },
          status: 'done',
          result: 'Special Tool Output',
        } as any,
      ],
      status: 'done',
      createdAt: 1000,
    }

    const hostServices: Partial<HostServices> = {
      rendererContributions: {
        getSlotContributions: () => [],
        getChatRenderers: () => [
          {
            id: 'special-tool-renderer',
            priority: 40,
            matches: (part: any) => part?.type === 'tool_call' && part?.name === 'special_tool',
            component: ({ value }: { value: any }) => (
              <div data-testid="custom-special-tool-card">
                Custom Tool: {value.name} - {value.result}
              </div>
            ),
          },
        ],
      },
    }

    render(
      <HostServicesProvider services={hostServices as HostServices}>
        <MessageItem
          message={messageWithCustomTool}
          compactActivity={false}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByTestId('custom-special-tool-card')).toHaveTextContent(
      'Custom Tool: special_tool - Special Tool Output',
    )
  })

  it('isolates errors in custom message renderer with error boundary and falls back to default renderer', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const message: DisplayChatMessage = {
      kind: 'message',
      id: 'u-buggy',
      sessionId: 's1',
      role: 'user',
      content: 'Standard Fallback User Message',
      parts: [{ type: 'text', text: 'Standard Fallback User Message' }],
      createdAt: 1000,
    }

    const hostServices: Partial<HostServices> = {
      rendererContributions: {
        getSlotContributions: () => [],
        getChatRenderers: () => [
          {
            id: 'buggy-user-renderer',
            priority: 10,
            matches: () => true,
            component: () => {
              throw new Error('Exploded in custom message renderer')
            },
          },
        ],
      },
    }

    render(
      <HostServicesProvider services={hostServices as HostServices}>
        <MessageItem
          message={message}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
        />
      </HostServicesProvider>,
    )

    expect(screen.getByText('Standard Fallback User Message')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('isolates errors in custom part renderer with error boundary and falls back to default part renderer', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const message: DisplayChatMessage = {
      kind: 'message',
      id: 'a-buggy-part',
      sessionId: 's1',
      role: 'assistant',
      content: '',
      parts: [
        {
          type: 'tool_call',
          id: 'call_fallback_1',
          name: 'read',
          args: { path: 'fallback.txt' },
          status: 'done',
        },
      ],
      status: 'done',
      createdAt: 1000,
    }

    const hostServices: Partial<HostServices> = {
      rendererContributions: {
        getSlotContributions: () => [],
        getChatRenderers: () => [
          {
            id: 'buggy-part-renderer',
            priority: 10,
            matches: (part: any) => part?.type === 'tool_call',
            component: () => {
              throw new Error('Exploded in custom part renderer')
            },
          },
        ],
      },
    }

    render(
      <HostServicesProvider services={hostServices as HostServices}>
        <MessageItem
          message={message}
          compactActivity={false}
          onApproveTool={() => undefined}
          onRejectTool={() => undefined}
        />
      </HostServicesProvider>,
    )

    // Should fall back to default ToolCard
    expect(screen.getByTestId('tool-status')).toHaveAttribute('data-tool-status', 'done')
    expect(screen.getByText('read')).toBeInTheDocument()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
