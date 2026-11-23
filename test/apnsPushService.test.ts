import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { capturedLocalNotifications, MockElectronNotification, mockElectronApp } = vi.hoisted(() => {
    const capturedLocalNotifications: Array<{ title: string; body: string }> = []

    class MockNotificationClass {
        options: { title: string; body: string }
        constructor(options: { title: string; body: string }) {
            this.options = options
            capturedLocalNotifications.push(options)
        }
        on(): this {
            return this
        }
        show(): void {}
    }

    const mockElectronApp = {
        dock: { setBadge: vi.fn(), bounce: vi.fn() },
        setBadgeCount: vi.fn(),
        setAppUserModelId: vi.fn(),
    }

    return {
        capturedLocalNotifications,
        MockElectronNotification: MockNotificationClass,
        mockElectronApp,
    }
})

vi.mock('electron', () => ({
    app: mockElectronApp,
    Notification: MockElectronNotification,
    BrowserWindow: vi.fn(),
}))

import {
    ApnsPushService,
    DEFAULT_APNS_PUSH_URL,
    NOTIFICATION_CLIENTS_STORAGE_KEY,
    type KVStoreLike,
    type RegisteredNotificationClient,
} from '../src/main/services/apnsPushService.js'
import { NotificationBadgeService } from '../src/main/services/notificationBadgeService.js'

class InMemoryKVStore implements KVStoreLike {
    private store = new Map<string, unknown>()
    public saveCalls = 0
    public setCalls = 0

    async get(key: string): Promise<unknown> {
        const value = this.store.get(key)
        return value === undefined ? undefined : structuredClone(value)
    }

    async set(key: string, value: unknown): Promise<void> {
        this.setCalls += 1
        this.store.set(key, structuredClone(value))
    }

    async save(): Promise<void> {
        this.saveCalls += 1
    }

    peek(key: string): unknown {
        return this.store.get(key)
    }
}

const TOKEN_A = 'a'.repeat(64)
const TOKEN_A_UPPER = 'A'.repeat(64)
const TOKEN_B = 'b'.repeat(64)
const TOKEN_NEW = 'c'.repeat(64)

