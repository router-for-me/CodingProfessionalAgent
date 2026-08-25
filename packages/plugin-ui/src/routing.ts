/** Reads the application pathname without confusing it with the document path. */
export function getHashRoutePathname(
    hash = typeof window !== 'undefined' ? window.location.hash : '',
): string {
    const route = hash.replace(/^#/, '')
    return route.startsWith('/') ? route.split(/[?#]/, 1)[0] : '/'
}

/** Builds a deep link while preserving the document path and deployment prefix. */
export function createHashRouteUrl(
    path: string,
    baseUrl = typeof window !== 'undefined' ? window.location.href : 'http://localhost/',
): string {
    const url = new URL(baseUrl)
    url.hash = path
    return url.href
}
