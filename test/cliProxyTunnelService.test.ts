import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { WebServerService } from '../src/main/services/webServerService.js'
import { CliProxyTunnelServerService } from '../src/main/services/cliProxyTunnelService.js'
import {
    CPA_TUNNEL_MUX_PAYLOAD_TYPE,
    CPA_TUNNEL_SERVER_TYPE,
    decodeMuxFrame,
    decodeTunnelFrame,
    encodeMuxFrame,
    encodeTunnelFrame,
    type DecodedMuxFrame,
    type TunnelMuxMeta,
} from '../src/main/services/tunnel/tunnelProtocol.js'
import type { CliProxyTunnelStatus, NativeEvent } from '../src/shared/types.js'

interface MockHubPeer {
    role: 'client' | 'server'
    uuid: string
    name: string
    type?: string
    ws: WebSocket
}

function isValidHubLabel(raw: string): boolean {
    if (!raw || /[\x00-\x1f\x7f]/.test(raw)) {
        return false
    }
    const byteLen = Buffer.byteLength(raw, 'utf8')
    return byteLen >= 1 && byteLen <= 256
}

class MockCliProxyTunnelHub {
    private server: http.Server | null = null
    private wss: WebSocketServer | null = null
    private allowedKeys = new Set<string>(['sk-valid-key'])
    private peers = new Map<string, MockHubPeer>()
    public port = 0
    public handshakeCount = 0
    public nextOverrideStatus: { status: number; body: Record<string, unknown> } | null = null

