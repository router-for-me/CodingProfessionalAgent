import { useEffect, useRef, useState } from 'react'
import { cn, useTranslation } from '@cpa/plugin-ui'
import type {
  DisplayChatMessage,
  DisplayCompaction,
  DisplayMessage,
  ToolLiveOverlay,
  WorktreeSessionSetup,
} from '../types.js'
import { WorktreeSetupCard } from './WorktreeSetupCard.js'
import { CompactionDivider } from './CompactionDivider.js'
import {
  assistantTurnMessages,
  groupChatTurns,
  mergeAssistantTurn,
  type AssistantTurnItem,
  type ChatTurn,
} from '../utils/groupChatTurns.js'
import { MessageItem } from './MessageItem.js'
import { TurnHeader } from './TurnHeader.js'
import { hasVisibleTurnContent, trailingAssistantText } from '../utils/toolActivity.js'

const STICK_TO_BOTTOM_PX = 48
export const DEFAULT_WINDOWED_TURNS = 40
export const DEFAULT_WINDOWED_MESSAGES = 50

export interface MessageListProps {
  messages: DisplayMessage[]
  onApproveTool: (toolId: string) => void
  onRejectTool: (toolId: string) => void
  onEditMessage?: (messageId: string, text: string) => void | Promise<void>
  onRetryMessage?: (messageId: string) => void | Promise<void>
  onForkMessage?: (messageId: string) => void | Promise<void>
  onExecuteHook?: (messageId: string) => void | Promise<void>
  /** Ephemeral live overlays keyed by normalized toolCallId. */
  toolOverlays?: Readonly<Record<string, ToolLiveOverlay>>
  /** Main-agent folded tool/turn presentation. */
  compactActivity?: boolean
  /** True while this session's agent run is in flight. */
  isRunActive?: boolean
  /** Explicit start time used while a worktree retry hands off to a new run. */
  activeTurnStartedAt?: number
  /** True while this session is summarizing context. */
  isCompacting?: boolean
  /** Identity used to reset stick-to-bottom when switching conversations. */
  sessionKey?: string
  worktreeSetup?: WorktreeSessionSetup
  onRetryWorktreeSetup?: () => void
  onContinueAnywayWorktreeSetup?: () => void
  onAutoFixWorktreeSetup?: () => void
  onToggleWorktreeSetupDetails?: () => void
  className?: string
  contentClassName?: string
  contentTestId?: string
  maxInitialTurns?: number
}

function computeScrollFingerprint(
  messages: DisplayMessage[],
  isCompacting: boolean,
  sessionKey?: string,
): string {
  const len = messages.length
  if (len === 0) {
    return `${sessionKey ?? ''}:${isCompacting ? '1' : '0'}:0`
  }
  // Fast tail fingerprint: active streaming and tool execution occur on the tail entries
  const tail = messages.slice(-2)
  const tailKey = tail
    .map((message) => {
      if (message.kind === 'compaction') {
        return `c:${message.id}`
      }
      const partsKey =
        message.parts
          ?.map((part) => {
            if (part.type === 'tool_call') {
              return `${part.id}:${part.status}:${part.result?.length ?? 0}`
            }
            if (part.type === 'thinking') {
              return `th:${part.thinking.length}`
            }
            return `t:${((part as any).text ?? '').length}`
          })
          .join(',') ?? ''
      return `${message.id}:${message.status ?? ''}:${message.content.length}:${partsKey}`
    })
    .join('|')
  const firstId = messages[0]?.id ?? ''
  return `${sessionKey ?? ''}:${isCompacting ? '1' : '0'}:${len}:${firstId}#${tailKey}`
}

/**
 * Scrollable message stack that sticks to the bottom as content streams in.
 * Consumes DisplayMessage[] projection (tool results never solo-bubble).
 */
