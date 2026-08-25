/**
 * Agent-level error classification and abort-interruptible retry delays.
 * Delays: 2s / 4s / 8s — at most 3 retries (4 total attempts).
 */

export const AGENT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>

export type AgentErrorClass =
    | 'transient'
    | 'context_overflow'
    | 'fatal'
    | 'aborted'

export async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        throw createAbortError()
    }
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(createAbortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

function createAbortError(): Error {
    const error = new Error('Request was aborted')
    error.name = 'AbortError'
    return error
}

function readStatus(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const record = error as Record<string, unknown>
    // Prefer explicit HTTP fields; do not treat string network codes as status.
    const candidates = [record.status, record.statusCode]
    for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
        if (typeof value === 'string' && /^\d{3}$/.test(value)) {
            return Number(value)
        }
    }
    // Numeric `code` only when it looks like an HTTP status.
    if (typeof record.code === 'number' && record.code >= 100 && record.code <= 599) {
        return record.code
    }
    if (typeof record.code === 'string' && /^\d{3}$/.test(record.code)) {
        return Number(record.code)
    }
    return undefined
}

function readCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const record = error as Record<string, unknown>
    if (typeof record.code === 'string') return record.code
    if (typeof record.errorCode === 'string') return record.errorCode
    if (typeof record.type === 'string') return record.type
    return undefined
}

function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>
        if (typeof record.message === 'string') return record.message
        if (typeof record.error === 'string') return record.error
    }
    return String(error ?? '')
}

function isAbortLike(error: unknown, message: string): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true
    if (
        typeof error === 'object' &&
        error !== null &&
        (error as { name?: string }).name === 'AbortError'
    ) {
        return true
    }
    return /request was aborted|aborted by user|the operation was aborted|aborterror/i.test(
        message,
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

function isNetworkCode(code: string): boolean {
    return /^(econnreset|econnrefused|etimedout|enotfound|eai_again|econnaborted|epipe|enetunreach|ehostunreach|socket_hang_up)$/i.test(
        code,
    )
}

function isContextOverflowMessage(message: string): boolean {
    return /context (length|window|overflow)|maximum context|prompt is too long|token limit exceeded|too many tokens|context_length_exceeded/i.test(
        message,
    )
}

/**
 * Classify provider/agent failures.
 * Preference order:
 * 1. abort
 * 2. context overflow code/message (wins over generic 4xx status)
 * 3. structured fatal status/codes (401/403/429, quota/rate/billing)
 * 4. structured transient status (5xx/408) and network codes
 * 5. other deterministic 4xx
 * 6. message heuristics
 */
export function classifyAgentError(error: unknown): AgentErrorClass {
    const message = messageOf(error)
    if (isAbortLike(error, message)) {
        return 'aborted'
    }

    const status = readStatus(error)
    const code = (readCode(error) ?? '').toLowerCase()

    // Overflow code beats generic 4xx (e.g. {status:400, code:context_length_exceeded}).
    if (isContextOverflowCode(code) || isContextOverflowMessage(message)) {
        // Still let explicit auth/rate statuses win when clearly fatal.
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

    // Structured 5xx / 408 are transient.
    if (status === 408 || (status !== undefined && status >= 500 && status <= 599)) {
        return 'transient'
    }

    // Other deterministic 4xx.
    if (status !== undefined && status >= 400 && status < 500) {
        return 'fatal'
    }

    if (isNetworkCode(code)) {
        return 'transient'
    }

    // Message-based fatal classes (auth / quota / billing / rate-limit).
    if (
        /\b(401|403|429)\b/.test(message) ||
        /unauthorized|forbidden|invalid.?api.?key|authentication|permission denied/i.test(
            message,
        ) ||
        /\b(rate[_\s-]?limit|too many requests)\b/i.test(message) ||
        /\b(insufficient[_\s-]?quota|quota[_\s-]?exceeded|billing|payment required|exceeded your current quota)\b/i.test(
            message,
        ) ||
        /\b(404|422|400)\b/.test(message)
    ) {
        return 'fatal'
    }

    // Transient network / stream / protocol failures.
    if (/closed network connection|network connection (was )?closed/i.test(message)) {
        return 'transient'
    }
    if (/(?:cpa|codex) stream closed before response\.completed/i.test(message)) {
        return 'transient'
    }
    if (/(?:invalid )?(?:cpa|codex) json|invalid json|failed to parse.*json/i.test(message)) {
        return 'transient'
    }
    if (
        /econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|socket closed|websocket|connection (closed|reset|lost|terminated)|network|temporar|unavailable|timed?\s*out|timeout/i.test(
            message,
        )
    ) {
        return 'transient'
    }
    if (/stream (ended|closed|failed)|missing completed|did not complete|terminated/i.test(message)) {
        return 'transient'
    }
    if (/\b(502|503|504|500|408)\b/.test(message)) {
        return 'transient'
    }

    // Default: treat unknown as fatal so we never infinite-retry silently.
    return 'fatal'
}

export function isTransientAgentError(error: unknown): boolean {
    return classifyAgentError(error) === 'transient'
}

export function isContextOverflowError(error: unknown): boolean {
    return classifyAgentError(error) === 'context_overflow'
}

/**
 * Sleep for the delay at the given retry attempt index (0-based).
 * attempt 0 → 2s, 1 → 4s, 2 → 8s. Out-of-range returns without sleeping.
 */
export async function sleepForRetryAttempt(
    attemptIndex: number,
    signal: AbortSignal,
    sleep: SleepFn = defaultSleep,
    delays: readonly number[] = AGENT_RETRY_DELAYS_MS,
): Promise<void> {
    const delay = delays[attemptIndex]
    if (delay === undefined) return
    await sleep(delay, signal)
}
