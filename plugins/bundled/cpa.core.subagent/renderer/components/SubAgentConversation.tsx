import { useEffect, useMemo, useRef } from 'react'
import {
  ArrowLeft,
  useTranslation,
  useHostServices,
  useDisplayMessages,
  useToolOverlays,
  useIsCompacting,
  useChatRenderers,
  PluginMessageHost,
  cn,
} from '@cpa/plugin-ui'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { SubAgentAvatar } from './SubAgentAvatar.js'
import { SubAgentMetaText } from './SubAgentMetaText.js'
import { ContextUsageRing } from './ContextUsageRingAdapter.js'

const STICK_TO_BOTTOM_PX = 48

export interface SubAgentConversationProps {
    sessionId: string
    agent: SubAgentRecord
    onBack: () => void
}

function computeScrollFingerprint(
    messages: readonly any[],
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
                    ?.map((part: any) => {
                        if (part.type === 'tool_call') {
                            return `${part.id}:${part.status}:${part.result?.length ?? 0}`
                        }
                        if (part.type === 'thinking') {
                            return `th:${part.thinking?.length ?? 0}`
                        }
                        return `t:${part.text?.length ?? 0}`
                    })
                    .join(',') ?? ''
            return `${message.id}:${message.status ?? ''}:${String(message.content ?? '').length}:${partsKey}`
        })
        .join('|')
    const firstId = messages[0]?.id ?? ''
    return `${sessionKey ?? ''}:${isCompacting ? '1' : '0'}:${len}:${firstId}#${tailKey}`
}

function findLastUserMessage(messages: readonly any[]): any | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const item = messages[index]
        if (!item || item.kind === 'compaction') continue
        if (item.role === 'user' || item.kind === 'user') {
            return item
        }
    }
    return undefined
}

interface ChatTurn {
    userMessage?: any
    assistantMessages: any[]
    startedAt: number
    completedAt?: number
    pausedMs?: number
    isLastTurn: boolean
}

function groupMessagesIntoTurns(messages: readonly any[]): ChatTurn[] {
    const turns: ChatTurn[] = []
    let currentTurn: ChatTurn | null = null

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg) continue

        if (msg.kind === 'compaction') {
            continue
        }

        const isUser = msg.role === 'user' || msg.kind === 'user'
        if (isUser) {
            const pMs = typeof msg.pausedMs === 'number' && msg.pausedMs > 0 ? msg.pausedMs : undefined
            currentTurn = {
                userMessage: msg,
                assistantMessages: [],
                startedAt: msg.createdAt || msg.timestamp || Date.now(),
                ...(pMs !== undefined ? { pausedMs: pMs } : {}),
                isLastTurn: false,
            }
            turns.push(currentTurn)
        } else {
            if (!currentTurn) {
                currentTurn = {
                    assistantMessages: [msg],
                    startedAt: msg.createdAt || msg.timestamp || Date.now(),
                    isLastTurn: false,
                }
                turns.push(currentTurn)
            } else {
                currentTurn.assistantMessages.push(msg)
            }
            if (typeof msg.completedAt === 'number') {
                currentTurn.completedAt =
                    currentTurn.completedAt === undefined
                        ? msg.completedAt
                        : Math.max(currentTurn.completedAt, msg.completedAt)
            }
        }
    }

    if (turns.length > 0) {
        turns[turns.length - 1].isLastTurn = true
    }

    return turns
}

/**
 * Flatten one request's assistant stages into a single display message.
 * Mirrors main-chat mergeAssistantTurn so in-progress tool calls from earlier
 * stages stay visible while the live turn continues streaming.
 */
