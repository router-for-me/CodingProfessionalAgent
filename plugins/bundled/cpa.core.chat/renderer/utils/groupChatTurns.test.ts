import { describe, expect, it } from 'vitest'
import type { DisplayChatMessage, DisplayMessage } from '../types.js'
import { groupChatTurns, mergeAssistantTurn } from './groupChatTurns.js'

function user(id: string, createdAt: number): DisplayChatMessage {
  return {
    kind: 'message',
    id,
    sessionId: 's1',
    role: 'user',
    content: id,
    parts: [{ type: 'text', text: id }],
    createdAt,
  }
}

function assistant(
  id: string,
  createdAt: number,
  status: 'streaming' | 'done' = 'done',
  extra: Partial<DisplayChatMessage> = {},
): DisplayChatMessage {
  return {
    kind: 'message',
    id,
    sessionId: 's1',
    role: 'assistant',
    content: id,
    parts: [{ type: 'text', text: id }],
    status,
    createdAt,
    ...extra,
  }
}

describe('groupChatTurns', () => {
  it('groups consecutive assistants after a user into one turn', () => {
    const messages: DisplayMessage[] = [
      user('u1', 10),
      assistant('a1', 20),
      assistant('a2', 30, 'done', { completedAt: 90 }),
      user('u2', 100),
      assistant('a3', 110),
    ]
    const turns = groupChatTurns(messages)
    expect(turns.map((turn) => turn.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(turns[1]).toMatchObject({
      type: 'assistant',
      startedAt: 10,
    })
    if (turns[1]?.type === 'assistant') {
      expect(turns[1].items.map((item) => item.message.id)).toEqual(['a1', 'a2'])
    }
  })

  it('keeps one assistant turn across compaction dividers', () => {
    const messages: DisplayMessage[] = [
      user('u1', 10),
      assistant('a1', 20),
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: 25,
      },
      assistant('a2', 30),
    ]
    const turns = groupChatTurns(messages)
    expect(turns.map((turn) => turn.type)).toEqual(['user', 'assistant'])
    expect(turns[1]).toMatchObject({
      type: 'assistant',
      startedAt: 10,
    })
    if (turns[1]?.type === 'assistant') {
      expect(turns[1].items.map((item) => item.message.id)).toEqual([
        'a1',
        'c1',
        'a2',
      ])
    }
  })

  it('uses compaction createdAt when conversation starts with compaction without prior user', () => {
    const messages: DisplayMessage[] = [
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: 100,
      },
      assistant('a1', 150),
    ]
    const turns = groupChatTurns(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      type: 'assistant',
      startedAt: 100,
    })
  })

  it('promotes post-user compaction into the current assistant turn', () => {
    const messages: DisplayMessage[] = [
      user('u1', 10),
      {
        kind: 'compaction',
        id: 'c1',
        sessionId: 's1',
        createdAt: 20,
      },
    ]
    const turns = groupChatTurns(messages)
    expect(turns.map((turn) => turn.type)).toEqual(['user', 'assistant'])
    expect(turns[1]).toMatchObject({
      type: 'assistant',
      startedAt: 10,
    })
  })

  it('passes pausedMs from user message to assistant turn', () => {
    const messages: DisplayMessage[] = [
      {
        ...user('u1', 10),
        pausedMs: 5000,
      } as any,
      assistant('a1', 20, 'done'),
    ]
    const turns = groupChatTurns(messages)
    expect(turns[1]).toMatchObject({
      type: 'assistant',
      startedAt: 10,
      pausedMs: 5000,
    })
  })
})

describe('mergeAssistantTurn', () => {
  it('keeps one timer from request start and concatenates parts', () => {
    const merged = mergeAssistantTurn(
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
              name: 'read',
              args: { path: 'a.go' },
              status: 'done',
            },
            { type: 'text', text: 'final' },
          ],
          content: 'final',
        }),
      ],
      10,
    )
    expect(merged.createdAt).toBe(10)
    expect((merged as any).completedAt).toBe(80)
    expect(merged.status).toBe('done')
    expect(merged.parts).toHaveLength(3)
  })

  it('stays streaming while the request is still live', () => {
    const merged = mergeAssistantTurn([assistant('a1', 20, 'done')], 10, true)
    expect(merged.status).toBe('streaming')
    expect((merged as any).completedAt).toBeUndefined()
  })

  it('carries errorMessage and error status when an assistant stage failed', () => {
    const merged = mergeAssistantTurn(
      [
        assistant('a1', 20, 'done', {
          parts: [{ type: 'text', text: 'part 1' }],
          content: 'part 1',
        }),
        assistant('a2', 40, 'done', {
          status: 'error',
          errorMessage: 'Connection timeout',
          parts: [],
          content: '',
        } as any),
      ],
      10,
    )
    expect(merged.status).toBe('error')
    expect((merged as any).errorMessage).toBe('Connection timeout')
  })

  it('propagates pausedMs onto merged message', () => {
    const merged = mergeAssistantTurn(
      [assistant('a1', 20, 'done', { completedAt: 100 })],
      10,
      false,
      5000,
    )
    expect((merged as any).pausedMs).toBe(5000)
  })

  it('does not set activeTurnStartedAt from pending user messages so prior turn duration remains intact', () => {
    const messages: DisplayMessage[] = [
      user('u1', 1000),
      assistant('a1', 2000, 'done', { completedAt: 5000 }),
      {
        ...user('u-queue', 2500),
        pendingStatus: 'queue',
      } as any,
    ]
    const turns = groupChatTurns(messages)
    expect(turns.map((t) => t.type)).toEqual(['user', 'assistant', 'user'])
    const aTurn = turns[1] as any
    expect(aTurn.type).toBe('assistant')
    expect(aTurn.startedAt).toBe(1000)
    // The merged assistant turn duration must be completedAt - startedAt = 5000 - 1000 = 4000
    const merged = mergeAssistantTurn(aTurn.items.map((i: any) => i.message), aTurn.startedAt)
    expect(merged.createdAt).toBe(1000)
    expect((merged as any).completedAt).toBe(5000)
  })
})
