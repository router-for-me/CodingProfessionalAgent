/**
 * Strict persistent Codex Responses WebSocket connection manager.
 * Session sockets keep one background pump per native operation across turns;
 * each response is isolated on its own queue. Isolated mode never touches the cache.
 */

import { CODEX_STREAM_CLOSED_BEFORE_COMPLETED } from './codexStream.js'
import type {
    CodexInputItem,
    CodexResponseCreate,
    NativeBridge,
    NativeEvent,
    NativeOperation,
} from './types.js'

export const IDLE_TTL_MS = 5 * 60 * 1000
export const MAX_AGE_MS = 55 * 60 * 1000
export const CONNECT_TIMEOUT_MS = 15_000
export const MAX_CONNECT_RETRIES = 3

const OPENAI_BETA_RESPONSES_WEBSOCKETS = 'responses_websockets=2026-02-06'

export type CodexConnectionMode = 'session' | 'isolated'

export type ScheduleFn = (fn: () => void, ms: number) => unknown
export type CancelScheduleFn = (handle: unknown) => void

export interface CodexConnectionManagerOptions {
    now?: () => number
    generateRequestId?: () => string
    /** Injectable timer for CONNECT_TIMEOUT_MS (tests use a fake scheduler). */
    schedule?: ScheduleFn
    cancelSchedule?: CancelScheduleFn
}

export interface CodexAcquireInput {
    apiKey: string
    baseUrl: string
    request: CodexResponseCreate
    signal: AbortSignal
    mode: CodexConnectionMode
    /** Override request id headers (defaults: sessionId for session mode, fresh id for isolated). */
    requestId?: string
    /**
     * Opaque service-assigned namespace for session socket cache isolation.
     * Never derived from hashing the API key. Defaults to a stable "default" for
     * standalone manager tests that do not rotate auth identity.
     */
    connectionNamespace?: string
}

export interface CodexCommitInput {
    fullRequestBody: CodexResponseCreate
    responseId: string
    responseItems: readonly CodexInputItem[]
}

export interface CodexConnectionLease {
    readonly operationId: string
    readonly requestBody: CodexResponseCreate
    readonly events: AsyncIterable<unknown>
    commit(input: CodexCommitInput): void
    release(options?: { keep?: boolean }): Promise<void>
    /** Cancel the underlying socket once and drop cache entry. */
    cancel(): Promise<void>
}

interface ContinuationState {
    lastRequestBody: CodexResponseCreate
    lastResponseId: string
    lastResponseItems: CodexInputItem[]
}

interface SessionLockWaiter {
    resolve: () => void
    reject: (error: Error) => void
    signal: AbortSignal
    onAbort: () => void
}

interface SessionLock {
    busy: boolean
    /** When true, queued waiters are rejected and new acquires for this key fail. */
    closed: boolean
    closeReason?: string
    queue: SessionLockWaiter[]
}

type QueueWaiter = {
    resolve: (result: IteratorResult<unknown>) => void
    reject: (error: unknown) => void
}

/**
 * Per-response event queue. Early iterator return does not stop the socket pump.
 * firstProtocol settles on the first valid decoded protocol event (or fails earlier).
 */
class ResponseEventQueue {
    private readonly buffer: unknown[] = []
    private readonly waiters: QueueWaiter[] = []
    private finished = false
    private failure: Error | undefined
    private abandoned = false
    private firstSettled = false
    /** Monotonic: once a valid protocol frame is accepted, never returns to false. */
    private started = false
    private readonly firstResolve: () => void
    private readonly firstReject: (error: Error) => void
    readonly firstProtocol: Promise<void>

    constructor() {
        let resolveFirst!: () => void
        let rejectFirst!: (error: Error) => void
        this.firstProtocol = new Promise<void>((resolve, reject) => {
            resolveFirst = resolve
            rejectFirst = reject
        })
        this.firstResolve = resolveFirst
        this.firstReject = rejectFirst
        // Avoid unhandled rejection when acquire aborts before awaiting firstProtocol.
        this.firstProtocol.catch(() => {
            // intentional
        })
    }

    get isSettled(): boolean {
        return this.finished || this.failure !== undefined
    }

    /**
     * True once the first valid protocol frame was pushed.
     * Monotonic latch: remains true after later fail/end so send-reject never retries.
     */
    get hasFirstProtocol(): boolean {
        return this.started
    }

    private notifyFirstOk(): void {
        // Started is a monotonic latch independent of later fail/end.
        this.started = true
        if (this.firstSettled) {
            return
        }
        this.firstSettled = true
        this.firstResolve()
    }

    private notifyFirstErr(error: Error): void {
        if (this.firstSettled) {
            return
        }
        this.firstSettled = true
        this.firstReject(error)
    }

    push(value: unknown): void {
        if (this.abandoned || this.finished || this.failure) {
            return
        }
        this.notifyFirstOk()
        if (this.waiters.length > 0) {
            this.waiters.shift()!.resolve({ value, done: false })
            return
        }
        this.buffer.push(value)
    }

    end(): void {
        if (this.finished || this.failure) {
            return
        }
        this.finished = true
        if (!this.firstSettled) {
            this.notifyFirstErr(new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED))
        }
        // Prefer draining any already-buffered frames before terminal done.
        this.flushWaitersPreferBuffer()
    }

    fail(error: Error): void {
        if (this.finished || this.failure) {
            return
        }
        this.failure = error
        this.notifyFirstErr(error)
        // Drain buffered events to waiters first; only reject once the buffer is empty.
        this.flushWaitersPreferBuffer()
    }

    /** Resolve waiters from buffer first so consumers observe events before end/error. */
    private flushWaitersPreferBuffer(): void {
        while (this.waiters.length > 0 && this.buffer.length > 0) {
            this.waiters.shift()!.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.buffer.length > 0) {
            // Remaining buffer is drained by subsequent next() calls before terminal.
            return
        }
        while (this.waiters.length > 0) {
            if (this.failure) {
                this.waiters.shift()!.reject(this.failure)
            } else if (this.finished) {
                this.waiters.shift()!.resolve({ value: undefined, done: true })
            } else {
                break
            }
        }
    }

    asIterable(): AsyncIterable<unknown> {
        const self = this
        return {
            [Symbol.asyncIterator](): AsyncIterator<unknown> {
                let consumerDone = false

                return {
                    async next(): Promise<IteratorResult<unknown>> {
                        if (consumerDone) {
                            return { value: undefined, done: true }
                        }
                        // Always drain buffered frames before surfacing failure/end.
                        if (self.buffer.length > 0) {
                            return { value: self.buffer.shift()!, done: false }
                        }
                        if (self.failure) {
                            consumerDone = true
                            throw self.failure
                        }
                        if (self.finished) {
                            consumerDone = true
                            return { value: undefined, done: true }
                        }
                        return await new Promise<IteratorResult<unknown>>((resolve, reject) => {
                            self.waiters.push({
                                resolve: (result) => {
                                    if (result.done) {
                                        consumerDone = true
                                    }
                                    resolve(result)
                                },
                                reject: (error) => {
                                    consumerDone = true
                                    reject(error)
                                },
                            })
                            // A concurrent fail/end may have already buffered+settled.
                            self.flushWaitersPreferBuffer()
                        })
                    },
                    async return(): Promise<IteratorResult<unknown>> {
                        // Abandon this response consumer only — pump keeps running.
                        consumerDone = true
                        self.abandoned = true
                        return { value: undefined, done: true }
                    },
                    async throw(error?: unknown): Promise<IteratorResult<unknown>> {
                        consumerDone = true
                        self.abandoned = true
                        throw error
                    },
                }
            },
        }
    }
}