export function mergeAssistantMessages(
    messages: readonly any[],
    startedAt: number,
    live?: boolean,
    pausedMs?: number,
    fallbackCompletedAt?: number,
): any {
    const first = messages[0]
    const last = messages[messages.length - 1]
    const resolvedPausedMs =
        typeof pausedMs === 'number' && pausedMs > 0
            ? pausedMs
            : messages.reduce<number>((max, m) => {
                  const p = typeof m?.pausedMs === 'number' ? m.pausedMs : 0
                  return Math.max(max, p)
              }, 0)
    if (!first || !last) {
        return {
            kind: 'message',
            id: `assistant-turn-${startedAt}`,
            sessionId: '',
            role: 'assistant',
            content: '',
            parts: [],
            status: live ? 'streaming' : 'done',
            createdAt: startedAt,
            ...(resolvedPausedMs > 0 ? { pausedMs: resolvedPausedMs } : {}),
        }
    }

    const parts: any[] = []
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
        typeof live === 'boolean'
            ? live
            : messages.some((message) => message.status === 'streaming')
    const status = streaming
        ? 'streaming'
        : messages.some((message) => message.status === 'error')
          ? 'error'
          : messages.some((message) => message.status === 'aborted')
            ? 'aborted'
            : 'done'

    const errorMessage = [...messages]
        .reverse()
        .find((message) => Boolean(message.errorMessage))?.errorMessage

    const resolvedCompletedAt = messages.reduce<number | undefined>((max, m) => {
        const c =
            typeof m.completedAt === 'number' && Number.isFinite(m.completedAt)
                ? m.completedAt
                : undefined
        if (c === undefined) return max
        return max === undefined ? c : Math.max(max, c)
    }, undefined)

    const effectiveCompletedAt =
        resolvedCompletedAt !== undefined
            ? resolvedCompletedAt
            : fallbackCompletedAt

    return {
        kind: 'message',
        id: first.id,
        sessionId: first.sessionId,
        role: 'assistant',
        content: texts.join('') || last.content || '',
        parts,
        status,
        ...(errorMessage ? { errorMessage } : {}),
        createdAt: startedAt,
        ...(streaming || typeof effectiveCompletedAt !== 'number'
            ? {}
            : { completedAt: effectiveCompletedAt }),
        ...(resolvedPausedMs > 0 ? { pausedMs: resolvedPausedMs } : {}),
    }
}

/**
 * Dedicated sub-agent conversation view with turn grouping, tool status, and meta header.
 * Dispatches message rendering via public chat-renderer contributions.
 */
