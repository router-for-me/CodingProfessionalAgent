/**
 * Production composition root for the standalone CLIProxyAPI agent runtime.
 * Owns NativeBridge-backed resources, CPA clients, AgentLoop, and approvals.
 * Does not import or read Zustand / React.
 */

import type { ModelCatalogEntry } from '@/features/models/types'
import type { AgentService } from '@/features/agent/AgentService'
import {
    AgentPreflightError,
    type AgentCompactInput,
    type AgentCompactResult,
    type AgentPrepareInput,
    type AgentStreamChatInput,
    type PreparedAgentRun,
} from '@/features/agent/types'
import {
    AgentLoop,
    type AgentLoopDependencies,
    type AgentRunInput,
} from './agent/agentLoop'
import { ApprovalController } from './agent/approvals'
import type { AgentRunEvent, AgentTool } from './agent/types'
import { RunScopedModelInvoker } from './agent/isolatedModelInvoker'
import {
    compactConversation,
    type CompactConversationOptions,
    type CompactConversationResult,
} from './context/compaction'
import { compactionSettingsFromThresholdPercent } from './context/tokenEstimate'
import {
    type LoadResourceSnapshotInput,
    type ResourceDiagnostic,
    type ResourceSnapshot,
} from './context/resourceLoader'
import type { NativeBridge, RuntimeInfo } from './native/types'
import { canonicalizeBaseUrl } from './context/baseUrl'
import {
    rendererRegistry,
    type RendererRegistry,
} from '@/plugins/platform/rendererRegistry'
import {
    agentRegistry,
} from '@/plugins/platform/AgentPluginRuntimeHost'
import type { ProtocolClient, ProtocolSession, ConversationEntry } from '@cpa/plugin-api'
import {
    DEFAULT_SUBAGENT_SETTINGS,
    type SubagentsSettings,
} from '@/types/models'
import {
    isAbsolutePath,
    resolveToCwd,
    expandUserEntrySkills,
    expandUserSkillEntries,
} from '@cpa/plugin-sdk'
import {
    createToolsFromProviders,
    type CreateCodingToolsOptions,
} from './providers/ToolFactoryProvider'
import {
    loadResourcesFromProviders,
} from './providers/ResourceProvider'
import {
    createWorktreeRunPolicy,
    type WorktreeRunPolicy,
} from './context/worktreeMode'
import {
    augmentSystemPromptForSessionTitle,
    SET_SESSION_TITLE_TOOL_NAME,
} from './context/systemPrompt'
import {
    SubAgentHost,
    codingToolsOnly,
    isSubAgentToolName,
    resolveChildReasoning,
    type SubAgentRunRequest,
} from './host/SubAgentHost'
import { HookProvider } from './providers/HookProvider'
import { AgentProviderRegistry } from './providers/AgentProviderRegistry'
import {
    disposeGenerationSnapshot,
    type AgentGenerationSnapshot,
} from './providers/generationSnapshot'

export interface ProtocolConnectionManager {
    dispose(): Promise<void> | void
    [key: string]: any
}

export interface CLIProxyAPIAgentServiceDependencies {
    bridge: NativeBridge
    /** Optional extension registry for protocol providers, middlewares, and dynamic tools. */
    extensionRegistry?: RendererRegistry
    /** Factory so tests can inject custom streams. */
    createClient?: (
        options: any,
    ) => ProtocolClient | any
    createConnectionManager?: (
        bridge: NativeBridge,
        providerId?: string,
    ) => ProtocolConnectionManager | null | undefined
    loadResources?: (
        input: LoadResourceSnapshotInput,
    ) => Promise<ResourceSnapshot>
    createTools?: (
        cwd: string | undefined | null,
        bridge: NativeBridge,
        model: ModelCatalogEntry,
        options?: CreateCodingToolsOptions,
    ) => Promise<AgentTool[]>
    createLoop?: (deps: AgentLoopDependencies) => AgentLoop
    compact?: (
        entries: readonly ConversationEntry[],
        options: CompactConversationOptions,
    ) => Promise<CompactConversationResult>
    now?: () => number
    generateId?: () => string
    /**
     * Bounded wait for old manager dispose during config rotation.
     * After timeout the new manager is installed; old dispose stays observed.
     * Production default: 5000ms.
     */
    disposeTimeoutMs?: number
    /**
     * Minimum interval between full assistant snapshots exposed to UI consumers.
     * Production default: 100ms.
     */
    streamUpdateIntervalMs?: number
    /**
     * Injectable delay for dispose timeout (tests use a fake scheduler).
     * Must reject with AbortError when signal aborts.
     */
    delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000
const DEFAULT_STREAM_UPDATE_INTERVAL_MS = 200

function monotonicNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

type AssistantUpdateEvent = Extract<
    AgentRunEvent,
    { type: 'assistant-update' }
>

function isDeltaAssistantUpdate(
    event: AgentRunEvent,
): event is AssistantUpdateEvent {
    return (
        event.type === 'assistant-update' &&
        (event.streamEvent.type === 'text-delta' ||
            event.streamEvent.type === 'thinking-delta' ||
            event.streamEvent.type === 'toolcall-delta')
    )
}

function mergeAssistantDeltas(
    previous: AssistantUpdateEvent,
    next: AssistantUpdateEvent,
): AssistantUpdateEvent | null {
    const previousStream = previous.streamEvent
    const nextStream = next.streamEvent
    if (
        !('delta' in previousStream) ||
        !('delta' in nextStream) ||
        previousStream.type !== nextStream.type ||
        previousStream.contentIndex !== nextStream.contentIndex
    ) {
        return null
    }
    return {
        ...next,
        streamEvent: {
            ...nextStream,
            delta: previousStream.delta + nextStream.delta,
        },
    }
}

/**
 * Keep cumulative assistant snapshots responsive without cloning and rendering
 * one increasingly large entry for every provider token. Consecutive deltas
 * are concatenated so stream consumers still observe the complete data.
 */
async function* throttleAssistantUpdates(
    events: AsyncIterable<AgentRunEvent>,
    intervalMs: number,
): AsyncGenerator<AgentRunEvent> {
    if (intervalMs <= 0) {
        yield* events
        return
    }

    let pendingUpdate: AssistantUpdateEvent | null = null
    let lastEmittedAt = Number.NEGATIVE_INFINITY

    for await (const event of events) {
        if (!isDeltaAssistantUpdate(event)) {
            if (pendingUpdate) {
                yield pendingUpdate
                pendingUpdate = null
                lastEmittedAt = monotonicNow()
            }
            yield event
            continue
        }

        if (pendingUpdate) {
            const merged = mergeAssistantDeltas(pendingUpdate, event)
            if (merged) {
                pendingUpdate = merged
            } else {
                yield pendingUpdate
                lastEmittedAt = monotonicNow()
                pendingUpdate = event
            }
        } else {
            pendingUpdate = event
        }

        if (monotonicNow() - lastEmittedAt >= intervalMs) {
            yield pendingUpdate
            pendingUpdate = null
            lastEmittedAt = monotonicNow()
        }
    }

    if (pendingUpdate) {
        yield pendingUpdate
    }
}

function createAbortError(message = 'Request was aborted'): Error {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError()
    }
}

/** Observe a late promise so its rejection never becomes unhandled. */
function observePromise(promise: Promise<unknown>): void {
    void promise.then(
        () => undefined,
        () => undefined,
    )
}

/**
 * Race a promise against AbortSignal. On abort, the underlying promise is
 * observed (not cancelled) and an AbortError is thrown.
 */
async function abortablePromise<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!signal) {
        return promise
    }
    if (signal.aborted) {
        observePromise(promise)
        throw createAbortError()
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false
        const onAbort = (): void => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', onAbort)
            observePromise(promise)
            reject(createAbortError())
        }
        signal.addEventListener('abort', onAbort)
        promise.then(
            (value) => {
                if (settled) return
                settled = true
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error: unknown) => {
                if (settled) return
                settled = true
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

async function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        throwIfAborted(signal)
        return
    }
    throwIfAborted(signal)
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup()
            resolve()
        }, ms)
        const onAbort = (): void => {
            cleanup()
            reject(createAbortError())
        }
        const cleanup = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
        }
        signal?.addEventListener('abort', onAbort)
    })
}

type MutexWaiter = {
    id: number
    signal?: AbortSignal
    resolve: (release: () => void) => void
    reject: (error: unknown) => void
    abortHandler?: () => void
}

/**
 * FIFO mutex that can drop waiters on abort and reject the whole queue on dispose.
 * Holders never keep the lock across resource/tool loading — only rotation CS.
 */
class AbortableMutex {
    private locked = false
    private queue: MutexWaiter[] = []
    private nextId = 0
    private closedError: Error | null = null

