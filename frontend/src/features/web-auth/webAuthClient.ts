export interface WebAuthStatus {
    required: boolean
    authenticated: boolean
}

export class WebAuthenticationRequiredError extends Error {
    constructor() {
        super('Web authentication required')
        this.name = 'WebAuthenticationRequiredError'
    }
}

export function reloadForWebAuthentication(): void {
    if (typeof window !== 'undefined') {
        window.location.reload()
    }
}

export function requireAuthenticatedResponse(
    response: Response,
    onAuthenticationRequired: () => void = reloadForWebAuthentication,
): Response {
    if (response.status === 401) {
        onAuthenticationRequired()
        throw new WebAuthenticationRequiredError()
    }
    return response
}

export async function readWebApiJson<T>(
    response: Response,
    onAuthenticationRequired: () => void = reloadForWebAuthentication,
): Promise<T> {
    return requireAuthenticatedResponse(
        response,
        onAuthenticationRequired,
    ).json() as Promise<T>
}

/**
 * Fetches the web server authentication requirement and status.
 */
export async function getWebAuthStatus(
    request: typeof fetch = globalThis.fetch,
): Promise<WebAuthStatus> {
    const response = await request('/api/auth/status', {
        credentials: 'same-origin',
    })
    if (!response.ok) {
        throw new Error(`Web authentication status failed: ${response.status}`)
    }
    const body = (await response.json()) as Partial<WebAuthStatus>
    if (
        typeof body.required !== 'boolean' ||
        typeof body.authenticated !== 'boolean'
    ) {
        throw new Error('Invalid Web authentication status response')
    }
    return {
        required: body.required,
        authenticated: body.authenticated,
    }
}

/**
 * Sends a login request with password to the web server auth endpoint.
 * Returns true if authenticated, false if rejected with 401 unauthorized.
 */
export async function loginWebAuth(
    password: string,
    request: typeof fetch = globalThis.fetch,
): Promise<boolean> {
    const response = await request('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
    })
    if (response.status === 401) {
        return false
    }
    if (!response.ok) {
        throw new Error(`Web authentication failed: ${response.status}`)
    }
    return true
}
