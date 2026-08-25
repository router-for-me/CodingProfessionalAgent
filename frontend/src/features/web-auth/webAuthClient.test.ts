import { describe, expect, it, vi } from 'vitest'
import {
    getWebAuthStatus,
    loginWebAuth,
    readWebApiJson,
    WebAuthenticationRequiredError,
} from './webAuthClient'

describe('webAuthClient', () => {
    it('loads auth status with same-origin credentials', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({ required: true, authenticated: false }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        )

        await expect(getWebAuthStatus(request)).resolves.toEqual({
            required: true,
            authenticated: false,
        })
        expect(request).toHaveBeenCalledWith('/api/auth/status', {
            credentials: 'same-origin',
        })
    })

    it('throws when fetching auth status fails with non-ok response', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'Server Error' }), { status: 500 }),
        )

        await expect(getWebAuthStatus(request)).rejects.toThrow(
            'Web authentication status failed: 500',
        )
    })

    it('throws when auth status response has invalid shape', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ required: 'yes' }), { status: 200 }),
        )

        await expect(getWebAuthStatus(request)).rejects.toThrow(
            'Invalid Web authentication status response',
        )
    })

    it('authenticates successfully with valid password', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ authenticated: true }), { status: 200 }),
        )

        await expect(loginWebAuth('correct-pass', request)).resolves.toBe(true)
        expect(request).toHaveBeenCalledWith(
            '/api/auth/login',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: 'correct-pass' }),
            }),
        )
    })

    it('returns false only for an invalid password response', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
        )

        await expect(loginWebAuth('wrong', request)).resolves.toBe(false)
        expect(request).toHaveBeenCalledWith(
            '/api/auth/login',
            expect.objectContaining({
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: 'wrong' }),
            }),
        )
    })

    it('throws for other non-ok HTTP responses during login', async () => {
        const request = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error: 'Server Error' }), { status: 500 }),
        )

        await expect(loginWebAuth('secret', request)).rejects.toThrow(
            'Web authentication failed: 500',
        )
    })

    it('notifies once and throws for an authenticated API 401', async () => {
        const onAuthenticationRequired = vi.fn()
        const response = new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401 },
        )

        await expect(
            readWebApiJson(response, onAuthenticationRequired),
        ).rejects.toBeInstanceOf(WebAuthenticationRequiredError)
        expect(onAuthenticationRequired).toHaveBeenCalledTimes(1)
    })

    it('parses successful authenticated API JSON without notifying', async () => {
        const onAuthenticationRequired = vi.fn()
        const response = new Response(JSON.stringify({ ok: true }), { status: 200 })

        await expect(
            readWebApiJson<{ ok: boolean }>(response, onAuthenticationRequired),
        ).resolves.toEqual({ ok: true })
        expect(onAuthenticationRequired).not.toHaveBeenCalled()
    })
})
