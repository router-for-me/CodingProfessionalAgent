/**
 * Agent runtime event and tool contracts shared by later tasks.
 * Keep shapes concrete enough to avoid `any` in protocol/agent code.
 */

import type {
    AgentStreamEvent,
    AgentTarget,
    AgentTool,
    AssistantStreamEvent,
    AssistantToolCallBlock,
    ProtocolMiddleware,
    ProtocolProviderContribution,
    ProtocolSession,
    ProtocolSessionContext,
    ProtocolStreamInput,
    ProtocolStreamOptions,
    ProtocolToolDefinition,
    ToolExecutionContext,
    ToolResult,
} from '@cpa/plugin-api'
import type {
    AssistantEntry,
    CompactionEntry,
    ConversationEntry,
    ToolResultEntry,
    UserEntry,
} from '../session/types'

export type {
    AgentStreamEvent,
    AgentTarget,
    AgentTool,
    AssistantStreamEvent,
    AssistantToolCallBlock,
    ProtocolMiddleware,
    ProtocolProviderContribution,
    ProtocolSession,
    ProtocolSessionContext,
    ProtocolStreamInput,
    ProtocolStreamOptions,
    ProtocolToolDefinition,
    ToolExecutionContext,
    ToolResult,
}

/**
 * Scoped agent-loop events for Tasks 15–17.
 * Every event carries runId + sessionId so late UI updates cannot cross runs.
 * entry/partial/result payloads are defensive snapshots — later mutations must
 * not rewrite history already yielded to consumers.
 */
export type AgentRunEvent =
    | { type: 'agent-start'; runId: string; sessionId: string }
    | {
          type: 'agent-end'
          runId: string
          sessionId: string
          entries?: readonly ConversationEntry[]
      }
    | {
          type: 'user-entry'
          sessionId: string
          runId: string
          entry: UserEntry
      }
    | {
          type: 'assistant-start'
          runId: string
          sessionId: string
          entry: AssistantEntry
      }
    | {
          type: 'assistant-update'
          runId: string
          sessionId: string
          entry: AssistantEntry
          streamEvent: AssistantStreamEvent
      }
    | {
          type: 'assistant-end'
          runId: string
          sessionId: string
          entry: AssistantEntry
      }
    | {
          type: 'tool-approval-required'
          runId: string
          sessionId: string
          toolCallId: string
          toolName: string
          args: Record<string, unknown>
      }
    | {
          type: 'tool-start'
          runId: string
          sessionId: string
          toolCallId: string
          toolName: string
          args: Record<string, unknown>
      }
    | {
          type: 'tool-update'
          runId: string
          sessionId: string
          toolCallId: string
          toolName: string
          result: ToolResult
      }
    | {
          type: 'tool-end'
          runId: string
          sessionId: string
          toolCallId: string
          toolName: string
          result: ToolResult
          isError: boolean
          /** Optional canonical entry so UI adapters need not invent ids. */
          entry?: ToolResultEntry
      }
    | {
          type: 'retrying'
          runId: string
          sessionId: string
          attempt: number
          delayMs: number
          error?: string
      }
    | {
          type: 'compaction-start'
          runId: string
          sessionId: string
      }
    | {
          type: 'compaction-end'
          runId: string
          sessionId: string
          entry?: CompactionEntry
      }
    | { type: 'error'; runId: string; sessionId: string; message: string }
    | { type: 'aborted'; runId: string; sessionId: string }
    | {
          type: 'diagnostic'
          runId: string
          sessionId: string
          message: string
          code?: string
      }
