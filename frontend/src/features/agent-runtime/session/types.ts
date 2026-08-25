/**
 * Canonical conversation entries for the standalone agent runtime.
 * These are the single source of truth for session history.
 */

import type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    EntryBase,
    EntryStatus,
    StopReason,
    ToolResultContentBlock,
    ToolResultEntry,
    Usage,
    UserEntry,
    UserPendingStatus,
} from '@cpa/plugin-api'

export type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    EntryBase,
    EntryStatus,
    StopReason,
    ToolResultContentBlock,
    ToolResultEntry,
    Usage,
    UserEntry,
    UserPendingStatus,
}

/** Display tool status kept compatible with current ToolCard expectations. */
export type DisplayToolStatus =
    | 'queued'
    | 'running'
    | 'awaiting_approval'
    | 'done'
    | 'rejected'
    | 'error'
    | 'aborted'

/** Canonical tool-result image block projected onto a tool_call card. */
export interface DisplayToolResultImage {
    data: string
    mimeType: string
}

export type DisplayMessagePart =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | {
          type: 'tool_call'
          id: string
          name: string
          args: Record<string, unknown>
          status: DisplayToolStatus
          result?: string
          isError?: boolean
          /** Defensive copies of ToolResult image blocks (never dropped). */
          resultImages?: DisplayToolResultImage[]
      }

export interface DisplayChatMessage {
    kind: 'message'
    id: string
    sessionId: string
    role: 'user' | 'assistant'
    content: string
    parts?: DisplayMessagePart[]
    status?: EntryStatus
    pendingStatus?: UserPendingStatus
    errorMessage?: string
    createdAt: number
    completedAt?: number
    pausedMs?: number
}

export interface DisplayCompaction {
    kind: 'compaction'
    id: string
    sessionId: string
    createdAt: number
    firstKeptEntryId?: string
}

/** UI-consumable projection of canonical conversation entries. */
export type DisplayMessage = DisplayChatMessage | DisplayCompaction
