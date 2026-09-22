import { useEffect, useRef, useState } from 'react'
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
    const [submitting, setSubmitting] = useState(false)

    const logoRef = useRef<SVGSVGElement | null>(null)
    const animStateRef = useRef({
        currentAngle: 0,
        targetAngle: 0,
        velocity: 0,
        rafId: 0,
        lastTime: 0,
    })

    useEffect(() => {
        services?.sessions?.setCurrentSessionId?.(null)
        return () => {
            if (animStateRef.current.rafId) {
                cancelAnimationFrame(animStateRef.current.rafId)
            }
        }
    }, [services])

    const handleLogoClick = () => {
        const state = animStateRef.current
        state.targetAngle += 360

        if (!state.rafId) {
            state.lastTime = performance.now()
            const step = (now: number) => {
                const dt = Math.min(0.05, (now - state.lastTime) / 1000)
                state.lastTime = now

                const remaining = state.targetAngle - state.currentAngle

                if (remaining <= 0.2) {
                    state.currentAngle = 0
                    state.targetAngle = 0
                    state.velocity = 0
                    state.rafId = 0
                    if (logoRef.current) {
                        logoRef.current.style.transform = ''
                    }
                    return
                }

                const CRUISE_SPEED = 720
                const ACCELERATION = 5000
                const DECEL_DISTANCE = 180

                let desiredV: number
                if (remaining <= DECEL_DISTANCE) {
                    const progress = Math.max(0, remaining / DECEL_DISTANCE)
                    desiredV = Math.max(30, CRUISE_SPEED * Math.sqrt(progress))
                } else {
                    desiredV = CRUISE_SPEED
                }

                if (state.velocity < desiredV) {
                    state.velocity = Math.min(desiredV, state.velocity + ACCELERATION * dt)
                } else {
                    state.velocity = Math.max(desiredV, state.velocity - ACCELERATION * dt)
                }

                const delta = Math.min(remaining, state.velocity * dt)
                state.currentAngle += delta

                if (logoRef.current) {
                    logoRef.current.style.transform = `rotate(${state.currentAngle}deg)`
                }

                state.rafId = requestAnimationFrame(step)
            }
            state.rafId = requestAnimationFrame(step)
        }
    }

    const handleSelect = (kind: QuickActionKind) => {
        if (onSelect) {
            onSelect(kind)
            return
        }

        if (submitting) return
        setSubmitting(true)

        const prompt = getQuickActionPrompt(kind, locale)
        const pendingSessionContext = services?.ui?.getPendingSessionContext?.() ?? {
            projectId: null,
            branch: null,
            workLocation: 'local',
            environmentId: null,
        }

        void (async () => {
            try {
                const sendFn = services?.agentRun?.send ?? services?.chatMessages?.send

                if (sendFn) {
                    const sessionId = await sendFn({
                        text: prompt,
                        projectId: pendingSessionContext.projectId,
                        branch: pendingSessionContext.branch,
                        workLocation: pendingSessionContext.workLocation,
                        environmentId: pendingSessionContext.environmentId,
                        sessionId: null as any,
                    })
                    if (!sessionId) {
                        setSubmitting(false)
                        return
                    }
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
                    } else {
                        setSubmitting(false)
                    }
                } else if (services?.navigation?.navigate) {
                    await services.navigation.navigate('/chat/new')
                } else {
                    void navigate({
                        to: '/',
                    })
                }
            } catch (err) {
                setSubmitting(false)
                console.error('[HomeEmpty] Failed to start quick action:', err)
            }
        })()
    }

    return (
        <div className="flex h-full w-full items-center justify-center overflow-auto p-8">
            <div className="flex w-full max-w-[720px] flex-col items-center pb-28 text-center">
                <button
                    type="button"
                    onClick={handleLogoClick}
                    onMouseDown={(e) => e.preventDefault()}
                    className="mb-5 flex size-16 cursor-pointer items-center justify-center select-none text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus:outline-none"
                    aria-label="Logo"
                >
                    <CodingLogo
                        ref={logoRef}
                        className="size-16 origin-center will-change-transform"
                    />
                </button>

                <h1 className="mb-8 text-[22px] font-medium tracking-tight text-[var(--text-primary)]">
                    {t('home.title', 'How can I help you today?')}
                </h1>

                <QuickActionCards onSelect={handleSelect} />
            </div>
        </div>
    )
}
