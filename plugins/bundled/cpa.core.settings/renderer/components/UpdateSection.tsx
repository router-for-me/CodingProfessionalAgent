import { useCallback, useEffect, useRef, useState } from 'react'
import type {
    DownloadProgress,
    UpdatePhase,
    UpdateStatusSnapshot,
    UpdateType,
} from '@cpa/plugin-api'
import {
    AlertCircle,
    CheckCircle2,
    Download,
    Package,
    RefreshCw,
    RotateCw,
    X,
    Zap,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'
import { SettingsCard, SettingsSection } from './SettingsControls.js'
import { getSettingsCapabilityClient } from '../utils/capability.js'

export interface UpdateSectionProps {
    currentVersion?: string
    phase?: UpdatePhase
    availableVersion?: string
    updateType?: UpdateType
    packageSize?: number
    releaseNotes?: string
    releaseDate?: string
    downloadProgress?: DownloadProgress
    errorMessage?: string
    onCheckUpdates?: () => void | Promise<void>
    onDownload?: () => void | Promise<void>
    onCancel?: () => void | Promise<void>
    onApply?: () => void | Promise<void>
}

function formatBytes(bytes: number): string {
    if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    let val = bytes
    let unitIdx = 0
    while (val >= 1024 && unitIdx < units.length - 1) {
        val /= 1024
        unitIdx++
    }
    const formatted = val.toFixed(unitIdx === 0 ? 0 : 1).replace(/\.0$/, '')
    return `${formatted} ${units[unitIdx]}`
}

function formatSpeed(bytesPerSecond: number): string {
    if (!bytesPerSecond || isNaN(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
    return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Version & Online Updater card in settings.
 * Displays current CPA version, update checks, hot/full update badges, download progress, and restart trigger.
 */
export function UpdateSection(props: UpdateSectionProps) {
    const { t } = useTranslation()

    const latestUpdateSeqRef = useRef<number>(0)
    const lastEventTimestampRef = useRef<number>(0)

    const [internalSnapshot, setInternalSnapshot] = useState<UpdateStatusSnapshot>({
        phase: props.phase ?? 'idle',
        currentVersion: props.currentVersion ?? '1.0.0',
        availableVersion: props.availableVersion,
        updateType: props.updateType,
        packageSize: props.packageSize,
        releaseNotes: props.releaseNotes,
        releaseDate: props.releaseDate,
        downloadProgress: props.downloadProgress,
        errorMessage: props.errorMessage,
    })

    const effectivePhase = props.phase ?? internalSnapshot.phase
    const effectiveCurrentVersion = props.currentVersion ?? internalSnapshot.currentVersion ?? '1.0.0'
    const effectiveAvailableVersion = props.availableVersion ?? internalSnapshot.availableVersion
    const effectiveUpdateType = props.updateType ?? internalSnapshot.updateType
    const effectivePackageSize =
        props.packageSize ?? internalSnapshot.packageSize ?? internalSnapshot.downloadProgress?.totalBytes
    const effectiveReleaseNotes = props.releaseNotes ?? internalSnapshot.releaseNotes
    const effectiveDownloadProgress = props.downloadProgress ?? internalSnapshot.downloadProgress
    const effectiveErrorMessage = props.errorMessage ?? internalSnapshot.errorMessage

    // Connect to update service via plugin capability client when uncontrolled
    useEffect(() => {
        if (props.phase !== undefined) return

        const client = getSettingsCapabilityClient()
        if (!client) return
        if (typeof client.has === 'function' && !client.has('system.update')) {
            return
        }

        let active = true
        const requestSeq = latestUpdateSeqRef.current
        const requestTimestamp = Date.now()

        client
            .invoke<UpdateStatusSnapshot>('update:getState')
            .then((state) => {
                if (!active || !state) return
                // Discard stale getState response if newer live event has already been received
                if (latestUpdateSeqRef.current > requestSeq || lastEventTimestampRef.current >= requestTimestamp) {
                    return
                }
                setInternalSnapshot(state)
            })
            .catch(() => {
                // Graceful fallback when update service is not available
            })

        try {
            if (typeof client.subscribe === 'function') {
                const unsub = client.subscribe('update:status-changed', (event: any) => {
                    if (!active || !event) return
                    try {
                        let snapshotData = event
                        if (event && event.kind === 'update:status-changed' && event.data !== undefined) {
                            snapshotData = event.data
                        }
                        const parsed = typeof snapshotData === 'string' ? JSON.parse(snapshotData) : snapshotData
                        if (parsed && typeof parsed === 'object') {
                            latestUpdateSeqRef.current++
                            lastEventTimestampRef.current = Date.now()
                            setInternalSnapshot(parsed)
                        }
                    } catch {
                        // Ignore parse error
                    }
                })

                return () => {
                    active = false
                    try {
                        unsub?.()
                    } catch {}
                }
            }
        } catch {
            // Graceful fallback if subscribe fails
        }

        return () => {
            active = false
        }
    }, [props.phase])

    const handleCheckUpdates = useCallback(async () => {
        if (props.onCheckUpdates) {
            await props.onCheckUpdates()
            return
        }

        const client = getSettingsCapabilityClient()
        if (!client || (typeof client.has === 'function' && !client.has('system.update'))) return

        latestUpdateSeqRef.current++
        lastEventTimestampRef.current = Date.now()
        setInternalSnapshot((prev) => ({ ...prev, phase: 'checking', errorMessage: undefined }))
        try {
            const res = await client.invoke<UpdateStatusSnapshot>('update:check')
            if (res) {
                latestUpdateSeqRef.current++
                lastEventTimestampRef.current = Date.now()
                setInternalSnapshot(res)
            }
        } catch (err: any) {
            latestUpdateSeqRef.current++
            lastEventTimestampRef.current = Date.now()
            setInternalSnapshot((prev) => ({
                ...prev,
                phase: 'error',
                errorMessage: err?.message || 'Failed to check for updates',
            }))
        }
    }, [props.onCheckUpdates])

    const handleDownload = useCallback(async () => {
        if (props.onDownload) {
            await props.onDownload()
            return
        }

        const client = getSettingsCapabilityClient()
        if (!client || (typeof client.has === 'function' && !client.has('system.update'))) return

        latestUpdateSeqRef.current++
        lastEventTimestampRef.current = Date.now()
        setInternalSnapshot((prev) => ({ ...prev, phase: 'downloading', errorMessage: undefined }))
        try {
            await client.invoke('update:download')
        } catch (err: any) {
            latestUpdateSeqRef.current++
            lastEventTimestampRef.current = Date.now()
            setInternalSnapshot((prev) => ({
                ...prev,
                phase: 'error',
                errorMessage: err?.message || 'Failed to start download',
            }))
        }
    }, [props.onDownload])

    const handleCancel = useCallback(async () => {
        if (props.onCancel) {
            await props.onCancel()
            return
        }

        const client = getSettingsCapabilityClient()
        if (!client || (typeof client.has === 'function' && !client.has('system.update'))) return

        try {
            await client.invoke('update:cancel')
        } catch (err: any) {
            console.warn('[UpdateSection] Failed to cancel download:', err)
        }
    }, [props.onCancel])

    const handleApply = useCallback(async () => {
        if (props.onApply) {
            await props.onApply()
            return
        }

        const client = getSettingsCapabilityClient()
        if (!client || (typeof client.has === 'function' && !client.has('system.update'))) return

        try {
            await client.invoke('update:apply')
        } catch (err: any) {
            latestUpdateSeqRef.current++
            lastEventTimestampRef.current = Date.now()
            setInternalSnapshot((prev) => ({
                ...prev,
                phase: 'error',
                errorMessage: err?.message || 'Failed to apply update',
            }))
        }
    }, [props.onApply])

    return (
        <SettingsSection id="setting-updates" title={t('settings.update.title', 'Version & Online Update')}>
            <SettingsCard>
                <div className="space-y-4 p-4 font-[inherit]">
                    {/* Top Row: App Version & Check Button */}
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <div className="flex items-center gap-2">
                                <span className="text-[14px] font-semibold text-[var(--text-primary)]">
                                    Coding Professional Agent
                                </span>
                                <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2 py-0.5 font-mono text-[12px] font-medium text-[var(--text-secondary)]">
                                    v{effectiveCurrentVersion}
                                </span>
                            </div>
                            <div className="text-[12px] text-[var(--text-muted)]">
                                {effectivePhase === 'checking' &&
                                    t('settings.update.checkingStatus', 'Checking...')}
                                {effectivePhase === 'idle' &&
                                    t('settings.update.upToDate', 'You are on the latest version')}
                                {effectivePhase === 'available' &&
                                    t('settings.update.newVersionFound', 'A newer release is available')}
                                {effectivePhase === 'downloading' &&
                                    t('settings.update.downloadInProgress', 'Download in progress')}
                                {effectivePhase === 'ready' &&
                                    t('settings.update.readySubtitle', 'Restart required to complete update')}
                                {effectivePhase === 'error' &&
                                    t('settings.update.failedSubtitle', 'Check or download failed')}
                            </div>
                        </div>

                        {(effectivePhase === 'idle' || effectivePhase === 'checking') && (
                            <button
                                type="button"
                                disabled={effectivePhase === 'checking'}
                                onClick={handleCheckUpdates}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition hover:bg-[var(--bg-elevated)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer',
                                )}
                            >
                                <RefreshCw
                                    className={cn(
                                        'h-3.5 w-3.5',
                                        effectivePhase === 'checking' && 'animate-spin',
                                    )}
                                />
                                <span>
                                    {effectivePhase === 'checking'
                                        ? t('settings.update.checking', 'Checking for updates...')
                                        : t('settings.update.check', 'Check for updates')}
                                </span>
                            </button>
                        )}
                    </div>

                    {/* Available Update Details */}
                    {effectivePhase === 'available' && (
                        <div className="space-y-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 p-3.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                                        v{effectiveAvailableVersion}
                                    </span>
                                    {effectiveUpdateType === 'hot' ? (
                                        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-green)]/30 bg-[var(--accent-green)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent-green)]">
                                            <Zap className="h-3 w-3" />
                                            {effectivePackageSize
                                                ? t('settings.update.hotBadgeWithSize', {
                                                      defaultValue: 'Hot Update ({{size}})',
                                                      size: formatBytes(effectivePackageSize),
                                                  })
                                                : t('settings.update.hotBadge', 'Hot Update (~25MB)')}
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-blue)]/30 bg-[var(--accent-blue)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--accent-blue)]">
                                            <Package className="h-3 w-3" />
                                            {effectivePackageSize
                                                ? t('settings.update.fullBadgeWithSize', {
                                                      defaultValue: 'Full Package Update ({{size}})',
                                                      size: formatBytes(effectivePackageSize),
                                                  })
                                                : t('settings.update.fullBadge', 'Full Package Update')}
                                        </span>
                                    )}
                                </div>

                                <button
                                    type="button"
                                    onClick={handleDownload}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer',
                                        'border border-[var(--accent-blue)]/40 bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]',
                                        'hover:bg-[var(--accent-blue)]/25 active:scale-95',
                                    )}
                                >
                                    <Download className="h-3.5 w-3.5" />
                                    <span>{t('settings.update.download', 'Download Update')}</span>
                                </button>
                            </div>

                            {effectiveReleaseNotes ? (
                                <div className="space-y-1">
                                    <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">
                                        {t('settings.update.releaseNotes', 'Release Notes')}
                                    </div>
                                    <div className="max-h-36 overflow-y-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2.5 font-[inherit] text-[12px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap">
                                        {effectiveReleaseNotes}
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    )}

                    {/* Downloading Progress Bar */}
                    {effectivePhase === 'downloading' && (
                        <div className="space-y-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/50 p-3.5">
                            <div className="flex items-center justify-between text-[12px]">
                                <span className="font-medium text-[var(--text-primary)]">
                                    {t('settings.update.downloading', 'Downloading update...')}
                                </span>
                                <div className="flex items-center gap-2">
                                    <span className="font-semibold font-mono text-[var(--accent-blue)]">
                                        {effectiveDownloadProgress?.percent ?? 0}%
                                    </span>
                                    <button
                                        type="button"
                                        onClick={handleCancel}
                                        className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)] cursor-pointer active:scale-95"
                                    >
                                        <X className="h-3 w-3" />
                                        <span>{t('settings.update.cancel', 'Cancel')}</span>
                                    </button>
                                </div>
                            </div>

                            {/* Progress bar track & fill */}
                            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--border-subtle)]">
                                <div
                                    className="h-full rounded-full bg-[var(--accent-blue)] transition-all duration-200 ease-out"
                                    style={{
                                        width: `${Math.min(100, Math.max(0, effectiveDownloadProgress?.percent ?? 0))}%`,
                                    }}
                                />
                            </div>

                            {effectiveDownloadProgress && (
                                <div className="flex items-center justify-between font-mono text-[11px] text-[var(--text-muted)]">
                                    <span>
                                        {formatBytes(effectiveDownloadProgress.transferredBytes)} /{' '}
                                        {formatBytes(effectiveDownloadProgress.totalBytes)}
                                    </span>
                                    {effectiveDownloadProgress.bytesPerSecond > 0 && (
                                        <span>{formatSpeed(effectiveDownloadProgress.bytesPerSecond)}</span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Ready State with Restart Button */}
                    {effectivePhase === 'ready' && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--accent-green)]/30 bg-[var(--accent-green)]/5 p-3.5">
                            <div className="flex items-center gap-2.5">
                                <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--accent-green)]" />
                                <div>
                                    <div className="text-[13px] font-semibold text-[var(--text-primary)]">
                                        {t('settings.update.ready', 'Update is ready to install')}
                                    </div>
                                    <div className="text-[11px] text-[var(--text-muted)]">
                                        {effectiveAvailableVersion ? `v${effectiveAvailableVersion} · ` : ''}
                                        {t('settings.update.restartDesc', 'Restart CPA to apply this update')}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={handleApply}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[12px] font-medium transition-colors cursor-pointer',
                                    'border border-[var(--accent-green)]/40 bg-[var(--accent-green)]/15 text-[var(--accent-green)]',
                                    'hover:bg-[var(--accent-green)]/25 active:scale-95',
                                )}
                            >
                                <RotateCw className="h-3.5 w-3.5" />
                                <span>{t('settings.update.apply', 'Restart to Apply Update')}</span>
                            </button>
                        </div>
                    )}

                    {/* Error State with Retry Button */}
                    {effectivePhase === 'error' && (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5 p-3.5">
                            <div className="flex items-center gap-2.5">
                                <AlertCircle className="h-5 w-5 shrink-0 text-[var(--accent-red)]" />
                                <div>
                                    <div className="text-[13px] font-semibold text-[var(--accent-red)]">
                                        {t('settings.update.error', 'Update error')}
                                    </div>
                                    <div className="text-[12px] text-[var(--text-muted)]">
                                        {effectiveErrorMessage ||
                                            t('settings.update.errorDesc', 'An error occurred during update')}
                                    </div>
                                </div>
                            </div>

                            <button
                                type="button"
                                onClick={handleCheckUpdates}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sidebar-hover)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] transition hover:bg-[var(--bg-elevated)] active:scale-95 cursor-pointer"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                <span>{t('settings.update.retry', 'Retry')}</span>
                            </button>
                        </div>
                    )}
                </div>
            </SettingsCard>
        </SettingsSection>
    )
}
