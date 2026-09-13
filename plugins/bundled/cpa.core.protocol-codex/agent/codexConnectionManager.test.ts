import { describe, expect, it, vi } from 'vitest'
import type { AssistantEntry, ModelCatalogEntry } from '@cpa/plugin-api'
import { FakeNativeBridge } from './testUtils.js'
import {
    buildConnectionCacheKey,
    buildWebSocketHeaders,
    canonicalizeBaseUrl,
    CodexConnectionManager,
    CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECTION_NAMESPACE,
    IDLE_TTL_MS,
    MAX_AGE_MS,
    MAX_CONNECT_RETRIES,
    resolveCodexWebSocketUrl,
} from './codexConnectionManager'
import { CodexClient } from './codexClient'
import type { CodexResponseCreate } from './types'

const model: ModelCatalogEntry = {
    id: 'gpt-test',
    label: 'GPT Test',
    supportsFast: true,
    reasoningLevels: [{ id: 'high', requestValue: 'high' }],
    input: ['text'],
    contextWindow: 128_000,
    maxTokens: 16_384,
}

function baseRequest(overrides: Partial<CodexResponseCreate> = {}): CodexResponseCreate {
    return {
        type: 'response.create',
        model: 'gpt-test',
        store: false,
        stream: true,
        instructions: 'You are a helpful assistant.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        text: { verbosity: 'low' },
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'session-1',
        ...overrides,
    }
}

function seedAssistant(): AssistantEntry {
    return {
        id: 'asst_1',
        sessionId: 'session-1',
        createdAt: 1,
        kind: 'assistant',
        model: 'gpt-test',
        content: [],
        status: 'streaming',
        stopReason: 'pending',
    }
}

function completedTextFrames(
    responseId: string,
    text: string,
): Array<{ kind: string; data?: string }> {
    const events = [
        { type: 'response.created', response: { id: responseId, status: 'in_progress' } },
        {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                status: 'in_progress',
                content: [],
            },
        },
        { type: 'response.output_text.delta', output_index: 0, delta: text },
        {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
            },
        },
        {
            type: 'response.completed',
            response: {
                id: responseId,
                status: 'completed',
                usage: {
                    input_tokens: 5,
                    output_tokens: 2,
                    total_tokens: 7,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                },
            },
        },
    ]
    return events.map((event) => ({
        kind: 'websocket-text',
        data: JSON.stringify(event),
    }))
}

function assistantMessageItem(text: string) {
    return {
        type: 'message' as const,
        role: 'assistant' as const,
        status: 'completed' as const,
        id: 'msg_1',
        content: [{ type: 'output_text' as const, text, annotations: [] as unknown[] }],
    }
}

describe('buildWebSocketHeaders / resolveCodexWebSocketUrl', () => {
    it('builds exact websocket headers', () => {
        expect(buildWebSocketHeaders('secret', 'req-1')).toEqual({
            Authorization: 'Bearer secret',
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
            'x-client-request-id': 'req-1',
            'session-id': 'req-1',
            originator: 'cpa',
        })
    })

    it('maps http/https inference base URLs to ws/wss codex responses', () => {
        expect(resolveCodexWebSocketUrl('http://127.0.0.1:8317/backend-api/')).toBe(
            'ws://127.0.0.1:8317/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('https://proxy.example/backend-api')).toBe(
            'wss://proxy.example/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('https://proxy.example/backend-api/codex')).toBe(
            'wss://proxy.example/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('http://example.com')).toBe(
            'ws://example.com/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('http://example.com/v1')).toBe(
            'ws://example.com/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('http://example.com/v1/')).toBe(
            'ws://example.com/v1/responses',
        )
        expect(resolveCodexWebSocketUrl('http://example.com/proxy')).toBe(
            'ws://example.com/proxy/v1/responses',
        )
    })

    it('canonicalizes base URL path/trailing slash and rejects query/hash/credentials', () => {
        expect(canonicalizeBaseUrl('http://127.0.0.1:8317/v1/')).toBe(
            'http://127.0.0.1:8317/v1',
        )
        expect(canonicalizeBaseUrl('http://127.0.0.1:8317/v1')).toBe(
            'http://127.0.0.1:8317/v1',
        )
        expect(() => canonicalizeBaseUrl('http://u:p@h/v1')).toThrow()
        expect(() => canonicalizeBaseUrl('http://h/v1?x=1')).toThrow()
        expect(() => canonicalizeBaseUrl('http://h/v1#z')).toThrow()

        // Cache keys use opaque namespace tokens — never hash or embed API keys.
        const k1 = buildConnectionCacheKey('ns-a', 'sess')
        const k2 = buildConnectionCacheKey('ns-a', 'sess')
        expect(k1).toBe(k2)
        expect(k1).not.toContain('secret')
        expect(k1).toBe(`ns-a\nsess`)
        expect(buildConnectionCacheKey('ns-b', 'sess')).not.toBe(k1)
        expect(buildConnectionCacheKey('', 'sess')).toBe(
            `${DEFAULT_CONNECTION_NAMESPACE}\nsess`,
        )
    })
})

