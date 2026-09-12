import * as electron from 'electron'
import semver from 'semver'
import https from 'node:https'
import http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
    InstallerAsset,
    ReleaseManifest,
    UpdatePhase,
    UpdateStatusSnapshot,
    UpdateType,
    DownloadProgress,
} from '../../../shared/updateTypes.js'
import type { NativeEvent } from '../../../shared/types.js'
import { UpdateStateStorage } from './updateStateStorage.js'
import { AsarHotUpdater } from './asarHotUpdater.js'
import { FullUpdateProvider } from './fullUpdateProvider.js'
import { decideUpdateType } from './updateDecision.js'
import { verifyFileSha256 } from './checksum.js'

export interface UpdateServiceOptions {
    storage?: UpdateStateStorage
    hotUpdater?: AsarHotUpdater
    fullProvider?: FullUpdateProvider
    currentVersion?: string
    electronVersion?: string
    nodeAbiVersion?: string
    repoOwner?: string
    repoName?: string
    manifestUrl?: string
    manifestFetcher?: () => Promise<ReleaseManifest>
    relaunch?: () => void
    exit?: (code?: number) => void
    emitEvent?: (event: NativeEvent) => void
    verifySha256?: (filePath: string, expectedSha256: string) => Promise<boolean>
    enableBackgroundCheck?: boolean
}

export class UpdateService {
    private storage: UpdateStateStorage
    private hotUpdater: AsarHotUpdater
    private fullProvider: FullUpdateProvider
    private currentVersion: string
    private electronVersion: string
    private nodeAbiVersion: string
    private repoOwner: string
    private repoName: string
    private manifestUrl?: string
    private manifestFetcher?: () => Promise<ReleaseManifest>
    private relaunchFn: () => void
    private exitFn: (code?: number) => void
    private emitEvent?: (event: NativeEvent) => void
    private verifySha256Fn: (filePath: string, expectedSha256: string) => Promise<boolean>

    private phase: UpdatePhase = 'idle'
    private availableManifest: ReleaseManifest | null = null
    private resolvedUpdateType: UpdateType | null = null
    private targetManifest: ReleaseManifest | null = null
    private targetUpdateType: UpdateType | null = null
    private errorMessage: string | null = null
    private currentProgress?: DownloadProgress
    private stagedInstallerPath: string | null = null

    // Backward compatibility alias for tests accessing downloadedInstallerPath
    private get downloadedInstallerPath(): string | null {
        return this.stagedInstallerPath
    }
    private set downloadedInstallerPath(value: string | null) {
        this.stagedInstallerPath = value
    }

    private downloadAbortController: AbortController | null = null
    private downloadSequence = 0
    private currentDownloadId = 0
    private listeners = new Set<(snapshot: UpdateStatusSnapshot) => void>()
    private eventSequence = 0
    private initialCheckTimer: NodeJS.Timeout | null = null
    private periodicCheckTimer: NodeJS.Timeout | null = null

    constructor(options?: UpdateServiceOptions) {
        this.storage = options?.storage || new UpdateStateStorage()
        this.hotUpdater = options?.hotUpdater || new AsarHotUpdater(this.storage)
        this.fullProvider = options?.fullProvider || new FullUpdateProvider()
        this.currentVersion =
            options?.currentVersion ||
            (typeof electron !== 'undefined' && electron.app?.getVersion?.()) ||
            '1.0.0'
        this.electronVersion =
            options?.electronVersion ||
            (typeof process !== 'undefined' && process.versions?.electron) ||
            '44.0.0'
        this.nodeAbiVersion =
            options?.nodeAbiVersion ||
            (typeof process !== 'undefined' && process.versions?.electron
                ? process.versions.modules
                : '130')
        this.repoOwner = options?.repoOwner || 'router-for-me'
        this.repoName = options?.repoName || 'CodingProfessionalAgent'
        this.manifestUrl = options?.manifestUrl
        this.manifestFetcher = options?.manifestFetcher
        this.relaunchFn = options?.relaunch || (() => electron.app?.relaunch?.())
        this.exitFn = options?.exit || ((code = 0) => electron.app?.exit?.(code))
        this.emitEvent = options?.emitEvent
        this.verifySha256Fn = options?.verifySha256 || verifyFileSha256

        if (options?.enableBackgroundCheck !== false) {
            this.startBackgroundTimer()
        }
    }

