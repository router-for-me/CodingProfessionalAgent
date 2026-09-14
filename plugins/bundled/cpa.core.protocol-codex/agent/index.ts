import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    PluginContext,
    ProtocolProviderContribution,
    ProtocolSessionContext,
} from '@cpa/plugin-api'
import { CodexProtocolSession } from './CodexProtocolSession.js'
import { createGeminiSearchTransport } from './geminiSearch.js'
import { CodexClient, type CodexClientOptions, type CodexClientStreamInput, type CodexClientStreamOptions } from './codexClient.js'
import {
    canonicalizeBaseUrl,
    CodexConnectionManager,
    buildWebSocketHeaders,
    resolveCodexWebSocketUrl,
    DEFAULT_CONNECTION_NAMESPACE,
    IDLE_TTL_MS,
    MAX_AGE_MS,
    CONNECT_TIMEOUT_MS,
    MAX_CONNECT_RETRIES,
    type CodexConnectionLease,
    type CodexConnectionMode,
} from './codexConnectionManager.js'
import { buildCodexRequest, type CodexRequestSpeed, type BuildCodexRequestInput } from './codexRequest.js'
import { convertConversationToCodexInput, codexCallId } from './codexMessages.js'
import { parseCodexEvents, CODEX_STREAM_CLOSED_BEFORE_COMPLETED } from './codexStream.js'
import { parseStreamingJson } from './streamingJson.js'
import {
    classifyCodexError,
    shouldRetryCodex,
    isCodexTransientError,
    isCodexContextOverflowError,
    readCodexStatus,
    readCodexCode,
    readCodexErrorMessage,
    CODEX_RETRY_DELAYS_MS,
} from './codexRetry.js'
import type { CodexResponseCreate, CodexToolDefinition, CodexInputItem, CodexFunctionTool } from './types.js'

export {
    canonicalizeBaseUrl,
    CodexClient,
    CodexConnectionManager,
    CodexProtocolSession,
    buildCodexRequest,
    convertConversationToCodexInput,
    codexCallId,
    parseCodexEvents,
    parseStreamingJson,
    classifyCodexError,
    shouldRetryCodex,
    isCodexTransientError,
    isCodexContextOverflowError,
    readCodexStatus,
    readCodexCode,
    readCodexErrorMessage,
    CODEX_RETRY_DELAYS_MS,
    buildWebSocketHeaders,
    resolveCodexWebSocketUrl,
    DEFAULT_CONNECTION_NAMESPACE,
    IDLE_TTL_MS,
    MAX_AGE_MS,
    CONNECT_TIMEOUT_MS,
    MAX_CONNECT_RETRIES,
    CODEX_STREAM_CLOSED_BEFORE_COMPLETED,
}

export type {
    CodexClientOptions,
    CodexClientStreamInput,
    CodexClientStreamOptions,
    CodexConnectionLease,
    CodexConnectionMode,
    CodexRequestSpeed,
    BuildCodexRequestInput,
    CodexResponseCreate,
    CodexToolDefinition,
    CodexInputItem,
    CodexFunctionTool,
}

export const protocolCodexAgentEntry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const geminiSearchTransport = createGeminiSearchTransport(context.capabilityClient)
        context.register<ProtocolProviderContribution>({
            kind: 'protocol',
            id: 'codex-responses-ws',
            value: {
                id: 'codex-responses-ws',
                name: 'CLIProxyAPI Codex Responses WebSocket',
                isDefault: true,
                createConnectionManager: (bridge: unknown) => {
                    return new CodexConnectionManager(bridge as any)
                },
                createSession: (options: ProtocolSessionContext) => {
                    return new CodexProtocolSession({ ...options, geminiSearchTransport })
                },
                createClient: (options: ProtocolSessionContext) => {
                    return new CodexProtocolSession({ ...options, geminiSearchTransport })
                },
            },
        })
    },
})

export const entry = protocolCodexAgentEntry
export default protocolCodexAgentEntry
