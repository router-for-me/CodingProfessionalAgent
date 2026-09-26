/**
 * Multi-turn AgentLoop: provider stream → tools → tool results → provider.
 * Owns approval waiters, transient retries, overflow compact-once, and abort.
 *
 * Public `run()` is eager: it occupies the active token/controller immediately
 * and returns a single-consumer AsyncIterable/Iterator. Work does not wait for
 * the first `next()`.
 */

import type { ModelCatalogEntry } from '@/features/models/types'
import {
    buildCompactedContext,
    compactConversation,
    deepCloneValue,
    type CompactConversationOptions,
    type CompactConversationResult,
} from '../context/compaction'
import {
    estimateContextTokens,
    shouldCompact,
    type CompactionSettings,
} from '../context/tokenEstimate'
import { codexCallId } from './toolCallId'
import { ProtocolMiddlewarePipeline } from '@/plugins/protocol/ProtocolMiddlewarePipeline'
import type {
    ProtocolClient,
    ProtocolMiddleware,
    ProtocolStreamInput,
    ProtocolToolDefinition,
} from '@cpa/plugin-api'
import type { RendererRegistry as ExtensionRegistry } from '@/plugins/platform/rendererRegistry'
import { HookProvider } from '../providers/HookProvider'
import type {
    AssistantEntry,
    CompactionEntry,
    ConversationEntry,
    ToolResultContentBlock,
    ToolResultEntry,
    UserEntry,
} from '../session/types'
import { findToolByNameOrAlias, isMutatingToolName, selectApprovalPolicy } from '../providers/ToolFactoryProvider'

import {
    ApprovalController,
    TOOL_REJECTED_MESSAGE,
} from './approvals'
import {
    AGENT_RETRY_DELAYS_MS,
    classifyAgentError,
    defaultSleep,
    type SleepFn,
} from './retry'
import type { HookContribution } from '@cpa/plugin-api'
import type {
    AgentRunEvent,
    AgentTool,
    AssistantStreamEvent,
    AssistantToolCallBlock,
    ToolResult,
} from './types'
import type { AgentGenerationSnapshot } from '../providers/generationSnapshot'
import type { ToolModelInvokerOwner } from './isolatedModelInvoker'

export type { AgentRunEvent }

export interface AgentLoopDependencies {
    client: ProtocolClient
    approvals?: ApprovalController
    sleep?: SleepFn
    now?: () => number
    generateId?: () => string
    /** Injectable compaction for tests. Defaults to Task 14 compactConversation. */
    compact?: (
        entries: readonly ConversationEntry[],
        options: CompactConversationOptions,
    ) => Promise<CompactConversationResult>
    retryDelaysMs?: readonly number[]
    /** Optional extension registry for protocol middlewares. */
    extensionRegistry?: ExtensionRegistry
    /** Optional explicit protocol middlewares. */
    middlewares?: readonly ProtocolMiddleware[]
    /** Optional explicit hook contributions. */
    hooks?: readonly HookContribution[]
    /** Optional generation snapshot pinning runtime providers for this run. */
    generationSnapshot?: AgentGenerationSnapshot
    /** Minimum interval between cumulative assistant delta snapshots. */
    streamUpdateIntervalMs?: number
    /** Disable here when the immediate consumer creates the defensive clone. */
    cloneStreamSnapshots?: boolean
    /** Run owner for credential-opaque isolated calls exposed only to tool executions. */
    modelInvoker?: ToolModelInvokerOwner
    /** Optional callback invoked synchronously when a model stream request is initiated. */
    onRequestSent?: (input: ProtocolStreamInput, isContextCurrent?: () => boolean) => void
    /** Optional callback invoked synchronously whenever conversation context entries are mutated. */
    onContextChanged?: () => void
}

export interface AgentRunInput {
    runId: string
    sessionId: string
    /** Existing conversation (never mutated). */
    entries: readonly ConversationEntry[]
    /** Optional new user message; appended at most once (deduped by id). */
    userEntry?: UserEntry
    model: ModelCatalogEntry
    systemPrompt: string
    developerPrompt?: string
    tools: readonly AgentTool[]
    /** When true, bash/edit/write wait for ApprovalController. read is always auto. */
    requestApproval?: boolean
    reasoningEffort?: string
    speed?: string
    signal?: AbortSignal
    compactionSettings?: Partial<CompactionSettings> | null
    fastContextCompaction?: boolean
    /** Absolute project cwd forwarded into tool execution contexts. */
    cwd?: string
    /** Optional generation snapshot pinning runtime providers for this run. */
    generationSnapshot?: AgentGenerationSnapshot
    /** Optional dynamic runtime settings resolver called before each LLM turn/request */
    getRuntimeSettings?: () => {
        reasoningEffort?: string
        reasoningLevel?: string
        speed?: string
    } | undefined
    /** Optional callback returning a pending steer user entry to inject after the current LLM request or tool execution */
    consumeSteerEntry?: () => UserEntry | undefined
    /** Optional callback returning all pending steer user entries to inject after the current LLM request or tool execution */
    consumeSteerEntries?: () => UserEntry[] | undefined
}

type CompactFn = NonNullable<AgentLoopDependencies['compact']>

const ABORTED_TOOL_MESSAGE = 'Tool execution aborted'
const UNKNOWN_TOOL_PREFIX = 'Unknown tool:'

export type AgentRunIterable = AsyncIterable<AgentRunEvent> &
    AsyncIterator<AgentRunEvent, void>

export function resolveDynamicReasoningEffort(
    fallbackEffort: string | undefined,
    model: ModelCatalogEntry,
    getRuntimeSettings?: () => {
        reasoningEffort?: string
        reasoningLevel?: string
    } | undefined,
): string | undefined {
    if (!getRuntimeSettings) return fallbackEffort
    try {
        const dynamic = getRuntimeSettings()
        if (!dynamic) return fallbackEffort
        if (dynamic.reasoningLevel !== undefined) {
            const levels = model.reasoningLevels ?? []
            if (levels.length === 0) return undefined
            const match = levels.find((opt) => opt.id === dynamic.reasoningLevel)
            if (match) return match.requestValue
        }
        if (dynamic.reasoningEffort !== undefined) {
            const levels = model.reasoningLevels ?? []
            const match = levels.find(
                (opt) =>
                    opt.id === dynamic.reasoningEffort ||
                    opt.requestValue === dynamic.reasoningEffort,
            )
            return match ? match.requestValue : dynamic.reasoningEffort
        }
    } catch {
        // Fail-safe
    }
    return fallbackEffort
}

export function resolveDynamicSpeed(
    fallbackSpeed: string | undefined,
    model: ModelCatalogEntry,
    getRuntimeSettings?: () => { speed?: string } | undefined,
): string | undefined {
    if (!getRuntimeSettings) return fallbackSpeed
    try {
        const dynamic = getRuntimeSettings()
        if (!dynamic || !dynamic.speed) return fallbackSpeed
        if (dynamic.speed === 'fast') {
            return model.supportsFast ? 'fast' : 'standard'
        }
        return 'standard'
    } catch {
        return fallbackSpeed
    }
}

function defaultId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function snapshotClone<T>(value: T): T {
    return deepCloneValue(value)
}

type AssistantDeltaEvent = Extract<
    AssistantStreamEvent,
    { type: 'text-delta' | 'thinking-delta' | 'toolcall-delta' }
>

function isAssistantDeltaEvent(
    event: AssistantStreamEvent,
): event is AssistantDeltaEvent {
    return (
        event.type === 'text-delta' ||
        event.type === 'thinking-delta' ||
        event.type === 'toolcall-delta'
    )
}

function mergeAssistantDeltaEvents(
    previous: AssistantDeltaEvent,
    next: AssistantDeltaEvent,
): AssistantDeltaEvent | null {
    if (
        previous.type !== next.type ||
        previous.contentIndex !== next.contentIndex
    ) {
        return null
    }
    return {
        ...next,
        delta: previous.delta + next.delta,
    }
}

function errorMessageOf(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    return String(error ?? 'Unknown error')
}

function isAbortError(error: unknown): boolean {
    return classifyAgentError(error) === 'aborted'
}

function createAbortError(): Error {
    const error = new Error('Request was aborted')
    error.name = 'AbortError'
    return error
}

function toolDefinitionsOf(tools: readonly AgentTool[]): ProtocolToolDefinition[] | undefined {
    if (tools.length === 0) return undefined
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }))
}

function textToolResult(text: string, isError: boolean): ToolResult {
    return {
        content: [{ type: 'text', text }],
        isError,
    }
}

