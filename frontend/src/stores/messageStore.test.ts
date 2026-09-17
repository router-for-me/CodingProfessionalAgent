import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AssistantEntry,
  CompactionEntry,
  ConversationEntry,
  ToolResultEntry,
  UserEntry,
} from '@/features/agent-runtime/session/types'
import {
  retainMessageSession,
  setProtectedSessionPredicate,
  useMessageStore,
  resetMessageStoreAccessOrderForTests,
} from './messageStore'
import { subscribeMessageEvents } from '@/application/events/messageEvents'

function user(partial: Partial<UserEntry> & Pick<UserEntry, 'id' | 'sessionId'>): UserEntry {
  return {
    kind: 'user',
    version: 1,
    createdAt: partial.createdAt ?? 1,
    content: partial.content ?? [{ type: 'text', text: 'hi' }],
    ...partial,
  }
}

function assistant(
  partial: Partial<AssistantEntry> & Pick<AssistantEntry, 'id' | 'sessionId'>,
): AssistantEntry {
  return {
    kind: 'assistant',
    version: 1,
    createdAt: partial.createdAt ?? 2,
    content: partial.content ?? [{ type: 'text', text: 'hello' }],
    status: partial.status ?? 'streaming',
    stopReason: partial.stopReason ?? 'pending',
    ...partial,
  }
}

function toolResult(
  partial: Partial<ToolResultEntry> &
    Pick<ToolResultEntry, 'id' | 'sessionId' | 'toolCallId'>,
): ToolResultEntry {
  return {
    kind: 'toolResult',
    version: 1,
    createdAt: partial.createdAt ?? 3,
    toolName: partial.toolName ?? 'bash',
    content: partial.content ?? [{ type: 'text', text: 'ok' }],
    isError: partial.isError ?? false,
    ...partial,
  }
}

function compaction(
  partial: Partial<CompactionEntry> & Pick<CompactionEntry, 'id' | 'sessionId'>,
): CompactionEntry {
  return {
    kind: 'compaction',
    version: 1,
    createdAt: partial.createdAt ?? 4,
    summary: partial.summary ?? 'summary',
    firstKeptEntryId: partial.firstKeptEntryId ?? 'kept',
    ...partial,
  }
}

