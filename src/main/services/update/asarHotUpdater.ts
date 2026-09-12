import * as fs from 'node:fs'
import * as path from 'node:path'
import * as https from 'node:https'
import * as http from 'node:http'
import { Transform } from 'node:stream'
import { pipeline, finished } from 'node:stream/promises'
import type { AsarAsset, DownloadProgress } from '../../../shared/updateTypes.js'
import { verifyFileSha256 } from './checksum.js'
import type { UpdateStateStorage } from './updateStateStorage.js'

export interface HotUpdateDeployResult {
    version: string
    asarRelativePath: string
    asarAbsolutePath: string
}

export class AsarHotUpdater {
    private storage: UpdateStateStorage

    constructor(storage: UpdateStateStorage) {
        this.storage = storage
    }

    /**
     * Downloads an asar asset to a temporary pending file, verifies its SHA-256 hash,
     * atomically moves it into the runtime versions directory, and records it as pending.
     */
    public async downloadAndStage(
        asset: AsarAsset,
        version: string,
        onProgress?: (progress: DownloadProgress) => void,
        abortSignal?: AbortSignal,
    ): Promise<HotUpdateDeployResult> {
        if (abortSignal?.aborted) {
            throw new Error('Operation aborted')
        }

        const runtimeDir = this.storage.getRuntimeDir()
        const pendingDir = path.join(runtimeDir, 'pending')
        const versionsDir = path.join(runtimeDir, 'versions', version)

        fs.mkdirSync(pendingDir, { recursive: true })
        fs.mkdirSync(versionsDir, { recursive: true })

        const tempFilePath = path.join(pendingDir, `app-update-${version}.tmp`)
        const targetAsarPath = path.join(versionsDir, 'app.asar')

        let downloadSuccess = false
        try {
            await this.downloadFileWithProgress(asset.url, tempFilePath, asset.size, onProgress, abortSignal)

            if (abortSignal?.aborted) {
                throw new Error('Operation aborted')
            }

            const isValid = await verifyFileSha256(tempFilePath, asset.sha256)
            if (!isValid) {
                try {
                    fs.unlinkSync(tempFilePath)
                } catch {}
                throw new Error(`SHA-256 verification failed for version ${version}`)
            }

            if (abortSignal?.aborted) {
                throw new Error('Operation aborted')
            }

            fs.renameSync(tempFilePath, targetAsarPath)
            downloadSuccess = true
            const relativePath = path.join('versions', version, 'app.asar')
            this.storage.recordPendingVersion(version, relativePath)

            return {
                version,
                asarRelativePath: relativePath,
                asarAbsolutePath: targetAsarPath,
            }
        } finally {
            if (fs.existsSync(tempFilePath)) {
                try {
                    fs.unlinkSync(tempFilePath)
                } catch {}
            }
        }
    }