function canonicalToolResult(
    result: ToolResult,
    ownerRecords: readonly NonNullable<ToolResult['isolatedModelInvocations']>[number][] = [],
): ToolResult {
    // Plugins cannot author accounting fields. Only records supplied by the runtime owner survive.
    return {
        content: snapshotClone(result.content),
        isError: Boolean(result.isError),
        ...(ownerRecords.length
            ? { isolatedModelInvocations: snapshotClone(ownerRecords) }
            : {}),
    }
}

/**
 * Dedupe tool calls by normalized call_id (prefix before first `|`), first-wins.
 * Matches Task 7 / codexMessages replay selection.
 */
function extractToolCalls(entry: AssistantEntry): {
    selected: AssistantToolCallBlock[]
    skipped: AssistantToolCallBlock[]
} {
    const selected: AssistantToolCallBlock[] = []
    const skipped: AssistantToolCallBlock[] = []
    const seen = new Set<string>()
    for (const block of entry.content) {
        if (block.type !== 'toolCall') continue
        const normalized = codexCallId(block.id)
        if (seen.has(normalized)) {
            skipped.push(block)
            continue
        }
        seen.add(normalized)
        selected.push(block)
    }
    return { selected, skipped }
}

/**
 * Identify pending tool calls from a trailing assistant entry that have not yet
 * been fulfilled by a matching toolResult in entries.
 */
function extractPendingToolCalls(
    entries: readonly ConversationEntry[],
): { selected: AssistantToolCallBlock[]; skipped: AssistantToolCallBlock[] } | null {
    if (!entries || entries.length === 0) return null
    let lastAssistantIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (entry?.kind === 'compaction') continue
        if (entry?.kind === 'assistant') {
            lastAssistantIndex = i
            break
        }
        break
    }
    if (lastAssistantIndex < 0) return null
    const lastAssistant = entries[lastAssistantIndex] as AssistantEntry
    if (!lastAssistant || lastAssistant.status === 'aborted' || lastAssistant.status === 'error') {
        return null
    }
    const { selected, skipped } = extractToolCalls(lastAssistant)
    if (selected.length === 0) return null

    const existingResultIds = new Set<string>()
    for (let i = lastAssistantIndex + 1; i < entries.length; i++) {
        const entry = entries[i]
        if (entry?.kind === 'toolResult') {
            existingResultIds.add(codexCallId(entry.toolCallId))
            existingResultIds.add(entry.toolCallId)
        }
    }

    const pending = selected.filter(
        (tc) => !existingResultIds.has(tc.id) && !existingResultIds.has(codexCallId(tc.id)),
    )
    if (pending.length === 0) return null
    return { selected: pending, skipped }
}

function createSeedAssistant(
    sessionId: string,
    id: string,
    now: number,
    model: ModelCatalogEntry,
    reasoningEffort?: string,
): AssistantEntry {
    return {
        id,
        sessionId,
        createdAt: now,
        kind: 'assistant',
        model: model.id,
        content: [],
        stopReason: 'pending',
        status: 'streaming',
        ...(reasoningEffort ? { reasoningEffort } : {}),
    }
}

function finalizeErrorAssistant(
    seed: AssistantEntry,
    message: string,
    reason: 'error' | 'aborted',
): AssistantEntry {
    return {
        ...snapshotClone(seed),
        content: snapshotClone(seed.content),
        stopReason: reason,
        status: reason,
        errorMessage: message,
    }
}

/**
 * Observe a promise so late rejection cannot become unhandled.
 * Returns the same settlement to the caller.
 */
function observePromise<T>(promise: Promise<T>): Promise<T> {
    void promise.then(
        () => undefined,
        () => undefined,
    )
    return promise
}

/**
 * Race `promise` against abort. Underlying promise is always observed so late
 * success/failure cannot hang the process as an unhandled rejection.
 */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    observePromise(promise)
    if (signal.aborted) {
        throw createAbortError()
    }
    return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            reject(createAbortError())
        }
        signal.addEventListener('abort', onAbort)
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

// Each event can contain a full assistant snapshot, so keep producer read-ahead small.
const MAX_PENDING_RUN_EVENTS = 16

type EventSink = {
    push: (event: AgentRunEvent) => void
    wait: () => Promise<void>
    waitForCapacity: (limit: number, signal: AbortSignal) => Promise<void>
    close: () => void
    /** Terminal-close: drop queued events, wake waiters, reject further pushes. */
    abort: () => void
    isClosed: () => boolean
    take: () => AgentRunEvent | undefined
    readonly pending: number
}

function createEventSink(): EventSink {
    const queue: AgentRunEvent[] = []
    let closed = false
    let wake: (() => void) | undefined
    let wakeProducer: (() => void) | undefined

    const notify = (): void => {
        const w = wake
        wake = undefined
        w?.()
    }

    return {
        push(event) {
            if (closed) return
            queue.push(event)
            notify()
        },
        async wait() {
            if (queue.length > 0 || closed) return
            await new Promise<void>((resolve) => {
                wake = resolve
            })
        },
        async waitForCapacity(limit, signal) {
            if (queue.length < limit || closed || signal.aborted) return
            await new Promise<void>((resolve) => {
                const resume = (): void => {
                    signal.removeEventListener('abort', resume)
                    wakeProducer = undefined
                    resolve()
                }
                wakeProducer = resume
                signal.addEventListener('abort', resume, { once: true })
            })
        },
        close() {
            closed = true
            notify()
            wakeProducer?.()
        },
        abort() {
            queue.length = 0
            closed = true
            notify()
            wakeProducer?.()
        },
        isClosed: () => closed,
        take() {
            const event = queue.shift()
            if (event !== undefined) wakeProducer?.()
            return event
        },
        get pending() {
            return queue.length
        },
    }
}

/**
 * Fire iterator.return/throw (or any thenable) without awaiting settlement.
 * Observes rejection so late failures cannot become unhandled.
 */
function fireAndObserve(value: unknown): void {
    try {
        if (
            value !== null &&
            value !== undefined &&
            typeof (value as { then?: unknown }).then === 'function'
        ) {
            observePromise(value as Promise<unknown>)
        }
    } catch {
        // Synchronous cleanup throws are ignored.
    }
}

export class AgentLoop {
    private readonly client: ProtocolClient
    private readonly approvals: ApprovalController
    private readonly sleep: SleepFn
    private readonly now: () => number
    private readonly generateId: () => string
    private readonly compact: CompactFn
    private readonly retryDelaysMs: readonly number[]
    private readonly extensionRegistry?: ExtensionRegistry
    private readonly explicitMiddlewares?: readonly ProtocolMiddleware[]
    private readonly explicitHooks?: readonly HookContribution[]
    private readonly generationSnapshot?: AgentGenerationSnapshot
    private readonly streamUpdateIntervalMs: number
    private readonly cloneStreamSnapshots: boolean
    private readonly modelInvoker?: ToolModelInvokerOwner
    private readonly onRequestSent?: (input: ProtocolStreamInput, isContextCurrent?: () => boolean) => void
    private readonly onContextChanged?: () => void
    private contextRevision = 0

    private activeRunId: string | null = null
    private activeToken = 0
    private runAbort: AbortController | null = null
    private externalAbortHandler: (() => void) | null = null
    /**
     * Current provider stream iterator for the active run, tagged with the
     * owning run token. Used so consumer return/abort can fire-and-observe
     * provider.return without awaiting the outer generator unwind
     * (provider.return may never settle). Only the owner token may release
     * or clear the slot — a stale run must never touch a newer run's provider.
     */
    private activeProvider: {
        ownerToken: number
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generator: { return?: (value?: any) => any }
    } | null = null

    constructor(deps: AgentLoopDependencies) {
        this.client = deps.client
        this.approvals = deps.approvals ?? new ApprovalController()
        this.sleep = deps.sleep ?? defaultSleep
        this.now = deps.now ?? (() => Date.now())
        this.generateId = deps.generateId ?? defaultId
        this.compact = deps.compact ?? compactConversation
        this.retryDelaysMs = deps.retryDelaysMs ?? AGENT_RETRY_DELAYS_MS
        this.extensionRegistry = deps.extensionRegistry
        this.explicitMiddlewares = deps.middlewares
        this.explicitHooks = deps.hooks
        this.generationSnapshot = deps.generationSnapshot
        this.streamUpdateIntervalMs = Math.max(
            0,
            deps.streamUpdateIntervalMs ?? 0,
        )
        this.cloneStreamSnapshots = deps.cloneStreamSnapshots ?? true
        this.modelInvoker = deps.modelInvoker
        this.onRequestSent = deps.onRequestSent
        this.onContextChanged = deps.onContextChanged
    }