    acquire(signal?: AbortSignal): Promise<() => void> {
        if (this.closedError) {
            return Promise.reject(this.closedError)
        }
        if (signal?.aborted) {
            return Promise.reject(createAbortError())
        }
        if (!this.locked) {
            this.locked = true
            return Promise.resolve(() => this.releaseLock())
        }
        return new Promise<() => void>((resolve, reject) => {
            const waiter: MutexWaiter = {
                id: ++this.nextId,
                signal,
                resolve,
                reject,
            }
            waiter.abortHandler = (): void => {
                this.removeWaiter(waiter.id)
                if (waiter.signal && waiter.abortHandler) {
                    waiter.signal.removeEventListener('abort', waiter.abortHandler)
                }
                reject(createAbortError())
            }
            signal?.addEventListener('abort', waiter.abortHandler)
            // Re-check close/abort after enqueue race.
            if (this.closedError) {
                this.removeWaiter(waiter.id)
                if (signal && waiter.abortHandler) {
                    signal.removeEventListener('abort', waiter.abortHandler)
                }
                reject(this.closedError)
                return
            }
            if (signal?.aborted) {
                this.removeWaiter(waiter.id)
                if (signal && waiter.abortHandler) {
                    signal.removeEventListener('abort', waiter.abortHandler)
                }
                reject(createAbortError())
                return
            }
            this.queue.push(waiter)
        })
    }

    /** Reject queued waiters and block new acquires (service dispose). */
    close(error: Error): void {
        this.closedError = error
        const pending = this.queue.splice(0)
        for (const waiter of pending) {
            if (waiter.signal && waiter.abortHandler) {
                waiter.signal.removeEventListener('abort', waiter.abortHandler)
            }
            waiter.reject(error)
        }
    }

    private removeWaiter(id: number): void {
        this.queue = this.queue.filter((waiter) => waiter.id !== id)
    }

    private releaseLock(): void {
        while (this.queue.length > 0) {
            const next = this.queue.shift()
            if (!next) break
            if (next.signal?.aborted) {
                // Abort handler already rejected; skip.
                continue
            }
            if (next.signal && next.abortHandler) {
                next.signal.removeEventListener('abort', next.abortHandler)
            }
            // Transfer lock ownership to the next waiter.
            next.resolve(() => this.releaseLock())
            return
        }
        this.locked = false
    }
}

/** Opaque owner token so only the claiming op may clear `active`. */
type ActiveOwnerToken = symbol

type ActiveStream = {
    kind: 'stream'
    token: ActiveOwnerToken
    runId: string
    sessionId: string
    /** Bound after manager/client/loop construction; optional during ensure. */
    loop?: AgentLoop
    client?: ProtocolClient
    controller: AbortController
    /** Auth identity of this op — prepare same-config checks use this. */
    baseUrl: string
    apiKey: string
}

type ActiveCompact = {
    kind: 'compact'
    token: ActiveOwnerToken
    runId: string
    sessionId: string
    controller: AbortController
    baseUrl: string
    apiKey: string
}

type ActiveOp = ActiveStream | ActiveCompact

const AGENT_DIR_SEGMENTS = ['coding-professional-agent', 'agent'] as const

function defaultId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Cross-platform path join using resolveToCwd (no Node path).
 * Segments must be relative names.
 */
export function joinPath(base: string, ...parts: string[]): string {
    let current = base
    for (const part of parts) {
        current = resolveToCwd(part, current)
    }
    return current
}

/** Build the fixed CPA agent directory under the user config root. */
export function buildAgentDir(userConfigDir: string): string {
    return joinPath(userConfigDir, ...AGENT_DIR_SEGMENTS)
}

/**
 * Cycle-safe deep clone for prepared snapshots and event sanitization.
 * Preserves functions, BigInt, and shared refs; never uses JSON (BigInt-safe).
 * Does not require structuredClone.
 */
function deepCloneData<T>(value: T, seen = new WeakMap<object, unknown>()): T {
    if (value === null || value === undefined) {
        return value
    }
    const valueType = typeof value
    if (valueType === 'function' || valueType === 'bigint' || valueType !== 'object') {
        return value
    }
    const obj = value as object
    const cached = seen.get(obj)
    if (cached !== undefined) {
        return cached as T
    }
    if (Array.isArray(value)) {
        const arr: unknown[] = []
        seen.set(obj, arr)
        for (const item of value) {
            arr.push(deepCloneData(item, seen))
        }
        return arr as T
    }
    if (value instanceof Date) {
        const cloned = new Date(value.getTime())
        seen.set(obj, cloned)
        return cloned as T
    }
    const out: Record<string, unknown> = {}
    seen.set(obj, out)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = deepCloneData(child, seen)
    }
    return out as T
}

/**
 * Deep-freeze plain data. Functions are left untouched so tool execute/validate
 * remain callable. Cycle-safe via the seen set; shared frozen refs are skipped.
 */
function deepFreezeData<T>(value: T, seen = new WeakSet<object>()): T {
    if (value === null || value === undefined) {
        return value
    }
    if (typeof value === 'function' || typeof value === 'bigint') {
        return value
    }
    if (typeof value !== 'object') {
        return value
    }
    const obj = value as object
    if (seen.has(obj)) {
        return value
    }
    if (Object.isFrozen(obj)) {
        return value
    }
    seen.add(obj)
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            value[i] = deepFreezeData(value[i], seen)
        }
        return Object.freeze(value)
    }
    for (const key of Object.keys(obj)) {
        const record = obj as Record<string, unknown>
        const child = record[key]
        if (typeof child !== 'function') {
            record[key] = deepFreezeData(child, seen)
        }
    }
    return Object.freeze(value)
}

function freezeDiagnostics(
    diagnostics: readonly ResourceDiagnostic[],
): readonly ResourceDiagnostic[] {
    return deepFreezeData(deepCloneData(diagnostics.slice())) as readonly ResourceDiagnostic[]
}

/**
 * Freeze tools while keeping execute/validate function identity.
 * Parameters schemas are deep-cloned then recursively frozen.
 */
function freezeTools(tools: readonly AgentTool[]): readonly AgentTool[] {
    return Object.freeze(
        tools.map((tool) => {
            const parameters = deepFreezeData(deepCloneData(tool.parameters))
            return Object.freeze({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters,
                validate: tool.validate,
                execute: tool.execute,
            })
        }),
    ) as readonly AgentTool[]
}

/**
 * Redact API keys and Bearer tokens from error strings before they leave the service.
 */
export function redactSecrets(
    message: string,
    secrets: readonly string[] = [],
): string {
    let out = String(message ?? '')
    // Redact Bearer tokens before short-key exact replacement so patterns like
    // `Bearer a` still match (a 1-char key would otherwise break the word Bearer).
    out = out.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    for (const secret of secrets) {
        const value = (secret ?? '').trim()
        // Any non-empty apiKey (including 1–3 char keys) must be exact-replaced.
        // split/join avoids regex special-character bugs and never leaves the key intact.
        if (value.length === 0) continue
        out = out.split(value).join('[REDACTED]')
    }
    return out
}

/**
 * Cycle-safe / shared-ref-safe deep redaction for arbitrary non-event payloads.
 * Prefer sanitizeEvent for AgentRunEvent — it is schema-aware and will not
 * rewrite structural fields or normal assistant/tool content.
 */
export function redactDeep(
    value: unknown,
    secrets: readonly string[],
    seen = new WeakMap<object, unknown>(),
): unknown {
    if (typeof value === 'string') {
        return redactSecrets(value, secrets)
    }
    if (value === null || value === undefined) {
        return value
    }
    const valueType = typeof value
    if (valueType === 'bigint' || valueType === 'function' || valueType !== 'object') {
        return value
    }
    const obj = value as object
    const cached = seen.get(obj)
    if (cached !== undefined) {
        return cached
    }
    if (Array.isArray(value)) {
        const arr: unknown[] = []
        seen.set(obj, arr)
        for (const item of value) {
            arr.push(redactDeep(item, secrets, seen))
        }
        return arr
    }
    if (value instanceof Date) {
        const cloned = new Date(value.getTime())
        seen.set(obj, cloned)
        return cloned
    }
    const out: Record<string, unknown> = {}
    seen.set(obj, out)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = redactDeep(child, secrets, seen)
    }
    return out
}

function redactAssistantEntryError(
    entry: { errorMessage?: string },
    secrets: readonly string[],
): void {
    if (typeof entry.errorMessage === 'string') {
        entry.errorMessage = redactSecrets(entry.errorMessage, secrets)
    }
}

function redactToolResultTextBlocks(
    content: ReadonlyArray<{ type?: string; text?: string } | unknown>,
    secrets: readonly string[],
): void {
    for (const block of content) {
        if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
        ) {
            ;(block as { text: string }).text = redactSecrets(
                (block as { text: string }).text,
                secrets,
            )
        }
    }
}

function redactToolResultPayload(
    result: { content: ReadonlyArray<unknown>; isError?: boolean },
    secrets: readonly string[],
): void {
    redactToolResultTextBlocks(result.content, secrets)
}

function redactConversationEntryErrors(
    entry: ConversationEntry,
    secrets: readonly string[],
): void {
    if (entry.kind === 'assistant') {
        redactAssistantEntryError(entry, secrets)
        return
    }
    if (entry.kind === 'toolResult' && entry.isError === true) {
        redactToolResultTextBlocks(entry.content, secrets)
    }
}

function redactStreamEventErrors(
    streamEvent: {
        type: string
        partial?: { errorMessage?: string }
        error?: { errorMessage?: string }
        message?: { errorMessage?: string }
    },
    secrets: readonly string[],
): void {
    if (streamEvent.partial) {
        redactAssistantEntryError(streamEvent.partial, secrets)
    }
    if (streamEvent.error) {
        redactAssistantEntryError(streamEvent.error, secrets)
    }
    if (streamEvent.message) {
        redactAssistantEntryError(streamEvent.message, secrets)
    }
}

