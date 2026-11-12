import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as os from 'node:os'
import { WebSocket, type RawData } from 'ws'
import type {
    CliProxyTunnelPhase,
    CliProxyTunnelStatus,
    NativeEvent,
    TunnelSyncConfig,
} from '../../shared/types.js'
import type { LoopbackEndpoint, WebServerService } from './webServerService.js'
import {
    CPA_TUNNEL_MUX_PAYLOAD_TYPE,
    CPA_TUNNEL_SERVER_TYPE,
    MAX_HTTP_RESPONSE_BODY_BYTES,
    MAX_TUNNEL_RAW_PAYLOAD_BYTES,
    decodeMuxFrame,
    decodeTunnelFrame,
    encodeMuxFrame,
    encodeTunnelFrame,
    isValidTunnelUuid,
    normalizeWsCloseCode,
    redactSecret,
    resolveTunnelServerName,
    resolveTunnelServerType,
    resolveTunnelWebSocketUrl,
    sanitizeLoopbackRequestHeaders,
    truncateWsCloseReason,
    validateHttpMethod,
    validateLoopbackPath,
    type DecodedMuxFrame,
    type TunnelHeaderMap,
    type TunnelMuxMeta,
} from './tunnel/tunnelProtocol.js'

const MAX_CONCURRENT_HTTP_PER_PEER = 64
const MAX_CONCURRENT_WS_PER_PEER = 32
const MAX_CONTROL_FRAME_BYTES = 4096
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export interface CliProxyTunnelServiceOptions {
    webServerService: WebServerService
    emitEvent?: (event: NativeEvent) => void
    ensureServerUuid?: (candidate?: string) => Promise<string> | string
    getHostname?: () => string
    serverType?: string
    randomJitter?: () => number
    initialBackoffMs?: number
    conflictBackoffMs?: number
    maxBackoffMs?: number
    handshakeTimeoutMs?: number
    handshakeErrorBodyTimeoutMs?: number
    maxHttpResponseBodyBytes?: number
}

interface PeerWsEntry {
    connId: string
    ws: WebSocket
    openAckSent: boolean
    closedByPeer: boolean
    settled: boolean
    preOpenServerFrames: Array<{ opcode: 'text' | 'binary'; body: Uint8Array }>
    preOpenClientFrames: Array<{ opcode: 'text' | 'binary'; body: Uint8Array }>
}

interface PeerState {
    clientUuid: string
    inFlightHttp: Map<string, http.ClientRequest>
    wsStreams: Map<string, PeerWsEntry>
}

function rawDataToUint8Array(data: RawData): Uint8Array {
    if (Buffer.isBuffer(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    }
    if (Array.isArray(data)) {
        const merged = Buffer.concat(data)
        return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength)
    }
    return new Uint8Array(data)
}

function normalizeNodeHeaders(headers: http.IncomingHttpHeaders): TunnelHeaderMap {
    const out: TunnelHeaderMap = {}
    for (const [key, val] of Object.entries(headers)) {
        if (val === undefined) continue
        out[key] = val
    }
    return out
}

/**
 * Manages CPA's outbound server-role connection to CLIProxyAPI's GET /v1/tunnel
 * and multiplexes incoming client HTTP and WebSocket streams onto WebServerService's internal loopback listener.
 */
export class CliProxyTunnelServerService {
    private readonly webServerService: WebServerService
    private readonly emitEvent?: (event: NativeEvent) => void
    private readonly ensureServerUuid?: (candidate?: string) => Promise<string> | string
    private readonly getHostname: () => string
    private readonly serverType: string
    private readonly randomJitter: () => number
    private readonly initialBackoffMs: number
    private readonly conflictBackoffMs: number
    private readonly maxBackoffMs: number
    private readonly handshakeTimeoutMs: number
    private readonly handshakeErrorBodyTimeoutMs: number
    private readonly maxHttpResponseBodyBytes: number

    private enabled = false
    private disposed = false
    private phase: CliProxyTunnelPhase = 'stopped'
    private serverUuid = ''
    private serverName = ''
    private activeTunnelUrl = ''
    private activeApiKey = ''
    private activeConfigKey = ''
    private retryAttempt = 0
    private lastError?: string
    private lastErrorCode?: string

    private connectionEpoch = 0
    private ws: WebSocket | null = null
    private pendingHandshakeCleanup: (() => void) | null = null
    private reconnectTimer: NodeJS.Timeout | null = null
    private loopbackEndpoint: LoopbackEndpoint | null = null
    private loopbackAcquired = false
    private readonly peers = new Map<string, PeerState>()
    private eventSequence = 0
    private opQueue: Promise<unknown> = Promise.resolve()