interface LiveSocket {
    operationId: string
    operation: NativeOperation
    iterator: AsyncIterator<NativeEvent>
    createdAt: number
    lastUsedAt: number
    continuation?: ContinuationState
    opened: boolean
    closed: boolean
    /** Session cache key when cached; undefined for isolated. */
    sessionId?: string
    currentQueue?: ResponseEventQueue
    /** Queue already past first-protocol readiness for the pending lease. */
    readyQueue?: ResponseEventQueue
    pumpStarted: boolean
    cancelLatched: boolean
    iteratorReturnLatched: boolean
    /** Unified close latch — resolves when cancel/return cleanup finishes. */
    closePromise?: Promise<void>
    /** True once a protocol terminal failed/error forced eviction. */
    forceEvict: boolean
    /** True after the current response generation sees a legal lifecycle start. */
    responseStarted: boolean
    /** Last successfully completed response id (reject same-id replay). */
    lastCompletedResponseId?: string
}

function defaultRequestId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export function buildWebSocketHeaders(
    apiKey: string,
    requestId: string,
): Record<string, string> {
    return {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': OPENAI_BETA_RESPONSES_WEBSOCKETS,
        'x-client-request-id': requestId,
        'session-id': requestId,
        originator: 'cpa',
    }
}

/**
 * Canonicalize an HTTP(S) CLIProxyAPI base URL.
 * - trims whitespace
 * - rejects credentials, query, and hash
 * - normalizes trailing slash on the path (root stays empty)
 * - preserves a valid base path (e.g. /v1, /backend-api)
 */