describe('CodexConnectionManager', () => {
    it('waits for websocket-open before sending and reuses session sockets with delta', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-id',
        })

        // Open may already be queued before send.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_1', 'one')],
        })

        const lease1 = await manager.acquire('session-1', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        const openCalls = bridge.calls.filter((c) => c.method === 'openWebSocket')
        const sendCalls = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        expect(openCalls).toHaveLength(1)
        expect(sendCalls).toHaveLength(1)
        expect((openCalls[0]?.args[0] as { connectTimeoutMs: number }).connectTimeoutMs).toBe(
            CONNECT_TIMEOUT_MS,
        )
        expect((openCalls[0]?.args[0] as { headers: Record<string, string> }).headers).toEqual(
            buildWebSocketHeaders('k', 'session-1'),
        )

        const sent1 = JSON.parse(String(sendCalls[0]?.args[1])) as CodexResponseCreate
        expect(sent1.previous_response_id).toBeUndefined()
        expect(sent1.input).toHaveLength(1)

        const events1: unknown[] = []
        for await (const event of lease1.events) {
            events1.push(event)
        }
        expect(events1.some((e) => (e as { type?: string }).type === 'response.completed')).toBe(
            true,
        )

        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_1',
            responseItems: [assistantMessageItem('one')],
        })
        await lease1.release()

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        const secondBody = baseRequest({
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('one'),
                { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
            ],
        })

        const acquire2 = manager.acquire('session-1', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: secondBody,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_2', 'two')) {
            bridge.emit(opId, frame)
        }
        const lease2 = await acquire2

        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        const sendCalls2 = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        const send2 = JSON.parse(
            String(sendCalls2[sendCalls2.length - 1]?.args[1]),
        ) as CodexResponseCreate
        expect(send2.previous_response_id).toBe('resp_1')
        expect(send2.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
        ])

        for await (const _ of lease2.events) {
            // drain
        }
        lease2.commit({
            fullRequestBody: secondBody,
            responseId: 'resp_2',
            responseItems: [assistantMessageItem('two')],
        })
        await lease2.release()
    })

    it('does not treat key-reordered bodies as mismatched for delta', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_k', 'ok')],
        })

        const bodyA = baseRequest({
            include: ['reasoning.encrypted_content'],
            text: { verbosity: 'low' },
        })
        const lease1 = await manager.acquire('session-key', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: bodyA,
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: bodyA,
            responseId: 'resp_k',
            responseItems: [assistantMessageItem('ok')],
        })
        await lease1.release()

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        const bodyB: CodexResponseCreate = {
            prompt_cache_key: 'session-1',
            include: ['reasoning.encrypted_content'],
            text: { verbosity: 'low' },
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('ok'),
                { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
            ],
            instructions: 'You are a helpful assistant.',
            stream: true,
            store: false,
            model: 'gpt-test',
            type: 'response.create',
        }

        const acquire2 = manager.acquire('session-key', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: bodyB,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_k2', 'ok2')) {
            bridge.emit(opId, frame)
        }
        const lease2 = await acquire2
        const sendCallsKey = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        const sent = JSON.parse(
            String(sendCallsKey[sendCallsKey.length - 1]?.args[1]),
        ) as CodexResponseCreate
        expect(sent.previous_response_id).toBe('resp_k')
        expect(sent.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
        ])
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })
    })

    it('clears continuation and sends full input when prefix mismatches', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op',
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_m', 'x')],
        })
        const bodyA = baseRequest()
        const lease1 = await manager.acquire('session-m', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: bodyA,
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: bodyA,
            responseId: 'resp_m',
            responseItems: [assistantMessageItem('x')],
        })
        await lease1.release()

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        const mismatched = baseRequest({
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'different' }] }],
        })
        const acquire2 = manager.acquire('session-m', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: mismatched,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_m2', 'y')) {
            bridge.emit(opId, frame)
        }
        const lease2 = await acquire2
        const sendCallsMismatch = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        const sent = JSON.parse(
            String(sendCallsMismatch[sendCallsMismatch.length - 1]?.args[1]),
        ) as CodexResponseCreate
        expect(sent.previous_response_id).toBeUndefined()
        expect(sent.input).toEqual(mismatched.input)
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })
    })

    it('serializes concurrent acquires on the same session socket', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op',
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_s1', 'a')],
        })

        const lease1 = await manager.acquire('session-serial', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        let secondStarted = false
        const secondPromise = manager
            .acquire('session-serial', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest({
                    input: [{ role: 'user', content: [{ type: 'input_text', text: '2' }] }],
                }),
                signal: new AbortController().signal,
                mode: 'session',
            })
            .then((lease) => {
                secondStarted = true
                return lease
            })

        await Promise.resolve()
        expect(secondStarted).toBe(false)

        for await (const _ of lease1.events) {
            // drain first response
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_s1',
            responseItems: [],
        })
        await lease1.release()

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_s2', 'b')) {
            bridge.emit(opId, frame)
        }

        const lease2 = await secondPromise
        expect(secondStarted).toBe(true)
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
    })

    it('evicts idle and max-age sessions using injected clock', async () => {
        const bridge = new FakeNativeBridge()
        let now = 10_000
        const manager = new CodexConnectionManager(bridge, {
            now: () => now,
            generateRequestId: () => 'op',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_idle', 'a')],
        })
        const lease1 = await manager.acquire('session-idle', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_idle',
            responseItems: [],
        })
        lease1.release()

        now += IDLE_TTL_MS + 1
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_idle2', 'b')],
        })
        const lease2 = await manager.acquire('session-idle', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(2)
        for await (const _ of lease2.events) {
            // drain
        }
        lease2.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_idle2',
            responseItems: [],
        })
        lease2.release()

        // Age from createdAt of the second connection.
        now += MAX_AGE_MS + 1
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_age', 'c')],
        })
        const lease3 = await manager.acquire('session-idle', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(3)
        for await (const _ of lease3.events) {
            // drain
        }
        lease3.release({ keep: false })
    })

    it('retries connect failures up to MAX_CONNECT_RETRIES and never on abort', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op',
        })

        let fails = 2
        const originalOpen = bridge.openWebSocket.bind(bridge)
        vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
            if (fails > 0) {
                fails -= 1
                throw new Error(`connect fail ${fails}`)
            }
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_r', 'ok')],
            })
            return originalOpen(input)
        })

        const lease = await manager.acquire('session-retry', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease.events) {
            // drain
        }
        lease.release({ keep: false })
        expect(bridge.openWebSocket).toHaveBeenCalledTimes(3)

        const abortBridge = new FakeNativeBridge()
        const abortManager = new CodexConnectionManager(abortBridge, {
            now: () => 1_000,
            generateRequestId: () => 'op',
        })
        const controller = new AbortController()
        const abortOpen = vi.spyOn(abortBridge, 'openWebSocket').mockImplementation(async () => {
            controller.abort()
            throw new Error('aborted during connect')
        })
        await expect(
            abortManager.acquire('session-abort-connect', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: controller.signal,
                mode: 'session',
            }),
        ).rejects.toThrow()
        expect(abortOpen).toHaveBeenCalledTimes(1)
    })

    it('rejects binary frames and physical close before completion', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-bin-${++n}`
            })(),
        })
        // First response frame binary is a pre-response failure — retry budget exhausts.
        for (let i = 0; i < MAX_CONNECT_RETRIES; i += 1) {
            bridge.queueWebSocket({
                frames: [
                    { kind: 'websocket-open' },
                    { kind: 'websocket-binary', data: 'AAAA', encoding: 'base64' },
                ],
            })
        }
        await expect(
            manager.acquire('session-bin', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            }),
        ).rejects.toThrow(/binary/i)

        const bridge2 = new FakeNativeBridge()
        const manager2 = new CodexConnectionManager(bridge2, {
            now: () => 1_000,
            generateRequestId: () => 'op-close',
        })
        // Only open is pre-queued so send can succeed; protocol frames arrive after send.
        bridge2.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })
        const acquireClose = manager2.acquire('session-close', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge2.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        bridge2.emit('op-close', {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: 'resp_x', status: 'in_progress' },
            }),
        })
        const lease2 = await acquireClose
        bridge2.emit('op-close', { kind: 'done', closeCode: 1000 })
        await expect(async () => {
            for await (const _ of lease2.events) {
                // should throw
            }
        }).rejects.toThrow('Codex stream closed before response.completed')
        await lease2.release({ keep: false })
    })

    it('keeps one persistent native iterator across two successful session turns', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-persist',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_p1', 'turn-1')],
        })

        const lease1 = await manager.acquire('session-persist', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain turn 1 via response queue only
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_p1',
            responseItems: [assistantMessageItem('turn-1')],
        })
        await lease1.release({ keep: true })

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        // Emit turn-2 frames only after the second request is sent (pump is live).
        const secondBody = baseRequest({
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('turn-1'),
                { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
            ],
        })

        const acquire2 = manager.acquire('session-persist', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: secondBody,
            signal: new AbortController().signal,
            mode: 'session',
        })

        // Wait for second send, then push protocol frames for the same operation.
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_p2', 'turn-2')) {
            bridge.emit(opId, frame)
        }

        const lease2 = await acquire2
        const events2: unknown[] = []
        for await (const event of lease2.events) {
            events2.push(event)
        }
        expect(events2.some((e) => (e as { type?: string }).type === 'response.completed')).toBe(
            true,
        )
        await lease2.release({ keep: true })

        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        expect(bridge.calls.filter((c) => c.method === 'cancel')).toHaveLength(0)
    })

    it('evicts session when physical close arrives between turns', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-phys-${++n}`
            })(),
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_phys1', 'a')],
        })
        const lease1 = await manager.acquire('session-phys', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_phys1',
            responseItems: [assistantMessageItem('a')],
        })
        await lease1.release({ keep: true })

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        // Physical close while idle between turns — pump must detect and mark closed.
        bridge.emit(opId, { kind: 'done', closeCode: 1000 })
        await vi.waitFor(() => {
            // Give the background pump a turn to observe physical close.
            expect(true).toBe(true)
        })
        await Promise.resolve()
        await Promise.resolve()

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_phys2', 'b')],
        })
        const lease2 = await manager.acquire('session-phys', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest({
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
            }),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })

        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBeGreaterThanOrEqual(
            2,
        )
    })

    it('rejects queued acquire immediately when its AbortSignal aborts', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-qabort',
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_qa1', 'hold')],
        })

        // Hold the serial lock with a fully-ready first lease (do not release yet).
        const lease1 = await manager.acquire('session-qabort', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        const controller2 = new AbortController()
        const second = manager.acquire('session-qabort', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest({
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'queued' }] }],
            }),
            signal: controller2.signal,
            mode: 'session',
        })

        await Promise.resolve()
        controller2.abort()

        await expect(second).rejects.toThrow(/abort/i)

        // First lease still healthy.
        for await (const _ of lease1.events) {
            // drain
        }
        await lease1.release({ keep: false })
    })

    it('deep-clones commit snapshots so later mutation does not corrupt delta baseline', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-clone',
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_clone', 'snap')],
        })

        const body = baseRequest()
        const items = [assistantMessageItem('snap')]
        const lease1 = await manager.acquire('session-clone', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: body,
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: body,
            responseId: 'resp_clone',
            responseItems: items,
        })
        await lease1.release({ keep: true })

        // Mutate originals after commit — baseline must remain the snapshot.
        body.input = [{ role: 'user', content: [{ type: 'input_text', text: 'MUTATED' }] }]
        items.push(assistantMessageItem('MUTATED'))

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        const secondBody = baseRequest({
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('snap'),
                { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
            ],
        })
        const acquire2 = manager.acquire('session-clone', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: secondBody,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_clone2', 'ok')) {
            bridge.emit(opId, frame)
        }
        const lease2 = await acquire2
        const sendCalls = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        const sent = JSON.parse(String(sendCalls[sendCalls.length - 1]?.args[1])) as CodexResponseCreate
        expect(sent.previous_response_id).toBe('resp_clone')
        expect(sent.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
        ])
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })
    })

    it('retries full pre-response failures including open wait, binary, and send, cleaning old ops', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-retry-${++n}`
            })(),
        })

        // Attempt 1: open succeeds but physical done before websocket-open wait completes.
        bridge.queueWebSocket({
            frames: [{ kind: 'done', closeCode: 1006 }],
        })
        // Attempt 2: binary before open.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-binary', data: 'AA==', encoding: 'base64' }],
        })
        // Attempt 3: healthy.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_retry_ok', 'ok')],
        })

        const lease = await manager.acquire('session-preresp', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease.events) {
            // drain
        }
        await lease.release({ keep: false })

        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(3)
        // Failed attempts must cancel/cleanup old ops (at least the failed ones).
        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBeGreaterThanOrEqual(2)
    })

    it('enforces CONNECT_TIMEOUT_MS via injectable scheduler and retries until budget exhausted', async () => {
        const bridge = new FakeNativeBridge()
        const scheduled = new Map<number, { ms: number; fn: () => void }>()
        let handleSeq = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-timeout-${++n}`
            })(),
            schedule: (fn, ms) => {
                handleSeq += 1
                scheduled.set(handleSeq, { fn, ms })
                return handleSeq
            },
            cancelSchedule: (handle) => {
                scheduled.delete(handle as number)
            },
        })

        const openSpy = vi.spyOn(bridge, 'openWebSocket').mockImplementation(
            () =>
                new Promise(() => {
                    // never resolves — timeout must win each attempt
                }),
        )

        const pending = manager.acquire('session-timeout', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        // Attach rejection handler immediately to avoid unhandled-rejection races.
        const settled = pending.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        )

        // Fire each live connect timeout until acquire rejects.
        for (let i = 0; i < MAX_CONNECT_RETRIES + 1; i += 1) {
            await vi.waitFor(() => {
                expect(scheduled.size).toBeGreaterThan(0)
            }).catch(() => {
                // acquire may already have rejected
            })
            const active = [...scheduled.entries()]
            if (active.length === 0) {
                break
            }
            const [handle, entry] = active[0]!
            expect(entry.ms).toBe(CONNECT_TIMEOUT_MS)
            scheduled.delete(handle)
            entry.fn()
            await Promise.resolve()
            await Promise.resolve()
        }

        const result = await settled
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(String(result.error)).toMatch(/timeout/i)
        }
        expect(openSpy.mock.calls.length).toBe(MAX_CONNECT_RETRIES)
    })

    it('cleans up isolated connect when send fails after open', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-iso-send',
        })

        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })

        vi.spyOn(bridge, 'sendWebSocket').mockRejectedValueOnce(new Error('send failed'))

        await expect(
            manager.acquire(null, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'isolated',
            }),
        ).rejects.toThrow(/send failed|not open/i)

        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBeGreaterThanOrEqual(1)
        // Isolated must never write session cache: a later session open is independent.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_after_iso', 'x')],
        })
        const sessionLease = await manager.acquire('session-after-iso', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of sessionLease.events) {
            // drain
        }
        await sessionLease.release({ keep: false })
    })

    it('aborts a hanging cached send immediately, cancels once, and frees the serial lock', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-hang-send',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_hang1', 'one')],
        })

        const lease1 = await manager.acquire('session-hang-send', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_hang1',
            responseItems: [assistantMessageItem('one')],
        })
        await lease1.release({ keep: true })

        let releaseLateSend!: (error: Error) => void
        const lateSend = new Promise<void>((_resolve, reject) => {
            releaseLateSend = reject
        })
        // Attach rejection handler before abort races it so late rejection is never unhandled.
        const lateSendObserved = lateSend.then(
            () => 'resolved' as const,
            () => 'rejected' as const,
        )
        vi.spyOn(bridge, 'sendWebSocket').mockImplementationOnce(() => lateSend)

        const controller = new AbortController()
        const second = manager.acquire('session-hang-send', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest({
                input: [
                    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                    assistantMessageItem('one'),
                    { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
                ],
            }),
            signal: controller.signal,
            mode: 'session',
        })
        const secondSettled = second.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        )

        await Promise.resolve()
        controller.abort()

        const result = await secondSettled
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(String(result.error)).toMatch(/abort/i)
        }

        const cancels = bridge.calls.filter((c) => c.method === 'cancel')
        expect(cancels.length).toBe(1)

        // Next waiter can enter the serial lock and open a fresh socket.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_hang2', 'two')],
        })
        const lease3 = await manager.acquire('session-hang-send', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease3.events) {
            // drain
        }
        await lease3.release({ keep: false })

        releaseLateSend(new Error('late send failed'))
        await expect(lateSendObserved).resolves.toBe('rejected')
    })

    it('retries when the first response frame is invalid/binary/done, and does not retry after first valid', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-first-frame-${++n}`
            })(),
        })

        // Attempt 1: open+send ok, first protocol frame is invalid JSON.
        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })
        // Attempt 2: healthy.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_first_ok', 'ok')],
        })

        const acquirePromise = manager.acquire('session-first-frame', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        const firstOpId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )
        bridge.emit(firstOpId, { kind: 'websocket-text', data: '{not-json' })

        const lease = await acquirePromise
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(2)
        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBeGreaterThanOrEqual(1)

        for await (const _ of lease.events) {
            // drain
        }
        await lease.release({ keep: false })

        // After first valid protocol event, physical failure must not open another socket.
        const bridge2 = new FakeNativeBridge()
        const manager2 = new CodexConnectionManager(bridge2, {
            now: () => 1_000,
            generateRequestId: () => 'op-after-valid',
        })
        bridge2.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })
        const afterValid = manager2.acquire('session-after-valid', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge2.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        bridge2.emit('op-after-valid', {
            kind: 'websocket-text',
            data: JSON.stringify({ type: 'response.created', response: { id: 'r1' } }),
        })
        const leaseValid = await afterValid
        bridge2.emit('op-after-valid', { kind: 'websocket-binary', data: 'AA==', encoding: 'base64' })

        await expect(
            (async () => {
                for await (const _ of leaseValid.events) {
                    // drain until failure
                }
            })(),
        ).rejects.toThrow(/binary/i)
        expect(bridge2.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        await leaseValid.release({ keep: false })
    })

    it('shares an idempotent finish latch across release/cancel orderings', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-finish-${++n}`
            })(),
        })

        async function runOneTurn(sessionId: string, responseId: string): Promise<{
            lease: Awaited<ReturnType<CodexConnectionManager['acquire']>>
            opId: string
        }> {
            bridge.queueWebSocket({
                frames: [{ kind: 'websocket-open' }, ...completedTextFrames(responseId, 'x')],
            })
            const lease = await manager.acquire(sessionId, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })
            const opId = lease.operationId
            for await (const _ of lease.events) {
                // drain
            }
            lease.commit({
                fullRequestBody: baseRequest(),
                responseId,
                responseItems: [assistantMessageItem('x')],
            })
            return { lease, opId }
        }

        // release then cancel: socket kept; late cancel must not drop next turn.
        const first = await runOneTurn('session-finish-a', 'resp_fa')
        await first.lease.release({ keep: true })
        await first.lease.cancel()
        const cancelsAfterLateCancel = bridge.calls.filter((c) => c.method === 'cancel').length

        const secondBody = baseRequest({
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('x'),
                { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
            ],
        })
        const acquire2 = manager.acquire('session-finish-a', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: secondBody,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_fa2', 'y')) {
            bridge.emit(first.opId, frame)
        }
        const lease2 = await acquire2
        expect(lease2.operationId).toBe(first.opId)
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBe(
            cancelsAfterLateCancel,
        )
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: false })

        // cancel then release / concurrent Promise.all: lock handed off once.
        const third = await runOneTurn('session-finish-b', 'resp_fb')
        await Promise.all([third.lease.cancel(), third.lease.release({ keep: true })])
        const opensBeforeNext = bridge.calls.filter((c) => c.method === 'openWebSocket').length

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_fb2', 'z')],
        })
        const lease4 = await manager.acquire('session-finish-b', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        // Prior cancel must have released the lock exactly once so the next acquire proceeds.
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(
            opensBeforeNext + 1,
        )
        for await (const _ of lease4.events) {
            // drain
        }
        await lease4.release({ keep: false })
    })

    it('cleans up late-resolved open operations after connect timeout exactly once', async () => {
        const bridge = new FakeNativeBridge()
        const scheduled = new Map<number, { ms: number; fn: () => void }>()
        let handleSeq = 0
        const returnCounts = new Map<string, number>()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-late-open-${++n}`
            })(),
            schedule: (fn, ms) => {
                handleSeq += 1
                scheduled.set(handleSeq, { fn, ms })
                return handleSeq
            },
            cancelSchedule: (handle) => {
                scheduled.delete(handle as number)
            },
        })

        const lateOps: Array<{
            resolve: (op: Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>) => void
            operation: Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>
        }> = []
        const origOpen = bridge.openWebSocket.bind(bridge)
        vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
            // Hold the open promise until the test flushes late resolutions after timeout.
            bridge.queueWebSocket({
                hold: true,
                frames: [{ kind: 'websocket-open' }],
            })
            const operation = origOpen(input).then((op) => {
                const origFactory = op.events[Symbol.asyncIterator].bind(op.events)
                ;(op.events as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[
                    Symbol.asyncIterator
                ] = () => {
                    const it = origFactory() as AsyncIterator<unknown> & {
                        return?: () => Promise<IteratorResult<unknown>>
                    }
                    const origReturn = it.return?.bind(it)
                    it.return = async () => {
                        returnCounts.set(
                            input.operationId,
                            (returnCounts.get(input.operationId) ?? 0) + 1,
                        )
                        return origReturn
                            ? origReturn()
                            : { value: undefined, done: true }
                    }
                    return it
                }
                return op
            })
            return await new Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>(
                (resolve) => {
                    lateOps.push({ resolve, operation })
                },
            )
        })

        const pending = manager.acquire('session-late-open', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        const settled = pending.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        )

        for (let i = 0; i < MAX_CONNECT_RETRIES + 1; i += 1) {
            await vi.waitFor(() => {
                expect(scheduled.size).toBeGreaterThan(0)
            }).catch(() => {
                // acquire may already have rejected
            })
            const active = [...scheduled.entries()]
            if (active.length === 0) {
                break
            }
            const [handle, entry] = active[0]!
            expect(entry.ms).toBe(CONNECT_TIMEOUT_MS)
            scheduled.delete(handle)
            entry.fn()
            await Promise.resolve()
            await Promise.resolve()
        }

        const result = await settled
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(String(result.error)).toMatch(/timeout/i)
        }

        // Flush late open resolutions and allow cleanup.
        expect(lateOps.length).toBe(MAX_CONNECT_RETRIES)
        for (const entry of lateOps) {
            entry.resolve(await entry.operation)
        }
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        const cancels = bridge.calls.filter((c) => c.method === 'cancel')
        expect(cancels.length).toBeGreaterThanOrEqual(1)
        for (const count of returnCounts.values()) {
            expect(count).toBe(1)
        }
        expect([...returnCounts.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1)

        // Cache must not retain a timed-out socket.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_after_late', 'z')],
        })
        // Restore real open for the verification acquire.
        vi.mocked(bridge.openWebSocket).mockRestore()
        const fresh = await manager.acquire('session-late-open', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of fresh.events) {
            // drain
        }
        await fresh.release({ keep: false })
    })

    it('evicts on stale protocol frames between turns and never feeds them to the next turn', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-stale-${++n}`
            })(),
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_stale1', 'one')],
        })
        const lease1 = await manager.acquire('session-stale', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_stale1',
            responseItems: [assistantMessageItem('one')],
        })
        await lease1.release({ keep: true })

        const firstOpId = lease1.operationId
        // Unsolicited protocol frame while idle — must evict, never buffer for next turn.
        bridge.emit(firstOpId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: 'stale_resp', status: 'in_progress' },
            }),
        })

        await vi.waitFor(() => {
            expect(
                bridge.calls.filter((c) => c.method === 'cancel').length,
            ).toBeGreaterThanOrEqual(1)
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_stale2', 'two')],
        })
        const lease2 = await manager.acquire('session-stale', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        expect(lease2.operationId).not.toBe(firstOpId)
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(2)

        const events2: unknown[] = []
        for await (const event of lease2.events) {
            events2.push(event)
        }
        expect(
            events2.some(
                (e) =>
                    (e as { response?: { id?: string } }).response?.id === 'stale_resp',
            ),
        ).toBe(false)
        expect(
            events2.some((e) => (e as { response?: { id?: string } }).response?.id === 'resp_stale2'),
        ).toBe(true)
        await lease2.release({ keep: false })
    })

    it('calls native iterator.return exactly once on idle pump physical failure', async () => {
        const bridge = new FakeNativeBridge()
        const returnCounts = new Map<string, number>()
        const origOpen = bridge.openWebSocket.bind(bridge)
        vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
            const op = await origOpen(input)
            const origFactory = op.events[Symbol.asyncIterator].bind(op.events)
            ;(op.events as { [Symbol.asyncIterator]: () => AsyncIterator<unknown> })[
                Symbol.asyncIterator
            ] = () => {
                const it = origFactory() as AsyncIterator<unknown> & {
                    return?: () => Promise<IteratorResult<unknown>>
                }
                const origReturn = it.return?.bind(it)
                it.return = async () => {
                    returnCounts.set(
                        input.operationId,
                        (returnCounts.get(input.operationId) ?? 0) + 1,
                    )
                    return origReturn ? origReturn() : { value: undefined, done: true }
                }
                return it
            }
            return op
        })

        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-idle-return',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_idle_ret', 'one')],
        })
        const lease1 = await manager.acquire('session-idle-return', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_idle_ret',
            responseItems: [assistantMessageItem('one')],
        })
        await lease1.release({ keep: true })

        // Idle physical failure with no active response queue.
        bridge.emit('op-idle-return', {
            kind: 'websocket-binary',
            data: 'AA==',
            encoding: 'base64',
        })

        await vi.waitFor(() => {
            expect(returnCounts.get('op-idle-return')).toBe(1)
        })

        // Explicit drop must remain idempotent (no second iterator.return).
        manager.closeSession('session-idle-return')
        await Promise.resolve()
        await Promise.resolve()
        expect(returnCounts.get('op-idle-return')).toBe(1)
    })

    it('does not retry when send rejects after first protocol already arrived (cached + fresh)', async () => {
        async function runPath(mode: 'cached' | 'fresh'): Promise<void> {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-send-after-first-${mode}-${++n}`
                })(),
            })

            let releaseSend!: (error?: Error) => void
            const origSend = bridge.sendWebSocket.bind(bridge)
            vi.spyOn(bridge, 'sendWebSocket').mockImplementation(async (operationId, payload) => {
                await origSend(operationId, payload)
                await new Promise<void>((resolve, reject) => {
                    releaseSend = (error) => {
                        if (error) reject(error)
                        else resolve()
                    }
                })
            })

            if (mode === 'cached') {
                // Warm a reusable session socket first.
                bridge.queueWebSocket({
                    frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_warm', 'warm')],
                })
                const warm = await manager.acquire('session-send-after-first', {
                    apiKey: 'k',
                    baseUrl: 'http://127.0.0.1:8317/backend-api/',
                    request: baseRequest(),
                    signal: new AbortController().signal,
                    mode: 'session',
                })
                for await (const _ of warm.events) {
                    // drain
                }
                warm.commit({
                    fullRequestBody: baseRequest(),
                    responseId: 'resp_warm',
                    responseItems: [assistantMessageItem('warm')],
                })
                await warm.release({ keep: true })
                vi.mocked(bridge.sendWebSocket).mockClear()
            } else {
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
            }

            const secondBody =
                mode === 'cached'
                    ? baseRequest({
                          input: [
                              { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                              assistantMessageItem('warm'),
                              { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
                          ],
                      })
                    : baseRequest()

            const sendsBefore = bridge.calls.filter((c) => c.method === 'sendWebSocket').length
            const acquirePromise = manager.acquire('session-send-after-first', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: secondBody,
                signal: new AbortController().signal,
                mode: 'session',
            })

            await vi.waitFor(() => {
                expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(
                    sendsBefore + 1,
                )
            })

            const opId = String(
                (
                    bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                        operationId: string
                    }
                ).operationId,
            )

            // First protocol arrives while send is still pending.
            for (const frame of completedTextFrames(
                mode === 'cached' ? 'resp_after_send' : 'resp_fresh_after_send',
                'ok',
            )) {
                bridge.emit(opId, frame)
            }

            const lease = await acquirePromise
            const opensBeforeReject = bridge.calls.filter((c) => c.method === 'openWebSocket').length

            // Late send rejection must not retry/duplicate or poison the active response.
            releaseSend(new Error('late send failed after first protocol'))
            await Promise.resolve()
            await Promise.resolve()

            expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(
                opensBeforeReject,
            )

            const events: unknown[] = []
            for await (const event of lease.events) {
                events.push(event)
            }
            expect(
                events.some((e) => (e as { type?: string }).type === 'response.completed'),
            ).toBe(true)
            await lease.release({ keep: false })
            vi.mocked(bridge.sendWebSocket).mockRestore()
        }

        await runPath('fresh')
        await runPath('cached')
    })

    it('retries scalar/array/null/empty-type first frames and fails after-first invalid without retry', async () => {
        const invalids = ['null', '42', '"x"', '[]', '{"type":""}', '{"no_type":true}']

        for (const invalid of invalids) {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-invalid-first-${invalid.length}-${++n}`
                })(),
            })

            bridge.queueWebSocket({
                hold: true,
                frames: [{ kind: 'websocket-open' }],
            })
            bridge.queueWebSocket({
                frames: [
                    { kind: 'websocket-open' },
                    ...completedTextFrames(`resp_ok_${invalid.length}`, 'ok'),
                ],
            })

            const acquirePromise = manager.acquire(`session-invalid-first-${invalid.length}`, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })

            await vi.waitFor(() => {
                expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
            })
            const firstOpId = String(
                (
                    bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                        operationId: string
                    }
                ).operationId,
            )
            bridge.emit(firstOpId, { kind: 'websocket-text', data: invalid })

            const lease = await acquirePromise
            expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(2)
            expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBeGreaterThanOrEqual(
                1,
            )
            for await (const _ of lease.events) {
                // drain
            }
            await lease.release({ keep: false })
        }

        // After first valid protocol, invalid frame fails the current response without reconnect.
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-after-first-invalid',
        })
        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })
        const acquirePromise = manager.acquire('session-after-first-invalid', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        bridge.emit('op-after-first-invalid', {
            kind: 'websocket-text',
            data: JSON.stringify({ type: 'response.created', response: { id: 'r1' } }),
        })
        const lease = await acquirePromise
        bridge.emit('op-after-first-invalid', {
            kind: 'websocket-text',
            data: 'null',
        })
        await expect(
            (async () => {
                for await (const _ of lease.events) {
                    // drain until failure
                }
            })(),
        ).rejects.toThrow(/invalid|protocol/i)
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        await lease.release({ keep: false })
    })

    it('cancels exactly once for binding-stage abort and post-resolve abort (incl. timeout late resolve)', async () => {
        // Binding-stage abort: open signal already aborted before resolve; manager must not double-cancel.
        {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: () => 'op-bind-abort',
            })
            const controller = new AbortController()
            const delayed: Array<{
                resolve: (op: Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>) => void
                operation: Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>
            }> = []
            const origOpen = bridge.openWebSocket.bind(bridge)
            vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
                const operation = origOpen(input)
                return await new Promise((resolve) => {
                    delayed.push({ resolve, operation })
                })
            })

            const pending = manager.acquire('session-bind-abort', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: controller.signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            await vi.waitFor(() => {
                expect(delayed.length).toBe(1)
            })
            controller.abort()
            // Flush late open resolution after abort (Task 6 cancels via linked signal).
            for (const entry of delayed) {
                entry.resolve(await entry.operation)
            }
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()

            const result = await settled
            expect(result.ok).toBe(false)
            const cancels = bridge.calls.filter((c) => c.method === 'cancel')
            expect(cancels.length).toBe(1)
            vi.mocked(bridge.openWebSocket).mockRestore()
        }

        // Post-resolve abort: open already returned; manager owns cancel; open signal path must not fire again.
        {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: () => 'op-post-resolve-abort',
            })
            const controller = new AbortController()
            bridge.queueWebSocket({
                hold: true,
                frames: [{ kind: 'websocket-open' }],
            })

            const pending = manager.acquire('session-post-resolve-abort', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: controller.signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            await vi.waitFor(() => {
                expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(1)
            })
            // Abort after open binding resolved (during wait-open / send / first-protocol).
            await Promise.resolve()
            controller.abort()

            const result = await settled
            expect(result.ok).toBe(false)
            await Promise.resolve()
            await Promise.resolve()
            const cancels = bridge.calls.filter((c) => c.method === 'cancel')
            expect(cancels.length).toBe(1)
        }

        // Timeout late resolve: cancel + iterator.return ownership stays single-shot.
        {
            const bridge = new FakeNativeBridge()
            const scheduled = new Map<number, { ms: number; fn: () => void }>()
            let handleSeq = 0
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-timeout-once-${++n}`
                })(),
                schedule: (fn, ms) => {
                    handleSeq += 1
                    scheduled.set(handleSeq, { fn, ms })
                    return handleSeq
                },
                cancelSchedule: (handle) => {
                    scheduled.delete(handle as number)
                },
            })

            const lateOps: Array<{
                resolve: (op: Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>) => void
                operation: Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>
            }> = []
            const origOpen = bridge.openWebSocket.bind(bridge)
            vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
                const operation = origOpen(input)
                return await new Promise((resolve) => {
                    lateOps.push({ resolve, operation })
                })
            })

            const pending = manager.acquire('session-timeout-once', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            for (let i = 0; i < MAX_CONNECT_RETRIES + 1; i += 1) {
                await vi.waitFor(() => {
                    expect(scheduled.size).toBeGreaterThan(0)
                }).catch(() => {
                    // may already have rejected
                })
                const active = [...scheduled.entries()]
                if (active.length === 0) break
                const [handle, entry] = active[0]!
                scheduled.delete(handle)
                entry.fn()
                await Promise.resolve()
                await Promise.resolve()
            }

            const result = await settled
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(String(result.error)).toMatch(/timeout/i)
            }

            for (const entry of lateOps) {
                entry.resolve(await entry.operation)
            }
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()

            // One cancel per timed-out attempt; never a second cancel for the same late resolve.
            const cancels = bridge.calls.filter((c) => c.method === 'cancel')
            expect(cancels.length).toBe(MAX_CONNECT_RETRIES)
            const byOp = new Map<string, number>()
            for (const call of cancels) {
                const opId = String(call.args[0])
                byOp.set(opId, (byOp.get(opId) ?? 0) + 1)
            }
            for (const count of byOp.values()) {
                expect(count).toBe(1)
            }
            vi.mocked(bridge.openWebSocket).mockRestore()
        }
    })

    it('drops stale pre-start deltas before a new response generation starts', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-stale-gate-${++n}`
            })(),
        })

        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })

        // Turn 1: complete successfully and keep socket.
        const firstAcquire = manager.acquire('session-stale-gate', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        const firstOpId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )
        for (const frame of completedTextFrames('resp_gate1', 'one')) {
            bridge.emit(firstOpId, frame)
        }
        const lease1 = await firstAcquire
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_gate1',
            responseItems: [assistantMessageItem('one')],
        })
        await lease1.release({ keep: true })

        // Stale delta buffered on the native iterator after turn1 terminal but before turn2 attach/send.
        // Emit while idle: current idle policy may evict; also cover attach-before-start race via hold.
        // Reconnect path for deterministic coverage of stale-before-start on a fresh attach.
        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })

        // Force a fresh socket by idle-evicting the previous one with a stale non-start frame.
        bridge.emit(firstOpId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.output_text.delta',
                output_index: 0,
                delta: 'stale-between-turns',
            }),
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBeGreaterThanOrEqual(
                1,
            )
        })

        const secondBody = baseRequest({
            input: [
                { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
                assistantMessageItem('one'),
                { role: 'user', content: [{ type: 'input_text', text: 'next' }] },
            ],
        })
        const secondAcquire = manager.acquire('session-stale-gate', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: secondBody,
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        const openCalls = bridge.calls.filter((c) => c.method === 'openWebSocket')
        const secondOpId = String(
            (openCalls[openCalls.length - 1]?.args[0] as { operationId: string }).operationId,
        )

        // Before response.created, a buffered delta/output item is stale: must not feed the new queue.
        bridge.emit(secondOpId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.output_text.delta',
                output_index: 0,
                delta: 'stale-before-start',
            }),
        })

        // Stale-before-start should fail/evict this attempt; a healthy retry should succeed.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_gate2', 'two')],
        })

        const lease2 = await secondAcquire
        const events2: unknown[] = []
        for await (const event of lease2.events) {
            events2.push(event)
        }
        expect(
            events2.some(
                (e) =>
                    (e as { type?: string }).type === 'response.output_text.delta' &&
                    (e as { delta?: string }).delta === 'stale-before-start',
            ),
        ).toBe(false)
        expect(
            events2.some((e) => (e as { response?: { id?: string } }).response?.id === 'resp_gate2'),
        ).toBe(true)

        // Healthy created → delta path still works.
        expect(
            events2.some((e) => (e as { type?: string }).type === 'response.created'),
        ).toBe(true)
        await lease2.release({ keep: false })
    })

    it('removes each parent abort listener by callback identity on the same AbortSignal', async () => {
        type Listener = EventListenerOrEventListenerObject
        const live = new Map<AbortSignal, Map<Listener, number>>()
        // Capture originals before spying so AbortSignal receivers stay valid.
        const originalAdd = AbortSignal.prototype.addEventListener
        const originalRemove = AbortSignal.prototype.removeEventListener

        const addSpy = vi
            .spyOn(AbortSignal.prototype, 'addEventListener')
            .mockImplementation(function (
                this: AbortSignal,
                type: string,
                listener: Listener,
                options?: boolean | AddEventListenerOptions,
            ) {
                if (type === 'abort') {
                    let counts = live.get(this)
                    if (!counts) {
                        counts = new Map()
                        live.set(this, counts)
                    }
                    counts.set(listener, (counts.get(listener) ?? 0) + 1)
                }
                return originalAdd.call(this, type, listener, options)
            })
        const removeSpy = vi
            .spyOn(AbortSignal.prototype, 'removeEventListener')
            .mockImplementation(function (
                this: AbortSignal,
                type: string,
                listener: Listener,
                options?: boolean | EventListenerOptions,
            ) {
                if (type === 'abort') {
                    const counts = live.get(this)
                    const current = counts?.get(listener) ?? 0
                    if (current <= 1) {
                        counts?.delete(listener)
                    } else {
                        counts?.set(listener, current - 1)
                    }
                    if (counts && counts.size === 0) {
                        live.delete(this)
                    }
                }
                return originalRemove.call(this, type, listener, options)
            })

        function assertAllListenersRemoved(signal: AbortSignal): void {
            const counts = live.get(signal)
            expect(counts === undefined || counts.size === 0).toBe(true)
        }

        try {
            // Underlying wins: send resolves, first protocol arrives.
            {
                const bridge = new FakeNativeBridge()
                const manager = new CodexConnectionManager(bridge, {
                    now: () => 1_000,
                    generateRequestId: () => 'op-race-win',
                })
                bridge.queueWebSocket({
                    frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_race_win', 'x')],
                })
                const controller = new AbortController()
                const lease = await manager.acquire('session-race-win', {
                    apiKey: 'k',
                    baseUrl: 'http://127.0.0.1:8317/backend-api/',
                    request: baseRequest(),
                    signal: controller.signal,
                    mode: 'session',
                })
                for await (const _ of lease.events) {
                    // drain
                }
                await lease.release({ keep: false })
                assertAllListenersRemoved(controller.signal)
            }

            // Abort wins during hanging send.
            {
                const bridge = new FakeNativeBridge()
                const manager = new CodexConnectionManager(bridge, {
                    now: () => 1_000,
                    generateRequestId: () => 'op-race-abort',
                })
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
                let releaseSend!: () => void
                const origSend = bridge.sendWebSocket.bind(bridge)
                vi.spyOn(bridge, 'sendWebSocket').mockImplementation(async (operationId, payload) => {
                    await origSend(operationId, payload)
                    await new Promise<void>((resolve) => {
                        releaseSend = resolve
                    })
                })
                const controller = new AbortController()
                const pending = manager.acquire('session-race-abort', {
                    apiKey: 'k',
                    baseUrl: 'http://127.0.0.1:8317/backend-api/',
                    request: baseRequest(),
                    signal: controller.signal,
                    mode: 'session',
                })
                const settled = pending.then(
                    () => ({ ok: true as const }),
                    (error: unknown) => ({ ok: false as const, error }),
                )
                await vi.waitFor(() => {
                    expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
                })
                controller.abort()
                const result = await settled
                expect(result.ok).toBe(false)
                releaseSend()
                await Promise.resolve()
                await Promise.resolve()
                assertAllListenersRemoved(controller.signal)
                vi.mocked(bridge.sendWebSocket).mockRestore()
            }

            // Underlying throws (send fails before first protocol).
            {
                const bridge = new FakeNativeBridge()
                const manager = new CodexConnectionManager(bridge, {
                    now: () => 1_000,
                    generateRequestId: (() => {
                        let n = 0
                        return () => `op-race-throw-${++n}`
                    })(),
                })
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
                // Second attempt succeeds so acquire settles without exhausting retries noise.
                bridge.queueWebSocket({
                    frames: [
                        { kind: 'websocket-open' },
                        ...completedTextFrames('resp_race_throw', 'ok'),
                    ],
                })
                const origSend = bridge.sendWebSocket.bind(bridge)
                let sendCount = 0
                vi.spyOn(bridge, 'sendWebSocket').mockImplementation(async (operationId, payload) => {
                    sendCount += 1
                    if (sendCount === 1) {
                        await origSend(operationId, payload)
                        throw new Error('send boom')
                    }
                    return origSend(operationId, payload)
                })
                const controller = new AbortController()
                const lease = await manager.acquire('session-race-throw', {
                    apiKey: 'k',
                    baseUrl: 'http://127.0.0.1:8317/backend-api/',
                    request: baseRequest(),
                    signal: controller.signal,
                    mode: 'session',
                })
                for await (const _ of lease.events) {
                    // drain
                }
                await lease.release({ keep: false })
                assertAllListenersRemoved(controller.signal)
                vi.mocked(bridge.sendWebSocket).mockRestore()
            }
        } finally {
            addSpy.mockRestore()
            removeSpy.mockRestore()
        }
    })

    it('treats first-frame failed/error as legal terminal, does not cache closed entry, next turn is fresh', async () => {
        for (const terminal of [
            {
                type: 'response.failed',
                response: { id: 'resp_failed_first', status: 'failed', error: { message: 'boom' } },
            },
            {
                type: 'error',
                error: { message: 'protocol boom' },
            },
        ] as const) {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-first-terminal-${terminal.type}-${++n}`
                })(),
            })

            bridge.queueWebSocket({
                hold: true,
                frames: [{ kind: 'websocket-open' }],
            })

            const acquirePromise = manager.acquire(`session-first-terminal-${terminal.type}`, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })

            await vi.waitFor(() => {
                expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
            })
            const firstOpId = String(
                (
                    bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                        operationId: string
                    }
                ).operationId,
            )
            bridge.emit(firstOpId, {
                kind: 'websocket-text',
                data: JSON.stringify(terminal),
            })

            const lease = await acquirePromise
            // Legal first terminal must be delivered to the parser (not treated as connect retry).
            const events: unknown[] = []
            for await (const event of lease.events) {
                events.push(event)
            }
            expect(events.some((e) => (e as { type?: string }).type === terminal.type)).toBe(true)

            // Closed terminal lease is consumable but must not be written to session cache.
            lease.commit({
                fullRequestBody: baseRequest(),
                responseId: 'should-not-cache',
                responseItems: [],
            })
            await lease.release({ keep: true })

            bridge.queueWebSocket({
                frames: [
                    { kind: 'websocket-open' },
                    ...completedTextFrames(`resp_after_${terminal.type}`, 'fresh'),
                ],
            })
            const lease2 = await manager.acquire(`session-first-terminal-${terminal.type}`, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })
            expect(lease2.operationId).not.toBe(firstOpId)
            expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(2)
            for await (const _ of lease2.events) {
                // drain
            }
            await lease2.release({ keep: false })
        }
    })

    it('does not retry when valid first is followed by invalid and late send reject; queue yields event then error', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-first-then-invalid-send-${++n}`
            })(),
        })

        let releaseSend!: (error?: Error) => void
        const origSend = bridge.sendWebSocket.bind(bridge)
        vi.spyOn(bridge, 'sendWebSocket').mockImplementation(async (operationId, payload) => {
            await origSend(operationId, payload)
            await new Promise<void>((resolve, reject) => {
                releaseSend = (error) => {
                    if (error) reject(error)
                    else resolve()
                }
            })
        })

        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })

        const acquirePromise = manager.acquire('session-first-then-invalid-send', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        // Valid first lifecycle frame starts the response generation.
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: 'resp_started', status: 'in_progress' },
            }),
        })
        const lease = await acquirePromise
        const opensAfterFirst = bridge.calls.filter((c) => c.method === 'openWebSocket').length

        // Invalid after first must fail this response/evict, never reconnect-retry.
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: 'null',
        })
        await Promise.resolve()
        await Promise.resolve()

        // Late send reject after started latch must not open another socket.
        releaseSend(new Error('late send failed after invalid'))
        await Promise.resolve()
        await Promise.resolve()
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(opensAfterFirst)

        const seen: unknown[] = []
        let observedError: unknown
        try {
            for await (const event of lease.events) {
                seen.push(event)
            }
        } catch (error) {
            observedError = error
        }
        expect(seen.some((e) => (e as { type?: string }).type === 'response.created')).toBe(true)
        expect(String(observedError)).toMatch(/invalid|protocol/i)
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)

        await lease.release({ keep: false })
        vi.mocked(bridge.sendWebSocket).mockRestore()
    })

    it('ignores connection metadata before and during a response without closing the socket', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-connection-metadata',
        })

        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })

        const acquirePromise = manager.acquire('session-connection-metadata', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })

        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket')).toHaveLength(1)
        })
        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({ type: 'codex.rate_limits', rate_limits: [] }),
        })
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.created',
                response: { id: 'resp_metadata', status: 'in_progress' },
            }),
        })
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({ type: 'codex.response.metadata', metadata: {} }),
        })
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.in_progress',
                response: { id: 'resp_metadata', status: 'in_progress' },
            }),
        })
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'resp_metadata',
                    status: 'completed',
                    usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        total_tokens: 2,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 0 },
                    },
                },
            }),
        })
        bridge.emit(opId, {
            kind: 'websocket-text',
            data: JSON.stringify({ type: 'responsesapi.websocket_timing', total_ms: 10 }),
        })

        const lease = await acquirePromise
        const events: unknown[] = []
        for await (const event of lease.events) {
            events.push(event)
        }

        expect(events.map((event) => (event as { type?: string }).type)).toEqual([
            'response.created',
            'response.in_progress',
            'response.completed',
        ])
        expect(bridge.calls.filter((c) => c.method === 'cancel')).toHaveLength(0)
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
        await lease.release({ keep: false })
    })

    it('accepts response.queued / response.in_progress as first lifecycle frames and rejects delta-first as stale', async () => {
        for (const startType of ['response.queued', 'response.in_progress'] as const) {
            const bridge = new FakeNativeBridge()
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-lifecycle-${startType}-${++n}`
                })(),
            })

            bridge.queueWebSocket({
                hold: true,
                frames: [{ kind: 'websocket-open' }],
            })

            const acquirePromise = manager.acquire(`session-lifecycle-${startType}`, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })

            await vi.waitFor(() => {
                expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
            })
            const opId = String(
                (
                    bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                        operationId: string
                    }
                ).operationId,
            )

            bridge.emit(opId, {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: startType,
                    response: { id: `resp_${startType}`, status: 'in_progress' },
                }),
            })
            bridge.emit(opId, {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.output_text.delta',
                    output_index: 0,
                    delta: 'ok',
                }),
            })
            bridge.emit(opId, {
                kind: 'websocket-text',
                data: JSON.stringify({
                    type: 'response.completed',
                    response: {
                        id: `resp_${startType}`,
                        status: 'completed',
                        usage: {
                            input_tokens: 1,
                            output_tokens: 1,
                            total_tokens: 2,
                            input_tokens_details: { cached_tokens: 0 },
                            output_tokens_details: { reasoning_tokens: 0 },
                        },
                    },
                }),
            })

            const lease = await acquirePromise
            const events: unknown[] = []
            for await (const event of lease.events) {
                events.push(event)
            }
            expect(events.some((e) => (e as { type?: string }).type === startType)).toBe(true)
            expect(
                events.some((e) => (e as { type?: string }).type === 'response.output_text.delta'),
            ).toBe(true)
            expect(events.some((e) => (e as { type?: string }).type === 'response.completed')).toBe(
                true,
            )
            // Single open: lifecycle start was accepted, not treated as stale reconnect.
            expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
            await lease.release({ keep: false })
        }

        // True delta-first is still stale and forces a fresh reconnect.
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-delta-first-stale-${++n}`
            })(),
        })
        bridge.queueWebSocket({
            hold: true,
            frames: [{ kind: 'websocket-open' }],
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_after_stale', 'ok')],
        })

        const acquirePromise = manager.acquire('session-delta-first-stale', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(1)
        })
        const firstOpId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )
        bridge.emit(firstOpId, {
            kind: 'websocket-text',
            data: JSON.stringify({
                type: 'response.output_text.delta',
                output_index: 0,
                delta: 'stale-first',
            }),
        })

        const lease = await acquirePromise
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBe(2)
        const events: unknown[] = []
        for await (const event of lease.events) {
            events.push(event)
        }
        expect(
            events.some(
                (e) =>
                    (e as { type?: string }).type === 'response.output_text.delta' &&
                    (e as { delta?: string }).delta === 'stale-first',
            ),
        ).toBe(false)
        expect(
            events.some((e) => (e as { response?: { id?: string } }).response?.id === 'resp_after_stale'),
        ).toBe(true)
        await lease.release({ keep: false })
    })

    it('never waits open when open resolve races timeout in the same tick; cancel once; retry budget holds', async () => {
        for (let round = 0; round < 8; round += 1) {
            const bridge = new FakeNativeBridge()
            const scheduled = new Map<number, { ms: number; fn: () => void }>()
            let handleSeq = 0
            const manager = new CodexConnectionManager(bridge, {
                now: () => 1_000,
                generateRequestId: (() => {
                    let n = 0
                    return () => `op-open-timeout-race-${round}-${++n}`
                })(),
                schedule: (fn, ms) => {
                    handleSeq += 1
                    scheduled.set(handleSeq, { fn, ms })
                    return handleSeq
                },
                cancelSchedule: (handle) => {
                    scheduled.delete(handle as number)
                },
            })

            const heldOps: Array<{
                resolve: (op: Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>) => void
                operation: Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>
            }> = []
            const origOpen = bridge.openWebSocket.bind(bridge)
            vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
                // Hold open fulfillment so tests can interleave timeout in the same microtask wave.
                // Frames include websocket-open only to detect accidental waitForOpen progress via send.
                bridge.queueWebSocket({
                    hold: true,
                    frames: [{ kind: 'websocket-open' }],
                })
                const operation = origOpen(input)
                return await new Promise((resolve) => {
                    heldOps.push({ resolve, operation })
                })
            })

            const pending = manager.acquire(`session-open-timeout-race-${round}`, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            // Interleave: fire connect timeout, then resolve open in the same microtask wave.
            for (let i = 0; i < MAX_CONNECT_RETRIES + 2; i += 1) {
                let done = false
                await Promise.race([
                    settled.then(() => {
                        done = true
                    }),
                    Promise.resolve(),
                ])
                if (done) {
                    break
                }
                await vi.waitFor(() => {
                    expect(scheduled.size > 0 || heldOps.length > 0).toBe(true)
                }).catch(() => {
                    // may already have rejected
                })
                await Promise.race([
                    settled.then(() => {
                        done = true
                    }),
                    Promise.resolve(),
                ])
                if (done) {
                    break
                }

                // Prefer timeout first, then open resolve — same tick interleaving.
                const active = [...scheduled.entries()]
                if (active.length > 0) {
                    const [handle, entry] = active[0]!
                    scheduled.delete(handle)
                    entry.fn()
                }
                while (heldOps.length > 0) {
                    const entry = heldOps.shift()!
                    entry.resolve(await entry.operation)
                }
                await Promise.resolve()
                await Promise.resolve()
                await Promise.resolve()
            }

            const result = await settled
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(String(result.error)).toMatch(/timeout/i)
            }

            // Timeout is retryable up to budget; parent abort is not involved here.
            const opens = bridge.calls.filter((c) => c.method === 'openWebSocket')
            expect(opens.length).toBe(MAX_CONNECT_RETRIES)
            const cancels = bridge.calls.filter((c) => c.method === 'cancel')
            // Exactly one cancel per timed-out attempt (binding-stage or manager, not both).
            expect(cancels.length).toBe(MAX_CONNECT_RETRIES)
            const byOp = new Map<string, number>()
            for (const call of cancels) {
                const opId = String(call.args[0])
                byOp.set(opId, (byOp.get(opId) ?? 0) + 1)
            }
            for (const count of byOp.values()) {
                expect(count).toBe(1)
            }
            // Never progressed to send (waitForOpen skipped after timeout recheck).
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket')).toHaveLength(0)
            vi.mocked(bridge.openWebSocket).mockRestore()
        }
    })

    it('observes late rejection for raceAbortable when wait signal is already aborted (no unhandled)', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-preabort-race',
        })

        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            const heldOps: Array<{
                resolve: (op: Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>) => void
                operation: Promise<Awaited<ReturnType<FakeNativeBridge['openWebSocket']>>>
            }> = []
            const origOpen = bridge.openWebSocket.bind(bridge)
            vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
                // No websocket-open frame: waitForOpen hangs until cancel/return rejects it.
                bridge.queueWebSocket({
                    hold: true,
                    frames: [],
                })
                const operation = origOpen(input)
                return await new Promise((resolve) => {
                    heldOps.push({ resolve, operation })
                })
            })

            const controller = new AbortController()
            const pending = manager.acquire('session-preabort-race', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: controller.signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            await vi.waitFor(() => {
                expect(heldOps.length).toBe(1)
            })

            // Abort parent before open fulfills so waitController is pre-aborted when race starts.
            controller.abort()
            // Same-tick: fulfill open after parent abort — recheck or pre-aborted wait race must observe settlement.
            const entry = heldOps[0]!
            entry.resolve(await entry.operation)
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()

            const result = await settled
            expect(result.ok).toBe(false)
            if (!result.ok) {
                expect(String(result.error)).toMatch(/abort/i)
            }

            // Force a late underlying rejection path via cancel/return churn.
            await Promise.resolve()
            await Promise.resolve()
            expect(unhandled).toEqual([])
            vi.mocked(bridge.openWebSocket).mockRestore()
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    it('attaches rejection handler when raceAbortable signal is already aborted (no unhandled late reject)', async () => {
        // Drive the open-binding path: hang open, abort parent so openController is aborted,
        // then late-reject the open promise and assert no unhandledRejection.
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-race-preabort-open',
        })

        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason)
        }
        process.on('unhandledRejection', onUnhandled)

        try {
            let rejectOpen!: (error: Error) => void
            vi.spyOn(bridge, 'openWebSocket').mockImplementation(async () => {
                await new Promise<never>((_resolve, reject) => {
                    rejectOpen = (error) => reject(error)
                })
                throw new Error('unreachable')
            })

            const controller = new AbortController()
            const pending = manager.acquire('session-race-preabort-open', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: controller.signal,
                mode: 'session',
            })
            const settled = pending.then(
                () => ({ ok: true as const }),
                (error: unknown) => ({ ok: false as const, error }),
            )

            await vi.waitFor(() => {
                expect(typeof rejectOpen).toBe('function')
            })

            // Abort wins the race; underlying open later rejects.
            controller.abort()
            const result = await settled
            expect(result.ok).toBe(false)

            rejectOpen(new Error('late open reject after abort race'))
            await Promise.resolve()
            await Promise.resolve()
            await Promise.resolve()
            expect(unhandled).toEqual([])
            vi.mocked(bridge.openWebSocket).mockRestore()
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })
})