    constructor(options: CliProxyTunnelServiceOptions) {
        this.webServerService = options.webServerService
        this.emitEvent = options.emitEvent
        this.ensureServerUuid = options.ensureServerUuid
        this.getHostname = options.getHostname ?? (() => os.hostname())
        this.randomJitter = options.randomJitter ?? (() => 0.8 + Math.random() * 0.4)
        this.initialBackoffMs = options.initialBackoffMs ?? 1000
        this.conflictBackoffMs = options.conflictBackoffMs ?? 2000
        this.maxBackoffMs = options.maxBackoffMs ?? 30_000
        this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000
        this.handshakeErrorBodyTimeoutMs = options.handshakeErrorBodyTimeoutMs ?? 4_000
        this.maxHttpResponseBodyBytes =
            options.maxHttpResponseBodyBytes ?? MAX_HTTP_RESPONSE_BODY_BYTES
        this.serverType = resolveTunnelServerType(options.serverType ?? CPA_TUNNEL_SERVER_TYPE)
        this.serverName = resolveTunnelServerName(this.getHostname())
    }

    getStatus(): CliProxyTunnelStatus {
        return {
            enabled: this.enabled,
            phase: this.phase,
            serverUuid: this.serverUuid,
            serverName: this.serverName,
            tunnelUrl: this.activeTunnelUrl,
            connectedClients: this.countActiveClients(),
            retryAttempt: this.retryAttempt,
            ...(this.lastError ? { error: this.lastError } : {}),
            ...(this.lastErrorCode ? { errorCode: this.lastErrorCode } : {}),
        }
    }

    private countActiveClients(): number {
        let count = 0
        for (const peer of this.peers.values()) {
            if (peer.inFlightHttp.size > 0 || peer.wsStreams.size > 0) {
                count += 1
            }
        }
        return count
    }

