import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
    Check,
    ChevronDown,
    ChevronUp,
    Copy,
    ExternalLink,
    Loader2,
    Radar,
    RefreshCw,
    Server,
    cn,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    GatewayDiscoveryServiceToken,
    SettingsServiceToken,
    UiServiceToken,
    WebServerServiceToken,
    type CliProxyApiSettings,
    type DiscoveredGateway,
    type WebServerSettings,
    type WebServerStatus,
} from '@cpa/plugin-api'
import { isBrowserEnvironment } from '../utils/platform.js'
import {
    SettingsCard,
    SettingsPasswordInput,
    SettingsPortInput,
    SettingsRow,
    SettingsSection,
    SettingsTextInput,
    ToggleSwitch,
} from './SettingsControls.js'

const DEFAULT_WEBSERVER_SETTINGS: WebServerSettings = {
    enabled: false,
    host: '127.0.0.1',
    port: 18080,
    password: '',
}

export function ConnectionsSection() {
    const { t } = useTranslation()
    const uiService = useHostService(UiServiceToken)
    const settingsService = useHostService(SettingsServiceToken)
    const webServerService = useHostService(WebServerServiceToken)
    const settings = useSettings()

    const pushToast = (msg: string) => uiService?.pushToast(msg)

    const cliProxyApi: CliProxyApiSettings = settings.cliProxyApi ?? { baseUrl: '', apiKey: '' }
    const setCliProxyApi = (partial: Partial<CliProxyApiSettings>) =>
        settingsService?.setCliProxyApi?.(partial)

    const webServer: WebServerSettings = settings.webServer ?? DEFAULT_WEBSERVER_SETTINGS
    const setWebServer = (partial: Partial<WebServerSettings>) =>
        settingsService?.setWebServer?.(partial)

    const isBrowser = isBrowserEnvironment()

    const gatewayDiscoveryService = useHostService(GatewayDiscoveryServiceToken)
    const [isDiscovering, setIsDiscovering] = useState(false)
    const [discoveredGateways, setDiscoveredGateways] = useState<DiscoveredGateway[]>([])
    const [discoveryError, setDiscoveryError] = useState<string | null>(null)
    const [isMenuOpen, setIsMenuOpen] = useState(false)
    const [hasScanned, setHasScanned] = useState(false)
    const [highlightedIndex, setHighlightedIndex] = useState<number>(-1)

    const discoveryContainerRef = useRef<HTMLDivElement>(null)
    const discoverButtonRef = useRef<HTMLButtonElement>(null)
    const toggleButtonRef = useRef<HTMLButtonElement>(null)
    const lastTriggerRef = useRef<HTMLButtonElement | null>(null)
    const rescanButtonRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const listboxRef = useRef<HTMLDivElement>(null)
    const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

    const [menuPosition, setMenuPosition] = useState<{
        top?: number
        bottom?: number
        left: number
        maxHeight: number
    }>({
        top: 0,
        bottom: undefined,
        left: 0,
        maxHeight: 320,
    })

    const returnFocusToTrigger = useCallback(() => {
        const trigger =
            lastTriggerRef.current ?? toggleButtonRef.current ?? discoverButtonRef.current
        trigger?.focus()
    }, [])

    const closeMenu = useCallback(
        (shouldReturnFocus = true) => {
            setIsMenuOpen(false)
            setHighlightedIndex(-1)
            if (shouldReturnFocus) {
                returnFocusToTrigger()
            }
        },
        [returnFocusToTrigger],
    )

    const handleSelectGateway = useCallback(
        (gw: DiscoveredGateway) => {
            const nextUrl =
                gw.baseUrl || `http://${gw.primaryAddress || gw.host}:${gw.port}`
            setCliProxyApi({ baseUrl: nextUrl })
            closeMenu(true)
        },
        [closeMenu, setCliProxyApi],
    )

    const updateMenuPosition = useCallback(() => {
        const el = discoveryContainerRef.current ?? discoverButtonRef.current
        if (!el || typeof window === 'undefined') return
        const triggerRect = el.getBoundingClientRect()
        const menuWidth = Math.min(360, Math.max(0, window.innerWidth - 32))
        const left = Math.max(16, Math.min(triggerRect.left, window.innerWidth - menuWidth - 16))

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
                maxHeight,
            })
        }
    }, [])

    const handleDiscover = async () => {
        if (isDiscovering) return
        if (!gatewayDiscoveryService) {
            pushToast(t('settings.connections.discovery.unavailable'))
            return
        }
        setIsDiscovering(true)
        setDiscoveryError(null)
        try {
            const results = await gatewayDiscoveryService.discover(3000)
            const gws = results || []
            setDiscoveredGateways(gws)
            setHasScanned(true)
            const selectedIdx = gws.findIndex((gw) => {
                const targetUrl =
                    gw.baseUrl || `http://${gw.primaryAddress || gw.host}:${gw.port}`
                return targetUrl === cliProxyApi.baseUrl
            })
            setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0)
            updateMenuPosition()
            setIsMenuOpen(true)
        } catch (err: unknown) {
            setDiscoveredGateways([])
            setHasScanned(true)
            setHighlightedIndex(-1)
            setDiscoveryError((err as Error)?.message || String(err))
            updateMenuPosition()
            setIsMenuOpen(true)
        } finally {
            setIsDiscovering(false)
        }
    }

    const handleNavigationKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Tab') {
                closeMenu(false)
                return
            }

            if (e.key === 'Escape') {
                e.preventDefault()
                closeMenu(true)
                return
            }

            const count = discoveredGateways.length
            if (count === 0) return

            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setHighlightedIndex((prev) => (prev + 1) % count)
                return
            }

            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setHighlightedIndex((prev) => (prev <= 0 ? count - 1 : prev - 1))
                return
            }

            if (e.key === 'Enter' || e.key === ' ') {
                if (
                    rescanButtonRef.current &&
                    rescanButtonRef.current.contains(e.target as Node)
                ) {
                    return
                }
                if (
                    toggleButtonRef.current &&
                    toggleButtonRef.current.contains(e.target as Node)
                ) {
                    return
                }
                if (
                    discoverButtonRef.current &&
                    discoverButtonRef.current.contains(e.target as Node)
                ) {
                    return
                }
                e.preventDefault()
                if (highlightedIndex >= 0 && highlightedIndex < count) {
                    handleSelectGateway(discoveredGateways[highlightedIndex])
                }
            }
        },
        [closeMenu, discoveredGateways, handleSelectGateway, highlightedIndex],
    )

    useEffect(() => {
        if (highlightedIndex >= 0 && optionRefs.current[highlightedIndex]) {
            optionRefs.current[highlightedIndex]?.scrollIntoView?.({ block: 'nearest' })
        }
    }, [highlightedIndex])

    useEffect(() => {
        if (isMenuOpen) {
            if (discoveredGateways.length > 0 && listboxRef.current) {
                listboxRef.current.focus()
            } else if (menuRef.current) {
                menuRef.current.focus()
            }
        }
    }, [isMenuOpen, discoveredGateways.length])

    const closeMenuRef = useRef(closeMenu)
    closeMenuRef.current = closeMenu

    useEffect(() => {
        if (!isMenuOpen) return
        updateMenuPosition()

        const handleClickOutside = (e: MouseEvent) => {
            if (
                menuRef.current &&
                !menuRef.current.contains(e.target as Node) &&
                discoveryContainerRef.current &&
                !discoveryContainerRef.current.contains(e.target as Node)
            ) {
                closeMenuRef.current(false)
            }
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                closeMenuRef.current(true)
                return
            }
            if (e.key === 'Tab') {
                closeMenuRef.current(false)
                return
            }
        }

        document.addEventListener('mousedown', handleClickOutside)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', updateMenuPosition)
        window.addEventListener('scroll', updateMenuPosition, true)
        return () => {
            document.removeEventListener('mousedown', handleClickOutside)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', updateMenuPosition)
            window.removeEventListener('scroll', updateMenuPosition, true)
        }
    }, [isMenuOpen, updateMenuPosition])

    const [copied, setCopied] = useState(false)
    const [serverStatus, setServerStatus] = useState<WebServerStatus>({
        running: false,
        host: webServer.host,
        port: webServer.port,
        url: '',
    })

    useEffect(() => {
        if (isBrowser || !webServerService) return
        let active = true
        webServerService
            .getStatus()
            .then((status) => {
                if (active && status) {
                    setServerStatus(status)
                }
            })
            .catch((err: unknown) => {
                if (active) {
                    setServerStatus({
                        running: false,
                        host: webServer.host,
                        port: webServer.port,
                        url: '',
                        error: (err as Error)?.message || String(err),
                    })
                }
            })
        return () => {
            active = false
        }
    }, [isBrowser, webServerService])

    const getWebServerStartConfig = () => {
        const current = settings.webServer ?? DEFAULT_WEBSERVER_SETTINGS
        return {
            host: current.host,
            port: current.port,
            password: current.password,
        }
    }

    const handleWebServerFieldChange = async (
        patch: Partial<{ host: string; port: number; password: string }>,
    ) => {
        const isRunningOrEnabled =
            serverStatus.running || Boolean(settings.webServer?.enabled ?? webServer.enabled)

        setWebServer({ ...patch, enabled: false })

        const nextHost = patch.host ?? webServer.host
        const nextPort = patch.port ?? webServer.port

        if (isRunningOrEnabled && webServerService) {
            try {
                const status = await webServerService.stop()
                setServerStatus({
                    ...status,
                    host: nextHost,
                    port: nextPort,
                })
            } catch (err: unknown) {
                setServerStatus({
                    running: false,
                    host: nextHost,
                    port: nextPort,
                    url: '',
                    error: (err as Error)?.message || String(err),
                })
            }
        } else {
            setServerStatus((prev) => ({
                ...prev,
                running: false,
                host: nextHost,
                port: nextPort,
                error: undefined,
            }))
        }
    }

    const handleToggleEnabled = async (enabled: boolean) => {
        setWebServer({ enabled })
        const current = getWebServerStartConfig()
        if (!webServerService) return
        try {
            if (enabled) {
                const status = await webServerService.start(current)
                setServerStatus(status)
            } else {
                const status = await webServerService.stop()
                setServerStatus(status)
            }
        } catch (err: unknown) {
            setServerStatus({
                running: false,
                host: current.host,
                port: current.port,
                url: '',
                error: (err as Error)?.message || String(err),
            })
        }
    }

    const handleHostChange = (host: string) => {
        if (host === webServer.host) return
        void handleWebServerFieldChange({ host })
    }

    const handlePortChange = (port: number) => {
        if (port === webServer.port) return
        void handleWebServerFieldChange({ port })
    }

    const handlePasswordChange = (password: string) => {
        if (password === webServer.password) return
        void handleWebServerFieldChange({ password })
    }

    const handleOpenInBrowser = () => {
        const targetUrl = serverStatus.url || `http://${webServer.host}:${webServer.port}`
        if (typeof window !== 'undefined') {
            window.open(targetUrl, '_blank')
        }
    }

    const handleCopyLink = async () => {
        const targetUrl = serverStatus.url || `http://${webServer.host}:${webServer.port}`
        try {
            if (uiService?.writeClipboard) {
                await uiService.writeClipboard(targetUrl)
            } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
                await navigator.clipboard.writeText(targetUrl)
            }
            setCopied(true)
            pushToast(t('settings.connections.webServer.copied'))
            setTimeout(() => setCopied(false), 2000)
        } catch {
            pushToast(t('session.copyFailed'))
        }
    }

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.connections.title')}
            </h1>

            <SettingsSection title={t('settings.connections.section')}>
                <SettingsCard>
                    <SettingsRow
                        title={t('settings.connections.baseUrl')}
                        description={t('settings.connections.baseUrl.desc')}
                        control={
                            <div
                                className="relative flex items-center gap-2"
                                ref={discoveryContainerRef}
                                data-testid="gateway-discovery-container"
                            >
                                <SettingsTextInput
                                    type="url"
                                    ariaLabel={t('settings.connections.baseUrl')}
                                    placeholder={t('settings.connections.baseUrl.placeholder')}
                                    autoComplete="url"
                                    value={cliProxyApi.baseUrl}
                                    onChange={(baseUrl) => setCliProxyApi({ baseUrl })}
                                />
                                <button
                                    ref={discoverButtonRef}
                                    type="button"
                                    data-testid="gateway-discover-button"
                                    disabled={isDiscovering}
                                    aria-label={
                                        isDiscovering
                                            ? t('settings.connections.discovery.discovering')
                                            : t('settings.connections.discovery.discover')
                                    }
                                    title={t('settings.connections.discovery.discover')}
                                    aria-haspopup="listbox"
                                    aria-expanded={isMenuOpen}
                                    aria-controls={
                                        isMenuOpen && discoveredGateways.length > 0
                                            ? 'gateway-discovery-listbox'
                                            : undefined
                                    }
                                    onClick={() => {
                                        lastTriggerRef.current = discoverButtonRef.current
                                        void handleDiscover()
                                    }}
                                    onKeyDown={(e) => {
                                        if (isMenuOpen) {
                                            handleNavigationKeyDown(e)
                                            return
                                        }
                                        if (
                                            (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
                                            hasScanned &&
                                            discoveredGateways.length > 0 &&
                                            !isDiscovering
                                        ) {
                                            e.preventDefault()
                                            lastTriggerRef.current = discoverButtonRef.current
                                            const selectedIdx = discoveredGateways.findIndex((gw) => {
                                                const targetUrl =
                                                    gw.baseUrl ||
                                                    `http://${gw.primaryAddress || gw.host}:${gw.port}`
                                                return targetUrl === cliProxyApi.baseUrl
                                            })
                                            setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0)
                                            updateMenuPosition()
                                            setIsMenuOpen(true)
                                        }
                                    }}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)]',
                                        'bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)]',
                                        'transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]',
                                        'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 outline-none',
                                        isDiscovering ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
                                    )}
                                >
                                    {isDiscovering ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                        <Radar className="size-3.5" />
                                    )}
                                    <span>
                                        {isDiscovering
                                            ? t('settings.connections.discovery.discovering')
                                            : t('settings.connections.discovery.discover')}
                                    </span>
                                </button>
                                {hasScanned && discoveredGateways.length > 0 && !isDiscovering && (
                                    <button
                                        ref={toggleButtonRef}
                                        type="button"
                                        data-testid="gateway-toggle-button"
                                        aria-haspopup="listbox"
                                        aria-expanded={isMenuOpen}
                                        aria-controls={isMenuOpen ? 'gateway-discovery-listbox' : undefined}
                                        onClick={() => {
                                            lastTriggerRef.current = toggleButtonRef.current
                                            if (isMenuOpen) {
                                                closeMenu(true)
                                            } else {
                                                const selectedIdx = discoveredGateways.findIndex((gw) => {
                                                    const targetUrl =
                                                        gw.baseUrl ||
                                                        `http://${gw.primaryAddress || gw.host}:${gw.port}`
                                                    return targetUrl === cliProxyApi.baseUrl
                                                })
                                                setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0)
                                                updateMenuPosition()
                                                setIsMenuOpen(true)
                                            }
                                        }}
                                        onKeyDown={(e) => {
                                            if (isMenuOpen) {
                                                handleNavigationKeyDown(e)
                                                return
                                            }
                                            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                                e.preventDefault()
                                                lastTriggerRef.current = toggleButtonRef.current
                                                const selectedIdx = discoveredGateways.findIndex((gw) => {
                                                    const targetUrl =
                                                        gw.baseUrl ||
                                                        `http://${gw.primaryAddress || gw.host}:${gw.port}`
                                                    return targetUrl === cliProxyApi.baseUrl
                                                })
                                                setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0)
                                                updateMenuPosition()
                                                setIsMenuOpen(true)
                                            }
                                        }}
                                        aria-label={t('settings.connections.discovery.toggleList')}
                                        title={t('settings.connections.discovery.toggleList')}
                                        className={cn(
                                            'inline-flex items-center justify-center size-8 rounded-lg border border-[var(--border-subtle)]',
                                            'bg-[var(--bg-sidebar-hover)] text-[var(--text-primary)] transition-colors',
                                            'hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 cursor-pointer',
                                        )}
                                    >
                                        {isMenuOpen ? (
                                            <ChevronUp className="size-3.5" />
                                        ) : (
                                            <ChevronDown className="size-3.5" />
                                        )}
                                    </button>
                                )}
                            </div>
                        }
                    />
                    <SettingsRow
                        title={t('settings.connections.apiKey')}
                        description={t('settings.connections.apiKey.desc')}
                        control={
                            <SettingsTextInput
                                type="password"
                                ariaLabel={t('settings.connections.apiKey')}
                                placeholder={t('settings.connections.apiKey.placeholder')}
                                autoComplete="current-password"
                                value={cliProxyApi.apiKey}
                                onChange={(apiKey) => setCliProxyApi({ apiKey })}
                            />
                        }
                        last
                    />
                </SettingsCard>
            </SettingsSection>

            {!isBrowser && (
                <SettingsSection title={t('settings.connections.webServer.title')}>
                    <SettingsCard>
                        <SettingsRow
                            title={t('settings.connections.webServer.enable')}
                            description={t('settings.connections.webServer.enable.desc')}
                            control={
                                <ToggleSwitch
                                    checked={Boolean(webServer.enabled)}
                                    onChange={handleToggleEnabled}
                                    label={t('settings.connections.webServer.enable')}
                                />
                            }
                        />
                        <SettingsRow
                            title={t('settings.connections.webServer.host')}
                            description={t('settings.connections.webServer.host.desc')}
                            control={
                                <SettingsTextInput
                                    type="text"
                                    ariaLabel={t('settings.connections.webServer.host')}
                                    placeholder={t('settings.connections.webServer.host.placeholder')}
                                    autoComplete="off"
                                    value={webServer.host}
                                    onChange={handleHostChange}
                                />
                            }
                        />
                        <SettingsRow
                            title={t('settings.connections.webServer.port')}
                            description={t('settings.connections.webServer.port.desc')}
                            control={
                                <SettingsPortInput
                                    value={webServer.port}
                                    onChange={handlePortChange}
                                    ariaLabel={t('settings.connections.webServer.port')}
                                />
                            }
                        />
                        <SettingsRow
                            title={t('settings.connections.webServer.password')}
                            description={t('settings.connections.webServer.password.desc')}
                            control={
                                <SettingsPasswordInput
                                    value={webServer.password}
                                    onChange={handlePasswordChange}
                                    ariaLabel={t('settings.connections.webServer.password')}
                                    placeholder={t('settings.connections.webServer.password.placeholder')}
                                    showLabel={t('settings.connections.webServer.password.show')}
                                    hideLabel={t('settings.connections.webServer.password.hide')}
                                />
                            }
                        />
                        <SettingsRow
                            title={t('settings.connections.webServer.status')}
                            description={
                                serverStatus.error ? (
                                    <div className="mt-1 flex items-center gap-2">
                                        <span className="inline-block size-2 rounded-full bg-[var(--accent-red)] ring-2 ring-[var(--accent-red)]/20" />
                                        <span className="font-medium text-[var(--accent-red)]">
                                            {t('settings.connections.webServer.status.error')}
                                        </span>
                                        <span className="text-[11px] text-[var(--accent-red)]/80">
                                            {serverStatus.error}
                                        </span>
                                    </div>
                                ) : serverStatus.running ? (
                                    <div className="mt-1 flex flex-col gap-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="inline-block size-2 rounded-full bg-[var(--accent-green)] ring-2 ring-[var(--accent-green)]/20" />
                                            <span className="font-medium text-[var(--accent-green)]">
                                                {t('settings.connections.webServer.status.running')}
                                            </span>
                                            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                                                {serverStatus.url || `http://${webServer.host}:${webServer.port}`}
                                            </span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mt-1 flex items-center gap-2">
                                        <span className="inline-block size-2 rounded-full bg-[var(--text-muted)] opacity-50" />
                                        <span className="text-[var(--text-muted)]">
                                            {t('settings.connections.webServer.status.stopped')}
                                        </span>
                                    </div>
                                )
                            }
                            control={
                                serverStatus.running ? (
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={handleOpenInBrowser}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                                        >
                                            <ExternalLink className="size-3.5" />
                                            <span>{t('settings.connections.webServer.openInBrowser')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleCopyLink}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
                                        >
                                            {copied ? (
                                                <Check className="size-3.5 text-[var(--accent-green)]" />
                                            ) : (
                                                <Copy className="size-3.5" />
                                            )}
                                            <span>{t('settings.connections.webServer.copyLink')}</span>
                                        </button>
                                    </div>
                                ) : null
                            }
                            last
                        />
                    </SettingsCard>
                </SettingsSection>
            )}

            {isMenuOpen && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={menuRef}
                          role="dialog"
                          data-testid="gateway-discovery-menu"
                          tabIndex={-1}
                          aria-label={t('settings.connections.discovery.found')}
                          onKeyDown={handleNavigationKeyDown}
                          style={{
                              top: menuPosition.top !== undefined ? `${menuPosition.top}px` : undefined,
                              bottom: menuPosition.bottom !== undefined ? `${menuPosition.bottom}px` : undefined,
                              left: `${menuPosition.left}px`,
                              maxHeight: `${menuPosition.maxHeight}px`,
                              maxWidth: 'calc(100vw - 32px)',
                          }}
                          className={cn(
                              'fixed z-[70] w-[360px] max-w-[calc(100vw-32px)] flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)]',
                              'bg-[var(--bg-elevated)] p-2 shadow-2xl backdrop-blur-md outline-none',
                              'animate-in fade-in zoom-in-95 duration-100',
                          )}
                      >
                          <div className="flex shrink-0 flex-shrink-0 items-center justify-between px-2.5 py-1.5 pb-2 border-b border-[var(--border-subtle)]">
                              <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                                  {t('settings.connections.discovery.found')}
                              </span>
                              <button
                                  ref={rescanButtonRef}
                                  type="button"
                                  onClick={() => void handleDiscover()}
                                  disabled={isDiscovering}
                                  className={cn(
                                      'inline-flex items-center gap-1 text-[11px] text-[var(--accent-blue)]',
                                      'hover:underline disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed',
                                  )}
                              >
                                  {isDiscovering ? (
                                      <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                      <RefreshCw className="size-3" />
                                  )}
                                  <span>{t('settings.connections.discovery.rescan')}</span>
                              </button>
                          </div>

                          <div
                              data-testid="gateway-discovery-content"
                              className="flex-1 min-h-0 overflow-y-auto"
                          >
                              {isDiscovering ? (
                                  <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-[var(--text-secondary)]">
                                      <Loader2 className="size-4 animate-spin text-[var(--accent-blue)]" />
                                      <span>{t('settings.connections.discovery.discovering')}</span>
                                  </div>
                              ) : discoveryError ? (
                                  <div className="py-4 px-2 text-center">
                                      <div className="text-[12px] font-medium text-[var(--accent-red)]">
                                          {t('settings.connections.discovery.failed')}
                                      </div>
                                      <div className="mt-1 text-[11px] text-[var(--accent-red)]/80 break-words">
                                          {discoveryError}
                                      </div>
                                  </div>
                              ) : discoveredGateways.length === 0 ? (
                                  <div className="py-5 px-3 text-center">
                                      <Radar className="mx-auto size-5 text-[var(--text-muted)] opacity-50 mb-1.5" />
                                      <div className="text-[12px] text-[var(--text-secondary)]">
                                          {t('settings.connections.discovery.noGateways')}
                                      </div>
                                  </div>
                              ) : (
                                  <div
                                      ref={listboxRef}
                                      id="gateway-discovery-listbox"
                                      role="listbox"
                                      tabIndex={-1}
                                      aria-label={t('settings.connections.discovery.found')}
                                      aria-activedescendant={
                                          highlightedIndex >= 0 &&
                                          highlightedIndex < discoveredGateways.length
                                              ? `gateway-option-${highlightedIndex}`
                                              : undefined
                                      }
                                      className="space-y-1 pt-1.5 outline-none"
                                  >
                                      {discoveredGateways.map((gw, idx) => {
                                          const targetUrl =
                                              gw.baseUrl ||
                                              `http://${gw.primaryAddress || gw.host}:${gw.port}`
                                          const isSelected = cliProxyApi.baseUrl === targetUrl
                                          const isHighlighted = highlightedIndex === idx
                                          return (
                                              <button
                                                  key={`${gw.instanceName}-${targetUrl}-${idx}`}
                                                  ref={(el) => {
                                                      optionRefs.current[idx] = el
                                                  }}
                                                  id={`gateway-option-${idx}`}
                                                  type="button"
                                                  role="option"
                                                  tabIndex={-1}
                                                  aria-selected={isSelected}
                                                  data-selected={isSelected ? 'true' : 'false'}
                                                  data-highlighted={isHighlighted ? 'true' : 'false'}
                                                  data-testid={`gateway-option-${idx}`}
                                                  onClick={() => handleSelectGateway(gw)}
                                                  onMouseEnter={() => setHighlightedIndex(idx)}
                                                  className={cn(
                                                      'w-full flex items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                                                      'hover:bg-[var(--bg-sidebar-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 outline-none cursor-pointer',
                                                      (isSelected || isHighlighted) && 'bg-[var(--bg-sidebar-hover)]',
                                                      isHighlighted && 'ring-1 ring-[var(--border-subtle)]',
                                                  )}
                                              >
                                                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                                                      <Server className="size-4 shrink-0 text-[var(--accent-blue)] mt-0.5" />
                                                      <div className="min-w-0 flex-1">
                                                          <div className="flex items-center gap-1.5">
                                                              <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                                                                  {gw.instanceName}
                                                              </span>
                                                          </div>
                                                          <div className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
                                                              {targetUrl}
                                                          </div>
                                                      </div>
                                                  </div>

                                                  <div className="flex items-center gap-1.5 shrink-0">
                                                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium border border-[var(--border-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)]">
                                                          {gw.product || 'generic'}
                                                      </span>
                                                      <span
                                                          className={cn(
                                                              'rounded px-1.5 py-0.5 text-[10px] font-medium border',
                                                              gw.authRequired
                                                                  ? 'border-[var(--accent-orange)]/30 bg-[var(--accent-orange)]/10 text-[var(--accent-orange)]'
                                                                  : 'border-[var(--accent-green)]/30 bg-[var(--accent-green)]/10 text-[var(--accent-green)]',
                                                          )}
                                                      >
                                                          {gw.authRequired
                                                              ? t('settings.connections.discovery.authRequired')
                                                              : t('settings.connections.discovery.noAuth')}
                                                      </span>
                                                      {isSelected && (
                                                          <Check className="size-3.5 text-[var(--accent-blue)] shrink-0 ml-1" />
                                                      )}
                                                  </div>
                                              </button>
                                          )
                                      })}
                                  </div>
                              )}
                          </div>
                      </div>,
                      document.body,
                  )
                : null}
        </div>
    )
}
