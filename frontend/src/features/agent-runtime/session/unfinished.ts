import type { ConversationEntry } from './types'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { codexCallId } from '../agent/toolCallId'
import { RESTART_STREAMING_ERROR } from './migration'

/**
 * Returns true if the conversation ended abruptly without normal completion,
 * without an explicit user cancellation (abort), and without a finalized error.
 */
export function isSessionUnfinished(
  entries: readonly ConversationEntry[],
): boolean {
  if (!entries || entries.length === 0) {
    return false
  }

  // Find the last non-compaction entry
  let lastIndex = entries.length - 1
  while (lastIndex >= 0 && entries[lastIndex]?.kind === 'compaction') {
    lastIndex--
  }

  if (lastIndex < 0) {
    return false
  }

  const lastEntry = entries[lastIndex]
  if (!lastEntry) {
    return false
  }

  if (lastEntry.kind === 'user') {
    return true
  }

  if (lastEntry.kind === 'toolResult') {
    return true
  }

  if (lastEntry.kind === 'assistant') {
    // If the assistant was interrupted by restart recovery, it was not cleanly terminated.
    if (
      lastEntry.errorMessage === RESTART_STREAMING_ERROR ||
      lastEntry.errorMessage === 'Interrupted by session restart'
    ) {
      return true
    }

    // Streaming or pending stop reason means process was killed mid-flight.
    if (
      lastEntry.status === 'streaming' ||
      lastEntry.stopReason === 'pending'
    ) {
      return true
    }

    // If stopReason is toolUse or the assistant contains tool calls, check for missing tool results.
    const content = Array.isArray(lastEntry.content) ? lastEntry.content : []
    const toolCalls = content.filter((b) => b && b.type === 'toolCall')
    if (lastEntry.stopReason === 'toolUse' || toolCalls.length > 0) {
      const toolCallIds = new Set(
        toolCalls.map((tc) => (tc.type === 'toolCall' ? codexCallId(tc.id) : '')).filter(Boolean),
      )
      const followingResults = new Set<string>()
      for (let i = lastIndex + 1; i < entries.length; i++) {
        const entry = entries[i]
        if (entry?.kind === 'toolResult') {
          followingResults.add(codexCallId(entry.toolCallId))
        }
      }
      for (const id of toolCallIds) {
        if (!followingResults.has(id)) {
          return true
        }
      }
    }

    // If explicitly aborted or errored (and not interrupted by restart or missing tool results), it was cleanly terminated.
    if (
      lastEntry.status === 'aborted' ||
      lastEntry.stopReason === 'aborted' ||
      lastEntry.status === 'error' ||
      lastEntry.stopReason === 'error'
    ) {
      return false
    }

    if (lastEntry.status !== 'done') {
      return true
    }

    // Normal completion
    if (
      lastEntry.status === 'done' &&
      (lastEntry.stopReason === 'stop' || lastEntry.stopReason === 'length')
    ) {
      return false
    }

    return false
  }

  return false
}

/**
 * Returns true if the conversation ended abruptly or was interrupted by the user (e.g. stop button),
 * making it resumable from the last valid turn/tool state.
 */
export function isSessionResumable(
  entries: readonly ConversationEntry[],
  subAgents?: readonly SubAgentRecord[],
  parentSessionId?: string,
): boolean {
  if (!entries || entries.length === 0) {
    return false
  }

  // Check if there are unfinished subagents for this parent session
  if (subAgents && parentSessionId) {
    const hasUnfinishedSubAgent = subAgents.some(
      (a) =>
        a.parentSessionId === parentSessionId &&
        (a.status === 'running' || a.status === 'queued'),
    )
    if (hasUnfinishedSubAgent) {
      return true
    }
  }

  // Find the last non-compaction entry
  let lastIndex = entries.length - 1
  while (lastIndex >= 0 && entries[lastIndex]?.kind === 'compaction') {
    lastIndex--
  }

  if (lastIndex < 0) {
    return false
  }

  const lastEntry = entries[lastIndex]
  if (!lastEntry) {
    return false
  }

  if (lastEntry.kind === 'user') {
    return true
  }

  if (lastEntry.kind === 'toolResult') {
    return true
  }

  if (lastEntry.kind === 'assistant') {
    // If the assistant was interrupted by restart recovery, it was not cleanly terminated.
    if (
      lastEntry.errorMessage === RESTART_STREAMING_ERROR ||
      lastEntry.errorMessage === 'Interrupted by session restart'
    ) {
      return true
    }

    // Explicitly aborted by user (e.g. stop button)
    if (
      lastEntry.status === 'aborted' ||
      lastEntry.stopReason === 'aborted'
    ) {
      return true
    }

    // Streaming or pending stop reason means process was killed mid-flight.
    if (
      lastEntry.status === 'streaming' ||
      lastEntry.stopReason === 'pending'
    ) {
      return true
    }

    // If stopReason is toolUse or the assistant contains tool calls, check for missing tool results.
    const content = Array.isArray(lastEntry.content) ? lastEntry.content : []
    const toolCalls = content.filter((b) => b && b.type === 'toolCall')
    if (lastEntry.stopReason === 'toolUse' || toolCalls.length > 0) {
      const toolCallIds = new Set(
        toolCalls
          .map((tc) => (tc.type === 'toolCall' ? codexCallId(tc.id) : ''))
          .filter(Boolean),
      )
      const followingResults = new Set<string>()
      for (let i = lastIndex + 1; i < entries.length; i++) {
        const entry = entries[i]
        if (entry?.kind === 'toolResult') {
          followingResults.add(codexCallId(entry.toolCallId))
        }
      }
      for (const id of toolCallIds) {
        if (!followingResults.has(id)) {
          return true
        }
      }
    }

    // Explicit error: regular retry should be used instead of resume
    if (
      lastEntry.status === 'error' ||
      lastEntry.stopReason === 'error'
    ) {
      return false
    }

    if (lastEntry.status !== 'done') {
      return true
    }

    // Normal completion
    if (
      lastEntry.status === 'done' &&
      (lastEntry.stopReason === 'stop' || lastEntry.stopReason === 'length')
    ) {
      return false
    }

    return false
  }

  return false
}

