import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useMessageStore } from '@/stores/messageStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useResumePromptStore } from '@/stores/resumePromptStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { useAutoResume, __resetAutoResumedForTests } from './useAutoResume'
import { setHostBridge } from '@/application/services/hostTransport'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

describe('useAutoResume', () => {
  let userAgentSpy: any

  beforeEach(() => {
    vi.useFakeTimers()
    userAgentSpy = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Electron/30.0.0')
    __resetAutoResumedForTests()
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        resumeUnfinishedConversations: true,
      },
    })
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
    })
    useSessionRunStore.setState({
      activeRuns: {},
    })
    useMessageStore.setState({
      entriesBySession: {},
    })
    useSubAgentStore.setState({
      agents: [],
    })
  })

  afterEach(() => {
    setHostBridge(null)
    userAgentSpy?.mockRestore()
    vi.useRealTimers()
  })

  it('does not open prompt when resumeUnfinishedConversations is disabled', async () => {
    useSettingsStore.getState().setResumeUnfinishedConversations(false)
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('does not open prompt when all sessions are completed normally', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Done Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Completed.' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('opens prompt with countdown when unfinished tasks exist, and auto-resumes after countdown', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().totalCount).toBe(1)
    expect(useResumePromptStore.getState().countdown).toBe(30)
    expect(resumeSession).not.toHaveBeenCalled()

    // Advance 10 seconds
    await vi.advanceTimersByTimeAsync(10000)
    expect(useResumePromptStore.getState().countdown).toBe(20)
    expect(resumeSession).not.toHaveBeenCalled()

    // Advance remaining 20 seconds (countdown reaches 0)
    await vi.advanceTimersByTimeAsync(20000)
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).toHaveBeenCalledWith('s1')
  })

  it('immediately resumes when onContinue is invoked', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))

    const onContinue = useResumePromptStore.getState().onContinueAction
    expect(onContinue).toBeDefined()

    await onContinue?.()
    expect(resumeSession).toHaveBeenCalledWith('s1')
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })

  it('resumes every unfinished main session with the current session first', async () => {
    const resumeSession = vi.fn(async (sessionId?: string) => sessionId ?? null)

    useSessionStore.setState({
      sessions: [
        {
          id: 'gpt-session',
          title: 'GPT unfinished',
          pinned: false,
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'gemini-session',
          title: 'Gemini unfinished',
          pinned: false,
          modelId: 'gemini-3.7-flash',
          reasoningEffort: 'high',
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      currentSessionId: 'gemini-session',
    })
    useMessageStore.getState().replaceSessionEntries('gpt-session', [
      {
        id: 'gpt-user',
        sessionId: 'gpt-session',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Continue with GPT' }],
      },
    ])
    useMessageStore.getState().replaceSessionEntries('gemini-session', [
      {
        id: 'gemini-user',
        sessionId: 'gemini-session',
        createdAt: 1001,
        kind: 'user',
        content: [{ type: 'text', text: 'Continue with Gemini' }],
      },
    ])

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().totalCount).toBe(2))
    await useResumePromptStore.getState().onContinueAction?.()

    expect(resumeSession.mock.calls).toEqual([
      ['gemini-session'],
      ['gpt-session'],
    ])
  })

  it('resumes unfinished session in background when on new chat page (currentSessionId is null) without desyncing currentSessionId', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: null,
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))

    const onContinue = useResumePromptStore.getState().onContinueAction
    expect(onContinue).toBeDefined()

    await onContinue?.()
    expect(resumeSession).toHaveBeenCalledWith('s1')
    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })

  it('marks all unfinished tasks as aborted when onAbort is invoked', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)
    useSubAgentStore.setState({
      agents: [
        {
          id: 'sa1',
          name: 'Worker',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 's1',
          sessionId: 'sa1',
          modelId: 'gpt-4',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().totalCount).toBe(1)

    const onAbort = useResumePromptStore.getState().onAbortAction
    expect(onAbort).toBeDefined()

    await onAbort?.()
    expect(resumeSession).not.toHaveBeenCalled()
    expect(useResumePromptStore.getState().isOpen).toBe(false)

    // SubAgent should be aborted
    expect(useSubAgentStore.getState().agents[0].status).toBe('aborted')

    // Session entries should now have an aborted assistant entry
    const s1Entries = useMessageStore.getState().getEntries('s1')
    expect(s1Entries[s1Entries.length - 1].kind).toBe('assistant')
    expect((s1Entries[s1Entries.length - 1] as any).status).toBe('aborted')
  })

  it('opens prompt when assistant was interrupted by session restart', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Interrupted Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Partial text' }],
        stopReason: 'aborted',
        status: 'aborted',
        errorMessage: 'Interrupted by session restart',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().totalCount).toBe(1)
  })

  it('resumes parent session when subagent was unfinished and onContinue is invoked', async () => {
    const resumeSession = vi.fn().mockResolvedValue('p1')

    useSessionStore.setState({
      sessions: [{ id: 'p1', title: 'Parent', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 'p1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'p1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Parent prompt' }],
      },
      {
        id: 'a1',
        sessionId: 'p1',
        createdAt: 1001,
        kind: 'assistant',
        model: 'gpt-4',
        content: [
          {
            type: 'toolCall',
            id: 'tc-1',
            name: 'spawn_agent',
            arguments: { name: 'Child', prompt: 'Work', model: 'gpt-4' },
          },
        ],
        stopReason: 'toolUse',
        status: 'done',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('p1', entries)
    useSubAgentStore.setState({
      agents: [
        {
          id: 'child-1',
          name: 'Child',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 'p1',
          sessionId: 'child-1',
          modelId: 'gpt-4',
          parentToolCallId: 'tc-1',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))

    const onContinue = useResumePromptStore.getState().onContinueAction
    expect(onContinue).toBeDefined()

    await onContinue?.()
    expect(resumeSession).toHaveBeenCalledWith('p1')
  })

  it('counts one resumable parent when duplicate subagents belong to the same pending tool call', async () => {
    const resumeSession = vi.fn().mockResolvedValue('p1')

    useSessionStore.setState({
      sessions: [{ id: 'p1', title: 'Parent', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 'p1',
    })
    useMessageStore.getState().replaceSessionEntries('p1', [
      {
        id: 'u1',
        sessionId: 'p1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Review the changes' }],
      },
      {
        id: 'a1',
        sessionId: 'p1',
        createdAt: 1001,
        kind: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'spawn-1|function-1',
            name: 'spawn_agent',
            arguments: { name: 'Reviewer', prompt: 'Review', model: 'gpt-4' },
          },
        ],
        stopReason: 'toolUse',
        status: 'done',
      },
    ])
    for (const childId of ['child-old', 'child-duplicate']) {
      useMessageStore.getState().replaceSessionEntries(childId, [
        {
          id: `u-${childId}`,
          sessionId: childId,
          createdAt: 1002,
          kind: 'user',
          content: [{ type: 'text', text: 'Review' }],
        },
      ])
    }
    useSubAgentStore.setState({
      agents: ['child-old', 'child-duplicate'].map((id, index) => ({
        id,
        name: 'Reviewer',
        color: '#fff',
        icon: 'sparkle' as const,
        parentSessionId: 'p1',
        sessionId: id,
        modelId: 'gpt-4',
        parentToolCallId: 'spawn-1|function-1',
        status: 'running' as const,
        createdAt: 1002 + index,
        updatedAt: 1002 + index,
      })),
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().totalCount).toBe(1)
    expect(useResumePromptStore.getState().unfinishedSessionIds).toEqual(['p1'])
    expect(useResumePromptStore.getState().unfinishedSubAgentIds).toEqual([
      'child-old',
      'child-duplicate',
    ])
  })

  it('aborts an active subagent whose parent history does not contain its tool call', async () => {
    const resumeSession = vi.fn().mockResolvedValue('p1')

    useSessionStore.setState({
      sessions: [{ id: 'p1', title: 'Parent', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 'p1',
    })
    useMessageStore.getState().replaceSessionEntries('p1', [
      {
        id: 'u1',
        sessionId: 'p1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Original task' }],
      },
      {
        id: 'a1',
        sessionId: 'p1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Completed' }],
        stopReason: 'stop',
        status: 'done',
      },
    ])
    useMessageStore.getState().replaceSessionEntries('orphan-child', [
      {
        id: 'u-child',
        sessionId: 'orphan-child',
        createdAt: 1002,
        kind: 'user',
        content: [{ type: 'text', text: 'Wrongly linked child task' }],
      },
      {
        id: 'a-child',
        sessionId: 'orphan-child',
        createdAt: 1003,
        kind: 'assistant',
        content: [],
        stopReason: 'pending',
        status: 'streaming',
      },
    ])
    useSubAgentStore.setState({
      agents: [
        {
          id: 'orphan-child',
          name: 'Reviewer',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 'p1',
          sessionId: 'orphan-child',
          modelId: 'gpt-4',
          parentToolCallId: 'call-from-another-session',
          status: 'running',
          createdAt: 1002,
          updatedAt: 1002,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
    expect(useSubAgentStore.getState().agents[0].status).toBe('aborted')
  })

  it('ignores completed subagent even if its child session has streaming entry', async () => {
    const resumeSession = vi.fn().mockResolvedValue('p1')

    useSessionStore.setState({
      sessions: [{ id: 'p1', title: 'Parent', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 'p1',
    })
    const parentEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'p1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: 'a1',
        sessionId: 'p1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'All done' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('p1', parentEntries)

    // Child session has dangling streaming entry
    const childEntries: ConversationEntry[] = [
      {
        id: 'u-child',
        sessionId: 'child-1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Child task' }],
      },
      {
        id: 'a-child',
        sessionId: 'child-1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'thinking', thinking: 'Thinking...' }],
        stopReason: 'pending',
        status: 'streaming',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('child-1', childEntries)

    useSubAgentStore.setState({
      agents: [
        {
          id: 'child-1',
          name: 'Child',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 'p1',
          sessionId: 'child-1',
          modelId: 'gpt-4',
          status: 'completed',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('self-heals running subagent whose child session was cleanly completed', async () => {
    const resumeSession = vi.fn().mockResolvedValue('p1')

    useSessionStore.setState({
      sessions: [{ id: 'p1', title: 'Parent', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 'p1',
    })

    const parentEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'p1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        id: 'a1',
        sessionId: 'p1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'All done' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('p1', parentEntries)

    // Child session has clean completed entries
    const childEntries: ConversationEntry[] = [
      {
        id: 'u-child',
        sessionId: 'child-1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Child task' }],
      },
      {
        id: 'a-child',
        sessionId: 'child-1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Child result' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    useMessageStore.getState().replaceSessionEntries('child-1', childEntries)

    useSubAgentStore.setState({
      agents: [
        {
          id: 'child-1',
          name: 'Child',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 'p1',
          sessionId: 'child-1',
          modelId: 'gpt-4',
          status: 'running',
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
    // SubAgent should be self-healed to completed
    expect(useSubAgentStore.getState().agents[0].status).toBe('completed')
    expect(useSubAgentStore.getState().agents[0].updatedAt).toBe(1001)
  })

  it('ignores archived sessions and their subagents', async () => {
    const resumeSession = vi.fn().mockResolvedValue('archived-1')

    useSessionStore.setState({
      sessions: [
        {
          id: 'archived-1',
          title: 'Archived Session',
          pinned: false,
          archivedAt: Date.now(),
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      currentSessionId: null,
    })
    // Unfinished entries in archived session
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'archived-1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Unfinished work' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('archived-1', entries)

    useSubAgentStore.setState({
      agents: [
        {
          id: 'child-archived',
          name: 'Child',
          color: '#fff',
          icon: 'sparkle',
          parentSessionId: 'archived-1',
          sessionId: 'child-archived',
          modelId: 'gpt-4',
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('does not scan or open prompt in web browser environment', async () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('ignores sessions that currently have active running tasks', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s1')

    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Running Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'In flight' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    // Set active run in sessionRunStore
    useSessionRunStore.getState().setRun('s1', {
      sessionId: 's1',
      runId: 'run-1',
      clientId: 'desktop-main',
      status: 'running',
      updatedAt: Date.now(),
    })

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('broadcasts prompt state to host bridge on state changes', async () => {
    const mockBroadcast = vi.fn().mockResolvedValue(undefined)
    setHostBridge({
      SessionBroadcastResumePromptState: mockBroadcast,
    } as any)

    const resumeSession = vi.fn().mockResolvedValue('s1')
    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(mockBroadcast).toHaveBeenCalledWith({
      isOpen: true,
      totalCount: 1,
      countdown: 30,
      unfinishedSessionIds: ['s1'],
      unfinishedSubAgentIds: [],
    })

    // Advance 1 second
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockBroadcast).toHaveBeenCalledWith({
      isOpen: true,
      totalCount: 1,
      countdown: 29,
      unfinishedSessionIds: ['s1'],
      unfinishedSubAgentIds: [],
    })
  })

  it('handles session:resume-prompt-action native event from web clients', async () => {
    let nativeListener: ((event: any) => void) | null = null
    setHostBridge({
      onNativeEvent: vi.fn((cb) => {
        nativeListener = cb
        return () => {
          nativeListener = null
        }
      }),
      SessionBroadcastResumePromptState: vi.fn().mockResolvedValue(undefined),
    } as any)

    const resumeSession = vi.fn().mockResolvedValue('s1')
    useSessionStore.setState({
      sessions: [{ id: 's1', title: 'Unfinished Session', pinned: false, createdAt: 1, updatedAt: 1 }],
      currentSessionId: 's1',
    })
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(nativeListener).toBeDefined()

    // Trigger continue action from web client
    nativeListener!({
      kind: 'session:resume-prompt-action',
      data: JSON.stringify({ action: 'continue' }),
    })

    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledWith('s1'))
    expect(useResumePromptStore.getState().isOpen).toBe(false)
  })

  it('does not prompt to resume when worktree setup failed (checkout or environment error)', async () => {
    const resumeSession = vi.fn().mockResolvedValue('s-wt-fail')
    const sessionId = 's-wt-fail'

    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Failed Worktree',
          pinned: false,
          workLocation: 'worktree',
          worktreePath: '/worktrees/proj-wt-fail',
          worktreeSetup: {
            sessionId,
            status: 'error',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'error',
            worktreePath: '/worktrees/proj-wt-fail',
            logs: 'Environment setup script failed with exit code 1',
            exitCode: 1,
            error: 'Exit code 1',
            expandedDetails: true,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      currentSessionId: sessionId,
    })
    useWorktreeSetupStore.setState({
      setups: {
        [sessionId]: {
          sessionId,
          status: 'error',
          stepWorkspace: 'done',
          stepCheckout: 'done',
          stepEnvironment: 'error',
          worktreePath: '/worktrees/proj-wt-fail',
          logs: 'Environment setup script failed with exit code 1',
          exitCode: 1,
          error: 'Exit code 1',
          expandedDetails: true,
        },
      },
    })

    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId,
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Help me refactor' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries(sessionId, entries)

    renderHook(() => useAutoResume(resumeSession))

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('waits for isReady to become true before initiating auto-resume scan and countdown', async () => {
    const sessionId = 'sess-deferred'
    const resumeSession = vi.fn().mockResolvedValue(sessionId)

    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Deferred Session',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      currentSessionId: sessionId,
    })

    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId,
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Unfinished prompt' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries(sessionId, entries)

    // Initially isReady = false (e.g. model catalog verification pending or error)
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useAutoResume(resumeSession, ready),
      { initialProps: { ready: false } },
    )

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).not.toHaveBeenCalled()

    // Model catalog verified and ready -> isReady becomes true
    rerender({ ready: true })

    await vi.runAllTimersAsync()
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps countdown ticking continuously across re-renders with changing resumeSession reference', async () => {
    const sessionId = 'sess-continuous-tick'
    const resumeSession1 = vi.fn().mockResolvedValue(sessionId)
    const resumeSession2 = vi.fn().mockResolvedValue(sessionId)

    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Continuous Tick Session',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      currentSessionId: sessionId,
    })

    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId,
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Unfinished prompt' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries(sessionId, entries)

    const { rerender } = renderHook(
      ({ fn, ready }: { fn: any; ready: boolean }) => useAutoResume(fn, ready),
      { initialProps: { fn: resumeSession1, ready: true } },
    )

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().countdown).toBe(30)

    // Advance 5 seconds -> countdown should be 25
    await vi.advanceTimersByTimeAsync(5000)
    expect(useResumePromptStore.getState().countdown).toBe(25)

    // Component re-renders with a new resumeSession function reference
    rerender({ fn: resumeSession2, ready: true })

    // Advance another 5 seconds -> countdown must continue ticking down to 20 without stopping
    await vi.advanceTimersByTimeAsync(5000)
    expect(useResumePromptStore.getState().countdown).toBe(20)

    // Advance remaining 20 seconds -> should reach 0 and auto-resume with latest function reference
    await vi.advanceTimersByTimeAsync(20000)
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession2).toHaveBeenCalledWith(sessionId)
  })

  it('keeps prompt and timer intact if a temporary unready state occurs after auto-resume has activated', async () => {
    const sessionId = 'sess-relogin-active'
    const resumeSession = vi.fn().mockResolvedValue(sessionId)

    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Re-login Session',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      currentSessionId: sessionId,
    })

    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId,
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Unfinished prompt' }],
      },
    ]
    useMessageStore.getState().replaceSessionEntries(sessionId, entries)

    // Initially unready (model catalog failed)
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useAutoResume(resumeSession, ready),
      { initialProps: { ready: false } },
    )

    expect(useResumePromptStore.getState().isOpen).toBe(false)

    // User successfully logs in / model catalog becomes ready
    rerender({ ready: true })

    await vi.waitFor(() => expect(useResumePromptStore.getState().isOpen).toBe(true))
    expect(useResumePromptStore.getState().countdown).toBe(30)

    // Advance 5 seconds
    await vi.advanceTimersByTimeAsync(5000)
    expect(useResumePromptStore.getState().countdown).toBe(25)

    // Suppose a background service or bootstrap state briefly flickers ready: false
    rerender({ ready: false })

    // Prompt MUST NOT be closed and timer MUST continue ticking
    await vi.advanceTimersByTimeAsync(5000)
    expect(useResumePromptStore.getState().isOpen).toBe(true)
    expect(useResumePromptStore.getState().countdown).toBe(20)

    // Advance remaining time -> reaches 0 and resumes
    await vi.advanceTimersByTimeAsync(20000)
    expect(useResumePromptStore.getState().isOpen).toBe(false)
    expect(resumeSession).toHaveBeenCalledWith(sessionId)
  })

  it('scanUnfinishedTasks does not pollute useMessageStore with entries from unhydrated sessions', async () => {
    const sessionId = 'sess-unhydrated-remote'
    useSessionStore.setState({
      sessions: [
        {
          id: sessionId,
          title: 'Remote Session',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
      currentSessionId: 'other-session',
    })

    const remoteEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId,
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Prompt' }],
      },
    ]

    setHostBridge({
      SessionGet: vi.fn().mockResolvedValue({
        id: sessionId,
        entries: remoteEntries,
      }),
    } as any)

    expect(useMessageStore.getState().getEntries(sessionId)).toEqual([])

    const { scanUnfinishedTasks } = await import('./useAutoResume')
    const result = await scanUnfinishedTasks()
    expect(result.unfinishedSessionIds).toContain(sessionId)

    // Crucial memory optimization: scanning must NOT pollute useMessageStore for background sessions
    expect(useMessageStore.getState().getEntries(sessionId)).toEqual([])
  })
})
