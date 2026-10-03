import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { brotliCompressSync } from 'node:zlib'
import { AsarHotUpdater } from '../../../../src/main/services/update/asarHotUpdater.js'
import { UpdateService } from '../../../../src/main/services/update/updateService.js'
import { UpdateStateStorage } from '../../../../src/main/services/update/updateStateStorage.js'
import type { AsarAsset } from '../../../../src/shared/updateTypes.js'

vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>() }))

describe('Brotli ASAR staging', () => {
    let dir: string
    let storage: UpdateStateStorage
    let updater: AsarHotUpdater
    let asset: AsarAsset
    let wire: Buffer
    const raw = Buffer.alloc(1024 * 1024, 'x')
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-br-'))
        storage = new UpdateStateStorage({ runtimeDir: dir, baseVersion: '1.0.0' })
        updater = new AsarHotUpdater(storage)
        wire = brotliCompressSync(raw)
        asset = {
            filename: 'app.asar', url: 'https://example.com/app.asar', size: raw.length, sha256: hash(raw),
            compressed: { encoding: 'br', filename: 'app.asar.br', url: 'https://example.com/app.asar.br', size: wire.length, sha256: hash(wire) },
        }
        vi.spyOn(updater as any, 'downloadFileWithProgress').mockImplementation(async (...args: any[]) => {
            const [url, dest, size, progress] = args
            fs.writeFileSync(dest, url.endsWith('.br') ? wire : raw)
            progress?.({ percent: 100, transferredBytes: size, totalBytes: size, bytesPerSecond: size })
        })
    })
    afterEach(() => {
        vi.restoreAllMocks()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const clean = () => {
        expect(fs.readdirSync(path.join(dir, 'pending'))).toEqual([])
        expect(storage.loadState().pendingVersion).toBeNull()
        expect(storage.loadState().activeVersion).toBe('1.0.0')
        expect(fs.existsSync(path.join(dir, 'versions/1.1.0/app.asar'))).toBe(false)
    }
    it('stages verified uncompressed bytes and persists pending state', async () => {
        const progress = vi.fn()
        const result = await updater.downloadAndStage(asset, '1.1.0', progress)
        expect(fs.readFileSync(result.asarAbsolutePath)).toEqual(raw)
        expect(new UpdateStateStorage({ runtimeDir: dir, baseVersion: '1.0.0' }).loadState().pendingVersion).toBe('1.1.0')
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({ totalBytes: wire.length }))
        expect(fs.readdirSync(path.join(dir, 'pending'))).toEqual([])
    })
    it.each(['legacy', 'unknown'])('falls back for %s manifests', async (kind) => {
        if (kind === 'legacy') delete asset.compressed
        else (asset.compressed as any).encoding = 'gzip'
        const result = await updater.downloadAndStage(asset, '1.1.0')
        expect(fs.readFileSync(result.asarAbsolutePath)).toEqual(raw)
    })
    it.each(['compressed hash', 'compressed size', 'raw hash', 'raw size', 'limit', 'corrupt', 'metadata', 'legacy size'])(
        'rejects %s and removes both temporary files', async (kind) => {
            let error = /verification failed/
            if (kind === 'compressed hash') asset.compressed!.sha256 = '0'.repeat(64)
            if (kind === 'compressed size') asset.compressed!.size++
            if (kind === 'raw hash') asset.sha256 = '0'.repeat(64)
            if (kind === 'raw size') asset.size++
            if (kind === 'legacy size') { delete asset.compressed; asset.size++ }
            if (kind === 'limit') { asset.size--; error = /exceeds expected size/ }
            if (kind === 'corrupt') {
                wire = Buffer.from('not a brotli stream')
                asset.compressed!.size = wire.length
                asset.compressed!.sha256 = hash(wire)
                error = /decompression failed/
            }
            if (kind === 'metadata') { asset.compressed!.size = -1; error = /Invalid compressed ASAR metadata/ }
            await expect(updater.downloadAndStage(asset, '1.1.0')).rejects.toThrow(error)
            clean()
        },
    )
    it.each(['compressed', 'raw'])('cancels during %s checksum and closes before cleanup', async (stage) => {
        const controller = new AbortController()
        const original = fs.createReadStream
        const remove = fs.rmSync
        let reads = 0
        let checksumStream: fs.ReadStream | undefined
        let closedBeforeCleanup = false
        vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
            reads++
            const targeted = reads === (stage === 'compressed' ? 1 : 3)
            const stream = original(file, targeted ? { highWaterMark: 1 } : options)
            if (targeted) {
                checksumStream = stream
                stream.once('data', () => controller.abort())
            }
            return stream
        })
        vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
            closedBeforeCleanup = checksumStream?.closed === true
            return remove(file, options)
        })
        await expect(updater.downloadAndStage(asset, '1.1.0', undefined, controller.signal)).rejects.toThrow('aborted')
        expect(checksumStream?.destroyed).toBe(true)
        expect(checksumStream?.bytesRead).toBeLessThan(stage === 'compressed' ? wire.length : raw.length)
        expect(closedBeforeCleanup).toBe(true)
        clean()
    })
    it('isolates an immediate service retry from decompression cancellation cleanup', async () => {
        const service = new UpdateService({
            storage, hotUpdater: updater, currentVersion: '1.0.0',
            electronVersion: '44.0.0', nodeAbiVersion: '130', enableBackgroundCheck: false,
            manifestFetcher: async () => ({
                version: '1.1.0', releaseDate: '2026-09-15T00:00:00Z', releaseNotes: '',
                nativeRequirements: { electron: '44.0.0', modules: '130', minNativeBaseVersion: '1.0.0' },
                asar: asset,
            }),
        })
        let releaseRetry!: () => void
        const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
        const paths: string[] = []
        vi.spyOn(updater as any, 'downloadFileWithProgress').mockImplementation(async (...args: any[]) => {
            const dest = args[1] as string
            paths.push(dest)
            fs.writeFileSync(dest, wire)
            if (paths.length === 2) await retryGate
        })
        const original = fs.createWriteStream
        let retry: Promise<void> | undefined
        vi.spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
            const stream = original(file, options)
            if (!retry) stream.once('open', () => {
                service.cancelDownload()
                expect(service.getStatusSnapshot().phase).toBe('available')
                retry = service.startDownload()
            })
            return stream
        })
        try {
            await service.checkForUpdates()
            await service.startDownload()
            expect(retry).toBeDefined()
            expect(paths).toHaveLength(2)
            expect(paths[0]).not.toBe(paths[1])
            expect(fs.existsSync(paths[0])).toBe(false)
            expect(fs.existsSync(paths[1])).toBe(true)
            expect(service.getStatusSnapshot().phase).toBe('downloading')
            expect(storage.loadState().pendingVersion).toBeNull()
            releaseRetry()
            await retry
            expect(service.getStatusSnapshot().phase).toBe('ready')
            expect(storage.loadState().pendingVersion).toBe('1.1.0')
            expect(fs.readFileSync(path.join(dir, 'versions/1.1.0/app.asar'))).toEqual(raw)
            expect(fs.readdirSync(path.join(dir, 'pending'))).toEqual([])
        } finally {
            releaseRetry()
            await retry
            service.dispose()
        }
    })
    it('cancels during decompression and cleans both files', async () => {
        const controller = new AbortController()
        const original = fs.createWriteStream
        vi.spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
            const stream = original(file, options)
            if (String(file).endsWith('.tmp')) stream.once('open', () => controller.abort())
            return stream
        })
        await expect(updater.downloadAndStage(asset, '1.1.0', undefined, controller.signal)).rejects.toThrow('aborted')
        clean()
    })
})
