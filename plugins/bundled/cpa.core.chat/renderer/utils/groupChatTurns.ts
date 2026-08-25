import type {
  DisplayChatMessage,
  DisplayCompaction,
  DisplayMessage,
  DisplayMessagePart,
} from '../types.js'

export type AssistantTurnItem =
  | { type: 'message'; message: DisplayChatMessage }
  | { type: 'compaction'; message: DisplayCompaction }

export type ChatTurn =
  | { type: 'user'; message: DisplayChatMessage }
  | { type: 'compaction'; message: DisplayCompaction }
  | {
      type: 'assistant'
      items: AssistantTurnItem[]
      startedAt: number
      pausedMs?: number
    }

/** Group one user request into a single assistant turn, including mid-turn compaction. */
export function groupChatTurns(messages: readonly DisplayMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  let activeTurnStartedAt: number | undefined
  let activeTurnPausedMs: number | undefined
  const buffer: AssistantTurnItem[] = []

  const flushBuffer = () => {
    if (buffer.length === 0) return
    const hasAssistant = buffer.some((item) => item.type === 'message')
    if (hasAssistant || activeTurnStartedAt !== undefined) {
      const first = buffer[0]
      const started =
        activeTurnStartedAt ??
        (first?.type === 'message'
          ? first.message.createdAt
          : ((first?.message as any)?.createdAt ?? 0))
      const turnPausedMs =
        activeTurnPausedMs ??
        (first?.type === 'message'
          ? (first.message as any).pausedMs
          : ((first?.message as any)?.pausedMs ?? 0))
      turns.push({
        type: 'assistant',
        items: buffer.splice(0, buffer.length),
        startedAt: started,
        ...(typeof turnPausedMs === 'number' && turnPausedMs > 0
          ? { pausedMs: turnPausedMs }
          : {}),
      })
      activeTurnPausedMs = undefined
      return
    }
    for (const item of buffer) {
      if (item.type === 'compaction') {
        turns.push({ type: 'compaction', message: item.message })
      }
    }
    buffer.length = 0
    activeTurnPausedMs = undefined
  }

  for (const message of messages) {
    if (message.kind === 'compaction') {
      buffer.push({ type: 'compaction', message })
      continue
    }
    if (message.role === 'user') {
      const isPending = Boolean((message as any).pendingStatus)
      flushBuffer()
      if (!isPending) {
        activeTurnStartedAt = message.createdAt
        activeTurnPausedMs = typeof (message as any).pausedMs === 'number' && (message as any).pausedMs > 0
          ? (message as any).pausedMs
          : undefined
      } else {
        activeTurnStartedAt = undefined
        activeTurnPausedMs = undefined
      }
      turns.push({ type: 'user', message })
      continue
    }
    buffer.push({ type: 'message', message })
  }
  flushBuffer()

  return turns
}

export function assistantTurnMessages(
  turn: Extract<ChatTurn, { type: 'assistant' }>,
): DisplayChatMessage[] {
  const messages: DisplayChatMessage[] = []
  for (const item of turn.items) {
    if (item.type === 'message') messages.push(item.message)
  }
  return messages
}

/** Flatten one request's assistant stages into a single display message. */
export function mergeAssistantTurn(
  messages: readonly DisplayChatMessage[],
  startedAt: number,
  live = false,
  pausedMs?: number,
): DisplayChatMessage {
  const first = messages[0]
  const last = messages[messages.length - 1]
  const resolvedPausedMs =
    typeof pausedMs === 'number' && pausedMs > 0
      ? pausedMs
      : messages.reduce<number>((max, m) => {
          const p = typeof (m as any).pausedMs === 'number' ? (m as any).pausedMs : 0
          return Math.max(max, p)
        }, 0)

  if (!first || !last) {
    return {
      kind: 'message',
      id: 'assistant-turn',
      sessionId: '',
      role: 'assistant',
      content: '',
      parts: [],
      status: live ? 'streaming' : 'done',
      createdAt: startedAt,
      ...(resolvedPausedMs > 0 ? { pausedMs: resolvedPausedMs } : {}),
    }
  }

  const parts: DisplayMessagePart[] = []
  const texts: string[] = []
  for (const message of messages) {
    if (message.parts && message.parts.length > 0) {
      parts.push(...message.parts)
    } else if (message.content) {
      parts.push({ type: 'text', text: message.content })
    }
    if (message.content) texts.push(message.content)
  }

  const streaming =
    live || messages.some((message) => message.status === 'streaming')
  const status = streaming
    ? 'streaming'
    : messages.some((message) => message.status === 'error')
      ? 'error'
      : messages.some((message) => message.status === 'aborted')
        ? 'aborted'
        : 'done'

  const errorMessage =
    messages.slice().reverse().find((message) => Boolean((message as any).errorMessage))?.errorMessage

  const resolvedCompletedAt = messages.reduce<number | undefined>((max, m) => {
    const c =
      typeof (m as any).completedAt === 'number' && Number.isFinite((m as any).completedAt)
        ? (m as any).completedAt
        : undefined
    if (c === undefined) return max
    return max === undefined ? c : Math.max(max, c)
  }, undefined)

  const hasInterrupted = messages.some((m) => (m as any).interrupted === true)

  return {
    kind: 'message',
    id: first.id,
    sessionId: first.sessionId,
    role: 'assistant',
    content: texts.join('') || last.content,
    parts,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    ...(hasInterrupted ? { interrupted: true } : {}),
    createdAt: startedAt,
    ...(streaming || typeof resolvedCompletedAt !== 'number'
      ? {}
      : { completedAt: resolvedCompletedAt }),
    ...(resolvedPausedMs > 0 ? { pausedMs: resolvedPausedMs } : {}),
  }
}
