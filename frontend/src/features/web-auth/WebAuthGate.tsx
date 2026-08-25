import { useEffect, useState, useRef, type ReactElement } from 'react'
import { useTranslation, I18nextProvider } from 'react-i18next'
import type { Root } from 'react-dom/client'
import { AlertCircle, Eye, EyeOff, Key, Loader2, RotateCw } from 'lucide-react'
import i18n from '@/i18n'
import { cn } from '@/lib/cn'
import { isBrowserEnvironment } from '@/lib/platform'
import { dismissSplashScreen } from '@/lib/splash'
import { getWebAuthStatus, loginWebAuth } from './webAuthClient'

export interface WebAuthGateProps {
    onAuthenticated: () => void
    onGateVisible?: () => void
}

type GateState =
    | { phase: 'checking' }
    | { phase: 'login'; error: 'invalid-password' | null }
    | { phase: 'connection-error' }

/**
 * Web authentication gate component displayed before desktop bridge and agent runtime initialization.
 */
export function WebAuthGate({
    onAuthenticated,
    onGateVisible,
}: WebAuthGateProps): ReactElement | null {
    const { t } = useTranslation()
    const [state, setState] = useState<GateState>({ phase: 'checking' })
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [showAuthPanel, setShowAuthPanel] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const passwordInputRef = useRef<HTMLInputElement | null>(null)
    const authenticatedCalledRef = useRef(false)
    const gateVisibleCalledRef = useRef(false)

    const triggerGateVisible = () => {
        if (!gateVisibleCalledRef.current) {
            gateVisibleCalledRef.current = true
            onGateVisible?.()
        }
    }

    const triggerAuthenticated = () => {
        if (!authenticatedCalledRef.current) {
            authenticatedCalledRef.current = true
            onAuthenticated()
        }
    }

    const checkStatus = async () => {
        setState({ phase: 'checking' })
        try {
            const status = await getWebAuthStatus()
            if (!status.required || status.authenticated) {
                triggerAuthenticated()
            } else {
                triggerGateVisible()
                setState({ phase: 'login', error: null })
            }
        } catch {
            triggerGateVisible()
            setState({ phase: 'connection-error' })
        }
    }

    useEffect(() => {
        void checkStatus()
    }, [])

    useEffect(() => {
        if (
            !showAuthPanel &&
            (state.phase === 'login' || state.phase === 'connection-error')
        ) {
            const timer = setTimeout(() => {
                setShowAuthPanel(true)
            }, 300)
            return () => clearTimeout(timer)
        }
    }, [showAuthPanel, state.phase])

    useEffect(() => {
        if (state.phase !== 'login') return

        if (!showAuthPanel) {
            passwordInputRef.current?.focus()
            return
        }

        const timer = setTimeout(() => {
            passwordInputRef.current?.focus()
        }, 100)
        return () => clearTimeout(timer)
    }, [showAuthPanel, state.phase, state.phase === 'login' ? state.error : null])

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) {
            e.preventDefault()
        }
        if (submitting) return

        setSubmitting(true)
        let success = false
        try {
            success = await loginWebAuth(password)
            if (success) {
                triggerAuthenticated()
            } else {
                setState({ phase: 'login', error: 'invalid-password' })
            }
        } catch {
            triggerGateVisible()
            setState({ phase: 'connection-error' })
        } finally {
            setSubmitting(false)
            if (!success && state.phase === 'login') {
                passwordInputRef.current?.focus()
            }
        }
    }

    if (state.phase === 'checking' && !gateVisibleCalledRef.current) {
        return null
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="web-auth-dialog-title"
            data-testid="web-auth-splash-overlay"
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center select-none overflow-hidden bg-[var(--bg-app)] text-[var(--text-primary)] font-[inherit] text-[var(--ui-font-size,13px)]"
        >
            <div
                className="pointer-events-none absolute h-[320px] w-[620px] rounded-full blur-[64px] animate-pulse"
                style={{
                    background:
                        'radial-gradient(ellipse at center, color-mix(in srgb, var(--accent-blue) 18%, transparent) 0%, color-mix(in srgb, var(--accent-blue) 10%, transparent) 45%, transparent 72%)',
                }}
            />

            <div
                className={cn(
                    'relative z-10 flex flex-col items-center px-6 text-center w-full max-w-[460px] transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] font-[inherit]',
                    showAuthPanel ? '-translate-y-4 md:-translate-y-8' : 'translate-y-0',
                )}
            >
                <h1
                    id="web-auth-dialog-title"
                    data-testid="web-auth-splash-title"
                    className="m-0 text-[clamp(22px,3.8vw,34px)] tracking-tight leading-tight whitespace-nowrap select-none text-transparent bg-clip-text animate-[splash-shimmer_3s_ease-in-out_infinite] font-[inherit]"
                    style={{
                        backgroundImage:
                            'linear-gradient(115deg, var(--text-muted) 0%, var(--text-secondary) 20%, var(--text-primary) 40%, var(--accent-blue) 60%, color-mix(in srgb, var(--accent-blue) 75%, var(--text-primary)) 80%, var(--text-muted) 100%)',
                        backgroundSize: '250% 100%',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        textShadow:
                            '0 0 32px color-mix(in srgb, var(--accent-blue) 25%, transparent)',
                    }}
                >
                    {t('startup.title', 'Coding Professional Agent')}
                </h1>

                <div
                    data-testid="web-auth-panel"
                    className={cn(
                        'w-full transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] overflow-hidden',
                        showAuthPanel
                            ? 'mt-6 max-h-[600px] opacity-100 translate-y-0'
                            : 'max-h-0 opacity-0 translate-y-6 pointer-events-none',
                    )}
                >
                {state.phase === 'checking' && (
                    <div
                        role="status"
                        className="w-full flex items-center justify-center p-8 rounded-2xl bg-[var(--bg-card)] backdrop-blur-xl border border-[var(--border-subtle)] shadow-2xl"
                    >
                        <Loader2 className="size-6 animate-spin text-[var(--accent-blue)]" />
                        <span className="sr-only font-[inherit]">
                            {t('webAuth.checking', 'Checking authentication status...')}
                        </span>
                    </div>
                )}

                {state.phase === 'login' && (
                    <form
                        onSubmit={handleSubmit}
                        data-testid="web-auth-login-form"
                        className="w-full flex flex-col gap-4 p-5 rounded-2xl bg-[var(--bg-card)] backdrop-blur-xl border border-[var(--border-subtle)] shadow-2xl text-left font-[inherit]"
                    >
                        <div className="flex flex-col gap-1.5">
                            <label
                                htmlFor="web-auth-password-input"
                                className="text-[var(--text-secondary)] flex items-center gap-1.5 font-[inherit] text-[var(--ui-font-size,13px)]"
                            >
                                <Key className="size-3.5 text-[var(--accent-blue)]" />
                                {t('webAuth.password')}
                            </label>
                            <div className="relative">
                                <input
                                    id="web-auth-password-input"
                                    ref={passwordInputRef}
                                    type={showPassword ? 'text' : 'password'}
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault()
                                            void handleSubmit()
                                        }
                                    }}
                                    placeholder={t('webAuth.password.placeholder')}
                                    disabled={submitting}
                                    className="h-9 w-full pl-3 pr-9 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-lg text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-blue)] focus:ring-1 focus:ring-[var(--accent-blue)] transition-colors font-[inherit] text-[var(--ui-font-size,13px)]"
                                />
                                <button
                                    type="button"
                                    aria-label={showPassword ? t('webAuth.hidePassword') : t('webAuth.showPassword')}
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 flex size-6 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
                                >
                                    {showPassword ? (
                                        <EyeOff className="size-4" />
                                    ) : (
                                        <Eye className="size-4" />
                                    )}
                                </button>
                            </div>
                        </div>

                        {state.error === 'invalid-password' && (
                            <div
                                role="alert"
                                className="flex items-start gap-2 p-2.5 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed font-[inherit] text-[var(--ui-font-size,13px)]"
                            >
                                <AlertCircle className="size-4 shrink-0 mt-0.5 text-[var(--accent-orange)]" />
                                <span>{t('webAuth.invalidPassword')}</span>
                            </div>
                        )}

                        <div className="mt-1 pt-2 border-t border-[var(--border-subtle)]">
                            <button
                                type="submit"
                                disabled={submitting}
                                className={cn(
                                    'h-9 w-full px-4 rounded-lg flex items-center justify-center gap-1.5 transition-all shadow-md text-[var(--bg-app)] bg-[var(--accent-blue)] hover:opacity-90 active:opacity-100 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer font-[inherit] text-[var(--ui-font-size,13px)]',
                                )}
                            >
                                {submitting ? (
                                    <>
                                        <Loader2 className="size-3.5 animate-spin" />
                                        <span>{t('webAuth.signingIn')}</span>
                                    </>
                                ) : (
                                    <span>{t('webAuth.signIn')}</span>
                                )}
                            </button>
                        </div>
                    </form>
                )}

                {state.phase === 'connection-error' && (
                    <div className="w-full flex flex-col items-center gap-4 p-5 rounded-2xl bg-[var(--bg-card)] backdrop-blur-xl border border-[var(--border-subtle)] shadow-2xl text-center font-[inherit]">
                        <div
                            role="alert"
                            className="flex items-center gap-2 p-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] leading-relaxed w-full justify-center font-[inherit] text-[var(--ui-font-size,13px)]"
                        >
                            <AlertCircle className="size-4 shrink-0 text-[var(--accent-orange)]" />
                            <span>{t('webAuth.connectionError')}</span>
                        </div>
                        <button
                            type="button"
                            onClick={() => void checkStatus()}
                            className="h-9 w-full px-4 rounded-lg flex items-center justify-center gap-1.5 transition-all text-[var(--bg-app)] bg-[var(--accent-blue)] hover:opacity-90 active:opacity-100 cursor-pointer font-[inherit] text-[var(--ui-font-size,13px)]"
                        >
                            <RotateCw className="size-3.5" />
                            <span>{t('webAuth.retry')}</span>
                        </button>
                    </div>
                )}
                </div>
            </div>
        </div>
    )
}

/**
 * Ensures web authentication is completed before continuing app bootstrap.
 * In Electron environments, returns immediately without rendering or network requests.
 */
export async function waitForWebAuthentication(root: Root): Promise<void> {
    if (!isBrowserEnvironment()) return
    await new Promise<void>((resolve) => {
        root.render(
            <I18nextProvider i18n={i18n}>
                <WebAuthGate
                    onAuthenticated={resolve}
                    onGateVisible={dismissSplashScreen}
                />
            </I18nextProvider>,
        )
    })
}
