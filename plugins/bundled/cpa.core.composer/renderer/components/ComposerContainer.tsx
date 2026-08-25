import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import {
    useAgentRunState,
    useDisplayMessages,
    useHostServices,
    usePrompts,
    useSessionResumable,
    useSupportsImages,
    useTranslation,
} from '@cpa/plugin-ui'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import { Composer, type ComposerSendPayload } from './Composer.js'
import { useComposerSkills } from '../utils/useComposerSkills.js'
import { isTurnCompleted } from '../utils/turnCompletion.js'

export function ComposerContainer() {
    const { t } = useTranslation()
    const services = useHostServices()
    const navigate = useNavigate()

    const isChatOrHome = useRouterState({
        select: (state) => {
            const pathname = state?.location?.pathname ?? '/'
            return pathname === '/' || pathname.startsWith('/chat')
        },
    })
    const chatSessionId = useRouterState({
        select: (state) => {
            const match = state?.location?.pathname?.match(/^\/chat\/([^/]+)/)
            return match?.[1] ?? null
        },
    })

    const agentRunState = useAgentRunState(chatSessionId ?? '')
    const isStreaming = chatSessionId ? (agentRunState?.isStreaming ?? false) : false
    const runStatus = chatSessionId ? agentRunState?.runState?.status : undefined

    const supportsImages = useSupportsImages(chatSessionId)
    const isSessionResumable = useSessionResumable(chatSessionId)
    const [stoppedSessionId, setStoppedSessionId] = useState<string | null>(null)
    const messages = useDisplayMessages(chatSessionId ?? '')
    const isTurnComplete = isTurnCompleted(messages, runStatus, isStreaming)

    const canResume = Boolean(
        chatSessionId &&
            !isStreaming &&
            !isTurnComplete &&
            (isSessionResumable || stoppedSessionId === chatSessionId),
    )

    const prompts = usePrompts()
    const skills = useComposerSkills()

    const handleSend = useCallback(
        (payload: ComposerSendPayload): Promise<void> =>
            new Promise<void>((resolve, reject) => {
                let accepted = false
                const acceptSession = (sessionId: string): void => {
                    if (accepted) return
                    accepted = true
                    try {
                        const navigation =
                            chatSessionId === null
                                ? navigate
                                    ? navigate({
                                          to: '/chat/$sessionId',
                                          params: { sessionId },
                                      } as any)
                                    : services?.navigation?.navigate?.(`/chat/${sessionId}`)
                                : undefined
                        void Promise.resolve(navigation).then(resolve, reject)
                    } catch (error) {
                        reject(error)
                    }
                }

                if (!services?.chatMessages?.send) {
                    reject(new Error('Send service unavailable'))
                    return
                }

                setStoppedSessionId(null)

                void services.chatMessages
                    .send({
                        text: payload.text,
                        images: payload.images,
                        projectId: payload.projectId,
                        branch: payload.branch,
                        workLocation: payload.workLocation,
                        environmentId: payload.environmentId,
                        followUpMode: payload.followUpMode,
                        sessionId: chatSessionId ?? '',
                        onSessionAccepted: acceptSession,
                    })
                    .then(
                        (sessionId) => {
                            if (sessionId) {
                                acceptSession(sessionId)
                            } else if (!accepted) {
                                reject(
                                    new Error(
                                        t('composer.sendFailed', {
                                            defaultValue: 'Send failed',
                                        }),
                                    ),
                                )
                            }
                        },
                        (error: unknown) => {
                            if (!accepted) reject(error)
                        },
                    )
            }),
        [services, chatSessionId, navigate, t],
    )

    const handleCompact = useCallback(
        async (focus: string): Promise<void> => {
            if (services?.chatMessages?.compact) {
                await services.chatMessages.compact(focus, chatSessionId)
            } else if (chatSessionId && services?.chatMessages?.send) {
                await services.chatMessages.send({
                    text: `/compact ${focus}`.trim(),
                    sessionId: chatSessionId,
                })
            }
        },
        [services, chatSessionId],
    )

    const handleStop = useCallback(() => {
        if (!chatSessionId) return
        setStoppedSessionId(chatSessionId)
        services?.chatMessages?.stop?.(chatSessionId)
    }, [services, chatSessionId])

    const handleResume = useCallback(async () => {
        if (!chatSessionId) return
        setStoppedSessionId(null)
        if (services?.chatMessages?.resumeSession) {
            await services.chatMessages.resumeSession(chatSessionId)
        }
    }, [services, chatSessionId])

    const isRunning =
        isStreaming ||
        Boolean(
            runStatus &&
                !['idle', 'done', 'error', 'aborted', ''].includes(runStatus),
        )

    useEffect(() => {
        const unsub = rendererEventBus.on('composer:stop', () => {
            if (isRunning) {
                handleStop()
            }
        })
        return () => {
            unsub()
        }
    }, [handleStop, isRunning])



    if (!isChatOrHome) {
        return null
    }

    return (
        <Composer
            sessionId={chatSessionId}
            onSend={handleSend}
            isStreaming={isStreaming}
            runStatus={runStatus}
            onStop={handleStop}
            onResume={handleResume}
            canResume={canResume}
            isTurnComplete={isTurnComplete}
            onCompact={handleCompact}
            supportsImages={supportsImages}
            skills={skills}
            prompts={prompts}
        />
    )
}
