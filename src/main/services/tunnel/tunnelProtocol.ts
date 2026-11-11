export const TUNNEL_PROTOCOL_VERSION = 0x01
export const CPA_TUNNEL_MUX_PAYLOAD_TYPE = 0x02
export const MAX_TUNNEL_RAW_PAYLOAD_BYTES = 67_108_864 // 64 MiB exact limit per CLIProxyAPI spec
export const MAX_MUX_META_BYTES = 65_536 // 64 KiB metadata ceiling
export const MAX_HTTP_RESPONSE_BODY_BYTES = MAX_TUNNEL_RAW_PAYLOAD_BYTES - MAX_MUX_META_BYTES

const textEncoder = new TextEncoder()
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface DecodedTunnelFrame {
    version: number
    payloadType: number
    srcUuid: string
    dstUuid: string
    payload: Uint8Array
}

export type TunnelHeaderMap = Record<string, string | string[]>

export type TunnelMuxMeta =
    | {
          type: 'http_request'
          id: string
          method: string
          path: string
          headers?: TunnelHeaderMap
      }
    | {
          type: 'http_response'
          id: string
          status: number
          headers?: TunnelHeaderMap
      }
    | {
          type: 'ws_open'
          connId: string
          path?: string
          headers?: TunnelHeaderMap
      }
    | {
          type: 'ws_open_result'
          connId: string
          ok: true
          headers?: TunnelHeaderMap
      }
    | {
          type: 'ws_open_result'
          connId: string
          ok: false
          status: number
          error?: string
          headers?: TunnelHeaderMap
      }
    | {
          type: 'ws_data'
          connId: string
          opcode: 'text' | 'binary'
      }
    | {
          type: 'ws_close'
          connId: string
          code?: number
          reason?: string
      }

export interface DecodedMuxFrame {
    meta: TunnelMuxMeta
    body: Uint8Array
}

const STRIPPED_LOOPBACK_HEADERS = new Set([
    'host',
    'origin',
    'connection',
    'upgrade',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'content-length',
    'forwarded',
    'x-real-ip',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-accept',
])

const HEADER_INJECTION_RE = /[\r\n\0]/
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const INVALID_HEADER_VALUE_CHAR_RE = /[^\t\x20-\x7e\x80-\xff]/

/**
 * Validates and normalizes an HTTP request method per RFC 7230 token grammar.
 * Returns null if the method is malformed (e.g. contains whitespace or control chars).
 */
export function validateHttpMethod(rawMethod: unknown): string | null {
    if (rawMethod === undefined) {
        return 'GET'
    }
    if (typeof rawMethod !== 'string') {
        return null
    }
    if (rawMethod.length < 1 || rawMethod.length > 32 || !HTTP_TOKEN_RE.test(rawMethod)) {
        return null
    }
    return rawMethod.toUpperCase()
}

/**
 * Validates whether a string is a legal CLIProxyAPI tunnel device UUID:
 * 1..128 printable non-whitespace ASCII bytes (0x21..0x7E) with no leading/trailing spaces.
 */
export function isValidTunnelUuid(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false
    }
    if (value.length < 1 || value.length > 128) {
        return false
    }
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        if (code < 0x21 || code > 0x7e) {
            return false
        }
    }
    return true
}

function isValidAsciiUuidBytes(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 1 || bytes.byteLength > 128) {
        return false
    }
    for (let i = 0; i < bytes.byteLength; i++) {
        const b = bytes[i]!
        if (b < 0x21 || b > 0x7e) {
            return false
        }
    }
    return true
}

function truncateUtf8ByCodePoints(input: string, maxBytes: number): string {
    let totalBytes = 0
    let endIndex = 0
    for (const ch of input) {
        const chBytes = textEncoder.encode(ch).byteLength
        if (totalBytes + chBytes > maxBytes) {
            break
        }
        totalBytes += chBytes
        endIndex += ch.length
    }
    return input.slice(0, endIndex)
}

/**
 * Sanitizes a raw OS hostname into a valid CLIProxyAPI tunnel server name:
 * removes ASCII control characters (0x00..0x1F, 0x7F), trims whitespace,
 * truncates cleanly at UTF-8 code-point boundaries to <= 256 bytes, and falls back to 'CPA-Server'.
 */
export function resolveTunnelServerName(rawHostname: string): string {
    const cleaned = String(rawHostname ?? '')
        .replace(/[\x00-\x1f\x7f]+/g, '')
        .trim()
    if (!cleaned) {
        return 'CPA-Server'
    }
    const truncated = truncateUtf8ByCodePoints(cleaned, 256).trim()
    return truncated || 'CPA-Server'
}

/**
 * Normalizes a CLIProxyAPI base URL to a ws:// or wss:// /v1/tunnel endpoint with server identity query parameters.
 */