    async start(): Promise<string> {
        const server = http.createServer((_req, res) => {
            res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
        })
        const wss = new WebSocketServer({ noServer: true })

        server.on('upgrade', (req, socket, head) => {
            this.handshakeCount += 1
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            if (url.pathname !== '/v1/tunnel') {
                socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
                return
            }

            if (this.nextOverrideStatus) {
                const { status, body } = this.nextOverrideStatus
                this.nextOverrideStatus = null
                const payload = JSON.stringify(body)
                socket.end(
                    `HTTP/1.1 ${status} Error\r\n` +
                        'Connection: close\r\n' +
                        'Content-Type: application/json\r\n' +
                        `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
                        payload,
                )
                return
            }

            const authHeader = String(req.headers.authorization || '')
            const bearer = authHeader.startsWith('Bearer ')
                ? authHeader.slice(7).trim()
                : authHeader.trim()
            const key = bearer || (url.searchParams.get('key') ?? '').trim()
            if (!key || !this.allowedKeys.has(key)) {
                const payload = JSON.stringify({ error: 'invalid or missing api key' })
                socket.end(
                    'HTTP/1.1 401 Unauthorized\r\n' +
                        'Connection: close\r\n' +
                        'Content-Type: application/json\r\n' +
                        `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
                        payload,
                )
                return
            }

            const headerValue = (headerName: string): string => {
                const raw = req.headers[headerName]
                return (Array.isArray(raw) ? raw[0] || '' : raw || '').trim()
            }
            const roleRaw = (url.searchParams.get('role') || '').trim() || headerValue('x-tunnel-role')
            const role = roleRaw.toLowerCase()
            const uuid = (url.searchParams.get('uuid') || '').trim() || headerValue('x-tunnel-uuid')
            const nameRaw = url.searchParams.get('name') ?? ''
            const name = nameRaw.trim() || headerValue('x-tunnel-name')
            if ((role !== 'client' && role !== 'server') || !uuid || !isValidHubLabel(name)) {
                const payload = JSON.stringify({ error: 'invalid role, uuid, or name' })
                socket.end(
                    'HTTP/1.1 400 Bad Request\r\n' +
                        'Connection: close\r\n' +
                        'Content-Type: application/json\r\n' +
                        `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
                        payload,
                )
                return
            }

            let serverType: string | undefined
            if (role === 'server') {
                const queryType = (url.searchParams.get('type') ?? '').trim()
                const resolvedType = queryType || headerValue('x-tunnel-type')
                if (!isValidHubLabel(resolvedType)) {
                    const payload = JSON.stringify({ error: 'invalid or missing type' })
                    socket.end(
                        'HTTP/1.1 400 Bad Request\r\n' +
                            'Connection: close\r\n' +
                            'Content-Type: application/json\r\n' +
                            `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
                            payload,
                    )
                    return
                }
                serverType = resolvedType
            }

            if (this.peers.has(uuid)) {
                const payload = JSON.stringify({ error: 'device uuid already connected' })
                socket.end(
                    'HTTP/1.1 409 Conflict\r\n' +
                        'Connection: close\r\n' +
                        'Content-Type: application/json\r\n' +
                        `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n` +
                        payload,
                )
                return
            }

            wss.handleUpgrade(req, socket, head, (ws) => {
                const peer: MockHubPeer = {
                    role: role as 'client' | 'server',
                    uuid,
                    name,
                    ...(serverType ? { type: serverType } : {}),
                    ws,
                }
                this.peers.set(uuid, peer)

                if (peer.role === 'client') {
                    const servers = Array.from(this.peers.values())
                        .filter((p) => p.role === 'server')
                        .map((p) => ({ uuid: p.uuid, name: p.name, type: p.type }))
                    ws.send(JSON.stringify({ type: 'server_list', servers }))
                } else {
                    for (const p of this.peers.values()) {
                        if (p.role === 'client' && p.ws.readyState === WebSocket.OPEN) {
                            p.ws.send(
                                JSON.stringify({
                                    type: 'server_online',
                                    server: { uuid: peer.uuid, name: peer.name, type: peer.type },
                                }),
                            )
                        }
                    }
                }

                ws.on('message', (data, isBinary) => {
                    if (!isBinary) {
                        return
                    }
                    const buf = Buffer.isBuffer(data)
                        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                        : new Uint8Array(data as ArrayBuffer)
                    const pkt = decodeTunnelFrame(buf)
                    if (pkt.srcUuid !== peer.uuid) {
                        ws.send(
                            JSON.stringify({
                                type: 'error',
                                code: 'source_uuid_mismatch',
                                message: 'source uuid mismatch',
                            }),
                        )
                        return
                    }
                    const target = this.peers.get(pkt.dstUuid)
                    if (!target || target.ws.readyState !== WebSocket.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: 'error',
                                code: 'target_not_found',
                                target_uuid: pkt.dstUuid,
                                message: 'target peer is not connected',
                            }),
                        )
                        return
                    }
                    target.ws.send(buf, { binary: true })
                })

                const cleanup = () => {
                    if (this.peers.get(uuid) === peer) {
                        this.peers.delete(uuid)
                        if (peer.role === 'server') {
                            for (const p of this.peers.values()) {
                                if (p.role === 'client' && p.ws.readyState === WebSocket.OPEN) {
                                    p.ws.send(
                                        JSON.stringify({
                                            type: 'server_offline',
                                            server: {
                                                uuid: peer.uuid,
                                                name: peer.name,
                                                type: peer.type,
                                            },
                                        }),
                                    )
                                }
                            }
                        }
                    }
                }
                ws.on('close', cleanup)
                ws.on('error', cleanup)
            })
        })

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve())
        })
        const addr = server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        this.server = server
        this.wss = wss
        return `http://127.0.0.1:${this.port}`
    }

    getPeer(uuid: string): MockHubPeer | undefined {
        return this.peers.get(uuid)
    }

    sendControlToPeer(uuid: string, frame: Record<string, unknown>): void {
        const peer = this.peers.get(uuid)
        if (peer && peer.ws.readyState === WebSocket.OPEN) {
            peer.ws.send(JSON.stringify(frame))
        }
    }

    closePeer(uuid: string, code: number, reason: string): void {
        const peer = this.peers.get(uuid)
        if (peer) {
            this.peers.delete(uuid)
            peer.ws.close(code, reason)
        }
    }

    async stop(): Promise<void> {
        for (const peer of this.peers.values()) {
            try {
                peer.ws.terminate()
            } catch {}
        }
        this.peers.clear()
        this.wss?.close()
        if (this.server) {
            await new Promise<void>((resolve) => this.server!.close(() => resolve()))
            this.server = null
        }
    }
}