    private notifyContextChanged(): void {
        this.contextRevision += 1
        this.onContextChanged?.()
    }

    private getEffectiveHooks(): readonly HookContribution[] | undefined {
        return (
            this.generationSnapshot?.hooks ??
            this.explicitHooks ??
            (this.extensionRegistry ? this.extensionRegistry.getHookContributions() : undefined)
        )
    }

    private getMiddlewares(): readonly ProtocolMiddleware[] {
        if (this.generationSnapshot?.middleware) {
            return this.generationSnapshot.middleware
        }
        if (this.explicitMiddlewares) {
            return this.explicitMiddlewares
        }
        if (this.extensionRegistry) {
            return this.extensionRegistry.getProtocolMiddlewares()
        }
        return []
    }

    get isActive(): boolean {
        return this.activeRunId !== null
    }

    getApprovalController(): ApprovalController {
        return this.approvals
    }

    /** Publish the provider iterator for the owning run token. */
    private setActiveProvider(
        token: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generator: { return?: (value?: any) => any },
    ): void {
        this.activeProvider = { ownerToken: token, generator }
    }

    /**
     * Fire-and-observe the active provider iterator's return() only when the
     * caller owns the slot (and optionally when the generator identity matches).
     * Never awaits — provider cleanup may hang forever. Stale runs are no-ops.
     */
    private releaseActiveProvider(
        token: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expectedGenerator?: { return?: (value?: any) => any },
        seed?: AssistantEntry,
    ): void {
        const slot = this.activeProvider
        if (!slot) return
        if (slot.ownerToken !== token) return
        if (expectedGenerator !== undefined && slot.generator !== expectedGenerator) {
            return
        }
        this.activeProvider = null
        const provider = slot.generator
        if (typeof provider.return !== 'function') return
        try {
            fireAndObserve(provider.return(seed))
        } catch {
            // ignore sync provider return errors
        }
    }

    /** Abort the active run (or a specific runId). No-op when no match. */
    abort(runId?: string): void {
        if (this.activeRunId === null) return
        if (runId !== undefined && runId !== this.activeRunId) return
        const token = this.activeToken
        this.runAbort?.abort()
        this.approvals.abortAll(this.activeRunId ?? undefined)
        // Best-effort provider cleanup without awaiting unbounded return().
        // Only the current active token may release the slot.
        this.releaseActiveProvider(token)
    }

    /**
     * Start a run immediately (occupies active token/controller) and return a
     * single-consumer async iterable/iterator. Two concurrent `run()` calls
     * reject synchronously even if the first consumer has not called `next()`.
     */
    run(input: AgentRunInput): AgentRunIterable {
        if (this.activeRunId !== null) {
            throw new Error(
                `An agent run is already active (runId=${this.activeRunId})`,
            )
        }
        if (!input.runId || !input.sessionId) {
            throw new Error('runId and sessionId are required')
        }

        const token = ++this.activeToken
        this.activeRunId = input.runId

        const runAbort = new AbortController()
        this.runAbort = runAbort

        const external = input.signal
        const onExternalAbort = (): void => {
            runAbort.abort()
            this.approvals.abortAll(input.runId)
        }
        this.externalAbortHandler = onExternalAbort
        if (external) {
            if (external.aborted) {
                runAbort.abort()
            } else {
                external.addEventListener('abort', onExternalAbort)
            }
        }

        const sink = createEventSink()
        const gen = this.runGenerator(input, token, runAbort.signal)

        let pumpError: unknown
        let pumpPromise: Promise<void> | null = null
        // Consumer return/throw latch — subsequent next() is immediately done.
        let consumerTerminal = false
        let cleanupStarted = false

        const clearOwnerActive = (): void => {
            this.clearActive(token, input.runId, external, onExternalAbort)
        }

        const ensurePump = (): Promise<void> => {
            if (pumpPromise) return pumpPromise
            pumpPromise = (async () => {
                try {
                    while (true) {
                        if (consumerTerminal) break
                        await sink.waitForCapacity(MAX_PENDING_RUN_EVENTS, runAbort.signal)
                        if (consumerTerminal) break
                        let step: IteratorResult<AgentRunEvent, void>
                        try {
                            step = await gen.next()
                        } catch (error) {
                            // Ignore post-terminal pump errors (consumer already left).
                            if (!consumerTerminal) {
                                pumpError = error
                            }
                            break
                        }
                        if (step.done) break
                        if (consumerTerminal) break
                        sink.push(step.value)
                    }
                } finally {
                    // close is a no-op once abort() already terminal-closed the sink.
                    sink.close()
                    if (!runAbort.signal.aborted) {
                        runAbort.abort()
                    }
                    this.approvals.abortAll(input.runId)
                    // Owner-token clear only; no-op if consumer already released.
                    clearOwnerActive()
                }
            })()
            void pumpPromise.catch(() => undefined)
            return pumpPromise
        }

        /**
         * Terminal consumer cleanup: abort sink (drop queued events + wake
         * pending next), abort run/approvals, fire-and-observe generator
         * return/throw (must not await unbounded), release active immediately.
         *
         * Cancellation is driven by AbortController so in-flight awaits that race
         * the signal can settle. Generator return/throw is best-effort observe-only
         * because provider return may never resolve.
         */
        const terminalCleanup = (mode: 'return' | 'throw', error?: unknown): void => {
            if (cleanupStarted) return
            cleanupStarted = true
            consumerTerminal = true

            // Drop queued events and resolve any pending next as done.
            sink.abort()

            if (!runAbort.signal.aborted) {
                runAbort.abort()
            }
            this.approvals.abortAll(input.runId)

            // Provider return may never settle — fire-and-observe immediately.
            // Owner token only: a stale run must never release a newer provider.
            this.releaseActiveProvider(token)

            // Active release must not wait on generator/provider settlement.
            clearOwnerActive()

            // Fire-and-observe outer generator return/throw after abort. Prefer
            // abort-driven unwind; return/throw is best-effort and must not be awaited.
            // Defer via microtask so an in-flight gen.next() can observe abort first
            // without contending with a concurrent return on the same async generator.
            queueMicrotask(() => {
                try {
                    if (mode === 'throw') {
                        fireAndObserve(gen.throw(error))
                    } else {
                        fireAndObserve(gen.return(undefined))
                    }
                } catch {
                    // ignore sync generator cleanup errors
                }
            })

            // Observe the pump so its late path cannot become unhandled; do not await.
            fireAndObserve(ensurePump())
        }

        // Eager start — do not wait for the first consumer next().
        void ensurePump()

        const iterator: AgentRunIterable = {
            async next() {
                // After return()/throw(), the iterator is terminal for all subsequent next().
                if (consumerTerminal) {
                    return { done: true, value: undefined }
                }
                while (true) {
                    if (consumerTerminal) {
                        return { done: true, value: undefined }
                    }
                    const event = sink.take()
                    if (event !== undefined) {
                        return { done: false, value: event }
                    }
                    if (sink.isClosed()) {
                        if (pumpError && !consumerTerminal) throw pumpError
                        return { done: true, value: undefined }
                    }
                    // The pump always closes the sink in finally. Racing its long-lived
                    // promise on every update would retain one reaction per wait.
                    await sink.wait()
                }
            },
            async return() {
                terminalCleanup('return')
                return { done: true, value: undefined }
            },
            async throw(error?: unknown) {
                terminalCleanup('throw', error)
                if (error !== undefined) throw error
                return { done: true, value: undefined }
            },
            [Symbol.asyncIterator]() {
                return iterator
            },
        }

        return iterator
    }

    private clearActive(
        token: number,
        runId: string,
        external: AbortSignal | undefined,
        onExternalAbort: () => void,
    ): void {
        // Only the owning token may clear the active slot.
        if (this.activeToken === token && this.activeRunId === runId) {
            this.activeRunId = null
            this.runAbort = null
        }
        // Drop provider ref only when this token still owns it (return may already
        // have fire-observed). Never clear a newer run's provider slot.
        if (this.activeProvider?.ownerToken === token) {
            this.activeProvider = null
        }
        if (external && onExternalAbort) {
            external.removeEventListener('abort', onExternalAbort)
        }
        if (this.externalAbortHandler === onExternalAbort) {
            this.externalAbortHandler = null
        }
    }

