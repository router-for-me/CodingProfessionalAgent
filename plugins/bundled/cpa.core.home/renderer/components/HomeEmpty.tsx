import { useEffect } from 'react'
import { useHostServices, useTranslation } from '@cpa/plugin-ui'
import { useNavigate } from '@tanstack/react-router'
import {
    getQuickActionPrompt,
    type QuickActionKind,
} from '../utils/templates.js'
import { CodingLogo } from './CodingLogo.js'
import { QuickActionCards } from './QuickActionCards.js'

export interface HomeEmptyProps {
    onSelect?: (kind: QuickActionKind) => void
}

/**
 * Centered home empty state: logo mark, title, and quick-action cards.
 * Card click sends the template prompt through host services and navigates.
 */
export function HomeEmpty({ onSelect }: HomeEmptyProps = {}) {
    const { t, i18n } = useTranslation()
    const navigate = useNavigate()
    const services = useHostServices()
    const locale = (i18n.language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en'

    useEffect(() => {
        services?.sessions?.setCurrentSessionId?.(null)
    }, [services])

    const handleSelect = (kind: QuickActionKind) => {
        if (onSelect) {
            onSelect(kind)
            return
        }

        const isStreaming = (services as any)?.agent?.isStreaming
        if (isStreaming) return

        const prompt = getQuickActionPrompt(kind, locale)
        const pendingSessionContext = services?.ui?.getPendingSessionContext?.() ?? {
            projectId: null,
            branch: null,
            workLocation: 'local',
            environmentId: null,
        }

        void (async () => {
            if ((services as any)?.agent?.send) {
                const sessionId = await (services as any).agent.send({
                    text: prompt,
                    kind,
                    projectId: pendingSessionContext.projectId,
                    branch: pendingSessionContext.branch,
                    workLocation: pendingSessionContext.workLocation,
                    environmentId: pendingSessionContext.environmentId,
                    sessionId: null,
                })
                if (!sessionId) return
                if (services?.navigation?.navigate) {
                    await services.navigation.navigate(`/chat/${sessionId}`)
                } else {
                    void navigate({
                        to: '/chat/$sessionId',
                        params: { sessionId },
                    } as any)
                }
            } else if (services?.sessions?.create) {
                const sessionId = await services.sessions.create({
                    projectId: pendingSessionContext.projectId ?? undefined,
                    branch: pendingSessionContext.branch ?? undefined,
                    workLocation: pendingSessionContext.workLocation,
                    environmentId: pendingSessionContext.environmentId,
                })
                if (sessionId) {
                    if (services?.navigation?.navigate) {
                        await services.navigation.navigate(`/chat/${sessionId}`)
                    } else {
                        void navigate({
                            to: '/chat/$sessionId',
                            params: { sessionId },
                        } as any)
                    }
                }
            } else if (services?.navigation?.navigate) {
                await services.navigation.navigate('/chat/new')
            } else {
                void navigate({
                    to: '/',
                })
            }
        })()
    }

    return (
        <div className="flex h-full w-full items-center justify-center overflow-auto p-8">
            <div className="flex w-full max-w-[720px] flex-col items-center pb-28 text-center">
                <div
                    className="mb-5 flex size-16 items-center justify-center text-[var(--text-muted)]"
                    aria-hidden
                >
                    <CodingLogo className="size-16" />
                </div>

                <h1 className="mb-8 text-[22px] font-medium tracking-tight text-[var(--text-primary)]">
                    {t('home.title', 'How can I help you today?')}
                </h1>

                <QuickActionCards onSelect={handleSelect} />
            </div>
        </div>
    )
}