/**
 * Strips dangling in-flight assistant entries that were interrupted before completion
 * so the conversation can be resumed cleanly from the last valid user message or tool result.
 */
export function cleanUnfinishedEntries(
  entries: readonly ConversationEntry[],
): ConversationEntry[] {
  if (!entries || entries.length === 0) {
    return []
  }

  const result = entries.slice()
  const lastIndex = result.length - 1
  const last = result[lastIndex]
  if (!last) {
    return result
  }

  if (last.kind === 'assistant') {
    const hasToolCalls =
      Array.isArray(last.content) &&
      last.content.some((b) => b && b.type === 'toolCall')

    if (hasToolCalls) {
      // Preserve assistant entry containing tool calls, normalizing status to done / toolUse
      // so pending tool calls (including subagents) can be executed/resumed upon restart.
      if (last.status !== 'done' || last.stopReason !== 'toolUse') {
        result[lastIndex] = {
          ...last,
          status: 'done',
          stopReason: 'toolUse',
        }
      }
    } else {
      // If streaming/pending or interrupted by restart or aborted with no tool calls, drop the partial unfinished assistant entry
      // so the LLM generates a complete response from the preceding user/tool entry.
      if (
        last.status === 'streaming' ||
        last.stopReason === 'pending' ||
        last.status === 'aborted' ||
        last.stopReason === 'aborted' ||
        last.status !== 'done' ||
        last.errorMessage === RESTART_STREAMING_ERROR ||
        last.errorMessage === 'Interrupted by session restart'
      ) {
        result.pop()
      }
    }
  }

  return result
}

export type SubAgentParentCallState =
  | 'unknown'
  | 'missing'
  | 'pending'
  | 'fulfilled'

/**
 * Resolves whether the spawn call recorded by a subagent still belongs to its
 * parent history and whether that call already has a result.
 */
export function subAgentParentCallState(
  agent: SubAgentRecord,
  parentEntries?: readonly ConversationEntry[],
): SubAgentParentCallState {
  if (!agent.parentToolCallId || !parentEntries) return 'unknown'

  const targetId = codexCallId(agent.parentToolCallId)
  let hasSpawnCall = false
  let hasSpawnResult = false

  for (const entry of parentEntries) {
    if (entry.kind === 'assistant') {
      const content = Array.isArray(entry.content) ? entry.content : []
      if (
        content.some(
          (block) =>
            block?.type === 'toolCall' &&
            block.name === 'spawn_agent' &&
            codexCallId(block.id) === targetId,
        )
      ) {
        hasSpawnCall = true
      }
      continue
    }
    if (
      entry.kind === 'toolResult' &&
      entry.toolName === 'spawn_agent' &&
      codexCallId(entry.toolCallId) === targetId
    ) {
      hasSpawnResult = true
    }
  }

  if (!hasSpawnCall) return 'missing'
  return hasSpawnResult ? 'fulfilled' : 'pending'
}

/**
 * Returns true if a subagent was in-flight (running or queued) when the process was killed.
 */
export function isSubAgentUnfinished(
  agent: SubAgentRecord,
  childEntries?: readonly ConversationEntry[],
): boolean {
  if (!agent) return false
  // Terminal states (completed, aborted, error) are never unfinished regardless of child entries.
  if (
    agent.status === 'completed' ||
    agent.status === 'aborted' ||
    agent.status === 'error'
  ) {
    return false
  }
  // If child entries are available and non-empty:
  // If child session is finished cleanly, this subagent actually completed successfully (self-heal).
  if (childEntries && childEntries.length > 0) {
    return isSessionUnfinished(childEntries)
  }
  if (agent.status === 'running' || agent.status === 'queued') {
    return true
  }
  return false
}
