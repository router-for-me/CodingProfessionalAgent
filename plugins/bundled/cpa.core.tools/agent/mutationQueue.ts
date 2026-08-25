/**
 * Serialize file mutation operations that target the same logical path.
 * Different keys still run in parallel. Browser-safe (no Node fs/path).
 */

import { dirnamePath } from './path.js'

const fileMutationQueues = new Map<string, Promise<unknown>>()
let registrationQueue: Promise<void> = Promise.resolve()

export type RealPathResolver = (absolutePath: string) => Promise<string>

type MutationSlot = {
    key: string
    previous: Promise<unknown>
    chained: Promise<unknown>
    releaseNext: () => void
}

/**
 * Missing-path classification:
 * - When error has a `code` field (any value, including empty/non-string), code is
 *   authoritative: only ENOENT/ENOTDIR are missing; never fall back to message.
 * - Code-less errors use precise OS predicates only (no generic "not found").
 */
function isMissingPathError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code
        return code === 'ENOENT' || code === 'ENOTDIR'
    }

    const message =
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : String(error)

    // Unix / Node code-less messages.
    if (/no such file or directory/i.test(message)) {
        return true
    }
    if (/\bnot a directory\b/i.test(message)) {
        return true
    }
    // Windows CreateFile messages (may include "real path ...: CreateFile ...:" prefix).
    if (/The system cannot find the file specified/i.test(message)) {
        return true
    }
    if (/The system cannot find the path specified/i.test(message)) {
        return true
    }
    return false
}

function baseName(absolutePath: string): string {
    const normalized = absolutePath.replace(/\\/g, '/')
    const trimmed = normalized.replace(/\/+$/, '')
    const index = trimmed.lastIndexOf('/')
    if (index < 0) {
        return trimmed
    }
    return trimmed.slice(index + 1)
}

function isPathRoot(absolutePath: string): boolean {
    const normalized = absolutePath.replace(/\\/g, '/')
    if (normalized === '/' || normalized === '') {
        return true
    }
    // Windows drive root: C:/
    if (/^[A-Za-z]:\/?$/.test(normalized)) {
        return true
    }
    // UNC share root: //server/share
    if (/^\/\/[^/]+\/[^/]+\/?$/.test(normalized)) {
        return true
    }
    return false
}

function joinPath(base: string, segments: string[]): string {
    if (segments.length === 0) {
        return base
    }
    const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '')
    // Drive root becomes "C:" after stripping trailing slash — restore separator.
    if (/^[A-Za-z]:$/.test(normalizedBase)) {
        return `${normalizedBase}/${segments.join('/')}`
    }
    if (normalizedBase === '') {
        return `/${segments.join('/')}`
    }
    return `${normalizedBase}/${segments.join('/')}`
}

/**
 * Resolve a stable mutation key.
 * Prefer realpath so symlink aliases share a queue. When the leaf is missing,
 * walk to the nearest existing parent realpath and append the missing segments
 * so `/alias/new/file` and `/real/new/file` collapse under a symlink parent.
 */
export async function getMutationQueueKey(
    absolutePath: string,
    realPath: RealPathResolver,
): Promise<string> {
    try {
        return await realPath(absolutePath)
    } catch (error) {
        if (!isMissingPathError(error)) {
            throw error
        }
    }

    const missingSegments: string[] = []
    let current = absolutePath

    while (true) {
        const parent = dirnamePath(current)
        const leaf = baseName(current)
        if (leaf) {
            missingSegments.unshift(leaf)
        }

        if (parent === current || isPathRoot(parent)) {
            // Try resolving the root itself; if it also fails as missing, keep lexical path.
            try {
                const rootReal = await realPath(parent)
                return joinPath(rootReal, missingSegments)
            } catch (error) {
                if (!isMissingPathError(error)) {
                    throw error
                }
                return joinPath(parent, missingSegments)
            }
        }

        try {
            const parentReal = await realPath(parent)
            return joinPath(parentReal, missingSegments)
        } catch (error) {
            if (!isMissingPathError(error)) {
                throw error
            }
            current = parent
        }
    }
}

function abortError(): Error {
    return new Error('Operation aborted')
}

