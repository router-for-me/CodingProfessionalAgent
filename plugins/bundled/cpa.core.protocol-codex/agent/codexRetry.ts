/**
 * Codex Responses protocol error classification and transport retry policies.
 */

export const CODEX_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const

export type CodexErrorClass =
    | 'transient'
    | 'context_overflow'
    | 'fatal'
    | 'aborted'

export function readCodexStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const record = error as Record<string, unknown>
    const candidates = [record.status, record.statusCode]
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
        if (typeof value === 'string' && /^\d{3}$/.test(value)) {
            return Number(value)
        }
    }
    if (
        typeof record.code === 'number' &&
        record.code >= 100 &&
        record.code <= 599
    ) {
        return record.code
    }
    if (typeof record.code === 'string' && /^\d{3}$/.test(record.code)) {
        return Number(record.code)
    }
    return undefined
}

export function readCodexCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const record = error as Record<string, unknown>
    if (typeof record.code === 'string') return record.code
    if (typeof record.errorCode === 'string') return record.errorCode
    if (typeof record.type === 'string') return record.type
    return undefined
}

export function readCodexErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>
        if (typeof record.message === 'string') return record.message
        if (typeof record.error === 'string') return record.error
    }
    return String(error ?? '')
}

function isAbortError(error: unknown, message: string): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true
    if (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'AbortError'
    ) {
        return true
    }
    return /request was aborted|aborted by user|the operation was aborted|aborterror/i.test(
        message
    )
}

function isContextOverflowCode(code: string): boolean {
    return (
        code === 'context_length_exceeded' ||
        code === 'context_overflow' ||
        code === 'token_limit_exceeded' ||
        code === 'max_tokens'
    )
}

function isFatalBusinessCode(code: string): boolean {
    return (
        code === 'insufficient_quota' ||
        code === 'quota_exceeded' ||
        code === 'rate_limit_exceeded' ||
        code === 'billing_hard_limit_reached' ||
        code === 'billing' ||
        code === 'authentication_error' ||
        code === 'permission_denied' ||
        code === 'invalid_api_key'
    )
}

function isNetworkErrorCode(code: string): boolean {
    return /^(econnreset|econnrefused|etimedout|enotfound|eai_again|econnaborted|epipe|enetunreach|ehostunreach|socket_hang_up)$/i.test(
        code
    )
}

function isContextOverflowMessage(message: string): boolean {
    return /context (length|window|overflow)|maximum context|prompt is too long|token limit exceeded|too many tokens|context_length_exceeded/i.test(
        message
    )
}

/**
 * Classify errors from the Codex WebSocket transport and API.
 */
export function classifyCodexError(error: unknown): CodexErrorClass {
    const message = readCodexErrorMessage(error)
    if (isAbortError(error, message)) {
        return 'aborted'
    }

    const status = readCodexStatus(error)
    const code = (readCodexCode(error) ?? '').toLowerCase()

    if (isContextOverflowCode(code) || isContextOverflowMessage(message)) {
        if (status === 401 || status === 403 || status === 429) {
            return 'fatal'
        }
        if (isFatalBusinessCode(code)) {
            return 'fatal'
        }
        return 'context_overflow'
    }

    if (status === 401 || status === 403 || status === 429) {
        return 'fatal'
    }

    if (isFatalBusinessCode(code)) {
        return 'fatal'
    }

    if (
        status === 408 ||
        (status !== undefined && status >= 500 && status <= 599)
    ) {
        return 'transient'
    }

    if (status !== undefined && status >= 400 && status < 500) {
        return 'fatal'
    }

    if (isNetworkErrorCode(code)) {
        return 'transient'
    }

    if (
        /\b(401|403|429)\b/.test(message) ||
        /unauthorized|forbidden|invalid.?api.?key|authentication|permission denied/i.test(
            message
        ) ||
        /\b(rate[_\s-]?limit|too many requests)\b/i.test(message) ||
        /\b(insufficient[_\s-]?quota|quota[_\s-]?exceeded|billing|payment required|exceeded your current quota)\b/i.test(
            message
        ) ||
        /\b(404|422|400)\b/.test(message)
    ) {
        return 'fatal'
    }

    if (
        /closed network connection|network connection (was )?closed/i.test(
            message
        ) ||
        /codex stream closed before response\.completed/i.test(message) ||
        /invalid codex json|invalid json|failed to parse.*json/i.test(message) ||
        /econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|socket closed|websocket|connection (closed|reset|lost|terminated)|network|temporar|unavailable|timed?\s*out|timeout/i.test(
            message
        ) ||
        /stream (ended|closed|failed)|missing completed|did not complete|terminated/i.test(
            message
        ) ||
        /\b(502|503|504|500|408)\b/.test(message)
    ) {
        return 'transient'
    }

    return 'fatal'
}

export function isCodexTransientError(error: unknown): boolean {
    return classifyCodexError(error) === 'transient'
}

export function isCodexContextOverflowError(error: unknown): boolean {
    return classifyCodexError(error) === 'context_overflow'
}

export function shouldRetryCodex(
    error: unknown,
    attempt: number,
    maxRetries = 3
): boolean {
    if (attempt >= maxRetries) return false
    return isCodexTransientError(error)
}
