import { useEffect, useState } from 'react'
import {
    Check,
    Copy,
    ExternalLink,
    useHostService,
    useSettings,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    SettingsServiceToken,
    UiServiceToken,
    WebServerServiceToken,
    type CliProxyApiSettings,
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
                            <SettingsTextInput
                                type="url"
                                ariaLabel={t('settings.connections.baseUrl')}
                                placeholder={t('settings.connections.baseUrl.placeholder')}
                                autoComplete="url"
                                value={cliProxyApi.baseUrl}
                                onChange={(baseUrl) => setCliProxyApi({ baseUrl })}
                            />
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
                                        <span className="inline-block size-2 rounded-full bg-rose-500 ring-2 ring-rose-500/20" />
                                        <span className="font-medium text-rose-500">
                                            {t('settings.connections.webServer.status.error')}
                                        </span>
                                        <span className="text-[11px] text-rose-400">
                                            {serverStatus.error}
                                        </span>
                                    </div>
                                ) : serverStatus.running ? (
                                    <div className="mt-1 flex flex-col gap-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="inline-block size-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                                            <span className="font-medium text-emerald-500">
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
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-white"
                                        >
                                            <ExternalLink className="size-3.5" />
                                            <span>{t('settings.connections.webServer.openInBrowser')}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleCopyLink}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-white"
                                        >
                                            {copied ? (
                                                <Check className="size-3.5 text-emerald-500" />
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
        </div>
    )
}
