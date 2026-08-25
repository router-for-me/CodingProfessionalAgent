import { describe, expect, it, vi } from 'vitest'
import type {
    NativeBridgeBindings,
    NativeEvent,
    NativeEventSource,
    NativeOperation,
} from './types'
import { FakeNativeBridge } from './fakeNativeBridge'
import { ElectronNativeBridge } from './electronNativeBridge'

function createFakeEventSource(): NativeEventSource & {
    emit: (event: NativeEvent) => void
    listenerCount: () => number
} {
    const listeners = new Set<(event: NativeEvent) => void>()
    return {
        on(handler) {
            listeners.add(handler)
            return () => {
                listeners.delete(handler)
            }
        },
        emit(event) {
            for (const listener of [...listeners]) {
                listener(event)
            }
        },
        listenerCount() {
            return listeners.size
        },
    }
}

function createFakeBindings(
    overrides: Partial<NativeBridgeBindings> = {},
): NativeBridgeBindings & {
    cancelCalls: string[]
    openWebSocketCalls: unknown[]
    startProcessCalls: unknown[]
} {
    const cancelCalls: string[] = []
    const openWebSocketCalls: unknown[] = []
    const startProcessCalls: unknown[] = []

    return {
        cancelCalls,
        openWebSocketCalls,
        startProcessCalls,
        RuntimeInfo: vi.fn(async () => ({
            platform: 'darwin',
            userConfigDir: '/tmp/config',
            tempDir: '/tmp',
            homeDir: '/Users/test',
        })),
        ReadFile: vi.fn(async () => ({ dataBase64: '' })),
        WriteFile: vi.fn(async () => undefined),
        MkdirAll: vi.fn(async () => undefined),
        RemoveFile: vi.fn(async () => undefined),
        Stat: vi.fn(async () => ({
            name: 'x',
            size: 0,
            mode: 0,
            isDir: false,
        })),
        ReadDir: vi.fn(async () => []),
        RealPath: vi.fn(async (path: string) => path),
        LookPath: vi.fn(async () => '/bin/bash'),
        OpenWebSocket: vi.fn(async (req) => {
            openWebSocketCalls.push(req)
        }),
        SendWebSocket: vi.fn(async () => undefined),
        StartProcess: vi.fn(async (req) => {
            startProcessCalls.push(req)
            return { fullOutputPath: '/tmp/full.log' }
        }),
        CancelOperation: vi.fn(async (operationId: string) => {
            cancelCalls.push(operationId)
        }),
        SessionBroadcastRunStatus: vi.fn(async () => undefined),
        SessionBroadcastStreamEvent: vi.fn(async () => undefined),
        SessionAbortRun: vi.fn(async () => undefined),
        SessionGetActiveRuns: vi.fn(async () => []),
        SessionDelegateRun: vi.fn(async (req) => (req?.sessionId as string) || ''),
        ...overrides,
    }
}

async function collect(operation: NativeOperation): Promise<NativeEvent[]> {
    const events: NativeEvent[] = []
    for await (const event of operation.events) {
        events.push(event)
    }
    return events
}