    private async *runGenerator(
        input: AgentRunInput,
        token: number,
        signal: AbortSignal,
    ): AsyncGenerator<AgentRunEvent, void, undefined> {
        const scope = { runId: input.runId, sessionId: input.sessionId }
        const requestApproval = Boolean(input.requestApproval)

        // Defensive clone of input entries — never mutate caller arrays/objects.
        const stableEntries: ConversationEntry[] = input.entries.map((e) =>
            snapshotClone(e),
        )

        // Append userEntry at most once (dedupe by id).
        if (input.userEntry) {
            const already = stableEntries.some((e) => e.id === input.userEntry!.id)
            if (!already) {
                let userEntryToAppend = snapshotClone(input.userEntry)
                try {
                    const promptText = input.userEntry.content
                        .filter((b) => b.type === 'text')
                        .map((b) => (b as { text: string }).text)
                        .join('\n')
                    const promptOutcome = await HookProvider.execute(
                        'UserPromptSubmit',
                        {
                            event: 'UserPromptSubmit',
                            sessionId: input.sessionId,
                            payload: {
                                hook_event_name: 'UserPromptSubmit',
                                session_id: input.sessionId,
                                cwd: input.cwd ?? '',
                                model: input.model.id,
                                permission_mode: requestApproval ? 'default' : 'bypassPermissions',
                                prompt: promptText,
                            },
                            signal,
                        },
                        {
                            hooks: this.getEffectiveHooks(),
                            extensionRegistry: this.extensionRegistry,
                        },
                    )
                    if (promptOutcome.additionalContexts.length > 0) {
                        userEntryToAppend = {
                            ...userEntryToAppend,
                            content: [
                                ...userEntryToAppend.content,
                                {
                                    type: 'text',
                                    text: `\n\n[Hook context]:\n${promptOutcome.additionalContexts.join('\n\n')}`,
                                },
                            ],
                        }
                    }
                } catch {
                    // Fail open on hook error
                }
                stableEntries.push(userEntryToAppend)
                this.notifyContextChanged()
            }
        }

        const model = input.model
        const systemPrompt = input.systemPrompt
        const tools = input.tools
        const toolDefs = toolDefinitionsOf(tools)
        const toolsByName = new Map(tools.map((t) => [t.name, t]))
        const reasoningEffort = input.reasoningEffort
        const speed = input.speed
        const compactionSettings = input.compactionSettings
        const fastContextCompaction = input.fastContextCompaction !== false
        const cwd = input.cwd

        const resolveCurrentReasoningEffort = () =>
            resolveDynamicReasoningEffort(reasoningEffort, model, input.getRuntimeSettings)
        const resolveCurrentSpeed = () =>
            resolveDynamicSpeed(speed, model, input.getRuntimeSettings)

        let terminalEmitted = false
        let agentEndEmitted = false

        const resolveSteerEntries = (): UserEntry[] | undefined => {
            if (input.consumeSteerEntries) {
                const list = input.consumeSteerEntries()
                return list && list.length > 0 ? list : undefined
            }
            if (input.consumeSteerEntry) {
                const list: UserEntry[] = []
                while (true) {
                    const entry = input.consumeSteerEntry()
                    if (!entry) break
                    list.push(entry)
                }
                return list.length > 0 ? list : undefined
            }
            return undefined
        }

        const emitAgentEnd = function* (
            this: AgentLoop,
        ): Generator<AgentRunEvent, void, undefined> {
            if (agentEndEmitted) return
            agentEndEmitted = true
            yield {
                type: 'agent-end',
                ...scope,
                entries: stableEntries.map((e) => snapshotClone(e)),
            }
        }.bind(this)

        try {
            yield { type: 'agent-start', ...scope }

            // Pre-first-provider compaction check.
            yield* this.awaitCompact(stableEntries, {
                model,
                sessionId: input.sessionId,
                reasoningEffort: resolveCurrentReasoningEffort(),
                speed: resolveCurrentSpeed(),
                signal,
                settings: compactionSettings,
                fastContextCompaction,
                force: false,
                scope,
                client: this.client,
            })

            // Execute any pending tool calls left unfulfilled from a previously interrupted assistant turn.
            const pendingToolCalls = extractPendingToolCalls(stableEntries)
            if (pendingToolCalls && pendingToolCalls.selected.length > 0) {
                for (const skip of pendingToolCalls.skipped) {
                    yield {
                        type: 'diagnostic',
                        ...scope,
                        code: 'duplicate_tool_call',
                        message: `Skipped duplicate tool call id=${skip.id} (normalized=${codexCallId(skip.id)}); first-wins keeps a single provider pair`,
                    }
                }

                yield* this.executeToolBatch({
                    toolCalls: pendingToolCalls.selected,
                    toolsByName,
                    requestApproval,
                    cwd,
                    model,
                    signal,
                    scope,
                    token,
                    stableEntries,
                })

                if (signal.aborted || token !== this.activeToken) {
                    if (!terminalEmitted) {
                        yield { type: 'aborted', ...scope }
                        terminalEmitted = true
                    }
                    yield* emitAgentEnd()
                    return
                }

                // Post-tool / next-provider compaction check.
                yield* this.awaitCompact(stableEntries, {
                    model,
                    sessionId: input.sessionId,
                    reasoningEffort: resolveCurrentReasoningEffort(),
                    speed: resolveCurrentSpeed(),
                    signal,
                    settings: compactionSettings,
                    fastContextCompaction,
                    force: false,
                    scope,
                    client: this.client,
                })
            }

            // Main provider ↔ tools loop.
            while (!signal.aborted) {
                if (token !== this.activeToken) break

                const activeReasoningEffort = resolveCurrentReasoningEffort()
                const activeSpeed = resolveCurrentSpeed()

                const assistantId = this.generateId()
                const providerResult = yield* this.runProviderTurn({
                    stableEntries,
                    assistantId,
                    model,
                    systemPrompt,
                    developerPrompt: input.developerPrompt,
                    toolDefs,
                    reasoningEffort: activeReasoningEffort,
                    speed: activeSpeed,
                    fastContextCompaction,
                    signal,
                    scope,
                    token,
                })

                if (providerResult.kind === 'aborted') {
                    const entry = providerResult.entry
                    stableEntries.push(entry)
                    this.notifyContextChanged()
                    yield {
                        type: 'assistant-end',
                        ...scope,
                        entry: snapshotClone(entry),
                    }
                    if (!terminalEmitted) {
                        yield { type: 'aborted', ...scope }
                        terminalEmitted = true
                    }
                    break
                }

                if (providerResult.kind === 'error') {
                    const entry = providerResult.entry
                    stableEntries.push(entry)
                    this.notifyContextChanged()
                    yield {
                        type: 'assistant-end',
                        ...scope,
                        entry: snapshotClone(entry),
                    }
                    if (!terminalEmitted) {
                        yield {
                            type: 'error',
                            ...scope,
                            message: entry.errorMessage ?? 'Unknown error',
                        }
                        terminalEmitted = true
                    }
                    break
                }

                // Success terminal assistant.
                const assistant = providerResult.entry
                stableEntries.push(snapshotClone(assistant))
                yield {
                    type: 'assistant-end',
                    ...scope,
                    entry: snapshotClone(assistant),
                }

                // Abort race after assistant-end: never emit ordinary error.
                if (signal.aborted || token !== this.activeToken) {
                    if (!terminalEmitted) {
                        yield { type: 'aborted', ...scope }
                        terminalEmitted = true
                    }
                    break
                }

                // Only execute tools on final stopReason toolUse.
                // length with tool calls must never execute.
                if (assistant.stopReason !== 'toolUse') {
                    const steers = resolveSteerEntries()
                    if (steers && steers.length > 0) {
                        for (const steer of steers) {
                            const consumed = {
                                ...snapshotClone(steer),
                                pendingStatus: undefined,
                                createdAt: steer.createdAt ?? Date.now(),
                            }
                            stableEntries.push(consumed)
                            this.notifyContextChanged()
                            yield {
                                type: 'user-entry',
                                ...scope,
                                entry: snapshotClone(consumed),
                            }
                        }
                        continue
                    }
                    break
                }

                const { selected: toolCalls, skipped } = extractToolCalls(assistant)
                for (const skip of skipped) {
                    yield {
                        type: 'diagnostic',
                        ...scope,
                        code: 'duplicate_tool_call',
                        message: `Skipped duplicate tool call id=${skip.id} (normalized=${codexCallId(skip.id)}); first-wins keeps a single provider pair`,
                    }
                }

                if (toolCalls.length === 0) {
                    break
                }

                yield* this.executeToolBatch({
                    toolCalls,
                    toolsByName,
                    requestApproval,
                    cwd,
                    model,
                    signal,
                    scope,
                    token,
                    stableEntries,
                })

                if (signal.aborted || token !== this.activeToken) {
                    if (!terminalEmitted) {
                        yield { type: 'aborted', ...scope }
                        terminalEmitted = true
                    }
                    break
                }

                // If steer entries exist, inject them right after tool results so they are sent alongside tool results to the provider
                const steers = resolveSteerEntries()
                if (steers && steers.length > 0) {
                    for (const steer of steers) {
                        const consumed = {
                            ...snapshotClone(steer),
                            pendingStatus: undefined,
                            createdAt: steer.createdAt ?? Date.now(),
                        }
                        stableEntries.push(consumed)
                        this.notifyContextChanged()
                        yield {
                            type: 'user-entry',
                            ...scope,
                            entry: snapshotClone(consumed),
                        }
                    }
                }

                // Post-tool / next-provider compaction check.
                yield* this.awaitCompact(stableEntries, {
                    model,
                    sessionId: input.sessionId,
                    reasoningEffort: resolveCurrentReasoningEffort(),
                    speed: resolveCurrentSpeed(),
                    signal,
                    settings: compactionSettings,
                    fastContextCompaction,
                    force: false,
                    scope,
                    client: this.client,
                })
            }

            if (signal.aborted && !terminalEmitted) {
                yield { type: 'aborted', ...scope }
                terminalEmitted = true
            }

            yield* emitAgentEnd()
        } catch (error) {
            if (isAbortError(error) || signal.aborted) {
                if (!terminalEmitted) {
                    yield { type: 'aborted', ...scope }
                    terminalEmitted = true
                }
                yield* emitAgentEnd()
            } else {
                const message = errorMessageOf(error)
                if (!terminalEmitted) {
                    yield { type: 'error', ...scope, message }
                    terminalEmitted = true
                }
                yield* emitAgentEnd()
            }
        }
    }

