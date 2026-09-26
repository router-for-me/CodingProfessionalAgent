/**
 * Codex ProtocolSession implementation.
 * Encapsulates CodexClient, CodexConnectionManager, and transport lifecycle.
 */

import type {
    AgentStreamEvent,
    ProtocolSession,
    ProtocolSessionContext,
    ProtocolStreamInput,
    ProtocolStreamOptions,
} from '@cpa/plugin-api'
import { CodexClient, type CodexClientStreamOptions } from './codexClient.js'
import {
    canonicalizeBaseUrl,
    CodexConnectionManager,
    type CodexConnectionMode,
} from './codexConnectionManager.js'
import type { CodexRequestSpeed } from './codexRequest.js'
import type { NativeBridge } from './types.js'
import { isGeminiModelId } from '../shared/gemini.js'
import { requestGeminiSearch, type GeminiSearchTransport } from './geminiSearch.js'

export interface CodexProtocolSessionOptions extends ProtocolSessionContext {
    bridge?: unknown
    connectionManager?: CodexConnectionManager
    generateRequestId?: () => string
    now?: () => number
    geminiSearchTransport?: GeminiSearchTransport
}

function resolveNativeBridge(contextBridge?: unknown): NativeBridge {
    if (contextBridge && typeof contextBridge === 'object') {
        return contextBridge as NativeBridge
    }
    throw new Error(
        'NativeBridge is not available in ProtocolSessionContext'
    )
}

export class CodexProtocolSession implements ProtocolSession {
    readonly id: string
    private readonly client: CodexClient
    private readonly manager: CodexConnectionManager
    private readonly ownsManager: boolean
    private readonly searchConfig: { baseUrl: string; apiKey: string; transport?: GeminiSearchTransport }
    private activeController: AbortController | null = null
    private disposed = false
    private baseReasoningEffort?: string

    constructor(options: CodexProtocolSessionOptions) {
        this.id = options.sessionId
        const bridge = resolveNativeBridge(options.bridge)
        const canonicalBaseUrl = canonicalizeBaseUrl(options.baseUrl)
        this.searchConfig = { baseUrl: canonicalBaseUrl, apiKey: options.apiKey, transport: options.geminiSearchTransport }

        if (
            options.connectionManager &&
            typeof (options.connectionManager as any).acquire === 'function'
        ) {
            this.manager = options.connectionManager
            this.ownsManager = false
        } else {
            this.manager = new CodexConnectionManager(bridge, {
                now: options.now,
                generateRequestId: options.generateRequestId,
            })
            this.ownsManager = true
        }

        this.client = new CodexClient({
            bridge,
            apiKey: options.apiKey,
            baseUrl: canonicalBaseUrl,
            sessionId: options.sessionId,
            connectionManager: this.manager,
            connectionNamespace: options.connectionNamespace,
            generateRequestId: options.generateRequestId,
            now: options.now,
        })
    }

    public async *stream(
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions
    ): AsyncIterable<AgentStreamEvent> {
        if (this.disposed) {
            throw new Error('Cannot stream on a disposed CodexProtocolSession')
        }

        const internalController = new AbortController()
        this.activeController = internalController

        const signal = internalController.signal
        let cleanupAbort: (() => void) | undefined

        if (options?.signal) {
            const externalSignal = options.signal
            if (externalSignal.aborted) {
                internalController.abort(externalSignal.reason)
            } else {
                const onExternalAbort = (): void => {
                    internalController.abort(externalSignal.reason)
                }
                externalSignal.addEventListener('abort', onExternalAbort, { once: true })
                cleanupAbort = (): void => {
                    externalSignal.removeEventListener('abort', onExternalAbort)
                }
            }
        }

        const codexOpts: CodexClientStreamOptions | undefined = options
            ? {
                  connectionMode: options.connectionMode as
                      | CodexConnectionMode
                      | undefined,
                  promptCacheKey: options.promptCacheKey,
                  maxOutputTokens: options.maxOutputTokens,
              }
            : undefined

        if (options?.connectionMode !== 'isolated') {
            if (this.baseReasoningEffort === undefined) {
                for (const entry of input.entries) {
                    if ((entry.kind === 'user' || entry.kind === 'assistant') && entry.reasoningEffort) {
                        this.baseReasoningEffort = entry.reasoningEffort
                        break
                    }
                }
                this.baseReasoningEffort ??= input.reasoningEffort
            }
        }

        const clientInput = {
            ...input,
            baseReasoningEffort:
                options?.connectionMode !== 'isolated'
                    ? this.baseReasoningEffort
                    : undefined,
            speed: input.speed as CodexRequestSpeed | undefined,
        }

        try {
            if (options?.connectionMode === 'isolated' && isGeminiModelId(input.model.id) &&
                input.nativeTools?.some((tool) => tool.type === 'web_search') && input.toolChoice !== 'none') {
                const message = await requestGeminiSearch(input, this.searchConfig, signal, options.maxOutputTokens)
                if (message.stopReason === 'error') {
                    yield { type: 'error', reason: 'error', error: message }
                } else {
                    yield { type: 'done', reason: message.stopReason === 'length' ? 'length' : 'stop', message }
                }
                return
            }
            const rawStream = this.client.stream(
                clientInput,
                signal,
                codexOpts
            )

            for await (const event of rawStream) {
                yield event
            }
        } finally {
            cleanupAbort?.()
            if (this.activeController === internalController) {
                this.activeController = null
            }
        }
    }

    public async cancel(reason?: string): Promise<void> {
        if (this.activeController) {
            this.activeController.abort(reason ?? 'Cancelled by user')
            this.activeController = null
        }
    }

    public async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true

        await this.cancel('Disposing protocol session')

        if (this.ownsManager) {
            try {
                await this.manager.dispose()
            } catch (err) {
                console.error(
                    `[CodexProtocolSession] Error disposing connection manager for session "${this.id}":`,
                    err
                )
            }
        }
    }

    public getConnectionManager(): CodexConnectionManager {
        return this.manager
    }

    public getClient(): CodexClient {
        return this.client
    }
}
