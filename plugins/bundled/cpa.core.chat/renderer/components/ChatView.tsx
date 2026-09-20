import { useCallback, useEffect, useState } from 'react'
import { useParams, useNavigate } from '@tanstack/react-router'
import {
    ExtensionSlot,
    useActiveRun,
    useAgentRunState,
    useChatMessageService,
    useDisplayMessages,
    useHostServices,
    useIsCompacting,
    useSessions,
    useToolOverlays,
    useTranslation,
    useWorktreeSetup,
} from '@cpa/plugin-ui'
import type { DisplayMessage } from '../types.js'
import { MessageList } from './MessageList.js'

export interface ChatViewProps {
    sessionId?: string
}

interface WorktreeRestartState {
    startedAt: number
    localRunId: string | null
    remoteRunId: string | null
}

/**
 * Session chat surface: validates route id, syncs current session, renders messages.
 * Composer stays mounted in AppShell.
 * Consumes canonical DisplayMessage[] projection + ephemeral tool overlays.
 */
export function ChatView(props: ChatViewProps) {
    let routeSessionId = ''
    let navigate: any = null
    try {
        const params = useParams({ strict: false }) as { sessionId?: string }
        routeSessionId = params.sessionId ?? ''
        navigate = useNavigate()
    } catch {
        // Not in router context
    }
    const sessionId = props.sessionId || routeSessionId
    const { t } = useTranslation()
    const services = useHostServices()
    const chatService = useChatMessageService()
    const sessions = useSessions()

    const messages = useDisplayMessages(sessionId)
    const toolOverlays = useToolOverlays(sessionId)
    const isCompacting = useIsCompacting(sessionId)
    const worktreeSetup = useWorktreeSetup(sessionId)
    const agentRunState = useAgentRunState(sessionId)
    const activeRun = useActiveRun(sessionId)

    const isStreaming = agentRunState.isStreaming
    const activeRunId = agentRunState.activeRunId
    const isRemoteRunning = Boolean(activeRun && activeRun.status !== 'idle')
    const isLocalRunning = Boolean(isStreaming)
    const isRunActive = isLocalRunning || isRemoteRunning

    const [worktreeRestart, setWorktreeRestart] = useState<WorktreeRestartState>()
    const isRestartingWorktree = worktreeRestart !== undefined

    useEffect(() => {
        if (!worktreeRestart) return
        const newLocalRunStarted = Boolean(
            isLocalRunning &&
                activeRunId &&
                activeRunId !== worktreeRestart.localRunId,
        )
        const newRemoteRunStarted = Boolean(
            isRemoteRunning &&
                activeRun?.runId &&
                activeRun.runId !== worktreeRestart.remoteRunId,
        )
        if (newLocalRunStarted || newRemoteRunStarted) {
            setWorktreeRestart(undefined)
        }
    }, [activeRun?.runId, activeRunId, isLocalRunning, isRemoteRunning, worktreeRestart])

    const restartLastUserTurn = useCallback(
        (targetSessionId: string) => {
            if (!chatService?.getEntries || !chatService.replaceSessionEntries) return undefined
            const entries = chatService.getEntries(targetSessionId)
            let lastUserIndex = -1
            for (let index = entries.length - 1; index >= 0; index -= 1) {
                if (entries[index]?.kind === 'user') {
                    lastUserIndex = index
                    break
                }
            }

            const lastUser = entries[lastUserIndex]
            if (!lastUser || lastUser.kind !== 'user') return undefined

            const restartedUser = {
                ...lastUser,
                createdAt: Date.now(),
            }
            chatService.replaceSessionEntries(targetSessionId, [
                ...entries.slice(0, lastUserIndex),
                restartedUser,
            ], { historyMutation: 'truncate' })
            return restartedUser
        },
        [chatService],
    )

    const handleRetryWorktree = useCallback(async () => {
        const lastUser = restartLastUserTurn(sessionId)
        setWorktreeRestart({
            startedAt: lastUser?.createdAt ?? Date.now(),
            localRunId: activeRunId,
            remoteRunId: activeRun?.runId ?? null,
        })
        let handedOff = false

        try {
            const res = await chatService?.retryWorktreeSetup?.(sessionId)
            if (res?.ok) {
                services?.ui?.emitEvent?.('setPinnedSummaryVisible', true)
            }
            if (res?.ok && lastUser) {
                const content = lastUser.content ?? []
                const lastText = content.find((c: any) => c?.type === 'text')?.text || ''
                if (lastText && chatService?.send) {
                    const resumedSessionId = await chatService.send({
                        text: lastText,
                        sessionId,
                        userEntryId: lastUser.id,
                        userEntryCreatedAt: lastUser.createdAt,
                    })
                    handedOff = Boolean(resumedSessionId)
                }
            }
        } finally {
            if (!handedOff) {
                setWorktreeRestart(undefined)
            }
        }
    }, [activeRun?.runId, activeRunId, chatService, restartLastUserTurn, services?.ui, sessionId])

    const handleContinueAnywayWorktree = useCallback(async () => {
        const lastUser = restartLastUserTurn(sessionId)
        setWorktreeRestart({
            startedAt: lastUser?.createdAt ?? Date.now(),
            localRunId: activeRunId,
            remoteRunId: activeRun?.runId ?? null,
        })
        let handedOff = false

        try {
            await chatService?.continueAnywayWorktreeSetup?.(sessionId)
            services?.ui?.emitEvent?.('setPinnedSummaryVisible', true)
            if (lastUser) {
                const content = lastUser.content ?? []
                const lastText = content.find((c: any) => c?.type === 'text')?.text || ''
                if (lastText && chatService?.send) {
                    const resumedSessionId = await chatService.send({
                        text: lastText,
                        sessionId,
                        userEntryId: lastUser.id,
                        userEntryCreatedAt: lastUser.createdAt,
                    })
                    handedOff = Boolean(resumedSessionId)
                }
            }
        } finally {
            if (!handedOff) {
                setWorktreeRestart(undefined)
            }
        }
    }, [activeRun?.runId, activeRunId, chatService, restartLastUserTurn, services?.ui, sessionId])

    const handleAutoFixWorktree = useCallback(async () => {
        if (worktreeSetup?.details && chatService?.send) {
            await chatService.send({
                text: `Environment setup failed. Please analyze the following setup logs and help me fix it:\n\n\`\`\`\n${worktreeSetup.details}\n\`\`\``,
                sessionId,
            })
        }
    }, [chatService, sessionId, worktreeSetup?.details])

    const handleToggleWorktreeDetails = useCallback(() => {
        chatService?.toggleWorktreeSetupDetails?.(sessionId)
    }, [chatService, sessionId])

    const handleEditMessage = useCallback(
        async (messageId: string, text: string) => {
            if (!chatService?.send) return
            const editedSessionId = await chatService.send({
                text,
                sessionId,
                editMessageId: messageId,
            })
            if (!editedSessionId) {
                throw new Error(
                    t('composer.sendFailed', { defaultValue: 'Send failed' }),
                )
            }
        },
        [chatService, sessionId, t],
    )

    const handleRetryMessage = useCallback(
        async (_messageId: string) => {
            if (!chatService?.retrySession) return
            await chatService.retrySession(sessionId)
        },
        [chatService, sessionId],
    )

    const handleForkMessage = useCallback(
        async (messageId: string) => {
            try {
                if (chatService?.forkSession) {
                    const forkedSessionId = await chatService.forkSession(sessionId, messageId)
                    if (forkedSessionId) {
                        services?.ui?.pushToast(
                            t('message.forkSuccess', {
                                defaultValue: 'Forked new chat from current position',
                            }),
                        )
                        if (services?.navigation?.navigate) {
                            await services.navigation.navigate(`/chat/${forkedSessionId}`)
                        } else if (navigate) {
                            await navigate({ to: `/chat/${forkedSessionId}` })
                        }
                    }
                }
            } catch (err) {
                services?.ui?.pushToast(
                    err instanceof Error
                        ? err.message
                        : t('message.forkFailed', {
                            defaultValue: 'Failed to fork chat',
                        }),
                )
            }
        },
        [chatService, navigate, services, sessionId, t],
    )

    const handleExecuteHook = useCallback(
        async (_messageId: string) => {
            try {
                await chatService?.executeHook?.('completion', sessionId)
                services?.ui?.pushToast(
                    t('message.hookSuccess', {
                        defaultValue: 'Session completion hook executed',
                    }),
                )
            } catch (err) {
                services?.ui?.pushToast(
                    err instanceof Error
                        ? err.message
                        : t('message.hookFailed', {
                            defaultValue: 'Hook execution failed',
                        }),
                )
            }
        },
        [chatService, services, sessionId, t],
    )

    const currentSession = sessions.find((item) => item.id === sessionId)
    const isCurrentSessionUnread = Boolean(currentSession?.unread)
    const isCurrentSessionManuallyMarkedUnread = Boolean(
        services?.sessions?.isManuallyMarkedUnread?.(sessionId),
    )

    useEffect(() => {
        if (!sessionId) return
        const session = services?.sessions?.getSnapshot?.()?.find((item) => item.id === sessionId)
        if (session && session.archivedAt !== undefined) {
            if (services?.navigation?.navigate) {
                void services.navigation.navigate('/')
            } else if (navigate) {
                void navigate({ to: '/' })
            }
            return
        }
        services?.sessions?.setCurrentSessionId?.(sessionId)
        if (session?.unread) {
            services?.sessions?.markRead?.(sessionId)
            chatService?.schedulePersist?.(true)
        }
        void chatService?.ensureSessionLoaded?.(sessionId)
    }, [sessionId])

    useEffect(() => {
        if (sessionId && isCurrentSessionUnread && !isCurrentSessionManuallyMarkedUnread) {
            services?.sessions?.markRead?.(sessionId)
            chatService?.schedulePersist?.(true)
        }
    }, [sessionId, isCurrentSessionUnread, isCurrentSessionManuallyMarkedUnread])

    const approveTool = useCallback(
        (toolId: string) => {
            chatService?.approveTool?.(toolId)
        },
        [chatService],
    )

    const rejectTool = useCallback(
        (toolId: string) => {
            chatService?.rejectTool?.(toolId)
        },
        [chatService],
    )

    return (
        <div className="flex h-full min-h-0 w-full flex-col">
            <ExtensionSlot name="chat.view.banner" props={{ sessionId }} />
            <div className="flex-1 min-h-0">
                <MessageList
                    sessionKey={sessionId}
                    messages={messages as DisplayMessage[]}
                    worktreeSetup={worktreeSetup}
                    onRetryWorktreeSetup={handleRetryWorktree}
                    onContinueAnywayWorktreeSetup={handleContinueAnywayWorktree}
                    onAutoFixWorktreeSetup={handleAutoFixWorktree}
                    onToggleWorktreeSetupDetails={handleToggleWorktreeDetails}
                    onApproveTool={approveTool}
                    onRejectTool={rejectTool}
                    onEditMessage={handleEditMessage}
                    onRetryMessage={handleRetryMessage}
                    onForkMessage={handleForkMessage}
                    onExecuteHook={handleExecuteHook}
                    toolOverlays={toolOverlays}
                    compactActivity
                    isRunActive={isRunActive || isRestartingWorktree}
                    activeTurnStartedAt={worktreeRestart?.startedAt}
                    isCompacting={isCompacting}
                    contentTestId="message-list-content"
                />
            </div>
            <ExtensionSlot name="chat.view.footer" props={{ sessionId }} />
        </div>
    )
}