    private async *awaitCompact(
        stableEntries: ConversationEntry[],
        args: {
            model: ModelCatalogEntry
            sessionId: string
            reasoningEffort?: string
            speed?: string
            signal: AbortSignal
            settings?: Partial<CompactionSettings> | null
            fastContextCompaction: boolean
            force: boolean
            scope: { runId: string; sessionId: string }
            client: ProtocolClient
        },
    ): AsyncGenerator<
        AgentRunEvent,
        {
            did: boolean
            entry?: CompactionEntry
            aborted?: boolean
        },
        undefined
    > {
        if (args.signal.aborted) {
            return { did: false, aborted: true }
        }

        const estimate = estimateContextTokens(stableEntries)
        const needs =
            args.force ||
            shouldCompact(
                estimate.tokens,
                args.model.contextWindow,
                args.settings,
            )
        if (!needs) {
            return { did: false }
        }

        // Yield before awaiting so the UI can show the in-progress divider.
        yield { type: 'compaction-start', ...args.scope }
        try {
            const preCompactOutcome = await HookProvider.execute(
                'PreCompact',
                {
                    event: 'PreCompact',
                    sessionId: args.sessionId,
                    payload: {
                        hook_event_name: 'PreCompact',
                        session_id: args.sessionId,
                        trigger: args.force ? 'manual' : 'auto',
                        cwd: '',
                    },
                    signal: args.signal,
                },
                {
                    hooks: this.getEffectiveHooks(),
                    extensionRegistry: this.extensionRegistry,
                },
            )
            if (!preCompactOutcome.continue) {
                yield { type: 'compaction-end', ...args.scope }
                return { did: false }
            }

            // Race abort so a never-settling compact cannot pin cleanup.
            // Underlying promise is observed inside raceAbort.
            const result = await raceAbort(
                this.compact(stableEntries, {
                    client: args.client,
                    model: args.model,
                    sessionId: args.sessionId,
                    reasoningEffort: args.reasoningEffort,
                    speed: args.speed,
                    fastContextCompaction: args.fastContextCompaction,
                    signal: args.signal,
                    settings: args.settings,
                    force: args.force,
                    now: this.now,
                    generateId: this.generateId,
                    sleep: this.sleep,
                }),
                args.signal,
            )

            if (args.signal.aborted) {
                yield { type: 'compaction-end', ...args.scope }
                return { did: false, aborted: true }
            }

            // Replace stable entries with compacted result (defensive copies).
            stableEntries.length = 0
            for (const entry of result.entries) {
                stableEntries.push(snapshotClone(entry))
            }
            this.notifyContextChanged()
            yield {
                type: 'compaction-end',
                ...args.scope,
                entry: snapshotClone(result.entry),
            }
            // Force path requires a real compaction entry to allow retry.
            if (!result.entry) {
                return { did: false }
            }

            try {
                await HookProvider.execute(
                    'PostCompact',
                    {
                        event: 'PostCompact',
                        sessionId: args.sessionId,
                        payload: {
                            hook_event_name: 'PostCompact',
                            session_id: args.sessionId,
                            trigger: args.force ? 'manual' : 'auto',
                            cwd: '',
                        },
                        signal: args.signal,
                    },
                    {
                        hooks: this.getEffectiveHooks(),
                        extensionRegistry: this.extensionRegistry,
                    },
                )
            } catch {
                // Fail open
            }

            return { did: true, entry: result.entry }
        } catch (error) {
            yield { type: 'compaction-end', ...args.scope }
            if (isAbortError(error) || args.signal.aborted) {
                return { did: false, aborted: true }
            }
            // Compaction failure must not pollute stable entries / allow retry.
            return { did: false }
        }
    }

