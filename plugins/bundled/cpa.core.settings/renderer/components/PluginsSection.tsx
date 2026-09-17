import {
    useCallback,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react'
import type { FormEvent } from 'react'
import {
    AlertCircle,
    CheckCircle2,
    Download,
    Power,
    RefreshCw,
    Trash2,
    XCircle,
    cn,
    useHostService,
    useTranslation,
} from '@cpa/plugin-ui'
import {
    PluginManagementServiceToken,
    type PluginManagementActionOptions,
    type PluginManagementInstallOptions,
    type PluginSummary,
} from '@cpa/plugin-api'
import { SettingsCard, SettingsSection } from './SettingsControls.js'

export interface UnifiedPluginHost {
    subscribe(onStoreChange: () => void): () => void
    getPluginSummaries(): readonly PluginSummary[]
    activatePlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    deactivatePlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    reloadPlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    installPlugin?(spec: string, options?: PluginManagementInstallOptions): Promise<void>
    uninstallPlugin?(id: string, options?: PluginManagementActionOptions): Promise<void>
    isPluginActive(id: string): boolean
}

const EMPTY_SUMMARIES: readonly PluginSummary[] = Object.freeze([])

function areSummariesEqual(
    a: readonly PluginSummary[],
    b: readonly PluginSummary[],
): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        const itemA = a[i]
        const itemB = b[i]
        if (
            itemA.manifest.id !== itemB.manifest.id ||
            itemA.status !== itemB.status ||
            itemA.error !== itemB.error ||
            itemA.manifest.version !== itemB.manifest.version
        ) {
            return false
        }
    }
    return true
}

export interface PluginsSectionProps {
    runtime?: UnifiedPluginHost
    runtimeHost?: UnifiedPluginHost
    /**
     * @deprecated Legacy PluginManager reference for migration compatibility
     */
    pluginManager?: any
}

/**
 * Settings section for viewing, installing, enabling, disabling, reloading,
 * and uninstalling plugins via the universal PluginManagementService.
 */