    private emitStatusChanged(): void {
        if (!this.emitEvent) return
        const snapshot = this.getStatus()
        try {
            this.emitEvent({
                operationId: 'tunnel',
                sequence: ++this.eventSequence,
                kind: 'tunnel:status-changed',
                data: JSON.stringify(snapshot),
            })
        } catch {
            // Ignore listener emission errors during shutdown
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    private closeActiveTunnelSocket(): void {
        this.clearReconnectTimer()
        if (this.pendingHandshakeCleanup) {
            const cleanup = this.pendingHandshakeCleanup
            this.pendingHandshakeCleanup = null
            try {
                cleanup()
            } catch {
                // Ignore handshake abort errors
            }
        }
        const current = this.ws
        this.ws = null
        if (!current) return
        try {
            if (current.readyState === WebSocket.OPEN) {
                current.close(1000, 'Tunnel reconfigured or stopped')
            } else {
                current.terminate()
            }
        } catch {
            try {
                current.terminate()
            } catch {
                // Ignore socket termination errors
            }
        }
    }

    private cleanupPeer(clientUuid: string): void {
        const peer = this.peers.get(clientUuid)
        if (!peer) return
        this.peers.delete(clientUuid)

        for (const req of peer.inFlightHttp.values()) {
            try {
                req.destroy()
            } catch {
                // Ignore request abort error
            }
        }
        peer.inFlightHttp.clear()

        for (const entry of peer.wsStreams.values()) {
            entry.closedByPeer = true
            entry.settled = true
            try {
                if (entry.ws.readyState === WebSocket.OPEN) {
                    entry.ws.close(1000, 'Remote tunnel peer disconnected')
                } else {
                    entry.ws.terminate()
                }
            } catch {
                try {
                    entry.ws.terminate()
                } catch {}
            }
        }
        peer.wsStreams.clear()
    }

    private cleanupAllPeers(): void {
        for (const clientUuid of Array.from(this.peers.keys())) {
            this.cleanupPeer(clientUuid)
        }
        this.peers.clear()
    }

    private async ensureLoopback(): Promise<LoopbackEndpoint> {
        if (this.loopbackAcquired && this.loopbackEndpoint) {
            return this.loopbackEndpoint
        }
        const endpoint = await this.webServerService.acquireLoopbackEndpoint()
        this.loopbackEndpoint = endpoint
        this.loopbackAcquired = true
        return endpoint
    }

    private async releaseLoopbackIfHeld(): Promise<void> {
        if (!this.loopbackAcquired) return
        this.loopbackAcquired = false
        this.loopbackEndpoint = null
        await this.webServerService.releaseLoopbackEndpoint()
    }

    private async resolveUuid(candidate?: string): Promise<string> {
        const trimmedCandidate = typeof candidate === 'string' ? candidate.trim() : ''
        if (this.ensureServerUuid) {
            const ensured = await this.ensureServerUuid(trimmedCandidate || this.serverUuid || undefined)
            if (isValidTunnelUuid(ensured)) {
                return ensured
            }
        }
        if (isValidTunnelUuid(trimmedCandidate)) {
            return trimmedCandidate
        }
        if (isValidTunnelUuid(this.serverUuid)) {
            return this.serverUuid
        }
        return crypto.randomUUID()
    }

    async syncConfig(config: TunnelSyncConfig): Promise<CliProxyTunnelStatus> {
        const task = this.opQueue.then(async () => {
            if (this.disposed) {
                return this.getStatus()
            }

            if (typeof config.webPassword === 'string') {
                this.webServerService.configure({ password: config.webPassword })
            }

            this.serverName = resolveTunnelServerName(this.getHostname())
            this.serverUuid = await this.resolveUuid(config.tunnelUuid)

            if (!config.enabled) {
                this.connectionEpoch += 1
                this.enabled = false
                this.closeActiveTunnelSocket()
                this.cleanupAllPeers()
                await this.releaseLoopbackIfHeld()
                this.activeTunnelUrl = ''
                this.activeApiKey = ''
                this.activeConfigKey = ''
                this.retryAttempt = 0
                this.lastError = undefined
                this.lastErrorCode = undefined
                this.phase = 'stopped'
                this.emitStatusChanged()
                return this.getStatus()
            }

            const wasEnabled = this.enabled
            this.enabled = true
            const baseUrl = String(config.baseUrl ?? '').trim()
            const apiKey = String(config.apiKey ?? '').trim()

            if (!baseUrl || !apiKey) {
                this.connectionEpoch += 1
                this.closeActiveTunnelSocket()
                this.cleanupAllPeers()
                await this.releaseLoopbackIfHeld()
                this.activeTunnelUrl = ''
                this.activeApiKey = apiKey
                this.activeConfigKey = ''
                this.retryAttempt = 0
                this.phase = 'error'
                this.lastErrorCode = 'missing_config'
                this.lastError = 'Missing CLIProxyAPI Base URL or API key'
                this.emitStatusChanged()
                return this.getStatus()
            }

            let tunnelUrl: string
            try {
                tunnelUrl = resolveTunnelWebSocketUrl(
                    baseUrl,
                    this.serverUuid,
                    this.serverName,
                    this.serverType,
                )
            } catch (err) {
                this.connectionEpoch += 1
                this.closeActiveTunnelSocket()
                this.cleanupAllPeers()
                await this.releaseLoopbackIfHeld()
                this.activeTunnelUrl = ''
                this.activeApiKey = apiKey
                this.activeConfigKey = ''
                this.retryAttempt = 0
                this.phase = 'error'
                this.lastErrorCode = 'invalid_url'
                this.lastError = redactSecret(
                    err instanceof Error ? err.message : String(err),
                    apiKey,
                )
                this.emitStatusChanged()
                return this.getStatus()
            }

            const nextConfigKey = `${tunnelUrl}\n${apiKey}`
            const isTerminalConfigError =
                this.phase === 'error' &&
                (this.lastErrorCode === 'unauthorized' ||
                    this.lastErrorCode === 'forbidden' ||
                    this.lastErrorCode === 'bad_request' ||
                    this.lastErrorCode === 'api_key_revoked')

            // Preserve active connection, scheduled backoff, or terminal auth rejection when config is unchanged
            if (
                wasEnabled &&
                this.activeConfigKey === nextConfigKey &&
                (this.phase === 'connecting' ||
                    this.phase === 'connected' ||
                    this.phase === 'reconnecting' ||
                    isTerminalConfigError)
            ) {
                return this.getStatus()
            }

            this.connectionEpoch += 1
            const epoch = this.connectionEpoch
            this.closeActiveTunnelSocket()
            this.cleanupAllPeers()

            try {
                await this.ensureLoopback()
            } catch (err) {
                this.phase = 'error'
                this.lastErrorCode = 'loopback_failed'
                this.lastError = redactSecret(
                    err instanceof Error ? err.message : String(err),
                    apiKey,
                )
                this.emitStatusChanged()
                return this.getStatus()
            }

            this.activeTunnelUrl = tunnelUrl
            this.activeApiKey = apiKey
            this.activeConfigKey = nextConfigKey
            this.retryAttempt = 0
            this.lastError = undefined
            this.lastErrorCode = undefined
            this.dial(epoch)
            return this.getStatus()
        })

        this.opQueue = task.catch(() => {})
        return task
    }

    async stop(): Promise<CliProxyTunnelStatus> {
        return this.syncConfig({
            enabled: false,
            baseUrl: '',
            apiKey: '',
        })
    }

    async dispose(): Promise<void> {
        const task = this.opQueue.then(async () => {
            if (this.disposed) return
            this.disposed = true
            this.connectionEpoch += 1
            this.enabled = false
            this.closeActiveTunnelSocket()
            this.cleanupAllPeers()
            await this.releaseLoopbackIfHeld()
            this.phase = 'stopped'
        })
        this.opQueue = task.catch(() => {})
        await task
    }

    private scheduleReconnect(
        epoch: number,
        baseDelayMs: number,
        errorCode: string,
        errorMessage: string,
    ): void {
        if (epoch !== this.connectionEpoch || !this.enabled || this.disposed) {
            return
        }
        this.clearReconnectTimer()
        this.retryAttempt += 1
        this.phase = 'reconnecting'
        this.lastErrorCode = errorCode
        this.lastError = redactSecret(errorMessage, this.activeApiKey)
        this.emitStatusChanged()

        const expDelay = Math.min(
            this.maxBackoffMs,
            baseDelayMs * Math.pow(2, Math.max(0, this.retryAttempt - 1)),
        )
        const jitteredDelay = Math.max(20, Math.round(expDelay * this.randomJitter()))

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null
            if (epoch !== this.connectionEpoch || !this.enabled || this.disposed) {
                return
            }
            this.dial(epoch)
        }, jitteredDelay)
    }

