import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    __resetFileMutationQueuesForTests,
    getMutationQueueKey,
    withFileMutationQueue,
} from './mutationQueue.js'

afterEach(() => {
    __resetFileMutationQueuesForTests()
})

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('mutation queue', () => {
    it('serializes operations for the same key', async () => {
        const order: string[] = []
        const gate = deferred()

        const first = withFileMutationQueue('/repo/a.txt', async (p) => p, async () => {
            order.push('first-start')
            await gate.promise
            order.push('first-end')
            return 1
        })

        await vi.waitFor(() => {
            expect(order).toEqual(['first-start'])
        })

        const second = withFileMutationQueue('/repo/a.txt', async (p) => p, async () => {
            order.push('second')
            return 2
        })

        // Second is registered but must not run until first releases.
        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual(['first-start'])

        gate.resolve()
        await expect(first).resolves.toBe(1)
        await expect(second).resolves.toBe(2)
        expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('runs different keys in parallel', async () => {
        const gateA = deferred()
        const gateB = deferred()
        let aStarted = false
        let bStarted = false

        const a = withFileMutationQueue('/repo/a.txt', async (p) => p, async () => {
            aStarted = true
            await gateA.promise
            return 'a'
        })
        const b = withFileMutationQueue('/repo/b.txt', async (p) => p, async () => {
            bStarted = true
            await gateB.promise
            return 'b'
        })

        await vi.waitFor(() => {
            expect(aStarted).toBe(true)
            expect(bStarted).toBe(true)
        })

        gateA.resolve()
        gateB.resolve()
        await expect(Promise.all([a, b])).resolves.toEqual(['a', 'b'])
    })

    it('uses realpath so symlink aliases share a key', async () => {
        const order: string[] = []
        const gate = deferred()
        const realPath = async (path: string) => {
            if (path === '/alias/link.txt' || path === '/real/target.txt') {
                return '/real/target.txt'
            }
            return path
        }

        const first = withFileMutationQueue('/alias/link.txt', realPath, async () => {
            order.push('first-start')
            await gate.promise
            order.push('first-end')
        })
        await vi.waitFor(() => {
            expect(order).toEqual(['first-start'])
        })

        const second = withFileMutationQueue('/real/target.txt', realPath, async () => {
            order.push('second')
        })

        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual(['first-start'])

        gate.resolve()
        await first
        await second
        expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('canonicalizes missing files via the nearest existing realpath parent', async () => {
        // /alias is a symlink to /real; children under either spelling are missing.
        const walker = async (path: string) => {
            if (path === '/alias/new/file.txt' || path === '/alias/new') {
                throw Object.assign(new Error('not found'), { code: 'ENOENT' })
            }
            if (path === '/alias') {
                return '/real'
            }
            if (path === '/real/new/file.txt' || path === '/real/new') {
                throw Object.assign(new Error('not found'), { code: 'ENOENT' })
            }
            return path
        }

        const aliasKey = await getMutationQueueKey('/alias/new/file.txt', walker)
        const realKey = await getMutationQueueKey('/real/new/file.txt', walker)
        expect(aliasKey).toBe('/real/new/file.txt')
        expect(realKey).toBe('/real/new/file.txt')
        expect(aliasKey).toBe(realKey)
    })

    it('serializes concurrent creates through a symlink parent under one key', async () => {
        const order: string[] = []
        const gate = deferred()
        const realPath = async (path: string) => {
            if (path === '/alias/new/file.txt' || path === '/alias/new') {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            }
            if (path === '/alias') {
                return '/real'
            }
            if (path === '/real/new/file.txt' || path === '/real/new') {
                throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
            }
            return path
        }

        const first = withFileMutationQueue('/alias/new/file.txt', realPath, async () => {
            order.push('first-start')
            await gate.promise
            order.push('first-end')
        })
        await vi.waitFor(() => {
            expect(order).toEqual(['first-start'])
        })

        const second = withFileMutationQueue('/real/new/file.txt', realPath, async () => {
            order.push('second')
        })
        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual(['first-start'])

        gate.resolve()
        await first
        await second
        expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('rejects non-missing realpath errors even when the message mentions not found', async () => {
        await expect(
            getMutationQueueKey('/secret/file.txt', async () => {
                throw Object.assign(new Error('permission denied: not found'), { code: 'EACCES' })
            }),
        ).rejects.toThrow(/permission denied/i)
    })

    it('rethrows EACCES with not-found text without message fallback', async () => {
        await expect(
            getMutationQueueKey('/locked/file.txt', async () => {
                throw Object.assign(new Error('The system cannot find the file specified.'), {
                    code: 'EACCES',
                })
            }),
        ).rejects.toMatchObject({ code: 'EACCES' })
    })

    it('treats empty code as authoritative and does not fall back to message', async () => {
        await expect(
            getMutationQueueKey('/empty-code/file.txt', async () => {
                throw Object.assign(new Error('no such file or directory'), { code: '' })
            }),
        ).rejects.toThrow(/no such file or directory/i)
    })

    it('does not treat business "resource not found" as a missing path', async () => {
        await expect(
            getMutationQueueKey('/api/item', async () => {
                throw new Error('resource not found')
            }),
        ).rejects.toThrow(/resource not found/i)
    })

    it('falls back on Windows code-less "file specified" errors and canonicalizes nearest parent', async () => {
        const walker = async (path: string) => {
            if (path === 'C:/alias/new/file.txt' || path === 'C:/alias/new') {
                throw new Error(
                    `real path ${path}: CreateFile ${path}: The system cannot find the file specified.`,
                )
            }
            if (path === 'C:/alias') {
                return 'C:/real'
            }
            if (path === 'C:/real/new/file.txt' || path === 'C:/real/new') {
                throw new Error(
                    `real path ${path}: CreateFile ${path}: The system cannot find the file specified.`,
                )
            }
            return path
        }

        const aliasKey = await getMutationQueueKey('C:/alias/new/file.txt', walker)
        const realKey = await getMutationQueueKey('C:/real/new/file.txt', walker)
        expect(aliasKey).toBe('C:/real/new/file.txt')
        expect(realKey).toBe('C:/real/new/file.txt')
        expect(aliasKey).toBe(realKey)
    })

    it('falls back on Windows code-less "path specified" errors and canonicalizes nearest parent', async () => {
        const walker = async (path: string) => {
            if (path === 'C:/alias/new/dir' || path === 'C:/alias/new') {
                throw new Error(
                    `real path ${path}: CreateFile ${path}: The system cannot find the path specified.`,
                )
            }
            if (path === 'C:/alias') {
                return 'C:/real'
            }
            if (path === 'C:/real/new/dir' || path === 'C:/real/new') {
                throw new Error(
                    `real path ${path}: CreateFile ${path}: The system cannot find the path specified.`,
                )
            }
            return path
        }

        const aliasKey = await getMutationQueueKey('C:/alias/new/dir', walker)
        const realKey = await getMutationQueueKey('C:/real/new/dir', walker)
        expect(aliasKey).toBe('C:/real/new/dir')
        expect(realKey).toBe('C:/real/new/dir')
        expect(aliasKey).toBe(realKey)
    })

    it('treats code-less Unix missing errors as missing via precise message match', async () => {
        const key = await getMutationQueueKey('/missing/unix.txt', async (path) => {
            if (path === '/missing/unix.txt' || path === '/missing') {
                throw new Error(`stat ${path}: no such file or directory`)
            }
            return path
        })
        expect(key).toBe('/missing/unix.txt')
    })

    it('treats code-less Unix "not a directory" as missing', async () => {
        const key = await getMutationQueueKey('/file-as-dir/child.txt', async (path) => {
            if (path === '/file-as-dir/child.txt' || path === '/file-as-dir') {
                throw new Error(`stat ${path}: not a directory`)
            }
            return path
        })
        expect(key).toBe('/file-as-dir/child.txt')
    })

    it('rejects immediately on abort while queued but does not poison later same-key work', async () => {
        const order: string[] = []
        const gate = deferred()
        const controller = new AbortController()

        const first = withFileMutationQueue(
            '/repo/queued.txt',
            async (p) => p,
            async () => {
                order.push('first-start')
                await gate.promise
                order.push('first-end')
                return 'first'
            },
        )

        await vi.waitFor(() => {
            expect(order).toEqual(['first-start'])
        })

        const second = withFileMutationQueue(
            '/repo/queued.txt',
            async (p) => p,
            async () => {
                order.push('second-ran')
                return 'second'
            },
            controller.signal,
        )

        await Promise.resolve()
        await Promise.resolve()
        controller.abort()
        await expect(second).rejects.toThrow(/aborted/i)
        expect(order).toEqual(['first-start'])

        gate.resolve()
        await expect(first).resolves.toBe('first')

        await expect(
            withFileMutationQueue('/repo/queued.txt', async (p) => p, async () => {
                order.push('third')
                return 'third'
            }),
        ).resolves.toBe('third')
        expect(order).toEqual(['first-start', 'first-end', 'third'])
        expect(order).not.toContain('second-ran')
    })

    it('rejects immediately on abort while blocked behind registrationQueue', async () => {
        const realPathGate = deferred()
        const controller = new AbortController()
        let firstEntered = false
        let secondFnRan = false

        const first = withFileMutationQueue(
            '/reg/a.txt',
            async (p) => {
                firstEntered = true
                await realPathGate.promise
                return p
            },
            async () => 'first',
        )

        await vi.waitFor(() => {
            expect(firstEntered).toBe(true)
        })

        const second = withFileMutationQueue(
            '/reg/b.txt',
            async (p) => p,
            async () => {
                secondFnRan = true
                return 'second'
            },
            controller.signal,
        )

        // Second is waiting on serial registration; abort must not wait for first realPath.
        await Promise.resolve()
        await Promise.resolve()
        controller.abort()
        await expect(second).rejects.toThrow(/aborted/i)
        expect(secondFnRan).toBe(false)

        realPathGate.resolve()
        await expect(first).resolves.toBe('first')

        await expect(
            withFileMutationQueue('/reg/c.txt', async (p) => p, async () => 'third'),
        ).resolves.toBe('third')
        expect(secondFnRan).toBe(false)
    })

    it('rejects immediately on abort while realPath hangs; never runs fn; later same-key continues', async () => {
        const realPathGate = deferred()
        const controller = new AbortController()
        let realPathCalls = 0
        let fnRan = false

        const op = withFileMutationQueue(
            '/repo/hang-realpath.txt',
            async (p) => {
                realPathCalls += 1
                await realPathGate.promise
                return p
            },
            async () => {
                fnRan = true
                return 'done'
            },
            controller.signal,
        )

        await vi.waitFor(() => {
            expect(realPathCalls).toBe(1)
        })

        controller.abort()
        await expect(op).rejects.toThrow(/aborted/i)
        expect(fnRan).toBe(false)

        realPathGate.resolve()
        // Background continuation must release the inserted slot after late realPath success.
        await vi.waitFor(async () => {
            await expect(
                withFileMutationQueue(
                    '/repo/hang-realpath.txt',
                    async (p) => p,
                    async () => 'next',
                ),
            ).resolves.toBe('next')
        })
        expect(fnRan).toBe(false)
    })

    it('observes late realPath rejection after abort without unhandled and keeps registration healthy', async () => {
        const realPathGate = deferred<never>()
        const controller = new AbortController()
        let realPathCalls = 0

        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            const op = withFileMutationQueue(
                '/repo/late-reject.txt',
                async () => {
                    realPathCalls += 1
                    return await realPathGate.promise
                },
                async () => 'should-not-run',
                controller.signal,
            )

            await vi.waitFor(() => {
                expect(realPathCalls).toBe(1)
            })

            controller.abort()
            await expect(op).rejects.toThrow(/aborted/i)

            realPathGate.reject(new Error('realpath exploded'))
            // Flush microtasks so a leaked rejection would surface.
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
            expect(unhandled).toEqual([])

            await expect(
                withFileMutationQueue('/repo/after-late-reject.txt', async (p) => p, async () => 'ok'),
            ).resolves.toBe('ok')
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('pairs abort listener add/remove with the same identity', async () => {
        const controller = new AbortController()
        const signal = controller.signal
        const added: Array<EventListenerOrEventListenerObject> = []
        const removed: Array<EventListenerOrEventListenerObject> = []

        const originalAdd = signal.addEventListener.bind(signal)
        const originalRemove = signal.removeEventListener.bind(signal)
        vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, options) => {
            if (type === 'abort') {
                added.push(listener as EventListenerOrEventListenerObject)
            }
            return originalAdd(type, listener, options as never)
        })
        vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
            if (type === 'abort') {
                removed.push(listener as EventListenerOrEventListenerObject)
            }
            return originalRemove(type, listener, options as never)
        })

        await expect(
            withFileMutationQueue('/repo/listener.txt', async (p) => p, async () => 'ok', signal),
        ).resolves.toBe('ok')

        expect(added.length).toBeGreaterThan(0)
        expect(removed.length).toBe(added.length)
        for (let i = 0; i < added.length; i += 1) {
            expect(removed[i]).toBe(added[i])
        }

        // Abort path must also remove the exact listener identity.
        added.length = 0
        removed.length = 0
        const gate = deferred()
        const abortController = new AbortController()
        const abortSignal = abortController.signal
        const origAdd2 = abortSignal.addEventListener.bind(abortSignal)
        const origRemove2 = abortSignal.removeEventListener.bind(abortSignal)
        vi.spyOn(abortSignal, 'addEventListener').mockImplementation((type, listener, options) => {
            if (type === 'abort') {
                added.push(listener as EventListenerOrEventListenerObject)
            }
            return origAdd2(type, listener, options as never)
        })
        vi.spyOn(abortSignal, 'removeEventListener').mockImplementation((type, listener, options) => {
            if (type === 'abort') {
                removed.push(listener as EventListenerOrEventListenerObject)
            }
            return origRemove2(type, listener, options as never)
        })

        const blocked = withFileMutationQueue(
            '/repo/listener-abort.txt',
            async (p) => p,
            async () => {
                await gate.promise
                return 'blocked'
            },
        )
        await vi.waitFor(async () => {
            // First op holds the key; second will wait with abort listener attached.
            await Promise.resolve()
        })

        const second = withFileMutationQueue(
            '/repo/listener-abort.txt',
            async (p) => p,
            async () => 'second',
            abortSignal,
        )
        await vi.waitFor(() => {
            expect(added.length).toBeGreaterThan(0)
        })

        abortController.abort()
        await expect(second).rejects.toThrow(/aborted/i)
        expect(removed.length).toBe(added.length)
        for (let i = 0; i < added.length; i += 1) {
            expect(removed[i]).toBe(added[i])
        }

        gate.resolve()
        await blocked
    })

    it('releases the queue when the operation fails', async () => {
        await expect(
            withFileMutationQueue('/repo/x.txt', async (p) => p, async () => {
                throw new Error('write failed')
            }),
        ).rejects.toThrow(/write failed/)

        const order: string[] = []
        await withFileMutationQueue('/repo/x.txt', async (p) => p, async () => {
            order.push('after-failure')
        })
        expect(order).toEqual(['after-failure'])
    })

    it('does not poison later work when a prior operation rejects', async () => {
        await expect(
            withFileMutationQueue('/repo/y.txt', async (p) => p, async () => {
                throw new Error('boom')
            }),
        ).rejects.toThrow(/boom/)

        await expect(
            withFileMutationQueue('/repo/y.txt', async (p) => p, async () => 'ok'),
        ).resolves.toBe('ok')
    })

    it('serializes registration itself under concurrent callers', async () => {
        const realPathStarts: string[] = []
        const realPathGate = deferred()
        let realPathCount = 0

        const realPath = async (path: string) => {
            realPathCount += 1
            realPathStarts.push(path)
            if (realPathCount === 1) {
                await realPathGate.promise
            }
            return path
        }

        const p1 = withFileMutationQueue('/a', realPath, async () => 1)
        const p2 = withFileMutationQueue('/b', realPath, async () => 2)

        await vi.waitFor(() => {
            expect(realPathStarts.length).toBe(1)
        })
        // Second registration must wait until the first finishes resolving its key.
        expect(realPathStarts).toEqual(['/a'])

        realPathGate.resolve()
        await expect(Promise.all([p1, p2])).resolves.toEqual([1, 2])
        expect(realPathStarts).toEqual(['/a', '/b'])
    })
})
