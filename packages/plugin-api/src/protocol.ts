/**
 * Neutral Protocol SPI interfaces and canonical conversation/event shapes.
 */

import type { CapabilityHandle, CapabilityId } from './capabilities.js'
import {
    DuplicatePluginSourceError,
    PluginActivationError,
    PluginCapabilityError,
    PluginConflictError,
    PluginDeactivationError,
    PluginDependencyError,
    PluginError,
    PluginManifestError,
    PluginValidationError,
} from './errors.js'

// --- Model Catalog Types ---

export interface ModelReasoningOption {
    id: string
    requestValue: string
    labelKey?: string
    fallbackLabel?: string
    description?: string
}

export type ModelInputModality = 'text' | 'image'

export interface ModelCatalogEntry {
    id: string
    label: string
    description?: string
    supportsFast: boolean
    reasoningLevels: readonly ModelReasoningOption[]
    input: readonly ModelInputModality[]
    contextWindow: number
    maxTokens: number
}

// --- Session and Conversation Entry Types ---

export type StopReason =
    | 'pending'
    | 'stop'
    | 'length'
    | 'toolUse'
    | 'error'
    | 'aborted'

export type EntryStatus = 'streaming' | 'done' | 'error' | 'aborted'

export interface Usage {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning?: number
    totalTokens: number
    cost: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        total: number
    }
}

export type ContentBlock =
    | { type: 'text'; text: string; signature?: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'thinking'; thinking: string; signature?: string }
    | {
          type: 'toolCall'
          id: string
          name: string
          arguments: Record<string, unknown>
      }

export type ToolResultContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }

export interface EntryBase {
    id: string
    sessionId: string
    createdAt: number
    version?: 1
    pausedMs?: number
}

export type UserPendingStatus = 'steer' | 'queue'

export interface UserEntry extends EntryBase {
    kind: 'user'
    content: ContentBlock[]
    pendingStatus?: UserPendingStatus
}

export interface AssistantEntry extends EntryBase {
    kind: 'assistant'
    api?: string
    provider?: string
    model?: string
    content: ContentBlock[]
    usage?: Usage
    stopReason: StopReason
    errorMessage?: string
    status: EntryStatus
    responseId?: string
    completedAt?: number
}

export interface ToolResultEntry extends EntryBase {
    kind: 'toolResult'
    toolCallId: string
    toolName: string
    content: ToolResultContentBlock[]
    isError: boolean
}

export interface CompactionEntry extends EntryBase {
    kind: 'compaction'
    summary: string
    firstKeptEntryId: string
    tokensBefore?: number
    usage?: Usage
    readFiles?: string[]
    modifiedFiles?: string[]
}

export type ConversationEntry =
    | UserEntry
    | AssistantEntry
    | ToolResultEntry
    | CompactionEntry

// --- Stream Event Types ---

export type AssistantToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>

export type AssistantStreamEvent =
    | { type: 'start'; partial: AssistantEntry }
    | { type: 'text-start'; contentIndex: number; partial: AssistantEntry }
    | {
          type: 'text-delta'
          contentIndex: number
          delta: string
          partial: AssistantEntry
      }
    | {
          type: 'text-end'
          contentIndex: number
          content: string
          partial: AssistantEntry
      }
    | { type: 'thinking-start'; contentIndex: number; partial: AssistantEntry }
    | {
          type: 'thinking-delta'
          contentIndex: number
          delta: string
          partial: AssistantEntry
      }
    | {
          type: 'thinking-end'
          contentIndex: number
          content: string
          partial: AssistantEntry
      }
    | { type: 'toolcall-start'; contentIndex: number; partial: AssistantEntry }
    | {
          type: 'toolcall-delta'
          contentIndex: number
          delta: string
          partial: AssistantEntry
      }
    | {
          type: 'toolcall-end'
          contentIndex: number
          toolCall: AssistantToolCallBlock
          partial: AssistantEntry
      }
    | {
          type: 'done'
          reason: Extract<StopReason, 'stop' | 'length' | 'toolUse'>
          message: AssistantEntry
      }
    | {
          type: 'error'
          reason: Extract<StopReason, 'aborted' | 'error'>
          error: AssistantEntry
      }

export type AgentStreamEvent = AssistantStreamEvent

// --- Neutral Protocol SPI ---

export interface ProtocolToolDefinition {
    name: string
    description: string
    parameters: Record<string, unknown>
}

export interface ProtocolStreamInput {
    model: ModelCatalogEntry
    systemPrompt: string
    entries: readonly ConversationEntry[]
    tools?: readonly ProtocolToolDefinition[]
    reasoningEffort?: string
    speed?: string
    seed: AssistantEntry
}

