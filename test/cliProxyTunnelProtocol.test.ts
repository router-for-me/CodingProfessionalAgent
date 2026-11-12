import { describe, it, expect } from 'vitest'
import {
    TUNNEL_PROTOCOL_VERSION,
    CPA_TUNNEL_MUX_PAYLOAD_TYPE,
    CPA_TUNNEL_SERVER_TYPE,
    MAX_TUNNEL_RAW_PAYLOAD_BYTES,
    MAX_MUX_META_BYTES,
    MAX_HTTP_RESPONSE_BODY_BYTES,
    isValidTunnelUuid,
    resolveTunnelServerName,
    resolveTunnelServerType,
    resolveTunnelWebSocketUrl,
    encodeTunnelFrame,
    decodeTunnelFrame,
    encodeMuxFrame,
    decodeMuxFrame,
    validateHttpMethod,
    validateLoopbackPath,
    sanitizeLoopbackRequestHeaders,
    normalizeWsCloseCode,
    truncateWsCloseReason,
    redactSecret,
    type TunnelMuxMeta,
} from '../src/main/services/tunnel/tunnelProtocol.js'

describe('CLIProxyAPI Tunnel Protocol and Loopback Safety Helpers', () => {
    it('validates tunnel UUID printable non-whitespace ASCII rules (1..128 bytes)', () => {
        expect(isValidTunnelUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true)
        expect(isValidTunnelUuid('a')).toBe(true)
        expect(isValidTunnelUuid('x'.repeat(128))).toBe(true)

        expect(isValidTunnelUuid('')).toBe(false)
        expect(isValidTunnelUuid('x'.repeat(129))).toBe(false)
        expect(isValidTunnelUuid(' leading-space')).toBe(false)
        expect(isValidTunnelUuid('has space')).toBe(false)
        expect(isValidTunnelUuid('non-ascii-设备')).toBe(false)
        expect(isValidTunnelUuid('ctrl\x7fchar')).toBe(false)
        expect(isValidTunnelUuid(null)).toBe(false)
        expect(isValidTunnelUuid(123)).toBe(false)
    })

    it('encodes and decodes outer v0x01 tunnel binary frames', () => {
        expect(TUNNEL_PROTOCOL_VERSION).toBe(0x01)
        expect(CPA_TUNNEL_MUX_PAYLOAD_TYPE).toBe(0x02)
        expect(MAX_TUNNEL_RAW_PAYLOAD_BYTES).toBe(67_108_864)
        expect(MAX_MUX_META_BYTES).toBe(65_536)
        expect(MAX_HTTP_RESPONSE_BODY_BYTES).toBe(67_108_864 - 65_536)

        const payload = new Uint8Array([10, 20, 30, 40])
        const frame = encodeTunnelFrame(CPA_TUNNEL_MUX_PAYLOAD_TYPE, 'client-1', 'server-1', payload)
        expect(Array.from(frame.subarray(0, 4))).toEqual([0x01, 0x02, 8, 8])

        const decoded = decodeTunnelFrame(frame)
        expect(decoded.version).toBe(0x01)
        expect(decoded.payloadType).toBe(0x02)
        expect(decoded.srcUuid).toBe('client-1')
        expect(decoded.dstUuid).toBe('server-1')
        expect(Array.from(decoded.payload)).toEqual([10, 20, 30, 40])

        // Also supports zero-length raw payload
        const emptyDecoded = decodeTunnelFrame(
            encodeTunnelFrame(0x02, 'client-1', 'server-1', new Uint8Array(0)).buffer,
        )
        expect(emptyDecoded.payload.byteLength).toBe(0)

        // Reject malformed outer frames
        expect(() => decodeTunnelFrame(new Uint8Array([0x01, 0x02, 1]))).toThrow(/short/i)
        expect(() => decodeTunnelFrame(new Uint8Array([0x02, 0x02, 1, 1, 0x61, 0x62]))).toThrow(/version/i)
        expect(() => decodeTunnelFrame(new Uint8Array([0x01, 0x02, 0, 1, 0x61]))).toThrow(/header/i)
        expect(() => decodeTunnelFrame(new Uint8Array([0x01, 0x02, 4, 4, 0x61, 0x62]))).toThrow(/header/i)
        expect(() => decodeTunnelFrame(new Uint8Array([0x01, 0x02, 1, 1, 0x20, 0x62]))).toThrow(/uuid/i)
        expect(() => encodeTunnelFrame(0x02, 'bad uuid', 'server-1', payload)).toThrow(/srcUuid/i)
    })

    it('encodes and decodes inner PayloadType=0x02 3-part mux frames with zero-copy binary body', () => {
        const meta: TunnelMuxMeta = {
            type: 'http_response',
            id: 'req-42',
            status: 200,
            headers: {
                'content-type': 'image/png',
                'set-cookie': ['cpa_web_session=abc; HttpOnly; Path=/'],
            },
        }
        const binaryBody = new Uint8Array([0, 255, 128, 1])
        const muxBytes = encodeMuxFrame(meta, binaryBody)

        const view = new DataView(muxBytes.buffer, muxBytes.byteOffset, muxBytes.byteLength)
        const metaLen = view.getUint32(0, false)
        expect(metaLen).toBeGreaterThan(0)
        expect(muxBytes.byteLength).toBe(4 + metaLen + 4)

        const decoded = decodeMuxFrame(muxBytes)
        expect(decoded.meta).toEqual(meta)
        expect(Array.from(decoded.body)).toEqual([0, 255, 128, 1])

        // Reject 0 metaLen, >65536 metaLen, or truncated meta
        expect(() => decodeMuxFrame(new Uint8Array([0, 0, 0, 0]))).toThrow(/meta/i)
        expect(() => decodeMuxFrame(new Uint8Array([0, 2, 0, 0, 0x7b, 0x7d]))).toThrow(/meta/i)
        expect(() => decodeMuxFrame(new Uint8Array([0, 0, 0, 10, 0x7b, 0x7d]))).toThrow(/meta/i)
        expect(() => decodeMuxFrame(new Uint8Array([0, 0, 0, 2, 0x5b, 0x5d]))).toThrow(/meta/i)
    })

    it('normalizes baseUrl variants to ws(s) /v1/tunnel with role=server and type=CodingProfessionalAgent query', () => {
        expect(CPA_TUNNEL_SERVER_TYPE).toBe('CodingProfessionalAgent')
        expect(resolveTunnelWebSocketUrl('http://127.0.0.1:8317', 'u1', 'Mac')).toBe(
            'ws://127.0.0.1:8317/v1/tunnel?role=server&uuid=u1&name=Mac&type=CodingProfessionalAgent',
        )
        expect(resolveTunnelWebSocketUrl('https://proxy.example.com/v1/', 'u1', 'Mac')).toBe(
            'wss://proxy.example.com/v1/tunnel?role=server&uuid=u1&name=Mac&type=CodingProfessionalAgent',
        )
        expect(resolveTunnelWebSocketUrl('https://proxy.example.com/gateway/v1/tunnel', 'u1', 'Mac')).toBe(
            'wss://proxy.example.com/gateway/v1/tunnel?role=server&uuid=u1&name=Mac&type=CodingProfessionalAgent',
        )
        expect(resolveTunnelWebSocketUrl('ws://10.0.0.2:8317/subpath', 'u1', 'Mac Studio')).toBe(
            'ws://10.0.0.2:8317/subpath/v1/tunnel?role=server&uuid=u1&name=Mac+Studio&type=CodingProfessionalAgent',
        )
        expect(resolveTunnelWebSocketUrl('http://127.0.0.1:8317', 'u1', 'Mac', '   ')).toBe(
            'ws://127.0.0.1:8317/v1/tunnel?role=server&uuid=u1&name=Mac&type=CodingProfessionalAgent',
        )

        expect(() => resolveTunnelWebSocketUrl('', 'u1', 'Mac')).toThrow(/empty/i)
        expect(() => resolveTunnelWebSocketUrl('ftp://proxy.example.com', 'u1', 'Mac')).toThrow(/protocol/i)
        expect(() => resolveTunnelWebSocketUrl('http://user:pass@127.0.0.1:8317', 'u1', 'Mac')).toThrow(/credentials/i)
        expect(() => resolveTunnelWebSocketUrl('http://127.0.0.1:8317?foo=1', 'u1', 'Mac')).toThrow(/query/i)
        expect(() => resolveTunnelWebSocketUrl('http://127.0.0.1:8317#frag', 'u1', 'Mac')).toThrow(/hash/i)
    })

    it('sanitizes server name and server type within 256 UTF-8 bytes without splitting multi-byte code points', () => {
        expect(resolveTunnelServerName('  MacBook\x00-Pro\x1f\x7f\n  ')).toBe('MacBook-Pro')
        expect(resolveTunnelServerName('   \x00\t\r\n\u0085   ')).toBe('CPA-Server')

        const hundredHan = '机'.repeat(100) // 300 UTF-8 bytes
        const sanitized = resolveTunnelServerName(hundredHan)
        const encoded = new TextEncoder().encode(sanitized)
        expect(encoded.byteLength).toBeLessThanOrEqual(256)
        expect(encoded.byteLength).toBe(255)
        expect(sanitized).toBe('机'.repeat(85))
        expect(sanitized.includes('\uFFFD')).toBe(false)

        expect(resolveTunnelServerType()).toBe('CodingProfessionalAgent')
        expect(resolveTunnelServerType('')).toBe('CodingProfessionalAgent')
        expect(resolveTunnelServerType('   \x00\t\r\n\x7f\u0085   ')).toBe('CodingProfessionalAgent')
        expect(resolveTunnelServerType('  CodingProfessionalAgent\x00\x7f  ')).toBe(
            'CodingProfessionalAgent',
        )

        const hundredTypeHan = '型'.repeat(100) // 300 UTF-8 bytes
        const sanitizedType = resolveTunnelServerType(hundredTypeHan)
        const encodedType = new TextEncoder().encode(sanitizedType)
        expect(encodedType.byteLength).toBeLessThanOrEqual(256)
        expect(encodedType.byteLength).toBe(255)
        expect(sanitizedType).toBe('型'.repeat(85))
        expect(sanitizedType.includes('\uFFFD')).toBe(false)
    })

    it('blocks SSRF paths and strips hop-by-hop headers while injecting loopback Host/Origin and preserving Cookie', () => {
        const origin = 'http://127.0.0.1:54321'
        expect(validateLoopbackPath('/api/status?x=1', origin)?.href).toBe(
            'http://127.0.0.1:54321/api/status?x=1',
        )
        expect(validateLoopbackPath('http://evil.com/a', origin)).toBeNull()
        expect(validateLoopbackPath('//evil.com/a', origin)).toBeNull()
        expect(validateLoopbackPath('api/status', origin)).toBeNull()
        expect(validateLoopbackPath('/api/status\r\nX-Injected: 1', origin)).toBeNull()

        expect(validateHttpMethod(undefined)).toBe('GET')
        expect(validateHttpMethod('post')).toBe('POST')
        expect(validateHttpMethod('BAD METHOD')).toBeNull()
        expect(validateHttpMethod('GET\r\n')).toBeNull()
        expect(validateHttpMethod('')).toBeNull()
        expect(validateHttpMethod(123)).toBeNull()

        const sanitized = sanitizeLoopbackRequestHeaders(
            {
                Host: 'evil.example.com',
                Origin: 'https://evil.example.com',
                Connection: 'keep-alive, Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'Transfer-Encoding': 'chunked',
                'Content-Length': '999',
                'X-Forwarded-Proto': 'https',
                'X-Forwarded-For': '1.2.3.4',
                'X-Forwarded-Host': 'spoofed.example.com',
                Forwarded: 'for=1.2.3.4;proto=https',
                'X-Real-IP': '1.2.3.4',
                'bad header': 'space-in-token',
                'X-Bad-Ctl': 'val\x01bad',
                cookie: 'cpa_web_session=tok123',
                'Content-Type': 'application/json',
            },
            '127.0.0.1:54321',
            origin,
        )
        expect(sanitized).toEqual({
            cookie: 'cpa_web_session=tok123',
            'Content-Type': 'application/json',
            Host: '127.0.0.1:54321',
            Origin: 'http://127.0.0.1:54321',
        })
    })

    it('normalizes reserved WebSocket close codes (1005/1006 -> 1000, preserves 4401) and truncates UTF-8 close reason to <= 123 bytes', () => {
        expect(normalizeWsCloseCode(undefined)).toBe(1000)
        expect(normalizeWsCloseCode(1005)).toBe(1000)
        expect(normalizeWsCloseCode(1006)).toBe(1000)
        expect(normalizeWsCloseCode(1015)).toBe(1000)
        expect(normalizeWsCloseCode(999)).toBe(1000)
        expect(normalizeWsCloseCode(5000)).toBe(1000)
        expect(normalizeWsCloseCode(1000)).toBe(1000)
        expect(normalizeWsCloseCode(1001)).toBe(1001)
        expect(normalizeWsCloseCode(1008)).toBe(1008)
        expect(normalizeWsCloseCode(1009)).toBe(1009)
        expect(normalizeWsCloseCode(4401)).toBe(4401)

        const longReason = '未授权关闭原因-'.repeat(10)
        const truncated = truncateWsCloseReason(longReason)
        expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(123)
        expect(truncated.includes('\uFFFD')).toBe(false)

        expect(redactSecret('Failed with Bearer sk-secret-999 and sk-secret-999', 'sk-secret-999')).toBe(
            'Failed with Bearer [REDACTED] and [REDACTED]',
        )
    })
})