export function MessageList({
  messages,
  onApproveTool,
  onRejectTool,
  onEditMessage,
  onRetryMessage,
  onForkMessage,
  onExecuteHook,
  toolOverlays,
  compactActivity = false,
  isRunActive = false,
  activeTurnStartedAt,
  isCompacting = false,
  sessionKey,
  worktreeSetup,
  onRetryWorktreeSetup,
  onContinueAnywayWorktreeSetup,
  onAutoFixWorktreeSetup,
  onToggleWorktreeSetupDetails,
  className,
  contentClassName,
  contentTestId,
  maxInitialTurns = DEFAULT_WINDOWED_TURNS,
}: MessageListProps) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [expandedAllHistory, setExpandedAllHistory] = useState(false)
  const lastUserMessage = findLastUserMessage(messages)
  const lastUserMessageKey = lastUserMessage
    ? `${lastUserMessage.id}:${lastUserMessage.content}`
    : ''
  const lastUserMessageKeyRef = useRef(lastUserMessageKey)

  const scrollKey = computeScrollFingerprint(messages, isCompacting, sessionKey)

  useEffect(() => {
    pinnedRef.current = true
    setExpandedAllHistory(false)
    lastUserMessageKeyRef.current = lastUserMessageKey
  }, [sessionKey])

  useEffect(() => {
    // When a new user message is sent or edited, re-pin and jump to the bottom.
    if (lastUserMessageKey && lastUserMessageKey !== lastUserMessageKeyRef.current) {
      lastUserMessageKeyRef.current = lastUserMessageKey
      pinnedRef.current = true
      const scroller = scrollerRef.current
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight
      }
    }
  }, [lastUserMessageKey])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onScroll = () => {
      const gap =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      pinnedRef.current = gap <= STICK_TO_BOTTOM_PX
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
    }
  }, [sessionKey])

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || !pinnedRef.current) return
    scroller.scrollTop = scroller.scrollHeight
  }, [scrollKey])

  useEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return
      scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [sessionKey])

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="message-list-scroller"
      >
        <div
          ref={contentRef}
          data-testid={contentTestId}
          className={
            contentClassName ??
            'mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-6 pb-44 pt-8'
          }
        >
          {compactActivity
            ? renderCompactTurns(
                messages,
                isRunActive,
                activeTurnStartedAt,
                isCompacting,
                {
                  onApproveTool,
                  onRejectTool,
                  onEditMessage,
                  onRetryMessage,
                  onForkMessage,
                  onExecuteHook,
                  toolOverlays,
                  worktreeSetup,
                  onRetryWorktreeSetup,
                  onContinueAnywayWorktreeSetup,
                  onAutoFixWorktreeSetup,
                  onToggleWorktreeSetupDetails,
                },
                {
                  expandedAllHistory,
                  onExpandAllHistory: () => setExpandedAllHistory(true),
                  maxVisibleTurns: maxInitialTurns,
                  t,
                },
              )
            : (() => {
                const shouldWindowMessages =
                  !expandedAllHistory && messages.length > DEFAULT_WINDOWED_MESSAGES
                const hiddenCount = shouldWindowMessages
                  ? messages.length - DEFAULT_WINDOWED_MESSAGES
                  : 0
                const visibleMessages = shouldWindowMessages
                  ? messages.slice(hiddenCount)
                  : messages

                return (
                  <>
                    {hiddenCount > 0 && (
                      <div className="flex justify-center py-2">
                        <button
                          type="button"
                          data-testid="load-earlier-messages-button"
                          onClick={() => setExpandedAllHistory(true)}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                        >
                          <span>
                            {t('chat.loadEarlierMessages', {
                              count: hiddenCount,
                              defaultValue: `Expand ${hiddenCount} earlier messages`,
                            })}
                          </span>
                        </button>
                      </div>
                    )}
                    {visibleMessages.map((message) => {
                      if (message.kind === 'compaction') {
                        return <CompactionDivider key={message.id} />
                      }
                      const isPendingUser =
                        message.role === 'user' && Boolean((message as any).pendingStatus)
                      return (
                        <div
                          key={message.id}
                          className={cn(
                            '[contain-intrinsic-size:120px]',
                            isPendingUser ? 'overflow-visible py-1' : '[content-visibility:auto]',
                          )}
                        >
                          <MessageItem
                            message={message}
                            onApproveTool={onApproveTool}
                            onRejectTool={onRejectTool}
                            onEditMessage={onEditMessage}
                            onRetry={
                              onRetryMessage
                                ? () => onRetryMessage(message.id)
                                : undefined
                            }
                            onFork={
                              onForkMessage
                                ? () => onForkMessage(message.id)
                                : undefined
                            }
                            onExecuteHook={
                              onExecuteHook
                                ? () => onExecuteHook(message.id)
                                : undefined
                            }
                            toolOverlays={toolOverlays}
                          />
                        </div>
                      )
                    })}
                  </>
                )
              })()}
          {!compactActivity && isCompacting ? (
            <CompactionDivider pending />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function renderCompactTurns(
  messages: DisplayMessage[],
  isRunActive: boolean,
  activeTurnStartedAt: number | undefined,
  isCompacting: boolean,
  handlers: CompactTurnHandlers,
  windowOptions?: {
    expandedAllHistory?: boolean
    onExpandAllHistory?: () => void
    maxVisibleTurns?: number
    t?: (key: string, options?: Record<string, unknown>) => string
  },
) {
  const turns = groupChatTurns(messages)
  const nodes: React.ReactNode[] = []
  let worktreeCardRendered = false

  const maxTurns = windowOptions?.maxVisibleTurns ?? DEFAULT_WINDOWED_TURNS
  const shouldWindow = !windowOptions?.expandedAllHistory && turns.length > maxTurns
  const hiddenCount = shouldWindow ? turns.length - maxTurns : 0
  const visibleTurns = shouldWindow ? turns.slice(hiddenCount) : turns

  if (hiddenCount > 0) {
    const t = windowOptions?.t
    nodes.push(
      <div key="expand-earlier-turns-wrapper" className="flex justify-center py-2">
        <button
          type="button"
          data-testid="load-earlier-turns-button"
          onClick={windowOptions?.onExpandAllHistory}
          className="flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
        >
          <span>
            {t
              ? t('chat.loadEarlierTurns', {
                  count: hiddenCount,
                  defaultValue: `Expand ${hiddenCount} earlier turns`,
                })
              : `Expand ${hiddenCount} earlier turns`}
          </span>
        </button>
      </div>,
    )
  }

  // Find the index of the assistant turn that is currently actively running.
  // When messages are queued or steered during an active run, those user turns are pending (not yet sent to LLM),
  // so the active run belongs to the assistant turn before the pending user turns.
  let activeAssistantTurnIndex = -1
  if (isRunActive) {
    for (let i = visibleTurns.length - 1; i >= 0; i--) {
      const t = visibleTurns[i]
      if (t.type === 'assistant') {
        activeAssistantTurnIndex = i
        break
      }
      if (t.type === 'user' && Boolean((t.message as any).pendingStatus)) {
        continue
      }
      break
    }
  }

  visibleTurns.forEach((turn, index) => {
    if (turn.type === 'compaction') {
      nodes.push(
        <div key={turn.message.id} className="[content-visibility:auto] [contain-intrinsic-size:40px]">
          <CompactionDivider />
        </div>,
      )
      return
    }
    if (turn.type === 'user') {
      const isPendingUser = Boolean((turn.message as any).pendingStatus)
      nodes.push(
        <div
          key={turn.message.id}
          className={cn(
            '[contain-intrinsic-size:100px]',
            isPendingUser ? 'overflow-visible py-1' : '[content-visibility:auto]',
          )}
        >
          <MessageItem
            message={turn.message}
            onApproveTool={handlers.onApproveTool}
            onRejectTool={handlers.onRejectTool}
            onEditMessage={handlers.onEditMessage}
            toolOverlays={handlers.toolOverlays}
          />
        </div>,
      )
      if (
        !worktreeCardRendered &&
        handlers.worktreeSetup &&
        handlers.worktreeSetup.status !== 'pending'
      ) {
        nodes.push(
          <WorktreeSetupCard
            key="worktree-setup-card"
            setup={handlers.worktreeSetup}
            onRetry={handlers.onRetryWorktreeSetup}
            onContinueAnyway={handlers.onContinueAnywayWorktreeSetup}
            onAutoFix={handlers.onAutoFixWorktreeSetup}
            onToggleDetails={handlers.onToggleWorktreeSetupDetails}
          />,
        )
        worktreeCardRendered = true
      }
      return
    }
    const live = isRunActive && index === activeAssistantTurnIndex
    const displayedTurn =
      live && activeTurnStartedAt !== undefined
        ? { ...turn, startedAt: activeTurnStartedAt }
        : turn
    nodes.push(
      <div key={compactAssistantTurnKey(turn)} className="[content-visibility:auto] [contain-intrinsic-size:120px]">
        <CompactAssistantTurn
          turn={displayedTurn}
          live={live}
          compacting={isCompacting && index === activeAssistantTurnIndex}
          handlers={handlers}
        />
      </div>,
    )
  })

  if (
    !worktreeCardRendered &&
    handlers.worktreeSetup &&
    handlers.worktreeSetup.status !== 'pending'
  ) {
    nodes.unshift(
      <WorktreeSetupCard
        key="worktree-setup-card"
        setup={handlers.worktreeSetup}
        onRetry={handlers.onRetryWorktreeSetup}
        onContinueAnyway={handlers.onContinueAnywayWorktreeSetup}
        onAutoFix={handlers.onAutoFixWorktreeSetup}
        onToggleDetails={handlers.onToggleWorktreeSetupDetails}
      />,
    )
  }

  const lastTurn = turns[turns.length - 1]
  const lastTurnIsPendingUser =
    lastTurn?.type === 'user' && Boolean((lastTurn.message as any).pendingStatus)

  if (
    isRunActive &&
    lastTurn?.type !== 'assistant' &&
    !lastTurnIsPendingUser &&
    activeAssistantTurnIndex === -1
  ) {
    nodes.push(
      <CompactAssistantTurn
        key="pending-assistant-turn"
        turn={{
          type: 'assistant',
          items: [],
          startedAt: activeTurnStartedAt ?? pendingAssistantStartedAt(turns),
        }}
        live
        compacting={isCompacting}
        handlers={handlers}
      />,
    )
  } else if (isCompacting && turns[turns.length - 1]?.type !== 'assistant') {
    nodes.push(<CompactionDivider key="compaction-progress" pending />)
  }
  return nodes
}

interface CompactTurnHandlers {
  onApproveTool: (toolId: string) => void
  onRejectTool: (toolId: string) => void
  onEditMessage?: (messageId: string, text: string) => void | Promise<void>
  onRetryMessage?: (messageId: string) => void | Promise<void>
  onForkMessage?: (messageId: string) => void | Promise<void>
  onExecuteHook?: (messageId: string) => void | Promise<void>
  toolOverlays?: Readonly<Record<string, ToolLiveOverlay>>
  worktreeSetup?: WorktreeSessionSetup
  onRetryWorktreeSetup?: () => void
  onContinueAnywayWorktreeSetup?: () => void
  onAutoFixWorktreeSetup?: () => void
  onToggleWorktreeSetupDetails?: () => void
}

function CompactAssistantTurn({
  turn,
  live,
  compacting,
  handlers,
}: {
  turn: Extract<ChatTurn, { type: 'assistant' }>
  live: boolean
  compacting: boolean
  handlers: CompactTurnHandlers
}) {
  const messages = assistantTurnMessages(turn)
  const merged = mergeAssistantTurn(messages, turn.startedAt, live, turn.pausedMs)
  const last = messages[messages.length - 1]
  const hasCompaction = turn.items.some((item) => item.type === 'compaction')
  const onRetryMessage = handlers.onRetryMessage
  const onForkMessage = handlers.onForkMessage
  const onExecuteHook = handlers.onExecuteHook
  const targetId = last ? last.id : merged.id
  if (!hasCompaction && !compacting) {
    return (
      <MessageItem
        message={merged}
        onApproveTool={handlers.onApproveTool}
        onRejectTool={handlers.onRejectTool}
        onEditMessage={handlers.onEditMessage}
        onRetry={
          onRetryMessage
            ? () => onRetryMessage(targetId)
            : undefined
        }
        onFork={
          onForkMessage
            ? () => onForkMessage(targetId)
            : undefined
        }
        onExecuteHook={
          onExecuteHook
            ? () => onExecuteHook(targetId)
            : undefined
        }
        toolOverlays={handlers.toolOverlays}
        compactActivity
        collapsedText={
          last ? trailingAssistantText(last.parts, last.content) : undefined
        }
      />
    )
  }
  return (
    <CompactAssistantTurnWithCompaction
      turn={turn}
      merged={merged}
      last={last}
      compacting={compacting}
      handlers={handlers}
    />
  )
}

interface AssistantMessagesSection {
  type: 'messages'
  messages: DisplayChatMessage[]
  merged: DisplayChatMessage
}

interface AssistantCompactionSection {
  type: 'compaction'
  message: DisplayCompaction
}

type AssistantTurnSection = AssistantMessagesSection | AssistantCompactionSection

function splitAssistantTurnSections(
  items: readonly AssistantTurnItem[],
  startedAt: number,
  live: boolean,
  pausedMs?: number,
  compacting = false,
): AssistantTurnSection[] {
  const sections: AssistantTurnSection[] = []
  let currentMessages: DisplayChatMessage[] = []

  const flushMessages = (isFollowedByCompaction: boolean, isLastStage: boolean) => {
    if (currentMessages.length === 0) return
    const isCutByCompaction = isFollowedByCompaction || (compacting && isLastStage)
    const stageLive = !isCutByCompaction && live

    const messagesToMerge = isCutByCompaction
      ? currentMessages.map((msg) =>
          msg.status === 'streaming'
            ? { ...msg, status: 'done' as const }
            : msg,
        )
      : currentMessages

    const stageMerged = mergeAssistantTurn(
      messagesToMerge,
      messagesToMerge[0]?.createdAt ?? startedAt,
      stageLive,
      pausedMs,
    )

    const finalMerged =
      isCutByCompaction && stageMerged.status === 'streaming'
        ? { ...stageMerged, status: 'done' as const }
        : stageMerged

    sections.push({
      type: 'messages',
      messages: currentMessages,
      merged: finalMerged,
    })
    currentMessages = []
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.type === 'compaction') {
      flushMessages(true, false)
      sections.push({
        type: 'compaction',
        message: item.message,
      })
    } else {
      currentMessages.push(item.message)
    }
  }
  flushMessages(false, true)

  return sections
}

function CompactAssistantTurnWithCompaction({
  turn,
  merged,
  last,
  compacting,
  handlers,
}: {
  turn: Extract<ChatTurn, { type: 'assistant' }>
  merged: DisplayChatMessage
  last: DisplayChatMessage | undefined
  compacting: boolean
  handlers: CompactTurnHandlers
}) {
  const [historyOpen, setHistoryOpen] = useState(
    () => merged.status === 'streaming',
  )

  useEffect(() => {
    if (merged.status === 'streaming') {
      setHistoryOpen(true)
      return
    }
    if (
      merged.status === 'done' ||
      merged.status === 'error' ||
      merged.status === 'aborted'
    ) {
      setHistoryOpen(false)
    }
  }, [merged.status])

  const streaming = merged.status === 'streaming'
  const terminal =
    merged.status === 'done' ||
    merged.status === 'error' ||
    merged.status === 'aborted'
  const visible = hasVisibleTurnContent(merged.parts, merged.content)
  const showFull = streaming || historyOpen
  const isInterrupted =
    !streaming &&
    (merged.status === 'aborted' ||
      merged.status === 'error' ||
      (merged as any).interrupted === true)

  const onRetryMessage = handlers.onRetryMessage
  const onForkMessage = handlers.onForkMessage
  const onExecuteHook = handlers.onExecuteHook
  const targetId = last ? last.id : merged.id

  const sections = splitAssistantTurnSections(
    turn.items,
    turn.startedAt,
    streaming,
    turn.pausedMs,
    compacting,
  )

  let lastMessagesSectionIndex = -1
  for (let i = sections.length - 1; i >= 0; i--) {
    if (sections[i].type === 'messages') {
      lastMessagesSectionIndex = i
      break
    }
  }

  return (
    <div className="w-full text-[14px]">
      <TurnHeader
        startedAt={merged.createdAt}
        completedAt={(merged as any).completedAt}
        streaming={streaming}
        status={merged.status}
        interrupted={isInterrupted}
        expanded={historyOpen}
        pausedMs={(merged as any).pausedMs}
        onToggle={
          terminal && visible
            ? () => setHistoryOpen((open) => !open)
            : undefined
        }
      />
      {showFull
        ? sections.map((section, index) => {
            if (section.type === 'compaction') {
              return <CompactionDivider key={section.message.id} />
            }
            const isLast = index === lastMessagesSectionIndex
            const stageLast = section.messages[section.messages.length - 1]
            const stageTargetId = isLast ? targetId : (stageLast?.id ?? section.merged.id)
            return (
              <MessageItem
                key={section.merged.id}
                message={section.merged}
                onApproveTool={handlers.onApproveTool}
                onRejectTool={handlers.onRejectTool}
                onEditMessage={handlers.onEditMessage}
                onRetry={
                  onRetryMessage
                    ? () => onRetryMessage(stageTargetId)
                    : undefined
                }
                onFork={
                  onForkMessage
                    ? () => onForkMessage(stageTargetId)
                    : undefined
                }
                onExecuteHook={
                  onExecuteHook
                    ? () => onExecuteHook(stageTargetId)
                    : undefined
                }
                toolOverlays={handlers.toolOverlays}
                compactActivity
                suppressTurnHeader
                forceExpanded
                suppressActions={!isLast}
              />
            )
          })
        : (
            <>
              {sections.map((section, index) => {
                if (section.type === 'compaction') {
                  return <CompactionDivider key={section.message.id} />
                }
                const isLast = index === lastMessagesSectionIndex
                if (!isLast) {
                  return null
                }
                return (
                  <MessageItem
                    key={section.merged.id}
                    message={section.merged}
                    onApproveTool={handlers.onApproveTool}
                    onRejectTool={handlers.onRejectTool}
                    onEditMessage={handlers.onEditMessage}
                    onRetry={
                      onRetryMessage
                        ? () => onRetryMessage(targetId)
                        : undefined
                    }
                    onFork={
                      onForkMessage
                        ? () => onForkMessage(targetId)
                        : undefined
                    }
                    onExecuteHook={
                      onExecuteHook
                        ? () => onExecuteHook(targetId)
                        : undefined
                    }
                    toolOverlays={handlers.toolOverlays}
                    compactActivity
                    suppressTurnHeader
                    collapsedText={trailingAssistantText(
                      last?.parts,
                      last?.content ?? merged.content,
                    )}
                  />
                )
              })}
            </>
          )}
      {compacting ? <CompactionDivider pending /> : null}
    </div>
  )
}

function findLastUserMessage(
  messages: readonly DisplayMessage[],
): DisplayChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index]
    if (item && item.kind === 'message' && item.role === 'user') {
      return item
    }
  }
  return undefined
}

function compactAssistantTurnKey(
  turn: Extract<ChatTurn, { type: 'assistant' }>,
): string {
  const first = turn.items[0]
  return (first?.type === 'message' ? first.message.id : first?.message.id) ?? `assistant-turn-${turn.startedAt}`
}

function pendingAssistantStartedAt(turns: readonly ChatTurn[]): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn?.type === 'user') return turn.message.createdAt
    if (turn?.type === 'assistant') return turn.startedAt
  }
  return Date.now()
}
