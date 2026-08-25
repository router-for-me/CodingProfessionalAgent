import { describe, expect, it } from 'vitest'
import {
    classifyCodexError,
    isCodexContextOverflowError,
    isCodexTransientError,
    readCodexCode,
    readCodexStatus,
    shouldRetryCodex,
} from './codexRetry'

describe('codexRetry', () => {
    it('extracts status code from error object correctly', () => {
        expect(readCodexStatus({ status: 502 })).toBe(502)
        expect(readCodexStatus({ statusCode: '404' })).toBe(404)
        expect(readCodexStatus({ code: 500 })).toBe(500)
        expect(readCodexStatus(new Error('no status'))).toBeUndefined()
    })

    it('extracts error code from error object correctly', () => {
        expect(readCodexCode({ code: 'ECONNRESET' })).toBe('ECONNRESET')
        expect(readCodexCode({ errorCode: 'context_overflow' })).toBe('context_overflow')
        expect(readCodexCode({ type: 'rate_limit_exceeded' })).toBe('rate_limit_exceeded')
    })

    it('classifies abort errors as aborted', () => {
        const err = new Error('Request was aborted')
        err.name = 'AbortError'
        expect(classifyCodexError(err)).toBe('aborted')
        expect(classifyCodexError('aborted by user')).toBe('aborted')
    })

    it('classifies context overflow errors', () => {
        expect(
            classifyCodexError({
                status: 400,
                code: 'context_length_exceeded',
                message: 'Context length exceeded',
            })
        ).toBe('context_overflow')
        expect(isCodexContextOverflowError({ message: 'prompt is too long' })).toBe(true)
    })

    it('classifies transient network/server errors', () => {
        expect(classifyCodexError({ status: 503 })).toBe('transient')
        expect(classifyCodexError({ code: 'ECONNRESET' })).toBe('transient')
        expect(
            classifyCodexError(new Error('Codex stream closed before response.completed'))
        ).toBe('transient')
        expect(isCodexTransientError({ status: 502 })).toBe(true)
    })

    it('classifies fatal auth/quota/client errors', () => {
        expect(classifyCodexError({ status: 401 })).toBe('fatal')
        expect(classifyCodexError({ status: 403 })).toBe('fatal')
        expect(classifyCodexError({ code: 'invalid_api_key' })).toBe('fatal')
        expect(classifyCodexError({ status: 404 })).toBe('fatal')
    })

    it('evaluates shouldRetryCodex based on attempts and error classification', () => {
        expect(shouldRetryCodex({ status: 502 }, 0, 3)).toBe(true)
        expect(shouldRetryCodex({ status: 502 }, 2, 3)).toBe(true)
        expect(shouldRetryCodex({ status: 502 }, 3, 3)).toBe(false)
        expect(shouldRetryCodex({ status: 401 }, 0, 3)).toBe(false)
    })
})
