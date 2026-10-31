import { afterEach, describe, expect, it, vi } from 'vitest'
import { setHostBridge } from '@/application/services/hostTransport'
import {
  extractSnippet,
  extractSearchableEntryText,
  extractTextFromEntry,
  searchChats,
  splitHighlightSegments,
} from './searchChats'
import type { Session } from '@/types/models'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

describe('searchChats', () => {
  afterEach(() => {
    setHostBridge(null)
  })

  describe('backend search results', () => {
    const sessions: Session[] = [{
      id: 'cached', title: 'shell conversation', createdAt: 1, updatedAt: 2, pinned: false,
    }]

    it('returns empty backend results without scanning titles when no entries are cached', async () => {
      const SessionSearch = vi.fn().mockResolvedValue([])
      setHostBridge({ SessionSearch })
      const titleGetter = vi.fn(() => 'shell conversation')
      const uncachedSessions = [{ ...sessions[0]!, get title() { return titleGetter() } }]
      expect(await searchChats({ query: ' shell ', sessions: uncachedSessions })).toEqual([])
      expect(SessionSearch).toHaveBeenCalledWith('shell', 50)
      expect(titleGetter).not.toHaveBeenCalled()
    })

    it('returns nonempty backend results without reading cached entries', async () => {
      const backendResults = [{ sessionId: 'remote', title: 'Remote', updatedAt: 3, matchType: 'content' as const }]
      setHostBridge({ SessionSearch: vi.fn().mockResolvedValue(backendResults) })
      const entriesBySession: Record<string, ConversationEntry[]> = {
        get cached(): ConversationEntry[] {
          throw new Error('Cached entries must not be scanned')
        },
      }
      expect(await searchChats({ query: 'shell', sessions, entriesBySession })).toBe(backendResults)
    })

    it('retains in-memory fallback for empty backend results with cached entries', async () => {
      setHostBridge({ SessionSearch: vi.fn().mockResolvedValue([]) })
      expect(await searchChats({ query: 'shell', sessions, entriesBySession: { cached: [] } }))
        .toEqual([expect.objectContaining({ sessionId: 'cached', matchType: 'title' })])
    })

    it('returns Unicode title matches from the backend without scanning local titles', async () => {
      const backendResults = [{ sessionId: 'unicode', title: 'ÉCOLE', updatedAt: 3, matchType: 'title' as const }]
      const SessionSearch = vi.fn().mockResolvedValue(backendResults)
      setHostBridge({ SessionSearch })
      const titleGetter = vi.fn(() => 'ÉCOLE')
      const unicodeSessions = [{ ...sessions[0]!, get title() { return titleGetter() } }]
      expect(await searchChats({ query: 'école', sessions: unicodeSessions })).toBe(backendResults)
      expect(SessionSearch).toHaveBeenCalledWith('école', 50)
      expect(titleGetter).not.toHaveBeenCalled()
    })

    it.each([null, undefined, {}])('falls back when backend results are not an array: %s', async (results) => {
      setHostBridge({ SessionSearch: vi.fn().mockResolvedValue(results) })
      expect(await searchChats({ query: 'shell', sessions }))
        .toEqual([expect.objectContaining({ sessionId: 'cached', matchType: 'title' })])
    })

    it('retains in-memory fallback when backend search fails', async () => {
      setHostBridge({ SessionSearch: vi.fn().mockRejectedValue(new Error('Unavailable')) })
      expect(await searchChats({ query: 'shell', sessions }))
        .toEqual([expect.objectContaining({ sessionId: 'cached', matchType: 'title' })])
    })
  })
  describe('extractTextFromEntry', () => {
    it('extracts plain text from user content blocks', () => {
      const entry: ConversationEntry = {
        id: '1',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'user',
        content: [{ type: 'text', text: 'Hello world' }],
      }
      expect(extractTextFromEntry(entry)).toBe('Hello world')
    })

    it('extracts text and thinking from assistant content blocks', () => {
      const entry: ConversationEntry = {
        id: '2',
        sessionId: 's1',
        createdAt: 1000,
        kind: 'assistant',
        stopReason: 'stop',
        status: 'done',
        content: [
          { type: 'thinking', thinking: 'Let me think about it' },
          { type: 'text', text: 'Here is the answer' },
        ],
      }
      const text = extractTextFromEntry(entry)
      expect(text).toContain('Here is the answer')
      expect(text).toContain('Let me think about it')
    })
  })

  describe('extractSearchableEntryText', () => {
    it.each([null, 'ignored', 42, { kind: 'toolResult', text: 'hidden' }, { type: 'toolResult', content: 'hidden' }])
      ('ignores nonentries and raw tool results: %s', (entry) => {
        expect(extractSearchableEntryText(entry)).toBe('')
      })

    it('preserves user text, reasoning, errors, summaries, and legacy parts', () => {
      expect(extractSearchableEntryText({
        text: 'Prompt', thought: 'Thought', errorMessage: 'Error',
        content: ['String block', { text: 'Text block', thinking: 'Reasoning', signature: 'hidden' }],
        parts: ['String part', { text: 'Text part', encryptedContent: 'hidden' }],
      })).toBe('Prompt Thought Error String block Text block Reasoning String part Text part')
      expect(extractSearchableEntryText({ kind: 'compaction', content: 'Summary' })).toBe('Summary')
    })

    it('removes opaque fields recursively and caps string and serialized tool arguments', () => {
      const argumentsObject = {
        signature: 'hidden-signature',
        nested: { thinkingSignature: 'hidden-thinking', encryptedContent: 'hidden-encrypted', command: 'pwd' },
        content: 'x'.repeat(2500),
      }
      const entry = { content: [
        { type: 'toolCall', name: 'write', arguments: argumentsObject },
        { type: 'toolCall', name: 'edit', arguments: 'y'.repeat(2500) },
      ] }
      const sanitized = JSON.stringify({ nested: { command: 'pwd' }, content: 'x'.repeat(2500) })
      expect(extractSearchableEntryText(entry)).toBe(`write ${sanitized.slice(0, 2000)} edit ${'y'.repeat(2000)}`)
      expect(argumentsObject.signature).toBe('hidden-signature')
      expect(extractTextFromEntry(entry)).toContain('hidden-signature')
      expect(extractTextFromEntry(entry)).toContain('x'.repeat(2500))
      expect(extractTextFromEntry({ kind: 'toolResult', text: 'Legacy output' })).toBe('Legacy output')
    })

    it('ignores unserializable arguments without losing tool names or adjacent text', () => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      expect(extractSearchableEntryText({ content: [
        { type: 'toolCall', name: 'read', arguments: circular },
        { type: 'text', text: 'Visible text' },
      ] })).toBe('read Visible text')
    })
  })

  describe('extractSnippet', () => {
    it('extracts snippet with ellipsis around keyword', () => {
      const fullText =
        'Coding Professional Agent Desktop coding agent (CPA-style shell) that talks to a CLIProxyAPI CPA Responses endpoint over a persistent WebSocket.'
      const snippet = extractSnippet(fullText, 'shell', 20)
      expect(snippet).toBeDefined()
      expect(snippet).toContain('shell')
      expect(snippet?.startsWith('... ')).toBe(true)
      expect(snippet?.endsWith(' ...')).toBe(true)
    })

    it.each([
      ['ΟΣ', 'Σ', '... Σ ...'], ['Straße', 'STRASSE', 'Straße ...'], ['İSTANBUL', 'i\u0307st', 'İST ...'],
    ])('uses original match offsets in %s for %s', (text, query, snippet) => {
      expect(extractSnippet(`${text} trailing`, query, 0)).toBe(snippet)
    })

    it('preserves snippet offsets after length-changing lowercase characters', () => {
      expect(extractSnippet('İ'.repeat(100) + ' needle', 'needle'))
        .toBe('... ' + 'İ'.repeat(39) + ' needle')
    })

    it('does not erase an explicitly requested combining dot', () => {
      expect(extractSnippet('Conversation istanbul', 'i\u0307')).toBeUndefined()
      expect(splitHighlightSegments('istanbul', 'i\u0307st'))
        .toEqual([{ text: 'istanbul', match: false }])
    })

    it('returns undefined if keyword is not found', () => {
      const snippet = extractSnippet('Some text', 'notFound')
      expect(snippet).toBeUndefined()
    })
  })

  describe('splitHighlightSegments', () => {
    it.each([
      ['ΟΣ', 'Σ', 'Ο', 'Σ', ''],
      ['Straße', 'STRASSE', '', 'Straße', ''],
      ['STRASSE', 'Straße', '', 'STRASSE', ''],
      ['İSTANBUL', 'i\u0307st', '', 'İST', 'ANBUL'],
      ['İSTANBUL', 'istanbul', '', 'İSTANBUL', ''],
      ['i\u0307stanbul', 'istanbul', '', 'i\u0307stanbul', ''],
      ['Აბგ', 'აბგ', '', 'Აბგ', ''],
      ['Kelvin', 'kelvin', '', 'Kelvin', ''],
      ['😀Straße!', 'STRASSE', '😀', 'Straße', '!'],
      ['😀İSTANBUL!', 'i\u0307st', '😀', 'İST', 'ANBUL!'],
      ['İ'.repeat(100) + ' needle', 'needle', 'İ'.repeat(100) + ' ', 'needle', ''],
    ])('highlights the original match in %s for %s', (text, query, prefix, match, suffix) => {
      expect(splitHighlightSegments(text, query)).toEqual([
        ...(prefix ? [{ text: prefix, match: false }] : []),
        { text: match, match: true },
        ...(suffix ? [{ text: suffix, match: false }] : []),
      ])
    })

    it('advances by original match lengths across repeated folded matches', () => {
      expect(splitHighlightSegments('Straße STRASSE Straße', 'strasse')).toEqual([
        { text: 'Straße', match: true }, { text: ' ', match: false },
        { text: 'STRASSE', match: true }, { text: ' ', match: false },
        { text: 'Straße', match: true },
      ])
    })

    it('splits text into matched and unmatched segments', () => {
      const segments = splitHighlightSegments('Hello world and shell environment', 'shell')
      expect(segments).toEqual([
        { text: 'Hello world and ', match: false },
        { text: 'shell', match: true },
        { text: ' environment', match: false },
      ])
    })
  })

  describe('searchChats in-memory fallback', () => {
    const sessions: Session[] = [
      {
        id: 's1',
        title: 'Learn shell scripting',
        createdAt: 1000,
        updatedAt: 2000,
        pinned: false,
      },
      {
        id: 's2',
        title: 'Project Setup Guide',
        createdAt: 1000,
        updatedAt: 3000,
        pinned: false,
      },
      {
        id: 's3',
        title: 'Archived session with shell',
        createdAt: 1000,
        updatedAt: 4000,
        pinned: false,
        archivedAt: 5000,
      },
    ]

    const entriesBySession: Record<string, ConversationEntry[]> = {
      s2: [
        {
          id: 'e1',
          sessionId: 's2',
          createdAt: 1000,
          kind: 'assistant',
          stopReason: 'stop',
          status: 'done',
          content: [
            {
              type: 'text',
              text: 'This uses a CPA-style shell underneath.',
            },
          ],
        },
      ],
    }

    it('returns recent sessions when query is empty', async () => {
      const results = await searchChats({ query: '', sessions })
      expect(results).toHaveLength(2)
      expect(results[0]?.sessionId).toBe('s2') // sorted by updatedAt DESC
      expect(results[1]?.sessionId).toBe('s1')
    })

    it.each([false, true])('excludes tool output, opaque fields, and oversized arguments with empty backend: %s', async (useBackend) => {
      if (useBackend) setHostBridge({ SessionSearch: vi.fn().mockResolvedValue([]) })
      const cachedEntries = { s2: [
        { kind: 'toolResult', text: 'kindoutput' },
        { type: 'toolResult', content: 'typeoutput' },
        { kind: 'assistant', content: [
          { type: 'thinking', thinking: 'Visible reasoning', signature: 'signatureonly' },
          { type: 'toolCall', name: 'bash', arguments: {
            signature: 'signatureonly',
            nested: { thinkingSignature: 'thinkingonly', encryptedContent: 'encryptedonly', command: 'publiccommand' },
          } },
          { type: 'toolCall', name: 'write', arguments: { content: 'x'.repeat(2000) + 'truncatedobject' } },
          { type: 'toolCall', name: 'edit', arguments: 'y'.repeat(2000) + 'truncatedstring' },
        ] },
      ] } as unknown as Record<string, ConversationEntry[]>
      for (const query of ['kindoutput', 'typeoutput', 'signatureonly', 'thinkingonly', 'encryptedonly', 'truncatedobject', 'truncatedstring']) {
        expect(await searchChats({ query, sessions, entriesBySession: cachedEntries })).toEqual([])
      }
      for (const query of ['publiccommand', 'reasoning']) {
        expect(await searchChats({ query, sessions, entriesBySession: cachedEntries }))
          .toEqual([expect.objectContaining({ sessionId: 's2', matchType: 'content' })])
      }
    })

    it.each([
      ['ΟΣ', 'Σ'], ['Straße', 'STRASSE'], ['STRASSE', 'Straße'],
      ['İSTANBUL', 'i\u0307st'], ['İSTANBUL', 'istanbul'], ['Აბგ', 'აბგ'], ['Kelvin', 'kelvin'],
      ['İ'.repeat(100) + ' needle', 'needle'], ['i\u0307stanbul', 'istanbul'],
    ])('matches Unicode titles and content in %s for %s', async (text, query) => {
      const unicodeSessions = [
        { ...sessions[0]!, id: 'unicode-title', title: text },
        { ...sessions[1]!, id: 'unicode-content' },
      ]
      const unicodeEntries = {
        'unicode-content': [{ ...entriesBySession.s2![0]!, content: [{ type: 'text' as const, text }] }],
      }
      expect(await searchChats({ query, sessions: unicodeSessions, entriesBySession: unicodeEntries }))
        .toEqual([
          expect.objectContaining({ sessionId: 'unicode-title', matchType: 'title' }),
          expect.objectContaining({ sessionId: 'unicode-content', matchType: 'content', snippet: expect.any(String) }),
        ])
    })

    it('sorts Unicode and ASCII content matches before applying the limit', async () => {
      const contentSessions = sessions.slice(0, 2).map((session) => ({ ...session, title: 'Conversation' }))
      const contentEntries = Object.fromEntries(contentSessions.map((session, index) => [session.id, [{
        ...entriesBySession.s2![0]!, content: [{ type: 'text' as const, text: index ? 'Kelvin' : 'kelvin' }],
      }]]))
      expect(await searchChats({ query: 'kelvin', sessions: contentSessions, entriesBySession: contentEntries, limit: 1 }))
        .toEqual([expect.objectContaining({ sessionId: 's2', matchType: 'content' })])
    })

    it('prioritizes title match above content match', async () => {
      const results = await searchChats({
        query: 'shell',
        sessions,
        entriesBySession,
      })

      expect(results).toHaveLength(2)
      expect(results[0]?.sessionId).toBe('s1')
      expect(results[0]?.matchType).toBe('title')

      expect(results[1]?.sessionId).toBe('s2')
      expect(results[1]?.matchType).toBe('content')
      expect(results[1]?.snippet).toBeDefined()
    })
  })
})