export function resolveTunnelWebSocketUrl(
    baseUrl: string,
    serverUuid: string,
    serverName: string,
): string {
    const trimmed = String(baseUrl ?? '').trim()
    if (!trimmed) {
        throw new Error('Base URL is empty')
    }
    if (!isValidTunnelUuid(serverUuid)) {
        throw new Error('Invalid server UUID')
    }

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        throw new Error(`Invalid base URL: ${trimmed}`)
    }

    let wsProtocol: string
    if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') {
        wsProtocol = 'ws:'
    } else if (parsed.protocol === 'https:' || parsed.protocol === 'wss:') {
        wsProtocol = 'wss:'
    } else {
        throw new Error(`Unsupported base URL protocol: ${parsed.protocol}`)
    }

    if (parsed.username || parsed.password) {
        throw new Error('Base URL must not include credentials')
    }
    if (parsed.search) {
        throw new Error('Base URL must not include query parameters')
    }
    if (parsed.hash) {
        throw new Error('Base URL must not include hash fragments')
    }

    let pathname = (parsed.pathname || '').replace(/\/+$/, '')
    if (pathname.endsWith('/v1/tunnel')) {
        // Keep existing /v1/tunnel suffix as-is
    } else if (pathname.endsWith('/v1')) {
        pathname = `${pathname.slice(0, -3)}/v1/tunnel`
    } else {
        pathname = `${pathname}/v1/tunnel`
    }

    const params = new URLSearchParams({
        role: 'server',
        uuid: serverUuid,
        name: resolveTunnelServerName(serverName),
    })

    return `${wsProtocol}//${parsed.host}${pathname}?${params.toString()}`
}

/**
 * Encodes an outer CLIProxyAPI tunnel binary packet (Version 0x01).
 */
export function encodeTunnelFrame(
    payloadType: number,
    srcUuid: string,
    dstUuid: string,
    payload: Uint8Array,
): Uint8Array {
    if (!isValidTunnelUuid(srcUuid)) {
        throw new Error('Invalid srcUuid')
    }
    if (!isValidTunnelUuid(dstUuid)) {
        throw new Error('Invalid dstUuid')
    }
    if (payload.byteLength > MAX_TUNNEL_RAW_PAYLOAD_BYTES) {
        throw new RangeError('Tunnel payload exceeds 64 MiB maximum frame limit')
    }

    const srcBytes = textEncoder.encode(srcUuid)
    const dstBytes = textEncoder.encode(dstUuid)
    const frame = new Uint8Array(4 + srcBytes.byteLength + dstBytes.byteLength + payload.byteLength)
    frame[0] = TUNNEL_PROTOCOL_VERSION
    frame[1] = payloadType & 0xff
    frame[2] = srcBytes.byteLength
    frame[3] = dstBytes.byteLength
    frame.set(srcBytes, 4)
    frame.set(dstBytes, 4 + srcBytes.byteLength)
    frame.set(payload, 4 + srcBytes.byteLength + dstBytes.byteLength)
    return frame
}

/**
 * Decodes an outer CLIProxyAPI tunnel binary packet (Version 0x01) using zero-copy subarray slicing.
 */
export function decodeTunnelFrame(raw: ArrayBuffer | Uint8Array): DecodedTunnelFrame {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    if (bytes.byteLength < 4) {
        throw new Error('Binary frame shorter than 4-byte tunnel header')
    }
    const version = bytes[0]!
    if (version !== TUNNEL_PROTOCOL_VERSION) {
        throw new Error(`Unsupported tunnel protocol version: ${version}`)
    }
    const payloadType = bytes[1]!
    const srcLen = bytes[2]!
    const dstLen = bytes[3]!
    const headerLen = 4 + srcLen + dstLen
    if (srcLen < 1 || srcLen > 128 || dstLen < 1 || dstLen > 128 || bytes.byteLength < headerLen) {
        throw new Error('Malformed tunnel packet header lengths')
    }

    const srcBytes = bytes.subarray(4, 4 + srcLen)
    const dstBytes = bytes.subarray(4 + srcLen, headerLen)
    if (!isValidAsciiUuidBytes(srcBytes) || !isValidAsciiUuidBytes(dstBytes)) {
        throw new Error('Invalid non-printable or whitespace bytes in tunnel UUID')
    }

    return {
        version,
        payloadType,
        srcUuid: strictUtf8Decoder.decode(srcBytes),
        dstUuid: strictUtf8Decoder.decode(dstBytes),
        payload: bytes.subarray(headerLen),
    }
}

/**
 * Encodes an inner PayloadType=0x02 3-part mux frame: [MetaLen: uint32 BE][MetaJSON][Body].
 */
export function encodeMuxFrame(meta: TunnelMuxMeta, body?: Uint8Array): Uint8Array {
    const metaBytes = textEncoder.encode(JSON.stringify(meta))
    if (metaBytes.byteLength < 1 || metaBytes.byteLength > MAX_MUX_META_BYTES) {
        throw new RangeError(`Mux metadata length ${metaBytes.byteLength} out of bounds (1..${MAX_MUX_META_BYTES})`)
    }
    const rawBody = body ?? new Uint8Array(0)
    const totalLen = 4 + metaBytes.byteLength + rawBody.byteLength
    if (totalLen > MAX_TUNNEL_RAW_PAYLOAD_BYTES) {
        throw new RangeError('Encoded mux frame exceeds 64 MiB tunnel raw payload limit')
    }

    const out = new Uint8Array(totalLen)
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    view.setUint32(0, metaBytes.byteLength, false)
    out.set(metaBytes, 4)
    if (rawBody.byteLength > 0) {
        out.set(rawBody, 4 + metaBytes.byteLength)
    }
    return out
}

