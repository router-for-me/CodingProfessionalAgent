import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
    WEB_AUTH_COOKIE_NAME,
    WebServerAuthService,
} from '../src/main/services/webServerAuthService.js'

function request(headers: Record<string, string> = {}): IncomingMessage {
    return {
        headers,
        socket: { encrypted: false },
    } as unknown as IncomingMessage
}

describe('WebServerAuthService', () => {
    it('treats an empty password as authenticated without a session', () => {
        const auth = new WebServerAuthService()
        expect(auth.getStatus(request())).toEqual({
            required: false,
            authenticated: true,
        })
    })

    it('creates a session only for the exact configured password', () => {
        const auth = new WebServerAuthService()
        expect(auth.setPassword('  secret  ')).toBe('enabled')
        expect(auth.createSession('secret')).toBeNull()

        const token = auth.createSession('  secret  ')
        expect(token).toMatch(/^[a-f0-9]{64}$/)

        const cookie = auth.createSessionCookie(
            token!,
            request({ host: '127.0.0.1:18080' }),
        )
        expect(cookie).toContain(`${WEB_AUTH_COOKIE_NAME}=${token}`)
        expect(cookie).toContain('HttpOnly')
        expect(cookie).toContain('SameSite=Strict')
        expect(cookie).not.toContain('Max-Age')

        expect(
            auth.isAuthenticated(
                request({ cookie: cookie.split(';')[0] }),
            ),
        ).toBe(true)
    })

    it('invalidates sessions and classifies password changes', () => {
        const auth = new WebServerAuthService()
        expect(auth.setPassword('first')).toBe('enabled')
        const token = auth.createSession('first')!
        const authenticated = request({
            cookie: `${WEB_AUTH_COOKIE_NAME}=${token}`,
        })
        expect(auth.isAuthenticated(authenticated)).toBe(true)

        expect(auth.setPassword('first')).toBe('unchanged')
        expect(auth.isAuthenticated(authenticated)).toBe(true)

        expect(auth.setPassword('second')).toBe('changed')
        expect(auth.isAuthenticated(authenticated)).toBe(false)
        expect(auth.setPassword('')).toBe('disabled')
        expect(auth.getStatus(request()).required).toBe(false)
    })

    it('accepts only the request origin matching host and protocol', () => {
        const auth = new WebServerAuthService()
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test:443',
                    origin: 'https://cpa.example.test:443',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: 'CPA.EXAMPLE.TEST:18080',
                    origin: 'http://cpa.example.test:18080',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test:80',
                    origin: 'http://CPA.EXAMPLE.TEST',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: '127.0.0.1:18080',
                    origin: 'http://127.0.0.1:18080',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: '[::1]:18080',
                    origin: 'http://[::1]:18080',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: '[2001:db8::1]:443',
                    origin: 'https://[2001:db8::1]',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(true)
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test',
                    origin: 'https://evil.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        expect(auth.isSameOrigin(request({ host: '127.0.0.1:18080' }))).toBe(true)
    })

    it('rejects malformed host headers with userinfo, path, query, or fragment', () => {
        const auth = new WebServerAuthService()
        // userinfo
        expect(
            auth.isSameOrigin(
                request({
                    host: 'attacker.invalid@cpa.example.test',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        expect(
            auth.isSameOrigin(
                request({
                    host: 'attacker.invalid:pass@cpa.example.test',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        // path
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test/path',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        expect(
            auth.isSameOrigin(
                request({
                    host: '127.0.0.1/path',
                    origin: 'http://127.0.0.1',
                }),
            ),
        ).toBe(false)
        // query
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test?query=1',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        expect(
            auth.isSameOrigin(
                request({
                    host: '127.0.0.1?query=1',
                    origin: 'http://127.0.0.1',
                }),
            ),
        ).toBe(false)
        // fragment
        expect(
            auth.isSameOrigin(
                request({
                    host: 'cpa.example.test#fragment',
                    origin: 'https://cpa.example.test',
                    'x-forwarded-proto': 'https',
                }),
            ),
        ).toBe(false)
        expect(
            auth.isSameOrigin(
                request({
                    host: '[::1]#fragment',
                    origin: 'http://[::1]',
                }),
            ),
        ).toBe(false)
    })

    it('adds Secure only for an HTTPS request and rejects malformed cookies', () => {
        const auth = new WebServerAuthService()
        auth.setPassword('secret')
        const token = auth.createSession('secret')!
        const secureCookie = auth.createSessionCookie(
            token,
            request({
                host: 'cpa.example.test',
                'x-forwarded-proto': 'https',
            }),
        )
        expect(secureCookie).toContain('; Secure')
        expect(auth.isAuthenticated(request({ cookie: 'broken-cookie' }))).toBe(false)
    })
})
