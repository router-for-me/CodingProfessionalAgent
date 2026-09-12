import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowRight, Check, Eye, EyeOff, Globe, KeyRound, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { flushPendingPersistence } from '@/application/services/persistenceService'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { refreshModelCatalog } from '@/features/models/modelCatalogService'
import styles from './StartupConfigCard.module.css'

export interface StartupSplashOverlayProps {
    /** Force display for testing purposes */
    forceOpen?: boolean
    /** Callback when the splash overlay is dismissed */
    onDismiss?: () => void
}

/**
 * Startup splash screen overlay.
 * If CLIProxyAPI is not configured (or model catalog fails to load),
 * the text animation smoothly slides upward and reveals the service configuration form.
 */
export function StartupSplashOverlay({
    forceOpen,
    onDismiss,
}: StartupSplashOverlayProps = {}) {
    const { t } = useTranslation()
    const cliProxyApi = useSettingsStore((s) => s.settings.cliProxyApi)
    const setCliProxyApi = useSettingsStore((s) => s.setCliProxyApi)
    const modelCatalogStatus = useModelCatalogStore((s) => s.status)
    const modelCatalogError = useModelCatalogStore((s) => s.error)

    const isConfigured = Boolean(
        cliProxyApi.baseUrl.trim() && cliProxyApi.apiKey.trim(),
    )

    const [visible, setVisible] = useState(true)
    const [isFadingOut, setIsFadingOut] = useState(false)
    const [showConfig, setShowConfig] = useState(false)
    const [showPassword, setShowPassword] = useState(false)
    const [baseUrl, setBaseUrl] = useState(cliProxyApi.baseUrl || 'http://127.0.0.1:8317')
    const [apiKey, setApiKey] = useState(cliProxyApi.apiKey || '')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSuccess, setIsSuccess] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const apiKeyInputRef = useRef<HTMLInputElement | null>(null)

    // Sync form with settings if updated externally
    useEffect(() => {
        if (!baseUrl && cliProxyApi.baseUrl) {
            setBaseUrl(cliProxyApi.baseUrl)
        }
        if (!apiKey && cliProxyApi.apiKey) {
            setApiKey(cliProxyApi.apiKey)
        }
    }, [cliProxyApi.baseUrl, cliProxyApi.apiKey, baseUrl, apiKey])

    const formatErrorMessage = (detailError?: string | null) => {
        const baseMsg = t('startup.failedToLoadModels')
        if (!detailError || detailError === baseMsg) return baseMsg
        return `${baseMsg} (${detailError})`
    }

    // Detect unconfigured state or model loading error
    useEffect(() => {
        if (!isConfigured) {
            const timer = setTimeout(() => {
                setShowConfig(true)
            }, 800)
            return () => clearTimeout(timer)
        }
    }, [isConfigured])

    useEffect(() => {
        if (modelCatalogStatus === 'error') {
            setShowConfig(true)
            setIsSuccess(false)
            setError(formatErrorMessage(modelCatalogError))
        }
    }, [modelCatalogStatus, modelCatalogError])

    // Auto-dismiss if configured and model loading succeeds
    useEffect(() => {
        if (isConfigured && modelCatalogStatus === 'ready' && !forceOpen) {
            const timer = setTimeout(() => {
                setIsFadingOut(true)
                const fadeTimer = setTimeout(() => {
                    setVisible(false)
                    onDismiss?.()
                }, 500)
                return () => clearTimeout(fadeTimer)
            }, 300)
            return () => clearTimeout(timer)
        }
    }, [isConfigured, modelCatalogStatus, forceOpen, onDismiss])

    // Auto-focus API key input when config form appears
    useEffect(() => {
        if (showConfig && apiKeyInputRef.current) {
            const timer = setTimeout(() => {
                apiKeyInputRef.current?.focus()
            }, 400)
            return () => clearTimeout(timer)
        }
    }, [showConfig])

    const handleBaseUrlChange = (newBaseUrl: string) => {
        setBaseUrl(newBaseUrl)
        setCliProxyApi({ baseUrl: newBaseUrl })
    }

    const handleApiKeyChange = (newApiKey: string) => {
        setApiKey(newApiKey)
        setCliProxyApi({ apiKey: newApiKey })
    }

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault()
        if (isSubmitting) return

        const trimmedBaseUrl = baseUrl.trim() || 'http://127.0.0.1:8317'
        const trimmedApiKey = apiKey.trim()

        if (!trimmedApiKey) {
            setError(t('startup.apiKeyRequired'))
            apiKeyInputRef.current?.focus()
            return
        }

        setIsSubmitting(true)
        setError(null)

        try {
            setCliProxyApi({
                baseUrl: trimmedBaseUrl,
                apiKey: trimmedApiKey,
            })
            // Immediately flush settings to disk so they are persisted even if process terminates
            try {
                await flushPendingPersistence()
            } catch {
                // Persistence errors must not prevent connection attempt
            }

            await refreshModelCatalog({
                baseUrl: trimmedBaseUrl,
                apiKey: trimmedApiKey,
            })

            const currentStatus = useModelCatalogStore.getState().status
            if (currentStatus === 'ready') {
                setIsSuccess(true)
                try {
                    await flushPendingPersistence()
                } catch {
                    // ignore
                }
                setTimeout(() => {
                    setIsFadingOut(true)
                    setTimeout(() => {
                        setVisible(false)
                        onDismiss?.()
                    }, 500)
                }, 600)
            } else {
                setIsSuccess(false)
                const currentError = useModelCatalogStore.getState().error
                setError(formatErrorMessage(currentError))
                apiKeyInputRef.current?.focus()
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            setIsSubmitting(false)
        }
    }

    if (!visible && !forceOpen) {
        return null
    }

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={t('startup.title')}
            data-testid="startup-splash-overlay"
            className={cn(
                'fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#06070f] select-none transition-all duration-500 ease-out',
                isFadingOut ? 'opacity-0 pointer-events-none scale-[1.02]' : 'opacity-100 scale-100',
            )}
        >
            {/* Ambient glowing background */}
            <div
                className="pointer-events-none absolute h-[320px] w-[620px] rounded-full blur-[64px] animate-pulse"
                style={{
                    background:
                        'radial-gradient(ellipse at center, rgba(56, 189, 248, 0.18) 0%, rgba(37, 99, 235, 0.1) 45%, transparent 72%)',
                }}
            />

            {/* Content Container */}
            <div
                className={cn(
                    'relative z-10 flex flex-col items-center px-6 text-center w-full max-w-[460px] transition-transform duration-700 cubic-bezier(0.16, 1, 0.3, 1)',
                    showConfig ? '-translate-y-4 md:-translate-y-8' : 'translate-y-0',
                )}
            >
                {/* Logo Text Animation */}
                <h1
                    data-testid="startup-splash-title"
                    className="m-0 text-[clamp(22px,3.8vw,34px)] font-bold tracking-tight leading-tight whitespace-nowrap select-none text-transparent bg-clip-text animate-[splash-shimmer_3s_ease-in-out_infinite]"
                    style={{
                        fontFamily:
                            'Inter, "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
                        backgroundImage:
                            'linear-gradient(115deg, #94a3b8 0%, #cbd5e1 20%, #ffffff 40%, #38bdf8 60%, #60a5fa 80%, #94a3b8 100%)',
                        backgroundSize: '250% 100%',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        textShadow: '0 0 32px rgba(56, 189, 248, 0.25)',
                    }}
                >
                    {t('startup.title')}
                </h1>

                {/* Configuration Form */}
                <div
                    className={cn(
                        'w-full transition-all duration-700 cubic-bezier(0.16, 1, 0.3, 1) overflow-hidden',
                        showConfig
                            ? 'mt-6 max-h-[600px] opacity-100 translate-y-0'
                            : 'max-h-0 opacity-0 translate-y-6 pointer-events-none',
                    )}
                >
                    <form
                        onSubmit={handleSubmit}
                        data-testid="startup-config-form"
                        className={styles.card}
                        aria-busy={isSubmitting}
                        aria-describedby={error ? 'startup-config-error' : undefined}
                    >
                        {/* Service Address */}
                        <div className={styles.field}>
                            <label htmlFor="startup-base-url" className={styles.label}>
                                {t('startup.serviceAddress')}
                            </label>
                            <div className={styles.inputWell}>
                                <Globe className={styles.fieldIcon} aria-hidden="true" />
                                <input
                                    id="startup-base-url"
                                    data-testid="startup-base-url-input"
                                    type="text"
                                    inputMode="url"
                                    autoComplete="url"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    value={baseUrl}
                                    onChange={(e) => handleBaseUrlChange(e.target.value)}
                                    placeholder="http://127.0.0.1:8317"
                                    className={styles.input}
                                />
                            </div>
                        </div>

                        {/* API Key */}
                        <div className={styles.field}>
                            <label htmlFor="startup-api-key" className={styles.label}>
                                {t('startup.apiKey')}
                            </label>
                            <div className={styles.inputWell}>
                                <KeyRound className={styles.fieldIcon} aria-hidden="true" />
                                <input
                                    id="startup-api-key"
                                    data-testid="startup-api-key-input"
                                    ref={apiKeyInputRef}
                                    type={showPassword ? 'text' : 'password'}
                                    autoComplete="current-password"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    value={apiKey}
                                    onChange={(e) => handleApiKeyChange(e.target.value)}
                                    placeholder={t('settings.connections.apiKey.placeholder')}
                                    className={styles.input}
                                />
                                <button
                                    type="button"
                                    aria-label={t(showPassword ? 'startup.hideApiKey' : 'startup.showApiKey')}
                                    aria-controls="startup-api-key"
                                    aria-pressed={showPassword}
                                    onClick={() => setShowPassword(!showPassword)}
                                    className={styles.visibilityButton}
                                >
                                    {showPassword ? (
                                        <EyeOff aria-hidden="true" />
                                    ) : (
                                        <Eye aria-hidden="true" />
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Error Message Display */}
                        {error && (
                            <div
                                id="startup-config-error"
                                role="alert"
                                data-testid="startup-error-banner"
                                className={styles.error}
                            >
                                <AlertCircle aria-hidden="true" />
                                <span>{error}</span>
                            </div>
                        )}

                        {/* Action Buttons */}
                        <div className={styles.actions}>
                            <button
                                type="submit"
                                data-testid="startup-save-connect-btn"
                                disabled={isSubmitting || isSuccess}
                                className={styles.connectButton}
                                data-success={isSuccess || undefined}
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                                        <span>{t('startup.connecting')}</span>
                                    </>
                                ) : isSuccess ? (
                                    <>
                                        <Check className="size-3.5" aria-hidden="true" />
                                        <span>{t('startup.connected')}</span>
                                    </>
                                ) : (
                                    <>
                                        <span>{t('startup.saveAndConnect')}</span>
                                        <ArrowRight className="size-3.5" aria-hidden="true" />
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    )
}