    private async *runProviderTurn(args: {
        stableEntries: ConversationEntry[]
        assistantId: string
        model: ModelCatalogEntry
        systemPrompt: string
        developerPrompt?: string
        toolDefs: ProtocolToolDefinition[] | undefined
        reasoningEffort?: string
        speed?: string
        fastContextCompaction: boolean
        signal: AbortSignal
        scope: { runId: string; sessionId: string }
        token: number
    }): AsyncGenerator<
        AgentRunEvent,
        | { kind: 'success'; entry: AssistantEntry }
        | { kind: 'error'; entry: AssistantEntry }
        | { kind: 'aborted'; entry: AssistantEntry },
        undefined
    > {
        const {
            stableEntries,
            assistantId,
            model,
            systemPrompt,
            toolDefs,
            reasoningEffort,
            speed,
            fastContextCompaction,
            signal,
            scope,
            token,
        } = args

        let overflowRetried = false
        let retryIndex = 0

        while (true) {
            if (signal.aborted || token !== this.activeToken) {
                const seed = createSeedAssistant(
                    scope.sessionId,
                    assistantId,
                    this.now(),
                    model,
                    reasoningEffort,
                )
                return {
                    kind: 'aborted',
                    entry: finalizeErrorAssistant(seed, 'Request was aborted', 'aborted'),
                }
            }

            // Same assistant ID across retries of this provider turn.
            const seed = createSeedAssistant(
                scope.sessionId,
                assistantId,
                this.now(),
                model,
                reasoningEffort,
            )

            // Emit assistant-start (reset on each attempt including retries).
            yield {
                type: 'assistant-start',
                ...scope,
                entry: snapshotClone(seed),
            }

            const middlewares = this.getMiddlewares()
            const pipeline = new ProtocolMiddlewarePipeline(middlewares)

            const streamInput: ProtocolStreamInput = {
                model,
                systemPrompt,
                developerPrompt: args.developerPrompt,
                entries: buildCompactedContext(stableEntries),
                tools: toolDefs,
                reasoningEffort,
                speed,
                seed,
            }

            let effectiveInput: ProtocolStreamInput = streamInput
            try {
                effectiveInput = await pipeline.executeRequest(streamInput, {
                    signal,
                })
            } catch (mwErr) {
                console.error(
                    '[AgentLoop] Error executing middleware pipeline.executeRequest:',
                    mwErr,
                )
            }

            if (signal.aborted || token !== this.activeToken) {
                const entry = finalizeErrorAssistant(
                    seed,
                    'Request was aborted',
                    'aborted',
                )
                return { kind: 'aborted', entry }
            }

            let streamError: unknown
            let finalEntry: AssistantEntry | undefined
            let generator: AsyncIterator<AssistantStreamEvent> | undefined

            const currentRev = this.contextRevision
            try {
                const rawStream = this.client.stream(
                    effectiveInput,
                    { signal },
                )
                this.onRequestSent?.(effectiveInput, () => this.contextRevision === currentRev)
                const wrappedStream = pipeline.executeStream(rawStream, {
                    sessionId: scope.sessionId,
                    model: model.id,
                })
                generator = wrappedStream[Symbol.asyncIterator]()
            } catch (error) {
                streamError = error
            }

            if (!streamError && generator) {
                // Publish so consumer return/abort can fire provider.return without
                // waiting for this generator's finally (return may never settle).
                this.setActiveProvider(token, generator)
                try {
                    let pendingDelta: AssistantDeltaEvent | null = null
                    let lastSnapshotAt = Number.NEGATIVE_INFINITY

                    const snapshotUpdate = (
                        streamEvent: AssistantStreamEvent,
                    ): AgentRunEvent => {
                        const partial =
                            'partial' in streamEvent && streamEvent.partial
                                ? streamEvent.partial
                                : seed
                        const partialSnapshot = this.cloneStreamSnapshots
                            ? snapshotClone(partial)
                            : partial
                        let eventSnapshot: AssistantStreamEvent
                        if (!this.cloneStreamSnapshots) {
                            eventSnapshot = streamEvent
                        } else if (
                            streamEvent.type !== 'done' &&
                            streamEvent.type !== 'error' &&
                            'partial' in streamEvent
                        ) {
                            const { partial: _partial, ...eventWithoutPartial } = streamEvent
                            eventSnapshot = {
                                ...snapshotClone(eventWithoutPartial),
                                partial: partialSnapshot,
                            } as AssistantStreamEvent
                        } else {
                            eventSnapshot = snapshotClone(streamEvent)
                        }
                        return {
                            type: 'assistant-update',
                            ...scope,
                            entry: partialSnapshot,
                            streamEvent: eventSnapshot,
                        }
                    }

                    while (true) {
                        if (signal.aborted || token !== this.activeToken) {
                            throw createAbortError()
                        }

                        const nextPromise = generator.next()
                        let next: IteratorResult<AssistantStreamEvent, AssistantEntry | void>
                        try {
                            next = await raceAbort(nextPromise, signal)
                        } catch (error) {
                            // Observe late settlement; never yield after abort.
                            observePromise(nextPromise)
                            throw error
                        }

                        // Re-check after successful next — token/signal may have flipped.
                        if (signal.aborted || token !== this.activeToken) {
                            throw createAbortError()
                        }

                        if (next.done) {
                            if (pendingDelta) {
                                yield snapshotUpdate(pendingDelta)
                            }
                            finalEntry = (next.value as AssistantEntry | undefined) ?? finalEntry ?? seed
                            break
                        }

                        const streamEvent = next.value as AssistantStreamEvent
                        if (streamEvent.type === 'done') {
                            finalEntry = streamEvent.message
                        } else if (streamEvent.type === 'error') {
                            finalEntry = streamEvent.error
                        }

                        const eventsToSnapshot: AssistantStreamEvent[] = []
                        if (
                            this.streamUpdateIntervalMs > 0 &&
                            isAssistantDeltaEvent(streamEvent)
                        ) {
                            if (pendingDelta) {
                                const merged = mergeAssistantDeltaEvents(
                                    pendingDelta,
                                    streamEvent,
                                )
                                if (merged) {
                                    pendingDelta = merged
                                } else {
                                    eventsToSnapshot.push(pendingDelta)
                                    pendingDelta = streamEvent
                                }
                            } else {
                                pendingDelta = streamEvent
                            }

                            if (
                                eventsToSnapshot.length === 0 &&
                                this.now() - lastSnapshotAt >=
                                    this.streamUpdateIntervalMs
                            ) {
                                eventsToSnapshot.push(pendingDelta)
                                pendingDelta = null
                            }
                        } else {
                            if (pendingDelta) {
                                eventsToSnapshot.push(pendingDelta)
                                pendingDelta = null
                            }
                            eventsToSnapshot.push(streamEvent)
                        }

                        for (const eventToSnapshot of eventsToSnapshot) {
                            // Final token/signal gate before yield.
                            if (signal.aborted || token !== this.activeToken) {
                                throw createAbortError()
                            }
                            yield snapshotUpdate(eventToSnapshot)
                            lastSnapshotAt = this.now()
                        }
                    }
                } catch (error) {
                    streamError = error
                } finally {
                    // Owner+generator match only — never clear/release a newer run's slot.
                    // Provider return may never settle — fire-and-observe only.
                    this.releaseActiveProvider(token, generator, seed)
                }
            }

            if (signal.aborted || token !== this.activeToken || (streamError && isAbortError(streamError))) {
                const entry = finalizeErrorAssistant(
                    seed,
                    'Request was aborted',
                    'aborted',
                )
                return { kind: 'aborted', entry }
            }

            if (streamError) {
                const klass = classifyAgentError(streamError)
                const message = errorMessageOf(streamError)

                if (klass === 'context_overflow') {
                    if (overflowRetried) {
                        // Second overflow terminates — no partial left streaming.
                        const entry = finalizeErrorAssistant(seed, message, 'error')
                        return { kind: 'error', entry }
                    }
                    overflowRetried = true
                    // Discard temp attempt (not persisted). Force compact then retry once
                    // only when compaction actually applied a new entry.
                    const compactOutcome = yield* this.awaitCompact(stableEntries, {
                        model,
                        sessionId: scope.sessionId,
                        reasoningEffort,
                        speed,
                        signal,
                        settings: null,
                        fastContextCompaction,
                        force: true,
                        scope,
                        client: this.client,
                    })
                    if (compactOutcome.aborted || signal.aborted || token !== this.activeToken) {
                        const entry = finalizeErrorAssistant(
                            seed,
                            'Request was aborted',
                            'aborted',
                        )
                        return { kind: 'aborted', entry }
                    }
                    if (!compactOutcome.did || !compactOutcome.entry) {
                        // Prepare impossible / summary failure — do not request again.
                        const entry = finalizeErrorAssistant(seed, message, 'error')
                        return { kind: 'error', entry }
                    }
                    continue
                }

                if (klass === 'transient' && retryIndex < this.retryDelaysMs.length) {
                    const delayMs = this.retryDelaysMs[retryIndex]!
                    yield {
                        type: 'retrying',
                        ...scope,
                        attempt: retryIndex + 1,
                        delayMs,
                        error: message,
                    }
                    try {
                        await this.sleep(delayMs, signal)
                    } catch (sleepError) {
                        if (isAbortError(sleepError) || signal.aborted) {
                            const entry = finalizeErrorAssistant(
                                seed,
                                'Request was aborted',
                                'aborted',
                            )
                            return { kind: 'aborted', entry }
                        }
                        throw sleepError
                    }
                    retryIndex += 1
                    continue
                }

                // Fatal or retries exhausted → single canonical error assistant.
                const entry = finalizeErrorAssistant(seed, message, 'error')
                return { kind: 'error', entry }
            }

            if (!finalEntry) {
                const entry = finalizeErrorAssistant(
                    seed,
                    'Provider stream completed without a terminal entry',
                    'error',
                )
                return { kind: 'error', entry }
            }

            // Successful terminal — only stable on success.
            if (finalEntry.stopReason === 'aborted' || finalEntry.status === 'aborted') {
                return {
                    kind: 'aborted',
                    entry: snapshotClone(finalEntry),
                }
            }
            if (finalEntry.stopReason === 'error' || finalEntry.status === 'error') {
                const message = finalEntry.errorMessage ?? 'Provider error'
                const klass = classifyAgentError(
                    Object.assign(new Error(message), {
                        status: (finalEntry as { statusCode?: number }).statusCode,
                    }),
                )
                if (klass === 'context_overflow' && !overflowRetried) {
                    overflowRetried = true
                    const compactOutcome = yield* this.awaitCompact(stableEntries, {
                        model,
                        sessionId: scope.sessionId,
                        reasoningEffort,
                        speed,
                        signal,
                        settings: null,
                        fastContextCompaction,
                        force: true,
                        scope,
                        client: this.client,
                    })
                    if (compactOutcome.aborted || signal.aborted || token !== this.activeToken) {
                        return {
                            kind: 'aborted',
                            entry: finalizeErrorAssistant(
                                seed,
                                'Request was aborted',
                                'aborted',
                            ),
                        }
                    }
                    if (!compactOutcome.did || !compactOutcome.entry) {
                        return {
                            kind: 'error',
                            entry: finalizeErrorAssistant(seed, message, 'error'),
                        }
                    }
                    continue
                }
                if (klass === 'transient' && retryIndex < this.retryDelaysMs.length) {
                    const delayMs = this.retryDelaysMs[retryIndex]!
                    yield {
                        type: 'retrying',
                        ...scope,
                        attempt: retryIndex + 1,
                        delayMs,
                        error: message,
                    }
                    try {
                        await this.sleep(delayMs, signal)
                    } catch (sleepError) {
                        if (isAbortError(sleepError) || signal.aborted) {
                            return {
                                kind: 'aborted',
                                entry: finalizeErrorAssistant(
                                    seed,
                                    'Request was aborted',
                                    'aborted',
                                ),
                            }
                        }
                        throw sleepError
                    }
                    retryIndex += 1
                    continue
                }
                return {
                    kind: 'error',
                    entry: snapshotClone({
                        ...finalEntry,
                        stopReason: 'error',
                        status: 'error',
                        errorMessage: message,
                    }),
                }
            }

            return { kind: 'success', entry: snapshotClone(finalEntry) }
        }
    }