export function SubAgentConversation({
    sessionId: _parentSessionId,
    agent,
    onBack,
}: SubAgentConversationProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const sessionKey = agent.sessionId || agent.id

    const messages = useDisplayMessages(sessionKey)
    const toolOverlays = useToolOverlays(sessionKey)
    const isCompacting = useIsCompacting(sessionKey)
    const chatRenderers = useChatRenderers()

    const scrollerRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const pinnedRef = useRef(true)
    const lastUserMessage = findLastUserMessage(messages)
    const lastUserMessageKey = lastUserMessage
        ? `${lastUserMessage.id}:${String(lastUserMessage.content ?? '')}`
        : ''
    const lastUserMessageKeyRef = useRef(lastUserMessageKey)
    // Fingerprint tail status/content plus tool status/result and text lengths so
    // streaming, approvals, thinking, and tool results all re-scroll to the bottom.
    const scrollKey = computeScrollFingerprint(messages, isCompacting, sessionKey)

    useEffect(() => {
        if (sessionKey && services?.chatMessages?.ensureSessionLoaded) {
            void services.chatMessages.ensureSessionLoaded(sessionKey)
        }
    }, [sessionKey, services?.chatMessages])

    useEffect(() => {
        pinnedRef.current = true
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
        // Scroll the list container itself (not scrollIntoView) so bottom padding
        // stays in view while content streams in.
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

    const isRunActive = agent.status === 'running' || agent.status === 'queued'

    const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages])

    // Find the currently active turn index when the agent is running/queued:
    // 1. If an earlier turn still has an assistant message in 'streaming' status, that turn is live.
    // 2. Otherwise, the last turn is the active one.
    const activeTurnIdx = useMemo(() => {
        if (!isRunActive || turns.length === 0) {
            return -1
        }
        const streamingIdx = turns.findIndex((turn) =>
            turn.assistantMessages.some((msg) => msg.status === 'streaming'),
        )
        if (streamingIdx !== -1) {
            return streamingIdx
        }
        return turns.length - 1
    }, [isRunActive, turns])

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-app)]">
            {/* Header */}
            <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 bg-[var(--bg-card)] select-none">
                <button
                    type="button"
                    className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)]"
                    onClick={onBack}
                    title={t('common.back')}
                >
                    <ArrowLeft size={14} />
                </button>
                <SubAgentAvatar icon={agent.icon} color={agent.color} size={18} />
                <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                    {agent.name}
                </span>
                <SubAgentMetaText agent={agent} />
                <ContextUsageRing agent={agent} size={16} />
            </div>

            {/* Message timeline with turn grouping */}
            <div
                ref={scrollerRef}
                data-testid="subagent-message-list"
                className="flex-1 min-h-0 overflow-y-auto"
            >
                <div ref={contentRef} className="space-y-4 px-4 py-4">
                    {turns.length === 0 && !isCompacting ? (
                        <div className="flex h-32 items-center justify-center text-[12px] text-[var(--text-muted)]">
                            {t('subagent.noMessages')}
                        </div>
                    ) : (
                        turns.map((turn, turnIdx) => (
                            <TurnSection
                                key={turnIdx}
                                turn={turn}
                                agent={agent}
                                isRunActive={turnIdx === activeTurnIdx}
                                sessionKey={sessionKey}
                                toolOverlays={toolOverlays}
                                chatRenderers={chatRenderers}
                            />
                        ))
                    )}

                    {isCompacting ? (
                        <div
                            role="status"
                            aria-label={t('chat.compacting', 'Compacting context...')}
                            data-testid="compaction-divider"
                            className="text-center py-2 text-[11px] text-[var(--text-muted)] italic border-y border-[var(--border-subtle)] bg-[var(--bg-card)]/50"
                        >
                            {t('chat.compacting', 'Compacting context...')}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

function extractCollapsedText(lastMsg: any): string | undefined {
    if (!lastMsg) return undefined
    if (typeof lastMsg.content === 'string' && lastMsg.content) {
        return lastMsg.content
    }
    if (Array.isArray(lastMsg.parts)) {
        let start = 0
        for (let i = 0; i < lastMsg.parts.length; i++) {
            const p = lastMsg.parts[i]
            if (p?.type === 'tool_call' || p?.type === 'thinking') {
                start = i + 1
            }
        }
        const text = lastMsg.parts
            .slice(start)
            .filter((p: any) => p?.type === 'text')
            .map((p: any) => p.text)
            .join('')
        if (text) return text
    }
    return undefined
}

function TurnSection({
    turn,
    agent,
    isRunActive,
    sessionKey,
    toolOverlays,
    chatRenderers,
}: {
    turn: ChatTurn
    agent: SubAgentRecord
    isRunActive: boolean
    sessionKey: string
    toolOverlays: Readonly<Record<string, any>>
    chatRenderers: readonly any[]
}) {
    const running = isRunActive && (agent.status === 'running' || agent.status === 'queued')
    const fallbackCompletedAt = !running
        ? (turn.isLastTurn
              ? (agent.completedAt ?? agent.updatedAt ?? turn.completedAt)
              : turn.completedAt)
        : undefined

    // Merge all assistant stages in the turn so earlier tool_call parts remain visible
    // while the live request continues. Force streaming while the agent is still running.
    let mergedAssistantMsg: any = null
    let collapsedText: string | undefined = undefined
    if (turn.assistantMessages.length > 0) {
        const lastMsg = turn.assistantMessages[turn.assistantMessages.length - 1]
        collapsedText = extractCollapsedText(lastMsg)
        mergedAssistantMsg = mergeAssistantMessages(
            turn.assistantMessages,
            turn.startedAt,
            running,
            turn.pausedMs,
            fallbackCompletedAt,
        )
    } else if (running) {
        // Agent running without assistant entry yet
        mergedAssistantMsg = {
            id: `running-${turn.startedAt}`,
            role: 'assistant',
            kind: 'message',
            status: 'streaming',
            createdAt: turn.startedAt,
            content: '',
            parts: [],
        }
    }

    return (
        <div className="flex flex-col gap-3">
            {/* User message if present */}
            {turn.userMessage ? (
                <MessageRendererItem
                    message={turn.userMessage}
                    sessionKey={sessionKey}
                    toolOverlays={toolOverlays}
                    isRunActive={false}
                    chatRenderers={chatRenderers}
                />
            ) : null}

            {/* Merged Assistant Turn message */}
            {mergedAssistantMsg ? (
                <MessageRendererItem
                    message={mergedAssistantMsg}
                    sessionKey={sessionKey}
                    toolOverlays={toolOverlays}
                    isRunActive={isRunActive}
                    collapsedText={collapsedText}
                    chatRenderers={chatRenderers}
                />
            ) : null}
        </div>
    )
}

function SubAgentMessageFallback({ message }: { message: any }) {
    const isUser = message.role === 'user' || message.kind === 'user'
    const textContent = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n')
          : String(message.content ?? '')

    return (
        <div
            data-testid={`subagent-message-${message.role || message.kind || 'item'}`}
            className={cn(
                'rounded-lg p-3 text-[12.5px] leading-relaxed',
                isUser
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] ml-8 border border-[var(--border-subtle)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-primary)] mr-8 border border-[var(--border-subtle)]',
            )}
        >
            <p className="whitespace-pre-wrap">{textContent}</p>
        </div>
    )
}

function MessageRendererItem({
    message,
    sessionKey,
    toolOverlays,
    isRunActive,
    collapsedText,
}: {
    message: any
    sessionKey: string
    toolOverlays: Readonly<Record<string, any>>
    isRunActive: boolean
    collapsedText?: string
    chatRenderers?: readonly any[]
}) {
    return (
        <PluginMessageHost
            message={message}
            value={message}
            sessionKey={sessionKey}
            toolOverlays={toolOverlays}
            isRunActive={isRunActive}
            compactActivity
            collapsedText={collapsedText}
            fallback={<SubAgentMessageFallback message={message} />}
        />
    )
}
