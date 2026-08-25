/**
 * Canonicalize an HTTP(S) CLIProxyAPI base URL.
 * - trims whitespace
 * - rejects credentials, query, and hash
 * - normalizes trailing slash on the path (root stays empty)
 * - preserves a valid base path (e.g. /v1, /backend-api)
 */
export function canonicalizeBaseUrl(raw: string): string {
    const trimmed = (raw ?? '').trim()
    if (!trimmed) {
        throw new Error('Base URL is empty')
    }
    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        throw new Error(`Invalid base URL: ${trimmed}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Base URL must be http(s): ${trimmed}`)
    }
    if (url.username || url.password) {
        throw new Error('Base URL must not include credentials')
    }
    if (url.search || url.hash) {
        throw new Error('Base URL must not include query or fragment')
    }

    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${pathname}`
}