async function connectTestTunnelClient(
    baseUrl: string,
    apiKey: string,
    clientUuid: string,
): Promise<{
    ws: WebSocket
    controlFrames: Array<Record<string, unknown>>
    nextControl: (
        predicate?: (frame: Record<string, unknown>) => boolean,
        timeoutMs?: number,
    ) => Promise<Record<string, unknown>>
    sendMux: (serverUuid: string, meta: TunnelMuxMeta, body?: Uint8Array) => void
    nextMux: (predicate?: (frame: DecodedMuxFrame) => boolean, timeoutMs?: number) => Promise<DecodedMuxFrame>
    close: () => void
}> {
    const wsUrl = baseUrl.replace(/^http/, 'ws') + `/v1/tunnel?role=client&uuid=${clientUuid}&name=iOS-Test`
    const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
    })

    const controlFrames: Array<Record<string, unknown>> = []
    const controlQueue: Array<Record<string, unknown>> = []
    const controlWaiters: Array<{
        predicate: (frame: Record<string, unknown>) => boolean
        resolve: (frame: Record<string, unknown>) => void
        reject: (err: Error) => void
        timer: NodeJS.Timeout
    }> = []

    const muxQueue: DecodedMuxFrame[] = []
    const waiters: Array<{
        predicate: (frame: DecodedMuxFrame) => boolean
        resolve: (frame: DecodedMuxFrame) => void
        reject: (err: Error) => void
        timer: NodeJS.Timeout
    }> = []

    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            const text = Buffer.isBuffer(data)
                ? data.toString('utf8')
                : Buffer.from(data as ArrayBuffer).toString('utf8')
            const parsed = JSON.parse(text) as Record<string, unknown>
            controlFrames.push(parsed)
            const cIdx = controlWaiters.findIndex((w) => w.predicate(parsed))
            if (cIdx >= 0) {
                const [waiter] = controlWaiters.splice(cIdx, 1)
                clearTimeout(waiter!.timer)
                waiter!.resolve(parsed)
            } else {
                controlQueue.push(parsed)
            }
            return
        }
        const bytes = Buffer.isBuffer(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data as ArrayBuffer)
        const outer = decodeTunnelFrame(bytes)
        const inner = decodeMuxFrame(outer.payload)
        const idx = waiters.findIndex((w) => w.predicate(inner))
        if (idx >= 0) {
            const [waiter] = waiters.splice(idx, 1)
            clearTimeout(waiter!.timer)
            waiter!.resolve(inner)
        } else {
            muxQueue.push(inner)
        }
    })

    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
    })

    return {
        ws,
        controlFrames,
        nextControl(predicate = () => true, timeoutMs = 4000) {
            const queuedIdx = controlQueue.findIndex(predicate)
            if (queuedIdx >= 0) {
                const [found] = controlQueue.splice(queuedIdx, 1)
                return Promise.resolve(found!)
            }
            return new Promise<Record<string, unknown>>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const i = controlWaiters.findIndex((w) => w.resolve === resolve)
                    if (i >= 0) controlWaiters.splice(i, 1)
                    reject(new Error('Timed out waiting for tunnel control frame'))
                }, timeoutMs)
                controlWaiters.push({ predicate, resolve, reject, timer })
            })
        },
        sendMux(serverUuid, meta, body) {
            const mux = encodeMuxFrame(meta, body)
            const frame = encodeTunnelFrame(CPA_TUNNEL_MUX_PAYLOAD_TYPE, clientUuid, serverUuid, mux)
            ws.send(frame, { binary: true })
        },
        nextMux(predicate = () => true, timeoutMs = 4000) {
            const queuedIdx = muxQueue.findIndex(predicate)
            if (queuedIdx >= 0) {
                const [found] = muxQueue.splice(queuedIdx, 1)
                return Promise.resolve(found!)
            }
            return new Promise<DecodedMuxFrame>((resolve, reject) => {
                const timer = setTimeout(() => {
                    const i = waiters.findIndex((w) => w.resolve === resolve)
                    if (i >= 0) waiters.splice(i, 1)
                    reject(new Error('Timed out waiting for tunnel mux frame'))
                }, timeoutMs)
                waiters.push({ predicate, resolve, reject, timer })
            })
        },
        close() {
            ws.close()
        },
    }
}

function waitForStatus(
    events: CliProxyTunnelStatus[],
    service: CliProxyTunnelServerService,
    predicate: (s: CliProxyTunnelStatus) => boolean,
    timeoutMs = 4000,
): Promise<CliProxyTunnelStatus> {
    const current = service.getStatus()
    if (predicate(current)) return Promise.resolve(current)
    const found = events.find(predicate)
    if (found) return Promise.resolve(found)

    return new Promise((resolve, reject) => {
        const start = Date.now()
        const interval = setInterval(() => {
            const nowStatus = service.getStatus()
            if (predicate(nowStatus)) {
                clearInterval(interval)
                resolve(nowStatus)
                return
            }
            if (Date.now() - start > timeoutMs) {
                clearInterval(interval)
                reject(new Error(`Timed out waiting for tunnel status (current: ${JSON.stringify(nowStatus)})`))
            }
        }, 20)
    })
}