    private async downloadFileWithProgress(
        url: string,
        destPath: string,
        expectedTotalBytes: number,
        onProgress?: (progress: DownloadProgress) => void,
        abortSignal?: AbortSignal,
    ): Promise<void> {
        if (abortSignal?.aborted) {
            throw new Error('Operation aborted')
        }

        let existingBytes = 0
        if (fs.existsSync(destPath)) {
            try {
                existingBytes = fs.statSync(destPath).size
            } catch {
                existingBytes = 0
            }
        }

        const headers: Record<string, string> = {}
        const canResume = existingBytes > 0 && expectedTotalBytes > 0 && existingBytes < expectedTotalBytes
        if (canResume) {
            headers['Range'] = `bytes=${existingBytes}-`
        } else if (existingBytes >= expectedTotalBytes && expectedTotalBytes > 0) {
            try {
                fs.unlinkSync(destPath)
            } catch {}
            existingBytes = 0
        }

        const { req, res } = await this.getResponseWithRedirects(url, 5, abortSignal, headers)

        const isPartial = res.statusCode === 206
        let transferredBytes = isPartial ? existingBytes : 0
        let lastTime = Date.now()
        let lastBytes = transferredBytes
        const contentLength = res.headers['content-length']
        let totalBytes = expectedTotalBytes
        if (!totalBytes) {
            if (isPartial) {
                const contentRange = res.headers['content-range']
                if (contentRange) {
                    const match = contentRange.match(/\/(\d+)$/)
                    if (match) {
                        totalBytes = Number(match[1])
                    }
                }
                if (!totalBytes && contentLength) {
                    totalBytes = existingBytes + Number(contentLength)
                }
            } else if (contentLength) {
                totalBytes = Number(contentLength)
            }
        }

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
                        percent: totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 0,
                        transferredBytes,
                        totalBytes,
                        bytesPerSecond: Math.round(speed),
                    })
                }
                callback(null, chunk)
            },
            flush(callback) {
                if (onProgress && transferredBytes > 0 && transferredBytes !== lastBytes) {
                    const now = Date.now()
                    const timeDiff = (now - lastTime) / 1000
                    const speed = timeDiff > 0 ? (transferredBytes - lastBytes) / timeDiff : 0
                    onProgress({
                        percent: totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : 100,
                        transferredBytes,
                        totalBytes,
                        bytesPerSecond: Math.round(speed),
                    })
                }
                callback()
            },
        })

        const fileStream = fs.createWriteStream(destPath, { flags: isPartial ? 'a' : 'w' })

        const onStreamAbort = () => {
            try {
                req.destroy()
            } catch {}
            try {
                res.resume()
                res.destroy()
            } catch {}
        }

        if (abortSignal) {
            abortSignal.addEventListener('abort', onStreamAbort, { once: true })
        }

        try {
            await pipeline(res, progressTransform, fileStream, { signal: abortSignal })
        } catch (err: any) {
            try {
                req.destroy()
            } catch {}
            try {
                res.resume()
                res.destroy()
            } catch {}
            if (abortSignal?.aborted || err.name === 'AbortError') {
                throw new Error('Operation aborted')
            }
            throw err
        } finally {
            if (abortSignal) {
                abortSignal.removeEventListener('abort', onStreamAbort)
            }
            if (!fileStream.closed) {
                fileStream.destroy()
                try {
                    await finished(fileStream)
                } catch {}
            }
        }
    }

    private async getResponseWithRedirects(
        initialUrl: string,
        maxRedirects: number,
        abortSignal?: AbortSignal,
        headers?: Record<string, string>,
    ): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
        let currentUrl = initialUrl
        let remainingRedirects = maxRedirects

        while (true) {
            if (abortSignal?.aborted) {
                throw new Error('Operation aborted')
            }

            let parsedUrl: URL
            try {
                parsedUrl = new URL(currentUrl)
            } catch (err: any) {
                throw err instanceof Error ? err : new Error(String(err))
            }

            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`)
            }

            const client = parsedUrl.protocol === 'https:' ? https : http

            const result = await new Promise<{
                req: http.ClientRequest
                res: http.IncomingMessage
                redirectUrl?: string
            }>((resolve, reject) => {
                let req: http.ClientRequest
                let settled = false

                const onAbort = () => {
                    cleanupAndReject(new Error('Operation aborted'))
                }

                const cleanupAndReject = (err: Error) => {
                    if (settled) return
                    settled = true
                    if (abortSignal) {
                        abortSignal.removeEventListener('abort', onAbort)
                    }
                    if (req && !req.destroyed) {
                        try {
                            req.destroy()
                        } catch {}
                    }
                    reject(err)
                }

                if (abortSignal?.aborted) {
                    return cleanupAndReject(new Error('Operation aborted'))
                }

                if (abortSignal) {
                    abortSignal.addEventListener('abort', onAbort, { once: true })
                }

                try {
                    req = client.get(currentUrl, { headers: headers ? { ...headers } : {} }, (res) => {
                        if (abortSignal) {
                            abortSignal.removeEventListener('abort', onAbort)
                        }

                        if (
                            res.statusCode &&
                            res.statusCode >= 300 &&
                            res.statusCode < 400 &&
                            res.headers.location
                        ) {
                            let nextUrl: string
                            try {
                                nextUrl = new URL(res.headers.location, currentUrl).toString()
                            } catch (err: any) {
                                try {
                                    res.resume()
                                    res.destroy()
                                } catch {}
                                return cleanupAndReject(err instanceof Error ? err : new Error(String(err)))
                            }

                            try {
                                res.resume()
                                res.destroy()
                            } catch {}

                            if (!settled) {
                                settled = true
                                resolve({ req, res, redirectUrl: nextUrl })
                            }

                            if (req && !req.destroyed) {
                                try {
                                    req.destroy()
                                } catch {}
                            }
                            return
                        }

                        if (res.statusCode !== 200 && res.statusCode !== 206) {
                            try {
                                res.resume()
                                res.destroy()
                            } catch {}
                            return cleanupAndReject(
                                new Error(`Download failed with HTTP status code ${res.statusCode}`),
                            )
                        }

                        if (!settled) {
                            settled = true
                            resolve({ req, res })
                        }
                    })
                } catch (err: any) {
                    return cleanupAndReject(err instanceof Error ? err : new Error(String(err)))
                }

                req.on('error', (err) => {
                    cleanupAndReject(err)
                })
            })

            if (result.redirectUrl) {
                if (result.res && !result.res.destroyed) {
                    try {
                        result.res.destroy()
                    } catch {}
                }
                if (result.req && !result.req.destroyed) {
                    try {
                        result.req.destroy()
                    } catch {}
                }

                if (remainingRedirects <= 0) {
                    throw new Error('Too many HTTP redirects')
                }
                remainingRedirects--
                currentUrl = result.redirectUrl
                continue
            }

            return { req: result.req, res: result.res }
        }
    }
}