/**
 * Race a promise against abort. Rejects immediately on abort and never returns
 * success after abort. Underlying settlement is always observed (no unhandled).
 * Listener add/remove use the same function identity.
 */
function abortableResult<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void promise.then(
            () => undefined,
            () => undefined,
        )
        return Promise.reject(abortError())
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false
        const onAbort = () => {
            if (settled) {
                return
            }
            settled = true
            signal.removeEventListener('abort', onAbort)
            // Keep observing the underlying promise so it cannot become unhandled.
            void promise.then(
                () => undefined,
                () => undefined,
            )
            reject(abortError())
        }

        signal.addEventListener('abort', onAbort)
        promise.then(
            (value) => {
                if (settled) {
                    return
                }
                settled = true
                signal.removeEventListener('abort', onAbort)
                if (signal.aborted) {
                    reject(abortError())
                    return
                }
                resolve(value)
            },
            (error) => {
                if (settled) {
                    return
                }
                settled = true
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

/** One-shot slot release so abort + normal paths never double-unlock a key. */
function createReleaseLatch(slot: MutationSlot): () => void {
    let released = false
    return () => {
        if (released) {
            return
        }
        released = true
        slot.releaseNext()
        if (fileMutationQueues.get(slot.key) === slot.chained) {
            fileMutationQueues.delete(slot.key)
        }
    }
}

/**
 * After the caller aborted during registration, keep observing registration.
 * If a slot was inserted, wait for previous then release without running fn.
 * Registration failures stay observed and do not surface as unhandled.
 */
function continueAbortedRegistration(registration: Promise<MutationSlot>): void {
    void registration.then(
        (slot) => {
            const releaseSlot = createReleaseLatch(slot)
            void Promise.resolve(slot.previous).then(
                () => {
                    releaseSlot()
                },
                () => {
                    releaseSlot()
                },
            )
        },
        () => undefined,
    )
}

/**
 * Serialize file mutation operations targeting the same file key.
 * Registration itself is serial so concurrent realpath races cannot interleave
 * key insertion. Abort rejects the caller immediately while registration and
 * queue nodes continue in the background: skip fn, release on turn, keep the
 * registration queue healthy.
 */
export async function withFileMutationQueue<T>(
    absolutePath: string,
    realPath: RealPathResolver,
    fn: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (signal?.aborted) {
        throw abortError()
    }

    const registration = registrationQueue.then(async (): Promise<MutationSlot> => {
        const key = await getMutationQueueKey(absolutePath, realPath)
        const previous = fileMutationQueues.get(key) ?? Promise.resolve()
        let releaseNext!: () => void
        const gate = new Promise<void>((resolveGate) => {
            releaseNext = resolveGate
        })
        // Tail always settles successfully so one failure/abort cannot poison the key.
        const chained: Promise<unknown> = previous.then(
            () => gate,
            () => gate,
        )
        fileMutationQueues.set(key, chained)
        return { key, previous, chained, releaseNext }
    })

    // Keep registration queue healthy even when key resolution rejects.
    registrationQueue = registration.then(
        () => undefined,
        () => undefined,
    )

    let slot: MutationSlot
    try {
        slot = signal
            ? await abortableResult(registration, signal)
            : await registration
    } catch (error) {
        // Caller must not await registration further; background releases any inserted slot.
        continueAbortedRegistration(registration)
        throw error
    }

    const releaseSlot = createReleaseLatch(slot)
    const waitPrevious = slot.previous.then(
        () => undefined,
        () => undefined,
    )

    try {
        if (signal) {
            await abortableResult(waitPrevious, signal)
        } else {
            await waitPrevious
        }
    } catch (error) {
        // Aborted (or failed) while waiting: skip work, release when prior finishes.
        void waitPrevious.then(releaseSlot, releaseSlot)
        throw error
    }

    if (signal?.aborted) {
        releaseSlot()
        throw abortError()
    }

    try {
        return await fn()
    } finally {
        releaseSlot()
    }
}

/** Test-only: clear queue state between cases. */
export function __resetFileMutationQueuesForTests(): void {
    fileMutationQueues.clear()
    registrationQueue = Promise.resolve()
}