describe('CliProxyTunnelServerService', () => {
    let hub: MockCliProxyTunnelHub
    let hubBaseUrl: string
    let tmpDir: string
    let webServer: WebServerService
    let tunnelService: CliProxyTunnelServerService
    let emittedStatuses: CliProxyTunnelStatus[]
    let disconnectedClientIds: string[]
    const binaryAsset = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20])

    beforeEach(async () => {
        emittedStatuses = []
        disconnectedClientIds = []
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpa-tunnel-test-'))
        await fs.writeFile(path.join(tmpDir, 'index.html'), '<html>Tunnel CPA</html>')
        await fs.writeFile(path.join(tmpDir, 'logo.png'), binaryAsset)

        webServer = new WebServerService({ distDir: tmpDir })
        webServer.setRpcDispatcher(async (method, args) => {
            if (method === 'session:list') {
                return ['s-1', 's-2']
            }
            if (method === 'echo') {
                return { echoed: args[0] }
            }
            throw new Error(`Unknown method: ${method}`)
        })
        webServer.setOnClientDisconnect((clientId) => {
            disconnectedClientIds.push(clientId)
        })

        hub = new MockCliProxyTunnelHub()
        hubBaseUrl = await hub.start()

        tunnelService = new CliProxyTunnelServerService({
            webServerService: webServer,
            getHostname: () => 'MacBook-Pro-Server',
            ensureServerUuid: () => 'srv-uuid-001',
            randomJitter: () => 1,
            initialBackoffMs: 60,
            conflictBackoffMs: 80,
            maxBackoffMs: 250,
            emitEvent: (evt: NativeEvent) => {
                if (evt.kind === 'tunnel:status-changed' && evt.data) {
                    emittedStatuses.push(JSON.parse(evt.data))
                }
            },
        })
    })

    afterEach(async () => {
        await tunnelService.dispose()
        webServer.dispose()
        await hub.stop()
        await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('reports missing config error without dialing when enabled with empty baseUrl or apiKey, and redacts apiKey from all errors', async () => {
        const s1 = await tunnelService.syncConfig({
            enabled: true,
            baseUrl: '',
            apiKey: 'sk-top-secret-token',
        })
        expect(s1.phase).toBe('error')
        expect(s1.errorCode).toBe('missing_config')
        expect(hub.handshakeCount).toBe(0)

        const s2 = await tunnelService.syncConfig({
            enabled: true,
            baseUrl: 'ftp://bad-scheme.example.com/sk-top-secret-token',
            apiKey: 'sk-top-secret-token',
        })
        expect(s2.phase).toBe('error')
        expect(s2.error).not.toContain('sk-top-secret-token')
        expect(JSON.stringify(emittedStatuses)).not.toContain('sk-top-secret-token')
    })

    it('connects as role=server with type=CodingProfessionalAgent and proxies HTTP GET/POST and binary static assets to internal loopback while public WebServer remains stopped', async () => {
        const earlyClient = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-early-01')
        const initialList = await earlyClient.nextControl((f) => f.type === 'server_list')
        expect(initialList.servers).toEqual([])

        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        const connected = await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')
        expect(connected.serverUuid).toBe('srv-uuid-001')
        expect(connected.serverName).toBe('MacBook-Pro-Server')
        expect(new URL(connected.tunnelUrl).searchParams.get('type')).toBe(CPA_TUNNEL_SERVER_TYPE)
        expect(hub.getPeer('srv-uuid-001')?.type).toBe('CodingProfessionalAgent')
        expect(webServer.getStatus().running).toBe(false)

        const onlineEvt = await earlyClient.nextControl((f) => f.type === 'server_online')
        expect(onlineEvt).toEqual({
            type: 'server_online',
            server: {
                uuid: 'srv-uuid-001',
                name: 'MacBook-Pro-Server',
                type: 'CodingProfessionalAgent',
            },
        })
        earlyClient.close()

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-uuid-01')
        const serverListEvt = await client.nextControl((f) => f.type === 'server_list')
        expect(serverListEvt).toEqual({
            type: 'server_list',
            servers: [
                {
                    uuid: 'srv-uuid-001',
                    name: 'MacBook-Pro-Server',
                    type: 'CodingProfessionalAgent',
                },
            ],
        })

        // 1. HTTP GET /api/health
        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'h1',
            method: 'GET',
            path: '/api/health',
        })
        const healthRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'h1',
        )
        expect(healthRes.meta.type === 'http_response' && healthRes.meta.status).toBe(200)
        expect(JSON.parse(new TextDecoder().decode(healthRes.body))).toEqual({ ok: true })

        // 2. HTTP POST /api/rpc
        const rpcReqBody = new TextEncoder().encode(
            JSON.stringify({ id: 'r1', method: 'session:list', args: [] }),
        )
        client.sendMux(
            'srv-uuid-001',
            {
                type: 'http_request',
                id: 'h2',
                method: 'POST',
                path: '/api/rpc',
                headers: { 'content-type': 'application/json' },
            },
            rpcReqBody,
        )
        const rpcRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'h2',
        )
        expect(rpcRes.meta.type === 'http_response' && rpcRes.meta.status).toBe(200)
        expect(JSON.parse(new TextDecoder().decode(rpcRes.body))).toEqual({
            id: 'r1',
            result: ['s-1', 's-2'],
        })

        // 3. Binary PNG static asset zero-corruption transfer
        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'h3',
            method: 'GET',
            path: '/logo.png',
        })
        const pngRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'h3',
        )
        expect(pngRes.meta.type === 'http_response' && pngRes.meta.status).toBe(200)
        expect(Array.from(pngRes.body)).toEqual(Array.from(binaryAsset))

        client.close()
    })

    it('guarantees ws_open_result(ok: true) arrives strictly before initial { type: "hello" } frame and bridges bidirectional RPC + broadcastEvent', async () => {
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-ws-order')
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'conn-1',
            path: '/api/ws',
        })

        const firstFrame = await client.nextMux()
        expect(firstFrame.meta).toMatchObject({
            type: 'ws_open_result',
            connId: 'conn-1',
            ok: true,
        })

        const secondFrame = await client.nextMux()
        expect(secondFrame.meta).toEqual({
            type: 'ws_data',
            connId: 'conn-1',
            opcode: 'text',
        })
        const helloPayload = JSON.parse(new TextDecoder().decode(secondFrame.body))
        expect(helloPayload.type).toBe('hello')
        expect(typeof helloPayload.clientId).toBe('string')

        // Bidirectional RPC over WS
        client.sendMux(
            'srv-uuid-001',
            { type: 'ws_data', connId: 'conn-1', opcode: 'text' },
            new TextEncoder().encode(
                JSON.stringify({ type: 'rpc', id: 'ws-rpc-1', method: 'echo', args: [{ hi: 1 }] }),
            ),
        )
        const rpcReply = await client.nextMux((f) => f.meta.type === 'ws_data')
        expect(JSON.parse(new TextDecoder().decode(rpcReply.body))).toEqual({
            type: 'rpc_result',
            id: 'ws-rpc-1',
            result: { echoed: { hi: 1 } },
        })

        // Broadcast event reaches tunnel WS client
        webServer.broadcastEvent({
            operationId: 'stream-1',
            sequence: 7,
            kind: 'session:stream-event',
            data: '{"chunk":"hello"}',
        })
        const pushedEvt = await client.nextMux((f) => f.meta.type === 'ws_data')
        const parsedEvt = JSON.parse(new TextDecoder().decode(pushedEvt.body))
        expect(parsedEvt.type).toBe('event')
        expect(parsedEvt.event.operationId).toBe('stream-1')

        client.close()
    })

    it('enforces Web access password over tunnel (401 before login, Set-Cookie login flow, and 4401 ws_close on live password change)', async () => {
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
            webPassword: 'tunnel-password-1',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-auth')

        // 1. Unauthenticated HTTP /api/status -> 401
        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'unauth-http',
            method: 'GET',
            path: '/api/status',
        })
        const unauthHttp = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'unauth-http',
        )
        expect(unauthHttp.meta.type === 'http_response' && unauthHttp.meta.status).toBe(401)

        // 2. Unauthenticated ws_open -> ok: false, status: 401
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'unauth-ws',
            path: '/api/ws',
        })
        const unauthWs = await client.nextMux(
            (f) => f.meta.type === 'ws_open_result' && f.meta.connId === 'unauth-ws',
        )
        expect(unauthWs.meta).toMatchObject({
            type: 'ws_open_result',
            connId: 'unauth-ws',
            ok: false,
            status: 401,
        })

        // 3. Login via POST /api/auth/login (even with non-matching Origin header from client, stripped & normalized)
        client.sendMux(
            'srv-uuid-001',
            {
                type: 'http_request',
                id: 'login-req',
                method: 'POST',
                path: '/api/auth/login',
                headers: {
                    'content-type': 'application/json',
                    Origin: 'capacitor://localhost',
                },
            },
            new TextEncoder().encode(JSON.stringify({ password: 'tunnel-password-1' })),
        )
        const loginRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'login-req',
        )
        expect(loginRes.meta.type === 'http_response' && loginRes.meta.status).toBe(200)
        const setCookieHeader =
            loginRes.meta.type === 'http_response' ? loginRes.meta.headers?.['set-cookie'] : undefined
        const cookieLine = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader)!
            .split(';')[0]!
        expect(cookieLine).toContain('cpa_web_session=')

        // 4. Authenticated ws_open succeeds
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'authed-ws',
            path: '/api/ws',
            headers: { Cookie: cookieLine },
        })
        const openOk = await client.nextMux(
            (f) => f.meta.type === 'ws_open_result' && f.meta.connId === 'authed-ws',
        )
        expect(openOk.meta).toMatchObject({ ok: true })
        await client.nextMux((f) => f.meta.type === 'ws_data' && f.meta.connId === 'authed-ws') // consume hello

        // 5. Changing webPassword live closes tunnel WS with 4401 without dropping main tunnel connection
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
            webPassword: 'tunnel-password-2',
        })
        const wsClosed = await client.nextMux(
            (f) => f.meta.type === 'ws_close' && f.meta.connId === 'authed-ws',
        )
        expect(wsClosed.meta).toMatchObject({
            type: 'ws_close',
            connId: 'authed-ws',
            code: 4401,
        })
        expect(tunnelService.getStatus().phase).toBe('connected')

        client.close()
    })

    it('returns 413 http_response instead of emitting >64 MiB frame when local response exceeds tunnel payload budget', async () => {
        await tunnelService.dispose()
        await fs.writeFile(path.join(tmpDir, 'oversized.bin'), new Uint8Array(4096))

        tunnelService = new CliProxyTunnelServerService({
            webServerService: webServer,
            ensureServerUuid: () => 'srv-uuid-budget',
            maxHttpResponseBodyBytes: 1024, // Pin budget guard cleanly
        })

        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-budget')
        client.sendMux('srv-uuid-budget', {
            type: 'http_request',
            id: 'big-1',
            method: 'GET',
            path: '/oversized.bin',
        })
        const res = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'big-1',
        )
        expect(res.meta.type === 'http_response' && res.meta.status).toBe(413)
        expect(tunnelService.getStatus().phase).toBe('connected')

        client.close()
    })

    it('stops retrying on HTTP 401 and WS close 1008 ("api key revoked"), backs off on HTTP 409 and WS close 1001, and cleans up client loopback sockets on target_not_found control error', async () => {
        // 1. HTTP 401 stops retrying
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-wrong-key',
        })
        const unauthStatus = await waitForStatus(
            emittedStatuses,
            tunnelService,
            (s) => s.phase === 'error',
        )
        expect(unauthStatus.errorCode).toBe('unauthorized')
        const countAfter401 = hub.handshakeCount
        await new Promise((r) => setTimeout(r, 150))
        expect(hub.handshakeCount).toBe(countAfter401)

        // 2. HTTP 409 Conflict retries automatically and recovers to connected
        hub.nextOverrideStatus = {
            status: 409,
            body: { error: 'device uuid already connected' },
        }
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        // 3. Open a WS from client, then emit target_not_found -> local loopback socket cleaned up immediately
        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-vanish')
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'vanish-ws',
            path: '/api/ws',
        })
        await client.nextMux((f) => f.meta.type === 'ws_open_result')
        await client.nextMux((f) => f.meta.type === 'ws_data') // hello
        client.close()

        hub.sendControlToPeer('srv-uuid-001', {
            type: 'error',
            code: 'target_not_found',
            target_uuid: 'cli-vanish',
            message: 'target peer is not connected',
        })
        await new Promise<void>((resolve, reject) => {
            const start = Date.now()
            const timer = setInterval(() => {
                if (disconnectedClientIds.length > 0) {
                    clearInterval(timer)
                    resolve()
                } else if (Date.now() - start > 2000) {
                    clearInterval(timer)
                    reject(new Error('Expected loopback WS disconnect cleanup on target_not_found'))
                }
            }, 20)
        })
        expect(disconnectedClientIds.length).toBe(1)

        // 4. WS Close 1001 Going Away triggers automatic reconnect
        emittedStatuses.length = 0
        hub.closePeer('srv-uuid-001', 1001, 'server shutting down')
        await waitForStatus(
            emittedStatuses,
            tunnelService,
            (s) => s.phase === 'reconnecting',
        )
        await waitForStatus(
            emittedStatuses,
            tunnelService,
            (s) => s.phase === 'connected' && s.retryAttempt === 0,
        )

        // 5. WS Close 1008 ("api key revoked") stops retrying permanently
        hub.closePeer('srv-uuid-001', 1008, 'api key revoked')
        const revokedStatus = await waitForStatus(
            emittedStatuses,
            tunnelService,
            (s) => s.phase === 'error' && s.errorCode === 'api_key_revoked',
        )
        expect(revokedStatus.phase).toBe('error')
        const countAfterRevoke = hub.handshakeCount
        await new Promise((r) => setTimeout(r, 150))
        expect(hub.handshakeCount).toBe(countAfterRevoke)

        // I6: Saving unrelated settings with identical enabled/baseUrl/apiKey must NOT redial permanent error
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        expect(hub.handshakeCount).toBe(countAfterRevoke)
    })

    it('isolates malformed HTTP methods/headers, rejects duplicate in-flight HTTP ids, and cleanly replaces sole WS stream', async () => {
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-edge-01')

        // I1: Malformed HTTP method & header must return 400 and leave tunnel healthy
        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'bad-1',
            method: 'BAD METHOD',
            path: '/api/health',
            headers: { 'bad header': 'x', 'X-Forwarded-Proto': 'https' },
        })
        const badRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'bad-1',
        )
        expect(badRes.meta.type === 'http_response' && badRes.meta.status).toBe(400)

        // Verify subsequent HTTP request with X-Forwarded-Proto stripped succeeds cleanly
        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'good-1',
            method: 'GET',
            path: '/api/health',
            headers: { 'X-Forwarded-Proto': 'https' },
        })
        const goodRes = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'good-1',
        )
        expect(goodRes.meta.type === 'http_response' && goodRes.meta.status).toBe(200)

        // I3: Duplicate in-flight HTTP id must return 400 without corrupting original slow request
        const enc = new TextEncoder()
        const slowPayload = enc.encode(JSON.stringify({ id: 'slow-1', method: 'slow:op', args: [] }))
        webServer.setRpcDispatcher(async (method, args) => {
            if (method === 'slow:op') {
                await new Promise((r) => setTimeout(r, 120))
                return { done: true }
            }
            if (method === 'session:list') {
                return ['s-1', 's-2']
            }
            if (method === 'echo') {
                return { echoed: args[0] }
            }
            throw new Error(`Unknown method: ${method}`)
        })

        client.sendMux(
            'srv-uuid-001',
            {
                type: 'http_request',
                id: 'dup-id',
                method: 'POST',
                path: '/api/rpc',
                headers: { 'content-type': 'application/json' },
            },
            slowPayload,
        )
        await new Promise((r) => setTimeout(r, 20))

        client.sendMux('srv-uuid-001', {
            type: 'http_request',
            id: 'dup-id',
            method: 'GET',
            path: '/api/health',
        })

        const firstDup = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'dup-id',
        )
        expect(firstDup.meta.type === 'http_response' && firstDup.meta.status).toBe(400)

        const secondDup = await client.nextMux(
            (f) => f.meta.type === 'http_response' && f.meta.id === 'dup-id',
        )
        expect(secondDup.meta.type === 'http_response' && secondDup.meta.status).toBe(200)

        // I4: Reopening same connId when it is the peer's sole stream keeps peer managed & relays data
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'sole-ws',
            path: '/api/ws',
        })
        await client.nextMux((f) => f.meta.type === 'ws_open_result' && f.meta.connId === 'sole-ws')
        await client.nextMux((f) => f.meta.type === 'ws_data' && f.meta.connId === 'sole-ws')

        // Replace with same connId
        client.sendMux('srv-uuid-001', {
            type: 'ws_open',
            connId: 'sole-ws',
            path: '/api/ws',
        })
        const reopenAck = await client.nextMux(
            (f) => f.meta.type === 'ws_open_result' && f.meta.connId === 'sole-ws',
        )
        expect(reopenAck.meta.type === 'ws_open_result' && reopenAck.meta.ok).toBe(true)
        await client.nextMux((f) => f.meta.type === 'ws_data' && f.meta.connId === 'sole-ws')

        expect(tunnelService.getStatus().connectedClients).toBe(1)

        const wsRpc = enc.encode(JSON.stringify({ id: 'ws-after-replace', method: 'session:list', args: [] }))
        client.sendMux(
            'srv-uuid-001',
            { type: 'ws_data', connId: 'sole-ws', opcode: 'text' },
            wsRpc,
        )
        const wsReply = await client.nextMux(
            (f) =>
                f.meta.type === 'ws_data' &&
                f.meta.connId === 'sole-ws' &&
                new TextDecoder().decode(f.body).includes('ws-after-replace'),
        )
        expect(JSON.parse(new TextDecoder().decode(wsReply.body)).result).toEqual(['s-1', 's-2'])

        client.close()
        await tunnelService.stop()
        expect(tunnelService.getStatus().connectedClients).toBe(0)
    })

    it('destroys stalled unexpected-response socket immediately when stop() is called', async () => {
        let serverSocketClosed = false
        const stalledServer = http.createServer((_req, res) => {
            res.socket?.once('close', () => {
                serverSocketClosed = true
            })
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.write('{"error":"stalled')
            // Intentionally do not call res.end()
        })
        await new Promise<void>((resolve) => stalledServer.listen(0, '127.0.0.1', () => resolve()))
        const stalledPort = (stalledServer.address() as AddressInfo).port

        try {
            await tunnelService.syncConfig({
                enabled: true,
                baseUrl: `http://127.0.0.1:${stalledPort}`,
                apiKey: 'sk-stalled',
            })
            await new Promise((r) => setTimeout(r, 80))
            await tunnelService.stop()

            await new Promise<void>((resolve, reject) => {
                const start = Date.now()
                const timer = setInterval(() => {
                    if (serverSocketClosed) {
                        clearInterval(timer)
                        resolve()
                    } else if (Date.now() - start > 1500) {
                        clearInterval(timer)
                        reject(new Error('Expected stalled handshake socket to be destroyed on stop()'))
                    }
                }, 20)
            })
            expect(serverSocketClosed).toBe(true)
        } finally {
            stalledServer.close()
        }
    })

    it('enforces server type handshake on hub, stops retrying on HTTP 400 bad_request, and broadcasts server_offline with type=CodingProfessionalAgent', async () => {
        // 1. Raw server dial without type is rejected with HTTP 400 without reserving srv-uuid-001
        const missingTypeUrl =
            hubBaseUrl.replace(/^http/, 'ws') +
            '/v1/tunnel?role=server&uuid=srv-uuid-001&name=NoTypeServer'
        const rawRejectCode = await new Promise<number>((resolve, reject) => {
            const rawWs = new WebSocket(missingTypeUrl, {
                headers: { Authorization: 'Bearer sk-valid-key' },
            })
            rawWs.on('error', () => {})
            rawWs.once('unexpected-response', (_req, res) => {
                const status = res.statusCode ?? 0
                res.resume()
                rawWs.terminate()
                resolve(status)
            })
            rawWs.once('open', () => {
                rawWs.close()
                reject(new Error('Expected missing type handshake to be rejected with HTTP 400'))
            })
        })
        expect(rawRejectCode).toBe(400)

        // 2. HTTP 400 from hub puts service into terminal bad_request error without retrying
        hub.nextOverrideStatus = {
            status: 400,
            body: { error: 'invalid or missing type' },
        }
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        const badReqStatus = await waitForStatus(
            emittedStatuses,
            tunnelService,
            (s) => s.phase === 'error' && s.errorCode === 'bad_request',
        )
        expect(badReqStatus.error).toBe('invalid or missing type')
        const handshakesAfter400 = hub.handshakeCount
        await new Promise((r) => setTimeout(r, 150))
        expect(hub.handshakeCount).toBe(handshakesAfter400)

        // 3. Re-enabling connects with type=CodingProfessionalAgent using same srv-uuid-001, and stop() triggers server_offline with type
        await tunnelService.stop()
        emittedStatuses.length = 0
        await tunnelService.syncConfig({
            enabled: true,
            baseUrl: hubBaseUrl,
            apiKey: 'sk-valid-key',
        })
        await waitForStatus(emittedStatuses, tunnelService, (s) => s.phase === 'connected')

        const client = await connectTestTunnelClient(hubBaseUrl, 'sk-valid-key', 'cli-watch-offline')
        await client.nextControl((f) => f.type === 'server_list')

        await tunnelService.stop()
        const offlineEvt = await client.nextControl((f) => f.type === 'server_offline')
        expect(offlineEvt).toEqual({
            type: 'server_offline',
            server: {
                uuid: 'srv-uuid-001',
                name: 'MacBook-Pro-Server',
                type: 'CodingProfessionalAgent',
            },
        })
        client.close()
    })
})