describe('CodexClient', () => {
    it('streams via NativeBridge only and supports isolated mode without cache', async () => {
        const bridge = new FakeNativeBridge()
        let seq = 0
        const client = new CodexClient({
            bridge,
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            sessionId: 'session-client',
            now: () => 1_000,
            generateRequestId: () => `iso-${++seq}`,
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_iso', 'hello')],
        })

        const events: string[] = []
        const result = await (async () => {
            const stream = client.stream(
                {
                    model,
                    systemPrompt: 'sys',
                    entries: [
                        {
                            id: 'u1',
                            sessionId: 'session-client',
                            createdAt: 1,
                            kind: 'user',
                            content: [{ type: 'text', text: 'hi' }],
                        },
                    ],
                    nativeTools: [{ type: 'web_search' }],
                    toolChoice: 'required',
                    seed: seedAssistant(),
                },
                new AbortController().signal,
                { connectionMode: 'isolated' },
            )
            while (true) {
                const next = await stream.next()
                if (next.done) return next.value
                events.push(next.value.type)
            }
        })()

        expect(events[0]).toBe('start')
        expect(events[events.length - 1]).toBe('done')
        expect(result.status).toBe('done')
        expect(result.responseId).toBe('resp_iso')

        const open = bridge.calls.filter((c) => c.method === 'openWebSocket')
        expect(open).toHaveLength(1)
        // isolated requestId and operationId both come from generateRequestId:
        // request headers use the first id of each stream turn.
        expect(
            (open[0]?.args[0] as { headers: Record<string, string> }).headers['session-id'],
        ).toBe('iso-1')
        const firstSend = bridge.calls.find((call) => call.method === 'sendWebSocket')
        const firstBody = JSON.parse(String(firstSend?.args[1])) as CodexResponseCreate
        expect(firstBody.prompt_cache_key).toBe('iso-1')
        expect(firstBody.tools).toEqual([{ type: 'web_search' }])
        expect(firstBody.tool_choice).toBe('required')
        expect(firstBody.store).toBe(false)
        expect(firstBody.previous_response_id).toBeUndefined()

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_iso2', 'again')],
        })
        const stream2 = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u2',
                        sessionId: 'session-client',
                        createdAt: 2,
                        kind: 'user',
                        content: [{ type: 'text', text: 'again' }],
                    },
                ],
                seed: seedAssistant(),
            },
            new AbortController().signal,
            { connectionMode: 'isolated' },
        )
        while (true) {
            const next = await stream2.next()
            if (next.done) break
        }
        const opens = bridge.calls.filter((c) => c.method === 'openWebSocket')
        expect(opens).toHaveLength(2)
        // Second isolated turn: requestId iso-3 (iso-2 was first operation id).
        expect(
            (opens[1]?.args[0] as { headers: Record<string, string> }).headers['session-id'],
        ).toBe('iso-3')
        // Distinct request ids across isolated turns.
        expect(
            (opens[0]?.args[0] as { headers: Record<string, string> }).headers['session-id'],
        ).not.toBe(
            (opens[1]?.args[0] as { headers: Record<string, string> }).headers['session-id'],
        )
    })

    it('cancels at most once on abort and evicts session cache', async () => {
        const bridge = new FakeNativeBridge()
        const client = new CodexClient({
            bridge,
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            sessionId: 'session-abort',
            now: () => 1_000,
            generateRequestId: () => 'op',
        })

        bridge.queueWebSocket({
            frames: [
                { kind: 'websocket-open' },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.created',
                        response: { id: 'resp_ab', status: 'in_progress' },
                    }),
                },
            ],
        })

        const controller = new AbortController()
        const stream = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u1',
                        sessionId: 'session-abort',
                        createdAt: 1,
                        kind: 'user',
                        content: [{ type: 'text', text: 'hi' }],
                    },
                ],
                seed: seedAssistant(),
            },
            controller.signal,
            { connectionMode: 'session' },
        )

        const first = await stream.next()
        expect(first.done).toBe(false)

        controller.abort()
        controller.abort()

        await expect(async () => {
            while (true) {
                const next = await stream.next()
                if (next.done) break
            }
        }).rejects.toThrow(/abort/i)

        const cancels = bridge.calls.filter((c) => c.method === 'cancel')
        expect(cancels.length).toBeLessThanOrEqual(1)

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_new', 'n')],
        })
        const stream2 = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u2',
                        sessionId: 'session-abort',
                        createdAt: 2,
                        kind: 'user',
                        content: [{ type: 'text', text: 'next' }],
                    },
                ],
                seed: seedAssistant(),
            },
            new AbortController().signal,
            { connectionMode: 'session' },
        )
        while (true) {
            const next = await stream2.next()
            if (next.done) break
        }
        expect(
            bridge.calls.filter((c) => c.method === 'openWebSocket').length,
        ).toBeGreaterThanOrEqual(2)
    })

    it('outer early return midstream cancels socket so next turn is fresh with no bleed', async () => {
        const bridge = new FakeNativeBridge()
        let seq = 0
        const client = new CodexClient({
            bridge,
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            sessionId: 'session-early',
            now: () => 1_000,
            generateRequestId: () => `early-${++seq}`,
        })

        // No terminal event: consumer will abandon midstream after the first yield.
        bridge.queueWebSocket({
            frames: [
                { kind: 'websocket-open' },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.created',
                        response: { id: 'resp_early', status: 'in_progress' },
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: {
                            type: 'message',
                            id: 'msg_bleed',
                            role: 'assistant',
                            status: 'in_progress',
                            content: [],
                        },
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'should-not-bleed',
                    }),
                },
            ],
        })

        const stream = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u1',
                        sessionId: 'session-early',
                        createdAt: 1,
                        kind: 'user',
                        content: [{ type: 'text', text: 'hi' }],
                    },
                ],
                seed: seedAssistant(),
            },
            new AbortController().signal,
            { connectionMode: 'session' },
        )

        const first = await stream.next()
        expect(first.done).toBe(false)

        // Consumer abandons midstream — must cancel/evict before releasing serial lock.
        await stream.return?.(seedAssistant())

        expect(bridge.calls.some((c) => c.method === 'cancel')).toBe(true)

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_fresh', 'fresh')],
        })
        const stream2 = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u2',
                        sessionId: 'session-early',
                        createdAt: 2,
                        kind: 'user',
                        content: [{ type: 'text', text: 'next' }],
                    },
                ],
                seed: seedAssistant(),
            },
            new AbortController().signal,
            { connectionMode: 'session' },
        )

        const events: string[] = []
        let finalText = ''
        while (true) {
            const next = await stream2.next()
            if (next.done) {
                const textBlock = next.value.content.find((b) => b.type === 'text')
                if (textBlock && textBlock.type === 'text') {
                    finalText = textBlock.text
                }
                break
            }
            events.push(next.value.type)
        }

        expect(events[events.length - 1]).toBe('done')
        expect(finalText).toBe('fresh')
        expect(finalText).not.toContain('should-not-bleed')
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBeGreaterThanOrEqual(
            2,
        )
    })

    it('uses raw terminal response.output for session continuation, not rebuilt assistant entries', async () => {
        const bridge = new FakeNativeBridge()
        const client = new CodexClient({
            bridge,
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            sessionId: 'session-wire-out',
            now: () => 1_000,
            generateRequestId: () => 'op-wire',
        })

        const wireMessage = {
            type: 'message',
            id: 'msg_wire_out',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'wire-text', annotations: [] }],
        }

        bridge.queueWebSocket({
            frames: [
                { kind: 'websocket-open' },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.created',
                        response: { id: 'resp_wire', status: 'in_progress' },
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.output_item.added',
                        output_index: 0,
                        item: {
                            type: 'message',
                            id: 'msg_wire_out',
                            role: 'assistant',
                            status: 'in_progress',
                            content: [],
                        },
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.output_text.delta',
                        output_index: 0,
                        delta: 'wire-text',
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.output_item.done',
                        output_index: 0,
                        item: wireMessage,
                    }),
                },
                {
                    kind: 'websocket-text',
                    data: JSON.stringify({
                        type: 'response.completed',
                        response: {
                            id: 'resp_wire',
                            status: 'completed',
                            output: [wireMessage],
                            usage: {
                                input_tokens: 3,
                                output_tokens: 2,
                                total_tokens: 5,
                            },
                        },
                    }),
                },
            ],
        })

        const stream1 = client.stream(
            {
                model,
                systemPrompt: 'sys',
                entries: [
                    {
                        id: 'u1',
                        sessionId: 'session-wire-out',
                        createdAt: 1,
                        kind: 'user',
                        content: [{ type: 'text', text: 'hi' }],
                    },
                ],
                seed: seedAssistant(),
            },
            new AbortController().signal,
            { connectionMode: 'session' },
        )
        while (true) {
            const next = await stream1.next()
            if (next.done) break
        }

        const opId = String(
            (
                bridge.calls.find((c) => c.method === 'openWebSocket')?.args[0] as {
                    operationId: string
                }
            ).operationId,
        )

        const stream2Promise = (async () => {
            const stream2 = client.stream(
                {
                    model,
                    systemPrompt: 'sys',
                    entries: [
                        {
                            id: 'u1',
                            sessionId: 'session-wire-out',
                            createdAt: 1,
                            kind: 'user',
                            content: [{ type: 'text', text: 'hi' }],
                        },
                        {
                            id: 'a1',
                            sessionId: 'session-wire-out',
                            createdAt: 2,
                            kind: 'assistant',
                            model: 'gpt-test',
                            content: [
                                {
                                    type: 'text',
                                    text: 'wire-text',
                                    signature: JSON.stringify({
                                        v: 1,
                                        id: 'msg_wire_out',
                                        phase: 'final_answer',
                                    }),
                                },
                            ],
                            status: 'done',
                            stopReason: 'stop',
                            responseId: 'resp_wire',
                        },
                        {
                            id: 'u2',
                            sessionId: 'session-wire-out',
                            createdAt: 3,
                            kind: 'user',
                            content: [{ type: 'text', text: 'again' }],
                        },
                    ],
                    seed: seedAssistant(),
                },
                new AbortController().signal,
                { connectionMode: 'session' },
            )
            while (true) {
                const next = await stream2.next()
                if (next.done) return next.value
            }
        })()

        await vi.waitFor(() => {
            expect(bridge.calls.filter((c) => c.method === 'sendWebSocket').length).toBe(2)
        })
        for (const frame of completedTextFrames('resp_wire2', 'two')) {
            bridge.emit(opId, frame)
        }
        await stream2Promise

        const sendCalls = bridge.calls.filter((c) => c.method === 'sendWebSocket')
        const sent2 = JSON.parse(String(sendCalls[1]?.args[1])) as CodexResponseCreate
        expect(sent2.previous_response_id).toBe('resp_wire')
        // Delta suffix only — proves continuation baseline used stored wire output items.
        expect(sent2.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'again' }] },
        ])
        expect(bridge.calls.filter((c) => c.method === 'openWebSocket')).toHaveLength(1)
    })

    it('same session with config change opens a fresh socket and cancels the old one', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: (() => {
                let n = 0
                return () => `op-cfg-${++n}`
            })(),
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_a', 'one')],
        })
        // Opaque namespace rotates with auth identity (service-assigned); never key hash.
        const lease1 = await manager.acquire('session-cfg', {
            apiKey: 'key-a',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            requestId: 'session-cfg',
            connectionNamespace: 'ns-key-a',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        lease1.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_a',
            responseItems: [],
        })
        await lease1.release({ keep: true })

        const cancelsBefore = bridge.calls.filter((c) => c.method === 'cancel').length

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_b', 'two')],
        })
        const lease2 = await manager.acquire('session-cfg', {
            apiKey: 'key-b',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            requestId: 'session-cfg',
            connectionNamespace: 'ns-key-b',
        })
        for await (const _ of lease2.events) {
            // drain
        }
        lease2.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_b',
            responseItems: [],
        })
        await lease2.release({ keep: true })

        expect(bridge.calls.filter((c) => c.method === 'openWebSocket').length).toBeGreaterThanOrEqual(
            2,
        )
        expect(
            bridge.calls.filter((c) => c.method === 'cancel').length,
        ).toBeGreaterThan(cancelsBefore)

        // Headers still carry the real session id, not the opaque cache key.
        const openArgs = bridge.calls.filter((c) => c.method === 'openWebSocket')
        for (const call of openArgs) {
            const headers = (call.args[0] as { headers: Record<string, string> }).headers
            expect(headers['session-id']).toBe('session-cfg')
        }
    })

    it('dispose closes idle cached sockets and rejects future acquire', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-dispose',
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_d', 'one')],
        })
        const lease = await manager.acquire('session-dispose', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
        })
        for await (const _ of lease.events) {
            // drain
        }
        lease.commit({
            fullRequestBody: baseRequest(),
            responseId: 'resp_d',
            responseItems: [],
        })
        await lease.release({ keep: true })
        expect(manager.cachedSessionCount).toBe(1)

        await manager.dispose()
        expect(manager.isDisposed).toBe(true)
        expect(manager.cachedSessionCount).toBe(0)
        expect(
            bridge.calls.some((c) => c.method === 'cancel'),
        ).toBe(true)

        await expect(
            manager.acquire('session-dispose', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
            }),
        ).rejects.toThrow(/disposed/i)

        await manager.dispose() // idempotent
    })

    it('rejects queued lock waiters on connectionNamespace switch, then new namespace succeeds', async () => {
        const bridge = new FakeNativeBridge()
        let n = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => `op-ns-${++n}`,
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_ns1', 'hold')],
        })

        const lease1 = await manager.acquire('session-ns', {
            apiKey: 'key-a',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-old',
        })

        // Queue a second acquire on the old namespace while the lock is held.
        const queued = manager.acquire('session-ns', {
            apiKey: 'key-a',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest({
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'queued' }] }],
            }),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-old',
        })
        await Promise.resolve()

        // Config switch: new namespace for same logical session rejects old waiters.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_ns2', 'new')],
        })
        const switched = manager.acquire('session-ns', {
            apiKey: 'key-b',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest({
                input: [{ role: 'user', content: [{ type: 'input_text', text: 'new' }] }],
            }),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-new',
        })

        await expect(queued).rejects.toThrow(/identity changed|lock closed|Session closed/i)

        // Release the old holder so it no longer occupies resources.
        for await (const _ of lease1.events) {
            // drain
        }
        await lease1.release({ keep: false })

        const leaseNew = await switched
        for await (const _ of leaseNew.events) {
            // drain
        }
        await leaseNew.release({ keep: true })
        expect(manager.cachedSessionCount).toBe(1)
        await manager.dispose()
    })

    it('tracks isolated sockets and dispose closes them exactly once', async () => {
        const bridge = new FakeNativeBridge()
        let n = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => `op-iso-${++n}`,
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_iso', 'x')],
        })

        const lease = await manager.acquire(null, {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'isolated',
        })

        expect(manager.cachedSessionCount).toBe(0)
        expect(manager.liveSocketCount).toBe(1)

        await manager.dispose()
        expect(manager.liveSocketCount).toBe(0)
        expect(manager.isDisposed).toBe(true)

        const cancelCalls = bridge.calls.filter((c) => c.method === 'cancel')
        expect(cancelCalls.length).toBe(1)

        // Late release after dispose is a no-op (already closed).
        await lease.release()
        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBe(1)
    })

    it('isolated lease release removes live tracking without double cancel', async () => {
        const bridge = new FakeNativeBridge()
        let n = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => `op-iso-rel-${++n}`,
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_iso2', 'y')],
        })

        const lease = await manager.acquire(null, {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'isolated',
        })
        expect(manager.liveSocketCount).toBe(1)

        for await (const _ of lease.events) {
            // drain
        }
        await lease.release()
        expect(manager.liveSocketCount).toBe(0)

        const cancelsBefore = bridge.calls.filter((c) => c.method === 'cancel').length
        await manager.dispose()
        expect(bridge.calls.filter((c) => c.method === 'cancel').length).toBe(cancelsBefore)
    })

    it('closeSession rejects queued waiters for that identity', async () => {
        const bridge = new FakeNativeBridge()
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => 'op-close-sess',
        })
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_cs', 'hold')],
        })

        const lease1 = await manager.acquire('session-cs', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-cs',
        })

        const queued = manager.acquire('session-cs', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-cs',
        })
        await Promise.resolve()

        manager.closeSession('session-cs')
        await expect(queued).rejects.toThrow(/Session closed|lock closed|namespace closed/i)

        for await (const _ of lease1.events) {
            // drain
        }
        await lease1.release({ keep: false })
        await manager.dispose()
    })

    it('closed namespace is permanent tombstone; new namespace still works', async () => {
        const bridge = new FakeNativeBridge()
        let n = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => `op-tomb-${++n}`,
        })

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_t1', 'old')],
        })
        const lease1 = await manager.acquire('session-tomb', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-old',
        })
        for await (const _ of lease1.events) {
            // drain
        }
        await lease1.release({ keep: true })

        const oldKey = buildConnectionCacheKey('ns-old', 'session-tomb')
        manager.closeSession('session-tomb')
        expect(manager.isKeyClosed(oldKey)).toBe(true)

        // Idle re-acquire on the closed namespace must always reject (no reopen).
        await expect(
            manager.acquire('session-tomb', {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'session',
                connectionNamespace: 'ns-old',
            }),
        ).rejects.toThrow(/namespace closed|lock closed|Session closed/i)

        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_t2', 'new')],
        })
        const lease2 = await manager.acquire('session-tomb', {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'session',
            connectionNamespace: 'ns-new',
        })
        for await (const _ of lease2.events) {
            // drain
        }
        await lease2.release({ keep: true })
        expect(manager.cachedSessionCount).toBe(1)
        await manager.dispose()
    })

    it('dispose aborts never-resolving open; late resolve cancels once and never leases', async () => {
        const bridge = new FakeNativeBridge()
        let n = 0
        const manager = new CodexConnectionManager(bridge, {
            now: () => 1_000,
            generateRequestId: () => `op-late-${++n}`,
        })

        let releaseOpen!: () => void
        const openGate = new Promise<void>((resolve) => {
            releaseOpen = resolve
        })
        const originalOpen = bridge.openWebSocket.bind(bridge)
        vi.spyOn(bridge, 'openWebSocket').mockImplementation(async (input) => {
            // Park forever until we manually release after dispose.
            await openGate
            return originalOpen(input)
        })

        const acquirePromise = manager.acquire(null, {
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:8317/backend-api/',
            request: baseRequest(),
            signal: new AbortController().signal,
            mode: 'isolated',
        })
        // Let acquire register the pre-open attempt.
        await Promise.resolve()
        await Promise.resolve()

        await manager.dispose()
        await expect(acquirePromise).rejects.toThrow(/disposed/i)
        expect(manager.liveSocketCount).toBe(0)
        expect(manager.cachedSessionCount).toBe(0)

        const cancelsBeforeLate = bridge.calls.filter((c) => c.method === 'cancel').length

        // Late open resolve must cancel once and never lease/cache.
        bridge.queueWebSocket({
            frames: [{ kind: 'websocket-open' }, ...completedTextFrames('resp_late', 'x')],
        })
        releaseOpen()
        // Flush late cleanup microtasks.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 0))

        expect(manager.liveSocketCount).toBe(0)
        expect(manager.cachedSessionCount).toBe(0)
        // Exactly one cancel path for the late open (cleanup uses alreadyCancelled latch).
        const cancelsAfter = bridge.calls.filter((c) => c.method === 'cancel').length
        expect(cancelsAfter - cancelsBeforeLate).toBeLessThanOrEqual(1)

        // Future acquire still rejects.
        await expect(
            manager.acquire(null, {
                apiKey: 'k',
                baseUrl: 'http://127.0.0.1:8317/backend-api/',
                request: baseRequest(),
                signal: new AbortController().signal,
                mode: 'isolated',
            }),
        ).rejects.toThrow(/disposed/i)
    })
})
