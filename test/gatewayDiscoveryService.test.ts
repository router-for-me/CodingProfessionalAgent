import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Service } from 'bonjour-service'

// Shared mock state for bonjour-service
const mockDestroy = vi.fn()
let mockBrowser: EventEmitter & { stop?: () => void }
let mockOnUpCallback: ((service: Service) => void) | undefined
let mockMdns: EventEmitter
let mockServer: { mdns: EventEmitter }
let shouldThrowInConstructor = false
let shouldThrowInDestroy = false

vi.mock('bonjour-service', () => {
    return {
        Bonjour: class MockBonjour {
            server: { mdns: EventEmitter }
            constructor(_opts?: unknown, _errorCallback?: (err: unknown) => void) {
                if (shouldThrowInConstructor) {
                    throw new Error('Constructor failure')
                }
                mockMdns = new EventEmitter()
                mockServer = { mdns: mockMdns }
                this.server = mockServer
            }
            find(_opts: unknown, onup: (service: Service) => void) {
                mockOnUpCallback = onup
                mockBrowser = new EventEmitter()
                return mockBrowser
            }
            destroy() {
                if (shouldThrowInDestroy) {
                    throw new Error('Destroy failure')
                }
                mockDestroy()
            }
        },
    }
})

import { GatewayDiscoveryService } from '../src/main/services/gatewayDiscoveryService.js'