describe('ElectronNativeBridge event routing', () => {
    it('routes strictly increasing events and ignores terminal late events', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-1')

        source.emit({ operationId: 'op-1', sequence: 1, kind: 'websocket-text', data: 'a' })
        source.emit({ operationId: 'op-1', sequence: 2, kind: 'done' })
        source.emit({ operationId: 'op-1', sequence: 3, kind: 'websocket-text', data: 'late' })

        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1 }),
            expect.objectContaining({ sequence: 2 }),
        ])
    })

    it('ignores out-of-order and duplicate sequences', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-2')

        source.emit({ operationId: 'op-2', sequence: 2, kind: 'websocket-text', data: 'gap' })
        source.emit({ operationId: 'op-2', sequence: 1, kind: 'websocket-text', data: 'first' })
        source.emit({ operationId: 'op-2', sequence: 1, kind: 'websocket-text', data: 'dup' })
        source.emit({ operationId: 'op-2', sequence: 3, kind: 'websocket-text', data: 'skip' })
        source.emit({ operationId: 'op-2', sequence: 2, kind: 'done', closeCode: 1000 })

        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, data: 'first' }),
            expect.objectContaining({ sequence: 2, kind: 'done' }),
        ])
    })

    it('ignores events for unknown operations', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('known')

        source.emit({ operationId: 'unknown', sequence: 1, kind: 'websocket-text', data: 'x' })
        source.emit({ operationId: 'known', sequence: 1, kind: 'done' })

        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ operationId: 'known', kind: 'done' }),
        ])
    })

    it('registers a single global listener and dispose unregisters it', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        expect(source.listenerCount()).toBe(1)

        bridge.observe('op-a')
        bridge.observe('op-b')
        expect(source.listenerCount()).toBe(1)

        await bridge.dispose()
        expect(source.listenerCount()).toBe(0)

        // Late emits after dispose must not throw or resurrect listeners.
        source.emit({ operationId: 'op-a', sequence: 1, kind: 'done' })
        expect(source.listenerCount()).toBe(0)
    })

    it('calls CancelOperation once when AbortSignal aborts', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings()
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const operation = bridge.observe('op-abort', controller.signal)
        controller.abort()
        controller.abort()

        // Give microtasks a chance to flush cancel.
        await Promise.resolve()
        await Promise.resolve()

        expect(bindings.cancelCalls).toEqual(['op-abort'])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(1)

        // Deliver terminal so the consumer can finish cleanly.
        source.emit({ operationId: 'op-abort', sequence: 1, kind: 'cancelled' })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ kind: 'cancelled' }),
        ])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(1)
    })

    it('manager cancel + bridge.dispose call CancelOperation once per op', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings()
        const bridge = new ElectronNativeBridge(bindings, source)

        bridge.observe('op-live-1')
        bridge.observe('op-live-2')

        // Manager-owned close cancels first.
        await bridge.cancel('op-live-1')
        await bridge.cancel('op-live-1') // idempotent
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(1)

        // Dispose must not re-cancel op-live-1; only cancel remaining live ops.
        await bridge.dispose()
        expect(bindings.cancelCalls).toEqual(['op-live-1', 'op-live-2'])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(2)

        // Idempotent dispose.
        await bridge.dispose()
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(2)
    })

    it('terminal accepted leaves live set; dispose cancel=0 and iterator still drains terminal', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings()
        const bridge = new ElectronNativeBridge(bindings, source)

        const operation = bridge.observe('op-terminal')
        source.emit({
            operationId: 'op-terminal',
            sequence: 1,
            kind: 'done',
        })

        // Dispose after terminal must not cancel.
        await bridge.dispose()
        expect(bindings.cancelCalls).toEqual([])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(0)

        // Consumer still drains the buffered terminal.
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ kind: 'done', operationId: 'op-terminal' }),
        ])
    })

    it('calls CancelOperation immediately when signal is already aborted on observe', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings()
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()
        controller.abort()

        const operation = bridge.observe('op-pre-aborted', controller.signal)
        await Promise.resolve()

        expect(bindings.cancelCalls).toEqual(['op-pre-aborted'])
        source.emit({ operationId: 'op-pre-aborted', sequence: 1, kind: 'cancelled' })
        await collect(operation)
    })

    it('defers already-aborted CancelOperation until OpenWebSocket binding succeeds', async () => {
        const source = createFakeEventSource()
        const cancelOrder: string[] = []
        let openResolve: (() => void) | undefined
        const openGate = new Promise<void>((resolve) => {
            openResolve = resolve
        })

        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async (req) => {
                cancelOrder.push(`open:${req.operationId}`)
                await openGate
            }),
            CancelOperation: vi.fn(async (operationId: string) => {
                cancelOrder.push(`cancel:${operationId}`)
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()
        controller.abort()

        const openPromise = bridge.openWebSocket({
            operationId: 'op-aborted-bind',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        await Promise.resolve()
        expect(cancelOrder).toEqual(['open:op-aborted-bind'])
        expect(bindings.CancelOperation).not.toHaveBeenCalled()

        openResolve?.()
        const operation = await openPromise
        await Promise.resolve()

        expect(cancelOrder).toEqual(['open:op-aborted-bind', 'cancel:op-aborted-bind'])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(1)

        source.emit({ operationId: 'op-aborted-bind', sequence: 1, kind: 'cancelled' })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ kind: 'cancelled' }),
        ])
    })

    it('ignores in-flight abort until binding succeeds, then cancels once', async () => {
        const source = createFakeEventSource()
        const cancelOrder: string[] = []
        let openResolve: (() => void) | undefined
        const openGate = new Promise<void>((resolve) => {
            openResolve = resolve
        })

        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async (req) => {
                cancelOrder.push(`open:${req.operationId}`)
                await openGate
            }),
            CancelOperation: vi.fn(async (operationId: string) => {
                cancelOrder.push(`cancel:${operationId}`)
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const openPromise = bridge.openWebSocket({
            operationId: 'op-inflight-abort',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        // Abort while OpenWebSocket is still in flight — Go has not registered yet.
        controller.abort()
        await Promise.resolve()
        expect(bindings.CancelOperation).not.toHaveBeenCalled()

        openResolve?.()
        const operation = await openPromise
        await Promise.resolve()

        expect(cancelOrder).toEqual(['open:op-inflight-abort', 'cancel:op-inflight-abort'])
        expect(bindings.CancelOperation).toHaveBeenCalledTimes(1)

        source.emit({ operationId: 'op-inflight-abort', sequence: 1, kind: 'cancelled' })
        await collect(operation)
    })

    it('does not cancel when binding rejects even if the signal aborts during the call', async () => {
        const source = createFakeEventSource()
        let openReject: ((error: Error) => void) | undefined
        const openGate = new Promise<void>((_resolve, reject) => {
            openReject = reject
        })

        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async () => openGate),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const openPromise = bridge.openWebSocket({
            operationId: 'op-bind-fail-abort',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        controller.abort()
        openReject?.(new Error('dial failed'))

        await expect(openPromise).rejects.toThrow(/dial failed/)
        await Promise.resolve()
        expect(bindings.CancelOperation).not.toHaveBeenCalled()

        // Queue was cleaned up; a later observe can restart at sequence 1.
        const operation = bridge.observe('op-bind-fail-abort')
        source.emit({ operationId: 'op-bind-fail-abort', sequence: 1, kind: 'done' })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('fails the queue observably when abort CancelOperation rejects', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings({
            CancelOperation: vi.fn(async () => {
                throw new Error('cancel transport failed')
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const operation = await bridge.openWebSocket({
            operationId: 'op-cancel-reject',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        const iterator = operation.events[Symbol.asyncIterator]()
        const pending = iterator.next()

        // Ensure the waiter is registered before abort.
        await Promise.resolve()
        controller.abort()

        await expect(pending).rejects.toThrow(/cancel transport failed/)
        // A second next must also surface the failure / closed state, not hang.
        await expect(iterator.next()).rejects.toThrow(/cancel transport failed/)
    })

    it('releases a pending next waiter when return() is called', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-return-pending')

        const iterator = operation.events[Symbol.asyncIterator]()
        const pending = iterator.next()

        await Promise.resolve()
        await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
        await expect(pending).resolves.toEqual({ done: true, value: undefined })

        // Queue released — restart sequence from 1.
        const restarted = bridge.observe('op-return-pending')
        source.emit({ operationId: 'op-return-pending', sequence: 1, kind: 'done' })
        await expect(collect(restarted)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('releases a pending next waiter when throw() is called', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-throw-pending')

        const iterator = operation.events[Symbol.asyncIterator]()
        const pending = iterator.next()

        await Promise.resolve()
        await expect(iterator.throw?.(new Error('consumer stop'))).rejects.toThrow(/consumer stop/)
        await expect(pending).resolves.toEqual({ done: true, value: undefined })

        const restarted = bridge.observe('op-throw-pending')
        source.emit({ operationId: 'op-throw-pending', sequence: 1, kind: 'done' })
        await expect(collect(restarted)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('releases the queue when return() is called before any next()', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-return-before-next')

        const iterator = operation.events[Symbol.asyncIterator]()
        await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })

        const restarted = bridge.observe('op-return-before-next')
        source.emit({ operationId: 'op-return-before-next', sequence: 1, kind: 'done' })
        await expect(collect(restarted)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('rejects a second async iterator on the same operation', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-single-consumer')

        const first = operation.events[Symbol.asyncIterator]()
        expect(() => operation.events[Symbol.asyncIterator]()).toThrow(/single consumer|already/i)

        source.emit({ operationId: 'op-single-consumer', sequence: 1, kind: 'done' })
        await expect(first.next()).resolves.toMatchObject({
            done: false,
            value: expect.objectContaining({ kind: 'done' }),
        })
        await expect(first.next()).resolves.toEqual({ done: true, value: undefined })

        // Still single-consumer after the first iterator finishes.
        expect(() => operation.events[Symbol.asyncIterator]()).toThrow(/single consumer|already/i)
    })

    it('releases the operation queue when the consumer returns early', async () => {
        const source = createFakeEventSource()
        const bridge = new ElectronNativeBridge(createFakeBindings(), source)
        const operation = bridge.observe('op-unsub')

        source.emit({ operationId: 'op-unsub', sequence: 1, kind: 'websocket-text', data: 'a' })
        source.emit({ operationId: 'op-unsub', sequence: 2, kind: 'websocket-text', data: 'b' })

        const iterator = operation.events[Symbol.asyncIterator]()
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: expect.objectContaining({ data: 'a' }),
        })
        await iterator.return?.()

        // After unsubscribe the queue is gone; a new observe can restart sequences.
        const restarted = bridge.observe('op-unsub')
        source.emit({ operationId: 'op-unsub', sequence: 1, kind: 'done' })
        await expect(collect(restarted)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('establishes the operation queue before OpenWebSocket so early events are not lost', async () => {
        const source = createFakeEventSource()
        let openResolve: (() => void) | undefined
        const openGate = new Promise<void>((resolve) => {
            openResolve = resolve
        })

        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async (req) => {
                // Emit before the binding promise settles.
                source.emit({
                    operationId: req.operationId,
                    sequence: 1,
                    kind: 'websocket-open',
                })
                source.emit({
                    operationId: req.operationId,
                    sequence: 2,
                    kind: 'done',
                    closeCode: 1000,
                })
                await openGate
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)

        const openPromise = bridge.openWebSocket({
            operationId: 'op-early',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
        })
        openResolve?.()
        const operation = await openPromise

        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'websocket-open' }),
            expect.objectContaining({ sequence: 2, kind: 'done' }),
        ])
    })

    it('cleans up the queue when OpenWebSocket fails', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async () => {
                throw new Error('dial failed')
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)

        await expect(
            bridge.openWebSocket({
                operationId: 'op-fail',
                url: 'ws://example.test',
                connectTimeoutMs: 1000,
            }),
        ).rejects.toThrow(/dial failed/)

        // Failure cleanup must drop the queue so a later observe starts clean.
        const operation = bridge.observe('op-fail')
        source.emit({ operationId: 'op-fail', sequence: 1, kind: 'done' })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'done' }),
        ])
    })

    it('establishes the queue before StartProcess and returns fullOutputPath', async () => {
        const source = createFakeEventSource()
        let startResolve: (() => void) | undefined
        const startGate = new Promise<void>((resolve) => {
            startResolve = resolve
        })

        const bindings = createFakeBindings({
            StartProcess: vi.fn(async (req) => {
                source.emit({
                    operationId: req.operationId,
                    sequence: 1,
                    kind: 'process-stdout',
                    data: btoa('hi'),
                    encoding: 'base64',
                })
                source.emit({
                    operationId: req.operationId,
                    sequence: 2,
                    kind: 'done',
                    exitCode: 0,
                })
                await startGate
                return { fullOutputPath: '/tmp/proc.log' }
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)

        const startPromise = bridge.startProcess({
            operationId: 'op-proc',
            executable: '/bin/echo',
            args: ['hi'],
            cwd: '/tmp',
        })
        startResolve?.()
        const operation = await startPromise

        expect(operation.fullOutputPath).toBe('/tmp/proc.log')
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'process-stdout' }),
            expect.objectContaining({ sequence: 2, kind: 'done', exitCode: 0 }),
        ])
    })

    it('cleans up the queue when StartProcess fails', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings({
            StartProcess: vi.fn(async () => {
                throw new Error('spawn failed')
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)

        await expect(
            bridge.startProcess({
                operationId: 'op-proc-fail',
                executable: '/bin/false',
            }),
        ).rejects.toThrow(/spawn failed/)

        const operation = bridge.observe('op-proc-fail')
        source.emit({ operationId: 'op-proc-fail', sequence: 1, kind: 'error', error: 'spawn failed' })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ kind: 'error' }),
        ])
    })

    it('converts base64 file payloads with multi-byte UTF-8 across chunk boundaries', async () => {
        // 100 multi-byte characters so encoding spans multiple base64 quanta.
        const text = 'Hello €€€😀'.repeat(20)
        const encoder = new TextEncoder()
        const bytes = encoder.encode(text)
        let binary = ''
        for (let i = 0; i < bytes.length; i += 1) {
            binary += String.fromCharCode(bytes[i]!)
        }
        const dataBase64 = btoa(binary)

        const written: Array<{ path: string; dataBase64: string }> = []
        const bindings = createFakeBindings({
            ReadFile: vi.fn(async () => ({ dataBase64 })),
            WriteFile: vi.fn(async (path, encoded) => {
                written.push({ path, dataBase64: encoded })
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, createFakeEventSource())

        const read = await bridge.readFile('/tmp/utf8.txt')
        expect(new TextDecoder().decode(read)).toBe(text)
        expect(read).toBeInstanceOf(Uint8Array)

        await bridge.writeFile('/tmp/utf8-out.txt', read)
        expect(written).toHaveLength(1)
        expect(written[0]?.dataBase64).toBe(dataBase64)

        // Round-trip through write → decode should restore exact bytes.
        const redecodedBinary = atob(written[0]!.dataBase64)
        const redecoded = new Uint8Array(redecodedBinary.length)
        for (let i = 0; i < redecodedBinary.length; i += 1) {
            redecoded[i] = redecodedBinary.charCodeAt(i)
        }
        expect(Array.from(redecoded)).toEqual(Array.from(bytes))
    })

    it('maps only executable-not-found LookPath errors to null and rethrows others', async () => {
        const notFoundBindings = createFakeBindings({
            LookPath: vi.fn(async () => {
                throw new Error('look path "missing": executable file not found in $PATH')
            }),
            ReadDir: vi.fn(async () => null as unknown as []),
        })
        const notFoundBridge = new ElectronNativeBridge(notFoundBindings, createFakeEventSource())
        await expect(notFoundBridge.lookPath('missing')).resolves.toBeNull()
        await expect(notFoundBridge.readDir('/empty')).resolves.toEqual([])

        const windowsNotFound = createFakeBindings({
            LookPath: vi.fn(async () => {
                throw new Error('look path "tool": executable file not found in %PATH%')
            }),
        })
        await expect(new ElectronNativeBridge(windowsNotFound, createFakeEventSource()).lookPath('tool')).resolves.toBeNull()

        const permissionBindings = createFakeBindings({
            LookPath: vi.fn(async () => {
                throw new Error('look path "secret": permission denied')
            }),
        })
        await expect(
            new ElectronNativeBridge(permissionBindings, createFakeEventSource()).lookPath('secret'),
        ).rejects.toThrow(/permission denied/)

        const unknownBindings = createFakeBindings({
            LookPath: vi.fn(async () => {
                throw new Error('look path "x": unexpected bridge failure')
            }),
        })
        await expect(
            new ElectronNativeBridge(unknownBindings, createFakeEventSource()).lookPath('x'),
        ).rejects.toThrow(/unexpected bridge failure/)
    })

    it('forwards cancel to CancelOperation', async () => {
        const bindings = createFakeBindings()
        const bridge = new ElectronNativeBridge(bindings, createFakeEventSource())
        await bridge.cancel('op-x')
        expect(bindings.cancelCalls).toEqual(['op-x'])
    })

    it('does not cancel when terminal arrives during bind even if signal is already aborted', async () => {
        const source = createFakeEventSource()
        let openResolve: (() => void) | undefined
        const openGate = new Promise<void>((resolve) => {
            openResolve = resolve
        })

        const bindings = createFakeBindings({
            OpenWebSocket: vi.fn(async (req) => {
                // Terminal arrives while the binding is still in flight.
                source.emit({
                    operationId: req.operationId,
                    sequence: 1,
                    kind: 'websocket-text',
                    data: 'pre-terminal',
                })
                source.emit({
                    operationId: req.operationId,
                    sequence: 2,
                    kind: 'done',
                    closeCode: 1000,
                })
                await openGate
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()
        controller.abort()

        const openPromise = bridge.openWebSocket({
            operationId: 'op-term-during-bind',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        await Promise.resolve()
        openResolve?.()
        const operation = await openPromise
        await Promise.resolve()
        await Promise.resolve()

        // Terminal already settled the operation — never arm / fire CancelOperation.
        expect(bindings.CancelOperation).not.toHaveBeenCalled()
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, data: 'pre-terminal' }),
            expect.objectContaining({ sequence: 2, kind: 'done' }),
        ])
    })

    it('drains buffered events before rejecting when cancel fails', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings({
            CancelOperation: vi.fn(async () => {
                throw new Error('cancel after buffer')
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const operation = await bridge.openWebSocket({
            operationId: 'op-buffer-then-fail',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        // Buffer events before any consumer / before cancel fails.
        source.emit({
            operationId: 'op-buffer-then-fail',
            sequence: 1,
            kind: 'websocket-text',
            data: 'cached-1',
        })
        source.emit({
            operationId: 'op-buffer-then-fail',
            sequence: 2,
            kind: 'websocket-text',
            data: 'cached-2',
        })

        controller.abort()
        await Promise.resolve()
        await Promise.resolve()

        const iterator = operation.events[Symbol.asyncIterator]()
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: expect.objectContaining({ data: 'cached-1' }),
        })
        await expect(iterator.next()).resolves.toMatchObject({
            done: false,
            value: expect.objectContaining({ data: 'cached-2' }),
        })
        await expect(iterator.next()).rejects.toThrow(/cancel after buffer/)
        await expect(iterator.next()).rejects.toThrow(/cancel after buffer/)
    })

    it('does not let late cancel rejection overwrite an already accepted terminal', async () => {
        const source = createFakeEventSource()
        let cancelReject: ((error: Error) => void) | undefined
        const cancelGate = new Promise<void>((_resolve, reject) => {
            cancelReject = reject
        })

        const bindings = createFakeBindings({
            CancelOperation: vi.fn(async () => cancelGate),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()

        const operation = await bridge.openWebSocket({
            operationId: 'op-term-beats-cancel',
            url: 'ws://example.test',
            connectTimeoutMs: 1000,
            signal: controller.signal,
        })

        controller.abort()
        await Promise.resolve()

        // Terminal wins while cancel is still in flight.
        source.emit({
            operationId: 'op-term-beats-cancel',
            sequence: 1,
            kind: 'done',
            closeCode: 1000,
        })

        cancelReject?.(new Error('late cancel failed'))
        await Promise.resolve()
        await Promise.resolve()

        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ kind: 'done', closeCode: 1000 }),
        ])
    })

    it('observe cancel rejection is not unhandled and is visible on the iterator', async () => {
        const source = createFakeEventSource()
        const bindings = createFakeBindings({
            CancelOperation: vi.fn(async () => {
                throw new Error('observe cancel failed')
            }),
        })
        const bridge = new ElectronNativeBridge(bindings, source)
        const controller = new AbortController()
        controller.abort()

        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)
        try {
            const operation = bridge.observe('op-observe-cancel', controller.signal)
            // Flush microtasks from void activateAbort.
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()

            expect(unhandled).toEqual([])

            const iterator = operation.events[Symbol.asyncIterator]()
            await expect(iterator.next()).rejects.toThrow(/observe cancel failed/)
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('settles concurrent next waiters for normal, terminal, return, throw, and failure', async () => {
        const source = createFakeEventSource()

        // --- normal event: only the first waiter receives it ---
        {
            const bridge = new ElectronNativeBridge(createFakeBindings(), source)
            const operation = bridge.observe('op-concurrent-normal')
            const iterator = operation.events[Symbol.asyncIterator]()
            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()

            await Promise.resolve()
            source.emit({
                operationId: 'op-concurrent-normal',
                sequence: 1,
                kind: 'websocket-text',
                data: 'only-one',
            })

            await expect(first).resolves.toMatchObject({
                done: false,
                value: expect.objectContaining({ data: 'only-one' }),
            })

            // Remaining waiters must still be pending until more input arrives.
            let secondSettled = false
            void second.then(() => {
                secondSettled = true
            })
            await Promise.resolve()
            expect(secondSettled).toBe(false)

            source.emit({
                operationId: 'op-concurrent-normal',
                sequence: 2,
                kind: 'websocket-text',
                data: 'two',
            })
            source.emit({
                operationId: 'op-concurrent-normal',
                sequence: 3,
                kind: 'websocket-text',
                data: 'three',
            })
            await expect(second).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'two' }),
            })
            await expect(third).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'three' }),
            })
            await iterator.return?.()
        }

        // --- terminal: one waiter gets terminal, remaining resolve done ---
        {
            const bridge = new ElectronNativeBridge(createFakeBindings(), source)
            const operation = bridge.observe('op-concurrent-terminal')
            const iterator = operation.events[Symbol.asyncIterator]()
            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()

            await Promise.resolve()
            source.emit({
                operationId: 'op-concurrent-terminal',
                sequence: 1,
                kind: 'done',
            })

            await expect(first).resolves.toMatchObject({
                done: false,
                value: expect.objectContaining({ kind: 'done' }),
            })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- return(): all pending waiters resolve done ---
        {
            const bridge = new ElectronNativeBridge(createFakeBindings(), source)
            const operation = bridge.observe('op-concurrent-return')
            const iterator = operation.events[Symbol.asyncIterator]()
            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()

            await Promise.resolve()
            await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
            await expect(first).resolves.toEqual({ done: true, value: undefined })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- throw(): all pending waiters resolve done ---
        {
            const bridge = new ElectronNativeBridge(createFakeBindings(), source)
            const operation = bridge.observe('op-concurrent-throw')
            const iterator = operation.events[Symbol.asyncIterator]()
            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()

            await Promise.resolve()
            await expect(iterator.throw?.(new Error('consumer throw'))).rejects.toThrow(/consumer throw/)
            await expect(first).resolves.toEqual({ done: true, value: undefined })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- failure: all pending waiters reject after buffer drain ---
        {
            const bindings = createFakeBindings({
                CancelOperation: vi.fn(async () => {
                    throw new Error('concurrent cancel fail')
                }),
            })
            const bridge = new ElectronNativeBridge(bindings, source)
            const controller = new AbortController()
            const operation = await bridge.openWebSocket({
                operationId: 'op-concurrent-fail',
                url: 'ws://example.test',
                connectTimeoutMs: 1000,
                signal: controller.signal,
            })
            const iterator = operation.events[Symbol.asyncIterator]()
            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()

            await Promise.resolve()
            controller.abort()

            await expect(first).rejects.toThrow(/concurrent cancel fail/)
            await expect(second).rejects.toThrow(/concurrent cancel fail/)
            await expect(third).rejects.toThrow(/concurrent cancel fail/)
        }
    })
})

describe('ElectronNativeBridge / FakeNativeBridge concurrent iterator parity', () => {
    it('FakeNativeBridge settles concurrent next waiters for normal, terminal, return, throw, and failure', async () => {
        // --- normal ---
        {
            const bridge = new FakeNativeBridge()
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const operation = await bridge.openWebSocket({
                operationId: 'fake-concurrent-normal',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            const iterator = operation.events[Symbol.asyncIterator]()
            // First frame already buffered (open).
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })

            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()
            await Promise.resolve()

            bridge.emit('fake-concurrent-normal', {
                kind: 'websocket-text',
                data: 'only-one',
            })
            await expect(first).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'only-one' }),
            })

            let secondSettled = false
            void second.then(() => {
                secondSettled = true
            })
            await Promise.resolve()
            expect(secondSettled).toBe(false)

            bridge.emit('fake-concurrent-normal', {
                kind: 'websocket-text',
                data: 'two',
            })
            bridge.emit('fake-concurrent-normal', {
                kind: 'websocket-text',
                data: 'three',
            })
            await expect(second).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'two' }),
            })
            await expect(third).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'three' }),
            })
            await iterator.return?.()
        }

        // --- terminal ---
        {
            const bridge = new FakeNativeBridge()
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const operation = await bridge.openWebSocket({
                operationId: 'fake-concurrent-terminal',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            const iterator = operation.events[Symbol.asyncIterator]()
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })

            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()
            await Promise.resolve()

            bridge.emit('fake-concurrent-terminal', { kind: 'done', closeCode: 1000 })
            await expect(first).resolves.toMatchObject({
                done: false,
                value: expect.objectContaining({ kind: 'done' }),
            })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- return ---
        {
            const bridge = new FakeNativeBridge()
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const operation = await bridge.openWebSocket({
                operationId: 'fake-concurrent-return',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            const iterator = operation.events[Symbol.asyncIterator]()
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })

            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()
            await Promise.resolve()
            await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
            await expect(first).resolves.toEqual({ done: true, value: undefined })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- throw ---
        {
            const bridge = new FakeNativeBridge()
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const operation = await bridge.openWebSocket({
                operationId: 'fake-concurrent-throw',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            const iterator = operation.events[Symbol.asyncIterator]()
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })

            const first = iterator.next()
            const second = iterator.next()
            const third = iterator.next()
            await Promise.resolve()
            await expect(iterator.throw?.(new Error('fake consumer throw'))).rejects.toThrow(
                /fake consumer throw/,
            )
            await expect(first).resolves.toEqual({ done: true, value: undefined })
            await expect(second).resolves.toEqual({ done: true, value: undefined })
            await expect(third).resolves.toEqual({ done: true, value: undefined })
        }

        // --- failure (buffer drain then reject all) ---
        {
            const bridge = new FakeNativeBridge()
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const operation = await bridge.openWebSocket({
                operationId: 'fake-concurrent-fail',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            // Buffer an extra event, then fail without clearing the FIFO buffer.
            bridge.emit('fake-concurrent-fail', {
                kind: 'websocket-text',
                data: 'cached',
            })
            bridge.fail('fake-concurrent-fail', new Error('fake stream failed'))

            const iterator = operation.events[Symbol.asyncIterator]()
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })
            await expect(iterator.next()).resolves.toMatchObject({
                value: expect.objectContaining({ data: 'cached' }),
            })
            await expect(iterator.next()).rejects.toThrow(/fake stream failed/)

            // Concurrent waiters after buffer is empty also reject.
            const bridge2 = new FakeNativeBridge()
            bridge2.queueWebSocket({
                frames: [{ kind: 'websocket-open' }],
                hold: true,
            })
            const op2 = await bridge2.openWebSocket({
                operationId: 'fake-concurrent-fail-waiters',
                url: 'ws://example.test',
                connectTimeoutMs: 500,
            })
            const it2 = op2.events[Symbol.asyncIterator]()
            await expect(it2.next()).resolves.toMatchObject({
                value: expect.objectContaining({ kind: 'websocket-open' }),
            })
            const p1 = it2.next()
            const p2 = it2.next()
            const p3 = it2.next()
            await Promise.resolve()
            bridge2.fail('fake-concurrent-fail-waiters', new Error('fake waiter fail'))
            await expect(p1).rejects.toThrow(/fake waiter fail/)
            await expect(p2).rejects.toThrow(/fake waiter fail/)
            await expect(p3).rejects.toThrow(/fake waiter fail/)
        }
    })
})

