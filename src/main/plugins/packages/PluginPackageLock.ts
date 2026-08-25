import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { PluginError } from '@cpa/plugin-api'

export interface ManagedNpmPackage {
    name: string
    version: string
    integrity: string
    packageRoot: string
    contentDigest?: string
}

export interface PluginPackageLockEntry {
    requested: string
    resolvedVersion: string
    integrity: string
    packageRoot: string
    contentDigest?: string
}

export interface PluginPackageLockFile {
    version: 1
    packages: Record<string, PluginPackageLockEntry>
}

export interface LockOptions {
    acquireTimeoutMs?: number
    staleTimeoutMs?: number
    pollIntervalMs?: number
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000
const DEFAULT_STALE_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 25

// In-process serialized execution queue per normalized lock path
const inProcessLockQueues = new Map<string, Promise<void>>()

function isProcessAlive(pid: number): boolean {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false
    }
    try {
        process.kill(pid, 0)
        return true
    } catch (err: any) {
        return err?.code === 'EPERM'
    }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
    try {
        const handle = await fs.open(dirPath, 'r')
        try {
            await handle.sync()
        } finally {
            await handle.close()
        }
    } catch {
        // Directory fsync not supported on all OS platforms (e.g. Windows); ignore
    }
}

async function atomicWriteAndSync(targetPath: string, content: string): Promise<void> {
    const targetDir = path.dirname(targetPath)
    await fs.mkdir(targetDir, { recursive: true })

    const tempPath = path.join(
        targetDir,
        `.${path.basename(targetPath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )

    const fileHandle = await fs.open(tempPath, 'w')
    try {
        await fileHandle.writeFile(content, 'utf-8')
        await fileHandle.sync()
    } finally {
        await fileHandle.close()
    }

    await fs.rename(tempPath, targetPath)
    await fsyncDirectory(targetDir)
}

/**
 * Universal PluginPackageLock managing atomic reads, modifications,
 * cross-process locking (`open('wx')`), stale lock recovery, and disk fsync.
 */
export class PluginPackageLock {
    readonly lockfilePath: string
    private readonly normalizedPath: string
    private readonly lockFileLockPath: string

    constructor(lockfilePath: string) {
        this.lockfilePath = lockfilePath
        this.normalizedPath = path.resolve(lockfilePath)
        this.lockFileLockPath = `${this.normalizedPath}.lock`
    }

    /**
     * Acquire cross-process lock file using exclusive creation (`wx` flag).
     */
    private async _acquireFileLock(options: LockOptions = {}): Promise<() => Promise<void>> {
        const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
        const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
        const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
        const startTime = Date.now()

        const lockDir = path.dirname(this.lockFileLockPath)
        await fs.mkdir(lockDir, { recursive: true })

        while (true) {
            try {
                const handle = await fs.open(this.lockFileLockPath, 'wx')
                const lockData = {
                    pid: process.pid,
                    createdAt: Date.now(),
                    owner: `pid-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                }
                try {
                    await handle.writeFile(JSON.stringify(lockData, null, 2) + '\n', 'utf-8')
                    await handle.sync()
                } finally {
                    await handle.close()
                }

                let released = false
                return async () => {
                    if (released) return
                    released = true
                    try {
                        await fs.rm(this.lockFileLockPath, { force: true })
                    } catch {
                        // Ignore removal error on release
                    }
                }
            } catch (err: any) {
                if (err?.code === 'EEXIST') {
                    // Lock file already exists: check if stale
                    try {
                        const raw = await fs.readFile(this.lockFileLockPath, 'utf-8')
                        const parsed = JSON.parse(raw)
                        const isExpired = Date.now() - parsed.createdAt > staleTimeoutMs
                        const isDead = !isProcessAlive(parsed.pid)

                        if (isExpired || isDead) {
                            // Lock is stale: break and re-try acquisition immediately
                            await fs.rm(this.lockFileLockPath, { force: true }).catch(() => {})
                            continue
                        }
                    } catch {
                        // Unreadable/corrupted lock file: remove and retry
                        await fs.rm(this.lockFileLockPath, { force: true }).catch(() => {})
                        continue
                    }

                    if (Date.now() - startTime > acquireTimeoutMs) {
                        throw new PluginError(
                            `Timeout acquiring package lockfile at '${this.lockFileLockPath}' after ${acquireTimeoutMs}ms`,
                            { cause: err },
                        )
                    }

                    // Spin wait with jitter
                    const jitter = Math.floor(Math.random() * 15)
                    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs + jitter))
                } else {
                    throw new PluginError(
                        `Failed to acquire package lock at '${this.lockFileLockPath}': ${err.message}`,
                        { cause: err },
                    )
                }
            }
        }
    }

    /**
     * Execute an action protected by in-process queue and cross-process file lock.
     */
    async withLock<T>(action: () => Promise<T>, options?: LockOptions): Promise<T> {
        const queueKey = this.normalizedPath
        const currentQueue = inProcessLockQueues.get(queueKey) ?? Promise.resolve()

        let resolveNext: () => void
        const nextPromise = new Promise<void>((resolve) => {
            resolveNext = resolve
        })
        inProcessLockQueues.set(queueKey, nextPromise)

        await currentQueue.catch(() => {})

        let releaseFileLock: (() => Promise<void>) | null = null
        try {
            releaseFileLock = await this._acquireFileLock(options)
            return await action()
        } finally {
            if (releaseFileLock) {
                await releaseFileLock()
            }
            resolveNext!()
            if (inProcessLockQueues.get(queueKey) === nextPromise) {
                inProcessLockQueues.delete(queueKey)
            }
        }
    }

    /**
     * Load and validate the lockfile from disk without taking a lock.
     * Returns an empty version 1 lockfile structure if the file does not exist.
     */
    async load(): Promise<PluginPackageLockFile> {
        return this._loadInternal()
    }

    private async _loadInternal(): Promise<PluginPackageLockFile> {
        let content: string
        try {
            content = await fs.readFile(this.lockfilePath, 'utf-8')
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                return {
                    version: 1,
                    packages: {},
                }
            }
            throw new PluginError(
                `Failed to read plugin lockfile at '${this.lockfilePath}': ${err.message}`,
                { cause: err },
            )
        }

        let parsed: unknown
        try {
            parsed = JSON.parse(content)
        } catch (err: any) {
            throw new PluginError(
                `Invalid JSON in plugin lockfile at '${this.lockfilePath}': ${err.message}`,
                { cause: err },
            )
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new PluginError(
                `Invalid plugin lockfile format at '${this.lockfilePath}': expected an object`,
            )
        }

        const lock = parsed as Record<string, unknown>
        if (lock.version !== 1) {
            throw new PluginError(
                `Unsupported plugin-lock.json version: ${lock.version}. Only version 1 is supported.`,
            )
        }

        const packages =
            lock.packages && typeof lock.packages === 'object' && !Array.isArray(lock.packages)
                ? (lock.packages as Record<string, PluginPackageLockEntry>)
                : {}

        return {
            version: 1,
            packages,
        }
    }

    /**
     * Atomically save the lockfile to disk using a temporary file, fsync, and atomic rename.
     */
    async save(lock: PluginPackageLockFile): Promise<void> {
        if (lock.version !== 1) {
            throw new PluginError(
                `Unsupported plugin-lock.json version: ${lock.version}. Only version 1 is supported.`,
            )
        }

        const content = JSON.stringify(lock, null, 2) + '\n'
        await atomicWriteAndSync(this.lockfilePath, content)
    }

    /**
     * Run an atomic Read-Modify-Write transaction under full in-process and cross-process lock.
     */
    async runTransaction<T>(
        mutator: (lockFile: PluginPackageLockFile) => Promise<T> | T,
        options?: LockOptions,
    ): Promise<T> {
        return this.withLock(async () => {
            const currentLock = await this._loadInternal()
            const result = await mutator(currentLock)
            await this.save(currentLock)
            return result
        }, options)
    }

    /**
     * Retrieve a specific locked package entry by spec or key.
     */
    async get(key: string): Promise<PluginPackageLockEntry | undefined> {
        const lock = await this.load()
        return lock.packages[key]
    }

    /**
     * Record or update a locked package entry safely within an atomic transaction.
     */
    async set(key: string, entry: PluginPackageLockEntry): Promise<void> {
        await this.runTransaction((lock) => {
            lock.packages[key] = entry
        })
    }

    /**
     * Remove a package entry from the lockfile safely within an atomic transaction.
     */
    async remove(key: string): Promise<void> {
        await this.runTransaction((lock) => {
            delete lock.packages[key]
        })
    }
}