export function canonicalizeBaseUrl(raw: string): string {
    const trimmed = (raw ?? '').trim()
    if (!trimmed) {
        throw new Error('Base URL is empty')
    }
    let url: URL
    try {
        url = new URL(trimmed)
    } catch {
        throw new Error(`Invalid base URL: ${trimmed}`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Base URL must be http(s): ${trimmed}`)
    }
    if (url.username || url.password) {
        throw new Error('Base URL must not include credentials')
    }
    if (url.search || url.hash) {
        throw new Error('Base URL must not include query or hash')
    }
    let pathname = url.pathname || ''
    if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1)
    }
    if (pathname === '/') {
        pathname = ''
    }
    return `${url.protocol}//${url.host}${pathname}`
}

/** Default namespace when callers omit connectionNamespace (standalone manager tests). */
export const DEFAULT_CONNECTION_NAMESPACE = 'default'

/**
 * Opaque connection identity for session socket cache isolation.
 * Uses a service-assigned namespace token — never hashes or embeds the raw API key.
 * Headers still carry the real sessionId via requestId.
 */
export function buildConnectionCacheKey(
    connectionNamespace: string,
    sessionId: string,
): string {
    const ns =
        (connectionNamespace ?? '').trim().length > 0
            ? connectionNamespace.trim()
            : DEFAULT_CONNECTION_NAMESPACE
    return `${ns}\n${sessionId}`
}

/**
 * Map an HTTP(S) CLIProxyAPI base URL to its Codex Responses WebSocket endpoint.
 * Root URLs use /v1/responses; a trailing /v1 is normalized to /v1/responses.
 */
export function resolveCodexWebSocketUrl(baseUrl: string): string {
    const raw =
        baseUrl && baseUrl.trim().length > 0
            ? baseUrl.trim()
            : 'http://127.0.0.1:8317/v1'
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        url = new URL(raw, 'http://127.0.0.1')
    }
    // Drop trailing slashes from the path while preserving intermediate segments.
    let pathname = (url.pathname || '/').replace(/\/+$/, '')
    if (pathname === '') {
        pathname = ''
    }
    if (pathname.endsWith('/v1/responses')) {
        // Already final.
    } else if (pathname.endsWith('/backend-api/codex/responses')) {
        pathname = `${pathname.slice(0, -'/backend-api/codex/responses'.length)}/v1/responses`
    } else if (pathname.endsWith('/backend-api/codex')) {
        pathname = `${pathname.slice(0, -'/backend-api/codex'.length)}/v1/responses`
    } else if (pathname.endsWith('/backend-api')) {
        pathname = `${pathname.slice(0, -'/backend-api'.length)}/v1/responses`
    } else if (pathname.endsWith('/responses')) {
        if (pathname === '/responses') {
            pathname = '/v1/responses'
        } else {
            pathname = `${pathname.slice(0, -'/responses'.length)}/v1/responses`
        }
    } else if (pathname === '/v1' || pathname.endsWith('/v1')) {
        pathname = `${pathname}/responses`
    } else {
        pathname = `${pathname}/v1/responses`
    }
    // Normalize accidental double slashes in the path only.
    pathname = pathname.replace(/\/{2,}/g, '/')
    if (!pathname.startsWith('/')) {
        pathname = `/${pathname}`
    }
    const protocol =
        url.protocol === 'https:'
            ? 'wss:'
            : url.protocol === 'http:'
              ? 'ws:'
              : url.protocol === 'wss:' || url.protocol === 'ws:'
                ? url.protocol
                : 'ws:'
    return `${protocol}//${url.host}${pathname}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep equality that ignores object key insertion order. */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true
    if (typeof a !== typeof b) return false
    if (a === null || b === null) return a === b
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i += 1) {
            if (!deepEqual(a[i], b[i])) return false
        }
        return true
    }
    if (!isPlainObject(a) || !isPlainObject(b)) {
        return false
    }
    const aKeys = Object.keys(a).sort()
    const bKeys = Object.keys(b).sort()
    if (aKeys.length !== bKeys.length) return false
    for (let i = 0; i < aKeys.length; i += 1) {
        if (aKeys[i] !== bKeys[i]) return false
    }
    for (const key of aKeys) {
        if (!deepEqual(a[key], b[key])) return false
    }
    return true
}

function deepClone<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value)
    }
    return JSON.parse(JSON.stringify(value)) as T
}

function requestBodyWithoutInput(body: CodexResponseCreate): Record<string, unknown> {
    const {
        input: _input,
        previous_response_id: _previousResponseId,
        ...rest
    } = body
    return rest
}

function requestBodiesMatchExceptInput(
    a: CodexResponseCreate,
    b: CodexResponseCreate,
): boolean {
    return deepEqual(requestBodyWithoutInput(a), requestBodyWithoutInput(b))
}

function getInputDelta(
    body: CodexResponseCreate,
    continuation: ContinuationState,
): CodexInputItem[] | undefined {
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
        return undefined
    }
    const currentInput = body.input ?? []
    const baseline = [
        ...(continuation.lastRequestBody.input ?? []),
        ...continuation.lastResponseItems,
    ]
    if (currentInput.length < baseline.length) {
        return undefined
    }
    const prefix = currentInput.slice(0, baseline.length)
    if (!deepEqual(prefix, baseline)) {
        return undefined
    }
    return currentInput.slice(baseline.length)
}

function buildRequestBody(
    fullBody: CodexResponseCreate,
    continuation: ContinuationState | undefined,
): { body: CodexResponseCreate; clearContinuation: boolean } {
    if (!continuation) {
        return { body: fullBody, clearContinuation: false }
    }
    const delta = getInputDelta(fullBody, continuation)
    if (!delta || !continuation.lastResponseId) {
        return { body: fullBody, clearContinuation: true }
    }
    return {
        body: {
            ...fullBody,
            previous_response_id: continuation.lastResponseId,
            input: delta,
        },
        clearContinuation: false,
    }
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true
    if (!(error instanceof Error)) return false
    return (
        error.name === 'AbortError' ||
        /abort/i.test(error.message) ||
        error.message === 'Request was aborted'
    )
}

function isTimeoutMessage(error: unknown): boolean {
    return error instanceof Error && /timeout/i.test(error.message)
}

function protocolType(value: unknown): string {
    if (!isPlainObject(value) || typeof value.type !== 'string') {
        return ''
    }
    return value.type === 'response.done' ? 'response.completed' : value.type
}

function isProtocolSuccessTerminal(type: string): boolean {
    return type === 'response.completed' || type === 'response.incomplete'
}

function isProtocolFailureTerminal(type: string): boolean {
    return type === 'response.failed' || type === 'error'
}

/** Connection-level telemetry may arrive before, during, or after a response turn. */
function isConnectionMetadataFrame(type: string): boolean {
    return (
        type === 'codex.rate_limits' ||
        type === 'codex.response.metadata' ||
        type === 'responsesapi.websocket_timing'
    )
}

/** JSON.parse success is not enough — require a plain object with nonempty type. */
function isValidProtocolFrame(value: unknown): boolean {
    if (!isPlainObject(value)) {
        return false
    }
    return typeof value.type === 'string' && value.type.length > 0
}

/**
 * Legal first frames for a new response generation: real lifecycle status, created,
 * or terminal-only. Deltas / output items before this are treated as stale.
 * Parser may ignore status events, but the pump must not mark them stale.
 */
function isResponseLifecycleStart(type: string): boolean {
    return (
        type === 'response.created' ||
        type === 'response.queued' ||
        type === 'response.in_progress' ||
        type === 'response.completed' ||
        type === 'response.incomplete' ||
        type === 'response.failed' ||
        type === 'error'
    )
}

function extractResponseId(value: unknown): string | undefined {
    if (!isPlainObject(value)) {
        return undefined
    }
    if (isPlainObject(value.response) && typeof value.response.id === 'string') {
        return value.response.id
    }
    return undefined
}

/** In-flight open before a LiveSocket is claimed (isolated/fresh pre-open). */
interface OpenAttempt {
    operationId: string
    controller: AbortController
    promise: Promise<NativeOperation>
    /** True when manager.dispose aborted this attempt. */
    disposed: boolean
    /** Cancel/return already issued for a late open resolve. */
    cleaned: boolean
}

export class CodexConnectionManager {
    /** Cached session sockets keyed by opaque namespace + sessionId. */
    private readonly sessions = new Map<string, LiveSocket>()
    /** Locks keyed by the same connection identity as sessions. */
    private readonly locks = new Map<string, SessionLock>()
    /**
     * Permanent tombstones for closed connection identities.
     * closeLock never reopens: subsequent acquire on the same key always rejects.
     * Bounded by manager lifetime (cleared only on dispose).
     */
    private readonly closedKeys = new Set<string>()
    /** Logical sessionId → last connection identity (evict on config change). */
    private readonly logicalSessionKeys = new Map<string, string>()
    /** All live sockets including isolated — dispose closes every entry once. */
    private readonly liveSockets = new Set<LiveSocket>()
    /** Pre-open attempts tracked before bridge open resolves (dispose + late cleanup). */
    private readonly openAttempts = new Set<OpenAttempt>()
    private readonly now: () => number
    private readonly generateRequestId: () => string
    private readonly schedule: ScheduleFn
    private readonly cancelSchedule: CancelScheduleFn
    private disposed = false

    constructor(
        private readonly bridge: NativeBridge,
        options: CodexConnectionManagerOptions = {},
    ) {
        this.now = options.now ?? (() => Date.now())
        this.generateRequestId = options.generateRequestId ?? defaultRequestId
        this.schedule =
            options.schedule ??
            ((fn, ms) => globalThis.setTimeout(fn, ms))
        this.cancelSchedule =
            options.cancelSchedule ??
            ((handle) => {
                globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
            })
    }

    /** Force-close and drop a cached session socket by logical session id (any identity). */
    closeSession(sessionId: string): void {
        const identity = this.logicalSessionKeys.get(sessionId)
        if (identity) {
            const entry = this.sessions.get(identity)
            if (entry) {
                void this.closeSocket(entry, { cancel: true })
            }
            this.closeLock(identity, 'Session closed')
            this.logicalSessionKeys.delete(sessionId)
            return
        }
        // Fallback: treat argument as a raw cache key (tests / internal).
        const entry = this.sessions.get(sessionId)
        if (entry) {
            void this.closeSocket(entry, { cancel: true })
        }
        this.closeLock(sessionId, 'Session closed')
    }

    /**
     * Close every live socket (session + isolated), reject lock waiters, and reject future acquire.
     * Idempotent. Safe to call from service/provider dispose paths.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return
        }
        this.disposed = true

        // Abort every in-flight pre-open attempt so late open never leases/caches.
        for (const attempt of [...this.openAttempts]) {
            attempt.disposed = true
            void this.cleanupOpenAttempt(attempt)
        }

        for (const key of [...this.locks.keys()]) {
            this.closeLock(key, 'Connection manager disposed')
        }
        this.locks.clear()
        this.logicalSessionKeys.clear()

        // Unified close: sessions + isolated leases tracked in liveSockets.
        const sockets = new Set<LiveSocket>([
            ...this.sessions.values(),
            ...this.liveSockets,
        ])
        this.sessions.clear()
        this.liveSockets.clear()
        await Promise.all(
            [...sockets].map((socket) =>
                this.closeSocket(socket, { cancel: true }).catch(() => {
                    // best-effort
                }),
            ),
        )

        // Manager is gone — tombstones no longer needed (lifetime-bounded).
        this.closedKeys.clear()
    }

    get isDisposed(): boolean {
        return this.disposed
    }

    /** Test helper: number of cached session sockets. */
    get cachedSessionCount(): number {
        return this.sessions.size
    }

    /** Test helper: live sockets including isolated (not yet closed). */
    get liveSocketCount(): number {
        return this.liveSockets.size
    }

    async acquire(
        sessionId: string | null | undefined,
        input: CodexAcquireInput,
    ): Promise<CodexConnectionLease> {
        if (this.disposed) {
            throw new Error('Connection manager disposed')
        }
        if (input.mode === 'isolated' || !sessionId) {
            return this.acquireIsolated(input)
        }
        const cacheKey = this.connectionKey(sessionId, input)
        if (this.closedKeys.has(cacheKey)) {
            throw new Error('Connection namespace closed')
        }
        return this.acquireSession(sessionId, input)
    }

    private connectionKey(sessionId: string, input: CodexAcquireInput): string {
        return buildConnectionCacheKey(
            input.connectionNamespace ?? DEFAULT_CONNECTION_NAMESPACE,
            sessionId,
        )
    }

    /** Test helper: whether a cache identity is permanently tombstoned. */
    isKeyClosed(cacheKey: string): boolean {
        return this.closedKeys.has(cacheKey)
    }

    /** When the opaque namespace changes for the same logical session, cancel the previous socket. */
    private evictStaleIdentity(sessionId: string, nextKey: string): void {
        const prevKey = this.logicalSessionKeys.get(sessionId)
        if (prevKey && prevKey !== nextKey) {
            const prev = this.sessions.get(prevKey)
            if (prev) {
                void this.closeSocket(prev, { cancel: true })
            }
            // Reject queued waiters on the old identity; do not delete while busy.
            this.closeLock(prevKey, 'Connection identity changed')
        }
        this.logicalSessionKeys.set(sessionId, nextKey)
    }

    private async acquireIsolated(input: CodexAcquireInput): Promise<CodexConnectionLease> {
        const requestId = input.requestId ?? this.generateRequestId()
        const prepared = await this.connectWithFirstProtocol(input, requestId, undefined)
        return this.makeIsolatedLease(prepared.socket, prepared.queue, prepared.body)
    }

    private async acquireSession(
        sessionId: string,
        input: CodexAcquireInput,
    ): Promise<CodexConnectionLease> {
        const cacheKey = this.connectionKey(sessionId, input)
        this.evictStaleIdentity(sessionId, cacheKey)
        await this.acquireLock(cacheKey, input.signal)

        try {
            const prepared = await this.prepareSessionSocket(
                sessionId,
                cacheKey,
                input,
            )
            return this.makeSessionLease(
                cacheKey,
                prepared.socket,
                prepared.queue,
                prepared.body,
            )
        } catch (error) {
            this.releaseLock(cacheKey)
            throw error
        }
    }

    /**
     * Session path: try cached send + first-protocol, else fresh connect retries.
     * Total pre-response attempts (including cached) are capped at MAX_CONNECT_RETRIES.
     * Cache keys are connection identities; request headers still use the real sessionId.
     */
    private async prepareSessionSocket(
        sessionId: string,
        cacheKey: string,
        input: CodexAcquireInput,
    ): Promise<{ socket: LiveSocket; queue: ResponseEventQueue; body: CodexResponseCreate }> {
        let lastError: unknown

        for (let attempt = 0; attempt < MAX_CONNECT_RETRIES; attempt += 1) {
            if (this.disposed) {
                throw new Error('Connection manager disposed')
            }
            if (input.signal.aborted) {
                throw new Error('Request was aborted')
            }

            let entry = this.sessions.get(cacheKey)
            if (entry) {
                this.evictIfExpired(cacheKey, entry)
                entry = this.sessions.get(cacheKey)
                if (entry?.closed) {
                    this.sessions.delete(cacheKey)
                    entry = undefined
                }
            }

            let socket: LiveSocket | undefined = entry && !entry.closed ? entry : undefined
            let body = buildRequestBody(input.request, socket?.continuation).body
            let usedCache = false

            try {
                if (socket) {
                    usedCache = true
                    const built = buildRequestBody(input.request, socket.continuation)
                    body = built.body
                    if (built.clearContinuation) {
                        socket.continuation = undefined
                    }
                    // Attach before send so a fast first frame cannot look unsolicited.
                    const queue = this.attachResponseQueue(socket)
                    try {
                        await this.sendAndAwaitFirstProtocol(socket, body, queue, input.signal)
                    } catch (errorSend) {
                        // If first protocol already arrived, keep the lease for the parser.
                        if (queue.hasFirstProtocol) {
                            socket.lastUsedAt = this.now()
                            return { socket, queue, body }
                        }
                        if (socket.currentQueue === queue && !queue.isSettled) {
                            queue.fail(this.asError(errorSend))
                        }
                        if (socket.currentQueue === queue) {
                            socket.currentQueue = undefined
                        }
                        throw errorSend
                    }
                    socket.lastUsedAt = this.now()
                    return { socket, queue, body }
                }
            } catch (error) {
                lastError = error
                if (socket) {
                    // Only cleanup/retry when first protocol never started.
                    const activeQueue = socket.currentQueue
                    if (!activeQueue?.hasFirstProtocol) {
                        await this.closeSocket(socket, {
                            cancel: true,
                            error: this.asError(error),
                        })
                        if (this.sessions.get(cacheKey) === socket) {
                            this.sessions.delete(cacheKey)
                        }
                    }
                }
                if (isAbortError(error, input.signal) || input.signal.aborted) {
                    throw error instanceof Error ? error : new Error('Request was aborted')
                }
                // Cached pre-response failure consumes this attempt; retry fresh below on next loop.
                if (usedCache && attempt + 1 < MAX_CONNECT_RETRIES) {
                    continue
                }
                if (usedCache) {
                    break
                }
            }

            // Fresh connect attempt (open handshake + send + first protocol).
            // requestId / headers keep the real sessionId; cache uses identity key.
            try {
                const requestId = input.requestId ?? sessionId
                const prepared = await this.runConnectAttempt(
                    input,
                    requestId,
                    cacheKey,
                )
                // Closed terminal leases may be returned for consumption but must not be cached.
                if (!prepared.socket.closed && !prepared.socket.forceEvict) {
                    this.sessions.set(cacheKey, prepared.socket)
                }
                return prepared
            } catch (error) {
                lastError = error
                if (isAbortError(error, input.signal) || input.signal.aborted) {
                    throw error instanceof Error ? error : new Error('Request was aborted')
                }
                if (attempt + 1 >= MAX_CONNECT_RETRIES) {
                    break
                }
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`WebSocket connect failed: ${String(lastError)}`)
    }

    private makeIsolatedLease(
        socket: LiveSocket,
        queue: ResponseEventQueue,
        body: CodexResponseCreate,
    ): CodexConnectionLease {
        let finished = false

        const finish = async (): Promise<void> => {
            if (finished) {
                return
            }
            finished = true
            await this.closeSocket(socket, { cancel: true })
        }

        return {
            operationId: socket.operationId,
            requestBody: body,
            events: queue.asIterable(),
            commit: () => {
                // Isolated mode never writes session continuation.
            },
            release: async () => {
                await finish()
            },
            cancel: async () => {
                await finish()
            },
        }
    }

    private makeSessionLease(
        sessionId: string,
        socket: LiveSocket,
        queue: ResponseEventQueue,
        body: CodexResponseCreate,
    ): CodexConnectionLease {
        let finished = false
        let committed = false
        let commitPayload: CodexCommitInput | undefined
        const active = socket

        /**
         * Shared idempotent finish latch for release/cancel (any order, concurrent-safe).
         * At most one cleanup and one releaseLock. Late cancel after keep-release is a no-op.
         */
        const finish = async (keep: boolean): Promise<void> => {
            if (finished) {
                return
            }
            finished = true

            if (!keep || active.closed || active.forceEvict) {
                await this.closeSocket(active, { cancel: true })
                this.releaseLock(sessionId)
                return
            }

            if (committed && commitPayload) {
                active.continuation = {
                    lastRequestBody: deepClone(commitPayload.fullRequestBody),
                    lastResponseId: commitPayload.responseId,
                    lastResponseItems: deepClone([...commitPayload.responseItems]),
                }
            }
            active.lastUsedAt = this.now()
            this.releaseLock(sessionId)
        }

        return {
            operationId: active.operationId,
            requestBody: body,
            events: queue.asIterable(),
            commit: (payload) => {
                committed = true
                commitPayload = payload
            },
            release: async (options) => {
                await finish(options?.keep ?? true)
            },
            cancel: async () => {
                await finish(false)
            },
        }
    }

    private getLock(sessionId: string): SessionLock {
        let lock = this.locks.get(sessionId)
        if (!lock) {
            lock = { busy: false, closed: false, queue: [] }
            this.locks.set(sessionId, lock)
        }
        return lock
    }

    /**
     * Close a lock key: reject all queued waiters and permanently tombstone the identity.
     * Does not allow reopen — closedKeys keeps the reject forever (manager lifetime).
     * Lock entry may be deleted when idle, but acquire always checks closedKeys first.
     */
    private closeLock(sessionId: string, reason: string): void {
        this.closedKeys.add(sessionId)
        const lock = this.locks.get(sessionId)
        if (!lock) {
            return
        }
        lock.closed = true
        lock.closeReason = reason
        const waiters = lock.queue.splice(0)
        for (const waiter of waiters) {
            try {
                waiter.signal.removeEventListener('abort', waiter.onAbort)
            } catch {
                // best-effort
            }
            waiter.reject(new Error(reason))
        }
        if (!lock.busy) {
            this.locks.delete(sessionId)
        }
    }

    private async acquireLock(sessionId: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted) {
            throw new Error('Request was aborted')
        }
        // Permanent tombstone: never recreate a lock for a closed namespace/key.
        if (this.closedKeys.has(sessionId)) {
            throw new Error('Connection namespace closed')
        }
        const lock = this.getLock(sessionId)
        if (lock.closed || this.closedKeys.has(sessionId)) {
            throw new Error(lock.closeReason ?? 'Connection namespace closed')
        }
        if (!lock.busy) {
            lock.busy = true
            return
        }

        await new Promise<void>((resolve, reject) => {
            const waiter: SessionLockWaiter = {
                resolve: () => {
                    signal.removeEventListener('abort', waiter.onAbort)
                    resolve()
                },
                reject: (error) => {
                    signal.removeEventListener('abort', waiter.onAbort)
                    reject(error)
                },
                signal,
                onAbort: () => {
                    const idx = lock.queue.indexOf(waiter)
                    if (idx >= 0) {
                        lock.queue.splice(idx, 1)
                    }
                    signal.removeEventListener('abort', waiter.onAbort)
                    reject(new Error('Request was aborted'))
                },
            }
            if (signal.aborted) {
                reject(new Error('Request was aborted'))
                return
            }
            // Re-check closed after constructing waiter: identity may have rotated.
            if (lock.closed) {
                reject(new Error(lock.closeReason ?? 'Connection lock closed'))
                return
            }
            signal.addEventListener('abort', waiter.onAbort)
            lock.queue.push(waiter)
        })
        // Holder may have closed the lock while we waited.
        if (lock.closed) {
            lock.busy = false
            if (lock.queue.length === 0) {
                this.locks.delete(sessionId)
            }
            throw new Error(lock.closeReason ?? 'Connection lock closed')
        }
        lock.busy = true
    }

    private releaseLock(sessionId: string): void {
        const lock = this.locks.get(sessionId)
        if (!lock) return
        if (lock.closed) {
            // Drain any residual waiters (should be empty after closeLock) and delete.
            for (const waiter of lock.queue.splice(0)) {
                try {
                    waiter.signal.removeEventListener('abort', waiter.onAbort)
                } catch {
                    // best-effort
                }
                waiter.reject(
                    new Error(lock.closeReason ?? 'Connection lock closed'),
                )
            }
            lock.busy = false
            this.locks.delete(sessionId)
            return
        }
        const next = lock.queue.shift()
        if (next) {
            // Keep busy=true for the next waiter; they run immediately.
            next.resolve()
            return
        }
        lock.busy = false
    }

    private evictIfExpired(sessionId: string, entry: LiveSocket): void {
        const now = this.now()
        if (now - entry.createdAt >= MAX_AGE_MS || now - entry.lastUsedAt >= IDLE_TTL_MS) {
            void this.closeSocket(entry, { cancel: true })
            if (this.sessions.get(sessionId) === entry) {
                this.sessions.delete(sessionId)
            }
        }
    }

    /**
     * Unified socket close path: fail active queue, cancel-once, iterator.return-once.
     * Idempotent via closePromise latch. Pump callers must not await this (void it).
     */
    private closeSocket(
        socket: LiveSocket,
        options: { cancel: boolean; error?: Error },
    ): Promise<void> {
        if (socket.closePromise) {
            return socket.closePromise
        }

        socket.closed = true
        socket.continuation = undefined
        if (options.cancel) {
            socket.forceEvict = true
        }
        if (socket.sessionId && this.sessions.get(socket.sessionId) === socket) {
            this.sessions.delete(socket.sessionId)
        }
        // Isolated and session sockets both drop from live tracking on close.
        this.liveSockets.delete(socket)
        if (socket.currentQueue && !socket.currentQueue.isSettled) {
            socket.currentQueue.fail(
                options.error ?? new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED),
            )
        }
        socket.currentQueue = undefined
        socket.readyQueue = undefined

        socket.closePromise = (async () => {
            if (options.cancel) {
                await this.cancelSocketOnce(socket)
            }
            if (!socket.iteratorReturnLatched) {
                socket.iteratorReturnLatched = true
                try {
                    await socket.iterator.return?.()
                } catch {
                    // best-effort
                }
            }
        })()

        return socket.closePromise
    }

    private trackLiveSocket(socket: LiveSocket): void {
        this.liveSockets.add(socket)
    }

    private async cancelSocketOnce(socket: LiveSocket): Promise<void> {
        if (socket.cancelLatched) {
            return
        }
        socket.cancelLatched = true
        if (typeof this.bridge.cancel === 'function') {
            await this.bridge.cancel(socket.operationId).catch(() => {
                // best-effort
            })
        } else if (typeof this.bridge.cancelOperation === 'function') {
            await this.bridge.cancelOperation(socket.operationId).catch(() => {
                // best-effort
            })
        }
    }

    /**
     * Cleanup a late-resolved open operation that was never claimed as a LiveSocket.
     * When Task 6 already cancelled via the open binding signal, skip a second cancel.
     */
    private async cleanupUnclaimedOperation(
        operation: NativeOperation,
        alreadyCancelled: boolean,
    ): Promise<void> {
        if (!alreadyCancelled) {
            if (typeof this.bridge.cancel === 'function') {
                await this.bridge.cancel(operation.operationId).catch(() => {
                    // best-effort
                })
            } else if (typeof this.bridge.cancelOperation === 'function') {
                await this.bridge.cancelOperation(operation.operationId).catch(() => {
                    // best-effort
                })
            }
        }
        try {
            const iterator = operation.events[Symbol.asyncIterator]()
            await iterator.return?.()
        } catch {
            // best-effort — iterator may already be taken or closed
        }
    }

    private async connectWithFirstProtocol(
        input: CodexAcquireInput,
        requestId: string,
        sessionId: string | undefined,
    ): Promise<{ socket: LiveSocket; queue: ResponseEventQueue; body: CodexResponseCreate }> {
        let lastError: unknown
        for (let attempt = 0; attempt < MAX_CONNECT_RETRIES; attempt += 1) {
            if (input.signal.aborted) {
                throw new Error('Request was aborted')
            }
            try {
                return await this.runConnectAttempt(input, requestId, sessionId)
            } catch (error) {
                lastError = error
                if (isAbortError(error, input.signal) || input.signal.aborted) {
                    throw error instanceof Error ? error : new Error('Request was aborted')
                }
                if (attempt + 1 >= MAX_CONNECT_RETRIES) {
                    break
                }
            }
        }
        throw lastError instanceof Error
            ? lastError
            : new Error(`WebSocket connect failed: ${String(lastError)}`)
    }

    private abortError(timedOut: boolean): Error {
        if (timedOut) {
            return new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
        }
        return new Error('Request was aborted')
    }

    /**
     * Race an underlying promise against AbortSignal.
     * Always removes the abort listener on underlying win, abort win, or throw.
     * When the signal is already aborted, still observe the underlying settlement so a
     * late rejection cannot become unhandled (late fulfill cleanup stays with the caller).
     */
    private raceAbortable<T>(
        promise: Promise<T>,
        signal: AbortSignal,
        options?: { timedOut?: () => boolean; timeoutStyle?: boolean },
    ): Promise<T> {
        const rejectAbort = (): Error => {
            if (options?.timeoutStyle) {
                return this.abortError(options.timedOut?.() ?? false)
            }
            return new Error('Request was aborted')
        }

        if (signal.aborted) {
            // Observe settlement even when we reject immediately.
            void promise.then(
                () => {
                    // late fulfill — resource cleanup is owned by the caller
                },
                () => {
                    // swallow late rejection
                },
            )
            return Promise.reject(rejectAbort())
        }

        return new Promise<T>((resolve, reject) => {
            let settled = false
            const onAbort = (): void => {
                if (settled) {
                    return
                }
                settled = true
                signal.removeEventListener('abort', onAbort)
                // Keep observing the underlying promise after abort wins.
                void promise.then(
                    () => {
                        // late fulfill — caller owns resource cleanup
                    },
                    () => {
                        // swallow late rejection
                    },
                )
                reject(rejectAbort())
            }
            signal.addEventListener('abort', onAbort)
            promise.then(
                (value) => {
                    if (settled) {
                        return
                    }
                    settled = true
                    signal.removeEventListener('abort', onAbort)
                    resolve(value)
                },
                (error: unknown) => {
                    if (settled) {
                        return
                    }
                    settled = true
                    signal.removeEventListener('abort', onAbort)
                    reject(error)
                },
            )
        })
    }

    private asError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error))
    }

    /**
     * Cancel + iterator.return once for a disposed/late pre-open attempt.
     * Never installs a lease or cache entry. Does not await a never-resolving open
     * (dispose must stay non-blocking); late fulfill still cleans exactly once.
     */
    private async cleanupOpenAttempt(attempt: OpenAttempt): Promise<void> {
        if (attempt.cleaned) {
            return
        }
        attempt.cleaned = true
        this.openAttempts.delete(attempt)
        try {
            attempt.controller.abort()
        } catch {
            // best-effort
        }
        // Observe late settle without pinning dispose on a hanging open.
        void attempt.promise.then(
            (operation) =>
                this.cleanupUnclaimedOperation(
                    operation,
                    /* alreadyCancelled */ true,
                ),
            () => {
                // open rejected — nothing to clean
            },
        )
    }

    /**
     * One connect attempt: open+wait-open under CONNECT_TIMEOUT_MS, then send + first-protocol
     * under parent Abort only (model first token is not connect-timed).
     *
     * Cancel ownership:
     * - Open binding signal covers only the pre-resolve phase (Task 6 may cancel once).
     * - After open resolves, unlink that signal path; manager owns wait-open/send/pump cancel.
     * - Pre-open attempts are tracked so manager.dispose can abort + late-resolve cleanup once.
     */
    private async runConnectAttempt(
        input: CodexAcquireInput,
        requestId: string,
        sessionId: string | undefined,
    ): Promise<{ socket: LiveSocket; queue: ResponseEventQueue; body: CodexResponseCreate }> {
        if (this.disposed) {
            throw new Error('Connection manager disposed')
        }
        const openController = new AbortController()
        // When true, parent/timeout may abort openController (binding phase only).
        let openSignalLinked = true
        let parentOpenListening = false
        let parentWaitListening = false
        const onParentAbortOpen = (): void => {
            if (openSignalLinked) {
                openController.abort()
            }
        }
        if (input.signal.aborted) {
            throw new Error('Request was aborted')
        }
        input.signal.addEventListener('abort', onParentAbortOpen)
        parentOpenListening = true

        const detachParentOpen = (): void => {
            if (!parentOpenListening) {
                return
            }
            parentOpenListening = false
            input.signal.removeEventListener('abort', onParentAbortOpen)
        }

        // Post-resolve wait phase uses a separate controller that never touches Task 6.
        const waitController = new AbortController()
        const onParentAbortWait = (): void => {
            waitController.abort()
        }
        const detachParentWait = (): void => {
            if (!parentWaitListening) {
                return
            }
            parentWaitListening = false
            input.signal.removeEventListener('abort', onParentAbortWait)
        }

        let timedOut = false
        let timer: unknown
        let socket: LiveSocket | undefined
        let openOwned = false

        // Track attempt BEFORE bridge open so dispose can abort never-resolving opens.
        const operationId = this.generateRequestId()
        if (!this.bridge.openWebSocket) {
            throw new Error('openWebSocket is unavailable on bridge')
        }
        const openPromise = this.bridge.openWebSocket({
            operationId,
            url: resolveCodexWebSocketUrl(input.baseUrl),
            headers: buildWebSocketHeaders(input.apiKey, requestId),
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
            signal: openController.signal,
        })
        const attempt: OpenAttempt = {
            operationId,
            controller: openController,
            promise: openPromise,
            disposed: this.disposed,
            cleaned: false,
        }
        this.openAttempts.add(attempt)
        if (this.disposed) {
            attempt.disposed = true
            openController.abort()
            void this.cleanupOpenAttempt(attempt)
            throw new Error('Connection manager disposed')
        }

        try {
            timer = this.schedule(() => {
                timedOut = true
                if (openSignalLinked) {
                    openController.abort()
                } else {
                    waitController.abort()
                }
            }, CONNECT_TIMEOUT_MS)

            const operation = await this.raceAbortable(openPromise, openController.signal, {
                timedOut: () => timedOut,
                timeoutStyle: true,
            })

            // Late open after dispose: cancel once, never lease/cache.
            if (this.disposed || attempt.disposed) {
                openSignalLinked = false
                detachParentOpen()
                await this.cleanupOpenAttempt(attempt)
                throw new Error('Connection manager disposed')
            }

            // Open resolve and timeout/parent abort may settle in the same microtask.
            // Re-check immediately: if timed out or aborted, never enter waitForOpen.
            const attemptTimedOut = timedOut
            const openSignalAlreadyAborted = openController.signal.aborted
            const parentAlreadyAborted = input.signal.aborted
            if (attemptTimedOut || openSignalAlreadyAborted || parentAlreadyAborted) {
                // Binding-stage signal owns cancel when it already aborted; manager only cleans
                // iterator and must not double-cancel. Claim socket so catch runs close once.
                openSignalLinked = false
                detachParentOpen()
                this.openAttempts.delete(attempt)
                const iterator = operation.events[Symbol.asyncIterator]()
                socket = {
                    operationId: operation.operationId,
                    operation,
                    iterator,
                    createdAt: this.now(),
                    lastUsedAt: this.now(),
                    opened: false,
                    closed: false,
                    sessionId,
                    pumpStarted: false,
                    cancelLatched: openSignalAlreadyAborted,
                    iteratorReturnLatched: false,
                    forceEvict: false,
                    responseStarted: false,
                }
                this.trackLiveSocket(socket)
                openOwned = true
                if (attemptTimedOut) {
                    throw new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
                }
                throw new Error('Request was aborted')
            }

            // Open resolved cleanly — stop open-signal path; manager owns subsequent cancel.
            openSignalLinked = false
            detachParentOpen()
            this.openAttempts.delete(attempt)

            const iterator = operation.events[Symbol.asyncIterator]()
            socket = {
                operationId: operation.operationId,
                operation,
                iterator,
                createdAt: this.now(),
                lastUsedAt: this.now(),
                opened: false,
                closed: false,
                sessionId,
                pumpStarted: false,
                // Task 6 may already have cancelled via the open binding signal.
                cancelLatched: false,
                iteratorReturnLatched: false,
                forceEvict: false,
                responseStarted: false,
            }
            this.trackLiveSocket(socket)
            openOwned = true

            // Arm parent abort for wait-open without re-linking Task 6 open signal.
            if (input.signal.aborted) {
                waitController.abort()
            } else {
                input.signal.addEventListener('abort', onParentAbortWait)
                parentWaitListening = true
            }

            try {
                await this.raceAbortable(this.waitForOpen(socket), waitController.signal, {
                    timedOut: () => timedOut,
                    timeoutStyle: true,
                })
                // Same-tick recheck: timeout/parent abort after wait race must not proceed.
                if (timedOut || waitController.signal.aborted || input.signal.aborted) {
                    if (timedOut) {
                        throw new Error(
                            `WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`,
                        )
                    }
                    throw new Error('Request was aborted')
                }
            } finally {
                detachParentWait()
            }

            // Handshake complete — clear connect timeout before send / first token.
            if (timer !== undefined) {
                this.cancelSchedule(timer)
                timer = undefined
            }

            socket.opened = true
            // Attach + start pump before send so first protocol can arrive while send is pending.
            const queue = this.attachResponseQueue(socket)
            this.startPump(socket)

            const built = buildRequestBody(input.request, undefined)
            try {
                await this.sendAndAwaitFirstProtocol(socket, built.body, queue, input.signal)
            } catch (errorSend) {
                // First protocol already arrived: keep lease for parser; do not cleanup/retry.
                if (queue.hasFirstProtocol) {
                    socket.lastUsedAt = this.now()
                    return { socket, queue, body: built.body }
                }
                throw errorSend
            }

            socket.lastUsedAt = this.now()
            return { socket, queue, body: built.body }
        } catch (error) {
            if (socket && openOwned) {
                this.openAttempts.delete(attempt)
                await this.closeSocket(socket, {
                    cancel: true,
                    error: this.asError(error),
                })
            } else {
                // Open never claimed / late after dispose: cancel + iterator.return once.
                void this.cleanupOpenAttempt(attempt)
            }
            if (this.disposed || attempt.disposed) {
                throw new Error('Connection manager disposed')
            }
            if (timedOut || isTimeoutMessage(error)) {
                throw new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
            }
            if (isAbortError(error, input.signal) || input.signal.aborted) {
                throw error instanceof Error ? error : new Error('Request was aborted')
            }
            throw error
        } finally {
            openSignalLinked = false
            if (timer !== undefined) {
                this.cancelSchedule(timer)
            }
            detachParentOpen()
            detachParentWait()
            // Successful claim already deleted the attempt; leave disposed path to cleanup.
            if (openOwned) {
                this.openAttempts.delete(attempt)
            }
        }
    }

    private async waitForOpen(socket: LiveSocket): Promise<void> {
        while (true) {
            if (socket.closed) {
                throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
            }
            const next = await socket.iterator.next()
            if (socket.closed) {
                throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
            }
            if (next.done) {
                throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
            }
            const event = next.value
            if (event.kind === 'websocket-open') {
                return
            }
            if (event.kind === 'error') {
                throw new Error(event.error || 'WebSocket error')
            }
            if (event.kind === 'cancelled') {
                throw new Error('Request was aborted')
            }
            if (event.kind === 'done') {
                throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
            }
            if (event.kind === 'websocket-binary') {
                throw new Error('Codex WebSocket binary frames are not supported')
            }
            if (event.kind === 'websocket-text') {
                // Invalid sequencing before open — treat as connect failure.
                throw new Error('Received websocket-text before websocket-open')
            }
        }
    }

    /**
     * Send and wait for the first valid protocol frame.
     * If first protocol arrives while send is still pending, a later send reject does not
     * fail the lease (no retry/duplicate). Abort abandons send and cleans listeners.
     */
    private async sendAndAwaitFirstProtocol(
        socket: LiveSocket,
        body: CodexResponseCreate,
        queue: ResponseEventQueue,
        signal: AbortSignal,
    ): Promise<void> {
        if (signal.aborted) {
            throw new Error('Request was aborted')
        }
        if (socket.closed) {
            throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
        }

        let abandoned = false
        let sendFailed: Error | undefined
        if (!this.bridge.sendWebSocket) {
            throw new Error('sendWebSocket is unavailable on bridge')
        }
        const sendPromise = this.bridge.sendWebSocket(
            socket.operationId,
            JSON.stringify(body),
        )

        // Monitor send without racing it against first-protocol success.
        void sendPromise.then(
            () => {
                // send ok
            },
            (error: unknown) => {
                if (abandoned || queue.hasFirstProtocol) {
                    // Late reject after first protocol or abort: swallow (no retry).
                    return
                }
                sendFailed = this.asError(error)
                if (!queue.isSettled) {
                    queue.fail(sendFailed)
                }
            },
        )

        try {
            await this.raceAbortable(queue.firstProtocol, signal)
        } catch (error) {
            if (isAbortError(error, signal) || signal.aborted) {
                abandoned = true
                void sendPromise.catch(() => {
                    // swallow late rejection
                })
                throw new Error('Request was aborted')
            }
            if (sendFailed) {
                throw sendFailed
            }
            throw error
        }

        // First protocol arrived — abandon late send outcomes.
        abandoned = true
        void sendPromise.catch(() => {
            // swallow late rejection
        })

        if (!queue.hasFirstProtocol && queue.isSettled) {
            throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
        }
    }

    private attachResponseQueue(socket: LiveSocket): ResponseEventQueue {
        if (socket.closed) {
            throw new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED)
        }
        if (socket.readyQueue) {
            const ready = socket.readyQueue
            socket.readyQueue = undefined
            if (!ready.isSettled) {
                socket.currentQueue = ready
            }
            // New response generation must re-gate on lifecycle start.
            socket.responseStarted = false
            return ready
        }
        if (socket.currentQueue && !socket.currentQueue.isSettled) {
            throw new Error('Session already has an active response queue')
        }

        const queue = new ResponseEventQueue()
        socket.currentQueue = queue
        socket.responseStarted = false
        return queue
    }

    private startPump(socket: LiveSocket): void {
        if (socket.pumpStarted) {
            return
        }
        socket.pumpStarted = true
        void this.runPump(socket)
    }

    private async runPump(socket: LiveSocket): Promise<void> {
        try {
            while (!socket.closed) {
                const next = await socket.iterator.next()
                if (socket.closed) {
                    return
                }
                if (next.done) {
                    // Do not await close from inside the pump (avoid self-deadlock).
                    this.handlePhysicalFailure(
                        socket,
                        new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED),
                        false,
                    )
                    return
                }
                this.handleNativeEvent(socket, next.value)
            }
        } catch (error) {
            if (socket.closed) {
                return
            }
            this.handlePhysicalFailure(
                socket,
                error instanceof Error ? error : new Error(String(error)),
                false,
            )
        }
    }

    private handleNativeEvent(socket: LiveSocket, event: NativeEvent): void {
        if (socket.closed) {
            return
        }

        if (event.kind === 'websocket-binary') {
            this.handlePhysicalFailure(
                socket,
                new Error('Codex WebSocket binary frames are not supported'),
                true,
            )
            return
        }
        if (event.kind === 'cancelled') {
            this.handlePhysicalFailure(socket, new Error('Request was aborted'), false)
            return
        }
        if (event.kind === 'error') {
            this.handlePhysicalFailure(
                socket,
                new Error(event.error || 'WebSocket error'),
                true,
            )
            return
        }
        if (event.kind === 'done') {
            this.handlePhysicalFailure(
                socket,
                new Error(CODEX_STREAM_CLOSED_BEFORE_COMPLETED),
                false,
            )
            return
        }
        if (event.kind === 'websocket-open') {
            // Already opened; ignore late open frames.
            return
        }
        if (event.kind !== 'websocket-text') {
            return
        }

        const raw = event.data ?? ''
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause)
            this.handlePhysicalFailure(
                socket,
                new Error(`Invalid Codex WebSocket JSON: ${detail}`),
                true,
            )
            return
        }

        const type = protocolType(parsed)
        if (isConnectionMetadataFrame(type)) {
            return
        }

        const queue = socket.currentQueue
        if (!queue || queue.isSettled) {
            // No active response queue: any protocol frame is a stale/unsolicited violation.
            // Never buffer across turns.
            this.handlePhysicalFailure(
                socket,
                new Error('Unsolicited Codex protocol frame while idle'),
                true,
            )
            return
        }

        this.routeProtocolEvent(socket, queue, parsed)
    }

    private routeProtocolEvent(
        socket: LiveSocket,
        queue: ResponseEventQueue,
        parsed: unknown,
    ): void {
        // JSON.parse success is not a protocol frame by itself.
        if (!isValidProtocolFrame(parsed)) {
            const error = new Error('Invalid Codex protocol frame')
            if (!queue.hasFirstProtocol) {
                // Before first: treat as pre-response failure (cleanup + retry).
                this.handlePhysicalFailure(socket, error, true)
                return
            }
            // After first: fail the active response and evict; do not reconnect-retry.
            queue.fail(error)
            if (socket.currentQueue === queue) {
                socket.currentQueue = undefined
            }
            socket.responseStarted = false
            void this.closeSocket(socket, { cancel: true, error })
            return
        }

        const type = protocolType(parsed)
        const responseId = extractResponseId(parsed)

        // Response-generation start gate: only lifecycle start / terminal-only may open a turn.
        if (!socket.responseStarted) {
            if (!isResponseLifecycleStart(type)) {
                this.handlePhysicalFailure(
                    socket,
                    new Error('Stale Codex protocol frame before response start'),
                    true,
                )
                return
            }
            if (
                responseId &&
                socket.lastCompletedResponseId &&
                responseId === socket.lastCompletedResponseId
            ) {
                this.handlePhysicalFailure(
                    socket,
                    new Error('Stale Codex response id replay'),
                    true,
                )
                return
            }
            socket.responseStarted = true
        }

        // Legal first-frame failed/error is a terminal delivered to the parser.
        queue.push(parsed)

        if (isProtocolSuccessTerminal(type)) {
            queue.end()
            if (responseId) {
                socket.lastCompletedResponseId = responseId
            }
            socket.responseStarted = false
            if (socket.currentQueue === queue) {
                socket.currentQueue = undefined
            }
            // Pump continues for the next turn on the same native iterator.
            return
        }

        if (isProtocolFailureTerminal(type)) {
            queue.end()
            socket.responseStarted = false
            if (socket.currentQueue === queue) {
                socket.currentQueue = undefined
            }
            // Conservative: fail the connection after failed/error terminals.
            socket.forceEvict = true
            // Fire-and-forget close from pump-driven path.
            void this.closeSocket(socket, { cancel: true })
        }
    }

    private handlePhysicalFailure(
        socket: LiveSocket,
        error: Error,
        cancelSocket: boolean,
    ): void {
        if (socket.closed && !socket.currentQueue) {
            return
        }
        // Never await from pump — close path is async and idempotent.
        void this.closeSocket(socket, { cancel: cancelSocket, error })
    }
}
