import { describe, expect, it } from 'vitest'
import { safeInvoke } from './safeInvoke.js'

describe('safeInvoke', () => {
    it('returns ok: true with value for synchronous functions', async () => {
        const result = await safeInvoke(() => 42)
        expect(result).toEqual({ ok: true, value: 42 })
    })

    it('returns ok: true with value for asynchronous functions', async () => {
        const result = await safeInvoke(async () => {
            return 'resolved-value'
        })
        expect(result).toEqual({ ok: true, value: 'resolved-value' })
    })

    it('catches synchronous exceptions and returns ok: false with Error', async () => {
        const result = await safeInvoke(() => {
            throw new Error('sync failure')
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toBeInstanceOf(Error)
            expect(result.error.message).toBe('sync failure')
        }
    })

    it('catches asynchronous rejections and returns ok: false with Error', async () => {
        const result = await safeInvoke(async () => {
            throw new Error('async failure')
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toBeInstanceOf(Error)
            expect(result.error.message).toBe('async failure')
        }
    })

    it('wraps non-Error throws into an Error instance', async () => {
        const result = await safeInvoke(() => {
            throw 'string failure'
        })
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error).toBeInstanceOf(Error)
            expect(result.error.message).toBe('string failure')
        }
    })

    it('times out when execution exceeds timeoutMs', async () => {
        const result = await safeInvoke(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve('late'), 100)
                }),
            { timeoutMs: 20, pluginId: 'test-plugin', actionName: 'slowAction' },
        )
        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.error.message).toContain('slowAction')
            expect(result.error.message).toContain('test-plugin')
            expect(result.error.message).toContain('20ms')
        }
    })

    it('completes normally when execution finishes within timeoutMs', async () => {
        const result = await safeInvoke(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve('fast'), 10)
                }),
            { timeoutMs: 100 },
        )
        expect(result).toEqual({ ok: true, value: 'fast' })
    })
})
