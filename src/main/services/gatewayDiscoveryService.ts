import { Bonjour, type Service } from 'bonjour-service'
import type { DiscoveredGateway, GatewayDiscoveryService as IGatewayDiscoveryService } from '@cpa/plugin-api'

const DEFAULT_TIMEOUT_MS = 3000
const MAX_TIMEOUT_MS = 10000
const MAX_DISCOVERED = 256

export class GatewayDiscoveryService implements IGatewayDiscoveryService {
    /**
     * Sanitizes string by stripping Bidi control characters, isolate controls,
     * DEL, C1 controls, zero-width codes, and normalising control characters / tabs.
     */
    sanitizeText(value: string): string {
        if (!value) return ''
        let result = ''
        for (const char of value) {
            const code = char.codePointAt(0) ?? 0
            if (char === '\t' || char === '\0') {
                result += ' '
                continue
            }
            // Retain printable ASCII characters (0x20 to 0x7e)
            if (code >= 0x20 && code <= 0x7e) {
                result += char
            } else if (code > 0x7e) {
                // Reject DEL (0x7f), C1 controls (0x80-0x9f), Soft Hyphen (0x00ad),
                // Arabic Letter Mark (0x061c), Zero-width spaces / marks (0x200b-0x200f),
                // Line / Paragraph separators (0x2028-0x2029), Bidi overrides (0x202a-0x202e),
                // Bidi isolate controls (0x2066-0x2069), and BOM (0xfeff).
                if (
                    code === 0x7f ||
                    (code >= 0x80 && code <= 0x9f) ||
                    code === 0x00ad ||
                    code === 0x061c ||
                    (code >= 0x200b && code <= 0x200f) ||
                    (code >= 0x202a && code <= 0x202e) ||
                    code === 0x2028 ||
                    code === 0x2029 ||
                    (code >= 0x2066 && code <= 0x2069) ||
                    code === 0xfeff
                ) {
                    continue
                }
                result += char
            }
        }
        return result
    }

    /**
     * Strictly sanitizes API endpoint paths blocking protocol-relative URLs,
     * path traversals, percent-encoded attacks, backslashes, schemes, and non-root-slashed paths.
     */
    sanitizeEndpoint(path: string): string {
        if (!path || typeof path !== 'string') return ''

        // 1. Sanitize text first before prefix check so hidden control chars cannot produce '//'
        const cleaned = this.sanitizeText(path).trim()
        if (!cleaned || !cleaned.startsWith('/') || cleaned.includes('//')) {
            return ''
        }

        // 2. Reject if containing backslash, scheme, fragment, space, raw traversal, or explicit encoded dot
        if (
            cleaned.includes('\\') ||
            cleaned.includes('://') ||
            cleaned.includes('..') ||
            cleaned.includes('#') ||
            cleaned.includes(' ') ||
            /%2[eE]/i.test(cleaned)
        ) {
            return ''
        }

        // 3. Safely decode URI components to uncover percent-encoded traversals or bypasses
        let current = cleaned
        let previous = ''
        try {
            for (let i = 0; i < 3; i++) {
                previous = current
                current = decodeURIComponent(previous)
                // Block explicit or nested percent-encoded dot at any intermediate decoding layer
                if (/%2[eE]/i.test(current)) {
                    return ''
                }
                if (current === previous) break
            }
        } catch {
            return ''
        }

        // If after the decode loop current !== previous (i.e. still decoding after max rounds),
        // or if '%' still exists and could represent an encoded sequence, reject the path
        if (current !== previous || /%[0-9a-fA-F]{2}/i.test(current) || current.includes('%')) {
            return ''
        }

        // Ensure current cannot be decoded any further
        try {
            if (decodeURIComponent(current) !== current) {
                return ''
            }
        } catch {
            return ''
        }

        // 4. Verify decoded path meets strict safety constraints
        if (
            !current.startsWith('/') ||
            current.includes('//') ||
            current.includes('\\') ||
            current.includes('://') ||
            current.includes('..') ||
            current.includes('#') ||
            current.includes(' ')
        ) {
            return ''
        }

        // 5. Block explicit percent-encoded traversals
        if (/%2[eE]/i.test(cleaned) || /%2[eE]/i.test(current)) {
            return ''
        }

        return cleaned
    }