    private async *executeToolBatch(args: {
        toolCalls: AssistantToolCallBlock[]
        toolsByName: Map<string, AgentTool>
        requestApproval: boolean
        cwd?: string
        model: ModelCatalogEntry
        signal: AbortSignal
        scope: { runId: string; sessionId: string }
        token: number
        stableEntries: ConversationEntry[]
    }): AsyncGenerator<AgentRunEvent, void, undefined> {
        const {
            toolCalls,
            toolsByName,
            requestApproval,
            cwd,
            model,
            signal,
            scope,
            token,
            stableEntries,
        } = args

        const sink = createEventSink()
        const results: Array<{
            toolCall: AssistantToolCallBlock
            result: ToolResult
        } | undefined> = new Array(toolCalls.length)
        let remaining = toolCalls.length

        const finish = (index: number, toolCall: AssistantToolCallBlock, result: ToolResult): void => {
            if (results[index]) return
            // Every caller canonicalizes plugin output before reaching this sink.
            results[index] = {
                toolCall,
                result: snapshotClone(result),
            }
            remaining -= 1
            if (remaining <= 0) sink.close()
        }

        const emitToolEnd = (
            toolCallId: string,
            toolName: string,
            result: ToolResult,
            toolCall?: AssistantToolCallBlock,
        ): void => {
            const entry = toolCall
                ? this.toToolResultEntry(scope.sessionId, toolCall, result)
                : this.toToolResultEntry(
                      scope.sessionId,
                      {
                          type: 'toolCall',
                          id: toolCallId,
                          name: toolName,
                          arguments: {},
                      },
                      result,
                  )
            sink.push({
                type: 'tool-end',
                ...scope,
                toolCallId,
                toolName,
                result: snapshotClone(result),
                isError: Boolean(result.isError),
                entry: snapshotClone(entry),
            })
        }

        const forceAbortSlot = (index: number, toolCall: AssistantToolCallBlock): void => {
            if (results[index]) return
            const records = this.modelInvoker?.takeRecords(toolCall.id) ?? []
            const result = canonicalToolResult(
                textToolResult(ABORTED_TOOL_MESSAGE, true),
                records,
            )
            emitToolEnd(toolCall.id, toolCall.name, result, toolCall)
            finish(index, toolCall, result)
        }

        const onAbort = (): void => {
            for (let i = 0; i < toolCalls.length; i++) {
                forceAbortSlot(i, toolCalls[i]!)
            }
        }
        if (signal.aborted) {
            onAbort()
        } else {
            signal.addEventListener('abort', onAbort)
        }

        const runOne = async (index: number, toolCall: AssistantToolCallBlock): Promise<void> => {
            const toolName = toolCall.name
            const toolCallId = toolCall.id
            let settled = false
            let rawArgs: Record<string, unknown> = {}

            try {
                try {
                    rawArgs = snapshotClone(toolCall.arguments) as Record<string, unknown>
                } catch (error) {
                    const result = textToolResult(errorMessageOf(error), true)
                    sink.push({
                        type: 'tool-start',
                        ...scope,
                        toolCallId,
                        toolName,
                        args: {},
                    })
                    emitToolEnd(toolCallId, toolName, result, toolCall)
                    finish(index, toolCall, result)
                    return
                }

                if (signal.aborted || token !== this.activeToken) {
                    forceAbortSlot(index, toolCall)
                    return
                }

                const tool = findToolByNameOrAlias(Array.from(toolsByName.values()), toolName)
                if (!tool) {
                    const result = textToolResult(
                        `${UNKNOWN_TOOL_PREFIX} ${toolName}`,
                        true,
                    )
                    sink.push({
                        type: 'tool-start',
                        ...scope,
                        toolCallId,
                        toolName,
                        args: rawArgs,
                    })
                    emitToolEnd(toolCallId, toolName, result, toolCall)
                    finish(index, toolCall, result)
                    return
                }

                // Validate args first.
                let validated: Record<string, unknown>
                try {
                    validated = (tool.validate(toolCall.arguments) as Record<string, unknown>) ?? {}
                } catch (error) {
                    const result = textToolResult(errorMessageOf(error), true)
                    sink.push({
                        type: 'tool-start',
                        ...scope,
                        toolCallId,
                        toolName,
                        args: rawArgs,
                    })
                    emitToolEnd(toolCallId, toolName, result, toolCall)
                    finish(index, toolCall, result)
                    return
                }

                let effectiveValidated: Record<string, unknown> = validated
                let hookPermissionDecision: 'allow' | 'deny' | 'ask' | undefined

                try {
                    const preOutcome = await HookProvider.execute(
                        'PreToolUse',
                        {
                            event: 'PreToolUse',
                            sessionId: scope.sessionId,
                            payload: {
                                hook_event_name: 'PreToolUse',
                                session_id: scope.sessionId,
                                cwd: cwd ?? '',
                                model: model.id,
                                permission_mode: requestApproval ? 'default' : 'bypassPermissions',
                                tool_name: toolName,
                                tool_input: validated,
                                tool_use_id: toolCallId,
                            },
                            signal,
                        },
                        {
                            hooks: this.getEffectiveHooks(),
                            extensionRegistry: this.extensionRegistry,
                        },
                    )

                    if (!preOutcome.continue || preOutcome.decision === 'deny') {
                        const result = textToolResult(
                            preOutcome.stopReason || preOutcome.message || 'Tool blocked by hook policy',
                            true,
                        )
                        emitToolEnd(toolCallId, toolName, result, toolCall)
                        finish(index, toolCall, result)
                        return
                    }

                    if (preOutcome.updatedInput !== undefined && preOutcome.updatedInput !== null && typeof preOutcome.updatedInput === 'object') {
                        effectiveValidated = preOutcome.updatedInput as Record<string, unknown>
                    }
                    if (preOutcome.permissionMode) {
                        hookPermissionDecision = preOutcome.permissionMode
                    }
                } catch {
                    // Fail open
                }

                // Approval: metadata-driven policy when requestApproval is true (unless auto-allowed by hook).
                const approvalPolicy = selectApprovalPolicy(tool ?? toolName)
                if (requestApproval && approvalPolicy.requiresApproval && hookPermissionDecision !== 'allow') {
                    if (hookPermissionDecision === 'deny') {
                        const result = textToolResult(TOOL_REJECTED_MESSAGE, true)
                        emitToolEnd(toolCallId, toolName, result, toolCall)
                        finish(index, toolCall, result)
                        return
                    }

                    let shouldPrompt = true
                    try {
                        const permOutcome = await HookProvider.execute(
                            'PermissionRequest',
                            {
                                event: 'PermissionRequest',
                                sessionId: scope.sessionId,
                                payload: {
                                    hook_event_name: 'PermissionRequest',
                                    session_id: scope.sessionId,
                                    cwd: cwd ?? '',
                                    model: model.id,
                                    permission_mode: 'default',
                                    tool_name: toolName,
                                    tool_input: effectiveValidated,
                                    tool_use_id: toolCallId,
                                },
                                signal,
                            },
                            {
                                hooks: this.getEffectiveHooks(),
                                extensionRegistry: this.extensionRegistry,
                            },
                        )
                        if (permOutcome.decision === 'allow') {
                            shouldPrompt = false
                        } else if (permOutcome.decision === 'deny' || !permOutcome.continue) {
                            const result = textToolResult(TOOL_REJECTED_MESSAGE, true)
                            emitToolEnd(toolCallId, toolName, result, toolCall)
                            finish(index, toolCall, result)
                            return
                        }
                    } catch {
                        // Fail open
                    }

                    if (shouldPrompt) {
                        sink.push({
                            type: 'tool-approval-required',
                            ...scope,
                            toolCallId,
                            toolName,
                            args: snapshotClone(effectiveValidated as Record<string, unknown>),
                        })
                        let decision: 'approved' | 'rejected' | 'aborted'
                        try {
                            decision = await raceAbort(
                                this.approvals.waitForApproval(
                                    scope.runId,
                                    toolCallId,
                                    signal,
                                ),
                                signal,
                            )
                        } catch (error) {
                            if (isAbortError(error) || signal.aborted) {
                                forceAbortSlot(index, toolCall)
                                return
                            }
                            const result = textToolResult(errorMessageOf(error), true)
                            emitToolEnd(toolCallId, toolName, result, toolCall)
                            finish(index, toolCall, result)
                            return
                        }

                        if (decision === 'rejected') {
                            const result = textToolResult(TOOL_REJECTED_MESSAGE, true)
                            emitToolEnd(toolCallId, toolName, result, toolCall)
                            finish(index, toolCall, result)
                            return
                        }
                        if (decision === 'aborted' || signal.aborted || token !== this.activeToken) {
                            forceAbortSlot(index, toolCall)
                            return
                        }
                    }
                }

                if (signal.aborted || token !== this.activeToken) {
                    forceAbortSlot(index, toolCall)
                    return
                }

                sink.push({
                    type: 'tool-start',
                    ...scope,
                    toolCallId,
                    toolName,
                    args: snapshotClone(effectiveValidated),
                })

                const onUpdate = (partial: ToolResult): void => {
                    // Ignore late updates after settle or when run is stale.
                    if (settled) return
                    if (results[index]) return
                    if (signal.aborted) return
                    if (token !== this.activeToken) return
                    sink.push({
                        type: 'tool-update',
                        ...scope,
                        toolCallId,
                        toolName,
                        result: snapshotClone(canonicalToolResult(partial)),
                    })
                }

                const executePromise = tool.execute(toolCallId, effectiveValidated, {
                    signal,
                    cwd,
                    sessionId: scope.sessionId,
                    onUpdate,
                    modelInvoker: selectApprovalPolicy(tool).riskLevel === 'network'
                        ? this.modelInvoker?.forToolCall(toolCallId)
                        : undefined,
                })
                // Always observe underlying execute so late settle is harmless.
                observePromise(executePromise)

                let result: ToolResult
                try {
                    result = await raceAbort(executePromise, signal)
                } catch (error) {
                    settled = true
                    if (results[index]) return
                    if (isAbortError(error) || signal.aborted || token !== this.activeToken) {
                        forceAbortSlot(index, toolCall)
                        return
                    }
                    const invocationRecords = this.modelInvoker?.takeRecords(toolCallId) ?? []
                    const errResult: ToolResult = {
                        ...textToolResult(errorMessageOf(error), true),
                        ...(invocationRecords.length > 0
                            ? { isolatedModelInvocations: invocationRecords }
                            : {}),
                    }
                    emitToolEnd(toolCallId, toolName, errResult, toolCall)
                    finish(index, toolCall, errResult)
                    return
                }

                settled = true

                // Re-check after success — abort/token may have flipped; never emit late.
                if (results[index]) return
                if (signal.aborted || token !== this.activeToken) {
                    forceAbortSlot(index, toolCall)
                    return
                }

                // Strip plugin-authored accounting immediately, but leave owner records
                // pending so an abort/error during post hooks can still claim them.
                let finalResult = canonicalToolResult(result)

                try {
                    const postOutcome = await HookProvider.execute(
                        'PostToolUse',
                        {
                            event: 'PostToolUse',
                            sessionId: scope.sessionId,
                            payload: {
                                hook_event_name: 'PostToolUse',
                                session_id: scope.sessionId,
                                cwd: cwd ?? '',
                                model: model.id,
                                permission_mode: requestApproval ? 'default' : 'bypassPermissions',
                                tool_name: toolName,
                                tool_input: effectiveValidated,
                                tool_output: finalResult.content,
                                tool_error: finalResult.isError
                                    ? finalResult.content[0]?.type === 'text'
                                        ? finalResult.content[0].text
                                        : undefined
                                    : undefined,
                                tool_use_id: toolCallId,
                            },
                            signal,
                        },
                        {
                            hooks: this.getEffectiveHooks(),
                            extensionRegistry: this.extensionRegistry,
                        },
                    )
                    if (postOutcome.additionalContexts.length > 0) {
                        const extraBlocks: ToolResultContentBlock[] = postOutcome.additionalContexts.map(
                            (ctx) => ({
                                type: 'text' as const,
                                text: `\n\n[Hook context]:\n${ctx}`,
                            }),
                        )
                        finalResult = {
                            ...finalResult,
                            content: [...finalResult.content, ...extraBlocks],
                        }
                    }
                } catch {
                    // Fail open
                }

                if (results[index]) return
                const invocationRecords = this.modelInvoker?.takeRecords(toolCallId) ?? []
                finalResult = canonicalToolResult(finalResult, invocationRecords)
                emitToolEnd(toolCallId, toolName, finalResult, toolCall)
                finish(index, toolCall, finalResult)
            } catch (error) {
                settled = true
                if (results[index]) return
                const invocationRecords = this.modelInvoker?.takeRecords(toolCallId) ?? []
                const result: ToolResult = {
                    ...textToolResult(
                        isAbortError(error) || signal.aborted
                            ? ABORTED_TOOL_MESSAGE
                            : errorMessageOf(error),
                        true,
                    ),
                    ...(invocationRecords.length > 0
                        ? { isolatedModelInvocations: invocationRecords }
                        : {}),
                }
                emitToolEnd(toolCallId, toolName, result, toolCall)
                finish(index, toolCall, result)
            } finally {
                // Guarantee remaining/queue progress even if finish was missed.
                if (!results[index]) {
                    forceAbortSlot(index, toolCall)
                }
            }
        }

        // Launch all tools in parallel; each producer is fully guarded.
        for (let i = 0; i < toolCalls.length; i++) {
            void runOne(i, toolCalls[i]!).catch(() => {
                // Final safety: never leave unhandled rejection from a producer.
                forceAbortSlot(i, toolCalls[i]!)
            })
        }

        // Drain events in completion order until all tools finish.
        // Abort unblocks wait by force-finishing slots → sink.close().
        while (!sink.isClosed() || sink.pending > 0) {
            const event = sink.take()
            if (event) {
                yield event
                continue
            }
            if (sink.isClosed()) break
            if (signal.aborted) {
                onAbort()
                continue
            }
            await Promise.race([
                sink.wait(),
                new Promise<void>((resolve) => {
                    if (signal.aborted) {
                        resolve()
                        return
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true })
                }),
            ])
        }