    public onStatusChange(listener: (snapshot: UpdateStatusSnapshot) => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private notifyStatus(): void {
        const snapshot = this.getStatusSnapshot()
        for (const listener of this.listeners) {
            try {
                listener(snapshot)
            } catch (err) {
                console.error('[UpdateService] Listener error:', err)
            }
        }
        if (this.emitEvent) {
            try {
                this.emitEvent({
                    operationId: 'update',
                    sequence: ++this.eventSequence,
                    kind: 'update:status-changed',
                    data: JSON.stringify(snapshot),
                })
            } catch (err) {
                console.error('[UpdateService] Failed to emit native event:', err)
            }
        }
    }

    public getStatusSnapshot(): UpdateStatusSnapshot {
        const manifest =
            (this.phase === 'downloading' || this.phase === 'ready') && this.targetManifest
                ? this.targetManifest
                : this.availableManifest
        const updateType =
            (this.phase === 'downloading' || this.phase === 'ready') && this.targetUpdateType
                ? this.targetUpdateType
                : this.resolvedUpdateType

        return {
            phase: this.phase,
            currentVersion: this.currentVersion,
            availableVersion: manifest?.version,
            updateType: updateType ?? undefined,
            releaseNotes: manifest?.releaseNotes,
            releaseDate: manifest?.releaseDate,
            downloadProgress: this.currentProgress,
            errorMessage: this.errorMessage ?? undefined,
        }
    }

    public async checkForUpdates(): Promise<UpdateStatusSnapshot> {
        if (this.phase === 'checking' || this.phase === 'downloading' || this.phase === 'ready') {
            return this.getStatusSnapshot()
        }

        this.phase = 'checking'
        this.errorMessage = null
        this.currentProgress = undefined
        this.notifyStatus()

        try {
            const manifest = await this.fetchLatestManifest()
            try {
                const state = this.storage.loadState()
                state.lastCheckTime = new Date().toISOString()
                this.storage.saveState(state)
            } catch {}

            if (semver.gt(manifest.version, this.currentVersion)) {
                this.availableManifest = manifest
                this.resolvedUpdateType = decideUpdateType(manifest, {
                    electronVersion: this.electronVersion,
                    nodeAbiVersion: this.nodeAbiVersion,
                    baseBinaryVersion: this.storage.loadState().baseBinaryVersion,
                    currentVersion: this.currentVersion,
                })
                this.phase = 'available'
            } else {
                this.availableManifest = null
                this.resolvedUpdateType = null
                this.phase = 'idle'
            }
        } catch (err: any) {
            this.phase = 'error'
            this.errorMessage = err.message || 'Failed to check for updates'
        }

        this.notifyStatus()
        return this.getStatusSnapshot()
    }

    public async startDownload(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
        if (this.phase !== 'available' || !this.availableManifest || !this.resolvedUpdateType) {
            return
        }

        const downloadId = ++this.downloadSequence
        this.currentDownloadId = downloadId

        const manifestSnapshot = this.availableManifest
        const updateTypeSnapshot = this.resolvedUpdateType
        this.targetManifest = manifestSnapshot
        this.targetUpdateType = updateTypeSnapshot

        this.phase = 'downloading'
        this.errorMessage = null
        this.stagedInstallerPath = null
        this.downloadAbortController = new AbortController()
        const signal = this.downloadAbortController.signal
        this.notifyStatus()

        const progressHandler = (progress: DownloadProgress) => {
            if (this.currentDownloadId !== downloadId) return
            this.currentProgress = progress
            onProgress?.(progress)
            this.notifyStatus()
        }

        let installerTargetPath: string | null = null

        try {
            if (updateTypeSnapshot === 'hot' && manifestSnapshot.asar) {
                await this.hotUpdater.downloadAndStage(
                    manifestSnapshot.asar,
                    manifestSnapshot.version,
                    progressHandler,
                    signal,
                )

                if (signal.aborted || this.currentDownloadId !== downloadId) {
                    if (this.currentDownloadId === downloadId) {
                        this.phase = 'available'
                        this.currentProgress = undefined
                        this.downloadAbortController = null
                        this.targetManifest = null
                        this.targetUpdateType = null
                        this.notifyStatus()
                    }
                    return
                }

                this.phase = 'ready'
                this.downloadAbortController = null
                this.notifyStatus()
            } else if (updateTypeSnapshot === 'full') {
                const installer = this.fullProvider.resolveInstaller(manifestSnapshot)
                if (!installer) {
                    throw new Error('No installer available for current platform')
                }

                const runtimeDir = this.storage.getRuntimeDir()
                const installersDir = path.join(runtimeDir, 'installers')
                fs.mkdirSync(installersDir, { recursive: true })
                const installerFile = path.join(
                    installersDir,
                    `cpa-update-${downloadId}-${installer.filename}`,
                )
                installerTargetPath = installerFile

                await this.downloadInstallerAsset(installer, installerFile, progressHandler, signal)

                if (signal.aborted || this.currentDownloadId !== downloadId) {
                    if (fs.existsSync(installerFile)) {
                        try {
                            fs.unlinkSync(installerFile)
                        } catch {}
                    }
                    if (this.currentDownloadId === downloadId) {
                        this.phase = 'available'
                        this.currentProgress = undefined
                        this.downloadAbortController = null
                        this.targetManifest = null
                        this.targetUpdateType = null
                        this.notifyStatus()
                    }
                    return
                }

                const isValid = await this.verifySha256Fn(installerFile, installer.sha256)

                if (signal.aborted || this.currentDownloadId !== downloadId) {
                    if (fs.existsSync(installerFile)) {
                        try {
                            fs.unlinkSync(installerFile)
                        } catch {}
                    }
                    if (this.currentDownloadId === downloadId) {
                        this.phase = 'available'
                        this.currentProgress = undefined
                        this.downloadAbortController = null
                        this.targetManifest = null
                        this.targetUpdateType = null
                        this.notifyStatus()
                    }
                    return
                }

                if (!isValid) {
                    if (fs.existsSync(installerFile)) {
                        try {
                            fs.unlinkSync(installerFile)
                        } catch {}
                    }
                    throw new Error(`SHA-256 verification failed for installer ${installer.filename}`)
                }

                this.stagedInstallerPath = installerFile
                this.phase = 'ready'
                this.downloadAbortController = null
                this.notifyStatus()
            }
        } catch (err: any) {
            if (installerTargetPath && fs.existsSync(installerTargetPath)) {
                try {
                    fs.unlinkSync(installerTargetPath)
                } catch {}
            }

            if (this.currentDownloadId !== downloadId) {
                return
            }

            if (signal.aborted) {
                this.phase = 'available'
                this.currentProgress = undefined
                this.downloadAbortController = null
                this.targetManifest = null
                this.targetUpdateType = null
                this.notifyStatus()
                return
            }

            this.phase = 'error'
            this.errorMessage = err.message || 'Download failed'
            this.downloadAbortController = null
            this.targetManifest = null
            this.targetUpdateType = null
            this.notifyStatus()
        }
    }

    public cancelDownload(): void {
        if (this.phase === 'downloading' && this.downloadAbortController) {
            this.currentDownloadId = 0
            const controller = this.downloadAbortController
            this.downloadAbortController = null
            this.targetManifest = null
            this.targetUpdateType = null
            this.stagedInstallerPath = null
            this.phase = 'available'
            this.currentProgress = undefined
            controller.abort()
            this.notifyStatus()
        }
    }

    public async quitAndInstall(): Promise<void> {
        if (this.phase !== 'ready') return

        const updateType = this.targetUpdateType ?? this.resolvedUpdateType
        if (updateType === 'hot') {
            try {
                this.storage.activatePendingVersion()
                this.relaunchFn()
                this.exitFn(0)
            } catch (err: any) {
                this.phase = 'error'
                this.errorMessage = err.message || 'Failed to restart and apply update'
                this.notifyStatus()
            }
        } else if (updateType === 'full') {
            if (!this.stagedInstallerPath) {
                this.phase = 'error'
                this.errorMessage = 'Downloaded installer path is not available'
                this.notifyStatus()
                return
            }
            try {
                await this.fullProvider.launchInstaller(this.stagedInstallerPath)
                this.exitFn(0)
            } catch (err: any) {
                this.phase = 'error'
                this.errorMessage = err.message || 'Failed to launch installer'
                this.notifyStatus()
            }
        }
    }

    public confirmHealthy(): void {
        this.storage.confirmHealthy()
    }

    public startBackgroundTimer(initialDelayMs = 30000, intervalMs = 4 * 60 * 60 * 1000): void {
        this.stopBackgroundTimer()

        this.initialCheckTimer = setTimeout(() => {
            this.initialCheckTimer = null
            void this.checkForUpdates().catch(() => {})

            this.periodicCheckTimer = setInterval(() => {
                void this.checkForUpdates().catch(() => {})
            }, intervalMs)
            this.periodicCheckTimer?.unref?.()
        }, initialDelayMs)

        this.initialCheckTimer?.unref?.()
    }

    public stopBackgroundTimer(): void {
        if (this.initialCheckTimer) {
            clearTimeout(this.initialCheckTimer)
            this.initialCheckTimer = null
        }
        if (this.periodicCheckTimer) {
            clearInterval(this.periodicCheckTimer)
            this.periodicCheckTimer = null
        }
    }

    public dispose(): void {
        this.stopBackgroundTimer()
        this.currentDownloadId = 0
        if (this.downloadAbortController) {
            try {
                this.downloadAbortController.abort()
            } catch {}
            this.downloadAbortController = null
        }
        this.targetManifest = null
        this.targetUpdateType = null
        this.listeners.clear()
    }

    private fetchLatestManifest(): Promise<ReleaseManifest> {
        if (this.manifestFetcher) {
            return this.manifestFetcher()
        }

        const targetUrl =
            this.manifestUrl ||
            `https://github.com/${this.repoOwner}/${this.repoName}/releases/latest/download/release-manifest.json`

        return new Promise<ReleaseManifest>((resolve, reject) => {
            const getWithRedirects = (url: string, redirectsLeft: number) => {
                if (redirectsLeft <= 0) {
                    return reject(new Error('Too many HTTP redirects'))
                }

                let parsedUrl: URL
                try {
                    parsedUrl = new URL(url)
                } catch (e: any) {
                    return reject(e)
                }

                const client = parsedUrl.protocol === 'http:' ? http : https
                const req = client.get(
                    url,
                    { headers: { 'User-Agent': 'CodingProfessionalAgent' } },
                    (res) => {
                        if (
                            res.statusCode &&
                            res.statusCode >= 300 &&
                            res.statusCode < 400 &&
                            res.headers.location
                        ) {
                            let nextUrl: string
                            try {
                                nextUrl = new URL(res.headers.location, url).toString()
                            } catch (e: any) {
                                res.resume()
                                return reject(e)
                            }
                            res.resume()
                            return getWithRedirects(nextUrl, redirectsLeft - 1)
                        }

                        if (res.statusCode !== 200) {
                            res.resume()
                            return reject(
                                new Error(`Failed to fetch release manifest (HTTP ${res.statusCode})`),
                            )
                        }

                        let rawData = ''
                        res.setEncoding('utf8')
                        res.on('data', (chunk) => {
                            rawData += chunk
                        })
                        res.on('end', () => {
                            try {
                                const parsed = JSON.parse(rawData) as ReleaseManifest
                                resolve(parsed)
                            } catch (err) {
                                reject(
                                    new Error(
                                        `Failed to parse release manifest JSON: ${(err as Error).message}`,
                                    ),
                                )
                            }
                        })
                        res.on('error', (err) => {
                            reject(err)
                        })
                    },
                )

                req.on('error', (err) => {
                    reject(err)
                })
            }

            getWithRedirects(targetUrl, 5)
        })
    }

    private async downloadInstallerAsset(
        asset: InstallerAsset,
        destPath: string,
        onProgress?: (progress: DownloadProgress) => void,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        if (abortSignal?.aborted) {
            throw new Error('Operation aborted')
        }

        const tempFilePath = `${destPath}.tmp`
        const getClientAndResponse = (url: string, redirectsLeft: number): Promise<http.IncomingMessage> => {
            return new Promise((resolve, reject) => {
                if (redirectsLeft <= 0) {
                    return reject(new Error('Too many HTTP redirects'))
                }

                const parsedUrl = new URL(url)
                const client = parsedUrl.protocol === 'http:' ? http : https
                const req = client.get(url, { signal: abortSignal }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const nextUrl = new URL(res.headers.location, url).toString()
                        res.resume()
                        return resolve(getClientAndResponse(nextUrl, redirectsLeft - 1))
                    }
                    if (res.statusCode !== 200) {
                        res.resume()
                        return reject(new Error(`Download failed with HTTP status ${res.statusCode}`))
                    }
                    resolve(res)
                })
                req.on('error', reject)
            })
        }