export interface ProtocolStreamOptions {
    connectionMode?: string
    promptCacheKey?: string
    maxOutputTokens?: number
    signal?: AbortSignal
}

export interface ProtocolSessionContext {
    capabilities?: ReadonlySet<CapabilityId>
    apiKey: string
    baseUrl: string
    sessionId: string
    connectionNamespace?: string
    bridge?: unknown
    [key: string]: unknown
}

export interface ProtocolSession {
    readonly id?: string
    stream(
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions
    ): AsyncIterable<AgentStreamEvent>
    cancel?(reason?: string): Promise<void> | void
    dispose?(): Promise<void> | void
}

export interface ProtocolProviderContribution {
    id: string
    name?: string
    displayName?: string
    isDefault?: boolean
    createSession?(
        context: ProtocolSessionContext
    ): Promise<ProtocolSession> | ProtocolSession
    createClient?(
        options: ProtocolSessionContext
    ): ProtocolSession | Promise<ProtocolSession>
    createConnectionManager?(
        bridge: unknown
    ): unknown
}

export type ProtocolClient = ProtocolSession
export type ProtocolProvider = ProtocolProviderContribution

export interface ProtocolMiddleware {
    id: string
    order?: number
    onRequest?(
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions
    ): Promise<ProtocolStreamInput> | ProtocolStreamInput
    onStreamEvent?(
        event: AgentStreamEvent,
        context: { sessionId: string; model: string }
    ): AgentStreamEvent | null | void
    onStreamComplete?(stats: { elapsedMs: number; error?: Error }): void
}

// --- Capability Invocation & Error Serialization ---

export interface CapabilityInvokeRequest {
    handle: CapabilityHandle
    method: string
    args: unknown[]
}

export interface CapabilityErrorDto {
    name: string
    message: string
    code?: string
    pluginId?: string
    stack?: string
    validationErrors?: readonly string[]
}

export type CapabilityInvokeResponse<T = unknown> =
    | { ok: true; value: T }
    | { ok: false; error: CapabilityErrorDto }

/**
 * Serializes an error into a structured CapabilityErrorDto for cross-process transport.
 */
export function serializeCapabilityError(err: unknown): CapabilityErrorDto {
    if (err instanceof PluginValidationError) {
        return {
            name: err.name,
            message: err.message,
            code: err.code,
            pluginId: err.pluginId,
            stack: err.stack,
            validationErrors: err.validationErrors,
        }
    }
    if (err instanceof PluginError) {
        return {
            name: err.name,
            message: err.message,
            code: err.code,
            pluginId: err.pluginId,
            stack: err.stack,
        }
    }
    if (err instanceof Error) {
        return {
            name: err.name || 'Error',
            message: err.message,
            stack: err.stack,
        }
    }
    return {
        name: 'Error',
        message: typeof err === 'string' ? err : String(err),
    }
}

/**
 * Deserializes a CapabilityErrorDto back into a typed Error or PluginError subclass.
 */
export function deserializeCapabilityError(dto: CapabilityErrorDto): Error {
    if (!dto || typeof dto !== 'object') {
        return new Error('Unknown capability error')
    }

    const { name, message, code, pluginId, stack, validationErrors } = dto

    let error: Error
    switch (name) {
        case 'PluginCapabilityError':
            error = new PluginCapabilityError(message, { pluginId })
            break
        case 'PluginValidationError':
            error = new PluginValidationError(message, validationErrors ?? [], {
                pluginId,
            })
            break
        case 'PluginManifestError':
            error = new PluginManifestError(message, { pluginId })
            break
        case 'DuplicatePluginSourceError':
            error = new DuplicatePluginSourceError(message, { pluginId })
            break
        case 'PluginActivationError':
            error = new PluginActivationError(message, { pluginId })
            break
        case 'PluginDeactivationError':
            error = new PluginDeactivationError(message, { pluginId })
            break
        case 'PluginDependencyError':
            error = new PluginDependencyError(message, { pluginId })
            break
        case 'PluginConflictError':
            error = new PluginConflictError(message, { pluginId })
            break
        case 'PluginError':
            error = new PluginError(message, { code, pluginId })
            break
        default: {
            error = new Error(message)
            error.name = name || 'Error'
            break
        }
    }

    if (stack) {
        error.stack = stack
    }
    return error
}

/**
 * Extract the primary tool call ID from a composite or formatted ID (`call_id|item_id`).
 */
export function normalizeToolCallId(id: string | null | undefined): string {
    if (!id) return ''
    const trimmed = id.trim()
    return trimmed.split('|', 1)[0] ?? trimmed
}