    private dial(epoch: number): void {
        if (epoch !== this.connectionEpoch || !this.enabled || this.disposed) {
            return
        }

        this.phase = this.retryAttempt > 0 ? 'reconnecting' : 'connecting'
        this.emitStatusChanged()

        const apiKey = this.activeApiKey
        let socket: WebSocket
        try {
            socket = new WebSocket(this.activeTunnelUrl, {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                handshakeTimeout: this.handshakeTimeoutMs,
                maxPayload: MAX_TUNNEL_RAW_PAYLOAD_BYTES + 1024,
            })
        } catch (err) {
            this.scheduleReconnect(
                epoch,
                this.initialBackoffMs,
                'dial_failed',
                err instanceof Error ? err.message : String(err),
            )
            return
        }

        this.ws = socket
        let settled = false
        let lastSocketErr = ''

        socket.once('open', () => {
            if (epoch !== this.connectionEpoch || this.disposed) {
                try {
                    socket.close(1000)
                } catch {}
                return
            }
            this.retryAttempt = 0
            this.lastError = undefined
            this.lastErrorCode = undefined
            this.phase = 'connected'
            this.emitStatusChanged()
        })

        socket.once('unexpected-response', (req, res) => {
            if (settled) return
            settled = true
            if (this.ws === socket) {
                this.ws = null
            }

            const statusCode = res.statusCode ?? 0
            const chunks: Buffer[] = []
            let total = 0
            let finalized = false

            const abortPendingHandshake = () => {
                clearTimeout(errorBodyTimer)
                try {
                    res.destroy()
                } catch {}
                try {
                    req.destroy()
                } catch {}
                try {
                    socket.terminate()
                } catch {}
            }

            this.pendingHandshakeCleanup = abortPendingHandshake

            res.on('data', (chunk: Buffer) => {
                if (total < 4096) {
                    chunks.push(chunk)
                    total += chunk.length
                } else {
                    finalizeHandshakeError()
                }
            })

            const finalizeHandshakeError = () => {
                if (finalized) return
                finalized = true
                if (this.pendingHandshakeCleanup === abortPendingHandshake) {
                    this.pendingHandshakeCleanup = null
                }
                abortPendingHandshake()

                if (epoch !== this.connectionEpoch || !this.enabled || this.disposed) {
                    return
                }

                this.cleanupAllPeers()

                let serverDetail = ''
                if (chunks.length > 0) {
                    const bodyText = Buffer.concat(chunks).toString('utf8').trim()
                    try {
                        const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown }
                        if (typeof parsed.message === 'string' && parsed.message) {
                            serverDetail = parsed.message
                        } else if (typeof parsed.error === 'string' && parsed.error) {
                            serverDetail = parsed.error
                        }
                    } catch {
                        serverDetail = bodyText.slice(0, 200)
                    }
                }
                const sanitizedDetail = redactSecret(serverDetail, apiKey)

                if (statusCode === 401) {
                    this.phase = 'error'
                    this.lastErrorCode = 'unauthorized'
                    this.lastError = sanitizedDetail || 'Unauthorized (401)'
                    this.emitStatusChanged()
                    return
                }
                if (statusCode === 403 || statusCode === 400) {
                    this.phase = 'error'
                    this.lastErrorCode = statusCode === 403 ? 'forbidden' : 'bad_request'
                    this.lastError = sanitizedDetail || `Handshake rejected (${statusCode})`
                    this.emitStatusChanged()
                    return
                }
                if (statusCode === 409) {
                    this.scheduleReconnect(
                        epoch,
                        this.conflictBackoffMs,
                        'uuid_conflict',
                        sanitizedDetail || 'Device UUID already connected (409)',
                    )
                    return
                }
                this.scheduleReconnect(
                    epoch,
                    this.initialBackoffMs,
                    `http_${statusCode}`,
                    sanitizedDetail || `Handshake failed with HTTP ${statusCode}`,
                )
            }

            const errorBodyTimer = setTimeout(
                finalizeHandshakeError,
                this.handshakeErrorBodyTimeoutMs,
            )
            errorBodyTimer.unref?.()

            res.once('end', finalizeHandshakeError)
            res.once('error', finalizeHandshakeError)
            res.once('close', finalizeHandshakeError)
        })

        socket.on('message', (data: RawData, isBinary: boolean) => {
            if (epoch !== this.connectionEpoch || this.disposed) {
                return
            }
            try {
                if (!isBinary) {
                    this.handleControlMessage(data)
                    return
                }
                this.handleBinaryTunnelPacket(epoch, data)
            } catch {
                // Isolate malformed frame errors so shared tunnel socket stays alive
            }
        })

