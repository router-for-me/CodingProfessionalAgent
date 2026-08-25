import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const WEB_AUTH_COOKIE_NAME = 'cpa_web_session'

export type WebAuthPasswordChange =
    | 'unchanged'
    | 'enabled'
    | 'changed'
    | 'disabled'

export interface WebAuthStatus {
    required: boolean
    authenticated: boolean
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest()
}

function firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value
}

function readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null
    for (const part of header.split(';')) {
        const separator = part.indexOf('=')
        if (separator < 0) continue
        if (part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim()
        }
    }
    return null
}

const HOST_AUTHORITY_PATTERN =
    /^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9_.-]+)(?::\d{1,5})?$/

export class WebServerAuthService {
    private password = ''
    private sessions = new Set<string>()

    setPassword(password: string): WebAuthPasswordChange {
        if (password === this.password) return 'unchanged'
        const wasRequired = this.password.length > 0
        const isRequired = password.length > 0
        this.password = password
        this.sessions.clear()
        if (!wasRequired && isRequired) return 'enabled'
        if (wasRequired && !isRequired) return 'disabled'
        return 'changed'
    }

    isRequired(): boolean {
        return this.password.length > 0
    }

    createSession(password: string): string | null {
        if (!this.isRequired()) return null
        if (!timingSafeEqual(digest(password), digest(this.password))) return null
        const token = randomBytes(32).toString('hex')
        this.sessions.add(token)
        return token
    }

    isAuthenticated(request: IncomingMessage): boolean {
        if (!this.isRequired()) return true
        const token = readCookie(request.headers.cookie, WEB_AUTH_COOKIE_NAME)
        return token !== null && this.sessions.has(token)
    }

    getStatus(request: IncomingMessage): WebAuthStatus {
        return {
            required: this.isRequired(),
            authenticated: this.isAuthenticated(request),
        }
    }

    createSessionCookie(token: string, request: IncomingMessage): string {
        const forwardedProto = firstHeader(request.headers['x-forwarded-proto'])
        const encrypted = Boolean(
            (request.socket as typeof request.socket & { encrypted?: boolean })?.encrypted,
        )
        const secure = encrypted || forwardedProto === 'https' ? '; Secure' : ''
        return `${WEB_AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`
    }

    isSameOrigin(request: IncomingMessage): boolean {
        const origin = firstHeader(request.headers.origin)
        if (!origin) return true
        const host = firstHeader(request.headers.host)
        if (!host || !HOST_AUTHORITY_PATTERN.test(host)) return false
        const forwardedProto = firstHeader(request.headers['x-forwarded-proto'])
        const encrypted = Boolean(
            (request.socket as typeof request.socket & { encrypted?: boolean })?.encrypted,
        )
        const protocol = encrypted || forwardedProto === 'https' ? 'https' : 'http'
        try {
            return new URL(origin).origin === new URL(`${protocol}://${host}`).origin
        } catch {
            return false
        }
    }

    clearSessions(): void {
        this.sessions.clear()
    }
}