/**
 * For unknown / future event shapes: clone is already done; only rewrite
 * clearly named errorMessage fields anywhere, plus top-level message/error.
 * Never globally replace every string.
 */
function redactUnknownEventFields(
    value: unknown,
    secrets: readonly string[],
    isTopLevel: boolean,
    seen: WeakSet<object>,
): void {
    if (value === null || value === undefined) return
    if (typeof value !== 'object') return
    const obj = value as object
    if (seen.has(obj)) return
    seen.add(obj)
    if (Array.isArray(value)) {
        for (const item of value) {
            redactUnknownEventFields(item, secrets, false, seen)
        }
        return
    }
    const record = value as Record<string, unknown>
    for (const [key, child] of Object.entries(record)) {
        if (typeof child === 'string') {
            if (
                key === 'errorMessage' ||
                (isTopLevel && (key === 'message' || key === 'error'))
            ) {
                record[key] = redactSecrets(child, secrets)
            }
            continue
        }
        redactUnknownEventFields(child, secrets, false, seen)
    }
}

/**
 * Schema-aware AgentRunEvent sanitizer.
 * Clones the event (cycle/shared-ref/BigInt/frozen-safe) and redacts secrets
 * only in error-bearing text fields. Structural fields and normal content
 * (type/runId/sessionId/tool names/paths/args/summaries/content) are preserved.
 */
export function sanitizeEvent(
    event: AgentRunEvent,
    secrets: readonly string[] = [],
): AgentRunEvent {
    const cloned = deepCloneData(event) as AgentRunEvent
    switch (cloned.type) {
        case 'error':
            cloned.message = redactSecrets(cloned.message, secrets)
            break
        case 'diagnostic':
            cloned.message = redactSecrets(cloned.message, secrets)
            break
        case 'retrying':
            if (typeof cloned.error === 'string') {
                cloned.error = redactSecrets(cloned.error, secrets)
            }
            break
        case 'assistant-start':
        case 'assistant-end':
            redactAssistantEntryError(cloned.entry, secrets)
            break
        case 'assistant-update':
            redactAssistantEntryError(cloned.entry, secrets)
            redactStreamEventErrors(cloned.streamEvent, secrets)
            break
        case 'agent-end':
            if (cloned.entries) {
                for (const entry of cloned.entries) {
                    redactConversationEntryErrors(entry, secrets)
                }
            }
            break
        case 'tool-update':
            // No entry on tool-update; redact only when result reports error.
            if (cloned.result.isError === true) {
                redactToolResultPayload(cloned.result, secrets)
            }
            break
        case 'tool-end': {
            // Any single error flag must redact both result and entry text,
            // then normalize all flags so eventAdapter (entry-first) cannot
            // persist unredacted success-shaped toolResult entries.
            const effectiveIsError =
                cloned.isError === true ||
                cloned.result.isError === true ||
                cloned.entry?.isError === true
            if (effectiveIsError) {
                redactToolResultPayload(cloned.result, secrets)
                if (cloned.entry) {
                    redactToolResultTextBlocks(cloned.entry.content, secrets)
                    cloned.entry.isError = true
                }
                cloned.result.isError = true
                cloned.isError = true
            }
            break
        }
        case 'agent-start':
        case 'aborted':
        case 'compaction-start':
        case 'compaction-end':
        case 'tool-start':
        case 'tool-approval-required':
            // Structural / non-error events: clone only, no string rewrites.
            break
        default:
            redactUnknownEventFields(cloned, secrets, true, new WeakSet<object>())
            break
    }
    return cloned
}

function mapSpeed(
    speed: AgentPrepareInput['speed'],
    model: ModelCatalogEntry,
): 'standard' | 'fast' {
    if (speed === 'fast') {
        if (model.supportsFast) return 'fast'
        return 'standard'
    }
    // 'max' and 'standard' both map to standard on the wire.
    return 'standard'
}

function mapReasoningEffort(
    reasoningLevel: string,
    model: ModelCatalogEntry,
): string | undefined {
    const levels = model.reasoningLevels ?? []
    if (levels.length === 0) {
        return undefined
    }
    const match = levels.find((option) => option.id === reasoningLevel)
    if (!match) {
        throw new AgentPreflightError(
            'invalid_reasoning',
            `Reasoning level "${reasoningLevel}" is not available for model "${model.id}"`,
            'agent.preflight.invalid_reasoning',
        )
    }
    return match.requestValue
}

function linkAbortSignals(
    outer: AbortSignal | undefined,
    inner: AbortController,
): () => void {
    if (!outer) return () => {}
    if (outer.aborted) {
        inner.abort()
        return () => {}
    }
    const onAbort = (): void => {
        inner.abort()
    }
    outer.addEventListener('abort', onAbort)
    return () => {
        outer.removeEventListener('abort', onAbort)
    }
}

export function adaptCodexClientToProtocolClient(
    client: any,
): ProtocolClient {
    return {
        stream: (input, streamOpts) => {
            const signal = streamOpts?.signal ?? new AbortController().signal
            const codexOpts: any = streamOpts
                ? {
                      connectionMode: (streamOpts as any).connectionMode,
                      promptCacheKey: streamOpts.promptCacheKey,
                      maxOutputTokens: streamOpts.maxOutputTokens,
                  }
                : undefined
            return client.stream(input, signal, codexOpts)
        },
        cancel: async () => {},
        dispose: () => {
            // no-op or client dispose
        },
    }
}

/**
 * Production agent service: validates config, freezes resources, runs AgentLoop.
 */
export class CLIProxyAPIAgentService implements AgentService {
    private readonly bridge: NativeBridge
    private readonly extensionRegistry: RendererRegistry
    private readonly customCreateClient?: (
        options: any,
    ) => ProtocolClient | any
    private readonly createConnectionManager: (
        bridge: NativeBridge,
        providerId?: string,
    ) => ProtocolConnectionManager | null | undefined
    private readonly loadResources: (
        input: LoadResourceSnapshotInput,
    ) => Promise<ResourceSnapshot>
    private readonly createTools: NonNullable<
        CLIProxyAPIAgentServiceDependencies['createTools']
    >
    private readonly createLoop: (
        deps: AgentLoopDependencies,
    ) => AgentLoop
    private readonly compactFn: NonNullable<
        CLIProxyAPIAgentServiceDependencies['compact']
    >
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly disposeTimeoutMs: number
    private readonly streamUpdateIntervalMs: number
    private readonly delayFn: (ms: number, signal?: AbortSignal) => Promise<void>
    private readonly agentProviderRegistry: AgentProviderRegistry

    private runtimeInfo: RuntimeInfo | null = null
    private connectionManager: ProtocolConnectionManager | null = null
    /** Opaque namespace token for the current (baseUrl, apiKey) identity — never a key hash. */
    private connectionNamespace: string | null = null
    /** Exact auth config bound to the current namespace (for rotate-on-change). */
    private connectionAuth: { baseUrl: string; apiKey: string } | null = null
    /** FIFO abortable mutex — only covers namespace rotation critical section. */
    private readonly configMutex = new AbortableMutex()
    /** Monotonic prepare start generation (latest wins commit). */
    private prepareGeneration = 0
    /** Highest generation that successfully committed namespace/manager. */
    private committedGeneration = 0
    /** Live prepare generations still in flight (resource load or commit). */
    private readonly livePrepareGens = new Set<number>()
    /**
     * Background disposal after abort/timeout. Never reuse these managers.
     * New managers are created only after wait resolves or times out.
     */
    private readonly backgroundDisposals = new Set<Promise<void>>()
    private approvals = new ApprovalController()
    private readonly activeOps = new Map<ActiveOwnerToken, ActiveOp>()
    private disposed = false
    readonly subAgents: SubAgentHost
    private readonly childOps = new Map<
        string,
        {
            runId: string
            sessionId: string
            controller: AbortController
            loop?: AgentLoop
            manager?: ProtocolConnectionManager | null
        }
    >()
    /** Last observed redacted config-rotation dispose failure (tests / diagnostics). */
    private lastConfigDisposeError: AgentPreflightError | null = null
    /** Last successfully committed prepared snapshot (tests / diagnostics). */
    private latestSnapshot: PreparedAgentRun | null = null

    constructor(deps: CLIProxyAPIAgentServiceDependencies) {
        this.bridge = deps.bridge
        this.extensionRegistry =
            deps.extensionRegistry ?? agentRegistry
        this.customCreateClient = deps.createClient
        this.createConnectionManager =
            deps.createConnectionManager ??
            ((bridge: NativeBridge, providerId?: string) => {
                const provider =
                    this.extensionRegistry.getProtocolProvider(providerId) ??
                    (this.extensionRegistry !== rendererRegistry
                        ? rendererRegistry.getProtocolProvider(providerId)
                        : undefined)
                if (
                    provider &&
                    typeof (provider as any).createConnectionManager === 'function'
                ) {
                    return (provider as any).createConnectionManager(bridge)
                }
                return null
            })
        this.loadResources = deps.loadResources ?? loadResourcesFromProviders
        this.createTools =
            deps.createTools ??
            ((cwd, bridge, model, options) =>
                createToolsFromProviders({
                    cwd: cwd ?? undefined,
                    bridge,
                    model,
                    ...options,
                }))
        this.createLoop =
            deps.createLoop ?? ((loopDeps) => new AgentLoop(loopDeps))
        this.compactFn = deps.compact ?? compactConversation
        this.now = deps.now ?? (() => Date.now())
        this.generateId = deps.generateId ?? defaultId
        this.disposeTimeoutMs =
            deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        this.streamUpdateIntervalMs = Math.max(
            0,
            deps.streamUpdateIntervalMs ?? DEFAULT_STREAM_UPDATE_INTERVAL_MS,
        )
        this.delayFn = deps.delay ?? defaultDelay
        this.agentProviderRegistry = new AgentProviderRegistry({
            extensionRegistry: this.extensionRegistry,
            bridge: this.bridge,
            createClient: (options) => this.createClientInstance(options),
            createTools: this.createTools,
            loadResources: this.loadResources,
        })
        this.subAgents = new SubAgentHost({
            generateId: () => this.generateId(),
            now: () => this.now(),
            run: (request) => this.streamChildChat(request),
        })
    }

