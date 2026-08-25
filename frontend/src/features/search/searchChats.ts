import type { Session } from '@/types/models'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { getHostBridge } from '@/application/services/hostTransport'

export interface ChatSearchResultItem {
  sessionId: string
  title: string
  projectId?: string
  branch?: string
  updatedAt: number
  matchType: 'title' | 'content'
  snippet?: string
}

/**
 * Extracts plain searchable text from a conversation entry or legacy message.
 */
export function extractTextFromEntry(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const parts: string[] = []
  const obj = entry as Record<string, any>

  if (typeof obj.text === 'string') parts.push(obj.text)
  if (typeof obj.thought === 'string') parts.push(obj.thought)
  if (typeof obj.errorMessage === 'string') parts.push(obj.errorMessage)

  if (Array.isArray(obj.content)) {
    for (const block of obj.content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        if (typeof block.text === 'string') parts.push(block.text)
        if (typeof block.thinking === 'string') parts.push(block.thinking)
        if (block.type === 'toolCall' && block.name) {
          parts.push(String(block.name))
          if (block.arguments) {
            try {
              parts.push(
                typeof block.arguments === 'string'
                  ? block.arguments
                  : JSON.stringify(block.arguments),
              )
            } catch {
              // Ignore serialization error
            }
          }
        }
      }
    }
  } else if (typeof obj.content === 'string') {
    parts.push(obj.content)
  }

  if (Array.isArray(obj.parts)) {
    for (const part of obj.parts) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object' && typeof part.text === 'string') {
        parts.push(part.text)
      }
    }
  }

  return parts.join(' ')
}

/**
 * Extracts a contextual snippet around the matched keyword.
 */
export function extractSnippet(
  fullText: string,
  query: string,
  maxContext = 40,
): string | undefined {
  if (!fullText || !query) return undefined
  const normalized = fullText.replace(/\s+/g, ' ').trim()
  const lowerText = normalized.toLowerCase()
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return undefined

  const index = lowerText.indexOf(lowerQuery)
  if (index === -1) return undefined

  const start = Math.max(0, index - maxContext)
  const end = Math.min(normalized.length, index + lowerQuery.length + maxContext)

  let snippet = normalized.slice(start, end)
  if (start > 0) snippet = '... ' + snippet
  if (end < normalized.length) snippet = snippet + ' ...'

  return snippet
}

/**
 * Splits text into matched and non-matched segments for highlighting in React.
 */
export function splitHighlightSegments(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  if (!text || !query.trim()) {
    return [{ text, match: false }]
  }

  const trimmedQuery = query.trim()
  const lowerText = text.toLowerCase()
  const lowerQuery = trimmedQuery.toLowerCase()
  const segments: Array<{ text: string; match: boolean }> = []

  let lastIndex = 0
  let matchIndex = lowerText.indexOf(lowerQuery, lastIndex)

  while (matchIndex !== -1) {
    if (matchIndex > lastIndex) {
      segments.push({
        text: text.slice(lastIndex, matchIndex),
        match: false,
      })
    }
    segments.push({
      text: text.slice(matchIndex, matchIndex + trimmedQuery.length),
      match: true,
    })
    lastIndex = matchIndex + trimmedQuery.length
    matchIndex = lowerText.indexOf(lowerQuery, lastIndex)
  }

  if (lastIndex < text.length) {
    segments.push({
      text: text.slice(lastIndex),
      match: false,
    })
  }

  return segments
}

export interface SearchChatsOptions {
  query: string
  sessions: Session[]
  entriesBySession?: Record<string, ConversationEntry[]>
  limit?: number
}

/**
 * Performs chat session search by title (prioritized) and content/entries.
 */
export async function searchChats({
  query,
  sessions,
  entriesBySession = {},
  limit = 50,
}: SearchChatsOptions): Promise<ChatSearchResultItem[]> {
  const trimmed = query.trim()
  const nonArchivedSessions = sessions.filter((s) => s.archivedAt === undefined)

  // Empty query -> Return recent sessions sorted by updatedAt
  if (!trimmed) {
    const sorted = [...nonArchivedSessions].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    )
    return sorted.slice(0, limit).map((s) => ({
      sessionId: s.id,
      title: s.title,
      projectId: s.projectId,
      branch: s.branch,
      updatedAt: s.updatedAt,
      matchType: 'title',
    }))
  }

  // If in Electron environment with IPC search available
  const bridge = getHostBridge()
  if (typeof bridge?.SessionSearch === 'function') {
    try {
      const results = await bridge.SessionSearch(trimmed, limit)
      if (Array.isArray(results) && results.length > 0) {
        return results
      }
    } catch {
      // Fallback to in-memory search on bridge error
    }
  }

  // Fallback in-memory search
  const lowerQuery = trimmed.toLowerCase()
  const titleMatches: ChatSearchResultItem[] = []
  const contentMatches: ChatSearchResultItem[] = []
  const seenSessionIds = new Set<string>()

  // 1. Search titles first
  for (const session of nonArchivedSessions) {
    if (session.title.toLowerCase().includes(lowerQuery)) {
      seenSessionIds.add(session.id)
      titleMatches.push({
        sessionId: session.id,
        title: session.title,
        projectId: session.projectId,
        branch: session.branch,
        updatedAt: session.updatedAt,
        matchType: 'title',
      })
    }
  }

  titleMatches.sort((a, b) => b.updatedAt - a.updatedAt)

  // 2. Search message entries for remaining sessions
  for (const session of nonArchivedSessions) {
    if (seenSessionIds.has(session.id)) continue
    const entries = entriesBySession[session.id]
    if (!entries || !Array.isArray(entries)) continue

    for (const entry of entries) {
      const text = extractTextFromEntry(entry)
      if (text.toLowerCase().includes(lowerQuery)) {
        const snippet = extractSnippet(text, trimmed)
        if (snippet) {
          seenSessionIds.add(session.id)
          contentMatches.push({
            sessionId: session.id,
            title: session.title,
            projectId: session.projectId,
            branch: session.branch,
            updatedAt: session.updatedAt,
            matchType: 'content',
            snippet,
          })
          break
        }
      }
    }
  }

  contentMatches.sort((a, b) => b.updatedAt - a.updatedAt)

  return [...titleMatches, ...contentMatches].slice(0, limit)
}
