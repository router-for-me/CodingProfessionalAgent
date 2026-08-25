import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AGENT_RETRY_DELAYS_MS,
    classifyAgentError,
    defaultSleep,
    isContextOverflowError,
    isTransientAgentError,
    sleepForRetryAttempt,
} from './retry'

describe('agent retry classification', () => {
    it('exposes 2s/4s/8s delays', () => {
        expect(AGENT_RETRY_DELAYS_MS).toEqual([2_000, 4_000, 8_000])
    })

    it('classifies network closed / stream closed / invalid JSON as transient', () => {
        expect(classifyAgentError(new Error('closed network connection'))).toBe(
            'transient',
        )
        expect(
            classifyAgentError(
                new Error('CPA stream closed before response.completed'),
            ),
        ).toBe('transient')
        expect(classifyAgentError(new Error('invalid CPA JSON'))).toBe('transient')
        expect(classifyAgentError(new Error('socket hang up'))).toBe('transient')
        expect(classifyAgentError(new Error('WebSocket connection terminated'))).toBe(
            'transient',
        )
        expect(classifyAgentError(new Error('request timeout'))).toBe('transient')
        expect(isTransientAgentError(new Error('ECONNRESET'))).toBe(true)
    })

    it('does not retry 401/403/429/quota/rate-limit/billing/deterministic 4xx', () => {
        expect(classifyAgentError(Object.assign(new Error('nope'), { status: 401 }))).toBe(
            'fatal',
        )
        expect(classifyAgentError(Object.assign(new Error('nope'), { status: 403 }))).toBe(
            'fatal',
        )
        expect(classifyAgentError(Object.assign(new Error('nope'), { status: 429 }))).toBe(
            'fatal',
        )
        expect(classifyAgentError(Object.assign(new Error('x'), { status: 400 }))).toBe(
            'fatal',
        )
        expect(classifyAgentError(Object.assign(new Error('x'), { status: 422 }))).toBe(
            'fatal',
        )
        expect(
            classifyAgentError(
                Object.assign(new Error('ignored message'), {
                    code: 'insufficient_quota',
                }),
            ),
        ).toBe('fatal')
        expect(
            classifyAgentError(
                Object.assign(new Error('ignored'), { code: 'rate_limit_exceeded' }),
            ),
        ).toBe('fatal')
        expect(classifyAgentError(new Error('billing hard limit reached'))).toBe('fatal')
        expect(classifyAgentError(new Error('exceeded your current quota'))).toBe('fatal')
        expect(classifyAgentError(new Error('Too Many Requests rate limit'))).toBe('fatal')
    })

    it('prefers status/code over message so quota text with network wording stays fatal', () => {
        // status 429 wins even if message mentions connection.
        expect(
            classifyAgentError(
                Object.assign(new Error('connection closed due to rate limit'), {
                    status: 429,
                }),
            ),
        ).toBe('fatal')
        // code wins over transient-looking message.
        expect(
            classifyAgentError(
                Object.assign(new Error('network error while checking quota'), {
                    code: 'insufficient_quota',
                }),
            ),
        ).toBe('fatal')
    })

    it('classifies context overflow independently', () => {
        expect(
            classifyAgentError(new Error('context_length_exceeded: prompt is too long')),
        ).toBe('context_overflow')
        expect(
            classifyAgentError(
                Object.assign(new Error('x'), { code: 'context_length_exceeded' }),
            ),
        ).toBe('context_overflow')
        expect(isContextOverflowError(new Error('maximum context length exceeded'))).toBe(
            true,
        )
        // overflow is not transient
        expect(isTransientAgentError(new Error('context window overflow'))).toBe(false)
    })

    it('prefers context overflow code over generic 400 status', () => {
        expect(
            classifyAgentError({
                status: 400,
                code: 'context_length_exceeded',
                message: 'bad request',
            }),
        ).toBe('context_overflow')
        expect(
            classifyAgentError(
                Object.assign(new Error('request failed'), {
                    statusCode: 400,
                    code: 'context_length_exceeded',
                }),
            ),
        ).toBe('context_overflow')
    })

    it('classifies structured 5xx and 408 as transient; 401/403/429 fatal', () => {
        expect(classifyAgentError({ status: 503, message: 'unavailable' })).toBe('transient')
        expect(classifyAgentError({ statusCode: 500, message: 'oops' })).toBe('transient')
        expect(classifyAgentError({ status: 408, message: 'timeout' })).toBe('transient')
        expect(classifyAgentError({ status: 401 })).toBe('fatal')
        expect(classifyAgentError({ status: 403 })).toBe('fatal')
        expect(classifyAgentError({ status: 429 })).toBe('fatal')
    })

    it('classifies network codes as transient', () => {
        expect(classifyAgentError({ code: 'ECONNRESET', message: 'reset' })).toBe('transient')
        expect(classifyAgentError({ code: 'ETIMEDOUT' })).toBe('transient')
        expect(classifyAgentError({ code: 'ENOTFOUND' })).toBe('transient')
    })

    it('classifies abort separately', () => {
        const abort = new Error('Request was aborted')
        abort.name = 'AbortError'
        expect(classifyAgentError(abort)).toBe('aborted')
        expect(classifyAgentError(new Error('Request was aborted'))).toBe('aborted')
    })
})

describe('retry sleep', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('sleeps 2s/4s/8s for retry attempts and is abort-interruptible', async () => {
        const ac = new AbortController()
        const p0 = sleepForRetryAttempt(0, ac.signal, defaultSleep)
        await vi.advanceTimersByTimeAsync(1_999)
        // still pending
        let settled = false
        void p0.then(() => {
            settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await p0
        expect(settled).toBe(true)

        const p1 = sleepForRetryAttempt(1, ac.signal, defaultSleep)
        await vi.advanceTimersByTimeAsync(4_000)
        await p1

        const p2 = sleepForRetryAttempt(2, ac.signal, defaultSleep)
        await vi.advanceTimersByTimeAsync(8_000)
        await p2

        const ac2 = new AbortController()
        const pending = sleepForRetryAttempt(0, ac2.signal, defaultSleep)
        ac2.abort()
        await expect(pending).rejects.toThrow(/abort/i)
    })

    it('defaultSleep rejects when already aborted', async () => {
        const ac = new AbortController()
        ac.abort()
        await expect(defaultSleep(1000, ac.signal)).rejects.toThrow(/abort/i)
    })
})
