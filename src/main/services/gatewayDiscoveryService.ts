import { Bonjour, type Service } from 'bonjour-service'
import type { DiscoveredGateway, GatewayDiscoveryService as IGatewayDiscoveryService } from '@cpa/plugin-api'

const DEFAULT_TIMEOUT_MS = 3000
const MAX_TIMEOUT_MS = 10000
const MAX_DISCOVERED = 256

/**
 * Standard operation routes for draft protocol tokens, mirroring the
 * protocolRoutes table in upstream CLIProxyAPI (draft-su-ai-gateway-
 * discovery-00). "version" is the versioned prefix below the mount path,
 * "suffix" the operation route below that prefix, and "legacyField" the
 * legacy TXT key that carried the versioned base path.
 */
const DRAFT_PROTOCOL_ROUTES: Record<string, { version: string; suffix: string; legacyField: string }> = Object.assign(
    Object.create(null) as Record<string, { version: string; suffix: string; legacyField: string }>,
    {
        'chat-completions': { version: '/v1', suffix: '/chat/completions', legacyField: 'api_openai' },
        completions: { version: '/v1', suffix: '/completions', legacyField: 'api_openai' },
        responses: { version: '/v1', suffix: '/responses', legacyField: 'api_openai' },
        'responses-ws': { version: '/v1', suffix: '/responses', legacyField: 'api_openai' },
        realtime: { version: '/v1', suffix: '/realtime', legacyField: 'api_openai' },
        images: { version: '/v1', suffix: '/images/generations', legacyField: 'api_openai' },
        videos: { version: '/v1', suffix: '/videos', legacyField: 'api_openai' },
        audio: { version: '/v1', suffix: '/audio/speech', legacyField: 'api_openai' },
        search: { version: '/v1', suffix: '/alpha/search', legacyField: 'api_openai' },
        messages: { version: '/v1', suffix: '/messages', legacyField: 'api_anthropic' },
        'count-tokens': { version: '/v1', suffix: '/messages/count_tokens', legacyField: 'api_anthropic' },
        'generate-content': { version: '/v1beta', suffix: '/models/{model}:generateContent', legacyField: 'api_gemini' },
        interactions: { version: '/v1beta', suffix: '/interactions', legacyField: 'api_gemini' },
    },
)

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
     * Keys are lowercased and the first occurrence of each key wins, matching
     * RFC 6763 Section 6.4 and the AI gateway discovery draft (the upstream
     * TXT decoder may already let later duplicates win, so duplicates are
     * also dropped here defensively).
     *
     * A bare draft version key is preserved as a presence marker: the TXT
     * decoder represents a bare "txtvers" as an undefined value and
     * "txtvers=" as a key literally named "txtvers=" (also with an
     * undefined value), which still proves a txtvers attribute was
     * advertised. Both spellings are normalised to the txtvers key with an
     * empty value that fails draft validation, ensuring such records are
     * never downgraded to legacy parsing. Legacy bare keys carry no routing
     * metadata and are still dropped.
     */
    parseTxtRecords(rawTxt: Record<string, string | Buffer | undefined>): Record<string, string> {
        const txtMap: Record<string, string> = {}
        for (const [k, v] of Object.entries(rawTxt || {})) {
            let key = k.toLowerCase()
            let value = v
            // Normalise the decoder's "txtvers=" key spelling (bare draft
            // version attribute with an explicit empty value).
            if (key === 'txtvers=' && (value === undefined || value === null)) {
                key = 'txtvers'
                value = ''
            }
            if (key in txtMap) continue
            if (value === undefined || value === null) {
                if (key === 'txtvers') txtMap[key] = ''
                continue
            }
            txtMap[key] = this.sanitizeText(typeof value === 'string' ? value : value.toString('utf-8'))
        }
        return txtMap
    }

    /**
     * Returns true when a TXT value is strictly printable ASCII (0x20-0x7e),
     * as required by the draft schema for validated attributes.
     */
    isPrintableTxtAscii(value: string): boolean {
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i)
            if (code < 0x20 || code > 0x7e) return false
        }
        return true
    }

    /**
     * Parses the draft boolean encoding, which accepts exactly "0" or "1".
     * Returns undefined for any other value.
     */
    parseDraftTxtFlag(value: string | undefined): boolean | undefined {
        if (value === '1') return true
        if (value === '0') return false
        return undefined
    }

    /**
     * Validates a draft TXT token (protocol or auth type). Tokens must be
     * non-empty lowercase ASCII letters, digits, hyphens, or underscores.
     */
    isValidTxtToken(token: string): boolean {
        if (!token) return false
        for (let i = 0; i < token.length; i++) {
            const code = token.charCodeAt(i)
            const ok =
                (code >= 0x61 && code <= 0x7a) ||
                (code >= 0x30 && code <= 0x39) ||
                code === 0x2d ||
                code === 0x5f
            if (!ok) return false
        }
        return true
    }

    /**
     * Splits a comma-separated TXT list, dropping empty entries. Unlike the
     * legacy parser, draft lists are not trimmed: upstream rejects any token
     * containing whitespace instead of normalising it.
     */
    splitTxtList(value: string | undefined, trim: boolean): string[] {
        if (!value) return []
        return value
            .split(',')
            .map((s) => (trim ? s.trim() : s))
            .filter(Boolean)
    }

    /**
     * Validates a draft mount path with the same rules as upstream
     * validateMountPath (RFC 3986 pchar segments): the root path "/" is
     * valid; other paths must start with "/", must not end with "/", may
     * only contain unreserved / sub-delim / ":" / "@" characters plus "/"
     * separators, and no segment may be empty, ".", or "..". Unlike the
     * legacy endpoint sanitizer, queries, fragments, escapes, and percent
     * encodings are rejected, while embedded dots such as "/a..b" are fine.
     * Returns the path when valid, otherwise an empty string.
     */
    validateMountPath(path: string): string {
        if (path === '/') return path
        if (path.length < 2 || !path.startsWith('/') || path.endsWith('/')) return ''
        for (let i = 0; i < path.length; i++) {
            const code = path.charCodeAt(i)
            const ok =
                (code >= 0x61 && code <= 0x7a) ||
                (code >= 0x41 && code <= 0x5a) ||
                (code >= 0x30 && code <= 0x39) ||
                "/-._~!$&'()*+,;=:@".includes(path[i])
            if (!ok) return ''
        }
        for (const segment of path.slice(1).split('/')) {
            if (segment === '' || segment === '.' || segment === '..') return ''
        }
        return path
    }

    /**
     * Joins a validated mount path with an operation route without producing
     * a double slash (the root path "/" contributes no prefix).
     */
    joinGatewayPath(mountPath: string, route: string): string {
        return mountPath === '/' ? route : `${mountPath}${route}`
    }

    /**
     * Parses raw TXT record dictionary into typed attributes and endpoints.
     *
     * Two schemas are supported, mirroring upstream CLIProxyAPI PR #7010
     * (draft-su-ai-gateway-discovery-00):
     * - Draft: selected whenever a "txtvers" key is present and validated
     *   strictly (version "1", 0/1 booleans, validated mount path). An
     *   invalid draft record is rejected outright (returns null) and never
     *   downgraded to legacy parsing.
     * - Legacy: the pre-draft CPA schema (version / auth_required /
     *   auth_methods / api_* base paths). Advertisements without any TXT
     *   records also take this path so bare services stay discoverable.
     */
    parseTxtRecordMap(rawTxt: Record<string, string | Buffer | undefined>) {
        const txtMap = this.parseTxtRecords(rawTxt)
        if ('txtvers' in txtMap) {
            return this.parseDraftTxtRecordMap(txtMap)
        }
        return this.parseLegacyTxtRecordMap(txtMap)
    }

    /**
     * Parses the draft-su-ai-gateway-discovery-00 TXT schema. Returns null
     * when the record is not a usable draft advertisement.
     */
    parseDraftTxtRecordMap(txtMap: Record<string, string>) {
        const validatedKeys = [
            'txtvers',
            'path',
            'tls',
            'auth',
            'protocols',
            'auth_type',
            'product',
            'id',
            'role',
        ] as const
        for (const key of validatedKeys) {
            const value = txtMap[key]
            if (value !== undefined && (value === '' || !this.isPrintableTxtAscii(value))) {
                return null
            }
        }

        const tlsFlag = this.parseDraftTxtFlag(txtMap['tls'])
        const authFlag = this.parseDraftTxtFlag(txtMap['auth'])
        // The mount path must satisfy the draft's RFC 3986 path rules; this
        // deliberately does not reuse the legacy endpoint sanitizer, whose
        // decode-based checks both accept queries/escapes and reject legal
        // embedded-dot segments.
        const mountPath = txtMap['path'] ? this.validateMountPath(txtMap['path']) : ''
        if (txtMap['txtvers'] !== '1' || tlsFlag === undefined || authFlag === undefined || !mountPath) {
            return null
        }

        for (const key of ['protocols', 'auth_type'] as const) {
            const value = txtMap[key]
            if (value !== undefined) {
                for (const token of value.split(',')) {
                    if (!this.isValidTxtToken(token)) return null
                }
            }
        }

        const endpoints: Record<string, string> = {}
        const protocols: string[] = []
        for (const token of this.splitTxtList(txtMap['protocols'], false)) {
            const route = DRAFT_PROTOCOL_ROUTES[token]
            if (!route) continue
            if (!protocols.includes(token)) protocols.push(token)
            endpoints[token] = this.joinGatewayPath(mountPath, `${route.version}${route.suffix}`)
        }
        const authMethods: string[] = []
        for (const token of this.splitTxtList(txtMap['auth_type'], false)) {
            if ((token === 'api_key' || token === 'oauth') && !authMethods.includes(token)) {
                authMethods.push(token)
            }
        }

        return {
            product: txtMap['product'] || 'generic',
            version: txtMap['txtvers'],
            isTls: tlsFlag,
            authRequired: authFlag,
            authMethods: authMethods.length > 0 ? authMethods : undefined,
            protocols: protocols.length > 0 ? protocols : undefined,
            features: undefined as string[] | undefined,
            endpoints,
            path: mountPath,
            instanceId: txtMap['id'] || undefined,
            nodeRole: txtMap['role'] || undefined,
            txtMap,
        }
    }

    /**
     * Parses the legacy (pre-draft) CPA TXT schema. Operation endpoints are
     * derived from the per-family api_* base paths when a protocol list was
     * advertised; without a protocol list only the base paths themselves are
     * exposed (keyed by their legacy TXT key), so no operation support is
     * inferred.
     */
    parseLegacyTxtRecordMap(txtMap: Record<string, string>) {
        const isTls = txtMap['tls'] === '1'
        const authRequired = txtMap['auth_required'] === 'true'
        const authMethods = txtMap['auth_methods']
            ? this.splitTxtList(txtMap['auth_methods'], true)
            : undefined
        const protocols = txtMap['protocols']
            ? this.splitTxtList(txtMap['protocols'], true)
            : undefined
        const features = txtMap['features']
            ? this.splitTxtList(txtMap['features'], true)
            : undefined

        // Operation-level endpoints use draft protocol tokens; the older
        // family tokens (openai / anthropic / gemini) map to each family's
        // primary operation for backward compatibility.
        const legacyFamilyTokens: Record<string, string> = {
            openai: 'chat-completions',
            anthropic: 'messages',
            gemini: 'generate-content',
        }
        const legacyBasePaths: Record<string, string> = {}
        for (const key of ['api_openai', 'api_anthropic', 'api_gemini'] as const) {
            const clean = txtMap[key] ? this.sanitizeEndpoint(txtMap[key]) : ''
            if (clean) legacyBasePaths[key] = clean
        }

        const endpoints: Record<string, string> = {}
        if (!txtMap['protocols']) {
            for (const [key, base] of Object.entries(legacyBasePaths)) {
                endpoints[key] = base
            }
        } else if (protocols) {
            const reported = new Set<string>()
            for (const rawToken of protocols) {
                const token = legacyFamilyTokens[rawToken] ?? rawToken
                const route = DRAFT_PROTOCOL_ROUTES[token]
                if (!route) continue
                const base = legacyBasePaths[route.legacyField]
                if (!base) continue
                endpoints[token] = this.joinGatewayPath(base, route.suffix)
                reported.add(token)
            }
            // Keep the type surface truthful: only report protocols that
            // resolved to an endpoint.
            return {
                product: txtMap['product'] || 'generic',
                version: txtMap['version'],
                isTls,
                authRequired,
                authMethods: authMethods && authMethods.length > 0 ? authMethods : undefined,
                protocols: reported.size > 0 ? [...reported] : undefined,
                features: features && features.length > 0 ? features : undefined,
                endpoints,
                path: undefined as string | undefined,
                instanceId: txtMap['instance_id'] || undefined,
                nodeRole: txtMap['node_role'] || undefined,
                txtMap,
            }
        }

        return {
            product: txtMap['product'] || 'generic',
            version: txtMap['version'],
            isTls,
            authRequired,
            authMethods: authMethods && authMethods.length > 0 ? authMethods : undefined,
            protocols,
            features,
            endpoints,
            path: undefined as string | undefined,
            instanceId: txtMap['instance_id'] || undefined,
            nodeRole: txtMap['node_role'] || undefined,
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
                    // An invalid draft advertisement (txtvers present but
                    // failing validation) is dropped, never downgraded.
                    if (!parsedTxt) return

                    const scheme = parsedTxt.isTls ? 'https' : 'http'
                    const formattedHost =
                        primaryAddress.includes(':') && !primaryAddress.startsWith('[')
                            ? `[${primaryAddress}]`
                            : primaryAddress
                    // Include the advertised mount path so gateways mounted
                    // below a non-root path route correctly. The root path
                    // "/" contributes no suffix.
                    const mountPathSuffix =
                        parsedTxt.path && parsedTxt.path !== '/' ? parsedTxt.path : ''
                    const baseUrl = `${scheme}://${formattedHost}:${port}${mountPathSuffix}`

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
                        path: parsedTxt.path,
                        tls: parsedTxt.isTls,
                        instanceId: parsedTxt.instanceId,
                        nodeRole: parsedTxt.nodeRole,
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