    /**
     * Selects the preferred primary IP address or hostname.
     * Prioritizes non-loopback IPv4, then routable IPv6 (Global Unicast and Unique Local),
     * then prefers host over unscoped link-local IPv6 (fe80::/10), then fallback.
     */
    selectPrimaryAddress(addresses: string[], host: string): string {
        const sanitizedHost = this.sanitizeText(host)
        if (!addresses || addresses.length === 0) {
            return sanitizedHost || '127.0.0.1'
        }

        const nonLoopbackIpv4 = addresses.filter(
            (ip) => !ip.startsWith('127.') && !ip.includes(':') && ip !== '0.0.0.0',
        )
        if (nonLoopbackIpv4.length > 0) {
            return nonLoopbackIpv4[0]
        }

        const isLinkLocalIpv6 = (ip: string) => {
            const trimmed = ip.trim()
            return /^fe[89ab]/i.test(trimmed)
        }

        const nonLoopbackIpv6 = addresses.filter(
            (ip) => ip !== '::1' && ip !== '::' && ip.includes(':'),
        )

        // Prioritize routable IPv6 (Global Unicast 2000::/3 and Unique Local fc00::/7 / fd00:...) over Link-Local
        const routableIpv6 = nonLoopbackIpv6.filter((ip) => !isLinkLocalIpv6(ip))
        if (routableIpv6.length > 0) {
            return routableIpv6[0]
        }

        // If the only IPv6 addresses available are link-local (fe80:...),
        // prefer the hostname so the system DNS/mDNS resolver can resolve on the appropriate interface.
        const linkLocalIpv6 = nonLoopbackIpv6.filter(isLinkLocalIpv6)
        if (linkLocalIpv6.length > 0) {
            if (sanitizedHost) {
                return sanitizedHost
            }
            return linkLocalIpv6[0]
        }

        return addresses[0]
    }

