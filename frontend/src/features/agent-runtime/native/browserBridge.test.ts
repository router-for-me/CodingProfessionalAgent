import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebAuthenticationRequiredError } from '@/features/web-auth/webAuthClient'
import { BrowserBridgeClient, createBrowserBridge } from './browserBridge'

class MockWebSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3

    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: ((event?: { code?: number }) => void) | null = null
    onerror: ((error: any) => void) | null = null
    send = vi.fn()
    close = vi.fn()
    addEventListener = vi.fn()
    removeEventListener = vi.fn()

    constructor(public url: string) {
        lastCreatedWs = this
    }
}

let lastCreatedWs: MockWebSocket | null = null

describe('browserBridge', () => {
    let originalWebSocket: any
    let originalFetch: any

    beforeEach(() => {
        lastCreatedWs = null
        originalWebSocket = globalThis.WebSocket
        originalFetch = globalThis.fetch

        globalThis.WebSocket = MockWebSocket as any
    })

    afterEach(() => {
        vi.useRealTimers()
        globalThis.WebSocket = originalWebSocket
        globalThis.fetch = originalFetch
    })

    it('creates browser bridge and dispatches RPC requests over WebSocket', async () => {
        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)

        const callPromise = bridge.ReadFile('/path/to/file.txt')

        expect(lastCreatedWs).not.toBeNull()
        expect(lastCreatedWs!.send).toHaveBeenCalled()
        const sentData = JSON.parse(lastCreatedWs!.send.mock.calls[0][0])
        expect(sentData.method).toBe('native:readFile')
        expect(sentData.args).toEqual(['/path/to/file.txt'])
        expect(sentData.clientId).toBe(client.getClientId())

        // Simulate server response
        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'rpc_result',
                id: sentData.id,
                result: { dataBase64: 'SGVsbG8=' },
            }),
        })

        const result = await callPromise
        expect(result).toEqual({ dataBase64: 'SGVsbG8=' })
        client.dispose()
    })

    it('redeems grant tickets and routes capability handles through capability:invoke', async () => {
        const client = new BrowserBridgeClient()

        const grantPromise = client.grantTicket('ticket_abc')
        expect(lastCreatedWs!.send).toHaveBeenCalled()
        const grantPayload = JSON.parse(lastCreatedWs!.send.mock.calls[0][0])
        expect(grantPayload.method).toBe('capability:grant')
        expect(grantPayload.args).toEqual([{ ticket: 'ticket_abc' }])
        expect(grantPayload.clientId).toBe(client.getClientId())

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'rpc_result',
                id: grantPayload.id,
                result: { ok: true, value: 'cap_web_handle_1' },
            }),
        })
        await expect(grantPromise).resolves.toEqual({ ok: true, value: 'cap_web_handle_1' })

        lastCreatedWs!.send.mockClear()
        const invokePromise = client.invoke('cap_web_handle_1', 'native:startPty', [{ operationId: 'pty-1' }])
        const invokePayload = JSON.parse(lastCreatedWs!.send.mock.calls[0][0])
        expect(invokePayload.method).toBe('capability:invoke')
        expect(invokePayload.args).toEqual([
            {
                handle: 'cap_web_handle_1',
                method: 'native:startPty',
                args: [{ operationId: 'pty-1' }],
            },
        ])

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'rpc_result',
                id: invokePayload.id,
                result: undefined,
            }),
        })
        await expect(invokePromise).resolves.toBeUndefined()

        const events: unknown[] = []
        const unsubscribe = client.subscribe('cap_web_handle_1', 'native-event', (payload) => {
            events.push(payload)
        })
        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'event',
                event: { kind: 'pty-stdout', operationId: 'pty-1', data: 'aGVsbG8=' },
            }),
        })
        expect(events).toEqual([{ kind: 'pty-stdout', operationId: 'pty-1', data: 'aGVsbG8=' }])
        unsubscribe()
        client.dispose()
    })

    it('handles RPC error responses correctly', async () => {
        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)

        const callPromise = bridge.ReadFile('/nonexistent')
        const sentData = JSON.parse(lastCreatedWs!.send.mock.calls[0][0])

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'rpc_error',
                id: sentData.id,
                error: 'File not found',
            }),
        })

        await expect(callPromise).rejects.toThrow('File not found')
        client.dispose()
    })

    it('receives and dispatches native events to subscribers', () => {
        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)

        const receivedEvents: any[] = []
        const unsubscribe = bridge.onNativeEvent((event) => {
            receivedEvents.push(event)
        })

        const testEvent = {
            operationId: 'op_1',
            sequence: 1,
            kind: 'pty-stdout',
            data: 'test output',
        }

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'event',
                event: testEvent,
            }),
        })

        expect(receivedEvents).toHaveLength(1)
        expect(receivedEvents[0]).toEqual(testEvent)

        unsubscribe()

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'event',
                event: { ...testEvent, sequence: 2 },
            }),
        })

        expect(receivedEvents).toHaveLength(1)
        client.dispose()
    })

    it('creates browser bridge and provides standard capabilities', () => {
        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)
        expect(bridge).toBeDefined()
        expect(typeof bridge?.ReadFile).toBe('function')
        expect(typeof bridge?.WebServerStart).toBe('function')
        client.dispose()
    })

    it('handles hello message and attaches clientId in SessionBroadcastRunStatus', async () => {
        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)

        expect(client.getClientId()).toMatch(/^client_browser_/)

        // Simulate hello message from server
        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'hello',
                clientId: 'client_ws_42_12345678',
            }),
        })

        expect(client.getClientId()).toBe('client_ws_42_12345678')

        // Call SessionBroadcastRunStatus without explicit clientId
        const broadcastPromise = bridge.SessionBroadcastRunStatus(
            'sess-test',
            'running',
            'run-test',
            '',
        )

        const sentData = JSON.parse(lastCreatedWs!.send.mock.calls[0][0])
        expect(sentData.method).toBe('session:broadcastRunStatus')
        expect(sentData.args).toEqual([
            'sess-test',
            'running',
            'run-test',
            'client_ws_42_12345678',
        ])

        lastCreatedWs!.onmessage?.({
            data: JSON.stringify({
                type: 'rpc_result',
                id: sentData.id,
                result: undefined,
            }),
        })

        await broadcastPromise
        client.dispose()
    })

    it('triggers onReconnect callback when WebSocket reconnects after initial connection', () => {
        vi.useFakeTimers()
        const client = new BrowserBridgeClient()
        const reconnectCallback = vi.fn()
        const unsubscribe = client.onReconnect(reconnectCallback)

        const firstWs = lastCreatedWs
        expect(firstWs).not.toBeNull()

        // Initial hello message — should not trigger onReconnect
        firstWs!.onmessage?.({
            data: JSON.stringify({
                type: 'hello',
                clientId: 'client_ws_1',
            }),
        })
        expect(reconnectCallback).not.toHaveBeenCalled()

        // Simulate connection drop
        firstWs!.onclose?.({ code: 1006 })

        // Fast forward reconnect timer (1500ms)
        vi.advanceTimersByTime(1500)

        const secondWs = lastCreatedWs
        expect(secondWs).not.toBe(firstWs)
        expect(secondWs).not.toBeNull()

        // Reconnected hello message — should trigger onReconnect
        secondWs!.onmessage?.({
            data: JSON.stringify({
                type: 'hello',
                clientId: 'client_ws_2',
            }),
        })
        expect(reconnectCallback).toHaveBeenCalledTimes(1)

        // Test unsubscribe
        unsubscribe()

        // Simulate another connection drop and reconnect
        secondWs!.onclose?.({ code: 1006 })
        vi.advanceTimersByTime(1500)
        const thirdWs = lastCreatedWs
        thirdWs!.onmessage?.({
            data: JSON.stringify({
                type: 'hello',
                clientId: 'client_ws_3',
            }),
        })
        expect(reconnectCallback).toHaveBeenCalledTimes(1)

        client.dispose()
    })

    it('supports startProfiling and stopProfiling on createBrowserBridge', async () => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            if (url === '/api/profile/start') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, session: { target: 'all' } }),
                })
            }
            if (url === '/api/profile/stop') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, report: { summary: {} } }),
                })
            }
            if (url === '/api/profile/report') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, report: { summary: { fetched: true } } }),
                })
            }
            return Promise.reject(new Error(`unknown url ${url}`))
        })
        globalThis.fetch = mockFetch

        const bridge = createBrowserBridge()
        const startRes = await bridge.startProfiling!({ durationMs: 5000, target: 'all' })
        expect(startRes).toEqual({ ok: true, session: { target: 'all' } })
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/profile/start',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ durationMs: 5000, target: 'all' }),
            }),
        )

        const stopRes = await bridge.stopProfiling!()
        expect(stopRes).toEqual({ ok: true, report: { summary: {} } })
        expect(mockFetch).toHaveBeenCalledWith(
            '/api/profile/stop',
            expect.objectContaining({
                method: 'POST',
            }),
        )

        const reportRes = await bridge.getProfilingReport!()
        expect(reportRes).toEqual({ ok: true, report: { summary: { fetched: true } } })
        expect(mockFetch).toHaveBeenCalledWith('/api/profile/report')
    })

    it('creates browser bridge with typed profiling and saveFile methods', async () => {
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            if (url === '/api/profile/start') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, session: {} }),
                })
            }
            if (url === '/api/profile/stop') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, report: {} }),
                })
            }
            if (url === '/api/profile/report') {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ ok: true, report: { cpa: true } }),
                })
            }
            return Promise.reject(new Error(`unknown url ${url}`))
        })
        globalThis.fetch = mockFetch

        const client = new BrowserBridgeClient()
        const bridge = createBrowserBridge(client)

        expect(typeof bridge.startProfiling).toBe('function')
        expect(typeof bridge.stopProfiling).toBe('function')
        expect(typeof bridge.getProfilingReport).toBe('function')
        expect(typeof bridge.saveFile).toBe('function')

        const startRes = await bridge.startProfiling!({ durationMs: 1000 })
        expect(startRes).toEqual({ ok: true, session: {} })

        const stopRes = await bridge.stopProfiling!()
        expect(stopRes).toEqual({ ok: true, report: {} })

        const reportRes = await bridge.getProfilingReport!()
        expect(reportRes).toEqual({ ok: true, report: { cpa: true } })
        client.dispose()
    })

    it('stops reconnecting, rejects pending WS calls, cleans up timers, and enters auth terminal state on 4401', async () => {
        vi.useFakeTimers()
        const onAuthenticationRequired = vi.fn()
        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!

        expect(vi.getTimerCount()).toBe(0)
        const invokePromise = client.invoke('native:readFile', '/path/test.txt')
        expect(socket.send).toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(1)

        socket.onclose?.({ code: 4401 })

        await expect(invokePromise).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)

        // Advance timers past 30s RPC timeout and 1500ms reconnect timer
        vi.advanceTimersByTime(35000)
        expect(vi.getTimerCount()).toBe(0)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(lastCreatedWs).toBe(socket)

        // Subsequent invoke must immediately reject with WebAuthenticationRequiredError without network/reconnect
        const fetchSpy = vi.fn()
        globalThis.fetch = fetchSpy
        await expect(client.invoke('native:readFile', '/path/second.txt')).rejects.toBeInstanceOf(
            WebAuthenticationRequiredError,
        )
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)

        client.dispose()
    })

    it('rejects pending CONNECTING calls and cleans up timers on WebSocket 4401', async () => {
        vi.useFakeTimers()
        const onAuthenticationRequired = vi.fn()
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!
        socket.readyState = MockWebSocket.CONNECTING

        expect(vi.getTimerCount()).toBe(0)
        const invokePromise = client.invoke('native:runtimeInfo')
        // Waiting for WebSocket hello while CONNECTING schedules a readiness timer.
        expect(vi.getTimerCount()).toBe(1)

        socket.onclose?.({ code: 4401 })

        await expect(invokePromise).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(vi.getTimerCount()).toBe(0)

        // Advance past hello wait / reconnect timers; auth terminal state must remain sticky.
        vi.advanceTimersByTime(15000)
        expect(vi.getTimerCount()).toBe(0)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)

        client.dispose()
    })

    it('does not trigger auth callback when delayed 4401 arrives after client dispose', async () => {
        vi.useFakeTimers()
        const onAuthenticationRequired = vi.fn()
        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!

        client.dispose()
        socket.onclose?.({ code: 4401 })
        vi.advanceTimersByTime(2000)

        expect(onAuthenticationRequired).not.toHaveBeenCalled()
        await expect(client.invoke('native:runtimeInfo')).rejects.toThrow('BrowserBridgeClient disposed')
    })

    it('handles concurrent HTTP 401 and WS 4401 by notifying auth required exactly once', async () => {
        const onAuthenticationRequired = vi.fn()
        globalThis.fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
        )
        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!
        socket.readyState = MockWebSocket.CONNECTING

        const invokePromise = client.invoke('native:runtimeInfo')
        socket.onclose?.({ code: 4401 })

        await expect(invokePromise).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)

        // Subsequent invoke after concurrent 401/4401
        await expect(client.invoke('native:runtimeInfo')).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)

        client.dispose()
    })

    it('handles HTTP RPC fallback from primary 404 to 18080 401 without entering CONNECTING wait', async () => {
        const onAuthenticationRequired = vi.fn()
        const originalLocation = window.location
        delete (window as any).location
        window.location = {
            origin: 'http://localhost:5173',
            port: '5173',
            protocol: 'http:',
            host: 'localhost:5173',
        } as any

        const fetchCalls: string[] = []
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            fetchCalls.push(url)
            if (url === 'http://localhost:5173/api/rpc') {
                return Promise.resolve(new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }))
            }
            if (url === 'http://127.0.0.1:18080/api/rpc') {
                return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
            }
            return Promise.reject(new Error(`Unexpected url ${url}`))
        })

        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!
        socket.readyState = MockWebSocket.CONNECTING

        await expect(client.invoke('native:runtimeInfo')).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(fetchCalls).toEqual([
            'http://localhost:5173/api/rpc',
            'http://127.0.0.1:18080/api/rpc',
        ])
        expect(socket.addEventListener).not.toHaveBeenCalled()

        // Subsequent invoke in terminal state directly rejects without fetch
        await expect(client.invoke('native:stat', '/path')).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(fetchCalls).toHaveLength(2)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)

        client.dispose()
        ;(window as any).location = originalLocation
    })

    it('handles HTTP RPC fallback from primary network failure to 18080 401 without entering CONNECTING wait', async () => {
        const onAuthenticationRequired = vi.fn()
        const originalLocation = window.location
        delete (window as any).location
        ;(window as any).location = {
            origin: 'http://localhost:5173',
            port: '5173',
            protocol: 'http:',
            host: 'localhost:5173',
        }

        const fetchCalls: string[] = []
        globalThis.fetch = vi.fn().mockImplementation((url: string) => {
            fetchCalls.push(url)
            if (url === 'http://localhost:5173/api/rpc') {
                return Promise.reject(new TypeError('Failed to fetch'))
            }
            if (url === 'http://127.0.0.1:18080/api/rpc') {
                return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
            }
            return Promise.reject(new Error(`Unexpected url ${url}`))
        })

        const client = new BrowserBridgeClient(onAuthenticationRequired)
        const socket = lastCreatedWs!
        socket.readyState = MockWebSocket.CONNECTING

        await expect(client.invoke('native:runtimeInfo')).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
        expect(fetchCalls).toEqual([
            'http://localhost:5173/api/rpc',
            'http://127.0.0.1:18080/api/rpc',
        ])
        expect(socket.addEventListener).not.toHaveBeenCalled()

        // Subsequent invoke in terminal state directly rejects without fetch
        await expect(client.invoke('native:stat', '/path')).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(fetchCalls).toHaveLength(2)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)

        client.dispose()
        ;(window as any).location = originalLocation
    })
})