        const res = await getClientAndResponse(asset.url, 5)

        let transferredBytes = 0
        let lastTime = Date.now()
        let lastBytes = 0
        const contentLength = res.headers['content-length']
        const totalBytes = contentLength ? Number(contentLength) || asset.size : asset.size

        const progressTransform = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                transferredBytes += chunk.length
                const now = Date.now()
                const timeDiff = (now - lastTime) / 1000
                if (timeDiff >= 0.2 || (totalBytes > 0 && transferredBytes === totalBytes)) {
                    const speed = timeDiff > 0 ? (transferredBytes - lastBytes) / timeDiff : 0
                    lastTime = now
                    lastBytes = transferredBytes
                    onProgress?.({
                        percent:
                            totalBytes > 0
                                ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
                                : 0,
                        transferredBytes,
                        totalBytes,
                        bytesPerSecond: Math.round(speed),
                    })
                }
                callback(null, chunk)
            },
        })

        const fileStream = fs.createWriteStream(tempFilePath)

        try {
            await pipeline(res, progressTransform, fileStream, { signal: abortSignal })
            if (fs.existsSync(destPath)) {
                try {
                    fs.unlinkSync(destPath)
                } catch {}
            }
            fs.renameSync(tempFilePath, destPath)
        } finally {
            if (fs.existsSync(tempFilePath)) {
                try {
                    fs.unlinkSync(tempFilePath)
                } catch {}
            }
        }
    }
}