    /**
     * Parses raw TXT records into a key-value map with sanitized string values.
     */
    parseTxtRecords(rawTxt: Record<string, string | Buffer | undefined>): Record<string, string> {
        const txtMap: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawTxt || {})) {
            if (v !== undefined && v !== null) {
                txtMap[k.toLowerCase()] = this.sanitizeText(typeof v === 'string' ? v : v.toString('utf-8'))
            }
        }
        return txtMap
    }

    /**
     * Parses raw TXT record dictionary into typed attributes and endpoints.
     */
    parseTxtRecordMap(rawTxt: Record<string, string | Buffer | undefined>) {
        const txtMap = this.parseTxtRecords(rawTxt)

        const isTls = txtMap['tls'] === '1'
        const authRequired = txtMap['auth_required'] === 'true'
        const authMethods = txtMap['auth_methods']
            ? txtMap['auth_methods'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined
        const protocols = txtMap['protocols']
            ? txtMap['protocols'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined
        const features = txtMap['features']
            ? txtMap['features'].split(',').map((s) => s.trim()).filter(Boolean)
            : undefined

        const endpoints: Record<string, string> = {}
        if (txtMap['api_openai']) {
            const clean = this.sanitizeEndpoint(txtMap['api_openai'])
            if (clean) endpoints.openai = clean
        }
        if (txtMap['api_anthropic']) {
            const clean = this.sanitizeEndpoint(txtMap['api_anthropic'])
            if (clean) endpoints.anthropic = clean
        }
        if (txtMap['api_gemini']) {
            const clean = this.sanitizeEndpoint(txtMap['api_gemini'])
            if (clean) endpoints.gemini = clean
        }

        return {
            product: txtMap['product'] || 'generic',
            version: txtMap['version'],
            isTls,
            authRequired,
            authMethods,
            protocols,
            features,
            endpoints,
            txtMap,
        }
    }

    /**
     * Discovers AI Gateway instances on the local network via mDNS.
     */
    async discover(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<DiscoveredGateway[]> {
        const boundedTimeout = Math.min(Math.max(500, timeoutMs), MAX_TIMEOUT_MS)
        let bonjour: Bonjour | null = null

        return new Promise<DiscoveredGateway[]>((resolve) => {
            const discoveredMap = new Map<string, DiscoveredGateway>()
            let timer: NodeJS.Timeout | null = null
            let isFinished = false

            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer)
                    timer = null
                }
                if (bonjour) {
                    try {
                        bonjour.destroy()
                    } catch {
                        // Ignore cleanup error
                    }
                    bonjour = null
                }
            }

            const finish = () => {
                if (isFinished) return
                isFinished = true
                cleanup()
                // Prioritize CPA gateways, then standard AI gateways
                const list = Array.from(discoveredMap.values())
                list.sort((a, b) => {
                    const aIsCpa = a.product === 'cliproxyapi' ? 1 : 0
                    const bIsCpa = b.product === 'cliproxyapi' ? 1 : 0
                    return bIsCpa - aIsCpa
                })
                resolve(list)
            }

            try {
                const onMdnsError = () => {
                    finish()
                }

                bonjour = new Bonjour({}, onMdnsError)

                // Attach error listeners to underlying server / mdns if present
                const serverAny = (bonjour as unknown as { server?: { on?: Function; mdns?: { on?: Function } } }).server
                if (serverAny) {
                    if (typeof serverAny.on === 'function') {
                        serverAny.on('error', onMdnsError)
                    }
                    if (serverAny.mdns && typeof serverAny.mdns.on === 'function') {
                        serverAny.mdns.on('error', onMdnsError)
                    }
                }

                const browser = bonjour.find({ type: 'ai-gateway', protocol: 'tcp' }, (service: Service) => {
                    if (!service || !service.name) return

                    const port = service.port > 0 && service.port <= 65535 ? service.port : 8317
                    const addresses = (service.addresses || []).filter(Boolean)
                    const host = service.host || ''
                    const primaryAddress = this.selectPrimaryAddress(addresses, host)
                    const parsedTxt = this.parseTxtRecordMap(service.txt as Record<string, string | Buffer>)

                    const scheme = parsedTxt.isTls ? 'https' : 'http'
                    const formattedHost =
                        primaryAddress.includes(':') && !primaryAddress.startsWith('[')
                            ? `[${primaryAddress}]`
                            : primaryAddress
                    const baseUrl = `${scheme}://${formattedHost}:${port}`

                    const gateway: DiscoveredGateway = {
                        instanceName: this.sanitizeText(service.name),
                        host: this.sanitizeText(host),
                        port,
                        addresses,
                        primaryAddress,
                        baseUrl,
                        product: parsedTxt.product,
                        version: parsedTxt.version,
                        authRequired: parsedTxt.authRequired,
                        authMethods: parsedTxt.authMethods,
                        protocols: parsedTxt.protocols,
                        features: parsedTxt.features,
                        endpoints: parsedTxt.endpoints,
                        rawTxt: parsedTxt.txtMap,
                    }

                    const key = `${gateway.instanceName}:${gateway.host}:${gateway.port}`
                    if (!discoveredMap.has(key) && discoveredMap.size < MAX_DISCOVERED) {
                        discoveredMap.set(key, gateway)
                        if (discoveredMap.size >= MAX_DISCOVERED) {
                            finish()
                        }
                    }
                })

                if (browser && typeof (browser as unknown as NodeJS.EventEmitter).on === 'function') {
                    ;(browser as unknown as NodeJS.EventEmitter).on('error', onMdnsError)
                }

                timer = setTimeout(() => {
                    finish()
                }, boundedTimeout)
            } catch {
                finish()
            }
        })
    }
}
