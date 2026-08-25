export type ToolCardStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'error'
  | 'rejected'
  | 'aborted'

export interface ToolCardPart {
  type?: 'tool_call'
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolCardStatus
  result?: string
  isError?: boolean
}

export interface ToolCardImage {
  mimeType: string
  data: string
  alt?: string
}

export interface ToolCardDetails {
  diff?: string
  patch?: string
}

export interface ToolLiveOverlay {
  toolCallId: string
  status?: ToolCardStatus
  partialOutput?: string
  result?: string
  details?: ToolCardDetails
  resultImages?: readonly ToolCardImage[]
}

export type DisplayMessagePart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'thinking'
      thinking: string
    }
  | {
      type: 'tool_call'
      id: string
      name: string
      args: Record<string, unknown>
      status: ToolCardStatus
      result?: string
      isError?: boolean
      partialOutput?: string
      details?: ToolCardDetails
      resultImages?: readonly ToolCardImage[]
    }
  | {
      type: 'other'
      [key: string]: unknown
    }

export interface DisplayChatMessage {
  kind: 'message'
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  parts?: DisplayMessagePart[]
  status?: 'streaming' | 'done' | 'error' | 'aborted'
  createdAt: number
  completedAt?: number
  pausedMs?: number
  updatedAt?: number
  [key: string]: unknown
}

export interface DisplayCompaction {
  kind: 'compaction'
  id: string
  sessionId: string
  tokensSaved?: number
  timestamp?: number
  createdAt?: number
  [key: string]: unknown
}

export type DisplayMessage = DisplayChatMessage | DisplayCompaction

export interface WorktreeSessionSetup {
  status: 'pending' | 'running' | 'done' | 'error'
  path?: string
  branch?: string
  error?: string
  details?: string
  expandedDetails?: boolean
  steps?: Array<{
    name: string
    status: 'pending' | 'running' | 'done' | 'error'
    command?: string
    error?: string
  }>
  [key: string]: unknown
}