describe('FakeNativeBridge', () => {
    it('stores files, records calls, and supports deterministic process streams', async () => {
        const bridge = new FakeNativeBridge()
        const payload = new TextEncoder().encode('hello world €')

        await bridge.writeFile('/repo/a.txt', payload)
        const readBack = await bridge.readFile('/repo/a.txt')
        expect(Array.from(readBack)).toEqual(Array.from(payload))
        await bridge.mkdirAll('/repo/nested')
        await bridge.removeFile('/repo/a.txt')
        await expect(bridge.readFile('/repo/a.txt')).rejects.toThrow()

        bridge.setLookPath('bash', '/bin/bash')
        await expect(bridge.lookPath('bash')).resolves.toBe('/bin/bash')
        await expect(bridge.lookPath('missing')).resolves.toBeNull()

        bridge.queueProcess({
            chunks: ['line1\n', 'line2\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/full.log',
        })

        const processOp = await bridge.startProcess({
            operationId: 'p1',
            executable: '/bin/echo',
            args: ['hi'],
            cwd: '/repo',
        })
        expect(processOp.fullOutputPath).toBe('/tmp/full.log')

        const events = await collect(processOp)
        expect(events.map((event) => event.kind)).toEqual([
            'process-stdout',
            'process-stdout',
            'done',
        ])
        expect(events[2]).toMatchObject({ exitCode: 0, sequence: 3 })

        expect(bridge.calls.some((call) => call.method === 'writeFile')).toBe(true)
        expect(bridge.calls.some((call) => call.method === 'startProcess')).toBe(true)
    })

    it('streams queued websocket frames and honors cancel with a single cancelled terminal', async () => {
        const bridge = new FakeNativeBridge()
        bridge.queueWebSocket({
            frames: [
                { kind: 'websocket-open' },
                { kind: 'websocket-text', data: 'ping' },
                { kind: 'done', closeCode: 1000, reason: 'normal' },
            ],
        })

        const operation = await bridge.openWebSocket({
            operationId: 'ws-1',
            url: 'ws://example.test',
            connectTimeoutMs: 500,
        })
        await expect(collect(operation)).resolves.toEqual([
            expect.objectContaining({ sequence: 1, kind: 'websocket-open' }),
            expect.objectContaining({ sequence: 2, kind: 'websocket-text', data: 'ping' }),
            expect.objectContaining({ sequence: 3, kind: 'done', closeCode: 1000 }),
        ])

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }],
            hold: true,
        })
        const controller = new AbortController()
        const cancellable = await bridge.openWebSocket({
            operationId: 'ws-2',
            url: 'ws://example.test',
            connectTimeoutMs: 500,
            signal: controller.signal,
        })
        controller.abort()
        await expect(collect(cancellable)).resolves.toEqual([
            expect.objectContaining({ kind: 'websocket-open' }),
            expect.objectContaining({ kind: 'cancelled' }),
        ])
        expect(bridge.calls.filter((call) => call.method === 'cancel')).toHaveLength(1)
    })

    it('supports abort on process operations without real timers', async () => {
        const bridge = new FakeNativeBridge()
        bridge.queueProcess({
            chunks: ['partial\n'],
            exitCode: 0,
            fullOutputPath: '/tmp/x.log',
            hold: true,
        })

        const controller = new AbortController()
        const operation = await bridge.startProcess({
            operationId: 'p-abort',
            executable: '/bin/sleep',
            signal: controller.signal,
        })
        controller.abort()

        const events = await collect(operation)
        expect(events.some((event) => event.kind === 'cancelled')).toBe(true)
        expect(events.filter((event) => event.kind === 'cancelled')).toHaveLength(1)
    })

    it('emits process stdout/stderr as browser-safe base64 like Go', async () => {
        const bridge = new FakeNativeBridge()
        const text = 'hello world €'
        bridge.queueProcess({
            chunks: [text],
            stderrChunks: ['err-line'],
            exitCode: 0,
            fullOutputPath: '/tmp/b64.log',
        })

        const operation = await bridge.startProcess({
            operationId: 'p-b64',
            executable: '/bin/echo',
        })
        const events = await collect(operation)

        expect(events[0]).toMatchObject({
            kind: 'process-stdout',
            encoding: 'base64',
        })
        expect(events[1]).toMatchObject({
            kind: 'process-stderr',
            encoding: 'base64',
        })

        const decode = (data: string | undefined) => {
            const binary = atob(data ?? '')
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i)
            }
            return new TextDecoder().decode(bytes)
        }
        expect(decode(events[0]?.data)).toBe(text)
        expect(decode(events[1]?.data)).toBe('err-line')
    })

    it('does not record cancel when abort arrives after a terminal event', async () => {
        const bridge = new FakeNativeBridge()
        bridge.queueProcess({
            chunks: ['done-soon'],
            exitCode: 0,
            fullOutputPath: '/tmp/term.log',
        })

        const controller = new AbortController()
        const operation = await bridge.startProcess({
            operationId: 'p-late-abort',
            executable: '/bin/echo',
            signal: controller.signal,
        })

        // Drain terminal first.
        await collect(operation)
        const cancelsBefore = bridge.calls.filter((call) => call.method === 'cancel').length

        controller.abort()
        await Promise.resolve()

        const cancelsAfter = bridge.calls.filter((call) => call.method === 'cancel').length
        expect(cancelsAfter).toBe(cancelsBefore)
    })

    it('flush completes held websocket/process streams exactly once', async () => {
        const bridge = new FakeNativeBridge()

        bridge.queueWebSocket({
            frames: [
                { kind: 'websocket-open' },
                { kind: 'websocket-text', data: 'held' },
                { kind: 'done', closeCode: 1000 },
            ],
            hold: true,
        })
        const wsOp = await bridge.openWebSocket({
            operationId: 'ws-flush',
            url: 'ws://example.test',
            connectTimeoutMs: 500,
        })

        const wsIterator = wsOp.events[Symbol.asyncIterator]()
        await expect(wsIterator.next()).resolves.toMatchObject({
            value: expect.objectContaining({ kind: 'websocket-open' }),
        })

        bridge.flush('ws-flush')
        await expect(wsIterator.next()).resolves.toMatchObject({
            value: expect.objectContaining({ kind: 'websocket-text', data: 'held' }),
        })
        await expect(wsIterator.next()).resolves.toMatchObject({
            value: expect.objectContaining({ kind: 'done', closeCode: 1000 }),
        })
        await expect(wsIterator.next()).resolves.toEqual({ done: true, value: undefined })

        // Second flush must not re-emit a terminal.
        bridge.flush('ws-flush')

        bridge.queueProcess({
            chunks: ['partial'],
            exitCode: 7,
            fullOutputPath: '/tmp/flush.log',
            hold: true,
        })
        const procOp = await bridge.startProcess({
            operationId: 'p-flush',
            executable: '/bin/echo',
        })
        const procIterator = procOp.events[Symbol.asyncIterator]()
        await expect(procIterator.next()).resolves.toMatchObject({
            value: expect.objectContaining({ kind: 'process-stdout' }),
        })

        bridge.flush('p-flush')
        await expect(procIterator.next()).resolves.toMatchObject({
            value: expect.objectContaining({ kind: 'done', exitCode: 7 }),
        })
        await expect(procIterator.next()).resolves.toEqual({ done: true, value: undefined })
        bridge.flush('p-flush')
    })

    it('flush after cancel does not emit a second terminal', async () => {
        const bridge = new FakeNativeBridge()
        bridge.queueProcess({
            chunks: ['x'],
            exitCode: 0,
            fullOutputPath: '/tmp/c.log',
            hold: true,
        })

        const operation = await bridge.startProcess({
            operationId: 'p-cancel-flush',
            executable: '/bin/sleep',
        })
        await bridge.cancel('p-cancel-flush')
        bridge.flush('p-cancel-flush')

        const events = await collect(operation)
        expect(events.filter((event) => event.kind === 'cancelled' || event.kind === 'done')).toEqual([
            expect.objectContaining({ kind: 'cancelled' }),
        ])
    })

    it('rejects a second async iterator like production', async () => {
        const bridge = new FakeNativeBridge()
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, { kind: 'done', closeCode: 1000 }],
        })
        const operation = await bridge.openWebSocket({
            operationId: 'ws-single',
            url: 'ws://example.test',
            connectTimeoutMs: 500,
        })

        const first = operation.events[Symbol.asyncIterator]()
        expect(() => operation.events[Symbol.asyncIterator]()).toThrow(/single consumer|already/i)
        await first.return?.()
    })

    it('supports startProfiling, stopProfiling, getProfilingReport, and saveFile on FakeNativeBridge and ElectronNativeBridge', async () => {
        const fakeBridge = new FakeNativeBridge()
        const startFake = await fakeBridge.startProfiling!({ durationMs: 1000, target: 'all' })
        expect(startFake.ok).toBe(true)

        const stopFake = await fakeBridge.stopProfiling!()
        expect(stopFake.ok).toBe(true)
        expect(stopFake.report).toBeDefined()

        const reportFake = await fakeBridge.getProfilingReport!()
        expect(reportFake.ok).toBe(true)
        expect(reportFake.report).toBeDefined()

        const saveFake = await fakeBridge.saveFile!({
            defaultPath: '/tmp/test-profile.md',
            content: '# Profile Report',
        })
        expect(saveFake.saved).toBe(true)

        const mockBindings = createFakeBindings({
            startProfiling: vi.fn(async (opts) => ({ ok: true, session: opts })),
            stopProfiling: vi.fn(async () => ({ ok: true, report: { test: true } })),
            getProfilingReport: vi.fn(async () => ({ ok: true, report: { test: true } })),
            saveFile: vi.fn(async (opts) => ({ saved: true, filePath: opts.defaultPath })),
        })
        const bridge = new ElectronNativeBridge(mockBindings, createFakeEventSource())

        const startElectron = await bridge.startProfiling!({ durationMs: 2000 })
        expect(startElectron.ok).toBe(true)
        expect(mockBindings.startProfiling).toHaveBeenCalledWith({ durationMs: 2000 })

        const stopElectron = await bridge.stopProfiling!()
        expect(stopElectron.ok).toBe(true)
        expect(mockBindings.stopProfiling).toHaveBeenCalled()

        const reportElectron = await bridge.getProfilingReport!()
        expect(reportElectron.ok).toBe(true)
        expect(mockBindings.getProfilingReport).toHaveBeenCalled()

        const saveElectron = await bridge.saveFile!({
            defaultPath: '/tmp/test.md',
            content: 'hello',
        })
        expect(saveElectron.saved).toBe(true)
        expect(mockBindings.saveFile).toHaveBeenCalled()
    })
})