describe('ApnsPushService', () => {
    let kvStore: InMemoryKVStore
    let originalServiceUrl: string | undefined

    beforeEach(() => {
        kvStore = new InMemoryKVStore()
        capturedLocalNotifications.length = 0
        originalServiceUrl = process.env.CPA_NOTIFICATION_SERVICE_URL
        delete process.env.CPA_NOTIFICATION_SERVICE_URL
    })

    afterEach(() => {
        if (originalServiceUrl === undefined) {
            delete process.env.CPA_NOTIFICATION_SERVICE_URL
        } else {
            process.env.CPA_NOTIFICATION_SERVICE_URL = originalServiceUrl
        }
        vi.restoreAllMocks()
    })

    it('registers and upserts client by (clientId, connectionId) in notification-clients key', async () => {
        let nowMs = 1_700_000_000_000
        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            now: () => nowMs,
        })

        // Initial registration normalizes uppercase hex token to lowercase
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: `  ${TOKEN_A_UPPER}  `,
            environment: 'sandbox',
            platform: 'ios',
            deviceName: 'iPhone 16 Pro',
            appVersion: '1.0.0',
            enabled: true,
        })

        let clients = (await kvStore.get(NOTIFICATION_CLIENTS_STORAGE_KEY)) as RegisteredNotificationClient[]
        expect(clients).toHaveLength(1)
        expect(clients[0]).toEqual({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'sandbox',
            platform: 'ios',
            deviceName: 'iPhone 16 Pro',
            appVersion: '1.0.0',
            enabled: true,
            registeredAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
        })
        expect(kvStore.saveCalls).toBe(1)

        // Token rotation on same (clientId, connectionId) overwrites old entry instead of appending
        nowMs = 1_700_000_050_000
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            platform: 'ios',
            deviceName: 'iPhone 16 Pro',
            appVersion: '1.0.1',
            enabled: false,
        })

        clients = await service.listClients()
        expect(clients).toHaveLength(1)
        expect(clients[0]).toEqual({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            platform: 'ios',
            deviceName: 'iPhone 16 Pro',
            appVersion: '1.0.1',
            enabled: false,
            registeredAt: 1_700_000_000_000,
            updatedAt: 1_700_000_050_000,
        })

        // Different connectionId for same clientId creates a separate entry
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'production',
            platform: 'ios',
            enabled: true,
        })
        clients = await service.listClients()
        expect(clients).toHaveLength(2)

        // Rejects invalid registration parameters
        await expect(
            service.registerClient({
                clientId: '   ',
                connectionId: 'conn-1',
                deviceToken: TOKEN_A,
                environment: 'production',
            }),
        ).rejects.toThrow()

        await expect(
            service.registerClient({
                clientId: 'client-1',
                connectionId: '',
                deviceToken: TOKEN_A,
                environment: 'production',
            }),
        ).rejects.toThrow()

        await expect(
            service.registerClient({
                clientId: 'client-1',
                connectionId: 'conn-1',
                deviceToken: 'not-hex-' + 'a'.repeat(56),
                environment: 'production',
            }),
        ).rejects.toThrow()

        await expect(
            service.registerClient({
                clientId: 'client-1',
                connectionId: 'conn-1',
                deviceToken: 'a'.repeat(63),
                environment: 'production',
            }),
        ).rejects.toThrow()

        await expect(
            service.registerClient({
                clientId: 'client-1',
                connectionId: 'conn-1',
                deviceToken: 'a'.repeat(201),
                environment: 'production',
            }),
        ).rejects.toThrow()

        await expect(
            service.registerClient({
                clientId: 'client-1',
                connectionId: 'conn-1',
                deviceToken: TOKEN_A,
                environment: 'staging' as any,
            }),
        ).rejects.toThrow()
    })

    const android = {
        clientId: 'android-install',
        connectionId: 'android-connection',
        platform: 'android',
        provider: 'fcm',
        deviceToken: 'Fcm:Mixed_Case-Id',
    } as const

    it('delivers both events to legacy APNs and FCM registrations after reopening the store', async () => {
        // Legacy persisted form predates the provider field and can omit platform.
        await kvStore.set(NOTIFICATION_CLIENTS_STORAGE_KEY, [{
            clientId: 'ios-install', connectionId: 'ios-connection', deviceToken: TOKEN_A_UPPER,
            environment: 'sandbox', enabled: true, registeredAt: 1, updatedAt: 1,
        }])
        const service = new ApnsPushService(() => kvStore)
        await service.registerClient(android)
        await service.registerClient({ ...android, connectionId: 'disabled', enabled: false })

        const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ok: true }))
        const reopened = new ApnsPushService({ kvStoreGetter: () => kvStore, fetchFn })
        const session = { sessionId: 's1', sessionTitle: 'Private session' }
        await reopened.notifyTaskCompleted(session)
        await reopened.notifyAskRequested({ ...session, question: 'Private question' })
        const sent = fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
        expect(sent).toHaveLength(4)
        expect(sent.filter(req => req.provider === 'fcm')).toEqual(
            ['taskCompleted', 'ask'].map(notificationType => ({
                provider: 'fcm', deviceToken: android.deviceToken,
                data: { connectionId: android.connectionId, sessionId: 's1', notificationType },
            })),
        )
        expect(sent.filter(req => !req.provider)).toHaveLength(2)
        expect(sent[0]).toMatchObject({ deviceToken: TOKEN_A, environment: 'sandbox', data: { sessionTitle: session.sessionTitle } })

        await reopened.unregisterClient(android)
        expect((await reopened.listClients()).map(c => c.connectionId)).toEqual(['ios-connection', 'disabled'])
    })

    it('checks provider, platform and opaque FCM target before persisting registrations', async () => {
        const service = new ApnsPushService(() => kvStore)
        for (const invalid of [
            { provider: undefined }, { platform: 'ios' }, { platform: undefined },
            { environment: 'sandbox' }, { provider: 'invalid' }, { deviceToken: '' },
            { deviceToken: 'bad ID' }, { deviceToken: 'token\u0001' }, { deviceToken: 'é'.repeat(2049) },
        ]) {
            await expect(service.registerClient({ ...android, ...invalid } as any)).rejects.toThrow()
        }
        expect(await service.listClients()).toEqual([])
    })

    it('keeps rotated FCM identifiers and only deletes confirmed unregistrations', async () => {
        let complete!: (response: Response) => void
        const fetchFn = vi.fn(async () => new Promise<Response>(resolve => { complete = resolve }))
        const service = new ApnsPushService({ kvStoreGetter: () => kvStore, fetchFn, logger: {} })
        await service.registerClient(android)
        const pending = service.notifyTaskCompleted({ sessionId: 's1' })
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce())
        const rotated = { ...android, deviceToken: android.deviceToken.toLowerCase() }
        await service.registerClient(rotated)
        const gone = () => Response.json({ ok: false, unregistered: true }, { status: 410 })
        complete(gone())
        await pending
        expect(await service.listClients()).toMatchObject([{ deviceToken: rotated.deviceToken }])
        for (const status of [400, 403, 429, 502, 504, 410]) {
            fetchFn.mockResolvedValueOnce(Response.json({ ok: false, unregistered: false }, { status }))
            await service.notifyTaskCompleted({ sessionId: 's1' })
            expect(await service.listClients()).toHaveLength(1)
        }
        fetchFn.mockResolvedValueOnce(gone())
        await service.notifyTaskCompleted({ sessionId: 's1' })
        expect(await service.listClients()).toEqual([])
        service.dispose()
    })

    it.each([429, 503])('retries a rejected FCM send once after Retry-After (%s)', async status => {
        vi.useFakeTimers()
        const rejected = () => Response.json({ unregistered: false }, {
            status, headers: { 'Retry-After': '90' },
        })
        const fetchFn = vi.fn(async () => rejected())
        const service = new ApnsPushService({ kvStoreGetter: () => kvStore, fetchFn, logger: {} })
        try {
            await service.registerClient(android)
            await service.notifyAskRequested({ sessionId: 's1' })
            await vi.advanceTimersByTimeAsync(89_999)
            expect(fetchFn).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(1)
            expect(fetchFn).toHaveBeenCalledTimes(2)
            await vi.advanceTimersByTimeAsync(600_000)
            expect(fetchFn).toHaveBeenCalledTimes(2)
        } finally {
            service.dispose()
            vi.useRealTimers()
        }
    })

    it.each(['rotate', 'unregister', 'disable'] as const)('suppresses pending retry after %s', async action => {
        vi.useFakeTimers()
        const fetchFn = vi.fn(async () => new Response(null, { status: 429 }))
        const service = new ApnsPushService({ kvStoreGetter: () => kvStore, fetchFn, logger: {} })
        try {
            await service.registerClient(android)
            await service.notifyTaskCompleted({ sessionId: 's1' })
            if (action === 'unregister') await service.unregisterClient(android)
            if (action === 'disable') await service.registerClient({ ...android, enabled: false })
            if (action === 'rotate') await service.registerClient({ ...android, deviceToken: android.deviceToken.toUpperCase() })
            await vi.advanceTimersByTimeAsync(60_000)
            expect(fetchFn).toHaveBeenCalledOnce()
        } finally {
            service.dispose()
            vi.useRealTimers()
        }
    })

    it('coalesces pending FCM retries and skips expired delays, unconfigured providers and unknown outcomes', async () => {
        vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') })
        const fetchFn = vi.fn(async () => Response.json({ ok: true }))
        const service = new ApnsPushService({ kvStoreGetter: () => kvStore, fetchFn, logger: {} })
        try {
            await service.registerClient(android)
            fetchFn.mockResolvedValueOnce(new Response(null, { status: 429 }))
            fetchFn.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': new Date(Date.now() + 70_000).toUTCString() } }))
            await service.notifyTaskCompleted({ sessionId: 'duplicate' })
            await service.notifyTaskCompleted({ sessionId: 'duplicate' })
            fetchFn.mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '3600' } }))
            await service.notifyTaskCompleted({ sessionId: 'next-hour' })
            fetchFn.mockResolvedValueOnce(Response.json({ reason: 'fcm not configured' }, { status: 503 }))
            await service.notifyTaskCompleted({ sessionId: 'not-configured' })
            fetchFn.mockRejectedValueOnce(new Error('connection lost'))
            await service.notifyTaskCompleted({ sessionId: 'unknown' })
            fetchFn.mockResolvedValueOnce(new Response(null, { status: 504 }))
            await service.notifyTaskCompleted({ sessionId: 'timed-out' })
            await vi.advanceTimersByTimeAsync(69_999)
            expect(fetchFn).toHaveBeenCalledTimes(6)
            await vi.advanceTimersByTimeAsync(1)
            expect(fetchFn).toHaveBeenCalledTimes(7)
            await vi.advanceTimersByTimeAsync(3_600_000)
            expect(fetchFn).toHaveBeenCalledTimes(7)
        } finally {
            service.dispose()
            vi.useRealTimers()
        }
    })

    it('unregisters matching client by (clientId, connectionId)', async () => {
        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
        })

        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: true,
        })

        const saveCountBefore = kvStore.saveCalls
        await service.unregisterClient({ clientId: 'client-1', connectionId: 'conn-1' })

        const clients = await service.listClients()
        expect(clients).toHaveLength(1)
        expect(clients[0].connectionId).toBe('conn-2')
        expect(kvStore.saveCalls).toBe(saveCountBefore + 1)

        // Unregistering non-existent client is a clean no-op
        await service.unregisterClient({ clientId: 'client-1', connectionId: 'conn-unknown' })
        expect(await service.listClients()).toHaveLength(1)

        // Rejects empty identifiers
        await expect(
            service.unregisterClient({ clientId: '', connectionId: 'conn-2' }),
        ).rejects.toThrow()
    })

    it('skips disabled clients and pushes concurrently to enabled clients on task completion', async () => {
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
        const requests: Array<{ url: string; body: any; signal?: AbortSignal | null }> = []
        const deferredResolvers: Array<(res: Response) => void> = []

        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            requests.push({
                url: String(input),
                body: JSON.parse(String(init?.body ?? '{}')),
                signal: init?.signal,
            })
            return await new Promise<Response>((resolve) => {
                deferredResolvers.push(resolve)
            })
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })

        await service.registerClient({
            clientId: 'client-enabled-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-disabled',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: false,
        })
        await service.registerClient({
            clientId: 'client-enabled-2',
            connectionId: 'conn-3',
            deviceToken: TOKEN_NEW,
            environment: 'sandbox',
            enabled: true,
        })

        // Case 1: Long title (> 40 characters) with default gateway URL and true concurrency check
        const longTitle = 'A'.repeat(50)
        const pendingNotify = service.notifyTaskCompleted({
            sessionId: 'session-123',
            sessionTitle: `  ${longTitle}  `,
        })

        // Wait microtasks so both concurrent fetch calls are initiated before either resolves
        await vi.waitFor(() => {
            expect(fetchMock).toHaveBeenCalledTimes(2)
            expect(deferredResolvers).toHaveLength(2)
        })

        // Resolve both pending fetch calls
        for (const resolve of deferredResolvers.splice(0)) {
            resolve(
                new Response(JSON.stringify({ ok: true, apnsId: 'apns-1' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            )
        }
        await pendingNotify

        expect(timeoutSpy).toHaveBeenCalledWith(10_000)
        expect(requests.map((r) => r.url)).toEqual([DEFAULT_APNS_PUSH_URL, DEFAULT_APNS_PUSH_URL])
        for (const req of requests) {
            expect(req.signal).toBeInstanceOf(AbortSignal)
            expect(req.body.title).toBe('Coding Professional Agent')
            expect(req.body.body).toBe(`${'A'.repeat(40)}... 任务已经完成`)
            expect(req.body.sound).toBe('default')
            expect(req.body.threadId).toBe('session-123')
            expect(req.body.collapseId).toBe('turn-complete-session-123')
            expect(req.body.data.sessionId).toBe('session-123')
        }
        expect(requests.map((r) => r.body.data.connectionId).sort()).toEqual(['conn-1', 'conn-3'])
        expect(requests.find((r) => r.body.data.connectionId === 'conn-3')?.body.environment).toBe('sandbox')

        // Case 2: Empty title falls back to "任务已经完成" and respects CPA_NOTIFICATION_SERVICE_URL override
        requests.length = 0
        process.env.CPA_NOTIFICATION_SERVICE_URL = 'http://127.0.0.1:18080/v1/push'
        const emptyTitleNotify = service.notifyTaskCompleted({
            sessionId: 'session-456',
            sessionTitle: '   ',
        })
        await vi.waitFor(() => {
            expect(deferredResolvers).toHaveLength(2)
        })
        for (const resolve of deferredResolvers.splice(0)) {
            resolve(
                new Response(JSON.stringify({ ok: true, apnsId: 'apns-2' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            )
        }
        await emptyTitleNotify

        expect(requests).toHaveLength(2)
        for (const req of requests) {
            expect(req.url).toBe('http://127.0.0.1:18080/v1/push')
            expect(req.body.body).toBe('任务已经完成')
            expect(req.body.data.sessionId).toBe('session-456')
        }
    })

    it('formats notification body identically to NotificationBadgeService', async () => {
        const pushBodies: string[] = []
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body ?? '{}'))
            pushBodies.push(payload.body)
            return new Response(JSON.stringify({ ok: true, apnsId: 'apns-parity' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        const pushService = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })
        await pushService.registerClient({
            clientId: 'client-parity',
            connectionId: 'conn-parity',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })

        const badgeService = new NotificationBadgeService(() => null)
        const testCases = [
            undefined,
            '   ',
            'Short Task',
            'A'.repeat(40),
            'A'.repeat(50),
            `${'测'.repeat(39)}🚀完成`,
        ]

        for (const sessionTitle of testCases) {
            badgeService.notifyTaskCompleted({ sessionId: 'session-parity', sessionTitle })
            await pushService.notifyTaskCompleted({ sessionId: 'session-parity', sessionTitle })
        }

        expect(capturedLocalNotifications).toHaveLength(testCases.length)
        expect(pushBodies).toHaveLength(testCases.length)
        for (let i = 0; i < testCases.length; i += 1) {
            expect(pushBodies[i]).toBe(capturedLocalNotifications[i].body)
        }
    })

    it('removes client automatically when service responds 410 or unregistered=true', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body ?? '{}'))
            if (payload.deviceToken === TOKEN_A) {
                return new Response(
                    JSON.stringify({ ok: false, reason: 'Unregistered', unregistered: true }),
                    { status: 410, headers: { 'content-type': 'application/json' } },
                )
            }
            if (payload.deviceToken === TOKEN_B) {
                return new Response(
                    JSON.stringify({ ok: false, reason: 'BadDeviceToken', unregistered: true }),
                    { status: 400, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response(JSON.stringify({ ok: true, apnsId: 'apns-ok' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })

        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-2',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-3',
            connectionId: 'conn-3',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            enabled: true,
        })

        await service.notifyTaskCompleted({
            sessionId: 'session-789',
            sessionTitle: 'Cleanup Test',
        })

        const remaining = await service.listClients()
        expect(remaining).toHaveLength(1)
        expect(remaining[0].clientId).toBe('client-3')
        expect(remaining[0].deviceToken).toBe(TOKEN_NEW)
    })

    it('removes client on standalone HTTP 410 even when body omits unregistered or is empty', async () => {
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body ?? '{}'))
            if (payload.deviceToken === TOKEN_A) {
                // Empty 410 response body
                return new Response('', { status: 410 })
            }
            if (payload.deviceToken === TOKEN_B) {
                // JSON 410 response omitting the unregistered field
                return new Response(
                    JSON.stringify({ ok: false, reason: 'Gone' }),
                    { status: 410, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response(JSON.stringify({ ok: true, apnsId: 'apns-keep' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })

        await service.registerClient({
            clientId: 'client-410-empty',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-410-no-flag',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-keep',
            connectionId: 'conn-3',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            enabled: true,
        })

        await service.notifyTaskCompleted({
            sessionId: 'session-410',
            sessionTitle: 'Standalone 410 Test',
        })

        const remaining = await service.listClients()
        expect(remaining).toHaveLength(1)
        expect(remaining[0].clientId).toBe('client-keep')
        expect(remaining[0].deviceToken).toBe(TOKEN_NEW)
    })

    it('does not remove newly rotated deviceToken when an earlier push for stale token returns unregistered=true', async () => {
        let resolveStalePush!: (value: Response) => void
        let markPushStarted!: () => void
        const pushStarted = new Promise<void>((resolve) => {
            markPushStarted = resolve
        })

        const fetchMock = vi.fn(async () => {
            markPushStarted()
            return await new Promise<Response>((resolve) => {
                resolveStalePush = resolve
            })
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })

        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })

        // Start push targeting TOKEN_A
        const notifyPromise = service.notifyTaskCompleted({
            sessionId: 'session-race',
            sessionTitle: 'Token Rotation Race',
        })
        await pushStarted

        // Rotate deviceToken to TOKEN_NEW while stale push is still in flight
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            enabled: true,
        })

        // Stale push completes with 410 unregistered=true for TOKEN_A
        resolveStalePush(
            new Response(
                JSON.stringify({ ok: false, reason: 'Unregistered', unregistered: true }),
                { status: 410, headers: { 'content-type': 'application/json' } },
            ),
        )
        await notifyPromise

        // Newly rotated TOKEN_NEW must NOT be deleted
        const clients = await service.listClients()
        expect(clients).toHaveLength(1)
        expect(clients[0].clientId).toBe('client-1')
        expect(clients[0].connectionId).toBe('conn-1')
        expect(clients[0].deviceToken).toBe(TOKEN_NEW)
    })

    it('ignores network errors and timeouts without throwing or deleting client', async () => {
        const loggerWarn = vi.fn()
        let callIndex = 0
        const fetchMock = vi.fn(async () => {
            callIndex += 1
            if (callIndex === 1) {
                throw new Error('ECONNREFUSED')
            }
            if (callIndex === 2) {
                const err = new Error('The operation timed out')
                err.name = 'TimeoutError'
                throw err
            }
            return new Response(
                JSON.stringify({ ok: false, reason: 'apns upstream error', unregistered: false }),
                { status: 504, headers: { 'content-type': 'application/json' } },
            )
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
            logger: { warn: loggerWarn },
        })

        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-2',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-3',
            connectionId: 'conn-3',
            deviceToken: TOKEN_NEW,
            environment: 'production',
            enabled: true,
        })

        await expect(
            service.notifyTaskCompleted({
                sessionId: 'session-err',
                sessionTitle: 'Network Error Test',
            }),
        ).resolves.toBeUndefined()

        expect(await service.listClients()).toHaveLength(3)
        expect(loggerWarn).toHaveBeenCalled()
    })

    it('handles concurrent registrations serially and null kvStore gracefully', async () => {
        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
        })

        await Promise.all([
            service.registerClient({
                clientId: 'c1',
                connectionId: 'conn-1',
                deviceToken: TOKEN_A,
                environment: 'production',
            }),
            service.registerClient({
                clientId: 'c2',
                connectionId: 'conn-2',
                deviceToken: TOKEN_B,
                environment: 'sandbox',
            }),
            service.registerClient({
                clientId: 'c3',
                connectionId: 'conn-3',
                deviceToken: TOKEN_NEW,
                environment: 'production',
            }),
        ])

        const clients = await service.listClients()
        expect(clients).toHaveLength(3)

        // Null kvStore behavior
        const unreadyService = new ApnsPushService({ kvStoreGetter: () => null })
        expect(await unreadyService.listClients()).toEqual([])
        await expect(
            unreadyService.notifyTaskCompleted({ sessionId: 's1' }),
        ).resolves.toBeUndefined()
        await expect(
            unreadyService.registerClient({
                clientId: 'c1',
                connectionId: 'conn-1',
                deviceToken: TOKEN_A,
                environment: 'production',
            }),
        ).rejects.toThrow()
    })

    it('pushes ask notifications concurrently with collapsed question text, bounded collapseId, and badge parity', async () => {
        const requests: Array<{ body: any }> = []
        const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
            const payload = JSON.parse(String(init?.body ?? '{}'))
            requests.push({ body: payload })
            if (payload.deviceToken === TOKEN_B) {
                return new Response(
                    JSON.stringify({ ok: false, reason: 'Unregistered', unregistered: true }),
                    { status: 410, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response(JSON.stringify({ ok: true, apnsId: 'apns-ask' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        })

        const service = new ApnsPushService({
            kvStoreGetter: () => kvStore,
            fetchFn: fetchMock,
        })
        await service.registerClient({
            clientId: 'client-1',
            connectionId: 'conn-1',
            deviceToken: TOKEN_A,
            environment: 'production',
            enabled: true,
        })
        await service.registerClient({
            clientId: 'client-stale',
            connectionId: 'conn-2',
            deviceToken: TOKEN_B,
            environment: 'sandbox',
            enabled: true,
        })

        const longSessionId = 's-'.padEnd(90, 'x')
        await service.notifyAskRequested({
            sessionId: longSessionId,
            sessionTitle: '重构登录模块',
            question: '是否继续执行\n  数据库迁移？',
            requestId: 'ask-req-1',
            toolCallId: 'call-1',
        })

        expect(requests).toHaveLength(2)
        for (const req of requests) {
            expect(req.body.title).toBe('Coding Professional Agent')
            expect(req.body.body).toBe('重构登录模块 正在询问：是否继续执行 数据库迁移？')
            expect(req.body.sound).toBe('default')
            expect(req.body.threadId).toBe(longSessionId)
            expect(Buffer.byteLength(req.body.collapseId, 'utf8')).toBeLessThanOrEqual(64)
            expect(req.body.data.sessionId).toBe(longSessionId)
            expect(req.body.data.sessionTitle).toBe('重构登录模块')
            expect(req.body.data.notificationType).toBe('ask')
        }
        // Stale client removed on 410 during ask push
        expect((await service.listClients()).map((c) => c.clientId)).toEqual(['client-1'])

        // Verify exact body parity with NotificationBadgeService across all ask combinations
        const badgeService = new NotificationBadgeService(() => null)
        const askCases = [
            { sessionId: 's1', sessionTitle: 'Short', question: 'Confirm?' },
            { sessionId: 's2', sessionTitle: undefined, question: 'Q'.repeat(100) },
            { sessionId: 's3', sessionTitle: 'T'.repeat(50), question: undefined },
            { sessionId: 's4', sessionTitle: '  ', question: '   ' },
        ]
        requests.length = 0
        capturedLocalNotifications.length = 0
        for (const c of askCases) {
            badgeService.notifyAskRequested(c)
            await service.notifyAskRequested(c)
        }
        expect(capturedLocalNotifications).toHaveLength(askCases.length)
        expect(requests).toHaveLength(askCases.length)
        for (let i = 0; i < askCases.length; i += 1) {
            expect(requests[i].body.body).toBe(capturedLocalNotifications[i].body)
        }
    })
})