    /**
     * Create protocol client:
     * 1. Prioritize injected deps.createClient if provided.
     * 2. Otherwise get protocol provider from extension registry (defaults to codex-responses-ws).
     * 3. Fallback to new CPAClient.
     */
    private createClientInstance(
        options: any,
    ): ProtocolClient {
        if (this.customCreateClient) {
            const client = this.customCreateClient(options)
            if (client && typeof client.stream === 'function') {
                return adaptCodexClientToProtocolClient(client)
            }
            return client as ProtocolClient
        }

        const providerId = options?.protocolProviderId ?? options?.protocolProvider?.id
        const provider =
            this.extensionRegistry.getProtocolProvider(providerId) ??
            (this.extensionRegistry !== rendererRegistry
                ? rendererRegistry.getProtocolProvider(providerId)
                : undefined)
        if (provider) {
            if (typeof (provider as any).createSession === 'function') {
                const session = (provider as any).createSession(options)
                if (session && typeof session.then === 'function') {
                    return {
                        stream: async function* (input, streamOpts) {
                            const resolved = await session
                            for await (const ev of resolved.stream(input, streamOpts)) {
                                yield ev
                            }
                        },
                        cancel: async (reason) => {
                            const resolved = await session
                            await resolved.cancel(reason)
                        },
                        dispose: async () => {
                            const resolved = await session
                            await resolved.dispose?.()
                        },
                    }
                }
                return session
            }
            if (typeof (provider as any).createClient === 'function') {
                return (provider as any).createClient(options)
            }
        }

        throw new Error('No protocol provider found in contribution registry')
    }

    /** Cached runtimeInfo — fetched once per service lifetime. */
    async getRuntimeInfo(signal?: AbortSignal): Promise<RuntimeInfo> {
        this.assertNotDisposed()
        throwIfAborted(signal)
        if (this.runtimeInfo) return this.runtimeInfo
        const info = await abortablePromise(this.bridge.runtimeInfo(), signal)
        // Another prepare may have filled the cache while we awaited.
        if (!this.runtimeInfo) {
            this.runtimeInfo = info
        }
        return this.runtimeInfo
    }

