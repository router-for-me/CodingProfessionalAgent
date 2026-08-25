import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from './types'
import type { SubAgentRecord } from '@cpa/plugin-api'
import {
  isSessionUnfinished,
  isSessionResumable,
  cleanUnfinishedEntries,
  isSubAgentUnfinished,
} from './unfinished'

describe('unfinished session detection', () => {
  it('returns false for empty entries', () => {
    expect(isSessionUnfinished([])).toBe(false)
  })

  it('returns true when last entry is a user message', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('returns true when last entry is a tool result without following assistant reply', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Run command' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
        stopReason: 'toolUse',
        status: 'done',
      },
      {
        id: 'tr1',
        sessionId: 's1',
        createdAt: 1002,
        kind: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'file.txt' }],
        isError: false,
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('returns false when assistant turn completed normally with stop reason stop', () => {
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
        content: [{ type: 'text', text: 'Hi there!' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(false)
  })

  it('returns false when assistant was aborted explicitly by user', () => {
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
        content: [{ type: 'text', text: 'Partia' }],
        stopReason: 'aborted',
        status: 'aborted',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(false)
  })

  it('returns false when assistant encountered a terminal error', () => {
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
        content: [],
        stopReason: 'error',
        status: 'error',
        errorMessage: 'Network timeout',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(false)
  })

  it('returns true when assistant was killed mid-flight while streaming', () => {
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
        content: [{ type: 'text', text: 'Let me think' }],
        stopReason: 'pending',
        status: 'streaming',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('returns true when assistant emitted tool calls but no matching tool results exist', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Spawn subagent' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'spawn_1',
            name: 'spawn_agent',
            arguments: { name: 'child', prompt: 'do work', model: 'gpt-4' },
          },
        ],
        stopReason: 'toolUse',
        status: 'done',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('returns true when assistant was interrupted by session restart', () => {
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
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('returns true when assistant has aborted status from restart with incomplete tool call', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Run command' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
        stopReason: 'aborted',
        status: 'aborted',
        errorMessage: 'Interrupted by session restart',
      },
    ]
    expect(isSessionUnfinished(entries)).toBe(true)
  })

  it('cleans dangling streaming assistant entry interrupted by restart', () => {
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
        content: [{ type: 'text', text: 'Parti' }],
        stopReason: 'aborted',
        status: 'aborted',
        errorMessage: 'Interrupted by session restart',
      },
    ]
    const cleaned = cleanUnfinishedEntries(entries)
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0].id).toBe('u1')
  })

  it('cleans dangling streaming assistant entry', () => {
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
        content: [{ type: 'text', text: 'Parti' }],
        stopReason: 'pending',
        status: 'streaming',
      },
    ]
    const cleaned = cleanUnfinishedEntries(entries)
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0].id).toBe('u1')
  })

  it('preserves assistant entry with tool calls and normalizes status to done and toolUse', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Spawn subagent' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'spawn_1',
            name: 'spawn_agent',
            arguments: { name: 'child', prompt: 'do work', model: 'gpt-4' },
          },
        ],
        stopReason: 'pending',
        status: 'streaming',
      },
    ]
    const cleaned = cleanUnfinishedEntries(entries)
    expect(cleaned).toHaveLength(2)
    expect(cleaned[1].id).toBe('a1')
    expect((cleaned[1] as any).status).toBe('done')
    expect((cleaned[1] as any).stopReason).toBe('toolUse')
  })

  it('detects unfinished subagents by status', () => {
    const runningAgent: SubAgentRecord = {
      id: 'sa1',
      name: 'Agent1',
      color: '#fff',
      icon: 'sparkle',
      parentSessionId: 's1',
      sessionId: 'sa1',
      modelId: 'gpt-4',
      status: 'running',
      createdAt: 1000,
      updatedAt: 1000,
    }
    expect(isSubAgentUnfinished(runningAgent)).toBe(true)

    const completedAgent: SubAgentRecord = {
      ...runningAgent,
      status: 'completed',
    }
    expect(isSubAgentUnfinished(completedAgent)).toBe(false)

    const streamingChildEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'sa1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Task' }],
      },
      {
        id: 'a1',
        sessionId: 'sa1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'thinking', thinking: 'Processing...' }],
        stopReason: 'pending',
        status: 'streaming',
      },
    ]

    // Terminal subagents (completed/aborted/error) should always be considered finished
    // even if child entries contain in-flight/streaming entries.
    expect(isSubAgentUnfinished(completedAgent, streamingChildEntries)).toBe(false)

    const abortedAgent: SubAgentRecord = {
      ...runningAgent,
      status: 'aborted',
    }
    expect(isSubAgentUnfinished(abortedAgent, streamingChildEntries)).toBe(false)

    const errorAgent: SubAgentRecord = {
      ...runningAgent,
      status: 'error',
    }
    expect(isSubAgentUnfinished(errorAgent, streamingChildEntries)).toBe(false)

    const queuedAgent: SubAgentRecord = {
      ...runningAgent,
      status: 'queued',
    }
    expect(isSubAgentUnfinished(queuedAgent)).toBe(true)

    const completedChildEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 'sa1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Task' }],
      },
      {
        id: 'a1',
        sessionId: 'sa1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Task completed' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]

    // Self-healing: if agent status is still 'running' but child session is cleanly completed,
    // it should be treated as finished (false).
    expect(isSubAgentUnfinished(runningAgent, completedChildEntries)).toBe(false)
    expect(isSubAgentUnfinished(runningAgent, streamingChildEntries)).toBe(true)
  })

  it('detects resumable session when interrupted by user abort', () => {
    const abortedEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Generate code' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Partial output...' }],
        stopReason: 'aborted',
        status: 'aborted',
      },
    ]

    // isSessionUnfinished ignores aborted sessions for auto-resume scan on startup
    expect(isSessionUnfinished(abortedEntries)).toBe(false)
    // isSessionResumable recognizes it as interrupted and resumable for single-session resume
    expect(isSessionResumable(abortedEntries)).toBe(true)

    // cleanUnfinishedEntries strips the aborted partial assistant entry
    const cleaned = cleanUnfinishedEntries(abortedEntries)
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]!.kind).toBe('user')
  })

  it('detects non-resumable session when completed normally or errored', () => {
    const doneEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hi' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        stopReason: 'stop',
        status: 'done',
      },
    ]
    expect(isSessionResumable(doneEntries)).toBe(false)

    const errorEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hi' }],
      },
      {
        id: 'a1',
        sessionId: 's1',
        createdAt: 1001,
        kind: 'assistant',
        content: [{ type: 'text', text: 'Error' }],
        stopReason: 'error',
        status: 'error',
      },
    ]
    expect(isSessionResumable(errorEntries)).toBe(false)
  })
})
