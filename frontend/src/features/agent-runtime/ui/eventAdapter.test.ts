import { beforeEach, describe, expect, it } from 'vitest'
import { TOOL_REJECTED_MESSAGE } from '../agent/approvals'
import type { AgentRunEvent } from '../agent/types'
import type {
  AssistantEntry,
  CompactionEntry,
  ConversationEntry,
  ToolResultEntry,
  UserEntry,
} from '../session/types'
import { useMessageStore } from '@/stores/messageStore'
import {
  __resetCompactionOverlayStoreForTests,
  useCompactionOverlayStore,
} from '@/stores/compactionOverlayStore'
import {
  __resetToolOverlayStoreForTests,
  createToolOverlayStore,
  useToolOverlayStore,
} from '@/stores/toolOverlayStore'
import {
  __resetAgentEventAdapterRegistryForTests,
  classifyToolEndStatus,
  createAgentEventAdapter,
  type ApplyAgentEventResult,
  type PersistUrgency,
} from './eventAdapter'

function baseAssistant(
  partial: Partial<AssistantEntry> & Pick<AssistantEntry, 'id' | 'sessionId'>,
): AssistantEntry {
  return {
    kind: 'assistant',
    version: 1,
    createdAt: 1,
    content: [{ type: 'text', text: '' }],
    status: 'streaming',
    stopReason: 'pending',
    ...partial,
  }
}