    async prepare(input: AgentPrepareInput): Promise<PreparedAgentRun> {
        this.assertNotDisposed()
        const signal = input.signal
        throwIfAborted(signal)

        const gen = this.beginPrepare()
        try {
            this.assertNotDisposed()
            throwIfAborted(signal)
            const diagnostics: ResourceDiagnostic[] = []

            let baseUrl: string
            try {
                baseUrl = canonicalizeBaseUrl(input.baseUrl ?? '')
            } catch (error) {
                throw new AgentPreflightError(
                    'invalid_base_url',
                    error instanceof Error
                        ? error.message
                        : 'CLIProxyAPI base URL must be an absolute http(s) URL',
                    'agent.preflight.invalid_base_url',
                )
            }

            const apiKey = (input.apiKey ?? '').trim()
            if (!apiKey) {
                throw new AgentPreflightError(
                    'missing_api_key',
                    'CLIProxyAPI API key is required',
                    'agent.preflight.missing_api_key',
                )
            }

            // Fail-fast: different config while a stream/compact owns active
            // (including while that op is still inside ensureConnectionManager).
            this.assertActiveAllowsConfig(baseUrl, apiKey)

            const models = (input.models ?? (input.model ? [input.model] : [])).slice()
            const model = input.model ?? models.find((entry) => entry.id === input.modelId)
            if (!model) {
                throw new AgentPreflightError(
                    'model_not_found',
                    `Model "${input.modelId}" is not in the catalog`,
                    'agent.preflight.model_not_found',
                )
            }

            // Deep-clone + deep-freeze model so later catalog mutations cannot rewrite this run.
            const modelSnapshot = deepFreezeData(
                deepCloneData(model),
            ) as ModelCatalogEntry

            const reasoningEffort = mapReasoningEffort(
                input.reasoningLevel,
                modelSnapshot,
            )
            const speed = mapSpeed(input.speed, modelSnapshot)

            // Resource/tool loading is OUTSIDE the config mutex so a hung load
            // cannot block other prepares or rotation waiters.
            const runtime = await this.getRuntimeInfo(signal)
            throwIfAborted(signal)
            this.assertNotDisposed()
            const agentDir = buildAgentDir(runtime.userConfigDir)
            await this.ensureAgentResourceDirs(agentDir, diagnostics, signal)
            throwIfAborted(signal)
            this.assertNotDisposed()

            const projectResolution = await abortablePromise(
                this.resolveProjectPaths(
                    input.projectPath,
                    input.projectPaths,
                    diagnostics,
                ),
                signal,
            )
            throwIfAborted(signal)
            this.assertNotDisposed()
            let projectCwd = projectResolution.cwd
            let projectPaths = projectResolution.paths

            let worktreePolicy: WorktreeRunPolicy | undefined
            if (input.worktreePolicy) {
                try {
                    if (!projectCwd) {
                        throw new Error('Git worktree mode requires a valid projectCwd')
                    }
                    worktreePolicy = createWorktreeRunPolicy(
                        input.worktreePolicy,
                        projectCwd,
                    )
                } catch (error) {
                    throw new AgentPreflightError(
                        'invalid_worktree_policy',
                        error instanceof Error ? error.message : String(error),
                        'agent.preflight.invalid_worktree_policy',
                    )
                }
            }

            // Tools known first. If tools end up empty after a project path, treat
            // the project as invalid for resource loading (global-only) — TOCTOU-safe.
            const toolsRaw = await abortablePromise(
                this.createTools(projectCwd, this.bridge, modelSnapshot, {
                    extensionRegistry: this.extensionRegistry,
                    scheduleId: input.scheduleId,
                    sessionId: input.sessionId,
                    worktreePolicy,
                    subAgents: this.subAgents,
                    models,
                }),
                signal,
            )
            throwIfAborted(signal)
            this.assertNotDisposed()
            if (projectCwd && toolsRaw.length === 0) {
                if (worktreePolicy) {
                    throw new AgentPreflightError(
                        'invalid_worktree_policy',
                        `Worktree coding tools unavailable for: ${projectCwd}`,
                        'agent.preflight.invalid_worktree_policy',
                    )
                }
                diagnostics.push({
                    type: 'warning',
                    message: `Project tools unavailable; using global-only resources: ${projectCwd}`,
                    path: projectCwd,
                    resourceType: 'system',
                })
                projectCwd = undefined
                projectPaths = []
            }

            const subagentsSettings: SubagentsSettings =
                input.subagentsSettings ??
                this.latestSnapshot?.subagentsSettings ??
                DEFAULT_SUBAGENT_SETTINGS

            const effectiveToolsRaw = subagentsSettings.enabled
                ? toolsRaw
                : toolsRaw.filter((tool) => !isSubAgentToolName(tool.name))

            const mainTools = effectiveToolsRaw.filter((tool) => tool.targetAgent !== 'subagent')
            const tools = freezeTools(mainTools)

            // Resource snapshot once after tools are known; invalid project → cwd undefined.
            const snapshot = await abortablePromise(
                this.loadResources({
                    cwd: projectCwd,
                    projectPaths,
                    agentDir,
                    homeDir: runtime.homeDir,
                    bridge: this.bridge,
                    tools: tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                    })),
                    language: input.language,
                    personality: input.personality,
                    localMemoryEnabled: input.localMemoryEnabled,
                    extensionRegistry: this.extensionRegistry,
                    worktreePolicy,
                }),
                signal,
            )
            throwIfAborted(signal)
            this.assertNotDisposed()

            for (const diag of snapshot.diagnostics) {
                diagnostics.push(diag)
            }

            const supportsImages = modelSnapshot.input.includes('image')

            // Deep-clone + recursively freeze the whole snapshot shell (contextFiles,
            // system/append, skills body, prompts content, diagnostics).
            const frozenSnapshot = deepFreezeData(
                deepCloneData(snapshot),
            ) as ResourceSnapshot

            const generationSnapshot = await this.agentProviderRegistry.createSnapshot(
                input,
                {
                    bridge: this.bridge,
                    model: modelSnapshot,
                    worktreePolicy,
                    tools,
                    resources: frozenSnapshot,
                },
            )

            const prepared = Object.freeze({
                baseUrl,
                apiKey,
                model: modelSnapshot,
                models: deepFreezeData(deepCloneData(models)) as readonly ModelCatalogEntry[],
                reasoningEffort,
                speed,
                requestApproval: Boolean(input.requestApproval),
                compactionSettings: compactionSettingsFromThresholdPercent(
                    input.compactionThresholdPercent,
                ),
                fastContextCompaction: input.fastContextCompaction !== false,
                agentDir,
                projectCwd,
                projectPaths: Object.freeze(projectPaths.slice()),
                tools,
                snapshot: frozenSnapshot,
                diagnostics: freezeDiagnostics(diagnostics),
                systemPrompt: frozenSnapshot.systemPrompt,
                supportsImages,
                // Recursive freeze of skill/prompt elements (body/content immutable).
                skills: deepFreezeData(
                    deepCloneData(frozenSnapshot.skills.slice()),
                ) as PreparedAgentRun['skills'],
                prompts: deepFreezeData(
                    deepCloneData(frozenSnapshot.prompts.slice()),
                ) as PreparedAgentRun['prompts'],
                language: input.language,
                personality: input.personality,
                protocolProviderId: input.protocolProviderId,
                subagentsSettings,
                ...(worktreePolicy ? { worktreePolicy } : {}),
                generationSnapshot,
            }) as PreparedAgentRun

            // Only the namespace rotation critical section holds the config mutex.
            const release = await this.configMutex.acquire(signal)
            try {
                throwIfAborted(signal)
                this.assertNotDisposed()

                // Stale prepare (older generation while a newer one is live/committed)
                // must not overwrite latestSnapshot / namespace / manager.
                if (this.isStalePrepare(gen)) {
                    return prepared
                }

                // Re-check under rotation lock (active may have started after load).
                // Same config as the active owner → allow; different → typed reject.
                this.assertActiveAllowsConfig(baseUrl, apiKey)

                await this.ensureAuthNamespace(baseUrl, apiKey, signal)

                // Reconfirm after possible dispose wait.
                throwIfAborted(signal)
                this.assertNotDisposed()
                if (this.isStalePrepare(gen)) {
                    return prepared
                }

                this.committedGeneration = gen
                this.latestSnapshot = prepared
                this.subAgents.configure({
                    prepared,
                    codingTools: freezeTools(codingToolsOnly(toolsRaw)),
                    allTools: freezeTools(toolsRaw),
                    subagentsSettings,
                    models: deepFreezeData(
                        deepCloneData(models),
                    ) as ModelCatalogEntry[],
                    extensionRegistry: this.extensionRegistry,
                    getEntries: input.getEntries,
                })
                return prepared
            } finally {
                release()
            }
        } finally {
            this.endPrepare(gen)
        }
    }

    /**
     * Eagerly claims the single-active owner token, then returns an async
     * generator whose body runs ensure/loop under that owner try/finally.
     * Claiming before any await closes the concurrent prepare/stream race.
     */
    streamChat(
        input: AgentStreamChatInput | PreparedAgentRun,
    ): AsyncGenerator<AgentRunEvent> & {
        readonly generationSnapshot?: AgentGenerationSnapshot
        readonly prepared?: PreparedAgentRun
    } {
        this.assertNotDisposed()
        const normalizedInput: AgentStreamChatInput =
            'prepared' in input && input.prepared
                ? {
                      ...input,
                      runId: input.runId ?? this.generateId(),
                      sessionId: input.sessionId ?? 'default-session',
                      entries: input.entries ?? [],
                  }
                : {
                      prepared: input as PreparedAgentRun,
                      sessionId: (input as any).sessionId ?? 'default-session',
                      runId: (input as any).runId ?? this.generateId(),
                      entries: (input as any).entries ?? [],
                      userEntry: (input as any).userEntry,
                      signal: (input as any).signal,
                  }

        const { prepared, sessionId, runId } = normalizedInput
        for (const active of this.activeOps.values()) {
            if (active.sessionId === sessionId || active.runId === runId) {
                throw new AgentPreflightError(
                    'run_active',
                    `An agent run is already active (runId=${active.runId})`,
                    'agent.preflight.run_active',
                )
            }
        }

        const controller = new AbortController()
        const unlink = linkAbortSignals(normalizedInput.signal, controller)
        const token = this.claimActive({
            kind: 'stream',
            runId,
            sessionId,
            controller,
            baseUrl: prepared.baseUrl,
            apiKey: prepared.apiKey,
        })

        const generator = this.streamChatOwned(normalizedInput, token, controller, unlink)
        let bodyEntered = false
        const originalNext = generator.next.bind(generator)
        const originalReturn = generator.return.bind(generator)
        const originalThrow = generator.throw.bind(generator)

        generator.next = async (...args) => {
            bodyEntered = true
            return originalNext(...args)
        }

        generator.return = async (value) => {
            try {
                if (bodyEntered) {
                    return await originalReturn(value)
                }
                return { done: true, value }
            } finally {
                if (!bodyEntered) {
                    unlink()
                    this.subAgents.setParentContext(null)
                    this.releaseActive(token)
                    await disposeGenerationSnapshot(prepared.generationSnapshot)
                }
            }
        }

        generator.throw = async (error) => {
            try {
                if (bodyEntered) {
                    return await originalThrow(error)
                }
                throw error
            } finally {
                if (!bodyEntered) {
                    unlink()
                    this.subAgents.setParentContext(null)
                    this.releaseActive(token)
                    await disposeGenerationSnapshot(prepared.generationSnapshot)
                }
            }
        }

        Object.defineProperty(generator, 'generationSnapshot', {
            get: () => prepared.generationSnapshot,
            enumerable: true,
        })
        Object.defineProperty(generator, 'prepared', {
            get: () => prepared,
            enumerable: true,
        })
        return generator as AsyncGenerator<AgentRunEvent> & {
            readonly generationSnapshot?: AgentGenerationSnapshot
            readonly prepared?: PreparedAgentRun
        }
    }

    private async *streamChatOwned(
        input: AgentStreamChatInput,
        token: ActiveOwnerToken,
        controller: AbortController,
        unlink: () => void,
    ): AsyncGenerator<AgentRunEvent> {
        const { prepared, sessionId, runId } = input
        let modelInvoker: RunScopedModelInvoker | undefined
        this.subAgents.setParentContext({
            sessionId,
            runId,
            getRuntimeSettings: (input as AgentStreamChatInput).getRuntimeSettings,
        })
        try {
            const { manager, namespace } = await this.ensureConnectionManager(
                prepared,
                controller.signal,
            )
            throwIfAborted(controller.signal)
            this.assertNotDisposed()
            if (!this.activeOps.has(token)) {
                throw createAbortError()
            }

            const client = this.createClientInstance({
                bridge: this.bridge,
                apiKey: prepared.apiKey,
                baseUrl: prepared.baseUrl,
                sessionId,
                protocolProviderId: (prepared as any).protocolProviderId,
                now: this.now,
                generateRequestId: this.generateId,
                connectionManager: manager ?? undefined,
                connectionNamespace: namespace,
            })

            modelInvoker = this.createRunModelInvoker(
                prepared,
                sessionId,
                controller.signal,
            )
            const loop = this.createLoop({
                client,
                approvals: this.approvals,
                now: this.now,
                generateId: this.generateId,
                compact: this.compactFn,
                extensionRegistry: this.extensionRegistry,
                middlewares: prepared.generationSnapshot?.middleware,
                hooks: prepared.generationSnapshot?.hooks,
                generationSnapshot: prepared.generationSnapshot,
                streamUpdateIntervalMs: this.streamUpdateIntervalMs,
                cloneStreamSnapshots: false,
                modelInvoker,
            })

            // Attach loop/client for abort() while we still own active.
            const activeRecord = this.activeOps.get(token)
            if (activeRecord && activeRecord.kind === 'stream') {
                activeRecord.loop = loop
                activeRecord.client = client
            }

            const baseTools = prepared.tools as AgentTool[]
            const hasSessionTitleTool = baseTools.some(
                (t) => t.name === SET_SESSION_TITLE_TOOL_NAME,
            )
            let effectiveTools: AgentTool[] = baseTools
            if (!hasSessionTitleTool) {
                const titleFactory =
                    this.extensionRegistry.getToolFactory(
                        SET_SESSION_TITLE_TOOL_NAME,
                    ) ??
                    (this.extensionRegistry !== rendererRegistry
                        ? rendererRegistry.getToolFactory(SET_SESSION_TITLE_TOOL_NAME)
                        : undefined)
                if (titleFactory) {
                    const dynamicTitleTool = await titleFactory.create({
                        platform: 'darwin',
                        services: {} as any,
                        sessionId,
                    })
                    if (dynamicTitleTool) {
                        effectiveTools = [dynamicTitleTool, ...baseTools]
                    }
                }
            }
            let effectiveSystemPrompt = augmentSystemPromptForSessionTitle(
                prepared.systemPrompt,
            )

            const isResume = input.entries.some(
                (entry) => entry.kind === 'assistant',
            )
            try {
                const sessionStartOutcome = await HookProvider.execute(
                    'SessionStart',
                    {
                        event: 'SessionStart',
                        sessionId,
                        payload: {
                            hook_event_name: 'SessionStart',
                            session_id: sessionId,
                            cwd: prepared.projectCwd ?? '',
                            model: prepared.model.id,
                            permission_mode: prepared.requestApproval ? 'default' : 'bypassPermissions',
                            source: isResume ? 'resume' : 'startup',
                        },
                        signal: input.signal,
                    },
                    {
                        hooks: prepared.generationSnapshot?.hooks,
                        extensionRegistry: this.extensionRegistry,
                    },
                )
                if (sessionStartOutcome.additionalContexts && sessionStartOutcome.additionalContexts.length > 0) {
                    effectiveSystemPrompt +=
                        '\n\n' + sessionStartOutcome.additionalContexts.join('\n\n')
                }
            } catch {
                // Fail open on session-start hook error
            }

            const runInput: AgentRunInput = {
                runId,
                sessionId,
                entries: expandUserSkillEntries(
                    input.entries,
                    prepared.skills,
                ),
                userEntry: input.userEntry
                    ? expandUserEntrySkills(input.userEntry, prepared.skills)
                    : input.userEntry,
                model: prepared.model,
                systemPrompt: effectiveSystemPrompt,
                tools: effectiveTools,
                requestApproval: prepared.requestApproval,
                reasoningEffort: prepared.reasoningEffort,
                speed: prepared.speed,
                signal: controller.signal,
                cwd: prepared.projectCwd,
                compactionSettings: prepared.compactionSettings,
                fastContextCompaction: prepared.fastContextCompaction,
                getRuntimeSettings: (input as AgentStreamChatInput).getRuntimeSettings,
                consumeSteerEntry: (input as AgentStreamChatInput).consumeSteerEntry,
                consumeSteerEntries: (input as AgentStreamChatInput).consumeSteerEntries,
            }

            const iterable = throttleAssistantUpdates(
                loop.run(runInput),
                this.streamUpdateIntervalMs,
            )
            for await (const event of iterable) {
                // Sanitize after coalescing so skipped cumulative snapshots are never cloned.
                yield this.sanitizeOutgoing(event, prepared.apiKey)
            }
        } catch (error) {
            const message = redactSecrets(
                error instanceof Error
                    ? error.message
                    : String(error ?? 'stream error'),
                [prepared.apiKey],
            )
            if (error instanceof Error) {
                error.message = message
                throw error
            }
            throw new Error(message)
        } finally {
            unlink()
            this.subAgents.setParentContext(null)
            this.releaseActive(token)
            await modelInvoker?.close()
            await disposeGenerationSnapshot(prepared.generationSnapshot)
        }
    }

    abort(runId?: string): void {
        if (this.disposed) return
        if (runId !== undefined) {
            for (const active of this.activeOps.values()) {
                if (active.runId === runId) {
                    if (active.kind === 'stream' && active.loop) {
                        active.loop.abort(active.runId)
                    }
                    this.subAgents.abortAllForParent(active.sessionId)
                    active.controller.abort()
                    this.approvals.abortAll(active.runId)
                }
            }
            this.abortChildOps()
        } else {
            for (const active of this.activeOps.values()) {
                if (active.kind === 'stream' && active.loop) {
                    active.loop.abort(active.runId)
                }
                this.subAgents.abortAllForParent(active.sessionId)
                active.controller.abort()
                this.approvals.abortAll(active.runId)
            }
            this.abortChildOps()
        }
    }

    approve(runId: string, toolCallId: string): boolean {
        if (this.disposed) return false
        if (!runId || !toolCallId) return false
        return this.approvals.approve(runId, toolCallId)
    }

    reject(runId: string, toolCallId: string): boolean {
        if (this.disposed) return false
        if (!runId || !toolCallId) return false
        return this.approvals.reject(runId, toolCallId)
    }

    async compact(input: AgentCompactInput): Promise<AgentCompactResult> {
        this.assertNotDisposed()
        for (const active of this.activeOps.values()) {
            if (active.sessionId === input.sessionId || active.runId === input.runId) {
                return {
                    ok: false,
                    message: `Cannot compact while run ${active.runId} is active`,
                    code: 'run_active',
                }
            }
        }

        const { prepared, sessionId, runId } = input
        const controller = new AbortController()
        const unlink = linkAbortSignals(input.signal, controller)

        // Claim active before any await (including ensureConnectionManager).
        const token = this.claimActive({
            kind: 'compact',
            runId,
            sessionId,
            controller,
            baseUrl: prepared.baseUrl,
            apiKey: prepared.apiKey,
        })

        return this.withActiveOperation(token, unlink, async () => {
            // Scoped terminal order (Task15): agent-start → body → error|aborted → agent-end.
            const events: AgentRunEvent[] = [
                { type: 'agent-start', runId, sessionId },
                { type: 'compaction-start', runId, sessionId },
            ]

            try {
                const { manager, namespace } = await this.ensureConnectionManager(
                    prepared,
                    controller.signal,
                )
                throwIfAborted(controller.signal)
                this.assertNotDisposed()

                const client = this.createClientInstance({
                    bridge: this.bridge,
                    apiKey: prepared.apiKey,
                    baseUrl: prepared.baseUrl,
                    sessionId,
                    now: this.now,
                    generateRequestId: this.generateId,
                    connectionManager: manager ?? undefined,
                    connectionNamespace: namespace,
                })

                if (controller.signal.aborted) {
                    events.push({ type: 'aborted', runId, sessionId })
                    events.push({ type: 'agent-end', runId, sessionId })
                    return {
                        ok: false as const,
                        message: 'Compact aborted',
                        code: 'aborted',
                        events: events.map((e) =>
                            this.sanitizeOutgoing(e, prepared.apiKey),
                        ),
                    }
                }

                const preCompactOutcome = await HookProvider.execute(
                    'PreCompact',
                    {
                        event: 'PreCompact',
                        sessionId,
                        payload: {
                            hook_event_name: 'PreCompact',
                            session_id: sessionId,
                            trigger: 'manual',
                            cwd: prepared.projectCwd ?? '',
                        },
                        signal: controller.signal,
                    },
                    {
                        hooks: prepared.generationSnapshot?.hooks,
                        extensionRegistry: this.extensionRegistry,
                    },
                )
                if (!preCompactOutcome.continue) {
                    events.push({ type: 'agent-end', runId, sessionId })
                    return {
                        ok: false as const,
                        message:
                            preCompactOutcome.stopReason ??
                            'Compaction blocked by hook',
                        code: 'blocked',
                        events: events.map((e) =>
                            this.sanitizeOutgoing(e, prepared.apiKey),
                        ),
                    }
                }

                const result = await this.compactFn(
                    expandUserSkillEntries(input.entries, prepared.skills),
                    {
                        client,
                        model: prepared.model,
                        sessionId,
                        reasoningEffort: prepared.reasoningEffort,
                        speed: prepared.speed,
                        fastContextCompaction: prepared.fastContextCompaction,
                        signal: controller.signal,
                        customInstructions: input.customInstructions,
                        force: true,
                        now: this.now,
                        generateId: this.generateId,
                    },
                )

                if (controller.signal.aborted) {
                    events.push({ type: 'aborted', runId, sessionId })
                    events.push({ type: 'agent-end', runId, sessionId })
                    return {
                        ok: false as const,
                        message: 'Compact aborted',
                        code: 'aborted',
                        events: events.map((e) =>
                            this.sanitizeOutgoing(e, prepared.apiKey),
                        ),
                    }
                }

                const entry = result.entry
                const authoritative: readonly ConversationEntry[] =
                    result.entries ?? [...input.entries, entry]

                if (entry) {
                    await HookProvider.execute(
                        'PostCompact',
                        {
                            event: 'PostCompact',
                            sessionId,
                            payload: {
                                hook_event_name: 'PostCompact',
                                session_id: sessionId,
                                trigger: 'manual',
                                cwd: prepared.projectCwd ?? '',
                            },
                            signal: controller.signal,
                        },
                        {
                            hooks: prepared.generationSnapshot?.hooks,
                            extensionRegistry: this.extensionRegistry,
                        },
                    )
                }

                events.push({
                    type: 'compaction-end',
                    runId,
                    sessionId,
                    entry,
                })
                events.push({
                    type: 'agent-end',
                    runId,
                    sessionId,
                    entries: authoritative,
                })

                return {
                    ok: true as const,
                    entry,
                    events: events.map((e) =>
                        this.sanitizeOutgoing(e, prepared.apiKey),
                    ),
                }
            } catch (error) {
                const aborted =
                    controller.signal.aborted ||
                    (error instanceof Error &&
                        (error.name === 'AbortError' ||
                            /abort/i.test(error.message)))
                if (aborted) {
                    events.push({ type: 'aborted', runId, sessionId })
                    events.push({ type: 'agent-end', runId, sessionId })
                    return {
                        ok: false as const,
                        message: 'Compact aborted',
                        code: 'aborted',
                        events: events.map((e) =>
                            this.sanitizeOutgoing(e, prepared.apiKey),
                        ),
                    }
                }
                const message = redactSecrets(
                    error instanceof Error
                        ? error.message
                        : String(error ?? 'compact failed'),
                    [prepared.apiKey],
                )
                events.push({
                    type: 'error',
                    runId,
                    sessionId,
                    message,
                })
                events.push({ type: 'agent-end', runId, sessionId })
                return {
                    ok: false as const,
                    message,
                    code: 'compact_failed',
                    events: events.map((e) =>
                        this.sanitizeOutgoing(e, prepared.apiKey),
                    ),
                }
            } finally {
                await disposeGenerationSnapshot(prepared.generationSnapshot)
            }
        })
    }

    private async *streamChildChat(
        request: SubAgentRunRequest,
    ): AsyncGenerator<AgentRunEvent> {
        this.assertNotDisposed()
        const prepared = this.latestSnapshot
        if (!prepared) {
            throw new Error('No prepared snapshot for sub-agent run')
        }

        const controller = new AbortController()
        const unlink = linkAbortSignals(request.signal, controller)
        // Child runs must not reuse the parent's session socket / namespace.
        // A dedicated manager keeps the child's model on its own upstream connection.
        const manager = this.createConnectionManager(this.bridge) ?? null
        const namespace = this.generateId()
        let modelInvoker: RunScopedModelInvoker | undefined
        const op = {
            runId: request.runId,
            sessionId: request.sessionId,
            controller,
            manager,
        }
        this.childOps.set(request.runId, op)
        try {
            throwIfAborted(controller.signal)
            this.assertNotDisposed()

            const client = this.createClientInstance({
                bridge: this.bridge,
                apiKey: prepared.apiKey,
                baseUrl: prepared.baseUrl,
                sessionId: request.sessionId,
                now: this.now,
                generateRequestId: this.generateId,
                connectionManager: manager ?? undefined,
                connectionNamespace: namespace,
            })
            modelInvoker = this.createRunModelInvoker(
                prepared,
                request.sessionId,
                controller.signal,
            )
            const loop = this.createLoop({
                client,
                approvals: this.approvals,
                now: this.now,
                generateId: this.generateId,
                compact: this.compactFn,
                extensionRegistry: this.extensionRegistry,
                middlewares: prepared.generationSnapshot?.middleware,
                hooks: prepared.generationSnapshot?.hooks,
                generationSnapshot: prepared.generationSnapshot,
                streamUpdateIntervalMs: this.streamUpdateIntervalMs,
                cloneStreamSnapshots: false,
                modelInvoker,
            })
            const tracked = this.childOps.get(request.runId)
            if (tracked) {
                tracked.loop = loop
            }

            const iterable = throttleAssistantUpdates(
                loop.run({
                    runId: request.runId,
                    sessionId: request.sessionId,
                    entries: request.entries,
                    userEntry: request.userEntry,
                    model: request.model,
                    systemPrompt: request.systemPrompt,
                    tools: request.tools as AgentTool[],
                    requestApproval: false,
                    reasoningEffort:
                        request.reasoningEffort ??
                        resolveChildReasoning(
                            request.model,
                            prepared.reasoningEffort,
                        ),
                    speed: request.speed ?? prepared.speed,
                    signal: controller.signal,
                    cwd: prepared.projectCwd,
                    compactionSettings: prepared.compactionSettings,
                    fastContextCompaction: prepared.fastContextCompaction,
                    getRuntimeSettings: request.getRuntimeSettings,
                }),
                this.streamUpdateIntervalMs,
            )
            for await (const event of iterable) {
                yield this.sanitizeOutgoing(event, prepared.apiKey)
            }
        } finally {
            unlink()
            this.childOps.delete(request.runId)
            await modelInvoker?.close()
            if (manager && typeof manager.dispose === 'function') {
                try {
                    await manager.dispose()
                } catch {
                    // observe dispose failures; never leave unhandled rejections
                }
            }
        }
    }

    private createRunModelInvoker(
        prepared: PreparedAgentRun,
        parentSessionId: string,
        runSignal: AbortSignal,
    ): RunScopedModelInvoker {
        const pinnedProvider = prepared.generationSnapshot?.protocolProvider
        const allowedModels = prepared.models ?? prepared.generationSnapshot?.models ?? [prepared.model]
        return new RunScopedModelInvoker({
            runSignal,
            sessionId: parentSessionId,
            allowedModels,
            generateId: this.generateId,
            now: this.now,
            sanitizeError: (error) => {
                // Plugin-facing invocation errors are credential-opaque. Do not
                // disclose arbitrary transport messages or account-specific URLs.
                const sanitized = new Error(error instanceof Error && error.name === 'AbortError'
                    ? 'Isolated model invocation aborted'
                    : 'Isolated model invocation failed')
                sanitized.name = error instanceof Error ? error.name : 'Error'
                return sanitized
            },
            createSession: async ({ invocationId }) => {
                this.assertNotDisposed()
                const providerId = prepared.protocolProviderId
                const manager = pinnedProvider && typeof (pinnedProvider as any).createConnectionManager === 'function'
                    ? (pinnedProvider as any).createConnectionManager(this.bridge) ?? null
                    : this.customCreateClient
                        ? this.createConnectionManager(this.bridge, providerId) ?? null
                        : null
                const options = {
                    bridge: this.bridge,
                    apiKey: prepared.apiKey,
                    baseUrl: prepared.baseUrl,
                    sessionId: `${parentSessionId}:isolated:${invocationId}`,
                    protocolProviderId: providerId,
                    now: this.now,
                    generateRequestId: this.generateId,
                    connectionManager: manager ?? undefined,
                    connectionNamespace: this.generateId(),
                }
                try {
                    let session: ProtocolSession
                    if (this.customCreateClient) {
                        session = this.createClientInstance(options)
                    } else if (pinnedProvider && typeof pinnedProvider.createSession === 'function') {
                        session = await pinnedProvider.createSession(options)
                    } else if (pinnedProvider && typeof pinnedProvider.createClient === 'function') {
                        session = await pinnedProvider.createClient(options) as unknown as ProtocolSession
                    } else {
                        throw new Error('Prepared protocol provider cannot create isolated session')
                    }
                    return {
                        session,
                        dispose: async () => {
                            if (manager && typeof manager.dispose === 'function') await manager.dispose()
                        },
                    }
                } catch (error) {
                    if (manager && typeof manager.dispose === 'function') {
                        try { await manager.dispose() } catch { /* preserve creation error */ }
                    }
                    throw error
                }
            },
        })
    }

    private abortChildOps(): void {
        for (const child of this.childOps.values()) {
            if (child.loop) {
                child.loop.abort(child.runId)
            }
            child.controller.abort()
            if (child.manager) {
                void this.trackBackgroundDispose(child.manager, [
                    this.latestSnapshot?.apiKey ?? '',
                ])
            }
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        // Abort queued rotation waiters so dispose cannot hang forever.
        this.configMutex.close(
            new AgentPreflightError(
                'disposed',
                'CLIProxyAPIAgentService has been disposed',
                'agent.preflight.disposed',
            ),
        )
        this.subAgents.abortAll()
        this.abortChildOps()
        for (const active of this.activeOps.values()) {
            if (active.kind === 'stream' && active.loop) {
                active.loop.abort(active.runId)
            }
            active.controller.abort()
            this.approvals.abortAll(active.runId)
        }
        this.activeOps.clear()
        this.approvals.abortAll()
        if (this.connectionManager) {
            const manager = this.connectionManager
            this.connectionManager = null
            this.connectionNamespace = null
            this.connectionAuth = null
            if (typeof manager.dispose === 'function') {
                try {
                    await manager.dispose()
                } catch {
                    // observe dispose failures; never leave unhandled rejections
                }
            }
        }
        this.latestSnapshot = null
        this.runtimeInfo = null
    }

    getApprovalController(): ApprovalController {
        return this.approvals
    }

    /** Test helper: whether a run is currently active. */
    get isActive(): boolean {
        return this.activeOps.size > 0
    }

    /** Test helper: current active kind when present. */
    get activeKind(): 'stream' | 'compact' | null {
        const first = this.activeOps.values().next().value
        return first?.kind ?? null
    }

    private beginPrepare(): number {
        const gen = this.prepareGeneration + 1
        this.prepareGeneration = gen
        this.livePrepareGens.add(gen)
        return gen
    }

    private endPrepare(gen: number): void {
        this.livePrepareGens.delete(gen)
    }

    /**
     * A prepare is stale when a newer generation already committed, or a newer
     * prepare is still live (will take ownership of namespace commit).
     */
    private isStalePrepare(gen: number): boolean {
        if (gen < this.committedGeneration) {
            return true
        }
        for (const live of this.livePrepareGens) {
            if (live > gen) {
                return true
            }
        }
        return false
    }

    private authMatches(baseUrl: string, apiKey: string): boolean {
        return (
            this.connectionAuth !== null &&
            this.connectionAuth.baseUrl === baseUrl &&
            this.connectionAuth.apiKey === apiKey
        )
    }

    /**
     * Rotate/install the connection manager for exact (baseUrl, apiKey).
     * Must be called while holding configMutex.
     *
     * Prepare-path active awareness lives in prepare() so stream/compact can
     * still install a manager for their own prepared config.
     *
     * Old dispose may hang: wait is abortable + bounded by disposeTimeoutMs.
     * Caller abort releases the mutex (via caller finally) while background
     * disposal continues; new managers are never the disposing old instance.
     */
    private async ensureAuthNamespace(
        baseUrl: string,
        apiKey: string,
        signal?: AbortSignal,
    ): Promise<{ manager: ProtocolConnectionManager | null; namespace: string }> {
        this.assertNotDisposed()
        throwIfAborted(signal)

        const authChanged = !this.authMatches(baseUrl, apiKey)

        // Same exact config: reuse manager/namespace (no dispose).
        if (!authChanged && this.connectionManager && this.connectionNamespace) {
            return {
                manager: this.connectionManager,
                namespace: this.connectionNamespace,
            }
        }

        if (authChanged && this.connectionManager) {
            const previous = this.connectionManager
            const previousApiKey = this.connectionAuth?.apiKey ?? ''
            // Drop refs immediately so nothing reuses the disposing manager.
            this.connectionManager = null
            this.connectionNamespace = null
            this.connectionAuth = null

            const disposePromise = this.trackBackgroundDispose(
                previous,
                [apiKey, previousApiKey],
            )

            // Abortable + bounded wait. On abort: throw (caller releases mutex);
            // disposal keeps running in the background. On timeout: proceed to
            // install a fresh manager without reusing `previous`.
            await this.waitForDisposeBounded(disposePromise, signal)
            throwIfAborted(signal)
            this.assertNotDisposed()
        }

        if (!this.connectionNamespace || authChanged) {
            // Opaque service-assigned token — never a hash of the API key.
            this.connectionNamespace = this.generateId()
        }
        if (!this.connectionManager || authChanged) {
            this.connectionManager = this.createConnectionManager(this.bridge) ?? null
            this.connectionAuth = { baseUrl, apiKey }
        }
        return {
            manager: this.connectionManager,
            namespace: this.connectionNamespace,
        }
    }

    /**
     * Start manager.dispose in the background, redact failures, never unhandled.
     */
    private trackBackgroundDispose(
        manager: ProtocolConnectionManager | null | undefined,
        secrets: readonly string[],
    ): Promise<void> {
        if (!manager || typeof manager.dispose !== 'function') {
            return Promise.resolve()
        }
        const disposePromise = Promise.resolve()
            .then(() => manager.dispose())
            .then(
                () => undefined,
                (error: unknown) => {
                    const redacted = new AgentPreflightError(
                        'connection_dispose_failed',
                        redactSecrets(
                            error instanceof Error
                                ? error.message
                                : String(error ?? 'connection dispose failed'),
                            secrets,
                        ),
                        'agent.preflight.connection_dispose_failed',
                    )
                    this.lastConfigDisposeError = redacted
                },
            )
            .finally(() => {
                this.backgroundDisposals.delete(disposePromise)
            })
        this.backgroundDisposals.add(disposePromise)
        return disposePromise
    }

    /**
     * Wait for dispose up to disposeTimeoutMs, abortable via signal.
     * Returns when dispose completes or timeout elapses (caller may continue).
     * Abort rejects without cancelling the underlying dispose.
     */
    private async waitForDisposeBounded(
        disposePromise: Promise<void>,
        signal?: AbortSignal,
    ): Promise<'completed' | 'timeout'> {
        throwIfAborted(signal)

        return new Promise<'completed' | 'timeout'>((resolve, reject) => {
            let settled = false
            const finish = (result: 'completed' | 'timeout'): void => {
                if (settled) return
                settled = true
                cleanup()
                resolve(result)
            }
            const fail = (error: unknown): void => {
                if (settled) return
                settled = true
                cleanup()
                reject(error)
            }
            const onAbort = (): void => {
                fail(createAbortError())
            }
            const cleanup = (): void => {
                signal?.removeEventListener('abort', onAbort)
            }
            signal?.addEventListener('abort', onAbort)

            void disposePromise.then(
                () => finish('completed'),
                () => finish('completed'),
            )
            void this.delayFn(this.disposeTimeoutMs, signal).then(
                () => finish('timeout'),
                (error: unknown) => {
                    // Delay abort only matters if dispose has not finished.
                    fail(error)
                },
            )
        })
    }

    /**
     * Ensure a connection manager bound to the exact (baseUrl, apiKey) identity.
     * Mutex only wraps the rotation critical section.
     */
    private async ensureConnectionManager(
        prepared: PreparedAgentRun,
        signal?: AbortSignal,
    ): Promise<{ manager: ProtocolConnectionManager | null; namespace: string }> {
        const release = await this.configMutex.acquire(signal)
        try {
            return await this.ensureAuthNamespace(
                prepared.baseUrl,
                prepared.apiKey,
                signal,
            )
        } finally {
            release()
        }
    }

    /** Test helper: last observed redacted config-dispose error. */
    get observedConfigDisposeError(): AgentPreflightError | null {
        return this.lastConfigDisposeError
    }

    /** Test helper: last committed prepared snapshot (null if none / disposed). */
    get committedSnapshot(): PreparedAgentRun | null {
        return this.latestSnapshot
    }

    /** Test helper: current opaque connection namespace (null when none). */
    get currentConnectionNamespace(): string | null {
        return this.connectionNamespace
    }

    /** Test helper: current committed auth identity (apiKey present for exact compare tests). */
    get currentConnectionAuth(): { baseUrl: string; apiKey: string } | null {
        return this.connectionAuth
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new AgentPreflightError(
                'disposed',
                'CLIProxyAPIAgentService has been disposed',
                'agent.preflight.disposed',
            )
        }
    }

    /**
     * Atomically claim the single-active owner slot. Must run before any await
     * on stream/compact paths so concurrent prepare rotation / second ops see it.
     */
    private claimActive(
        op: Omit<ActiveStream, 'token' | 'loop' | 'client'> | Omit<ActiveCompact, 'token'>,
    ): ActiveOwnerToken {
        this.assertNotDisposed()
        for (const active of this.activeOps.values()) {
            if (active.sessionId === op.sessionId || active.runId === op.runId) {
                throw new AgentPreflightError(
                    'run_active',
                    `An agent run is already active (runId=${active.runId})`,
                    'agent.preflight.run_active',
                )
            }
        }
        this.assertActiveAllowsConfig(op.baseUrl, op.apiKey)
        const token: ActiveOwnerToken = Symbol(`active-${op.kind}`)
        if (op.kind === 'stream') {
            this.activeOps.set(token, {
                kind: 'stream',
                token,
                runId: op.runId,
                sessionId: op.sessionId,
                controller: op.controller,
                baseUrl: op.baseUrl,
                apiKey: op.apiKey,
            })
        } else {
            this.activeOps.set(token, {
                kind: 'compact',
                token,
                runId: op.runId,
                sessionId: op.sessionId,
                controller: op.controller,
                baseUrl: op.baseUrl,
                apiKey: op.apiKey,
            })
        }
        return token
    }

    /** Only the owning token may clear active (never a newer op). */
    private releaseActive(token: ActiveOwnerToken): void {
        this.activeOps.delete(token)
    }

    /**
     * Run an already-claimed active op body. All awaits after claim must live
     * inside this helper so ensure/iterator failures always release the owner.
     */
    private async withActiveOperation<T>(
        token: ActiveOwnerToken,
        unlink: () => void,
        run: () => Promise<T>,
    ): Promise<T> {
        try {
            return await run()
        } finally {
            unlink()
            this.releaseActive(token)
        }
    }

    /**
     * While an op owns active, only the same exact (baseUrl, apiKey) may prepare.
     * Compared against the active owner's intended auth (not connectionAuth),
     * so mid-ensure rotation still allows same-config prepare and rejects others.
     */
    private assertActiveAllowsConfig(baseUrl: string, apiKey: string): void {
        for (const active of this.activeOps.values()) {
            if (
                active.baseUrl !== baseUrl ||
                active.apiKey !== apiKey
            ) {
                throw new AgentPreflightError(
                    'config_change_during_run',
                    'Cannot change API configuration while a run is active',
                    'agent.preflight.config_change_during_run',
                )
            }
        }
    }

    private sanitizeOutgoing(
        event: AgentRunEvent,
        apiKey: string,
    ): AgentRunEvent {
        return sanitizeEvent(event, [apiKey])
    }

    private async ensureAgentResourceDirs(
        agentDir: string,
        diagnostics: ResourceDiagnostic[],
        signal?: AbortSignal,
    ): Promise<void> {
        for (const name of ['skills', 'prompts']) {
            const dir = joinPath(agentDir, name)
            try {
                await abortablePromise(this.bridge.mkdirAll(dir), signal)
            } catch (error) {
                throwIfAborted(signal)
                diagnostics.push({
                    type: 'warning',
                    message: `Could not create agent resource directory: ${error instanceof Error ? error.message : String(error)}`,
                    path: dir,
                    resourceType: name === 'skills' ? 'skill' : 'prompt',
                })
            }
        }
    }

    private async resolveProjectPaths(
        projectPath: string | null | undefined,
        projectPaths: readonly string[] | null | undefined,
        diagnostics: ResourceDiagnostic[],
    ): Promise<{ cwd?: string; paths: string[] }> {
        const requested: string[] = []
        const seen = new Set<string>()
        for (const path of [projectPath, ...(projectPaths ?? [])]) {
            if (typeof path !== 'string' || !path || seen.has(path)) continue
            seen.add(path)
            requested.push(path)
        }

        const paths: string[] = []
        for (const path of requested) {
            if (!isAbsolutePath(path)) {
                diagnostics.push({
                    type: 'warning',
                    message: `Project path is not absolute; path ignored: ${path}`,
                    path,
                    resourceType: 'system',
                })
                continue
            }

            try {
                const stat = await this.bridge.stat(path)
                if (!stat.isDir) {
                    diagnostics.push({
                        type: 'warning',
                        message: `Project path is not a directory; path ignored: ${path}`,
                        path,
                        resourceType: 'system',
                    })
                    continue
                }
                paths.push(path)
            } catch {
                diagnostics.push({
                    type: 'warning',
                    message: `Project path does not exist; path ignored: ${path}`,
                    path,
                    resourceType: 'system',
                })
            }
        }

        return {
            cwd: paths[0],
            paths,
        }
    }
}
