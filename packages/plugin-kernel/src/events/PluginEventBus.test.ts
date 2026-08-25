import { describe, expect, it, vi } from 'vitest'
import { PluginEventBus } from './PluginEventBus.js'

describe('PluginEventBus', () => {
    it('subscribes to events and receives emitted payloads', async () => {
        const bus = new PluginEventBus()
        const received: string[] = []

        const unsubscribe = bus.on<string>('agent:status', (payload) => {
            received.push(payload)
        })

        await bus.emit('agent:status', 'ready')
        await bus.emit('agent:status', 'busy')

        expect(received).toEqual(['ready', 'busy'])

        unsubscribe()
        await bus.emit('agent:status', 'idle')
        expect(received).toEqual(['ready', 'busy'])
    })

    it('handles multiple listeners for the same event', async () => {
        const bus = new PluginEventBus()
        const calls: string[] = []

        bus.on<number>('tick', (n) => {
            calls.push(`listener-1:${n}`)
        })
        bus.on<number>('tick', (n) => {
            calls.push(`listener-2:${n}`)
        })

        await bus.emit('tick', 1)
        expect(calls).toEqual(['listener-1:1', 'listener-2:1'])
    })

    it('isolates listener errors so one listener failure does not crash emit or stop other listeners', async () => {
        const bus = new PluginEventBus()
        const listenerCalls: string[] = []

        bus.on('action', () => {
            listenerCalls.push('first')
            throw new Error('sync listener error')
        })

        bus.on('action', async () => {
            listenerCalls.push('second')
            throw new Error('async listener error')
        })

        bus.on('action', () => {
            listenerCalls.push('third')
        })

        // emit should resolve without throwing
        await expect(bus.emit('action', { data: 'test' })).resolves.toBeUndefined()
        expect(listenerCalls).toEqual(['first', 'second', 'third'])
    })

    it('revokes listeners associated with an owner token', async () => {
        const bus = new PluginEventBus()
        const tokenA = Symbol('plugin-a')
        const tokenB = Symbol('plugin-b')
        const received: string[] = []

        bus.on<string>(
            'event',
            (msg) => {
                received.push(`A:${msg}`)
            },
            tokenA,
        )

        bus.on<string>(
            'event',
            (msg) => {
                received.push(`B:${msg}`)
            },
            tokenB,
        )

        await bus.emit('event', 'hello')
        expect(received).toEqual(['A:hello', 'B:hello'])

        bus.revokeOwner(tokenA)

        await bus.emit('event', 'world')
        expect(received).toEqual(['A:hello', 'B:hello', 'B:world'])
    })

    it('creates scoped event bus that automatically attaches owner token', async () => {
        const bus = new PluginEventBus()
        const token = Symbol('scoped-plugin')
        const scopedBus = bus.createScoped(token)
        const received: string[] = []

        scopedBus.on<string>('scoped:event', (data) => {
            received.push(data)
        })

        await scopedBus.emit('scoped:event', 'val-1')
        expect(received).toEqual(['val-1'])

        bus.revokeOwner(token)

        await bus.emit('scoped:event', 'val-2')
        expect(received).toEqual(['val-1'])
    })

    it('tracks listener counts accurately', () => {
        const bus = new PluginEventBus()
        expect(bus.listenerCount()).toBe(0)

        const unsub1 = bus.on('test-1', () => {})
        const unsub2 = bus.on('test-1', () => {})
        const unsub3 = bus.on('test-2', () => {})

        expect(bus.listenerCount()).toBe(3)
        expect(bus.listenerCount('test-1')).toBe(2)
        expect(bus.listenerCount('test-2')).toBe(1)

        unsub1()
        expect(bus.listenerCount('test-1')).toBe(1)
        expect(bus.listenerCount()).toBe(2)

        unsub2()
        unsub3()
        expect(bus.listenerCount()).toBe(0)
    })

    describe('StagedPluginEventBus', () => {
        it('isolates staged listeners and queued emits until commitListeners and flushEmits', async () => {
            const bus = new PluginEventBus()
            const token = Symbol('staged-token')
            const staged = bus.createStaged(token)

            const receivedStaged: string[] = []
            const receivedLive: string[] = []

            bus.on<string>('test:topic', (msg) => {
                receivedLive.push(`live:${msg}`)
            })

            const stagedUnsub = staged.on<string>('test:topic', (msg) => {
                receivedStaged.push(`staged:${msg}`)
            })

            // 1. Before commit: listenerCount must not increase
            expect(bus.listenerCount('test:topic')).toBe(1)

            // 2. Emitting on live bus does not trigger staged listener
            await bus.emit('test:topic', 'live-emit-1')
            expect(receivedStaged).toEqual([])
            expect(receivedLive).toEqual(['live:live-emit-1'])

            // 3. Staged emit does not trigger live listeners before flush
            await staged.emit('test:topic', 'staged-emit-1')
            expect(receivedLive).toEqual(['live:live-emit-1'])

            // 4. Commit listeners
            const disposers = staged.commitListeners()
            expect(disposers.length).toBe(1)
            expect(bus.listenerCount('test:topic')).toBe(2)

            // 5. Flush emits
            await staged.flushEmits()
            // Both live and newly committed staged listener receive the queued emit
            expect(receivedLive).toEqual(['live:live-emit-1', 'live:staged-emit-1'])
            expect(receivedStaged).toEqual(['staged:staged-emit-1'])

            // 6. Unsubscribe after commit works via the original disposer
            stagedUnsub()
            expect(bus.listenerCount('test:topic')).toBe(1)

            await bus.emit('test:topic', 'live-emit-2')
            expect(receivedStaged).toEqual(['staged:staged-emit-1'])
        })

        it('cancels staged listener if disposer called before commit', async () => {
            const bus = new PluginEventBus()
            const token = Symbol('staged-token')
            const staged = bus.createStaged(token)

            const received: string[] = []
            const unsub = staged.on<string>('event', (msg) => {
                received.push(msg)
            })

            // Dispose before commit
            unsub()

            staged.commitListeners()
            await staged.flushEmits()

            expect(bus.listenerCount('event')).toBe(0)
            await bus.emit('event', 'hello')
            expect(received).toEqual([])
        })

        it('discards staged listeners and emits on rollback', async () => {
            const bus = new PluginEventBus()
            const token = Symbol('staged-token')
            const staged = bus.createStaged(token)

            const liveReceived: string[] = []
            bus.on<string>('event', (msg) => {
                liveReceived.push(msg)
            })

            const stagedReceived: string[] = []
            staged.on<string>('event', (msg) => {
                stagedReceived.push(msg)
            })
            await staged.emit('event', 'from-staged')

            // Rollback
            staged.rollback()

            expect(bus.listenerCount('event')).toBe(1)
            await bus.emit('event', 'from-live')

            expect(stagedReceived).toEqual([])
            expect(liveReceived).toEqual(['from-live'])
        })
    })
})
