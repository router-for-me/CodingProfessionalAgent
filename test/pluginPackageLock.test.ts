import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    PluginPackageLock,
    type PluginPackageLockEntry,
} from '../src/main/plugins/packages/PluginPackageLock.js'

describe('PluginPackageLock Concurrency and Recovery', () => {
    let tempRoot: string
    let lockfilePath: string

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-lock-test-'))
        lockfilePath = path.join(tempRoot, 'plugin-lock.json')
    })

    afterEach(async () => {
        try {
            await fs.rm(tempRoot, { recursive: true, force: true })
        } catch {
            // Ignore cleanup error
        }
    })

    it('preserves both packages when two distinct instances concurrently write to the same lockfile', async () => {
        const lock1 = new PluginPackageLock(lockfilePath)
        const lock2 = new PluginPackageLock(lockfilePath)

        const entryA: PluginPackageLockEntry = {
            requested: 'npm:@scope/package-a@1.0.0',
            resolvedVersion: '1.0.0',
            integrity: 'sha512-hashA',
            packageRoot: path.join(tempRoot, 'npm', 'package-a', '1.0.0'),
            contentDigest: 'digestA',
        }

        const entryB: PluginPackageLockEntry = {
            requested: 'npm:@scope/package-b@2.0.0',
            resolvedVersion: '2.0.0',
            integrity: 'sha512-hashB',
            packageRoot: path.join(tempRoot, 'npm', 'package-b', '2.0.0'),
            contentDigest: 'digestB',
        }

        // Run both writes concurrently across separate instances
        await Promise.all([
            lock1.set('npm:@scope/package-a@1.0.0', entryA),
            lock2.set('npm:@scope/package-b@2.0.0', entryB),
        ])

        const verifyLock = new PluginPackageLock(lockfilePath)
        const finalContent = await verifyLock.load()

        expect(finalContent.packages['npm:@scope/package-a@1.0.0']).toEqual(entryA)
        expect(finalContent.packages['npm:@scope/package-b@2.0.0']).toEqual(entryB)
    })

    it('recovers from a stale lockfile left behind by a dead process or timed out operation', async () => {
        const lockfileLockPath = `${lockfilePath}.lock`
        const staleTimestamp = Date.now() - 30_000 // 30 seconds ago (expired)
        const staleLockData = {
            pid: 9999999, // Unlikely to exist
            createdAt: staleTimestamp,
            owner: 'dead-process-lock',
        }

        await fs.writeFile(lockfileLockPath, JSON.stringify(staleLockData), 'utf-8')

        const lock = new PluginPackageLock(lockfilePath)
        const entry: PluginPackageLockEntry = {
            requested: 'npm:test-pkg@1.0.0',
            resolvedVersion: '1.0.0',
            integrity: 'sha512-hash',
            packageRoot: path.join(tempRoot, 'npm', 'test-pkg', '1.0.0'),
        }

        // Should recover the stale lock and successfully write
        await lock.set('npm:test-pkg@1.0.0', entry)

        const loaded = await lock.get('npm:test-pkg@1.0.0')
        expect(loaded).toEqual(entry)
    })
})