        signal.removeEventListener('abort', onAbort)

        // Append ToolResultEntry in strict source order (not completion order).
        // Keep canonical text + image blocks; details already stripped.
        for (let i = 0; i < toolCalls.length; i++) {
            const item = results[i]
            if (!item) {
                const tc = toolCalls[i]!
                const result = textToolResult(ABORTED_TOOL_MESSAGE, true)
                stableEntries.push(this.toToolResultEntry(scope.sessionId, tc, result))
                continue
            }
            stableEntries.push(
                this.toToolResultEntry(scope.sessionId, item.toolCall, item.result),
            )
        }
        this.notifyContextChanged()
    }

    private toToolResultEntry(
        sessionId: string,
        toolCall: AssistantToolCallBlock,
        result: ToolResult,
    ): ToolResultEntry {
        // Keep canonical text + image blocks (deep-copied). Details are not persisted.
        const content: ToolResultContentBlock[] = result.content
            .filter(
                (block): block is ToolResultContentBlock =>
                    block.type === 'text' || block.type === 'image',
            )
            .map((block) => snapshotClone(block))
        if (content.length === 0 && result.isError) {
            content.push({ type: 'text', text: 'Tool failed' })
        }
        return {
            // Deterministic id uses normalized call_id first segment.
            id: `tool-result:${sessionId}:${codexCallId(toolCall.id)}`,
            sessionId,
            createdAt: this.now(),
            kind: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content,
            isError: Boolean(result.isError),
            ...(result.isolatedModelInvocations?.length
                ? {
                      isolatedModelInvocations: snapshotClone(
                          result.isolatedModelInvocations,
                      ),
                  }
                : {}),
        } as ToolResultEntry
    }
}

// Re-export helper so tests can import tool policy alongside the loop.
export { TOOL_REJECTED_MESSAGE, isMutatingToolName }
