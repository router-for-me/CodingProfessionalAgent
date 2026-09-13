import { useCallback, useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
    AlertCircle,
    ArrowRight,
    Check,
    ChevronDown,
    ChevronUp,
    Eye,
    EyeOff,
    Globe,
    KeyRound,
    Loader2,
    RotateCcw,
    Server,
} from 'lucide-react'
import type { DiscoveredGateway } from '@cpa/plugin-api'
import { cn } from '@/lib/cn'
import { flushPendingPersistence } from '@/application/services/persistenceService'
import { useSettingsStore } from '@/stores/settingsStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { refreshModelCatalog } from '@/features/models/modelCatalogService'
import { useGatewayDiscovery } from '@/features/gateway/useGatewayDiscovery'
import styles from './StartupConfigCard.module.css'

export interface StartupSplashOverlayProps {
    /** Force display for testing purposes */
    forceOpen?: boolean
    /** Callback when the splash overlay is dismissed */
    onDismiss?: () => void
    /** Optional discovery function override for testing */
    discoverFn?: (timeoutMs?: number) => Promise<DiscoveredGateway[]>
}

/**
 * Startup splash screen overlay.
 * If CLIProxyAPI is not configured (or model catalog fails to load),
 * the text animation smoothly slides upward and reveals the service configuration form.
 */
