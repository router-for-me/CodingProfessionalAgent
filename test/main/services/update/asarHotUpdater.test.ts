import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { AsarHotUpdater } from '../../../../src/main/services/update/asarHotUpdater.js'
import { UpdateStateStorage } from '../../../../src/main/services/update/updateStateStorage.js'
import type { AsarAsset, DownloadProgress } from '../../../../src/shared/updateTypes.js'

describe('AsarHotUpdater', () => {
    let tempDir: string
    let storage: UpdateStateStorage
    let updater: AsarHotUpdater
    let server: http.Server
    let serverBaseUrl: string
    let serverFtpClosed = false
    let serverMalformedClosed = false
    const mockAsarData = Buffer.from('mock asar archive content with sufficient length for testing', 'utf8')
    const mockAsarSha256 = crypto.createHash('sha256').update(mockAsarData).digest('hex')
    const largeAsarData = crypto.randomBytes(256 * 1024)
    const largeAsarSha256 = crypto.createHash('sha256').update(largeAsarData).digest('hex')

    beforeEach(async () => {
        serverFtpClosed = false
        serverMalformedClosed = false
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-asar-updater-test-'))
        storage = new UpdateStateStorage({ runtimeDir: tempDir, baseVersion: '1.0.0' })
        updater = new AsarHotUpdater(storage)

        server = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1')
            if (parsedUrl.pathname === '/app.asar') {
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': mockAsarData.length.toString(),
                })
                res.end(mockAsarData)
            } else if (parsedUrl.pathname === '/resumable-asar') {
                const rangeHeader = req.headers.range
                if (rangeHeader && rangeHeader.startsWith('bytes=')) {
                    const parts = rangeHeader.replace(/bytes=/, '').split('-')
                    const start = parseInt(parts[0], 10) || 0
                    const chunk = mockAsarData.subarray(start)
                    res.writeHead(206, {
                        'Content-Type': 'application/octet-stream',
                        'Content-Range': `bytes ${start}-${mockAsarData.length - 1}/${mockAsarData.length}`,
                        'Content-Length': chunk.length.toString(),
                    })
                    res.end(chunk)
                } else {
                    res.writeHead(200, {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': mockAsarData.length.toString(),
                    })
                    res.end(mockAsarData)
                }
            } else if (parsedUrl.pathname === '/ignore-range-asar') {
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': mockAsarData.length.toString(),
                })
                res.end(mockAsarData)
            } else if (parsedUrl.pathname === '/redirect-asar') {
                res.writeHead(302, {
                    Location: '/app.asar',
                })
                res.end()
            } else if (parsedUrl.pathname === '/redirect-ftp') {
                res.writeHead(302, {
                    Location: 'ftp://127.0.0.1/unsupported.asar',
                })
                res.end()
            } else if (parsedUrl.pathname === '/redirect-malformed') {
                res.writeHead(302, {
                    Location: 'http://[::1]:namedport/invalid.asar',
                })
                res.end()
            } else if (parsedUrl.pathname === '/redirect-open-body-ftp') {
                res.writeHead(302, {
                    Location: 'ftp://127.0.0.1/unsupported.asar',
                })
                res.write('open body stream chunk never closed by server')
                req.on('close', () => {
                    serverFtpClosed = true
                })
            } else if (parsedUrl.pathname === '/redirect-open-body-malformed') {
                res.writeHead(302, {
                    Location: 'http://[::1]:namedport/invalid.asar',
                })
                res.write('open body stream chunk never closed by server')
                req.on('close', () => {
                    serverMalformedClosed = true
                })
            } else if (parsedUrl.pathname === '/large-asar') {
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': largeAsarData.length.toString(),
                })
                let offset = 0
                const chunkSize = 16 * 1024
                const interval = setInterval(() => {
                    if (offset >= largeAsarData.length) {
                        clearInterval(interval)
                        res.end()
                        return
                    }
                    const next = Math.min(offset + chunkSize, largeAsarData.length)
                    res.write(largeAsarData.subarray(offset, next))
                    offset = next
                }, 5)
                req.on('close', () => clearInterval(interval))
            } else if (parsedUrl.pathname === '/error-500') {
                res.writeHead(500, { 'Content-Type': 'text/plain' })
                res.end('Internal Server Error')
            } else if (parsedUrl.pathname === '/slow-asar') {
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': '1000000',
                })
                // Stream chunks slowly to allow abort testing
                const interval = setInterval(() => {
                    res.write(Buffer.alloc(1000, 'x'))
                }, 50)
                req.on('close', () => clearInterval(interval))
            } else {
                res.writeHead(404)
                res.end('Not Found')
            }
        })

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                const addr = server.address()
                const port = typeof addr === 'object' && addr ? addr.port : 0
                serverBaseUrl = `http://127.0.0.1:${port}`
                resolve()
            })
        })
    })

    afterEach(async () => {
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        try {
            fs.rmSync(tempDir, { recursive: true, force: true })
        } catch {}
    })

    it('downloads, verifies SHA-256, stages asar atomically, and records pending version', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/app.asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        const progressList: DownloadProgress[] = []
        const result = await updater.downloadAndStage(
            asset,
            '1.1.0',
            (progress) => progressList.push(progress),
        )

        expect(result.version).toBe('1.1.0')
        expect(result.asarRelativePath).toBe(path.join('versions', '1.1.0', 'app.asar'))
        expect(fs.existsSync(result.asarAbsolutePath)).toBe(true)

        const stagedContent = fs.readFileSync(result.asarAbsolutePath)
        expect(stagedContent.equals(mockAsarData)).toBe(true)

        const state = storage.loadState()
        expect(state.pendingVersion).toBe('1.1.0')
        expect(state.pendingAsarPath).toBe(path.join('versions', '1.1.0', 'app.asar'))

        expect(progressList.length).toBeGreaterThan(0)
        const lastProgress = progressList[progressList.length - 1]
        expect(lastProgress.percent).toBe(100)
        expect(lastProgress.transferredBytes).toBe(mockAsarData.length)
        expect(lastProgress.totalBytes).toBe(mockAsarData.length)
    })

    it('follows HTTP redirect before staging', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/redirect-asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        const result = await updater.downloadAndStage(asset, '1.1.0')
        expect(result.version).toBe('1.1.0')
        expect(fs.existsSync(result.asarAbsolutePath)).toBe(true)
    })

    it('rejects and cleans up temp files when SHA-256 verification fails', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/app.asar`,
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow(
            'SHA-256 verification failed for version 1.1.0',
        )

        const state = storage.loadState()
        expect(state.pendingVersion).toBeNull()
        expect(state.pendingAsarPath).toBeNull()

        const pendingDir = path.join(tempDir, 'pending')
        const pendingFiles = fs.readdirSync(pendingDir)
        expect(pendingFiles.length).toBe(0)

        const targetAsarPath = path.join(tempDir, 'versions', '1.1.0', 'app.asar')
        expect(fs.existsSync(targetAsarPath)).toBe(false)
    })

    it('rejects on HTTP error status (500) and cleans up temp files', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/error-500`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow(
            'Download failed with HTTP status code 500',
        )

        const pendingDir = path.join(tempDir, 'pending')
        const pendingFiles = fs.readdirSync(pendingDir)
        expect(pendingFiles.length).toBe(0)
    })

    it('rejects on unsupported protocol and cleans up temp files', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: 'ftp://127.0.0.1/app.asar',
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow(
            'Unsupported protocol: ftp:',
        )

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('rejects on invalid or malformed URL and cleans up temp files', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: 'not-a-valid-url',
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow()

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('rejects when redirect targets unsupported protocol', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/redirect-ftp`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow(
            'Unsupported protocol: ftp:',
        )

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('rejects when redirect location header is malformed', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/redirect-malformed`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow()

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('immediately destroys connection and response when 302 with open unclosed body redirects to invalid protocol or URL', async () => {
        const clientSockets: any[] = []
        const originalCreateConnection = http.globalAgent.createConnection
        http.globalAgent.createConnection = function (...args: any[]) {
            const socket = (originalCreateConnection as any).apply(this, args)
            clientSockets.push(socket)
            return socket
        }

        try {
            // Case 1: 302 with open unclosed body redirecting to unsupported protocol (ftp:)
            const assetFtp: AsarAsset = {
                filename: 'app-update-1.1.0.asar',
                url: `${serverBaseUrl}/redirect-open-body-ftp`,
                sha256: mockAsarSha256,
                size: mockAsarData.length,
            }

            await expect(updater.downloadAndStage(assetFtp, '1.1.0')).rejects.toThrow(
                'Unsupported protocol: ftp:',
            )

            expect(clientSockets.length).toBeGreaterThan(0)
            const ftpSocket = clientSockets[clientSockets.length - 1]
            expect(ftpSocket.destroyed).toBe(true)
            const ftpReq = ftpSocket._httpMessage
            if (ftpReq) {
                expect(ftpReq.destroyed).toBe(true)
            }

            // Verify server-side socket was closed by the client destruction
            await new Promise<void>((resolve) => {
                if (serverFtpClosed) return resolve()
                const interval = setInterval(() => {
                    if (serverFtpClosed) {
                        clearInterval(interval)
                        resolve()
                    }
                }, 10)
                setTimeout(() => {
                    clearInterval(interval)
                    resolve()
                }, 300)
            })
            expect(serverFtpClosed).toBe(true)

            // Case 2: 302 with open unclosed body redirecting to malformed URL
            const socketsBeforeMalformed = clientSockets.length
            const assetMalformed: AsarAsset = {
                filename: 'app-update-1.1.0.asar',
                url: `${serverBaseUrl}/redirect-open-body-malformed`,
                sha256: mockAsarSha256,
                size: mockAsarData.length,
            }

            await expect(updater.downloadAndStage(assetMalformed, '1.1.0')).rejects.toThrow()

            expect(clientSockets.length).toBeGreaterThan(socketsBeforeMalformed)
            const malformedSocket = clientSockets[clientSockets.length - 1]
            expect(malformedSocket.destroyed).toBe(true)
            const malformedReq = malformedSocket._httpMessage
            if (malformedReq) {
                expect(malformedReq.destroyed).toBe(true)
            }

            await new Promise<void>((resolve) => {
                if (serverMalformedClosed) return resolve()
                const interval = setInterval(() => {
                    if (serverMalformedClosed) {
                        clearInterval(interval)
                        resolve()
                    }
                }, 10)
                setTimeout(() => {
                    clearInterval(interval)
                    resolve()
                }, 300)
            })
            expect(serverMalformedClosed).toBe(true)
        } finally {
            http.globalAgent.createConnection = originalCreateConnection
        }
    })

    it('handles backpressure and large payload streaming with SHA-256 integrity', async () => {
        const asset: AsarAsset = {
            filename: 'app-update-2.0.0.asar',
            url: `${serverBaseUrl}/large-asar`,
            sha256: largeAsarSha256,
            size: largeAsarData.length,
        }

        const progressList: DownloadProgress[] = []
        const result = await updater.downloadAndStage(
            asset,
            '2.0.0',
            (progress) => progressList.push(progress),
        )

        expect(result.version).toBe('2.0.0')
        expect(fs.existsSync(result.asarAbsolutePath)).toBe(true)

        const stagedContent = fs.readFileSync(result.asarAbsolutePath)
        expect(stagedContent.equals(largeAsarData)).toBe(true)

        const state = storage.loadState()
        expect(state.pendingVersion).toBe('2.0.0')
        expect(progressList.length).toBeGreaterThan(0)
        expect(progressList[progressList.length - 1].percent).toBe(100)
    })

    it('handles abort signal and cleans up temp files during active download', async () => {
        const controller = new AbortController()
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/slow-asar`,
            sha256: mockAsarSha256,
            size: 1000000,
        }

        setTimeout(() => controller.abort(), 80)

        await expect(
            updater.downloadAndStage(asset, '1.1.0', undefined, controller.signal),
        ).rejects.toThrow('Operation aborted')

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('aborts immediately when AbortSignal is already aborted before starting', async () => {
        const controller = new AbortController()
        controller.abort()

        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/app.asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(
            updater.downloadAndStage(asset, '1.1.0', undefined, controller.signal),
        ).rejects.toThrow('Operation aborted')

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }
    })

    it('aborts before staging and deletes temporary file when aborted at 100% progress', async () => {
        const controller = new AbortController()
        const asset: AsarAsset = {
            filename: 'app-update-1.1.0.asar',
            url: `${serverBaseUrl}/app.asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        await expect(
            updater.downloadAndStage(
                asset,
                '1.1.0',
                (progress) => {
                    if (progress.percent === 100) {
                        controller.abort()
                    }
                },
                controller.signal,
            ),
        ).rejects.toThrow('Operation aborted')

        const pendingDir = path.join(tempDir, 'pending')
        if (fs.existsSync(pendingDir)) {
            const pendingFiles = fs.readdirSync(pendingDir)
            expect(pendingFiles.length).toBe(0)
        }

        const targetAsarPath = path.join(tempDir, 'versions', '1.1.0', 'app.asar')
        expect(fs.existsSync(targetAsarPath)).toBe(false)

        const state = storage.loadState()
        expect(state.pendingVersion).toBeNull()
    })

    it('resumes partial download when temporary file exists and server returns 206 Partial Content', async () => {
        const pendingDir = path.join(tempDir, 'pending')
        fs.mkdirSync(pendingDir, { recursive: true })
        const tempFilePath = path.join(pendingDir, 'app-update-1.5.0.tmp')

        // Simulate a partial download of 20 bytes
        const partialSize = 20
        fs.writeFileSync(tempFilePath, mockAsarData.subarray(0, partialSize))

        const asset: AsarAsset = {
            filename: 'app-update-1.5.0.asar',
            url: `${serverBaseUrl}/resumable-asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        const progressList: DownloadProgress[] = []
        const result = await updater.downloadAndStage(
            asset,
            '1.5.0',
            (progress) => progressList.push(progress),
        )

        expect(result.version).toBe('1.5.0')
        expect(fs.existsSync(result.asarAbsolutePath)).toBe(true)

        const stagedContent = fs.readFileSync(result.asarAbsolutePath)
        expect(stagedContent.equals(mockAsarData)).toBe(true)
        expect(progressList.length).toBeGreaterThan(0)
        expect(progressList[progressList.length - 1].percent).toBe(100)
    })

    it('overwrites from 0 when temporary file exists but server returns 200 OK (ignores Range)', async () => {
        const pendingDir = path.join(tempDir, 'pending')
        fs.mkdirSync(pendingDir, { recursive: true })
        const tempFilePath = path.join(pendingDir, 'app-update-1.6.0.tmp')

        // Simulate a partial download of 20 bytes
        const partialSize = 20
        fs.writeFileSync(tempFilePath, mockAsarData.subarray(0, partialSize))

        const asset: AsarAsset = {
            filename: 'app-update-1.6.0.asar',
            url: `${serverBaseUrl}/ignore-range-asar`,
            sha256: mockAsarSha256,
            size: mockAsarData.length,
        }

        const result = await updater.downloadAndStage(asset, '1.6.0')
        expect(result.version).toBe('1.6.0')
        expect(fs.existsSync(result.asarAbsolutePath)).toBe(true)

        const stagedContent = fs.readFileSync(result.asarAbsolutePath)
        expect(stagedContent.equals(mockAsarData)).toBe(true)
    })
})