describe('GatewayDiscoveryService', () => {
    let service: GatewayDiscoveryService

    beforeEach(() => {
        vi.clearAllMocks()
        mockOnUpCallback = undefined
        shouldThrowInConstructor = false
        shouldThrowInDestroy = false
        service = new GatewayDiscoveryService()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('sanitizes text removing control characters, DEL, C1 controls, and Bidi overrides/isolates', () => {
        // Tab and null to space, Bidi override \u202E removed
        const raw = 'CPA\u202E\u0000Instance\t#1'
        expect(service.sanitizeText(raw)).toBe('CPA Instance #1')

        // DEL (0x7f) and C1 controls (0x80 - 0x9f)
        expect(service.sanitizeText('Hello\x7fWorld')).toBe('HelloWorld')
        expect(service.sanitizeText('Hello\x80\x85\x9fWorld')).toBe('HelloWorld')

        // U+061C (Arabic letter mark)
        expect(service.sanitizeText('Test\u061CName')).toBe('TestName')

        // U+2066 - U+2069 (Bidi isolate controls: LRI, RLI, FSI, PDI)
        expect(service.sanitizeText('A\u2066B\u2067C\u2068D\u2069E')).toBe('ABCDE')

        // U+202A - U+202E (Bidi overrides/embeddings)
        expect(service.sanitizeText('A\u202AB\u202BB\u202CB\u202DB\u202EE')).toBe('ABBBBE')

        // U+200B - U+200F (Zero width spaces / marks)
        expect(service.sanitizeText('Zero\u200B\u200C\u200D\u200E\u200FWidth')).toBe('ZeroWidth')

        // Preserves Chinese characters and emojis
        expect(service.sanitizeText('网关🤖 Gateway')).toBe('网关🤖 Gateway')
    })

    it('sanitizes endpoint paths strictly blocking protocol-relative, traversals, and evasions', () => {
        expect(service.sanitizeEndpoint('/v1')).toBe('/v1')
        expect(service.sanitizeEndpoint('//evil.com/v1')).toBe('')
        expect(service.sanitizeEndpoint('\\evil/v1')).toBe('')
        expect(service.sanitizeEndpoint('https://evil.com/v1')).toBe('')
        expect(service.sanitizeEndpoint('/v1/../v2')).toBe('')
        expect(service.sanitizeEndpoint('v1')).toBe('')

        // Hidden character and prefix evasion tests
        expect(service.sanitizeEndpoint('/\n/evil.com')).toBe('')
        expect(service.sanitizeEndpoint('/\r/evil.com')).toBe('')
        expect(service.sanitizeEndpoint('/\x7f/evil.com')).toBe('')
        expect(service.sanitizeEndpoint('/ /evil.com')).toBe('')
        expect(service.sanitizeEndpoint('/v1#frag')).toBe('')

        // Percent-encoded traversals
        expect(service.sanitizeEndpoint('%2e%2e')).toBe('')
        expect(service.sanitizeEndpoint('/%2e%2e')).toBe('')
        expect(service.sanitizeEndpoint('/%2E%2E')).toBe('')
        expect(service.sanitizeEndpoint('/%2e%2e/v1')).toBe('')
        expect(service.sanitizeEndpoint('/v1/%2e%2e/v2')).toBe('')
        expect(service.sanitizeEndpoint('/v1/%2E%2E/v2')).toBe('')
        expect(service.sanitizeEndpoint('/%2f/evil.com')).toBe('')
        expect(service.sanitizeEndpoint('/%5c/evil.com')).toBe('')

        // Multi-layer percent-encoded traversals
        expect(service.sanitizeEndpoint('/v1/%2525252e%2525252e/v2')).toBe('')
        expect(service.sanitizeEndpoint('/v1/%25252e%25252e/v2')).toBe('')
        expect(service.sanitizeEndpoint('/v1/%252e%252e/v2')).toBe('')
        expect(service.sanitizeEndpoint('/v1/%252525252e%252525252e/v2')).toBe('')
    })

    it('selects preferred primary address avoiding loopback when alternatives exist', () => {
        const addrs = ['127.0.0.1', '192.168.1.120', '10.0.0.5']
        expect(service.selectPrimaryAddress(addrs, 'my-mac.local')).toBe('192.168.1.120')

        expect(service.selectPrimaryAddress(['127.0.0.1'], 'my-mac.local')).toBe('127.0.0.1')
        expect(service.selectPrimaryAddress([], 'my-mac.local')).toBe('my-mac.local')
    })

    it('parses TXT records correctly with types and flags', () => {
        const rawTxt: Record<string, string | Buffer> = {
            version: '1',
            product: 'cliproxyapi',
            tls: '0',
            auth_required: 'true',
            auth_methods: 'api_key',
            protocols: 'openai,anthropic,gemini',
            api_openai: '/v1',
            api_anthropic: '/v1',
        }
        const parsed = service.parseTxtRecordMap(rawTxt)
        expect(parsed.product).toBe('cliproxyapi')
        expect(parsed.authRequired).toBe(true)
        expect(parsed.authMethods).toEqual(['api_key'])
        expect(parsed.protocols).toEqual(['openai', 'anthropic', 'gemini'])
        expect(parsed.endpoints.openai).toBe('/v1')
    })

    it('parses TXT records with Buffer values and handles tls=1', () => {
        const rawTxt: Record<string, string | Buffer> = {
            VERSION: Buffer.from('2.0.0'),
            PRODUCT: 'cliproxyapi',
            TLS: '1',
            AUTH_REQUIRED: Buffer.from('false'),
            FEATURES: 'chat,responses',
            API_GEMINI: '/v1beta',
        }
        const parsed = service.parseTxtRecordMap(rawTxt)
        expect(parsed.product).toBe('cliproxyapi')
        expect(parsed.version).toBe('2.0.0')
        expect(parsed.isTls).toBe(true)
        expect(parsed.authRequired).toBe(false)
        expect(parsed.features).toEqual(['chat', 'responses'])
        expect(parsed.endpoints.gemini).toBe('/v1beta')
    })

    it('parseTxtRecords returns key-value string dictionary with lowercased keys', () => {
        const rawTxt = {
            Foo_Bar: 'Baz',
            KEY2: Buffer.from('value2'),
        }
        const records = service.parseTxtRecords(rawTxt)
        expect(records).toEqual({
            foo_bar: 'Baz',
            key2: 'value2',
        })
    })

    it('prioritizes routable IPv6 over link-local fe80 addresses', () => {
        // Unique Local (fd00::/8) vs Link-Local (fe80::/10)
        expect(service.selectPrimaryAddress(['fe80::1', 'fd00::1'], 'my-host.local')).toBe('fd00::1')
        // Global Unicast (2000::/3) vs Link-Local
        expect(service.selectPrimaryAddress(['fe80::1', '2001:db8::1'], 'my-host.local')).toBe('2001:db8::1')
        // Mixed with loopback IPv4 and multiple IPv6
        expect(service.selectPrimaryAddress(['127.0.0.1', 'fe80::200', 'fc00::abc', '::1'], 'my-host.local')).toBe('fc00::abc')
    })

    it('prefers host name over unscoped link-local fe80 IPv6 when host is provided', () => {
        const addrs = ['127.0.0.1', 'fe80::1', '::1']
        expect(service.selectPrimaryAddress(addrs, 'my-host.local')).toBe('my-host.local')
        expect(service.selectPrimaryAddress(['fe80::1'], 'ai-gateway.local')).toBe('ai-gateway.local')
    })

    it('falls back to fe80 link-local address when only link-local is available and host is empty', () => {
        const addrs = ['127.0.0.1', 'fe80::1', '::1']
        expect(service.selectPrimaryAddress(addrs, '')).toBe('fe80::1')
        expect(service.selectPrimaryAddress(['fe80::1'], '')).toBe('fe80::1')
    })

    it('falls back to 127.0.0.1 when both addresses and host are empty', () => {
        expect(service.selectPrimaryAddress([], '')).toBe('127.0.0.1')
    })

    it('discovers gateways, prioritizes cliproxyapi, and resolves after timeout', async () => {
        vi.useFakeTimers()

        const discoverPromise = service.discover(1000)

        // Simulate two discovered services: one generic, one cliproxyapi
        mockOnUpCallback?.({
            name: 'Generic Gateway',
            host: 'generic.local',
            port: 9000,
            addresses: ['192.168.1.50'],
            txt: {
                product: 'other-gateway',
                version: '0.9.0',
                auth_required: 'false',
                protocols: 'openai',
            },
        } as unknown as Service)

        mockOnUpCallback?.({
            name: 'CPA Primary',
            host: 'cpa.local',
            port: 8317,
            addresses: ['192.168.1.100'],
            txt: {
                product: 'cliproxyapi',
                version: '1.5.0',
                tls: '1',
                auth_required: 'true',
                auth_methods: 'api_key',
                protocols: 'openai,anthropic',
                api_openai: '/v1',
            },
        } as unknown as Service)

        // Advance timers to trigger discovery finish
        await vi.advanceTimersByTimeAsync(1000)
        const results = await discoverPromise

        expect(results).toHaveLength(2)
        // cliproxyapi should be sorted first
        expect(results[0].product).toBe('cliproxyapi')
        expect(results[0].instanceName).toBe('CPA Primary')
        expect(results[0].baseUrl).toBe('https://192.168.1.100:8317')
        expect(results[0].authRequired).toBe(true)
        expect(results[0].endpoints?.openai).toBe('/v1')

        expect(results[1].product).toBe('other-gateway')
        expect(results[1].instanceName).toBe('Generic Gateway')
        expect(results[1].baseUrl).toBe('http://192.168.1.50:9000')

        expect(mockDestroy).toHaveBeenCalled()
    })

    it('deduplicates gateways by instanceName, host, and port', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(1000)

        const serviceData = {
            name: 'CPA Server',
            host: 'cpa.local',
            port: 8317,
            addresses: ['192.168.1.100'],
            txt: { product: 'cliproxyapi' },
        } as unknown as Service

        mockOnUpCallback?.(serviceData)
        mockOnUpCallback?.(serviceData) // duplicate broadcast

        await vi.advanceTimersByTimeAsync(1000)
        const results = await discoverPromise

        expect(results).toHaveLength(1)
    })

    it('formats IPv6 primaryAddress with square brackets so new URL(baseUrl) is valid', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(1000)

        mockOnUpCallback?.({
            name: 'IPv6 Gateway',
            host: 'ipv6.local',
            port: 8317,
            addresses: ['fd00::1'],
            txt: { product: 'cliproxyapi' },
        } as unknown as Service)

        await vi.advanceTimersByTimeAsync(1000)
        const results = await discoverPromise

        expect(results).toHaveLength(1)
        expect(results[0].primaryAddress).toBe('fd00::1')
        expect(results[0].baseUrl).toBe('http://[fd00::1]:8317')
        expect(() => new URL(results[0].baseUrl)).not.toThrow()
        const parsedUrl = new URL(results[0].baseUrl)
        expect(parsedUrl.hostname).toBe('[fd00::1]')
        expect(parsedUrl.port).toBe('8317')
    })

    it('prefers host in discovery when only link-local fe80 IPv6 is available', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(1000)

        mockOnUpCallback?.({
            name: 'Link-Local Gateway',
            host: 'gateway.local',
            port: 8317,
            addresses: ['fe80::1'],
            txt: { product: 'cliproxyapi' },
        } as unknown as Service)

        await vi.advanceTimersByTimeAsync(1000)
        const results = await discoverPromise

        expect(results).toHaveLength(1)
        expect(results[0].primaryAddress).toBe('gateway.local')
        expect(results[0].baseUrl).toBe('http://gateway.local:8317')
    })

    it('handles underlying server.mdns error event without crashing main process', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(3000)

        mockOnUpCallback?.({
            name: 'CPA Socket',
            host: 'socket.local',
            port: 8317,
            addresses: ['192.168.1.15'],
            txt: { product: 'cliproxyapi' },
        } as unknown as Service)

        // Trigger error event on underlying server.mdns EventEmitter
        mockMdns.emit('error', new Error('mDNS UDP bind error'))

        const results = await discoverPromise
        expect(results).toHaveLength(1)
        expect(results[0].instanceName).toBe('CPA Socket')
        expect(mockDestroy).toHaveBeenCalled()
    })

    it('handles Bonjour initialization error gracefully without crashing', async () => {
        shouldThrowInConstructor = true
        const results = await service.discover(1000)
        expect(results).toEqual([])
    })

    it('handles Bonjour destroy failure cleanly without throwing uncaught error', async () => {
        shouldThrowInDestroy = true
        vi.useFakeTimers()
        const discoverPromise = service.discover(1000)

        await vi.advanceTimersByTimeAsync(1000)
        await expect(discoverPromise).resolves.toEqual([])
    })

    it('defaults invalid ports to 8317', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(500)

        mockOnUpCallback?.({
            name: 'Zero Port Gateway',
            host: 'zero.local',
            port: 0,
            addresses: ['192.168.1.20'],
            txt: {},
        } as unknown as Service)

        await vi.advanceTimersByTimeAsync(500)
        const results = await discoverPromise

        expect(results).toHaveLength(1)
        expect(results[0].port).toBe(8317)
        expect(results[0].baseUrl).toBe('http://192.168.1.20:8317')
    })

    it('caps discovered gateways at MAX_DISCOVERED (256)', async () => {
        vi.useFakeTimers()
        const discoverPromise = service.discover(5000)

        // Emit 300 unique services
        for (let i = 0; i < 300; i++) {
            mockOnUpCallback?.({
                name: `Gateway ${i}`,
                host: `host-${i}.local`,
                port: 8000 + i,
                addresses: [`192.168.1.${(i % 250) + 1}`],
                txt: { product: 'generic' },
            } as unknown as Service)
        }

        const results = await discoverPromise
        expect(results).toHaveLength(256)
        expect(mockDestroy).toHaveBeenCalled()
    })
})
