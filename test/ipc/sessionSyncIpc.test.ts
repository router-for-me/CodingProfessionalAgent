import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import type { NativeEvent, SessionDelegateRunRequest, SessionItem } from '../../src/shared/types.js'

const ipcHandlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp'),
    },
    BrowserWindow: vi.fn(),
    ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
            ipcHandlers.set(channel, handler)
        }),
    },
}))

import {
    createServices,
    registerIpcHandlers,
    attachMainWindowListeners,
    type AppServices,
} from '../../src/main/ipc/registerIpcHandlers.js'
import { MainPluginRuntimeHost } from '../../src/main/plugins/runtime/MainPluginRuntimeHost.js'

function waitForEvent(
    ws: WebSocket,
    predicate: (msg: any) => boolean,
    timeoutMs = 2000,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error(`Timeout waiting for event after ${timeoutMs}ms`))
        }, timeoutMs)

        const onMessage = (data: any) => {
            try {
                const parsed = JSON.parse(data.toString())
                if (predicate(parsed)) {
                    cleanup()
                    resolve(parsed)
                }
            } catch {
                // Ignore parse errors
            }
        }

        const cleanup = () => {
            clearTimeout(timer)
            ws.off('message', onMessage)
        }

        ws.on('message', onMessage)
    })
}

describe('Session Sync IPC & Broadcast', () => {
    let services: AppServices
    let sentEvents: NativeEvent[]
    let mockWindow: any
    let tempDir: string

    beforeEach(async () => {
        ipcHandlers.clear()
        sentEvents = []

        tempDir = path.join(os.tmpdir(), `cpa-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        fs.mkdirSync(tempDir, { recursive: true })

        mockWindow = {
            isDestroyed: () => false,
            webContents: {
                send: vi.fn((channel: string, event: NativeEvent) => {
                    if (channel === 'cpa:native') {
                        sentEvents.push(event)
                    }
                }),
                once: vi.fn(),
                on: vi.fn(),
            },
        }

        const host = new MainPluginRuntimeHost()
        await host.activateAll()

        // Use isolated in-memory SQLite and temp home directory
        services = createServices(() => mockWindow, {
            isDebug: true,
            pluginRuntimeHost: host,
            sessionDatabaseOptions: { dbPath: ':memory:', getHomeDir: () => tempDir },
        })
        registerIpcHandlers(services, () => mockWindow)
    })

    afterEach(() => {
        services.disposeAll()
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true })
        }
    })

    const invokeRpc = (method: string, ...args: unknown[]) =>
        services.handleMethod(method, args, {
            pluginId: 'desktop-main',
            clientId: 'desktop-main',
            senderId: mockWindow?.webContents?.id ?? 1,
            frameUrl: '',
            transport: 'electron',
        })

    it('creates services with sessionRunRegistry and registers RPC methods', async () => {
        expect(services.sessionRunRegistry).toBeDefined()

        // Test registering and fetching active runs via service directly
        services.sessionRunRegistry.registerOrUpdate({
            sessionId: 'sess-direct',
            runId: 'run-direct',
            clientId: 'test-client',
            status: 'running',
        })

        const activeRuns = services.sessionRunRegistry.getActiveRuns()
        expect(activeRuns).toHaveLength(1)
        expect(activeRuns[0]?.sessionId).toBe('sess-direct')
        expect(activeRuns[0]?.status).toBe('running')
    })

    it('handles session:broadcastRunStatus and session:getActiveRuns via IPC', async () => {
        expect(ipcHandlers.has('session:broadcastRunStatus')).toBe(false)
        expect(ipcHandlers.has('cpa:capability:invoke')).toBe(true)

        // Register running status (IPC forces desktop-main clientId)
        await invokeRpc('session:broadcastRunStatus', 'sess-1', 'running', 'run-1', 'client-electron')

        let runs = (await invokeRpc('session:getActiveRuns')) as any[]
        expect(runs).toHaveLength(1)
        expect(runs[0].sessionId).toBe('sess-1')
        expect(runs[0].status).toBe('running')
        expect(runs[0].runId).toBe('run-1')
        expect(runs[0].clientId).toBe('desktop-main')

        // Check broadcast event
        const runStatusEvent = sentEvents.find((e) => e.kind === 'session:run-status')
        expect(runStatusEvent).toBeDefined()
        const payload = JSON.parse(runStatusEvent!.data!)
        expect(payload.sessionId).toBe('sess-1')
        expect(payload.status).toBe('running')
        expect(payload.clientId).toBe('desktop-main')

        // Clear running status by setting to idle
        await invokeRpc('session:broadcastRunStatus', 'sess-1', 'idle', 'run-1', 'client-electron')
        runs = (await invokeRpc('session:getActiveRuns')) as any[]
        expect(runs).toHaveLength(0)
    })

    it.each(['crashed', 'detached', 'disposed'] as const)(
        'skips native sends to a %s renderer while preserving run updates',
        async (state) => {
            mockWindow.webContents.isCrashed = () => state === 'crashed'
            Object.defineProperty(mockWindow.webContents, 'mainFrame', {
                get() {
                    if (state === 'disposed') {
                        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
                    }
                    return { detached: state === 'detached' }
                },
            })
            mockWindow.webContents.send.mockClear()

            await expect(
                invokeRpc('session:broadcastRunStatus', 'sess-unavailable', 'running', 'run-unavailable'),
            ).resolves.toBeUndefined()

            expect(mockWindow.webContents.send).not.toHaveBeenCalled()
            expect(services.sessionRunRegistry.getActiveRuns()).toEqual([
                expect.objectContaining({ sessionId: 'sess-unavailable', status: 'running' }),
            ])
        },
    )

    it('keeps broadcasting when the renderer frame is disposed during webContents.send', async () => {
        mockWindow.webContents.send = vi.fn(() => {
            throw new Error('Render frame was disposed before WebFrameMain could be accessed')
        })

        await expect(
            invokeRpc('session:broadcastRunStatus', 'sess-disposed', 'running', 'run-disposed'),
        ).resolves.toBeUndefined()

        expect(services.sessionRunRegistry.getActiveRuns()).toEqual([
            expect.objectContaining({
                sessionId: 'sess-disposed',
                runId: 'run-disposed',
                status: 'running',
            }),
        ])
    })

    it('attaches main window listeners, cleans up runs, and reloads a crashed renderer', () => {
        let destroyedHandler: (() => void) | undefined
        let goneHandler: ((event: unknown, details: { reason: string }) => void) | undefined
        const mockWin: any = {
            isDestroyed: () => false,
            webContents: {
                isDestroyed: () => false,
                reload: vi.fn(),
                once: vi.fn((event: string, handler: () => void) => {
                    if (event === 'destroyed') destroyedHandler = handler
                }),
                on: vi.fn((event: string, handler: typeof goneHandler) => {
                    if (event === 'render-process-gone') goneHandler = handler
                }),
            },
        }

        attachMainWindowListeners(mockWin, services)
        expect(mockWin.webContents.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
        expect(mockWin.webContents.on).toHaveBeenCalledWith('render-process-gone', expect.any(Function))

        // Register desktop-main run
        services.sessionRunRegistry.registerOrUpdate({
            sessionId: 'sess-desktop',
            runId: 'run-desktop',
            clientId: 'desktop-main',
            status: 'running',
        })
        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(1)

        // Trigger destroyed
        destroyedHandler?.()
        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(0)

        // Register desktop-main run again and test render-process-gone
        services.sessionRunRegistry.registerOrUpdate({
            sessionId: 'sess-desktop-2',
            runId: 'run-desktop-2',
            clientId: 'desktop-main',
            status: 'running',
        })
        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(1)

        // Trigger render-process-gone
        goneHandler?.({}, { reason: 'crashed' })
        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(0)
        expect(mockWin.webContents.reload).toHaveBeenCalledTimes(1)
    })

    it('does not echo session stream events to the originating Electron renderer', async () => {
        await invokeRpc('session:broadcastStreamEvent', 'sess-1', 'run-1', { type: 'token', text: 'Hello' })
        expect(sentEvents.some((event) => event.kind === 'session:stream-event')).toBe(false)

        // Abort run
        await invokeRpc('session:abortRun', 'sess-1', 'user requested abort')
        const abortEvent = sentEvents.find((e) => e.kind === 'session:abort-run')
        expect(abortEvent).toBeDefined()
        expect(abortEvent!.operationId).toBe('abort-sess-1')
        const abortData = JSON.parse(abortEvent!.data!)
        expect(abortData.sessionId).toBe('sess-1')
        expect(abortData.reason).toBe('user requested abort')
    })

    it('broadcasts full session item and events on session CRUD operations (setMeta, set, delete)', async () => {
        const sessionMeta: Partial<SessionItem> & { id: string } = {
            id: 'sess-crud',
            title: 'CRUD Session',
            pinned: true,
        }

        // 1. setMeta - should broadcast full session item with createdAt and updatedAt
        await invokeRpc('session:setMeta', sessionMeta)
        const metaEvent = sentEvents.find((e) => e.kind === 'session:meta-updated')
        expect(metaEvent).toBeDefined()
        expect(metaEvent!.operationId).toBe('meta-sess-crud')
        const fullItem = JSON.parse(metaEvent!.data!)
        expect(fullItem.id).toBe('sess-crud')
        expect(fullItem.title).toBe('CRUD Session')
        expect(fullItem.pinned).toBe(true)
        expect(typeof fullItem.createdAt).toBe('number')
        expect(typeof fullItem.updatedAt).toBe('number')

        // 2. set entries
        await invokeRpc('session:set', 'sess-crud', [{ id: 'entry-1', kind: 'user', content: [{ type: 'text', text: 'Hi' }] }])
        const entriesEvent = sentEvents.find((e) => e.kind === 'session:entries-updated')
        expect(entriesEvent).toBeDefined()
        expect(entriesEvent!.operationId).toBe('entries-sess-crud')
        expect(JSON.parse(entriesEvent!.data!)).toEqual({ sessionId: 'sess-crud' })

        // 3. delete
        await invokeRpc('session:delete', 'sess-crud')
        const deleteEvent = sentEvents.find((e) => e.kind === 'session:deleted')
        expect(deleteEvent).toBeDefined()
        expect(deleteEvent!.operationId).toBe('delete-sess-crud')
        expect(JSON.parse(deleteEvent!.data!)).toEqual({ sessionId: 'sess-crud' })
    })

    it('broadcasts project updates when projects are persisted', async () => {
        const setSpy = vi.spyOn(services.kvStoreService, 'set').mockResolvedValue(undefined)
        const projects = [
            {
                id: 'project-sync-1',
                name: 'Synced Project',
                path: '/workspace/synced-project',
                pinned: false,
                createdAt: 100,
                updatedAt: 100,
            },
        ]

        await invokeRpc('kvstore:set', 'projects', projects)

        expect(setSpy).toHaveBeenCalledWith('projects', projects)
        const projectsEvent = sentEvents.find((event) => event.kind === 'projects:updated')
        expect(projectsEvent).toBeDefined()
        expect(JSON.parse(projectsEvent!.data!)).toEqual(projects)
    })

    it('handles RPC methods via WebServer /api/rpc endpoint', async () => {
        const status = await services.webServerService.start({ host: '127.0.0.1', port: 0 })
        const port = status.port

        // 1. SessionBroadcastRunStatus via HTTP RPC
        const rpcRes1 = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_1',
                method: 'SessionBroadcastRunStatus',
                args: ['sess-web', 'thinking', 'run-web-1', 'client-web'],
            }),
        })
        expect(rpcRes1.status).toBe(200)

        // 2. SessionGetActiveRuns via HTTP RPC
        const rpcRes2 = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_2',
                method: 'SessionGetActiveRuns',
                args: [],
            }),
        })
        expect(rpcRes2.status).toBe(200)
        const data2 = await rpcRes2.json()
        expect(data2.result).toHaveLength(1)
        expect(data2.result[0].sessionId).toBe('sess-web')
        expect(data2.result[0].status).toBe('thinking')

        // 3. SessionBroadcastStreamEvent via HTTP RPC
        const rpcRes3 = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_3',
                method: 'SessionBroadcastStreamEvent',
                args: ['sess-web', 'run-web-1', { type: 'chunk', text: 'abc' }],
            }),
        })
        expect(rpcRes3.status).toBe(200)

        // 4. SessionAbortRun via HTTP RPC
        const rpcRes4 = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_4',
                method: 'SessionAbortRun',
                args: ['sess-web', 'stopped by user'],
            }),
        })
        expect(rpcRes4.status).toBe(200)

        // 5. SessionSetMeta, SessionSet, SessionDelete via HTTP RPC
        await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_5',
                method: 'SessionSetMeta',
                args: [{ id: 'sess-web-meta', title: 'Web Meta' }],
            }),
        })

        await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_6',
                method: 'SessionSet',
                args: ['sess-web-meta', { messages: [] }],
            }),
        })

        await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_7',
                method: 'SessionDelete',
                args: ['sess-web-meta'],
            }),
        })

        const kinds = sentEvents.map((e) => e.kind)
        expect(kinds).toContain('session:run-status')
        expect(kinds).toContain('session:stream-event')
        expect(kinds).toContain('session:abort-run')
        expect(kinds).toContain('session:meta-updated')
        expect(kinds).toContain('session:entries-updated')
        expect(kinds).toContain('session:deleted')

        await services.webServerService.stop()
    })

    it('broadcasts events to WS Client B when Client A mutates or registers runs and cleans up on disconnect', async () => {
        const status = await services.webServerService.start({ host: '127.0.0.1', port: 0 })
        const port = status.port

        const wsA = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
        const wsB = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)

        const [helloA, helloB] = await Promise.all([
            waitForEvent(wsA, (m) => m.type === 'hello'),
            waitForEvent(wsB, (m) => m.type === 'hello'),
        ])

        expect(helloA).toBeDefined()
        expect(helloB).toBeDefined()
        expect(helloA.clientId).toMatch(/^client_ws_\d+_\d+$/)
        expect(helloB.clientId).toMatch(/^client_ws_\d+_\d+$/)
        expect(helloA.clientId).not.toBe(helloB.clientId)

        const clientAId = helloA.clientId

        // 1. Client A sends RPC broadcastRunStatus (should auto-bind Client A's clientId)
        const runStatusPromise = waitForEvent(
            wsB,
            (m) => m.type === 'event' && m.event?.kind === 'session:run-status',
        )

        wsA.send(
            JSON.stringify({
                type: 'rpc',
                id: 'rpc_run_1',
                method: 'SessionBroadcastRunStatus',
                args: ['sess-sync-1', 'running', 'run-sync-1'],
            }),
        )

        const runStatusMsg = await runStatusPromise

        // Check Client A's run in registry
        const activeRuns = services.sessionRunRegistry.getActiveRuns()
        expect(activeRuns).toHaveLength(1)
        expect(activeRuns[0].sessionId).toBe('sess-sync-1')
        expect(activeRuns[0].clientId).toBe(clientAId)

        // Check Client B received the event
        const runStatusPayload = JSON.parse(runStatusMsg.event.data)
        expect(runStatusPayload.sessionId).toBe('sess-sync-1')
        expect(runStatusPayload.status).toBe('running')
        expect(runStatusPayload.clientId).toBe(clientAId)

        // Stream snapshots are delivered to peers but not echoed to their source client.
        const streamForB = waitForEvent(
            wsB,
            (m) => m.type === 'event' && m.event?.kind === 'session:stream-event',
        )
        const streamEchoForA = waitForEvent(
            wsA,
            (m) => m.type === 'event' && m.event?.kind === 'session:stream-event',
            100,
        ).then(
            () => true,
            () => false,
        )
        wsA.send(
            JSON.stringify({
                type: 'rpc',
                id: 'rpc_stream_1',
                method: 'SessionBroadcastStreamEvent',
                args: ['sess-sync-1', 'run-sync-1', { type: 'token', text: 'Hello' }],
            }),
        )

        const streamMsg = await streamForB
        expect(streamMsg.event.sourceClientId).toBe(clientAId)
        expect(JSON.parse(streamMsg.event.data)).toEqual({
            sessionId: 'sess-sync-1',
            runId: 'run-sync-1',
            event: { type: 'token', text: 'Hello' },
        })
        expect(await streamEchoForA).toBe(false)

        // 2. Client A calls SessionSetMeta
        const metaPromise = waitForEvent(
            wsB,
            (m) => m.type === 'event' && m.event?.kind === 'session:meta-updated',
        )

        wsA.send(
            JSON.stringify({
                type: 'rpc',
                id: 'rpc_meta_1',
                method: 'SessionSetMeta',
                args: [{ id: 'sess-sync-1', title: 'Sync Title', pinned: true }],
            }),
        )

        const metaMsg = await metaPromise
        const metaPayload = JSON.parse(metaMsg.event.data)
        expect(metaPayload.id).toBe('sess-sync-1')
        expect(metaPayload.title).toBe('Sync Title')
        expect(metaPayload.pinned).toBe(true)

        // 3. Client A calls SessionSet (entries)
        const entriesPromise = waitForEvent(
            wsB,
            (m) => m.type === 'event' && m.event?.kind === 'session:entries-updated',
        )

        wsA.send(
            JSON.stringify({
                type: 'rpc',
                id: 'rpc_entries_1',
                method: 'SessionSet',
                args: ['sess-sync-1', { messages: [{ role: 'user', content: 'Hi' }] }],
            }),
        )

        const entriesMsg = await entriesPromise
        expect(entriesMsg).toBeDefined()

        // 4. Client A disconnects -> active run is automatically cleaned up, and idle event broadcast to Client B
        const idlePromise = waitForEvent(
            wsB,
            (m) =>
                m.type === 'event' &&
                m.event?.kind === 'session:run-status' &&
                JSON.parse(m.event.data).status === 'idle',
        )

        wsA.close()
        const idleMsg = await idlePromise

        // Registry should now have 0 active runs
        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(0)

        // Client B should have received the idle cleanup event
        const idlePayload = JSON.parse(idleMsg.event.data)
        expect(idlePayload.sessionId).toBe('sess-sync-1')
        expect(idlePayload.status).toBe('idle')
        expect(idlePayload.clientId).toBe(clientAId)

        wsB.close()
        await services.webServerService.stop()
    })

    it('enforces connection-level clientId when Client A sends spoofed clientId and cleans up on disconnect', async () => {
        const status = await services.webServerService.start({ host: '127.0.0.1', port: 0 })
        const port = status.port

        const wsA = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
        const wsB = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)

        const [helloA, helloB] = await Promise.all([
            waitForEvent(wsA, (m) => m.type === 'hello'),
            waitForEvent(wsB, (m) => m.type === 'hello'),
        ])

        const clientAId = helloA.clientId
        expect(clientAId).toMatch(/^client_ws_\d+_\d+$/)

        // Client A explicitly sends a fake/custom clientId
        const runStatusPromise = waitForEvent(
            wsB,
            (m) => m.type === 'event' && m.event?.kind === 'session:run-status',
        )

        wsA.send(
            JSON.stringify({
                type: 'rpc',
                id: 'rpc_spoof_1',
                method: 'SessionBroadcastRunStatus',
                args: ['sess-spoof-1', 'running', 'run-spoof-1', 'fake-custom-id'],
            }),
        )

        const runStatusMsg = await runStatusPromise
        const runStatusPayload = JSON.parse(runStatusMsg.event.data)
        expect(runStatusPayload.sessionId).toBe('sess-spoof-1')
        expect(runStatusPayload.status).toBe('running')
        // Must match connection's real clientId, NOT the spoofed one
        expect(runStatusPayload.clientId).toBe(clientAId)
        expect(runStatusPayload.clientId).not.toBe('fake-custom-id')

        const activeRuns = services.sessionRunRegistry.getActiveRuns()
        expect(activeRuns).toHaveLength(1)
        expect(activeRuns[0].sessionId).toBe('sess-spoof-1')
        expect(activeRuns[0].clientId).toBe(clientAId)

        // Client A disconnects -> active run automatically cleaned up and Client B receives idle
        const idlePromise = waitForEvent(
            wsB,
            (m) =>
                m.type === 'event' &&
                m.event?.kind === 'session:run-status' &&
                JSON.parse(m.event.data).status === 'idle',
        )

        wsA.close()
        const idleMsg = await idlePromise
        const idlePayload = JSON.parse(idleMsg.event.data)
        expect(idlePayload.sessionId).toBe('sess-spoof-1')
        expect(idlePayload.status).toBe('idle')
        expect(idlePayload.clientId).toBe(clientAId)

        expect(services.sessionRunRegistry.getActiveRuns()).toHaveLength(0)

        wsB.close()
        await services.webServerService.stop()
    })

    it('handles SessionDelegateRun via IPC and WebServer RPC and emits session:delegate-run event', async () => {
        const req: SessionDelegateRunRequest = {
            sessionId: 'sess-delegate-1',
            text: 'Please review and fix this issue',
            images: [{ data: 'base64img', mimeType: 'image/png', name: 'screenshot.png' }],
            projectId: 'proj-1',
            branch: 'feature-branch',
            editMessageId: 'msg-123',
        }

        // 1. IPC invocation
        const result = await invokeRpc('session:delegateRun', req)
        expect(result).toBe('sess-delegate-1')

        const delegateEvent = sentEvents.find((e) => e.kind === 'session:delegate-run')
        expect(delegateEvent).toBeDefined()
        expect(delegateEvent!.operationId).toMatch(/^delegate-\d+$/)
        const eventData = JSON.parse(delegateEvent!.data!)
        expect(eventData).toEqual(req)

        // 2. Test with empty/null sessionId returns empty string
        const reqWithoutSession: SessionDelegateRunRequest = {
            sessionId: null,
            text: 'Start fresh session',
        }
        const resultWithoutSession = await invokeRpc('session:delegateRun', reqWithoutSession)
        expect(resultWithoutSession).toBe('')

        // 3. WebServer HTTP RPC invocation
        const status = await services.webServerService.start({ host: '127.0.0.1', port: 0 })
        const port = status.port

        const httpRes = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_delegate_1',
                method: 'SessionDelegateRun',
                args: [req],
            }),
        })
        expect(httpRes.status).toBe(200)
        const httpData = await httpRes.json()
        expect(httpData.result).toBe('sess-delegate-1')

        await services.webServerService.stop()
    })

    it('handles resume prompt state and action sync via IPC and WebServer broadcast', async () => {
        // 1. Initial state is closed
        const initialState = await invokeRpc('session:getResumePromptState')
        expect(initialState).toEqual({
            isOpen: false,
            totalCount: 0,
            countdown: 0,
            unfinishedSessionIds: [],
            unfinishedSubAgentIds: [],
        })

        // 2. Start WebServer and connect WebSocket client
        const status = await services.webServerService.start({ host: '127.0.0.1', port: 0 })
        const wsUrl = `ws://127.0.0.1:${status.port}/api/ws`
        const clientWs = new WebSocket(wsUrl)
        await new Promise<void>((resolve) => clientWs.on('open', () => resolve()))

        // 3. Desktop broadcasts prompt state
        const statePromise = waitForEvent(clientWs, (msg) => msg.type === 'event' && msg.event?.kind === 'session:resume-prompt-state')
        await invokeRpc('session:broadcastResumePromptState', {
            isOpen: true,
            totalCount: 2,
            countdown: 30,
            unfinishedSessionIds: ['sess-1'],
            unfinishedSubAgentIds: ['sub-1'],
        })

        const receivedStateMsg = await statePromise
        expect(receivedStateMsg.event.kind).toBe('session:resume-prompt-state')
        const parsedState = JSON.parse(receivedStateMsg.event.data)
        expect(parsedState.isOpen).toBe(true)
        expect(parsedState.countdown).toBe(30)
        expect(parsedState.totalCount).toBe(2)

        // Verify getResumePromptState returns current state
        const currentState = await invokeRpc('session:getResumePromptState')
        expect(currentState).toEqual(
            expect.objectContaining({
                isOpen: true,
                countdown: 30,
            }),
        )

        // 4. Web client triggers resumePromptAction via HTTP RPC
        const actionPromise = waitForEvent(clientWs, (msg) => msg.type === 'event' && msg.event?.kind === 'session:resume-prompt-action')
        const httpRes = await fetch(`http://127.0.0.1:${status.port}/api/rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'rpc_action_1',
                method: 'SessionResumePromptAction',
                args: ['continue'],
            }),
        })
        expect(httpRes.status).toBe(200)

        const receivedActionMsg = await actionPromise
        expect(receivedActionMsg.event.kind).toBe('session:resume-prompt-action')
        expect(JSON.parse(receivedActionMsg.event.data)).toEqual({ action: 'continue' })

        clientWs.close()
        await services.webServerService.stop()
    })

    it('handles dialog:saveFile and profiling IPC channels', async () => {
        // 1. Profiling status
        const initialStatus = await invokeRpc('profiling:getStatus')
        expect(initialStatus).toEqual({
            running: false,
            enabled: true,
            target: 'all',
            startedAt: undefined,
        })

        // 2. Profiling start / stop / report
        await invokeRpc('profiling:start', { durationMs: 1000, target: 'main' })
        const runningStatus: any = await invokeRpc('profiling:getStatus')
        expect(runningStatus.running).toBe(true)

        const stopRes: any = await invokeRpc('profiling:stop')
        expect(stopRes.ok).toBe(true)
        expect(stopRes.report).toBeDefined()

        const stoppedStatus: any = await invokeRpc('profiling:getStatus')
        expect(stoppedStatus.running).toBe(false)

        const report: any = await invokeRpc('profiling:getReport')
        expect(report).toBeDefined()
        expect(report.summary).toBeDefined()
    })
})