        socket.on('error', (err: Error) => {
            lastSocketErr = redactSecret(err?.message || String(err), apiKey)
        })

        socket.once('close', (code: number, reasonBuf: Buffer) => {
            if (settled) return
            settled = true
            if (this.ws === socket) {
                this.ws = null
            }
            if (epoch !== this.connectionEpoch || !this.enabled || this.disposed) {
                return
            }

            this.cleanupAllPeers()
            const reasonText = redactSecret(
                reasonBuf && reasonBuf.length > 0 ? reasonBuf.toString('utf8') : '',
                apiKey,
            )

            if (code === 1008 && /api key revoked/i.test(reasonText)) {
                this.phase = 'error'
                this.lastErrorCode = 'api_key_revoked'
                this.lastError = reasonText || 'API key revoked (1008)'
                this.emitStatusChanged()
                return
            }

            this.scheduleReconnect(
                epoch,
                this.initialBackoffMs,
                `ws_${code}`,
                reasonText || lastSocketErr || `Tunnel disconnected (${code})`,
            )
        })
    }

    private handleControlMessage(data: RawData): void {
        const bytes = rawDataToUint8Array(data)
        if (bytes.byteLength > MAX_CONTROL_FRAME_BYTES) {
            return
        }
        try {
            const parsed = JSON.parse(textDecoder.decode(bytes)) as {
                type?: unknown
                code?: unknown
                target_uuid?: unknown
            }
            if (
                parsed?.type === 'error' &&
                parsed?.code === 'target_not_found' &&
                typeof parsed?.target_uuid === 'string' &&
                parsed.target_uuid
            ) {
                const hadPeer = this.peers.has(parsed.target_uuid)
                this.cleanupPeer(parsed.target_uuid)
                if (hadPeer) {
                    this.emitStatusChanged()
                }
            }
        } catch {
            // Ignore malformed control frame
        }
    }

    private getOrCreatePeer(clientUuid: string): PeerState {
        let peer = this.peers.get(clientUuid)
        if (!peer) {
            peer = {
                clientUuid,
                inFlightHttp: new Map(),
                wsStreams: new Map(),
            }
            this.peers.set(clientUuid, peer)
        }
        return peer
    }

    private sendMuxToClient(
        epoch: number,
        clientUuid: string,
        meta: TunnelMuxMeta,
        body?: Uint8Array,
    ): boolean {
        if (
            epoch !== this.connectionEpoch ||
            !this.ws ||
            this.ws.readyState !== WebSocket.OPEN
        ) {
            return false
        }
        try {
            const muxBytes = encodeMuxFrame(meta, body)
            const outerBytes = encodeTunnelFrame(
                CPA_TUNNEL_MUX_PAYLOAD_TYPE,
                this.serverUuid,
                clientUuid,
                muxBytes,
            )
            this.ws.send(outerBytes, { binary: true })
            return true
        } catch {
            return false
        }
    }

    private handleBinaryTunnelPacket(epoch: number, data: RawData): void {
        let outer
        try {
            outer = decodeTunnelFrame(rawDataToUint8Array(data))
        } catch {
            return
        }

        if (
            outer.dstUuid !== this.serverUuid ||
            outer.payloadType !== CPA_TUNNEL_MUX_PAYLOAD_TYPE
        ) {
            return
        }

        let mux: DecodedMuxFrame
        try {
            mux = decodeMuxFrame(outer.payload)
        } catch {
            return
        }

        const clientUuid = outer.srcUuid
        switch (mux.meta.type) {
            case 'http_request':
                this.forwardHttpRequest(epoch, clientUuid, mux.meta, mux.body)
                break
            case 'ws_open':
                this.openLoopbackWebSocket(epoch, clientUuid, mux.meta)
                break
            case 'ws_data':
                this.forwardClientWsData(clientUuid, mux.meta.connId, mux.meta.opcode, mux.body)
                break
            case 'ws_close':
                this.closeClientWsStream(clientUuid, mux.meta.connId, mux.meta.code, mux.meta.reason)
                break
            default:
                break
        }
    }

    private sendJsonHttpError(
        epoch: number,
        clientUuid: string,
        requestId: string,
        status: number,
        message: string,
    ): void {
        this.sendMuxToClient(
            epoch,
            clientUuid,
            {
                type: 'http_response',
                id: requestId,
                status,
                headers: {
                    'content-type': 'application/json',
                    'cache-control': 'no-store',
                },
            },
            textEncoder.encode(JSON.stringify({ error: message })),
        )
    }

    private forwardHttpRequest(
        epoch: number,
        clientUuid: string,
        meta: Extract<TunnelMuxMeta, { type: 'http_request' }>,
        body: Uint8Array,
    ): void {
        if (!meta.id || typeof meta.id !== 'string') {
            return
        }
        const reqId = typeof meta.id === 'string' ? meta.id.trim() : ''
        if (!reqId || reqId.length > 128) {
            return
        }

        const endpoint = this.loopbackEndpoint
        if (!endpoint) {
            this.sendJsonHttpError(epoch, clientUuid, reqId, 503, 'Loopback server is unavailable')
            return
        }

        const method = validateHttpMethod(meta.method)
        if (!method) {
            this.sendJsonHttpError(epoch, clientUuid, reqId, 400, 'Invalid HTTP method')
            return
        }

        const targetUrl = validateLoopbackPath(meta.path, endpoint.origin)
        if (!targetUrl) {
            this.sendJsonHttpError(epoch, clientUuid, reqId, 400, 'Invalid request path')
            return
        }

        const peer = this.getOrCreatePeer(clientUuid)
        if (peer.inFlightHttp.has(reqId)) {
            this.sendJsonHttpError(epoch, clientUuid, reqId, 400, 'Duplicate in-flight HTTP request id')
            return
        }
        if (peer.inFlightHttp.size >= MAX_CONCURRENT_HTTP_PER_PEER) {
            this.sendJsonHttpError(epoch, clientUuid, reqId, 429, 'Too many concurrent HTTP requests')
            return
        }

        const loopbackHost = `${endpoint.host}:${endpoint.port}`
        const sanitizedHeaders = sanitizeLoopbackRequestHeaders(
            meta.headers,
            loopbackHost,
            endpoint.origin,
        )
        if (body.byteLength > 0 && method !== 'GET' && method !== 'HEAD') {
            sanitizedHeaders['Content-Length'] = String(body.byteLength)
        }

        let responded = false
        let req: http.ClientRequest | null = null
        const finishRequest = () => {
            if (req && peer.inFlightHttp.get(reqId) === req) {
                peer.inFlightHttp.delete(reqId)
                if (
                    this.peers.get(clientUuid) === peer &&
                    peer.wsStreams.size === 0 &&
                    peer.inFlightHttp.size === 0
                ) {
                    this.peers.delete(clientUuid)
                    this.emitStatusChanged()
                }
            }
        }

        try {
            req = http.request(
            {
                hostname: endpoint.host,
                port: endpoint.port,
                path: `${targetUrl.pathname}${targetUrl.search}`,
                method,
                headers: sanitizedHeaders,
            },
            (res) => {
                const chunks: Buffer[] = []
                let totalBytes = 0
                let exceededBudget = false

                res.on('data', (chunk: Buffer | string) => {
                    if (exceededBudget) return
                    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
                    totalBytes += buf.byteLength
                    if (totalBytes > this.maxHttpResponseBodyBytes) {
                        exceededBudget = true
                        responded = true
                        finishRequest()
                        res.destroy()
                        req?.destroy()
                        this.sendJsonHttpError(
                            epoch,
                            clientUuid,
                            reqId,
                            413,
                            'Response exceeds 64 MiB tunnel frame limit',
                        )
                        return
                    }
                    chunks.push(buf)
                })

                res.on('end', () => {
                    if (responded || exceededBudget) return
                    responded = true
                    finishRequest()

                    const merged = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)
                    const bodyBytes = new Uint8Array(
                        merged.buffer,
                        merged.byteOffset,
                        merged.byteLength,
                    )
                    const resMeta: TunnelMuxMeta = {
                        type: 'http_response',
                        id: reqId,
                        status: res.statusCode ?? 200,
                        headers: normalizeNodeHeaders(res.headers),
                    }

                    const sent = this.sendMuxToClient(epoch, clientUuid, resMeta, bodyBytes)
                    if (!sent && epoch === this.connectionEpoch && this.ws?.readyState === WebSocket.OPEN) {
                        this.sendJsonHttpError(
                            epoch,
                            clientUuid,
                            reqId,
                            413,
                            'Encoded HTTP response exceeds 64 MiB tunnel frame limit',
                        )
                    }
                })

                res.on('error', (err) => {
                    if (responded) return
                    responded = true
                    finishRequest()
                    this.sendJsonHttpError(
                        epoch,
                        clientUuid,
                        reqId,
                        502,
                        err instanceof Error ? err.message : 'Loopback response error',
                    )
                })
            },
            )
        } catch (err) {
            this.sendJsonHttpError(
                epoch,
                clientUuid,
                reqId,
                400,
                err instanceof Error ? err.message : 'Invalid HTTP request',
            )
            return
        }

        const wasPeerIdle = peer.wsStreams.size === 0 && peer.inFlightHttp.size === 0
        peer.inFlightHttp.set(reqId, req)
        if (wasPeerIdle) {
            this.emitStatusChanged()
        }

        req.on('error', (err) => {
            if (responded) return
            responded = true
            finishRequest()
            this.sendJsonHttpError(
                epoch,
                clientUuid,
                reqId,
                502,
                err instanceof Error ? err.message : 'Loopback request failed',
            )
        })

        if (body.byteLength > 0 && method !== 'GET' && method !== 'HEAD') {
            req.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
        }
        req.end()
    }

    private openLoopbackWebSocket(
        epoch: number,
        clientUuid: string,
        meta: Extract<TunnelMuxMeta, { type: 'ws_open' }>,
    ): void {
        const connId = typeof meta.connId === 'string' ? meta.connId.trim() : ''
        if (!connId || connId.length > 128) {
            return
        }

        const endpoint = this.loopbackEndpoint
        if (!endpoint) {
            this.sendMuxToClient(epoch, clientUuid, {
                type: 'ws_open_result',
                connId,
                ok: false,
                status: 503,
                error: 'Loopback server is unavailable',
            })
            return
        }

        const rawPath = typeof meta.path === 'string' && meta.path ? meta.path : '/api/ws'
        const targetUrl = validateLoopbackPath(rawPath, endpoint.origin)
        if (!targetUrl) {
            this.sendMuxToClient(epoch, clientUuid, {
                type: 'ws_open_result',
                connId,
                ok: false,
                status: 400,
                error: 'Invalid WebSocket path',
            })
            return
        }

        if (this.peers.get(clientUuid)?.wsStreams.has(connId)) {
            this.closeClientWsStream(clientUuid, connId, 1000, 'Replaced by new stream')
        }
        const peer = this.getOrCreatePeer(clientUuid)
        if (peer.wsStreams.size >= MAX_CONCURRENT_WS_PER_PEER) {
            this.sendMuxToClient(epoch, clientUuid, {
                type: 'ws_open_result',
                connId,
                ok: false,
                status: 429,
                error: 'Too many concurrent WebSocket streams',
            })
            return
        }

        const loopbackHost = `${endpoint.host}:${endpoint.port}`
        const sanitizedHeaders = sanitizeLoopbackRequestHeaders(
            meta.headers,
            loopbackHost,
            endpoint.origin,
        )

        const wsUrl = `ws://${endpoint.host}:${endpoint.port}${targetUrl.pathname}${targetUrl.search}`
        let localWs: WebSocket
        try {
            localWs = new WebSocket(wsUrl, {
                headers: sanitizedHeaders,
                maxPayload: MAX_TUNNEL_RAW_PAYLOAD_BYTES,
            })
        } catch (err) {
            if (peer.wsStreams.size === 0 && peer.inFlightHttp.size === 0) {
                this.peers.delete(clientUuid)
            }
            this.sendMuxToClient(epoch, clientUuid, {
                type: 'ws_open_result',
                connId,
                ok: false,
                status: 400,
                error: err instanceof Error ? err.message : 'Invalid WebSocket request',
            })
            return
        }

        const entry: PeerWsEntry = {
            connId,
            ws: localWs,
            openAckSent: false,
            closedByPeer: false,
            settled: false,
            preOpenServerFrames: [],
            preOpenClientFrames: [],
        }
        const wasPeerIdle = peer.wsStreams.size === 0 && peer.inFlightHttp.size === 0
        peer.wsStreams.set(connId, entry)
        if (wasPeerIdle) {
            this.emitStatusChanged()
        }

        const deliverServerWsFrame = (opcode: 'text' | 'binary', frameBody: Uint8Array) => {
            let muxBytes: Uint8Array
            try {
                muxBytes = encodeMuxFrame({ type: 'ws_data', connId, opcode }, frameBody)
            } catch {
                // Frame exceeds 64 MiB tunnel ceiling: close only this virtual connId
                entry.closedByPeer = true
                if (peer.wsStreams.get(connId) === entry) {
                    peer.wsStreams.delete(connId)
                }
                try {
                    localWs.close(1009, 'Message exceeds tunnel frame limit')
                } catch {}
                this.sendMuxToClient(epoch, clientUuid, {
                    type: 'ws_close',
                    connId,
                    code: 1009,
                    reason: 'Message exceeds tunnel frame limit',
                })
                return
            }

            if (
                epoch === this.connectionEpoch &&
                this.ws &&
                this.ws.readyState === WebSocket.OPEN
            ) {
                try {
                    const outer = encodeTunnelFrame(
                        CPA_TUNNEL_MUX_PAYLOAD_TYPE,
                        this.serverUuid,
                        clientUuid,
                        muxBytes,
                    )
                    this.ws.send(outer, { binary: true })
                } catch {}
            }
        }

        localWs.on('message', (data: RawData, isBinary: boolean) => {
            if (entry.closedByPeer || epoch !== this.connectionEpoch) return
            const frameBody = rawDataToUint8Array(data)
            const opcode: 'text' | 'binary' = isBinary ? 'binary' : 'text'
            if (!entry.openAckSent) {
                // Buffer copy so underlying ws buffer is not mutated before flush
                entry.preOpenServerFrames.push({ opcode, body: new Uint8Array(frameBody) })
                return
            }
            deliverServerWsFrame(opcode, frameBody)
        })

        localWs.once('open', () => {
            if (entry.settled || entry.closedByPeer || epoch !== this.connectionEpoch) {
                try {
                    localWs.close(1000)
                } catch {}
                return
            }
            this.sendMuxToClient(epoch, clientUuid, {
                type: 'ws_open_result',
                connId,
                ok: true,
            })
            entry.openAckSent = true

            // Strictly flush server-initiated greeting frames (e.g. hello) AFTER ws_open_result
            const bufferedServer = entry.preOpenServerFrames.splice(0)
            for (const item of bufferedServer) {
                deliverServerWsFrame(item.opcode, item.body)
            }

            const bufferedClient = entry.preOpenClientFrames.splice(0)
            for (const item of bufferedClient) {
                if (localWs.readyState === WebSocket.OPEN) {
                    localWs.send(item.body, { binary: item.opcode === 'binary' })
                }
            }
        })

        localWs.once('unexpected-response', (_req, res) => {
            if (entry.settled) return
            entry.settled = true
            if (peer.wsStreams.get(connId) === entry) {
                peer.wsStreams.delete(connId)
            }

            const statusCode = res.statusCode ?? 502
            const chunks: Buffer[] = []
            let total = 0
            res.on('data', (chunk: Buffer) => {
                if (total < 4096) {
                    chunks.push(chunk)
                    total += chunk.length
                }
            })
            const finishReject = () => {
                try {
                    res.destroy()
                } catch {}
                try {
                    localWs.terminate()
                } catch {}

                const bodyBuf = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0)
                const bodyBytes = new Uint8Array(
                    bodyBuf.buffer,
                    bodyBuf.byteOffset,
                    bodyBuf.byteLength,
                )
                this.sendMuxToClient(
                    epoch,
                    clientUuid,
                    {
                        type: 'ws_open_result',
                        connId,
                        ok: false,
                        status: statusCode,
                        error: `WebSocket upgrade rejected (${statusCode})`,
                        headers: normalizeNodeHeaders(res.headers),
                    },
                    bodyBytes,
                )
                if (
                    this.peers.get(clientUuid) === peer &&
                    peer.wsStreams.size === 0 &&
                    peer.inFlightHttp.size === 0
                ) {
                    this.peers.delete(clientUuid)
                    this.emitStatusChanged()
                }
            }
            res.once('end', finishReject)
            res.once('error', finishReject)
        })

        localWs.once('close', (code: number, reasonBuf: Buffer) => {
            if (entry.settled) return
            entry.settled = true
            if (peer.wsStreams.get(connId) === entry) {
                peer.wsStreams.delete(connId)
            }

            if (!entry.closedByPeer) {
                const reason = reasonBuf && reasonBuf.length > 0 ? reasonBuf.toString('utf8') : ''
                if (entry.openAckSent) {
                    this.sendMuxToClient(epoch, clientUuid, {
                        type: 'ws_close',
                        connId,
                        code: normalizeWsCloseCode(code),
                        reason: truncateWsCloseReason(reason),
                    })
                } else {
                    this.sendMuxToClient(epoch, clientUuid, {
                        type: 'ws_open_result',
                        connId,
                        ok: false,
                        status: 502,
                        error: reason || `Local WebSocket closed before open (${code})`,
                    })
                }
            }

            if (
                this.peers.get(clientUuid) === peer &&
                peer.wsStreams.size === 0 &&
                peer.inFlightHttp.size === 0
            ) {
                this.peers.delete(clientUuid)
                this.emitStatusChanged()
            }
        })

        localWs.on('error', () => {
            // Handled via unexpected-response or close
        })
    }

    private forwardClientWsData(
        clientUuid: string,
        connId: string,
        opcode: 'text' | 'binary',
        body: Uint8Array,
    ): void {
        const peer = this.peers.get(clientUuid)
        const entry = peer?.wsStreams.get(connId)
        if (!entry || entry.closedByPeer || entry.settled) return

        const isBinary = opcode === 'binary'
        if (!entry.openAckSent || entry.ws.readyState === WebSocket.CONNECTING) {
            entry.preOpenClientFrames.push({ opcode, body: new Uint8Array(body) })
            return
        }
        if (entry.ws.readyState === WebSocket.OPEN) {
            try {
                if (isBinary) {
                    entry.ws.send(body, { binary: true })
                } else {
                    entry.ws.send(textDecoder.decode(body))
                }
            } catch {
                // Ignore send errors on closing loopback socket
            }
        }
    }

    private closeClientWsStream(
        clientUuid: string,
        connId: string,
        code?: number,
        reason?: string,
    ): void {
        const peer = this.peers.get(clientUuid)
        const entry = peer?.wsStreams.get(connId)
        if (!entry) return

        entry.closedByPeer = true
        entry.settled = true
        peer!.wsStreams.delete(connId)

        try {
            if (entry.ws.readyState === WebSocket.OPEN) {
                entry.ws.close(normalizeWsCloseCode(code), truncateWsCloseReason(reason))
            } else {
                entry.ws.terminate()
            }
        } catch {
            try {
                entry.ws.terminate()
            } catch {}
        }

        if (peer!.wsStreams.size === 0 && peer!.inFlightHttp.size === 0) {
            this.peers.delete(clientUuid)
            this.emitStatusChanged()
        }
    }
}