describe('createAgentEventAdapter', () => {
  beforeEach(() => {
    useMessageStore.setState({ entriesBySession: {} })
    __resetAgentEventAdapterRegistryForTests(useMessageStore)
    __resetToolOverlayStoreForTests()
    __resetCompactionOverlayStoreForTests()
  })

  it('scopes active run per session and ignores late old-run events', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const start = adapter.apply({
      type: 'agent-start',
      runId: 'run-1',
      sessionId: 's1',
    })
    expect(start.changed).toBe(false)
    expect(start.urgency).toBe('none')

    const a1 = baseAssistant({
      id: 'a1',
      sessionId: 's1',
      content: [{ type: 'text', text: 'from-run-1' }],
    })
    adapter.apply({
      type: 'assistant-start',
      runId: 'run-1',
      sessionId: 's1',
      entry: a1,
    })

    // Late agent-start is ignored while another run is still active.
    const lateStart = adapter.apply({
      type: 'agent-start',
      runId: 'run-2',
      sessionId: 's1',
    })
    expect(lateStart.changed).toBe(false)
    expect(lateStart.diagnostic).toMatch(/ignored late agent-start/)
    expect(adapter.getActiveRunId('s1')).toBe('run-1')

    // After current run fully ends, a new run may start.
    adapter.apply({
      type: 'agent-end',
      runId: 'run-1',
      sessionId: 's1',
      entries: useMessageStore.getState().getEntries('s1'),
    })
    adapter.apply({ type: 'agent-start', runId: 'run-2', sessionId: 's1' })
    expect(adapter.getActiveRunId('s1')).toBe('run-2')

    const late: ApplyAgentEventResult = adapter.apply({
      type: 'assistant-update',
      runId: 'run-1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [{ type: 'text', text: 'late-should-ignore' }],
      }),
      streamEvent: {
        type: 'text-delta',
        contentIndex: 0,
        delta: 'late',
        partial: baseAssistant({ id: 'a1', sessionId: 's1' }),
      },
    })
    expect(late.changed).toBe(false)
    expect(late.urgency).toBe('none')
    expect(
      (useMessageStore.getState().getEntries('s1')[0] as AssistantEntry).content[0],
    ).toEqual({ type: 'text', text: 'from-run-1' })

    // Independent session can run in parallel.
    adapter.apply({ type: 'agent-start', runId: 'run-other', sessionId: 's2' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'run-other',
      sessionId: 's2',
      entry: baseAssistant({
        id: 'a-other',
        sessionId: 's2',
        content: [{ type: 'text', text: 'other' }],
      }),
    })
    expect(useMessageStore.getState().getEntries('s2')).toHaveLength(1)
  })

  it('updates assistant in place for start/update/end without duplicates', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })

    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({ id: 'a1', sessionId: 's1' }),
    })
    const update = adapter.apply({
      type: 'assistant-update',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'thinking', thinking: 'hmm' },
        ],
      }),
      streamEvent: {
        type: 'text-delta',
        contentIndex: 0,
        delta: 'Hello',
        partial: baseAssistant({ id: 'a1', sessionId: 's1' }),
      },
    })
    expect(update.changed).toBe(true)
    expect(update.urgency).toBe('debounce')

    const end = adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Hello world' }],
      }),
    })
    expect(end.urgency).toBe('immediate')

    const entries = useMessageStore.getState().getEntries('s1')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'a1',
      status: 'done',
      content: [{ type: 'text', text: 'Hello world' }],
    })
  })

  it('uses event entry snapshots and does not re-concatenate deltas', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [{ type: 'text', text: 'AB' }],
      }),
    })
    // Snapshot already includes full text "ABC" — adapter must not produce "ABABC".
    adapter.apply({
      type: 'assistant-update',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [{ type: 'text', text: 'ABC' }],
      }),
      streamEvent: {
        type: 'text-delta',
        contentIndex: 0,
        delta: 'C',
        partial: baseAssistant({
          id: 'a1',
          sessionId: 's1',
          content: [{ type: 'text', text: 'ABC' }],
        }),
      },
    })
    const text = (
      useMessageStore.getState().getEntries('s1')[0] as AssistantEntry
    ).content[0]
    expect(text).toEqual({ type: 'text', text: 'ABC' })
  })

  it('appends tool results once with text/image and is idempotent', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
    })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
    })

    const entry: ToolResultEntry = {
      id: 'tr-stable',
      sessionId: 's1',
      kind: 'toolResult',
      version: 1,
      createdAt: 9,
      toolCallId: 'tc1',
      toolName: 'bash',
      content: [
        { type: 'text', text: 'out' },
        { type: 'image', data: 'img64', mimeType: 'image/png' },
      ],
      isError: false,
    }
    const first = adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'bash',
      result: {
        content: [
          { type: 'text', text: 'out' },
          { type: 'image', data: 'img64', mimeType: 'image/png' },
        ],
      },
      isError: false,
      entry,
    })
    expect(first.changed).toBe(true)
    expect(first.urgency).toBe('immediate')

    const dup = adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'out' }] },
      isError: false,
      entry,
    })
    expect(dup.changed).toBe(false)

    const results = useMessageStore
      .getState()
      .getEntries('s1')
      .filter((e) => e.kind === 'toolResult') as ToolResultEntry[]
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('tr-stable')
    expect(results[0].content).toEqual([
      { type: 'text', text: 'out' },
      { type: 'image', data: 'img64', mimeType: 'image/png' },
    ])
  })

  it('does not write tool approval/start/update scratch into entries', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [
          {
            type: 'toolCall',
            id: 'tc1',
            name: 'bash',
            arguments: { command: 'rm -rf /' },
          },
        ],
      }),
    })

    for (const event of [
      {
        type: 'tool-approval-required',
        runId: 'r1',
        sessionId: 's1',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'rm -rf /' },
      },
      {
        type: 'tool-start',
        runId: 'r1',
        sessionId: 's1',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'rm -rf /' },
      },
      {
        type: 'tool-update',
        runId: 'r1',
        sessionId: 's1',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: {
          content: [{ type: 'text', text: 'partial' }],
          details: { partialJson: '{}' },
        },
      },
    ] as AgentRunEvent[]) {
      const result = adapter.apply(event)
      expect(result.changed).toBe(false)
      expect(result.urgency).toBe('none')
    }

    const stored = useMessageStore.getState().getEntries('s1')
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toContain('partialJson')
    expect(JSON.stringify(stored)).not.toContain('awaiting_approval')
  })

  it('appends compaction once and ignores compaction-start', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    expect(
      adapter.apply({ type: 'compaction-start', runId: 'r1', sessionId: 's1' }),
    ).toEqual({ changed: false, urgency: 'none' })
    expect(useCompactionOverlayStore.getState().bySession.s1).toBe(true)

    const entry: CompactionEntry = {
      id: 'c1',
      sessionId: 's1',
      kind: 'compaction',
      version: 1,
      createdAt: 5,
      summary: 'compressed',
      firstKeptEntryId: 'u1',
    }
    expect(
      adapter.apply({
        type: 'compaction-end',
        runId: 'r1',
        sessionId: 's1',
        entry,
      }).urgency,
    ).toBe('immediate')
    expect(
      adapter.apply({
        type: 'compaction-end',
        runId: 'r1',
        sessionId: 's1',
        entry,
      }).changed,
    ).toBe(false)
    expect(
      useMessageStore.getState().getEntries('s1').filter((e) => e.kind === 'compaction'),
    ).toHaveLength(1)
    expect(useCompactionOverlayStore.getState().bySession.s1).toBeUndefined()
  })

  it('retrying does not persist failed partials; same assistant id resets on new start', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [{ type: 'text', text: 'attempt-1' }],
      }),
    })
    expect(
      adapter.apply({
        type: 'retrying',
        runId: 'r1',
        sessionId: 's1',
        attempt: 1,
        delayMs: 2000,
        error: 'stream closed',
      }),
    ).toEqual({ changed: false, urgency: 'none' })

    // Same id restarts: replace/reset content.
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        content: [{ type: 'text', text: '' }],
      }),
    })
    const entries = useMessageStore.getState().getEntries('s1')
    expect(entries).toHaveLength(1)
    expect((entries[0] as AssistantEntry).content[0]).toEqual({
      type: 'text',
      text: '',
    })
  })

  it('agent-end authoritative reconcile cannot be overwritten by late old run', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'old', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'old',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a-old',
        sessionId: 's1',
        content: [{ type: 'text', text: 'old' }],
      }),
    })
    adapter.apply({
      type: 'agent-end',
      runId: 'old',
      sessionId: 's1',
      entries: useMessageStore.getState().getEntries('s1'),
    })

    adapter.apply({ type: 'agent-start', runId: 'new', sessionId: 's1' })
    const finalEntries: ConversationEntry[] = [
      {
        id: 'u1',
        sessionId: 's1',
        kind: 'user',
        version: 1,
        createdAt: 1,
        content: [{ type: 'text', text: 'q' }],
      },
      baseAssistant({
        id: 'a-new',
        sessionId: 's1',
        status: 'done',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'authoritative' }],
      }),
    ]
    const end = adapter.apply({
      type: 'agent-end',
      runId: 'new',
      sessionId: 's1',
      entries: finalEntries,
    })
    expect(end.changed).toBe(true)
    expect(end.urgency).toBe('immediate')
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual([
      'u1',
      'a-new',
    ])

    // Late agent-end from old run ignored.
    const late = adapter.apply({
      type: 'agent-end',
      runId: 'old',
      sessionId: 's1',
      entries: [
        baseAssistant({
          id: 'a-old',
          sessionId: 's1',
          status: 'done',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'stale' }],
        }),
      ],
    })
    expect(late.changed).toBe(false)
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual([
      'u1',
      'a-new',
    ])
  })

  it('terminates active run on aborted/error after applying prior terminal entries', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'aborted',
        stopReason: 'aborted',
        content: [{ type: 'text', text: 'cut' }],
      }),
    })
    const aborted = adapter.apply({
      type: 'aborted',
      runId: 'r1',
      sessionId: 's1',
    })
    expect(aborted.changed).toBe(false)
    expect(useMessageStore.getState().getEntries('s1')[0]).toMatchObject({
      status: 'aborted',
    })

    // After terminate, same run is ignored.
    expect(
      adapter.apply({
        type: 'assistant-update',
        runId: 'r1',
        sessionId: 's1',
        entry: baseAssistant({
          id: 'a1',
          sessionId: 's1',
          content: [{ type: 'text', text: 'after-abort' }],
        }),
        streamEvent: {
          type: 'text-delta',
          contentIndex: 0,
          delta: 'x',
          partial: baseAssistant({ id: 'a1', sessionId: 's1' }),
        },
      }).changed,
    ).toBe(false)
  })

  it('builds deterministic tool result when entry is omitted', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 'call-9',
            name: 'read',
            arguments: {},
          },
        ],
      }),
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call-9',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'body' }], isError: false },
      isError: false,
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call-9',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'body' }], isError: false },
      isError: false,
    })
    const results = useMessageStore
      .getState()
      .getEntries('s1')
      .filter((e) => e.kind === 'toolResult') as ToolResultEntry[]
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('tool-result:s1:call-9')
    expect(results[0].toolName).toBe('read')
  })

  it('returns typed urgency values for Task18 drivers', () => {
    const urgencies: PersistUrgency[] = ['none', 'debounce', 'immediate']
    expect(urgencies).toContain('debounce')
  })

  it('keeps agent-end after error/aborted terminal-pending and rejects later late events', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'error',
        stopReason: 'error',
        content: [{ type: 'text', text: 'partial' }],
      }),
    })
    expect(
      adapter.apply({
        type: 'error',
        runId: 'r1',
        sessionId: 's1',
        message: 'boom',
      }).changed,
    ).toBe(false)

    const end = adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
      entries: [
        baseAssistant({
          id: 'a1',
          sessionId: 's1',
          status: 'error',
          stopReason: 'error',
          content: [{ type: 'text', text: 'authoritative-error' }],
        }),
      ],
    })
    expect(end.changed).toBe(true)
    expect(
      (useMessageStore.getState().getEntries('s1')[0] as AssistantEntry).content[0],
    ).toEqual({ type: 'text', text: 'authoritative-error' })

    // A delayed duplicate start must not reactivate an already-ended run.
    expect(
      adapter.apply({
        type: 'agent-start',
        runId: 'r1',
        sessionId: 's1',
      }).changed,
    ).toBe(false)
    expect(adapter.getActiveRunId('s1')).toBeNull()

    // Late same-run event after agent-end is rejected via endedRuns.
    expect(
      adapter.apply({
        type: 'assistant-update',
        runId: 'r1',
        sessionId: 's1',
        entry: baseAssistant({
          id: 'a1',
          sessionId: 's1',
          content: [{ type: 'text', text: 'too-late' }],
        }),
        streamEvent: {
          type: 'text-delta',
          contentIndex: 0,
          delta: 'x',
          partial: baseAssistant({ id: 'a1', sessionId: 's1' }),
        },
      }).changed,
    ).toBe(false)
  })

  it('agent-start can replace terminal-pending run that never received agent-end', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({ type: 'aborted', runId: 'r1', sessionId: 's1' })
    adapter.apply({ type: 'agent-start', runId: 'r2', sessionId: 's1' })
    expect(adapter.getActiveRunId('s1')).toBe('r2')
    adapter.apply({
      type: 'assistant-start',
      runId: 'r2',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a2',
        sessionId: 's1',
        content: [{ type: 'text', text: 'new-run' }],
      }),
    })
    expect(useMessageStore.getState().getEntries('s1')[0]).toMatchObject({
      id: 'a2',
    })
  })

  it('agent-end preserves external additions and non-owned concurrent edits', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    useMessageStore.getState().appendEntry({
      id: 'base-user',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 1,
      content: [{ type: 'text', text: 'base' }],
    })
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a-run',
        sessionId: 's1',
        content: [{ type: 'text', text: 'stream' }],
      }),
    })

    // External concurrent edit to base entry (not run-owned).
    useMessageStore.getState().replaceEntry({
      id: 'base-user',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 1,
      content: [{ type: 'text', text: 'base-edited' }],
    })
    // External addition after base.
    useMessageStore.getState().appendEntry({
      id: 'external-note',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 9,
      content: [{ type: 'text', text: 'note' }],
    })

    adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
      entries: [
        {
          id: 'base-user',
          sessionId: 's1',
          kind: 'user',
          version: 1,
          createdAt: 1,
          content: [{ type: 'text', text: 'base' }],
        },
        baseAssistant({
          id: 'a-run',
          sessionId: 's1',
          status: 'done',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'final' }],
        }),
      ],
    })

    const ids = useMessageStore.getState().getEntries('s1').map((e) => e.id)
    expect(ids).toContain('external-note')
    expect(ids).toContain('a-run')
    const base = useMessageStore
      .getState()
      .getEntries('s1')
      .find((e) => e.id === 'base-user') as { content: { text: string }[] }
    expect(base.content[0].text).toBe('base-edited')
    const assistant = useMessageStore
      .getState()
      .getEntries('s1')
      .find((e) => e.id === 'a-run') as AssistantEntry
    expect(assistant.content[0]).toEqual({ type: 'text', text: 'final' })
  })

  it('agent-end preserves interleaved order of queued messages inserted during run', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    useMessageStore.getState().appendEntry({
      id: 'u0',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 1,
      content: [{ type: 'text', text: 'original user message' }],
    })
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    // Assistant emits first turn part
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a0-1',
        sessionId: 's1',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
      }),
    })

    // User enqueues message 1 during run
    useMessageStore.getState().appendEntry({
      id: 'u-queue-1',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 2,
      pendingStatus: 'queue',
      content: [{ type: 'text', text: 'queued 1' }],
    })

    // Run continues: tool result and next assistant part (continuing growth)
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a0-2',
        sessionId: 's1',
        content: [{ type: 'text', text: 'assistant part 2' }],
      }),
    })

    // User enqueues message 2, 3, 4
    useMessageStore.getState().appendEntry({
      id: 'u-queue-2',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 3,
      pendingStatus: 'queue',
      content: [{ type: 'text', text: 'queued 2' }],
    })
    useMessageStore.getState().appendEntry({
      id: 'u-queue-3',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 4,
      pendingStatus: 'queue',
      content: [{ type: 'text', text: 'queued 3' }],
    })
    useMessageStore.getState().appendEntry({
      id: 'u-queue-4',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 5,
      pendingStatus: 'queue',
      content: [{ type: 'text', text: 'queued 4' }],
    })

    // Run ends with authoritative entries
    adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
      entries: [
        {
          id: 'u0',
          sessionId: 's1',
          kind: 'user',
          version: 1,
          createdAt: 1,
          content: [{ type: 'text', text: 'original user message' }],
        },
        baseAssistant({
          id: 'a0-1',
          sessionId: 's1',
          status: 'done',
          content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }],
        }),
        baseAssistant({
          id: 'a0-2',
          sessionId: 's1',
          status: 'done',
          content: [{ type: 'text', text: 'assistant part 2' }],
        }),
      ],
    })

    const finalIds = useMessageStore.getState().getEntries('s1').map((e) => e.id)
    // First run entries remain contiguous (u0 -> a0-1 -> a0-2), followed by queued messages
    expect(finalIds).toEqual([
      'u0',
      'a0-1',
      'a0-2',
      'u-queue-1',
      'u-queue-2',
      'u-queue-3',
      'u-queue-4',
    ])
  })

  it('shares active-run registry across adapters for the same store', () => {
    const a = createAgentEventAdapter(useMessageStore)
    const b = createAgentEventAdapter(useMessageStore)
    a.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    expect(b.getActiveRunId('s1')).toBe('r1')
    const late = b.apply({ type: 'agent-start', runId: 'r2', sessionId: 's1' })
    expect(late.diagnostic).toMatch(/ignored late agent-start/)
    expect(a.getActiveRunId('s1')).toBe('r1')
    a.dispose()
    expect(b.getActiveRunId('s1')).toBeNull()
  })

  it('ignores entry payloads whose sessionId mismatches the event', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    const bad = adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 'other',
        content: [{ type: 'text', text: 'x' }],
      }),
    })
    expect(bad.changed).toBe(false)
    expect(bad.diagnostic).toMatch(/sessionId mismatch/)
    expect(useMessageStore.getState().getEntries('s1')).toEqual([])
    expect(useMessageStore.getState().getEntries('other')).toEqual([])

    const end = adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
      entries: [
        baseAssistant({
          id: 'a1',
          sessionId: 'other',
          status: 'done',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'nope' }],
        }),
      ],
    })
    expect(end.changed).toBe(false)
    expect(end.diagnostic).toMatch(/sessionId mismatch/)
  })

  it('buffers tool-end until assistant is stable and inserts by toolCall order', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        content: [
          { type: 'text', text: 'using tools' },
          {
            type: 'toolCall',
            id: 'call_a|fc_a',
            name: 'read',
            arguments: { path: 'a' },
          },
          {
            type: 'toolCall',
            id: 'call_b|fc_b',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
    })

    // Results may complete out of order while assistant is still streaming.
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_b|fc_b',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'b-result' }], isError: false },
      isError: false,
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_a|fc_a',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'a-result' }], isError: false },
      isError: false,
    })
    // Buffered — not yet in store.
    expect(
      useMessageStore.getState().getEntries('s1').filter((e) => e.kind === 'toolResult'),
    ).toHaveLength(0)

    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'using tools' },
          {
            type: 'toolCall',
            id: 'call_a|fc_a',
            name: 'read',
            arguments: { path: 'a' },
          },
          {
            type: 'toolCall',
            id: 'call_b|fc_b',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
    })

    const entries = useMessageStore.getState().getEntries('s1')
    expect(entries.map((e) => e.kind)).toEqual([
      'assistant',
      'toolResult',
      'toolResult',
    ])
    expect((entries[1] as ToolResultEntry).toolCallId).toBe('call_a|fc_a')
    expect((entries[2] as ToolResultEntry).toolCallId).toBe('call_b|fc_b')
    expect((entries[1] as ToolResultEntry).id).toBe('tool-result:s1:call_a')
    expect((entries[2] as ToolResultEntry).id).toBe('tool-result:s1:call_b')
  })

  it('dedupes tool results by normalized call_id first-wins', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 'call_1|fc_a',
            name: 'read',
            arguments: {},
          },
        ],
      }),
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_1|fc_a',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'first' }], isError: false },
      isError: false,
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_1|fc_b',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'second' }], isError: false },
      isError: false,
    })
    const results = useMessageStore
      .getState()
      .getEntries('s1')
      .filter((e) => e.kind === 'toolResult') as ToolResultEntry[]
    expect(results).toHaveLength(1)
    expect(results[0].content[0]).toEqual({ type: 'text', text: 'first' })
    expect(results[0].id).toBe('tool-result:s1:call_1')
  })

  it('agent-end keeps external deletions of base user/assistant/toolResult', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const baseUser: ConversationEntry = {
      id: 'base-user',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 1,
      content: [{ type: 'text', text: 'keep-me-deleted' }],
    }
    const baseAssistantEntry = baseAssistant({
      id: 'base-assistant',
      sessionId: 's1',
      status: 'done',
      stopReason: 'toolUse',
      content: [
        {
          type: 'toolCall',
          id: 'call_old|fc_old',
          name: 'read',
          arguments: { path: 'old.ts' },
        },
      ],
    })
    const baseTool: ToolResultEntry = {
      id: 'tool-result:s1:call_old',
      sessionId: 's1',
      kind: 'toolResult',
      version: 1,
      createdAt: 2,
      toolCallId: 'call_old|fc_old',
      toolName: 'read',
      content: [{ type: 'text', text: 'old-result' }],
      isError: false,
    }
    useMessageStore.getState().appendEntry(baseUser)
    useMessageStore.getState().appendEntry(baseAssistantEntry)
    useMessageStore.getState().appendEntry(baseTool)

    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a-run',
        sessionId: 's1',
        content: [{ type: 'text', text: 'run' }],
      }),
    })

    // External deletions during the run (not adapter-owned).
    useMessageStore.getState().removeEntry('s1', 'base-user')
    useMessageStore.getState().removeEntry('s1', 'base-assistant')
    useMessageStore.getState().removeEntry('s1', 'tool-result:s1:call_old')

    adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
      entries: [
        baseUser,
        baseAssistantEntry,
        baseTool,
        baseAssistant({
          id: 'a-run',
          sessionId: 's1',
          status: 'done',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'final' }],
        }),
      ],
    })

    const ids = useMessageStore.getState().getEntries('s1').map((e) => e.id)
    expect(ids).not.toContain('base-user')
    expect(ids).not.toContain('base-assistant')
    expect(ids).not.toContain('tool-result:s1:call_old')
    expect(ids).toContain('a-run')
  })

  it('does not buffer tool-end for unknown call ids; flushes known buffer on agent-end without entries', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        content: [
          {
            type: 'toolCall',
            id: 'call_known|fc_1',
            name: 'read',
            arguments: { path: 'a.ts' },
          },
        ],
      }),
    })

    const unknown = adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_unknown|fc_x',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'nope' }], isError: false },
      isError: false,
    })
    expect(unknown.changed).toBe(false)
    expect(
      useMessageStore.getState().getEntries('s1').filter((e) => e.kind === 'toolResult'),
    ).toHaveLength(0)

    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_known|fc_1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'known-result' }], isError: false },
      isError: false,
    })
    // Still buffered while assistant streams.
    expect(
      useMessageStore.getState().getEntries('s1').filter((e) => e.kind === 'toolResult'),
    ).toHaveLength(0)

    // Terminal-pending then agent-end without authoritative entries must flush buffer.
    adapter.apply({ type: 'error', runId: 'r1', sessionId: 's1', message: 'boom' })
    const end = adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
    })
    expect(end.changed).toBe(true)
    expect(end.urgency).toBe('immediate')
    const results = useMessageStore
      .getState()
      .getEntries('s1')
      .filter((e) => e.kind === 'toolResult') as ToolResultEntry[]
    expect(results).toHaveLength(1)
    expect(results[0].content[0]).toEqual({ type: 'text', text: 'known-result' })
    expect(results[0].id).toBe('tool-result:s1:call_known')
    expect(adapter.getActiveRunId('s1')).toBeNull()
  })

  it('clears pending tool buffer on new run and authoritative agent-end', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        content: [
          {
            type: 'toolCall',
            id: 'call_1|fc_1',
            name: 'read',
            arguments: {},
          },
        ],
      }),
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_1|fc_1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'stale' }], isError: false },
      isError: false,
    })

    // Force terminal-pending then replace with a new run (clears buffer).
    adapter.apply({ type: 'aborted', runId: 'r1', sessionId: 's1' })
    adapter.apply({ type: 'agent-start', runId: 'r2', sessionId: 's1' })
    adapter.apply({
      type: 'agent-end',
      runId: 'r2',
      sessionId: 's1',
      entries: [
        baseAssistant({
          id: 'a2',
          sessionId: 's1',
          status: 'done',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'fresh' }],
        }),
      ],
    })

    const results = useMessageStore
      .getState()
      .getEntries('s1')
      .filter((e) => e.kind === 'toolResult')
    expect(results).toHaveLength(0)
    expect(useMessageStore.getState().getEntries('s1').map((e) => e.id)).toEqual([
      'a2',
    ])
  })

  it('terminal agent-end without entries flushes pending tools in buffer source order (b then a)', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        content: [
          {
            type: 'toolCall',
            id: 'call_a|fc_a',
            name: 'read',
            arguments: { path: 'a' },
          },
          {
            type: 'toolCall',
            id: 'call_b|fc_b',
            name: 'bash',
            arguments: { command: 'ls' },
          },
        ],
      }),
    })

    // Buffer arrival order is b then a (reverse of assistant toolCall order).
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_b|fc_b',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'b-result' }], isError: false },
      isError: false,
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_a|fc_a',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'a-result' }], isError: false },
      isError: false,
    })
    expect(
      useMessageStore.getState().getEntries('s1').filter((e) => e.kind === 'toolResult'),
    ).toHaveLength(0)

    // No assistant-end / no authoritative entries: terminal fallback flush.
    adapter.apply({ type: 'error', runId: 'r1', sessionId: 's1', message: 'boom' })
    const end = adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
    })
    expect(end.changed).toBe(true)

    const entries = useMessageStore.getState().getEntries('s1')
    expect(entries.map((e) => e.kind)).toEqual([
      'assistant',
      'toolResult',
      'toolResult',
    ])
    // Must keep pending Map insertion order (b then a), not re-sort by toolCall order.
    expect((entries[1] as ToolResultEntry).toolCallId).toBe('call_b|fc_b')
    expect((entries[2] as ToolResultEntry).toolCallId).toBe('call_a|fc_a')
    expect((entries[1] as ToolResultEntry).content[0]).toEqual({
      type: 'text',
      text: 'b-result',
    })
    expect((entries[2] as ToolResultEntry).content[0]).toEqual({
      type: 'text',
      text: 'a-result',
    })
  })

  it('terminal agent-end flush dedupes existing store results first-wins over buffer', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-start',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'streaming',
        content: [
          {
            type: 'toolCall',
            id: 'call_a|fc_a',
            name: 'read',
            arguments: {},
          },
          {
            type: 'toolCall',
            id: 'call_b|fc_b',
            name: 'bash',
            arguments: {},
          },
        ],
      }),
    })

    // Buffer both results (source order b then a).
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_b|fc_b',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'buffer-b' }], isError: false },
      isError: false,
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_a|fc_a',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'buffer-a' }], isError: false },
      isError: false,
    })

    // Inject an existing result for call_a after buffer, before terminal flush.
    useMessageStore.getState().appendEntry({
      id: 'existing-a',
      sessionId: 's1',
      createdAt: 99,
      kind: 'toolResult',
      version: 1,
      toolCallId: 'call_a',
      toolName: 'read',
      content: [{ type: 'text', text: 'existing-a' }],
      isError: false,
    })

    adapter.apply({ type: 'error', runId: 'r1', sessionId: 's1', message: 'x' })
    const end = adapter.apply({
      type: 'agent-end',
      runId: 'r1',
      sessionId: 's1',
    })
    expect(end.changed).toBe(true)

    const entries = useMessageStore.getState().getEntries('s1')
    const results = entries.filter(
      (e): e is ToolResultEntry => e.kind === 'toolResult',
    )
    // call_a keeps existing first-wins; call_b flushes from buffer; no buffer-a dup.
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(
      ['existing-a', 'tool-result:s1:call_b'].sort(),
    )
    const byNorm = Object.fromEntries(
      results.map((r) => [r.toolCallId.split('|', 1)[0], r]),
    )
    expect(byNorm.call_a.content[0]).toEqual({
      type: 'text',
      text: 'existing-a',
    })
    expect(byNorm.call_b.content[0]).toEqual({
      type: 'text',
      text: 'buffer-b',
    })
  })

  it('updates ephemeral overlay for approval/start/update/end without persisting details', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 'call_x|fc',
            name: 'edit',
            arguments: { path: 'a.ts' },
          },
        ],
      }),
    })

    adapter.apply({
      type: 'tool-approval-required',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'edit',
      args: { path: 'a.ts' },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 'call_x')?.status).toBe(
      'awaiting_approval',
    )

    adapter.apply({
      type: 'tool-start',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'edit',
      args: { path: 'a.ts' },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 'call_x')?.status).toBe(
      'running',
    )

    adapter.apply({
      type: 'tool-update',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'partial-bash' }],
        details: { diff: '+line' },
      },
    })
    const mid = useToolOverlayStore.getState().getOverlay('s1', 'call_x')
    expect(mid?.partialOutput).toBe('partial-bash')
    expect(mid?.details).toEqual({ diff: '+line' })

    const end = adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'edit',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', data: 'imgdata', mimeType: 'image/png' },
        ],
        details: { diff: '+final', patch: 'p' },
      },
    })
    expect(end.changed).toBe(true)
    const final = useToolOverlayStore.getState().getOverlay('s1', 'call_x')
    expect(final?.status).toBe('done')
    expect(final?.details).toEqual({ diff: '+final', patch: 'p' })
    expect(final?.resultImages).toEqual([
      { data: 'imgdata', mimeType: 'image/png' },
    ])
    // Terminal explicitly clears partial (undefined, not leftover stream text).
    expect(final?.partialOutput).toBeUndefined()

    const stored = useMessageStore.getState().getEntries('s1')
    expect(JSON.stringify(stored)).not.toContain('+final')
    expect(JSON.stringify(stored)).not.toContain('partial-bash')
    const tool = stored.find((e) => e.kind === 'toolResult') as ToolResultEntry
    expect(tool.content.some((b) => b.type === 'image')).toBe(true)
  })

  it('classifies rejected/aborted tool-end deterministically and clears overlay on agent-start', () => {
    expect(
      classifyToolEndStatus(
        { content: [{ type: 'text', text: TOOL_REJECTED_MESSAGE }], isError: true },
        true,
      ),
    ).toBe('rejected')
    expect(
      classifyToolEndStatus(
        { content: [{ type: 'text', text: 'Tool execution aborted' }], isError: true },
        true,
      ),
    ).toBe('aborted')
    expect(
      classifyToolEndStatus(
        { content: [{ type: 'text', text: 'boom' }], isError: true },
        true,
      ),
    ).toBe('error')

    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: 't1',
            name: 'bash',
            arguments: {},
          },
        ],
      }),
    })
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'bash',
      isError: true,
      result: {
        content: [{ type: 'text', text: TOOL_REJECTED_MESSAGE }],
        isError: true,
      },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')?.status).toBe(
      'rejected',
    )

    // Finish r1 so a new start is accepted; agent-start clears prior overlays.
    adapter.apply({ type: 'agent-end', runId: 'r1', sessionId: 's1' })
    // agent-end keeps final overlay by design until the next agent-start.
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')?.status).toBe(
      'rejected',
    )
    adapter.apply({ type: 'agent-start', runId: 'r2', sessionId: 's1' })
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')).toBeUndefined()

    // Late old-run tool-update must not revive overlay.
    adapter.apply({
      type: 'tool-update',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'late' }] },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')).toBeUndefined()
  })

  it('isolates overlays across sessions and dispose clears all', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({ type: 'agent-start', runId: 'r2', sessionId: 's2' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }],
      }),
    })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r2',
      sessionId: 's2',
      entry: baseAssistant({
        id: 'a2',
        sessionId: 's2',
        status: 'done',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't2', name: 'bash', arguments: {} }],
      }),
    })
    adapter.apply({
      type: 'tool-start',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'bash',
      args: {},
    })
    adapter.apply({
      type: 'tool-start',
      runId: 'r2',
      sessionId: 's2',
      toolCallId: 't2',
      toolName: 'bash',
      args: {},
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')?.status).toBe(
      'running',
    )
    expect(useToolOverlayStore.getState().getOverlay('s2', 't2')?.status).toBe(
      'running',
    )
    adapter.dispose()
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')).toBeUndefined()
    expect(useToolOverlayStore.getState().getOverlay('s2', 't2')).toBeUndefined()
  })

  it('keeps per-adapter overlay instances; dispose of one does not clear the other', () => {
    const overlayA = createToolOverlayStore()
    const overlayB = createToolOverlayStore()
    const adapterA = createAgentEventAdapter(useMessageStore, {
      overlayStore: overlayA,
    })
    const adapterB = createAgentEventAdapter(useMessageStore, {
      overlayStore: overlayB,
    })

    adapterA.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    // Second start on same session is ignored while r1 active — use s2 for B.
    adapterB.apply({ type: 'agent-start', runId: 'r2', sessionId: 's2' })

    adapterA.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tA', name: 'bash', arguments: {} }],
      }),
    })
    adapterB.apply({
      type: 'assistant-end',
      runId: 'r2',
      sessionId: 's2',
      entry: baseAssistant({
        id: 'a2',
        sessionId: 's2',
        status: 'done',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'tB', name: 'bash', arguments: {} }],
      }),
    })

    adapterA.apply({
      type: 'tool-start',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'tA',
      toolName: 'bash',
      args: {},
    })
    adapterB.apply({
      type: 'tool-start',
      runId: 'r2',
      sessionId: 's2',
      toolCallId: 'tB',
      toolName: 'bash',
      args: {},
    })

    expect(overlayA.getState().getOverlay('s1', 'tA')?.status).toBe('running')
    expect(overlayB.getState().getOverlay('s2', 'tB')?.status).toBe('running')
    // Cross-instance isolation.
    expect(overlayA.getState().getOverlay('s2', 'tB')).toBeUndefined()
    expect(overlayB.getState().getOverlay('s1', 'tA')).toBeUndefined()

    adapterA.dispose()
    expect(overlayA.getState().getOverlay('s1', 'tA')).toBeUndefined()
    // B's overlay must survive A.dispose.
    expect(overlayB.getState().getOverlay('s2', 'tB')?.status).toBe('running')
    expect(useToolOverlayStore.getState().getOverlay('s1', 'tA')).toBeUndefined()

    adapterB.dispose()
    expect(overlayB.getState().getOverlay('s2', 'tB')).toBeUndefined()
  })

  it('keeps the first terminal overlay latched against late updates and duplicate terminals', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'call_x|fc', name: 'bash', arguments: {} },
        ],
      }),
    })

    adapter.apply({
      type: 'tool-update',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'partial-1' }],
        details: { diff: '+partial' },
      },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 'call_x')?.partialOutput).toBe(
      'partial-1',
    )

    // First terminal latches overlay with image + clear partial.
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x',
      toolName: 'bash',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'first-done' },
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
        ],
        details: { diff: '+first' },
      },
    })
    const first = useToolOverlayStore.getState().getOverlay('s1', 'call_x')
    expect(first?.status).toBe('done')
    expect(first?.partialOutput).toBeUndefined()
    expect(first?.details).toEqual({ diff: '+first' })
    expect(first?.resultImages).toEqual([
      { data: 'AAA', mimeType: 'image/png' },
    ])

    // A delayed streamed update must not revive a completed command.
    adapter.apply({
      type: 'tool-update',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'post-terminal-update' }] },
    })
    const afterLateUpdate = useToolOverlayStore
      .getState()
      .getOverlay('s1', 'call_x')
    expect(afterLateUpdate?.status).toBe('done')
    expect(afterLateUpdate?.partialOutput).toBeUndefined()
    expect(afterLateUpdate?.details).toEqual({ diff: '+first' })
    expect(afterLateUpdate?.resultImages).toEqual([
      { data: 'AAA', mimeType: 'image/png' },
    ])

    // Duplicate terminal with suffix must NOT rewrite overlay (first terminal wins).
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 'call_x|fc',
      toolName: 'bash',
      isError: true,
      result: {
        content: [{ type: 'text', text: 'second-should-ignore' }],
        details: { diff: '+second', patch: 'nope' },
      },
    })
    const afterDup = useToolOverlayStore.getState().getOverlay('s1', 'call_x')
    expect(afterDup?.status).toBe('done')
    expect(afterDup?.details).toEqual({ diff: '+first' })
    expect(afterDup?.resultImages).toEqual([
      { data: 'AAA', mimeType: 'image/png' },
    ])
    expect(afterDup?.partialOutput).toBeUndefined()
  })

  it('final tool-end clears partial/details/images explicitly; empty images do not mask canonical', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    adapter.apply({ type: 'agent-start', runId: 'r1', sessionId: 's1' })
    adapter.apply({
      type: 'assistant-end',
      runId: 'r1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: {} }],
      }),
    })

    adapter.apply({
      type: 'tool-update',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'bash',
      result: {
        content: [
          { type: 'text', text: 'streaming' },
          { type: 'image', data: 'partial-img', mimeType: 'image/png' },
        ],
        details: { diff: '+live', patch: 'p' },
      },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 't1')?.resultImages).toEqual([
      { data: 'partial-img', mimeType: 'image/png' },
    ])

    // Terminal with no images + no details → explicit clear to [] / undefined.
    adapter.apply({
      type: 'tool-end',
      runId: 'r1',
      sessionId: 's1',
      toolCallId: 't1',
      toolName: 'bash',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'final text only' }],
      },
    })
    const final = useToolOverlayStore.getState().getOverlay('s1', 't1')
    expect(final?.status).toBe('done')
    expect(final?.partialOutput).toBeUndefined()
    expect(final?.details).toBeUndefined()
    expect(final?.resultImages).toEqual([])
  })

  it('auto-bootstraps active run and meta when receiving assistant-start without prior agent-start', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const a1 = baseAssistant({
      id: 'a-mid-1',
      sessionId: 's1',
      content: [{ type: 'text', text: 'mid-stream-start' }],
    })
    const res = adapter.apply({
      type: 'assistant-start',
      runId: 'run-mid-1',
      sessionId: 's1',
      entry: a1,
    })
    expect(res.changed).toBe(true)
    expect(res.urgency).toBe('debounce')
    expect(adapter.getActiveRunId('s1')).toBe('run-mid-1')
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]?.id).toBe('a-mid-1')
  })

  it('auto-bootstraps active run and meta when receiving assistant-update without prior agent-start', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const a2 = baseAssistant({
      id: 'a-mid-2',
      sessionId: 's1',
      content: [{ type: 'text', text: 'mid-stream-update' }],
    })
    const res = adapter.apply({
      type: 'assistant-update',
      runId: 'run-mid-2',
      sessionId: 's1',
      entry: a2,
      streamEvent: {
        type: 'text-delta',
        contentIndex: 0,
        delta: 'mid-stream-update',
        partial: a2,
      },
    })
    expect(res.changed).toBe(true)
    expect(res.urgency).toBe('debounce')
    expect(adapter.getActiveRunId('s1')).toBe('run-mid-2')
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]?.id).toBe('a-mid-2')
  })

  it('auto-bootstraps active run and meta when receiving tool-start without prior agent-start', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const res = adapter.apply({
      type: 'tool-start',
      runId: 'run-mid-3',
      sessionId: 's1',
      toolCallId: 'tc-mid-1',
      toolName: 'read_file',
      args: { path: 'file.ts' },
    })
    expect(res.changed).toBe(false)
    expect(adapter.getActiveRunId('s1')).toBe('run-mid-3')
    expect(
      useToolOverlayStore.getState().getOverlay('s1', 'tc-mid-1')?.status,
    ).toBe('running')
  })

  it('appends user-entry event to messageStore and ignores duplicate', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    const userEntry: UserEntry = {
      id: 'user-1',
      sessionId: 's1',
      createdAt: 100,
      kind: 'user',
      content: [{ type: 'text', text: 'Hello agent runtime' }],
    }

    // 1. Initial user-entry appends
    const firstRes = adapter.apply({
      type: 'user-entry',
      runId: 'run-user-1',
      sessionId: 's1',
      entry: userEntry,
    })
    expect(firstRes.changed).toBe(true)
    expect(firstRes.urgency).toBe('none')
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]?.id).toBe('user-1')

    // 2. Duplicate user-entry with same id and identical content is ignored
    const dupRes = adapter.apply({
      type: 'user-entry',
      runId: 'run-user-1',
      sessionId: 's1',
      entry: userEntry,
    })
    expect(dupRes.changed).toBe(false)
    expect(dupRes.urgency).toBe('none')
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
  })

  it('replaces edited user entry and truncates subsequent history on user-entry event', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    useMessageStore.getState().replaceSessionEntries('s1', [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 100,
        kind: 'user',
        content: [{ type: 'text', text: 'Original prompt' }],
      },
      baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        content: [{ type: 'text', text: 'Original response' }],
      }),
      {
        id: 'u2',
        sessionId: 's1',
        createdAt: 200,
        kind: 'user',
        content: [{ type: 'text', text: 'Second prompt' }],
      },
      baseAssistant({
        id: 'a2',
        sessionId: 's1',
        status: 'done',
        content: [{ type: 'text', text: 'Second response' }],
      }),
    ])

    // Edit u1
    const editRes = adapter.apply({
      type: 'user-entry',
      runId: 'run-edit-1',
      sessionId: 's1',
      entry: {
        id: 'u1',
        sessionId: 's1',
        createdAt: 100,
        kind: 'user',
        content: [{ type: 'text', text: 'Edited prompt' }],
      },
    })
    expect(editRes.changed).toBe(true)
    expect(editRes.urgency).toBe('none')

    const entriesAfterEdit = useMessageStore.getState().getEntries('s1')
    expect(entriesAfterEdit).toHaveLength(1)
    expect(entriesAfterEdit[0]?.id).toBe('u1')
    expect(entriesAfterEdit[0]?.kind === 'user' ? entriesAfterEdit[0].content : undefined).toEqual([{ type: 'text', text: 'Edited prompt' }])

    // New run streams assistant response
    adapter.apply({
      type: 'agent-start',
      runId: 'run-edit-1',
      sessionId: 's1',
    })
    adapter.apply({
      type: 'assistant-start',
      runId: 'run-edit-1',
      sessionId: 's1',
      entry: baseAssistant({
        id: 'a-new',
        sessionId: 's1',
        status: 'streaming',
        content: [{ type: 'text', text: 'New stream...' }],
      }),
    })
    adapter.apply({
      type: 'agent-end',
      runId: 'run-edit-1',
      sessionId: 's1',
      entries: [
        {
          id: 'u1',
          sessionId: 's1',
          createdAt: 100,
          kind: 'user',
          content: [{ type: 'text', text: 'Edited prompt' }],
        },
        baseAssistant({
          id: 'a-new',
          sessionId: 's1',
          status: 'done',
          content: [{ type: 'text', text: 'New final response' }],
        }),
      ],
    })

    const finalEntries = useMessageStore.getState().getEntries('s1')
    expect(finalEntries).toHaveLength(2)
    expect(finalEntries.map((e) => e.id)).toEqual(['u1', 'a-new'])
    expect(finalEntries[0]?.kind === 'user' ? finalEntries[0].content : undefined).toEqual([{ type: 'text', text: 'Edited prompt' }])
  })

  it('replaces edited middle user entry and truncates only subsequent history', () => {
    const adapter = createAgentEventAdapter(useMessageStore)
    useMessageStore.getState().replaceSessionEntries('s1', [
      {
        id: 'u1',
        sessionId: 's1',
        createdAt: 100,
        kind: 'user',
        content: [{ type: 'text', text: 'First prompt' }],
      },
      baseAssistant({
        id: 'a1',
        sessionId: 's1',
        status: 'done',
        content: [{ type: 'text', text: 'First response' }],
      }),
      {
        id: 'u2',
        sessionId: 's1',
        createdAt: 200,
        kind: 'user',
        content: [{ type: 'text', text: 'Second prompt' }],
      },
      baseAssistant({
        id: 'a2',
        sessionId: 's1',
        status: 'done',
        content: [{ type: 'text', text: 'Second response' }],
      }),
    ])

    // Edit u2
    const editRes = adapter.apply({
      type: 'user-entry',
      runId: 'run-edit-2',
      sessionId: 's1',
      entry: {
        id: 'u2',
        sessionId: 's1',
        createdAt: 200,
        kind: 'user',
        content: [{ type: 'text', text: 'Edited second prompt' }],
      },
    })
    expect(editRes.changed).toBe(true)

    const entriesAfterEdit = useMessageStore.getState().getEntries('s1')
    expect(entriesAfterEdit).toHaveLength(3)
    expect(entriesAfterEdit.map((e) => e.id)).toEqual(['u1', 'a1', 'u2'])
    expect(entriesAfterEdit[2]?.kind === 'user' ? entriesAfterEdit[2].content : undefined).toEqual([{ type: 'text', text: 'Edited second prompt' }])
  })

  it('auto-bootstraps new run and clears previous tool overlays when previous run was terminal-pending or ended', () => {
    const adapter = createAgentEventAdapter(useMessageStore)

    // 1. Start run-1 with tool overlay
    adapter.apply({
      type: 'agent-start',
      runId: 'run-1',
      sessionId: 's1',
    })
    adapter.apply({
      type: 'tool-start',
      runId: 'run-1',
      sessionId: 's1',
      toolCallId: 'tc-1',
      toolName: 'execute_bash',
      args: { command: 'ls' },
    })
    expect(useToolOverlayStore.getState().getOverlay('s1', 'tc-1')?.status).toBe('running')

    // Mark run-1 as error (terminal-pending)
    adapter.apply({
      type: 'error',
      runId: 'run-1',
      sessionId: 's1',
      message: 'Run 1 failed',
    })

    // 2. New run-2 arrives with assistant-start without prior agent-start
    const a2 = baseAssistant({
      id: 'a-run2-1',
      sessionId: 's1',
      content: [{ type: 'text', text: 'Run 2 content' }],
    })
    const res2 = adapter.apply({
      type: 'assistant-start',
      runId: 'run-2',
      sessionId: 's1',
      entry: a2,
    })

    expect(res2.changed).toBe(true)
    expect(adapter.getActiveRunId('s1')).toBe('run-2')
    // Previous tool overlay should have been cleared
    expect(useToolOverlayStore.getState().getOverlay('s1', 'tc-1')).toBeUndefined()
    expect(useMessageStore.getState().getEntries('s1')).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]?.id).toBe('a-run2-1')
  })
})