export function StartupSplashOverlay({
    forceOpen,
    onDismiss,
    discoverFn,
}: StartupSplashOverlayProps = {}) {
    const { t } = useTranslation()
    const cliProxyApi = useSettingsStore((s) => s.settings.cliProxyApi)
    const setCliProxyApi = useSettingsStore((s) => s.setCliProxyApi)
    const modelCatalogStatus = useModelCatalogStore((s) => s.status)
    const modelCatalogError = useModelCatalogStore((s) => s.error)

    const {
        isDiscovering,
        gateways,
        hasDiscovered,
        triggerDiscovery,
    } = useGatewayDiscovery({ discoverFn })

    const isConfigured = Boolean(
        cliProxyApi.baseUrl.trim() && cliProxyApi.apiKey.trim(),
    )

    const [visible, setVisible] = useState(true)
    const [isFadingOut, setIsFadingOut] = useState(false)
    const [showConfig, setShowConfig] = useState(false)
    const [showPassword, setShowPassword] = useState(false)
    const [baseUrl, setBaseUrl] = useState(cliProxyApi.baseUrl || 'http://127.0.0.1:8317')
    const [apiKey, setApiKey] = useState(cliProxyApi.apiKey || '')
    const [selectedGatewayKey, setSelectedGatewayKey] = useState<string>('')
    const [hasManuallyEditedAddress, setHasManuallyEditedAddress] = useState(false)
    const [isDropdownOpen, setIsDropdownOpen] = useState(false)
    const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [isSuccess, setIsSuccess] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const apiKeyInputRef = useRef<HTMLInputElement | null>(null)
    const selectorRef = useRef<HTMLDivElement | null>(null)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const menuRef = useRef<HTMLDivElement | null>(null)

    const [menuPosition, setMenuPosition] = useState<{
        top?: number
        bottom?: number
        left: number
        width: number
        maxHeight: number
    }>({
        top: 0,
        bottom: undefined,
        left: 0,
        width: 360,
        maxHeight: 320,
    })

    const updateMenuPosition = useCallback(() => {
        const trigger = triggerRef.current
        if (!trigger || typeof window === 'undefined') return
        const triggerRect = trigger.getBoundingClientRect()
        const width = Math.min(triggerRect.width || 360, Math.max(0, window.innerWidth - 32))
        const left = Math.max(16, Math.min(triggerRect.left, window.innerWidth - width - 16))

        const spaceBelow = window.innerHeight - triggerRect.bottom - 16
        const spaceAbove = triggerRect.top - 16

        if (spaceBelow < 160 && spaceAbove > spaceBelow) {
            const availableSpace = Math.max(0, spaceAbove)
            const maxHeight = Math.min(
                320,
                availableSpace <= 60 ? availableSpace : Math.max(60, availableSpace),
            )
            setMenuPosition({
                top: undefined,
                bottom: Math.max(16, window.innerHeight - triggerRect.top + 6),
                left,
                width,
                maxHeight,
            })
        } else {
            const availableSpace = Math.max(0, spaceBelow)
            const maxHeight = Math.min(
                320,
                availableSpace <= 60 ? availableSpace : Math.max(60, availableSpace),
            )
            setMenuPosition({
                top: triggerRect.bottom + 6,
                bottom: undefined,
                left,
                width,
                maxHeight,
            })
        }
    }, [])

    // Helper to get unique gateway identifier
    const getGatewayKey = (gw: DiscoveredGateway): string => {
        return gw.baseUrl || `${gw.host}:${gw.port}`
    }

    // Trigger gateway discovery on unconfigured mount
    useEffect(() => {
        if (!isConfigured) {
            void triggerDiscovery(3000)
        }
    }, [isConfigured, triggerDiscovery])

    // Auto-select first discovered gateway if not in manual mode and address has not been manually edited
    useEffect(() => {
        if (hasManuallyEditedAddress || selectedGatewayKey === 'manual') {
            return
        }
        if (gateways.length > 0) {
            const stillExists = gateways.some((g) => getGatewayKey(g) === selectedGatewayKey)
            if (!stillExists) {
                const firstGw = gateways[0]
                const key = getGatewayKey(firstGw)
                setSelectedGatewayKey(key)
                setBaseUrl(firstGw.baseUrl)
                setCliProxyApi({ baseUrl: firstGw.baseUrl })
            }
        }
    }, [gateways, selectedGatewayKey, hasManuallyEditedAddress, setCliProxyApi])

    // Initialize or reset highlighted index when dropdown opens/closes
    useEffect(() => {
        if (isDropdownOpen) {
            if (selectedGatewayKey === 'manual') {
                setHighlightedIndex(gateways.length)
            } else {
                const idx = gateways.findIndex((g) => getGatewayKey(g) === selectedGatewayKey)
                setHighlightedIndex(idx >= 0 ? idx : 0)
            }
        } else {
            setHighlightedIndex(-1)
        }
    }, [isDropdownOpen, selectedGatewayKey, gateways])

    // Scroll highlighted option into view on keyboard navigation
    useEffect(() => {
        if (!isDropdownOpen || highlightedIndex < 0) return
        const activeId =
            highlightedIndex === gateways.length
                ? 'gateway-option-manual'
                : `gateway-option-${highlightedIndex}`
        const el = document.getElementById(activeId)
        if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest' })
        }
    }, [isDropdownOpen, highlightedIndex, gateways.length])

    // Update position and listen for outside clicks, Escape, Tab, window resize/scroll
    useEffect(() => {
        if (!isDropdownOpen) return

        updateMenuPosition()

        const handleClickOutside = (e: Event) => {
            const target = e.target as Node
            if (
                menuRef.current &&
                !menuRef.current.contains(target) &&
                triggerRef.current &&
                !triggerRef.current.contains(target)
            ) {
                setIsDropdownOpen(false)
            }
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                setIsDropdownOpen(false)
                triggerRef.current?.focus()
                return
            }
            if (e.key === 'Tab') {
                setIsDropdownOpen(false)
                return
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        document.addEventListener('pointerdown', handleClickOutside)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', updateMenuPosition)
        window.addEventListener('scroll', updateMenuPosition, true)

        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('pointerdown', handleClickOutside)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', updateMenuPosition)
            window.removeEventListener('scroll', updateMenuPosition, true)
        }
    }, [isDropdownOpen, updateMenuPosition])

    useEffect(() => {
        if (isFadingOut) {
            setIsDropdownOpen(false)
        }
    }, [isFadingOut])

    const selectedGateway =
        gateways.find((g) => getGatewayKey(g) === selectedGatewayKey) ||
        (gateways.length > 0 && selectedGatewayKey !== 'manual' ? gateways[0] : null)

    const isAuthRequired =
        selectedGatewayKey === 'manual' || (selectedGateway ? selectedGateway.authRequired : true)

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
        setHasManuallyEditedAddress(true)
        setSelectedGatewayKey('manual')
        setBaseUrl(newBaseUrl)
        setCliProxyApi({ baseUrl: newBaseUrl })
    }

    const handleApiKeyChange = (newApiKey: string) => {
        setApiKey(newApiKey)
        setCliProxyApi({ apiKey: newApiKey })
    }

    const handleSelectGateway = (gw: DiscoveredGateway) => {
        setHasManuallyEditedAddress(false)
        const key = getGatewayKey(gw)
        setSelectedGatewayKey(key)
        setBaseUrl(gw.baseUrl)
        setCliProxyApi({ baseUrl: gw.baseUrl })
        setIsDropdownOpen(false)
        if (gw.authRequired) {
            setTimeout(() => {
                apiKeyInputRef.current?.focus()
            }, 50)
        }
    }

    const handleSelectManual = () => {
        setHasManuallyEditedAddress(true)
        setSelectedGatewayKey('manual')
        setIsDropdownOpen(false)
        setTimeout(() => {
            document.getElementById('startup-base-url')?.focus()
        }, 50)
    }

    const handleSelectorKeyDown = (e: React.KeyboardEvent) => {
        const totalOptions = gateways.length + 1
        if (!isDropdownOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                updateMenuPosition()
                setIsDropdownOpen(true)
            }
            return
        }

        if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setIsDropdownOpen(false)
            triggerRef.current?.focus()
            return
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlightedIndex((prev) => (prev + 1) % totalOptions)
            return
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlightedIndex((prev) => (prev - 1 + totalOptions) % totalOptions)
            return
        }

        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (highlightedIndex >= 0 && highlightedIndex < gateways.length) {
                handleSelectGateway(gateways[highlightedIndex])
            } else if (highlightedIndex === gateways.length) {
                handleSelectManual()
            }
            setIsDropdownOpen(false)
            triggerRef.current?.focus()
            return
        }

        if (e.key === 'Tab') {
            setIsDropdownOpen(false)
        }
    }

    const handleRescan = (e?: React.MouseEvent) => {
        e?.preventDefault()
        e?.stopPropagation()
        void triggerDiscovery(3000)
    }

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault()
        if (isSubmitting) return

        const trimmedBaseUrl = baseUrl.trim() || 'http://127.0.0.1:8317'
        let trimmedApiKey = apiKey.trim()

        if (isAuthRequired && !trimmedApiKey) {
            setError(t('startup.apiKeyRequired'))
            apiKeyInputRef.current?.focus()
            return
        }

        // For gateways where auth is not required, store a dummy fallback API key if left blank
        // so that CLIProxyAPI and model catalog validation succeed and isConfigured remains true
        if (!isAuthRequired && !trimmedApiKey) {
            trimmedApiKey = 'no-auth'
            setApiKey('no-auth')
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
                            ? 'mt-6 max-h-[850px] opacity-100 translate-y-0'
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
                        {/* Scanning Indicator */}
                        {isDiscovering && (
                            <div
                                data-testid="gateway-scanning-indicator"
                                className={styles.scanningIndicator}
                            >
                                <Loader2 className="size-3.5 animate-spin text-[var(--accent-blue)]" aria-hidden="true" />
                                <span>{t('startup.scanningGateways')}</span>
                            </div>
                        )}

                        {/* Discovered Gateways Selector */}
                        {gateways.length > 0 ? (
                            <div className={styles.field}>
                                <div className={styles.fieldHeader}>
                                    <label className={styles.label} id="gateway-selector-label">
                                        {t('startup.gatewaysFound')}
                                    </label>
                                    <button
                                        type="button"
                                        data-testid="gateway-rescan-btn"
                                        className={styles.rescanButton}
                                        onClick={handleRescan}
                                        disabled={isDiscovering}
                                        title={t('startup.rescan')}
                                    >
                                        <RotateCcw
                                            className={cn('size-3', isDiscovering && 'animate-spin')}
                                            aria-hidden="true"
                                        />
                                        <span>{t('startup.rescan')}</span>
                                    </button>
                                </div>

                                <div
                                    ref={selectorRef}
                                    className={styles.gatewaySelectorWrapper}
                                    onKeyDown={handleSelectorKeyDown}
                                >
                                    <button
                                        ref={triggerRef}
                                        type="button"
                                        role="combobox"
                                        aria-label={t('startup.gatewaysFound')}
                                        aria-expanded={isDropdownOpen}
                                        aria-haspopup="listbox"
                                        aria-controls="gateway-selector-menu"
                                        aria-activedescendant={
                                            isDropdownOpen && highlightedIndex >= 0
                                                ? (highlightedIndex === gateways.length
                                                    ? 'gateway-option-manual'
                                                    : `gateway-option-${highlightedIndex}`)
                                                : undefined
                                        }
                                        data-testid="gateway-selector"
                                        onClick={() => {
                                            if (!isDropdownOpen) {
                                                updateMenuPosition()
                                            }
                                            setIsDropdownOpen(!isDropdownOpen)
                                        }}
                                        className={styles.gatewayTrigger}
                                    >
                                        <div className={styles.gatewayTriggerContent}>
                                            {selectedGatewayKey === 'manual' || !selectedGateway ? (
                                                <>
                                                    <Globe className={styles.fieldIcon} aria-hidden="true" />
                                                    <div className={styles.gatewayTriggerMain}>
                                                        <span className={styles.gatewayName}>
                                                            {t('startup.manualInputOption')}
                                                        </span>
                                                    </div>
                                                </>
                                            ) : (
                                                <>
                                                    <Server className={styles.fieldIcon} aria-hidden="true" />
                                                    <div className={styles.gatewayTriggerMain}>
                                                        <div className={styles.gatewayNameRow}>
                                                            <span className={styles.gatewayName}>
                                                                {selectedGateway.instanceName}
                                                            </span>
                                                        </div>
                                                        <span className={styles.gatewayAddress}>
                                                            {selectedGateway.baseUrl ||
                                                                `${selectedGateway.primaryAddress || selectedGateway.host}:${selectedGateway.port}`}
                                                        </span>
                                                    </div>
                                                    <div className={styles.gatewayBadges}>
                                                        <span className={styles.productBadge}>
                                                            {selectedGateway.product || 'generic'}
                                                        </span>
                                                        <span
                                                            className={cn(
                                                                styles.authBadge,
                                                                selectedGateway.authRequired
                                                                    ? styles.authBadgeRequired
                                                                    : styles.authBadgeNone,
                                                            )}
                                                        >
                                                            {selectedGateway.authRequired
                                                                ? t('startup.authRequiredBadge')
                                                                : t('startup.noAuthBadge')}
                                                        </span>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                        {isDropdownOpen ? (
                                            <ChevronUp
                                                className="size-4 shrink-0 text-[var(--text-muted)]"
                                                aria-hidden="true"
                                            />
                                        ) : (
                                            <ChevronDown
                                                className="size-4 shrink-0 text-[var(--text-muted)]"
                                                aria-hidden="true"
                                            />
                                        )}
                                    </button>

                                    {isDropdownOpen && typeof document !== 'undefined'
                                        ? createPortal(
                                              <div
                                                  ref={menuRef}
                                                  id="gateway-selector-menu"
                                                  role="listbox"
                                                  data-testid="gateway-selector-menu"
                                                  tabIndex={-1}
                                                  aria-label={t('startup.gatewaysFound')}
                                                  style={{
                                                      top: menuPosition.top !== undefined ? `${menuPosition.top}px` : undefined,
                                                      bottom: menuPosition.bottom !== undefined ? `${menuPosition.bottom}px` : undefined,
                                                      left: `${menuPosition.left}px`,
                                                      width: `${menuPosition.width}px`,
                                                      maxHeight: `${menuPosition.maxHeight}px`,
                                                      maxWidth: 'calc(100vw - 32px)',
                                                  }}
                                                  className={cn(
                                                      styles.gatewayMenu,
                                                      'fixed z-[10001] overflow-y-auto',
                                                  )}
                                              >
                                                  {gateways.map((gw, idx) => {
                                                      const key = getGatewayKey(gw)
                                                      const isSelected =
                                                          key === selectedGatewayKey ||
                                                          (!selectedGatewayKey && idx === 0)
                                                      const isHighlighted = highlightedIndex === idx
                                                      return (
                                                          <button
                                                              key={key}
                                                              id={`gateway-option-${idx}`}
                                                              type="button"
                                                              role="option"
                                                              aria-selected={isSelected}
                                                              data-highlighted={isHighlighted || undefined}
                                                              data-testid={`gateway-option-${idx}`}
                                                              onClick={() => handleSelectGateway(gw)}
                                                              onMouseEnter={() => setHighlightedIndex(idx)}
                                                              className={styles.gatewayOption}
                                                          >
                                                              <div className={styles.gatewayTriggerContent}>
                                                                  <Server
                                                                      className={styles.fieldIcon}
                                                                      aria-hidden="true"
                                                                  />
                                                                  <div className={styles.gatewayTriggerMain}>
                                                                      <div className={styles.gatewayNameRow}>
                                                                          <span className={styles.gatewayName}>
                                                                              {gw.instanceName}
                                                                          </span>
                                                                      </div>
                                                                      <span className={styles.gatewayAddress}>
                                                                          {gw.baseUrl ||
                                                                              `${gw.primaryAddress || gw.host}:${gw.port}`}
                                                                      </span>
                                                                  </div>
                                                                  <div className={styles.gatewayBadges}>
                                                                      <span className={styles.productBadge}>
                                                                          {gw.product || 'generic'}
                                                                      </span>
                                                                      <span
                                                                          className={cn(
                                                                              styles.authBadge,
                                                                              gw.authRequired
                                                                                  ? styles.authBadgeRequired
                                                                                  : styles.authBadgeNone,
                                                                          )}
                                                                      >
                                                                          {gw.authRequired
                                                                              ? t('startup.authRequiredBadge')
                                                                              : t('startup.noAuthBadge')}
                                                                      </span>
                                                                  </div>
                                                              </div>
                                                              {isSelected && (
                                                                  <Check
                                                                      className="size-4 shrink-0 text-[var(--accent-blue)]"
                                                                      aria-hidden="true"
                                                                  />
                                                              )}
                                                          </button>
                                                      )
                                                  })}

                                                  <div className={styles.gatewayDivider} />

                                                  <button
                                                      id="gateway-option-manual"
                                                      type="button"
                                                      role="option"
                                                      aria-selected={selectedGatewayKey === 'manual'}
                                                      data-highlighted={highlightedIndex === gateways.length || undefined}
                                                      data-testid="gateway-option-manual"
                                                      onClick={handleSelectManual}
                                                      onMouseEnter={() => setHighlightedIndex(gateways.length)}
                                                      className={styles.gatewayOption}
                                                  >
                                                      <div className={styles.gatewayTriggerContent}>
                                                          <Globe className={styles.fieldIcon} aria-hidden="true" />
                                                          <div className={styles.gatewayTriggerMain}>
                                                              <span className={styles.gatewayName}>
                                                                  {t('startup.manualInputOption')}
                                                              </span>
                                                          </div>
                                                      </div>
                                                      {selectedGatewayKey === 'manual' && (
                                                          <Check
                                                              className="size-4 shrink-0 text-[var(--accent-blue)]"
                                                              aria-hidden="true"
                                                          />
                                                      )}
                                                  </button>
                                              </div>,
                                              document.body,
                                          )
                                        : null}
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* Notice when no gateways discovered */}
                                {hasDiscovered && !isDiscovering && (
                                    <div
                                        data-testid="gateway-not-found-notice"
                                        className={styles.noticeRow}
                                    >
                                        <span className={styles.noticeText}>
                                            {t('startup.noGatewaysFound')}
                                        </span>
                                        <button
                                            type="button"
                                            data-testid="gateway-rescan-btn"
                                            className={styles.rescanButton}
                                            onClick={handleRescan}
                                            disabled={isDiscovering}
                                        >
                                            <RotateCcw className="size-3" aria-hidden="true" />
                                            <span>{t('startup.rescan')}</span>
                                        </button>
                                    </div>
                                )}
                            </>
                        )}

                        {/* Service Address Manual Input (Shown if no gateways found or manual input selected) */}
                        {(gateways.length === 0 || selectedGatewayKey === 'manual') && (
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
                        )}

                        {/* API Key */}
                        <div className={styles.field}>
                            <label htmlFor="startup-api-key" className={styles.label}>
                                {t('startup.apiKey')}
                                {!isAuthRequired && (
                                    <span className={styles.optionalBadge}>
                                        ({t('startup.apiKeyOptional')})
                                    </span>
                                )}
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
                                    placeholder={
                                        isAuthRequired
                                            ? t('settings.connections.apiKey.placeholder')
                                            : t('startup.apiKeyOptional')
                                    }
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
