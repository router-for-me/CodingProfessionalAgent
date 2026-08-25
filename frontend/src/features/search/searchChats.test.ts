import { describe, expect, it } from 'vitest'
import {
  extractSnippet,
  extractTextFromEntry,
  searchChats,
  splitHighlightSegments,
} from './searchChats'
import type { Session } from '@/types/models'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

describe('searchChats', () => {
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

    it('returns undefined if keyword is not found', () => {
      const snippet = extractSnippet('Some text', 'notFound')
      expect(snippet).toBeUndefined()
    })
  })

  describe('splitHighlightSegments', () => {
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