export function PluginsSection({
    runtime,
    runtimeHost,
}: PluginsSectionProps) {
    const { t } = useTranslation()
    const pluginManagementService = useHostService(PluginManagementServiceToken)
    const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)
    const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
    const [installSpec, setInstallSpec] = useState('')
    const [isInstalling, setIsInstalling] = useState(false)
    const [installError, setInstallError] = useState<string | null>(null)

    const host: UnifiedPluginHost = useMemo(() => {
        if (runtime) return runtime
        if (runtimeHost) return runtimeHost
        if (pluginManagementService) {
            return {
                subscribe: (onStoreChange: () => void) =>
                    pluginManagementService.subscribe
                        ? pluginManagementService.subscribe(onStoreChange)
                        : () => {},
                getPluginSummaries: () => pluginManagementService.getPluginSummaries(),
                activatePlugin: (id: string, opt?: PluginManagementActionOptions) =>
                    pluginManagementService.activatePlugin(id, opt),
                deactivatePlugin: (id: string, opt?: PluginManagementActionOptions) =>
                    pluginManagementService.deactivatePlugin(id, opt),
                reloadPlugin: (id: string, opt?: PluginManagementActionOptions) =>
                    pluginManagementService.reloadPlugin(id, opt),
                installPlugin: (spec: string, opt?: PluginManagementInstallOptions) =>
                    pluginManagementService.installPlugin
                        ? opt !== undefined
                            ? pluginManagementService.installPlugin(spec, opt)
                            : pluginManagementService.installPlugin(spec)
                        : Promise.resolve(),
                uninstallPlugin: (id: string, opt?: PluginManagementActionOptions) =>
                    pluginManagementService.uninstallPlugin
                        ? opt !== undefined
                            ? pluginManagementService.uninstallPlugin(id, opt)
                            : pluginManagementService.uninstallPlugin(id)
                        : Promise.resolve(),
                isPluginActive: (id: string) => pluginManagementService.isPluginActive(id),
            }
        }
        return {
            subscribe: () => () => {},
            getPluginSummaries: () => EMPTY_SUMMARIES,
            activatePlugin: async () => {},
            deactivatePlugin: async () => {},
            reloadPlugin: async () => {},
            installPlugin: async () => {},
            uninstallPlugin: async () => {},
            isPluginActive: () => false,
        }
    }, [runtime, runtimeHost, pluginManagementService])

    const snapshotRef = useRef<readonly PluginSummary[]>(EMPTY_SUMMARIES)
    const subscribe = useCallback(
        (onStoreChange: () => void) => host.subscribe(onStoreChange),
        [host],
    )
    const getSnapshot = useCallback(() => {
        const next = host.getPluginSummaries()
        if (areSummariesEqual(snapshotRef.current, next)) {
            return snapshotRef.current
        }
        snapshotRef.current = next
        return next
    }, [host])

    const rawPlugins = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

    const plugins = useMemo(() => {
        return [...rawPlugins].sort((a, b) => {
            const isCoreA =
                Boolean((a.manifest as any).isCore) ||
                a.manifest.id.startsWith('cpa.core.') ||
                a.manifest.criticality === 'platform' ||
                a.manifest.criticality === 'required'
            const isCoreB =
                Boolean((b.manifest as any).isCore) ||
                b.manifest.id.startsWith('cpa.core.') ||
                b.manifest.criticality === 'platform' ||
                b.manifest.criticality === 'required'
            if (isCoreA !== isCoreB) {
                return isCoreA ? -1 : 1
            }
            const prioA = a.manifest.activationPriority ?? 100
            const prioB = b.manifest.activationPriority ?? 100
            if (prioA !== prioB) {
                return prioA - prioB
            }
            return a.manifest.name.localeCompare(b.manifest.name)
        })
    }, [rawPlugins])

    const handleEnable = async (pluginId: string) => {
        if (actionLoadingId) return
        setActionLoadingId(pluginId)
        setActionErrors((prev) => {
            const next = { ...prev }
            delete next[pluginId]
            return next
        })
        try {
            await host.activatePlugin(pluginId)
        } catch (err: any) {
            setActionErrors((prev) => ({
                ...prev,
                [pluginId]: err?.message || String(err),
            }))
        } finally {
            setActionLoadingId(null)
        }
    }

    const handleDisable = async (pluginId: string) => {
        if (actionLoadingId) return
        setActionLoadingId(pluginId)
        setActionErrors((prev) => {
            const next = { ...prev }
            delete next[pluginId]
            return next
        })
        try {
            await host.deactivatePlugin(pluginId)
        } catch (err: any) {
            setActionErrors((prev) => ({
                ...prev,
                [pluginId]: err?.message || String(err),
            }))
        } finally {
            setActionLoadingId(null)
        }
    }

    const handleReload = async (pluginId: string) => {
        if (actionLoadingId) return
        setActionLoadingId(pluginId)
        setActionErrors((prev) => {
            const next = { ...prev }
            delete next[pluginId]
            return next
        })
        try {
            await host.reloadPlugin(pluginId)
        } catch (err: any) {
            setActionErrors((prev) => ({
                ...prev,
                [pluginId]: err?.message || String(err),
            }))
        } finally {
            setActionLoadingId(null)
        }
    }

    const handleUninstall = async (pluginId: string) => {
        if (actionLoadingId) return
        setActionLoadingId(pluginId)
        setActionErrors((prev) => {
            const next = { ...prev }
            delete next[pluginId]
            return next
        })
        try {
            if (host.uninstallPlugin) {
                await host.uninstallPlugin(pluginId)
            }
        } catch (err: any) {
            setActionErrors((prev) => ({
                ...prev,
                [pluginId]: err?.message || String(err),
            }))
        } finally {
            setActionLoadingId(null)
        }
    }

    const handleInstallSubmit = async (e: FormEvent) => {
        e.preventDefault()
        const trimmed = installSpec.trim()
        if (!trimmed) return

        setIsInstalling(true)
        setInstallError(null)
        try {
            if (host.installPlugin) {
                await host.installPlugin(trimmed)
            }
            setInstallSpec('')
        } catch (err: any) {
            setInstallError(err?.message || t('settings.plugins.installFailed', 'Failed to install plugin'))
        } finally {
            setIsInstalling(false)
        }
    }

    const renderStatusBadge = (status: PluginSummary['status']) => {
        switch (status) {
            case 'active':
                return (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                        <CheckCircle2 className="size-3 shrink-0" aria-hidden />
                        <span>{t('settings.plugins.status.active', 'Active')}</span>
                    </span>
                )
            case 'error':
                return (
                    <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-400">
                        <AlertCircle className="size-3 shrink-0" aria-hidden />
                        <span>{t('settings.plugins.status.error', 'Error')}</span>
                    </span>
                )
            case 'inactive':
            case 'blocked':
            case 'incompatible':
                return (
                    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
                        <Power className="size-3 shrink-0" aria-hidden />
                        <span>{t('settings.plugins.status.inactive', 'Inactive')}</span>
                    </span>
                )
            case 'registered':
            case 'discovered':
            case 'validated':
            case 'resolved':
            default:
                return (
                    <span className="inline-flex items-center gap-1 rounded-full border border-zinc-500/20 bg-zinc-500/10 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
                        <span>{t('settings.plugins.status.registered', 'Registered')}</span>
                    </span>
                )
        }
    }

    return (
        <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 pt-8 pb-12">
            <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                {t('settings.nav.plugins', 'Plugins')}
            </h1>

            {/* Install New Plugin Section */}
            <SettingsSection title={t('settings.plugins.installNew', 'Install Plugin')}>
                <SettingsCard>
                    <div className="p-4">
                        <form onSubmit={handleInstallSubmit} className="space-y-3">
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                                <div className="flex-1">
                                    <input
                                        type="text"
                                        value={installSpec}
                                        onChange={(e) => setInstallSpec(e.target.value)}
                                        placeholder={t(
                                            'settings.plugins.installPlaceholder',
                                            'NPM package name or spec (e.g. @scope/plugin@1.0.0)',
                                        )}
                                        className="w-full rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)] px-3 py-1.5 text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-blue-500 focus:outline-none"
                                    />
                                </div>
                                <button
                                    type="submit"
                                    disabled={isInstalling || !installSpec.trim()}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-[13px] font-medium text-white shadow hover:bg-blue-500 disabled:opacity-50"
                                >
                                    {isInstalling ? (
                                        <RefreshCw className="size-3.5 animate-spin" aria-hidden />
                                    ) : (
                                        <Download className="size-3.5" aria-hidden />
                                    )}
                                    <span>{t('settings.plugins.installButton', 'Install')}</span>
                                </button>
                            </div>
                            {installError && (
                                <div className="text-[12px] font-mono text-rose-400">
                                    {installError}
                                </div>
                            )}
                        </form>
                    </div>
                </SettingsCard>
            </SettingsSection>

            {/* Installed Plugins List */}
            <SettingsSection title={t('settings.plugins.installed', 'Installed Plugins')}>
                <SettingsCard>
                    {plugins.length === 0 ? (
                        <div className="p-6 text-center text-[13px] text-[var(--text-muted)]">
                            {t('settings.plugins.noPlugins', 'No plugins installed')}
                        </div>
                    ) : (
                        <div className="divide-y divide-[var(--border-subtle)]">
                            {plugins.map((plugin) => {
                                const isCore =
                                    Boolean((plugin.manifest as any).isCore) ||
                                    plugin.manifest.id.startsWith('cpa.core.') ||
                                    plugin.manifest.criticality === 'platform' ||
                                    plugin.manifest.criticality === 'required'
                                const isActive = plugin.status === 'active'
                                const isError = plugin.status === 'error'
                                const isLoading = actionLoadingId === plugin.manifest.id
                                const actionError = actionErrors[plugin.manifest.id]
                                const pluginError =
                                    (isError || plugin.error) &&
                                    plugin.error !== 'Plugin is disabled' &&
                                    plugin.status !== 'inactive'
                                        ? typeof plugin.error === 'string'
                                            ? plugin.error
                                            : (plugin.error as any)?.message ||
                                              t('settings.plugins.status.error', 'Plugin encountered an error')
                                        : null
                                const currentError = actionError || pluginError
                                const authorName =
                                    typeof plugin.manifest.author === 'string'
                                        ? plugin.manifest.author
                                        : plugin.manifest.author?.name

                                return (
                                    <div
                                        key={plugin.manifest.id}
                                        data-testid={`plugin-row-${plugin.manifest.id}`}
                                        className="p-4 space-y-2.5"
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="min-w-0 flex-1 space-y-1">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-[14px] font-medium text-[var(--text-primary)]">
                                                        {plugin.manifest.name}
                                                    </span>
                                                    <span className="text-[12px] font-mono text-[var(--text-muted)]">
                                                        v{plugin.manifest.version}
                                                    </span>

                                                    {isCore ? (
                                                        <span className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)]">
                                                            {t('settings.plugins.core', 'Core')}
                                                        </span>
                                                    ) : plugin.source?.kind === 'npm' || (plugin as any).sourceKind === 'npm' ? (
                                                        <span className="rounded-full border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-400">
                                                            {t('settings.plugins.source.npm', 'NPM')}
                                                        </span>
                                                    ) : plugin.source?.kind?.startsWith('global') || (plugin as any).sourceKind?.startsWith('global') ? (
                                                        <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400">
                                                            {t('settings.plugins.source.global', 'Global')}
                                                        </span>
                                                    ) : (
                                                        <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-400">
                                                            {t('settings.plugins.external', 'External')}
                                                        </span>
                                                    )}

                                                    {renderStatusBadge(plugin.status)}

                                                    {/* Declared Runtimes */}
                                                    {plugin.manifest.entries &&
                                                        Object.keys(plugin.manifest.entries).length > 0 && (
                                                            <div className="flex items-center gap-1">
                                                                {Object.keys(plugin.manifest.entries).map((rt) => (
                                                                    <span
                                                                        key={rt}
                                                                        className="rounded border border-[var(--border-subtle)] px-1.5 py-0.2 text-[10px] font-mono text-[var(--text-muted)]"
                                                                    >
                                                                        {rt}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                </div>

                                                {plugin.manifest.description ? (
                                                    <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                                                        {plugin.manifest.description}
                                                    </p>
                                                ) : null}

                                                {authorName ? (
                                                    <p className="text-[11px] text-[var(--text-muted)]">
                                                        {t('settings.plugins.author', {
                                                            author: authorName,
                                                            defaultValue: `By ${authorName}`,
                                                        })}
                                                    </p>
                                                ) : null}

                                                {/* Dependencies */}
                                                {plugin.manifest.dependencies &&
                                                    Object.keys(plugin.manifest.dependencies).length > 0 && (
                                                        <p className="text-[11px] font-mono text-[var(--text-muted)]">
                                                            {t('settings.plugins.dependencies', 'Depends on')}:{' '}
                                                            {Object.entries(plugin.manifest.dependencies)
                                                                .map(([depId, depVer]) => `${depId}@${depVer}`)
                                                                .join(', ')}
                                                        </p>
                                                    )}
                                            </div>

                                            <div className="flex items-center gap-2 shrink-0 pt-0.5">
                                                {isCore ? (
                                                    <span className="text-[12px] text-[var(--text-muted)] italic select-none">
                                                        {t('settings.plugins.coreProtected', 'Core plugin')}
                                                    </span>
                                                ) : (
                                                    <>
                                                        {isActive ? (
                                                            <button
                                                                type="button"
                                                                disabled={isLoading}
                                                                className={cn(
                                                                    'rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition-colors',
                                                                    'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-50',
                                                                )}
                                                                onClick={() => handleDisable(plugin.manifest.id)}
                                                            >
                                                                {t('settings.plugins.disable', 'Disable')}
                                                            </button>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                disabled={isLoading}
                                                                className={cn(
                                                                    'rounded-md border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-[12px] font-medium text-blue-400 transition-colors',
                                                                    'hover:bg-blue-500/20 disabled:opacity-50',
                                                                )}
                                                                onClick={() => handleEnable(plugin.manifest.id)}
                                                            >
                                                                {t('settings.plugins.enable', 'Enable')}
                                                            </button>
                                                        )}

                                                        <button
                                                            type="button"
                                                            disabled={isLoading}
                                                            title={t('settings.plugins.reload', 'Reload')}
                                                            aria-label={t('settings.plugins.reload', 'Reload')}
                                                            className={cn(
                                                                'flex size-7 items-center justify-center rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sidebar)] text-[var(--text-muted)] transition-colors',
                                                                'hover:bg-[var(--bg-sidebar-hover)] hover:text-[var(--text-primary)] disabled:opacity-50',
                                                            )}
                                                            onClick={() => handleReload(plugin.manifest.id)}
                                                        >
                                                            <RefreshCw
                                                                className={cn(
                                                                    'size-3.5',
                                                                    isLoading && 'animate-spin',
                                                                )}
                                                                aria-hidden
                                                            />
                                                        </button>

                                                        <button
                                                            type="button"
                                                            disabled={isLoading}
                                                            title={t('settings.plugins.uninstall', 'Uninstall')}
                                                            aria-label={t('settings.plugins.uninstall', 'Uninstall')}
                                                            className={cn(
                                                                'flex size-7 items-center justify-center rounded-md border border-rose-500/20 bg-rose-500/10 text-rose-400 transition-colors',
                                                                'hover:bg-rose-500/20 disabled:opacity-50',
                                                            )}
                                                            onClick={() => handleUninstall(plugin.manifest.id)}
                                                        >
                                                            <Trash2 className="size-3.5" aria-hidden />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>

                                        {currentError && (
                                            <div
                                                data-testid={`plugin-error-${plugin.manifest.id}`}
                                                className="rounded-md border border-rose-500/20 bg-rose-500/10 p-2.5 text-[11px] font-mono text-rose-400 space-y-1"
                                            >
                                                <div className="flex items-center gap-1.5 font-medium">
                                                    <XCircle className="size-3.5 shrink-0" aria-hidden />
                                                    <span>{currentError}</span>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </SettingsCard>
            </SettingsSection>
        </div>
    )
}