describe('messageStore canonical entries', () => {
  beforeEach(() => {
    resetMessageStoreAccessOrderForTests()
    useMessageStore.setState({ entriesBySession: {}, maxCachedSessions: 8 })
    useMessageStore.getState().clearHydrateDiagnostics()
  })

  it('appends entries with defensive deep copy', () => {
    const entry = assistant({
      id: 'a1',
      sessionId: 's1',
      content: [{ type: 'text', text: 'partial' }],
    })
    useMessageStore.getState().appendEntry(entry)
    entry.content[0] = { type: 'text', text: 'mutated-after-append' }

    const stored = useMessageStore.getState().getEntries('s1')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      id: 'a1',
      kind: 'assistant',
      content: [{ type: 'text', text: 'partial' }],
    })

    // Caller mutation of returned array must not touch source.
    stored.push(user({ id: 'u-x', sessionId: 's1' }))
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    ;(stored[0] as AssistantEntry).content[0] = {
      type: 'text',
      text: 'mutated-return',
    }
    expect(
      (useMessageStore.getState().getEntries('s1')[0] as AssistantEntry).content[0],
    ).toEqual({ type: 'text', text: 'partial' })
  })

  it('replaceEntry updates in place; missing id upserts and is explicit', () => {
    useMessageStore.getState().appendEntry(
      assistant({ id: 'a1', sessionId: 's1', status: 'streaming' }),
    )
    useMessageStore.getState().replaceEntry(
      assistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'final' }],
      }),
    )
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]).toMatchObject({
      id: 'a1',
      status: 'done',
      content: [{ type: 'text', text: 'final' }],
    })

    // Missing id: upsert (append) so streaming start races are safe.
    useMessageStore.getState().replaceEntry(
      assistant({ id: 'a2', sessionId: 's1', content: [{ type: 'text', text: 'new' }] }),
    )
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual([
      'a1',
      'a2',
    ])
  })

  it('replaceEntry inserts before trailing pending user entries so active run entries remain contiguous', () => {
    // Current run has u1 and a1
    useMessageStore.getState().appendEntry(user({ id: 'u1', sessionId: 's2' }))
    useMessageStore.getState().appendEntry(assistant({ id: 'a1', sessionId: 's2' }))
    // User enqueues u-pending while run is active
    useMessageStore.getState().appendEntry({
      id: 'u-pending',
      sessionId: 's2',
      kind: 'user',
      createdAt: 100,
      version: 1,
      pendingStatus: 'queue',
      content: [{ type: 'text', text: 'queued prompt' }],
    })
    expect(useMessageStore.getState().getEntries('s2').map((e) => e.id)).toEqual([
      'u1',
      'a1',
      'u-pending',
    ])

    // Current run produces subsequent entry a2
    useMessageStore.getState().replaceEntry(
      assistant({ id: 'a2', sessionId: 's2', content: [{ type: 'text', text: 'continued' }] }),
    )
    // a2 must be inserted before u-pending!
    expect(useMessageStore.getState().getEntries('s2').map((e) => e.id)).toEqual([
      'u1',
      'a1',
      'a2',
      'u-pending',
    ])
  })

  it('replaceSessionEntries is a no-op when entries are identical', () => {
    const entries = [
      user({ id: 'u1', sessionId: 's1', content: [{ type: 'text', text: 'hello' }] }),
      assistant({ id: 'a1', sessionId: 's1', content: [{ type: 'text', text: 'world' }], status: 'done' }),
    ]
    useMessageStore.getState().replaceSessionEntries('s1', entries)
    const prevEntriesBySession = useMessageStore.getState().entriesBySession

    let subscriberCalled = false
    const unsub = useMessageStore.subscribe(() => {
      subscriberCalled = true
    })

    // Calling replaceSessionEntries with deeply equal entries
    useMessageStore.getState().replaceSessionEntries('s1', [
      user({ id: 'u1', sessionId: 's1', content: [{ type: 'text', text: 'hello' }] }),
      assistant({ id: 'a1', sessionId: 's1', content: [{ type: 'text', text: 'world' }], status: 'done' }),
    ])

    expect(subscriberCalled).toBe(false)
    expect(useMessageStore.getState().entriesBySession).toBe(prevEntriesBySession)

    // Calling replaceSessionEntries with changed entries
    useMessageStore.getState().replaceSessionEntries('s1', [
      user({ id: 'u1', sessionId: 's1', content: [{ type: 'text', text: 'hello updated' }] }),
    ])

    expect(subscriberCalled).toBe(true)
    expect(useMessageStore.getState().entriesBySession).not.toBe(prevEntriesBySession)
    unsub()
  })

  it('removeEntry deletes by session + id only', () => {
    useMessageStore.getState().appendEntry(user({ id: 'u1', sessionId: 's1' }))
    useMessageStore.getState().appendEntry(assistant({ id: 'a1', sessionId: 's1' }))
    useMessageStore.getState().appendEntry(assistant({ id: 'a1', sessionId: 's2' }))

    useMessageStore.getState().removeEntry('s1', 'a1')
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual(['u1'])
    expect(useMessageStore.getState().getEntries('s2').map((e) => e.id)).toEqual(['a1'])
  })

  it('projects ToolResult pairing, compaction divider, and statuses', () => {
    const entries: ConversationEntry[] = [
      user({ id: 'u1', sessionId: 's1', content: [{ type: 'text', text: 'run' }] }),
      assistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'working' },
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
      toolResult({
        id: 'tr1',
        sessionId: 's1',
        toolCallId: 'tc1',
        content: [{ type: 'text', text: 'file.txt' }],
      }),
      compaction({ id: 'c1', sessionId: 's1', firstKeptEntryId: 'a1' }),
      assistant({
        id: 'a2',
        sessionId: 's1',
        status: 'streaming',
        stopReason: 'pending',
        content: [
          {
            type: 'toolCall',
            id: 'tc2',
            name: 'read',
            arguments: { path: 'x' },
          },
        ],
      }),
    ]
    for (const entry of entries) {
      useMessageStore.getState().appendEntry(entry)
    }

    const display = useMessageStore.getState().getDisplayMessages('s1')
    expect(display.map((d) => d.kind)).toEqual([
      'message',
      'message',
      'compaction',
      'message',
    ])
    const assistantMsg = display[1]
    expect(assistantMsg.kind).toBe('message')
    if (assistantMsg.kind !== 'message') return
    expect(assistantMsg.status).toBe('done')
    const toolPart = assistantMsg.parts?.find((p) => p.type === 'tool_call')
    expect(toolPart).toMatchObject({
      type: 'tool_call',
      id: 'tc1',
      status: 'done',
      result: 'file.txt',
    })

    const streaming = display[3]
    expect(streaming.kind).toBe('message')
    if (streaming.kind !== 'message') return
    const runningTool = streaming.parts?.find((p) => p.type === 'tool_call')
    expect(runningTool).toMatchObject({ status: 'running' })
  })

  it('hydrates legacy, mixed, and canonical payloads via Task2 migration', () => {
    useMessageStore.getState().hydrate({
      s1: [
        {
          id: 'legacy-u',
          sessionId: 's1',
          role: 'user',
          content: 'hello legacy',
          createdAt: 10,
        },
        {
          id: 'legacy-a',
          sessionId: 's1',
          role: 'assistant',
          content: 'partial',
          status: 'streaming',
          createdAt: 11,
          parts: [
            { type: 'text', text: 'partial' },
            {
              type: 'tool_call',
              id: 't1',
              name: 'bash',
              args: { command: 'echo' },
              status: 'running',
            },
          ],
        },
        {
          id: 'canon-u',
          sessionId: 's1',
          kind: 'user',
          version: 1,
          createdAt: 12,
          content: [{ type: 'text', text: 'already canonical' }],
        },
      ],
      s2: [
        {
          id: 'done-a',
          sessionId: 's2',
          role: 'assistant',
          content: 'complete',
          status: 'done',
          createdAt: 20,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      ],
    })

    const s1 = useMessageStore.getState().getEntries('s1')
    expect(s1.some((e) => e.kind === 'user' && e.id === 'legacy-u')).toBe(true)
    const aborted = s1.find((e) => e.id === 'legacy-a') as AssistantEntry
    expect(aborted.status).toBe('aborted')
    expect(aborted.stopReason).toBe('aborted')
    expect(s1.some((e) => e.id === 'canon-u')).toBe(true)

    const s2 = useMessageStore.getState().getEntries('s2')
    expect(s2[0]).toMatchObject({
      id: 'done-a',
      status: 'done',
      usage: { totalTokens: 3 },
    })

    // Idempotent re-hydrate with already-canonical store payload.
    const snapshot = {
      s1: useMessageStore.getState().getEntries('s1'),
      s2: useMessageStore.getState().getEntries('s2'),
    }
    useMessageStore.getState().hydrate(snapshot)
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual(
      s1.map((e) => e.id),
    )
  })

  it('isolates corrupt sessions and keeps good sessions', () => {
    useMessageStore.getState().hydrate({
      good: [
        {
          id: 'u1',
          sessionId: 'good',
          role: 'user',
          content: 'ok',
          createdAt: 1,
        },
      ],
      bad: null as unknown as ConversationEntry[],
      alsoGood: [
        {
          id: 'a1',
          sessionId: 'alsoGood',
          kind: 'assistant',
          version: 1,
          createdAt: 2,
          content: [{ type: 'text', text: 'fine' }],
          status: 'done',
          stopReason: 'stop',
        },
      ],
    })

    expect(useMessageStore.getState().getEntries('good')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('alsoGood')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('bad')).toEqual([])
    const diagnostics = useMessageStore.getState().getHydrateDiagnostics()
    expect(diagnostics.some((d) => d.sessionId === 'bad')).toBe(true)
  })

  it('does not rewrite already-terminal assistants on hydrate', () => {
    useMessageStore.getState().hydrate({
      s1: [
        {
          id: 'a1',
          sessionId: 's1',
          kind: 'assistant',
          version: 1,
          createdAt: 1,
          content: [{ type: 'text', text: 'done' }],
          status: 'done',
          stopReason: 'stop',
        },
      ],
    })
    const again = useMessageStore.getState().getEntries('s1')[0] as AssistantEntry
    expect(again.status).toBe('done')
    expect(again.stopReason).toBe('stop')
  })

  it('removeSessionMessages clears one session only', () => {
    useMessageStore.getState().appendEntry(user({ id: 'u1', sessionId: 's1' }))
    useMessageStore.getState().appendEntry(user({ id: 'u2', sessionId: 's2' }))
    useMessageStore.getState().removeSessionMessages('s1')
    expect(useMessageStore.getState().getEntries('s1')).toEqual([])
    expect(useMessageStore.getState().getEntries('s2')).toHaveLength(1)
  })

  it('supports dangerous session ids without prototype pollution', () => {
    for (const sessionId of ['__proto__', 'constructor', 'prototype']) {
      useMessageStore.getState().appendEntry(
        user({ id: `${sessionId}-u`, sessionId, content: [{ type: 'text', text: 'ok' }] }),
      )
      expect(useMessageStore.getState().getEntries(sessionId)).toHaveLength(1)
      expect(
        Object.prototype.hasOwnProperty.call(
          useMessageStore.getState().entriesBySession,
          sessionId,
        ),
      ).toBe(true)
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Array.isArray((Object.prototype as { polluted?: unknown }).polluted)).toBe(false)
  })

  it('appendMessage live mode preserves streaming status', () => {
    useMessageStore.getState().appendMessage({
      id: 'a-live',
      sessionId: 's1',
      role: 'assistant',
      content: 'partial',
      status: 'streaming',
      createdAt: 1,
    })
    const entry = useMessageStore.getState().getEntries('s1')[0] as AssistantEntry
    expect(entry.status).toBe('streaming')
    expect(entry.stopReason).toBe('pending')
  })

  it('patchMessage preserves images responseId usage and only updates specified fields', () => {
    useMessageStore.getState().appendEntry(
      assistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        stopReason: 'pending',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'img-b64', mimeType: 'image/png' },
          {
            type: 'toolCall',
            id: 't1',
            name: 'bash',
            arguments: { command: 'ls', keep: true },
          },
        ],
        responseId: 'resp-1',
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    )

    useMessageStore.getState().patchMessage('s1', 'a1', {
      content: 'hello world',
      status: 'streaming',
    })

    const entry = useMessageStore.getState().getEntries('s1')[0] as AssistantEntry
    expect(entry.content.find((b) => b.type === 'text')).toEqual({
      type: 'text',
      text: 'hello world',
    })
    expect(entry.content.find((b) => b.type === 'image')).toEqual({
      type: 'image',
      data: 'img-b64',
      mimeType: 'image/png',
    })
    expect(entry.content.find((b) => b.type === 'toolCall')).toMatchObject({
      type: 'toolCall',
      id: 't1',
      arguments: { command: 'ls', keep: true },
    })
    expect(entry.responseId).toBe('resp-1')
    expect(entry.usage?.totalTokens).toBe(3)
    expect(entry.status).toBe('streaming')
  })

  it('freezes session arrays at the store boundary', () => {
    useMessageStore.getState().appendEntry(user({ id: 'u1', sessionId: 's1' }))
    const raw = useMessageStore.getState().entriesBySession.s1
    expect(Object.isFrozen(raw)).toBe(true)
    expect(() => {
      ;(raw as ConversationEntry[]).push(user({ id: 'u2', sessionId: 's1' }))
    }).toThrow()
  })

  describe('LRU cache eviction', () => {
    it('evicts oldest session when cache capacity is exceeded and emits session-evicted event', () => {
      const evictedEvents: string[] = []
      const unsub = subscribeMessageEvents((event) => {
        if (event.type === 'session-evicted') {
          evictedEvents.push(event.sessionId)
        }
      })

      try {
        useMessageStore.getState().setMaxCachedSessions(3)

        useMessageStore.getState().replaceSessionEntries('s1', [user({ id: 'u1', sessionId: 's1' })])
        useMessageStore.getState().replaceSessionEntries('s2', [user({ id: 'u2', sessionId: 's2' })])
        useMessageStore.getState().replaceSessionEntries('s3', [user({ id: 'u3', sessionId: 's3' })])

        expect(Object.keys(useMessageStore.getState().entriesBySession)).toEqual(['s1', 's2', 's3'])

        // Add 4th session -> oldest s1 must be evicted
        useMessageStore.getState().replaceSessionEntries('s4', [user({ id: 'u4', sessionId: 's4' })])

        expect(Object.keys(useMessageStore.getState().entriesBySession)).toEqual(['s2', 's3', 's4'])
        expect(evictedEvents).toEqual(['s1'])
        expect(useMessageStore.getState().getEntries('s1')).toEqual([])
      } finally {
        unsub()
      }
    })

    it('updates LRU recency on getEntries access preventing eviction', () => {
      useMessageStore.getState().setMaxCachedSessions(3)

      useMessageStore.getState().replaceSessionEntries('s1', [user({ id: 'u1', sessionId: 's1' })])
      useMessageStore.getState().replaceSessionEntries('s2', [user({ id: 'u2', sessionId: 's2' })])
      useMessageStore.getState().replaceSessionEntries('s3', [user({ id: 'u3', sessionId: 's3' })])

      // Touch s1 to make it most recently accessed
      const s1Entries = useMessageStore.getState().getEntries('s1')
      expect(s1Entries).toHaveLength(1)

      // Add 4th session -> oldest should now be s2, not s1!
      useMessageStore.getState().replaceSessionEntries('s4', [user({ id: 'u4', sessionId: 's4' })])

      expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
      expect(useMessageStore.getState().getEntries('s2')).toEqual([])
      expect(useMessageStore.getState().getEntries('s3')).toHaveLength(1)
      expect(useMessageStore.getState().getEntries('s4')).toHaveLength(1)
    })

    it('protects active streaming sessions from LRU eviction', () => {
      useMessageStore.getState().setMaxCachedSessions(2)

      // s1 is streaming
      useMessageStore.getState().replaceSessionEntries('s1', [
        assistant({ id: 'a1', sessionId: 's1', status: 'streaming' }),
      ])
      // s2 is done
      useMessageStore.getState().replaceSessionEntries('s2', [
        user({ id: 'u2', sessionId: 's2' }),
      ])

      // Add s3 -> even though s1 is older than s2, s1 is streaming so s2 should be evicted!
      useMessageStore.getState().replaceSessionEntries('s3', [
        user({ id: 'u3', sessionId: 's3' }),
      ])

      expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
      expect(useMessageStore.getState().getEntries('s2')).toEqual([])
      expect(useMessageStore.getState().getEntries('s3')).toHaveLength(1)
    })

    it('protects a retained visible session while background sessions stream', () => {
      useMessageStore.getState().setMaxCachedSessions(2)
      useMessageStore.getState().replaceSessionEntries('visible', [
        assistant({
          id: 'visible-done',
          sessionId: 'visible',
          status: 'done',
          stopReason: 'stop',
        }),
      ])
      const release = retainMessageSession('visible')

      try {
        useMessageStore.getState().replaceSessionEntries('background-1', [
          assistant({ id: 'bg-1', sessionId: 'background-1' }),
        ])
        useMessageStore.getState().replaceSessionEntries('background-2', [
          assistant({ id: 'bg-2', sessionId: 'background-2' }),
        ])

        expect(useMessageStore.getState().getEntries('visible')).toHaveLength(1)
      } finally {
        release()
      }
    })

    it('protects session matched by protectedSessionPredicate from LRU eviction', () => {
      useMessageStore.getState().setMaxCachedSessions(2)
      useMessageStore.getState().replaceSessionEntries('active-sess', [
        user({ id: 'u-act', sessionId: 'active-sess' }),
      ])
      useMessageStore.getState().replaceSessionEntries('other-sess', [
        user({ id: 'u-other', sessionId: 'other-sess' }),
      ])
      setProtectedSessionPredicate((id) => id === 'active-sess')

      useMessageStore.getState().replaceSessionEntries('third-sess', [
        user({ id: 'u-third', sessionId: 'third-sess' }),
      ])

      expect(useMessageStore.getState().getEntries('active-sess')).toHaveLength(1)
      expect(useMessageStore.getState().getEntries('other-sess')).toEqual([])
      expect(useMessageStore.getState().getEntries('third-sess')).toHaveLength(1)
    })
  })
})
