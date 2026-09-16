import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import http from 'node:http'
import type { ReleaseManifest, DownloadProgress } from '../../../../src/shared/updateTypes.js'
import { UpdateService } from '../../../../src/main/services/update/updateService.js'
import { UpdateStateStorage } from '../../../../src/main/services/update/updateStateStorage.js'
import { createServices } from '../../../../src/main/ipc/registerIpcHandlers.js'

describe('UpdateService', () => {
    let tempDir: string
    let storage: UpdateStateStorage
    let service: UpdateService
    let relaunchMock: ReturnType<typeof vi.fn>
    let exitMock: ReturnType<typeof vi.fn>
    let mockHotUpdater: any
    let mockFullProvider: any

    const sampleHotManifest: ReleaseManifest = {
        version: '1.2.0',
        releaseDate: '2026-09-15T00:00:00Z',
        releaseNotes: 'Performance improvements and bug fixes',
        nativeRequirements: {
            electron: '44.0.0',
            modules: '130',
            minNativeBaseVersion: '1.0.0',
        },
        asar: {
            filename: 'app-update-1.2.0.asar',
            url: 'https://example.com/app.asar',
            sha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
            size: 2048,
        },
    }

    const sampleFullManifest: ReleaseManifest = {
        version: '2.0.0',
        releaseDate: '2026-10-01T00:00:00Z',
        releaseNotes: 'Major new version with updated Electron',
        nativeRequirements: {
            electron: '45.0.0',
            modules: '132',
            minNativeBaseVersion: '2.0.0',
        },
        installers: {
            'darwin-arm64': {
                filename: 'CodingProfessionalAgent-2.0.0-arm64.dmg',
                url: 'https://example.com/app-2.0.0-arm64.dmg',
                sha256: 'dmgsha256',
                size: 80000,
            },
        },
    }

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-service-test-'))
        storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
        relaunchMock = vi.fn()
        exitMock = vi.fn()
        mockHotUpdater = {
            downloadAndStage: vi.fn().mockImplementation(
                async (
                    _asset,
                    _version,
                    onProgress?: (progress: DownloadProgress) => void,
                ) => {
                    onProgress?.({
                        percent: 50,
                        transferredBytes: 1024,
                        totalBytes: 2048,
                        bytesPerSecond: 512,
                    })
                    onProgress?.({
                        percent: 100,
                        transferredBytes: 2048,
                        totalBytes: 2048,
                        bytesPerSecond: 1024,
                    })
                    return {
                        version: '1.2.0',
                        asarRelativePath: 'versions/1.2.0/app.asar',
                        asarAbsolutePath: path.join(tempDir, 'versions', '1.2.0', 'app.asar'),
                    }
                },
            ),
        }
        mockFullProvider = {
            resolvePlatformKey: vi.fn().mockReturnValue('darwin-arm64'),
            resolveInstaller: vi.fn().mockImplementation((manifest: ReleaseManifest) => {
                return manifest.installers?.['darwin-arm64']
            }),
            launchInstaller: vi.fn().mockResolvedValue(undefined),
        }

        service = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            fullProvider: mockFullProvider,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            repoOwner: 'router-for-me',
            repoName: 'CodingProfessionalAgent',
            relaunch: relaunchMock,
            exit: exitMock,
        })
    })

    afterEach(() => {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    })

    it('starts at idle phase with current version', () => {
        const snapshot = service.getStatusSnapshot()
        expect(snapshot.phase).toBe('idle')
        expect(snapshot.currentVersion).toBe('1.0.0')
        expect(snapshot.availableVersion).toBeUndefined()
        expect(snapshot.updateType).toBeUndefined()
        expect(snapshot.errorMessage).toBeUndefined()
    })

    it('automatically picks activeVersion from storage when currentVersion is not provided', () => {
        storage.recordPendingVersion('1.0.4', 'versions/1.0.4/app.asar')
        storage.activatePendingVersion()

        const activeService = new UpdateService({
            storage,
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
        })

        const snapshot = activeService.getStatusSnapshot()
        expect(snapshot.currentVersion).toBe('1.0.4')
    })

    it('detects available hot update when remote version is higher and compatible', async () => {
        const fetcher = vi.fn().mockResolvedValue(sampleHotManifest)
        const customService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            manifestFetcher: fetcher,
        })

        const snapshot = await customService.checkForUpdates()
        expect(snapshot.phase).toBe('available')
        expect(snapshot.availableVersion).toBe('1.2.0')
        expect(snapshot.updateType).toBe('hot')
        expect(snapshot.packageSize).toBe(2048)
        expect(snapshot.releaseNotes).toBe('Performance improvements and bug fixes')
        expect(snapshot.releaseDate).toBe('2026-09-15T00:00:00Z')
        expect(snapshot.errorMessage).toBeUndefined()
    })

    it('detects available full update when remote version requires newer Electron', async () => {
        const fetcher = vi.fn().mockResolvedValue(sampleFullManifest)
        const customService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            manifestFetcher: fetcher,
        })

        const snapshot = await customService.checkForUpdates()
        expect(snapshot.phase).toBe('available')
        expect(snapshot.availableVersion).toBe('2.0.0')
        expect(snapshot.updateType).toBe('full')
        expect(snapshot.releaseNotes).toBe('Major new version with updated Electron')
    })

    it('populates packageSize in snapshot for both hot and full updates', async () => {
        const fetcherHot = vi.fn().mockResolvedValue(sampleHotManifest)
        const hotService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            manifestFetcher: fetcherHot,
        })
        const hotSnapshot = await hotService.checkForUpdates()
        expect(hotSnapshot.packageSize).toBe(2048)

        const fetcherFull = vi.fn().mockResolvedValue(sampleFullManifest)
        const fullService = new UpdateService({
            storage,
            fullProvider: mockFullProvider,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            manifestFetcher: fetcherFull,
        })
        const fullSnapshot = await fullService.checkForUpdates()
        expect(fullSnapshot.packageSize).toBe(80000)
    })

    it('transitions to idle when remote version is not greater than current version', async () => {
        const olderManifest: ReleaseManifest = {
            ...sampleHotManifest,
            version: '1.0.0',
        }
        const fetcher = vi.fn().mockResolvedValue(olderManifest)
        const customService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            manifestFetcher: fetcher,
        })

        const snapshot = await customService.checkForUpdates()
        expect(snapshot.phase).toBe('idle')
        expect(snapshot.availableVersion).toBeUndefined()
    })

    it('transitions to error phase when manifest fetch fails', async () => {
        const fetcher = vi.fn().mockRejectedValue(new Error('Network offline'))
        const customService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            manifestFetcher: fetcher,
        })

        const snapshot = await customService.checkForUpdates()
        expect(snapshot.phase).toBe('error')
        expect(snapshot.errorMessage).toBe('Network offline')
    })

    it('downloads and stages hot update, transitions to ready phase, and updates progress', async () => {
        const customService = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
            relaunch: relaunchMock,
            exit: exitMock,
        })

        await customService.checkForUpdates()
        expect(customService.getStatusSnapshot().phase).toBe('available')

        const progressUpdates: number[] = []
        await customService.startDownload((prog) => progressUpdates.push(prog.percent))

        expect(customService.getStatusSnapshot().phase).toBe('ready')
        expect(mockHotUpdater.downloadAndStage).toHaveBeenCalledTimes(1)
        expect(progressUpdates).toEqual([50, 100])
        expect(customService.getStatusSnapshot().downloadProgress?.percent).toBe(100)
    })

    it('handles download error and transitions to error phase', async () => {
        const failingHotUpdater = {
            downloadAndStage: vi.fn().mockRejectedValue(new Error('SHA-256 verification failed')),
        }
        const customService = new UpdateService({
            storage,
            hotUpdater: failingHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        await customService.checkForUpdates()
        await customService.startDownload()

        expect(customService.getStatusSnapshot().phase).toBe('error')
        expect(customService.getStatusSnapshot().errorMessage).toBe('SHA-256 verification failed')
    })

    it('cancels active download, aborts signal, and reverts phase to available', async () => {
        let capturedSignal: AbortSignal | undefined
        const slowHotUpdater = {
            downloadAndStage: vi.fn().mockImplementation(
                (_asset, _version, _prog, signal: AbortSignal) => {
                    capturedSignal = signal
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            reject(new Error('Operation aborted'))
                        })
                    })
                },
            ),
        }

        const customService = new UpdateService({
            storage,
            hotUpdater: slowHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        await customService.checkForUpdates()
        const downloadPromise = customService.startDownload()

        expect(customService.getStatusSnapshot().phase).toBe('downloading')

        customService.cancelDownload()

        await downloadPromise

        expect(capturedSignal?.aborted).toBe(true)
        expect(customService.getStatusSnapshot().phase).toBe('available')
        expect(customService.getStatusSnapshot().errorMessage).toBeUndefined()
    })

    it('quitAndInstall activates pending version and calls relaunch and exit for hot update', async () => {
        const customService = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
            relaunch: relaunchMock,
            exit: exitMock,
        })

        await customService.checkForUpdates()
        await customService.startDownload()

        expect(customService.getStatusSnapshot().phase).toBe('ready')

        // Precondition: pending version exists in storage
        storage.recordPendingVersion('1.2.0', 'versions/1.2.0/app.asar')

        await customService.quitAndInstall()

        expect(storage.loadState().activeVersion).toBe('1.2.0')
        expect(storage.loadState().pendingVersion).toBeNull()
        expect(relaunchMock).toHaveBeenCalledTimes(1)
        expect(exitMock).toHaveBeenCalledWith(0)
    })

    it('quitAndInstall launches installer and exits for full update', async () => {
        const customService = new UpdateService({
            storage,
            fullProvider: mockFullProvider,
            currentVersion: '1.0.0',
            electronVersion: '44.0.0',
            nodeAbiVersion: '130',
            manifestFetcher: vi.fn().mockResolvedValue(sampleFullManifest),
            relaunch: relaunchMock,
            exit: exitMock,
        })

        await customService.checkForUpdates()
        expect(customService.getStatusSnapshot().phase).toBe('available')
        expect(customService.getStatusSnapshot().updateType).toBe('full')

        // Simulate full download complete
        const fakeInstallerPath = path.join(tempDir, 'app-2.0.0.dmg')
        fs.writeFileSync(fakeInstallerPath, 'fake-installer-content')
        ;(customService as any).downloadedInstallerPath = fakeInstallerPath
        ;(customService as any).phase = 'ready'

        await customService.quitAndInstall()

        expect(mockFullProvider.launchInstaller).toHaveBeenCalledWith(fakeInstallerPath)
        expect(exitMock).toHaveBeenCalledWith(0)
        expect(relaunchMock).not.toHaveBeenCalled()
    })

    it('cancelDownload does nothing when not downloading', () => {
        expect(service.getStatusSnapshot().phase).toBe('idle')
        service.cancelDownload()
        expect(service.getStatusSnapshot().phase).toBe('idle')
    })

    it('handles cancel-then-immediate-restart without race condition overwriting new download state', async () => {
        let firstSignal: AbortSignal | undefined

        const controlledHotUpdater = {
            downloadAndStage: vi
                .fn()
                .mockImplementationOnce((_asset, _ver, _prog, signal: AbortSignal) => {
                    firstSignal = signal
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            setTimeout(() => reject(new Error('AbortError')), 20)
                        })
                    })
                })
                .mockImplementationOnce(async (_asset, _ver, onProgress) => {
                    onProgress?.({
                        percent: 100,
                        transferredBytes: 2048,
                        totalBytes: 2048,
                        bytesPerSecond: 1024,
                    })
                    return {
                        version: '1.2.0',
                        asarRelativePath: 'versions/1.2.0/app.asar',
                        asarAbsolutePath: path.join(tempDir, 'versions', '1.2.0', 'app.asar'),
                    }
                }),
        }

        const customService = new UpdateService({
            storage,
            hotUpdater: controlledHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        await customService.checkForUpdates()
        expect(customService.getStatusSnapshot().phase).toBe('available')

        const firstDownloadPromise = customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('downloading')

        customService.cancelDownload()
        expect(customService.getStatusSnapshot().phase).toBe('available')

        const secondDownloadPromise = customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('downloading')

        await Promise.all([firstDownloadPromise, secondDownloadPromise])

        expect(firstSignal?.aborted).toBe(true)
        expect(controlledHotUpdater.downloadAndStage).toHaveBeenCalledTimes(2)
        expect(customService.getStatusSnapshot().phase).toBe('ready')
        expect(customService.getStatusSnapshot().downloadProgress?.percent).toBe(100)
    })

    it('aborts full update during or after hash verification, cleans up downloaded file and does not transition to ready', async () => {
        const fileContent = 'installer-binary-payload-data'
        const server = http.createServer((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(Buffer.byteLength(fileContent)),
            })
            res.end(fileContent)
        })

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address() as any
        const port = address.port

        try {
            const fullManifestWithLocalServer: ReleaseManifest = {
                ...sampleFullManifest,
                installers: {
                    'darwin-arm64': {
                        filename: 'CodingProfessionalAgent-test.dmg',
                        url: `http://127.0.0.1:${port}/download.dmg`,
                        sha256: 'dummy-sha',
                        size: Buffer.byteLength(fileContent),
                    },
                },
            }

            let installerPathDuringVerification = ''
            const customService = new UpdateService({
                storage,
                fullProvider: mockFullProvider,
                currentVersion: '1.0.0',
                electronVersion: '44.0.0',
                nodeAbiVersion: '130',
                manifestFetcher: vi.fn().mockResolvedValue(fullManifestWithLocalServer),
                verifySha256: async (filePath: string) => {
                    installerPathDuringVerification = filePath
                    expect(fs.existsSync(filePath)).toBe(true)
                    customService.cancelDownload()
                    return true
                },
            })

            await customService.checkForUpdates()
            expect(customService.getStatusSnapshot().phase).toBe('available')
            expect(customService.getStatusSnapshot().updateType).toBe('full')

            await customService.startDownload()

            expect(installerPathDuringVerification).not.toBe('')
            expect(fs.existsSync(installerPathDuringVerification)).toBe(false)
            expect(customService.getStatusSnapshot().phase).toBe('available')
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })

    it('isolates full update download file paths per downloadId so cancelled download cleanup does not delete new download installer', async () => {
        const fileContent = 'installer-binary-payload-data'
        const server = http.createServer((_req, res) => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(Buffer.byteLength(fileContent)),
            })
            res.end(fileContent)
        })

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address() as any
        const port = address.port

        try {
            const fullManifestWithLocalServer: ReleaseManifest = {
                ...sampleFullManifest,
                installers: {
                    'darwin-arm64': {
                        filename: 'CodingProfessionalAgent-test.dmg',
                        url: `http://127.0.0.1:${port}/download.dmg`,
                        sha256: 'dummy-sha',
                        size: Buffer.byteLength(fileContent),
                    },
                },
            }

            let download1VerifyStarted!: () => void
            const download1VerifyStartedPromise = new Promise<void>((resolve) => {
                download1VerifyStarted = resolve
            })
            let allowDownload1CleanupToRun!: () => void
            const download1HoldPromise = new Promise<void>((resolve) => {
                allowDownload1CleanupToRun = resolve
            })

            let download1InstallerPath = ''
            let download2InstallerPath = ''
            let verifyCount = 0

            const customService = new UpdateService({
                storage,
                fullProvider: mockFullProvider,
                currentVersion: '1.0.0',
                electronVersion: '44.0.0',
                nodeAbiVersion: '130',
                manifestFetcher: vi.fn().mockResolvedValue(fullManifestWithLocalServer),
                exit: exitMock,
                verifySha256: async (filePath: string) => {
                    verifyCount++
                    if (verifyCount === 1) {
                        download1InstallerPath = filePath
                        expect(fs.existsSync(filePath)).toBe(true)
                        download1VerifyStarted()
                        // Pause verification until download 2 completes to ready
                        await download1HoldPromise
                        return true
                    } else {
                        download2InstallerPath = filePath
                        expect(fs.existsSync(filePath)).toBe(true)
                        return true
                    }
                },
            })

            await customService.checkForUpdates()
            expect(customService.getStatusSnapshot().phase).toBe('available')
            expect(customService.getStatusSnapshot().updateType).toBe('full')

            // Start download 1
            const firstDownloadPromise = customService.startDownload()
            expect(customService.getStatusSnapshot().phase).toBe('downloading')

            // Wait until download 1 is in-flight verifying hash
            await download1VerifyStartedPromise
            expect(download1InstallerPath).toContain('cpa-update-1-CodingProfessionalAgent-test.dmg')

            // Cancel download 1 while verification is in-flight
            customService.cancelDownload()
            expect(customService.getStatusSnapshot().phase).toBe('available')

            // Immediately start download 2 to completion (ready)
            const secondDownloadPromise = customService.startDownload()
            expect(customService.getStatusSnapshot().phase).toBe('downloading')

            await secondDownloadPromise
            expect(customService.getStatusSnapshot().phase).toBe('ready')
            expect(download2InstallerPath).toContain('cpa-update-2-CodingProfessionalAgent-test.dmg')
            expect(download2InstallerPath).not.toBe(download1InstallerPath)
            expect(fs.existsSync(download2InstallerPath)).toBe(true)

            // Allow download 1's verification to resolve and its cleanup logic to run
            allowDownload1CleanupToRun()
            await firstDownloadPromise

            // Verify download 1's installer file is cleaned up, but download 2's installer file is NOT deleted
            expect(fs.existsSync(download1InstallerPath)).toBe(false)
            expect(fs.existsSync(download2InstallerPath)).toBe(true)
            expect(fs.readFileSync(download2InstallerPath, 'utf8')).toBe(fileContent)
            expect(customService.getStatusSnapshot().phase).toBe('ready')

            // Verify quitAndInstall launches download 2's installer
            await customService.quitAndInstall()
            expect(mockFullProvider.launchInstaller).toHaveBeenCalledWith(download2InstallerPath)
            expect(exitMock).toHaveBeenCalledWith(0)
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })

    it('denies startDownload when phase is not available (checking, downloading, ready)', async () => {
        const customService = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        expect(customService.getStatusSnapshot().phase).toBe('idle')
        await customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('idle')
        expect(mockHotUpdater.downloadAndStage).not.toHaveBeenCalled()

        ;(customService as any).phase = 'checking'
        await customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('checking')
        expect(mockHotUpdater.downloadAndStage).not.toHaveBeenCalled()

        ;(customService as any).phase = 'downloading'
        await customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('downloading')
        expect(mockHotUpdater.downloadAndStage).not.toHaveBeenCalled()

        ;(customService as any).phase = 'ready'
        await customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('ready')
        expect(mockHotUpdater.downloadAndStage).not.toHaveBeenCalled()
    })

    it('snapshots manifest and update type at start of download even if manifest changes later', async () => {
        let finishDownload: () => void
        const slowHotUpdater = {
            downloadAndStage: vi.fn().mockImplementation((_asset, _ver, _prog, _signal) => {
                return new Promise((resolve) => {
                    finishDownload = () =>
                        resolve({
                            version: '1.2.0',
                            asarRelativePath: 'versions/1.2.0/app.asar',
                            asarAbsolutePath: path.join(tempDir, 'versions', '1.2.0', 'app.asar'),
                        })
                })
            }),
        }

        const customService = new UpdateService({
            storage,
            hotUpdater: slowHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
            relaunch: relaunchMock,
            exit: exitMock,
        })

        await customService.checkForUpdates()
        expect(customService.getStatusSnapshot().phase).toBe('available')

        const downloadPromise = customService.startDownload()
        expect(customService.getStatusSnapshot().phase).toBe('downloading')

        ;(customService as any).availableManifest = {
            ...sampleHotManifest,
            version: '1.3.0',
        }
        ;(customService as any).resolvedUpdateType = 'full'

        expect(customService.getStatusSnapshot().availableVersion).toBe('1.2.0')
        expect(customService.getStatusSnapshot().updateType).toBe('hot')

        finishDownload!()
        await downloadPromise

        expect(customService.getStatusSnapshot().phase).toBe('ready')
        expect(customService.getStatusSnapshot().availableVersion).toBe('1.2.0')
        expect(customService.getStatusSnapshot().updateType).toBe('hot')

        storage.recordPendingVersion('1.2.0', 'versions/1.2.0/app.asar')
        await customService.quitAndInstall()
        expect(relaunchMock).toHaveBeenCalledTimes(1)
        expect(exitMock).toHaveBeenCalledWith(0)
    })

    it('sets phase to error and does not call exit if launchInstaller fails', async () => {
        const failingFullProvider = {
            resolvePlatformKey: vi.fn().mockReturnValue('darwin-arm64'),
            resolveInstaller: vi.fn().mockReturnValue(sampleFullManifest.installers?.['darwin-arm64']),
            launchInstaller: vi.fn().mockRejectedValue(new Error('Installer launch permission denied')),
        }

        const customService = new UpdateService({
            storage,
            fullProvider: failingFullProvider,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleFullManifest),
            exit: exitMock,
        })

        await customService.checkForUpdates()

        const fakeInstallerPath = path.join(tempDir, 'app-2.0.0.dmg')
        fs.writeFileSync(fakeInstallerPath, 'fake-installer-content')
        ;(customService as any).downloadedInstallerPath = fakeInstallerPath
        ;(customService as any).phase = 'ready'

        await customService.quitAndInstall()

        expect(failingFullProvider.launchInstaller).toHaveBeenCalledWith(fakeInstallerPath)
        expect(exitMock).not.toHaveBeenCalled()
        expect(customService.getStatusSnapshot().phase).toBe('error')
        expect(customService.getStatusSnapshot().errorMessage).toBe('Installer launch permission denied')
    })

    it('dispose aborts active download and cleans up listeners', async () => {
        let capturedSignal: AbortSignal | undefined
        const slowHotUpdater = {
            downloadAndStage: vi.fn().mockImplementation(
                (_asset, _version, _prog, signal: AbortSignal) => {
                    capturedSignal = signal
                    return new Promise((_resolve, reject) => {
                        signal.addEventListener('abort', () => {
                            reject(new Error('Operation aborted'))
                        })
                    })
                },
            ),
        }

        const customService = new UpdateService({
            storage,
            hotUpdater: slowHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        const listener = vi.fn()
        customService.onStatusChange(listener)

        await customService.checkForUpdates()
        const downloadPromise = customService.startDownload()

        expect(customService.getStatusSnapshot().phase).toBe('downloading')

        customService.dispose()

        await downloadPromise

        expect(capturedSignal?.aborted).toBe(true)
    })

    it('does nothing on startDownload when no update is available', async () => {
        await service.startDownload()
        expect(service.getStatusSnapshot().phase).toBe('idle')
        expect(mockHotUpdater.downloadAndStage).not.toHaveBeenCalled()
    })

    it('does nothing on quitAndInstall when phase is not ready', async () => {
        await service.quitAndInstall()
        expect(relaunchMock).not.toHaveBeenCalled()
        expect(exitMock).not.toHaveBeenCalled()
    })

    it('notifies status listeners on phase and progress changes', async () => {
        const customService = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
        })

        const snapshots: string[] = []
        const unsubscribe = customService.onStatusChange((snap) => {
            snapshots.push(snap.phase)
        })

        await customService.checkForUpdates()
        await customService.startDownload()

        unsubscribe()

        expect(snapshots).toContain('checking')
        expect(snapshots).toContain('available')
        expect(snapshots).toContain('downloading')
        expect(snapshots).toContain('ready')
    })

    it('emits native event when emitEvent option is provided', async () => {
        const emitEventMock = vi.fn()
        const customService = new UpdateService({
            storage,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
            emitEvent: emitEventMock,
        })

        await customService.checkForUpdates()

        expect(emitEventMock).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'update:status-changed',
            }),
        )
    })

    it('confirmHealthy delegates to storage confirmHealthy', () => {
        storage.incrementFailure()
        expect(storage.loadState().consecutiveFailures).toBe(1)

        service.confirmHealthy()
        expect(storage.loadState().consecutiveFailures).toBe(0)
    })

    it('fetches manifest via HTTP server with redirect handling', async () => {
        const server = http.createServer((req, res) => {
            if (req.url === '/redirect') {
                res.writeHead(302, { Location: '/target-manifest.json' })
                res.end()
            } else if (req.url === '/target-manifest.json') {
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(sampleHotManifest))
            } else {
                res.writeHead(404)
                res.end()
            }
        })

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const address = server.address() as any
        const port = address.port

        try {
            const httpService = new UpdateService({
                storage,
                currentVersion: '1.0.0',
                manifestUrl: `http://127.0.0.1:${port}/redirect`,
            })

            const snap = await httpService.checkForUpdates()
            expect(snap.phase).toBe('available')
            expect(snap.availableVersion).toBe('1.2.0')
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    })

    it('dispatches update:* RPC methods through services.handleMethod', async () => {
        const customService = new UpdateService({
            storage,
            hotUpdater: mockHotUpdater,
            currentVersion: '1.0.0',
            manifestFetcher: vi.fn().mockResolvedValue(sampleHotManifest),
            relaunch: relaunchMock,
            exit: exitMock,
        })

        const services = createServices(() => null, {
            updateService: customService,
            homeDir: tempDir,
        })

        const state1 = (await services.handleMethod('update:getState', [])) as any
        expect(state1).toEqual(expect.objectContaining({ phase: 'idle', currentVersion: '1.0.0' }))

        const checkRes = (await services.handleMethod('update:check', [])) as any
        expect(checkRes).toEqual(expect.objectContaining({ phase: 'available', availableVersion: '1.2.0' }))

        await services.handleMethod('update:download', [])
        expect(customService.getStatusSnapshot().phase).toBe('ready')

        // cancelDownload when not downloading is safe
        await services.handleMethod('update:cancel', [])

        // quitAndInstall
        storage.recordPendingVersion('1.2.0', 'versions/1.2.0/app.asar')
        await services.handleMethod('update:apply', [])
        expect(relaunchMock).toHaveBeenCalled()
        expect(exitMock).toHaveBeenCalledWith(0)
    })

    it('schedules initial and periodic background checks and disposes timers properly', async () => {
        vi.useFakeTimers()
        try {
            const fetcher = vi.fn().mockResolvedValue(sampleHotManifest)
            const timedService = new UpdateService({
                storage,
                currentVersion: '1.0.0',
                manifestFetcher: fetcher,
                enableBackgroundCheck: true,
            })

            // Initial check should not have run yet (0s)
            expect(fetcher).not.toHaveBeenCalled()

            // Fast forward 30 seconds -> initial check fires
            await vi.advanceTimersByTimeAsync(30000)
            expect(fetcher).toHaveBeenCalledTimes(1)

            // Fast forward 4 hours -> periodic check fires
            await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
            expect(fetcher).toHaveBeenCalledTimes(2)

            // Dispose service -> timers should be cleared
            timedService.dispose()

            // Advance another 4 hours -> no additional checks
            await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000)
            expect(fetcher).toHaveBeenCalledTimes(2)
        } finally {
            vi.useRealTimers()
        }
    })
})
