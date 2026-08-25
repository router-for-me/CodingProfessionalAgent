/**
 * Codex Responses client: request builder + connection manager + stream parser.
 * Transport is NativeBridge WebSocket only — no SSE / EventSource / fetch fallback.
 */

import type {
    AssistantEntry,
    AssistantStreamEvent,
    ConversationEntry,
    ModelCatalogEntry,
} from '@cpa/plugin-api'
import {
    CodexConnectionManager,
    type CodexConnectionLease,
    type CodexConnectionMode,
} from './codexConnectionManager.js'
import {
    buildCodexRequest,
    type BuildCodexRequestInput,
    type CodexRequestSpeed,
} from './codexRequest.js'
import { parseCodexEvents } from './codexStream.js'
import type {
    CodexInputItem,
    CodexToolDefinition,
    NativeBridge,
} from './types.js'

export interface CodexClientOptions {
    bridge: NativeBridge
    apiKey: string
    baseUrl: string
    sessionId: string
    now?: () => number
    generateRequestId?: () => string
    connectionManager?: CodexConnectionManager
    /**
     * Opaque service-assigned namespace for session socket cache isolation.
     * Never derived from the API key. Omitted → manager default namespace.
     */
    connectionNamespace?: string
}

export interface CodexClientStreamInput {
    model: ModelCatalogEntry
    systemPrompt: string
    entries: readonly ConversationEntry[]
    tools?: readonly CodexToolDefinition[]
    reasoningEffort?: string
    speed?: CodexRequestSpeed | string
    /** Mutable assistant entry updated by the stream parser. */
    seed: AssistantEntry
}

export interface CodexClientStreamOptions {
    connectionMode?: CodexConnectionMode
    /**
     * Override prompt_cache_key for this turn (isolated summarization).
     * Does not change the client's main session id or session cache key.
     */
    promptCacheKey?: string
    /**
     * Summary-only output budget mapped to wire `max_output_tokens`.
     * Must remain unset for normal session turns.
     */
    maxOutputTokens?: number
}

function isCodexInputItem(value: unknown): value is CodexInputItem {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const record = value as Record<string, unknown>
    if (record.role === 'user' && Array.isArray(record.content)) {
        return true
    }
    if (typeof record.type === 'string') {
        return (
            record.type === 'message' ||
            record.type === 'function_call' ||
            record.type === 'function_call_output' ||
            record.type === 'reasoning'
        )
    }
    return false
}

export class CodexClient {
    private readonly apiKey: string
    private readonly baseUrl: string
    private readonly sessionId: string
    private readonly manager: CodexConnectionManager
    private readonly generateRequestId: () => string
    private readonly connectionNamespace: string | undefined

    constructor(options: CodexClientOptions) {
        this.apiKey = options.apiKey
        this.baseUrl = options.baseUrl
        this.sessionId = options.sessionId
        this.connectionNamespace = options.connectionNamespace
        this.generateRequestId =
            options.generateRequestId ??
            (() =>
                typeof globalThis.crypto?.randomUUID === 'function'
                    ? globalThis.crypto.randomUUID()
                    : `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)
        this.manager =
            options.connectionManager &&
            typeof (options.connectionManager as any).acquire === 'function'
                ? options.connectionManager
                : new CodexConnectionManager(options.bridge, {
                      now: options.now,
                      generateRequestId: this.generateRequestId,
                  })
    }

    /**
     * Stream one Codex Responses turn.
     * session mode reuses the cached socket; isolated uses a fresh request id and never touches cache.
     * Early generator return/throw always cancels/evicts in-flight sockets (keep=false) unless the
     * turn reached a successful protocol terminal and committed continuation.
     */
    async *stream(
        input: CodexClientStreamInput,
        signal: AbortSignal,
        options?: CodexClientStreamOptions,
    ): AsyncGenerator<AssistantStreamEvent, AssistantEntry> {
        const mode: CodexConnectionMode = options?.connectionMode ?? 'session'
        // Isolated summarization may override prompt_cache_key without touching the
        // main session id used for connection cache identity.
        const promptCacheKey =
            typeof options?.promptCacheKey === 'string' && options.promptCacheKey.length > 0
                ? options.promptCacheKey
                : this.sessionId
        const buildInput: BuildCodexRequestInput = {
            model: input.model,
            sessionId: promptCacheKey,
            systemPrompt: input.systemPrompt,
            entries: input.entries,
            tools: input.tools,
            reasoningEffort: input.reasoningEffort,
            speed: input.speed as CodexRequestSpeed | undefined,
            maxOutputTokens: options?.maxOutputTokens,
        }
        const fullBody = buildCodexRequest(buildInput)

        let lease: CodexConnectionLease | undefined
        let parser: AsyncGenerator<AssistantStreamEvent, AssistantEntry> | undefined
        let cancelled = false
        // Only successful protocol terminal + commit may keep a session socket.
        let keep = false
        let terminalOutput: CodexInputItem[] | undefined

        const cancelOnce = async (): Promise<void> => {
            if (cancelled) return
            cancelled = true
            keep = false
            if (lease) {
                await lease.cancel()
            }
        }

        // Abort listener must exist before acquire so queued/in-flight waits reject promptly.
        const onAbort = (): void => {
            void cancelOnce()
        }
        if (signal.aborted) {
            throw new Error('Request was aborted')
        }
        signal.addEventListener('abort', onAbort)

        try {
            lease = await this.manager.acquire(
                mode === 'session' ? this.sessionId : null,
                {
                    apiKey: this.apiKey,
                    baseUrl: this.baseUrl,
                    request: fullBody,
                    signal,
                    mode,
                    requestId:
                        mode === 'session' ? this.sessionId : this.generateRequestId(),
                    connectionNamespace: this.connectionNamespace,
                },
            )

            if (signal.aborted) {
                await cancelOnce()
                throw new Error('Request was aborted')
            }

            parser = parseCodexEvents(lease.events, input.seed, {
                onTerminal: (meta) => {
                    if (meta.type === 'completed' || meta.type === 'incomplete') {
                        terminalOutput = meta.responseOutput.filter(isCodexInputItem)
                    }
                },
            })

            while (true) {
                if (signal.aborted) {
                    await cancelOnce()
                    throw new Error('Request was aborted')
                }
                const next = await parser.next()
                if (next.done) {
                    const finalEntry = next.value
                    if (
                        mode === 'session' &&
                        finalEntry.responseId &&
                        terminalOutput &&
                        !cancelled
                    ) {
                        lease.commit({
                            fullRequestBody: fullBody,
                            responseId: finalEntry.responseId,
                            responseItems: terminalOutput,
                        })
                        keep = true
                    } else {
                        keep = false
                    }
                    return finalEntry
                }
                yield next.value
            }
        } catch (error) {
            keep = false
            if (signal.aborted || cancelled) {
                await cancelOnce()
                throw error instanceof Error && /abort/i.test(error.message)
                    ? error
                    : new Error('Request was aborted')
            }
            await cancelOnce()
            throw error
        } finally {
            signal.removeEventListener('abort', onAbort)

            // Explicitly return the parser so nested cleanup cannot leave dangling state.
            if (parser) {
                try {
                    await parser.return?.(input.seed)
                } catch {
                    // ignore parser cleanup errors
                }
            }

            if (lease) {
                if (cancelled) {
                    // cancel already dropped the socket and released the serial lock
                } else if (mode === 'isolated' || !keep) {
                    // Midstream early return / failure: evict and never keep a streaming socket.
                    await lease.release({ keep: false })
                } else {
                    await lease.release({ keep: true })
                }
            }
        }
    }
}