/**
 * Decodes an inner PayloadType=0x02 3-part mux frame with zero-copy body subarray slicing.
 */
export function decodeMuxFrame(rawPayload: Uint8Array): DecodedMuxFrame {
    if (rawPayload.byteLength < 5) {
        throw new Error('Mux payload shorter than minimum meta header')
    }
    const view = new DataView(rawPayload.buffer, rawPayload.byteOffset, rawPayload.byteLength)
    const metaLen = view.getUint32(0, false)
    if (metaLen < 1 || metaLen > MAX_MUX_META_BYTES || 4 + metaLen > rawPayload.byteLength) {
        throw new Error(`Invalid mux meta length: ${metaLen}`)
    }

    const metaSlice = rawPayload.subarray(4, 4 + metaLen)
    const metaJson = strictUtf8Decoder.decode(metaSlice)
    const parsed = JSON.parse(metaJson) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Mux meta must be a JSON object')
    }
    const typeField = (parsed as { type?: unknown }).type
    if (typeof typeField !== 'string' || !typeField) {
        throw new Error('Mux meta missing string type')
    }

    return {
        meta: parsed as TunnelMuxMeta,
        body: rawPayload.subarray(4 + metaLen),
    }
}

/**
 * Validates a relative HTTP/WS request path against the local loopback origin to block SSRF and header injection.
 */
export function validateLoopbackPath(rawPath: string, loopbackOrigin: string): URL | null {
    if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//')) {
        return null
    }
    if (HEADER_INJECTION_RE.test(rawPath)) {
        return null
    }
    try {
        const expectedOrigin = new URL(loopbackOrigin).origin
        const resolved = new URL(rawPath, expectedOrigin)
        if (resolved.origin !== expectedOrigin) {
            return null
        }
        return resolved
    } catch {
        return null
    }
}

/**
 * Strips hop-by-hop and WebSocket handshake headers while injecting trusted loopback Host and Origin headers.
 */
export function sanitizeLoopbackRequestHeaders(
    headers: TunnelHeaderMap | undefined,
    loopbackHost: string,
    loopbackOrigin: string,
): TunnelHeaderMap {
    const clean: TunnelHeaderMap = {}
    if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
            if (!key || typeof key !== 'string') continue
            const trimmedKey = key.trim()
            if (!trimmedKey || !HTTP_TOKEN_RE.test(trimmedKey)) continue
            const lower = trimmedKey.toLowerCase()
            if (STRIPPED_LOOPBACK_HEADERS.has(lower) || lower.startsWith('x-forwarded-')) {
                continue
            }
            if (typeof value === 'string') {
                if (INVALID_HEADER_VALUE_CHAR_RE.test(value)) continue
                clean[trimmedKey] = value
            } else if (Array.isArray(value)) {
                const filtered = value.filter(
                    (item): item is string =>
                        typeof item === 'string' && !INVALID_HEADER_VALUE_CHAR_RE.test(item),
                )
                if (filtered.length > 0) {
                    clean[trimmedKey] = filtered
                }
            }
        }
    }
    clean.Host = loopbackHost
    clean.Origin = loopbackOrigin
    return clean
}

/**
 * Normalizes a WebSocket close code to RFC 6455 sendable codes (maps reserved pseudo-codes like 1005/1006 to 1000).
 */
export function normalizeWsCloseCode(code?: number): number {
    if (typeof code !== 'number' || !Number.isInteger(code)) {
        return 1000
    }
    if (code >= 3000 && code <= 4999) {
        return code
    }
    if (
        code === 1000 ||
        code === 1001 ||
        code === 1002 ||
        code === 1003 ||
        (code >= 1007 && code <= 1011)
    ) {
        return code
    }
    return 1000
}

/**
 * Truncates a WebSocket close reason to <= 123 UTF-8 bytes per RFC 6455 control frame limit.
 */
export function truncateWsCloseReason(reason?: string): string {
    if (typeof reason !== 'string' || !reason) {
        return ''
    }
    const singleLine = reason.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
    return truncateUtf8ByCodePoints(singleLine, 123)
}

/**
 * Redacts all literal and URI-encoded occurrences of a secret from an error/status message.
 */
export function redactSecret(input: string, secret?: string): string {
    if (typeof input !== 'string' || !input) {
        return ''
    }
    const rawSecret = typeof secret === 'string' ? secret.trim() : ''
    if (!rawSecret) {
        return input
    }
    let output = input.split(rawSecret).join('[REDACTED]')
    const encoded = encodeURIComponent(rawSecret)
    if (encoded && encoded !== rawSecret) {
        output = output.split(encoded).join('[REDACTED]')
    }
    return output
}
