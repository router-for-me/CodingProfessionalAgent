/**
 * Codex Responses event stream parser.
 * Maps wire events into AssistantStreamEvent updates and a final AssistantEntry.
 */

import type {
    AssistantEntry,
    AssistantStreamEvent,
    ContentBlock,
    StopReason,
    Usage,
} from '@cpa/plugin-api'
import { parseStreamingJson } from './streamingJson'

const CLOSED_BEFORE_COMPLETED = 'Codex stream closed before response.completed'

type TextBlock = Extract<ContentBlock, { type: 'text' }>
type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>
type ToolCallBlock = Extract<ContentBlock, { type: 'toolCall' }>

type OutputSlot =
    | { type: 'text'; block: TextBlock; contentIndex: number }
    | { type: 'thinking'; block: ThinkingBlock; contentIndex: number }
    | {
          type: 'toolCall'
          block: ToolCallBlock
          contentIndex: number
          /** Streaming scratch buffer — never persisted on content blocks. */
          partialJson: string
      }

interface WireUsage {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
}

interface WireResponse {
    id?: string
    status?: string
    usage?: WireUsage
    error?: { code?: string; message?: string }
    incomplete_details?: { reason?: string }
    /** Wire response.output items when present on terminal events. */
    output?: unknown[]
}

export interface ParseCodexTerminalMeta {
    type: 'completed' | 'incomplete' | 'failed'
    responseId?: string
    /** Deep-cloned wire items for previous_response_id continuation. */
    responseOutput: unknown[]
}

export interface ParseCodexEventsOptions {
    /** Optional terminal metadata collector; does not change the public return type. */
    onTerminal?: (meta: ParseCodexTerminalMeta) => void
}

function deepCloneJson<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value)
    }
    return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

function encodeTextSignatureV1(id: string, phase?: string): string {
    const payload: { v: 1; id: string; phase?: string } = { v: 1, id }
    if (phase === 'commentary' || phase === 'final_answer') {
        payload.phase = phase
    }
    return JSON.stringify(payload)
}

function emptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

function mapUsage(wire: WireUsage | undefined): Usage {
    const usage = emptyUsage()
    if (!wire) return usage
    const cachedTokens = wire.input_tokens_details?.cached_tokens || 0
    usage.input = (wire.input_tokens || 0) - cachedTokens
    usage.output = wire.output_tokens || 0
    usage.cacheRead = cachedTokens
    usage.cacheWrite = 0
    usage.reasoning = wire.output_tokens_details?.reasoning_tokens || 0
    usage.totalTokens = wire.total_tokens || 0
    return usage
}

function mapStopReason(status: string | undefined): StopReason {
    switch (status) {
        case 'completed':
            return 'stop'
        case 'incomplete':
            return 'length'
        case 'failed':
        case 'cancelled':
            return 'error'
        case 'in_progress':
        case 'queued':
            return 'stop'
        default:
            return 'stop'
    }
}

function clearPartialState(output: AssistantEntry, slots: Map<number, OutputSlot>): void {
    slots.clear()
    for (const block of output.content) {
        if (block && typeof block === 'object' && 'partialJson' in block) {
            delete (block as { partialJson?: unknown }).partialJson
        }
    }
}

function parseFinalToolArguments(raw: string): Record<string, unknown> {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw || '{}')
    } catch (cause) {
        const message =
            cause instanceof Error
                ? cause.message
                : 'Invalid tool call arguments: expected strict JSON object'
        throw new Error(`Invalid tool call arguments: ${message}`)
    }
    if (!isRecord(parsed)) {
        throw new Error('Invalid tool call arguments: expected strict JSON object')
    }
    return parsed
}

function markError(output: AssistantEntry, message: string): void {
    output.status = 'error'
    output.stopReason = 'error'
    output.errorMessage = message
}

function jsonIdentity(value: Record<string, unknown>): string {
    try {
        return JSON.stringify(value)
    } catch {
        return ''
    }
}

function appendAnnotation(output: AssistantEntry, value: Record<string, unknown>): void {
    const annotation = deepCloneJson(value)
    const identity = jsonIdentity(annotation)
    const existing = [...(output.annotations ?? [])]
    if (!existing.some((item) => jsonIdentity(item) === identity)) {
        if (existing.length >= 256) throw new Error('Response annotation limit exceeded')
        existing.push(annotation)
        output.annotations = existing
    }
}

const CITATION_TYPES = new Set([
    'citation',
    'url_citation',
    'web_search_result_location',
])

/** Collect citation records from OpenAI and Claude-compatible response shapes. */
function collectAnnotations(output: AssistantEntry, value: unknown, depth = 0): void {
    if (depth > 32) throw new Error('Response metadata nesting limit exceeded')
    if (Array.isArray(value)) {
        for (const item of value) collectAnnotations(output, item, depth + 1)
        return
    }
    if (!isRecord(value)) return

    if (Array.isArray(value.annotations)) {
        for (const annotation of value.annotations) {
            if (isRecord(annotation)) appendAnnotation(output, annotation)
        }
    }
    if (typeof value.type === 'string' && CITATION_TYPES.has(value.type)) {
        appendAnnotation(output, value)
    }
    for (const [key, nested] of Object.entries(value)) {
        if (key !== 'annotations' && key !== 'encrypted_content' && key !== 'encrypted_index') {
            collectAnnotations(output, nested, depth + 1)
        }
    }
}

function upsertNativeToolCall(output: AssistantEntry, item: Record<string, unknown>): void {
    if (item.type !== 'web_search_call') return
    const cloned = deepCloneJson(item)
    const existing = [...(output.nativeToolCalls ?? [])]
    const id = asString(cloned.id)
    const index = id
        ? existing.findIndex((candidate) => candidate.type === cloned.type && candidate.id === id)
        : existing.findIndex((candidate) => jsonIdentity(candidate) === jsonIdentity(cloned))
    if (index >= 0) {
        existing[index] = cloned
    } else {
        if (existing.length >= 64) throw new Error('Response native tool limit exceeded')
        existing.push(cloned)
    }
    output.nativeToolCalls = existing
}

function collectTerminalOutput(output: AssistantEntry, items: readonly unknown[]): void {
    for (const item of items) {
        if (!isRecord(item)) continue
        upsertNativeToolCall(output, item)
        collectAnnotations(output, item)
    }
}

/**
 * Parse Codex Responses websocket/SSE-shaped events into stream events.
 * Yields AssistantStreamEvent values and returns the finalized AssistantEntry.
 */
export async function* parseCodexEvents(
    events: AsyncIterable<unknown>,
    seed: AssistantEntry,
    options?: ParseCodexEventsOptions,
): AsyncGenerator<AssistantStreamEvent, AssistantEntry> {
    const output = seed
    output.status = 'streaming'
    if (output.stopReason === undefined) {
        output.stopReason = 'pending'
    }
    if (!Array.isArray(output.content)) {
        output.content = []
    }

    const outputSlots = new Map<number, OutputSlot>()
    const messageSlots = new Map<number, Extract<OutputSlot, { type: 'text' }>>()
    /** Exact copies of output_item.done raw items (fallback when response.output is absent). */
    const doneWireItems: unknown[] = []
    let sawTerminalResponseEvent = false
    let started = false

    const getSlot = <T extends OutputSlot['type']>(
        outputIndex: number,
        type: T,
    ): Extract<OutputSlot, { type: T }> | undefined => {
        const slot = outputSlots.get(outputIndex)
        return slot?.type === type ? (slot as Extract<OutputSlot, { type: T }>) : undefined
    }

    const createSlot = (outputIndex: number, item: Record<string, unknown>): OutputSlot | undefined => {
        const itemType = asString(item.type)
        if (itemType === 'reasoning') {
            const block: ThinkingBlock = { type: 'thinking', thinking: '' }
            output.content.push(block)
            const slot: OutputSlot = {
                type: 'thinking',
                block,
                contentIndex: output.content.length - 1,
            }
            outputSlots.set(outputIndex, slot)
            return slot
        }
        if (itemType === 'message') {
            const block: TextBlock = { type: 'text', text: '' }
            output.content.push(block)
            const slot: OutputSlot = {
                type: 'text',
                block,
                contentIndex: output.content.length - 1,
            }
            outputSlots.set(outputIndex, slot)
            messageSlots.set(outputIndex, slot)
            return slot
        }
        if (itemType === 'function_call') {
            const callId = asString(item.call_id) ?? ''
            const itemId = asString(item.id) ?? ''
            const name = asString(item.name) ?? ''
            const initialArgs = asString(item.arguments) ?? ''
            const block: ToolCallBlock = {
                type: 'toolCall',
                id: itemId ? `${callId}|${itemId}` : callId,
                name,
                arguments: {},
            }
            output.content.push(block)
            const slot: OutputSlot = {
                type: 'toolCall',
                block,
                contentIndex: output.content.length - 1,
                partialJson: initialArgs,
            }
            if (initialArgs) {
                block.arguments = parseStreamingJson(initialArgs)
            }
            outputSlots.set(outputIndex, slot)
            return slot
        }
        return undefined
    }

    const getOrCreateSlot = (
        outputIndex: number,
        item: Record<string, unknown>,
    ): OutputSlot | undefined => {
        return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item)
    }

    const finalizeResponse = (response: WireResponse | undefined, terminalType: string): void => {
        sawTerminalResponseEvent = true
        if (response?.id) {
            output.responseId = response.id
        }
        if (response?.usage) {
            output.usage = mapUsage(response.usage)
        }
        const status =
            terminalType === 'response.incomplete'
                ? 'incomplete'
                : terminalType === 'response.failed'
                  ? 'failed'
                  : response?.status
        output.stopReason = mapStopReason(status)
        if (
            output.content.some((b) => b.type === 'toolCall') &&
            output.stopReason === 'stop'
        ) {
            output.stopReason = 'toolUse'
        }
        output.status = 'done'
    }

    try {
        for await (const rawEvent of events) {
            if (!isRecord(rawEvent)) {
                continue
            }

            let event = rawEvent
            let type = asString(event.type)
            if (!type) continue

            // Normalize Codex aliases.
            if (type === 'response.done') {
                type = 'response.completed'
                event = { ...event, type }
            }

            if (!started) {
                started = true
                yield { type: 'start', partial: output }
            }

            // Some Responses implementations stream annotations separately from
            // message/output-item terminal records.
            if (type.includes('annotation')) {
                if (isRecord(event.annotation)) appendAnnotation(output, event.annotation)
                if (Array.isArray(event.annotations)) {
                    collectAnnotations(output, { annotations: event.annotations })
                }
            }

            if (type === 'response.created') {
                const response = isRecord(event.response) ? (event.response as WireResponse) : undefined
                if (response?.id) {
                    output.responseId = response.id
                }
                continue
            }

            if (type === 'response.output_item.added') {
                const item = isRecord(event.item) ? event.item : undefined
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                if (!item || outputIndex === undefined) continue
                const slot = createSlot(outputIndex, item)
                if (!slot) continue
                if (slot.type === 'thinking') {
                    yield {
                        type: 'thinking-start',
                        contentIndex: slot.contentIndex,
                        partial: output,
                    }
                } else if (slot.type === 'text') {
                    yield {
                        type: 'text-start',
                        contentIndex: slot.contentIndex,
                        partial: output,
                    }
                } else {
                    yield {
                        type: 'toolcall-start',
                        contentIndex: slot.contentIndex,
                        partial: output,
                    }
                }
                continue
            }

            if (type === 'response.reasoning_summary_text.delta') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                const delta = asString(event.delta)
                if (outputIndex === undefined || delta === undefined) continue
                const slot = getSlot(outputIndex, 'thinking')
                if (!slot) continue
                slot.block.thinking += delta
                yield {
                    type: 'thinking-delta',
                    contentIndex: slot.contentIndex,
                    delta,
                    partial: output,
                }
                continue
            }

            if (type === 'response.reasoning_summary_part.done') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                if (outputIndex === undefined) continue
                const slot = getSlot(outputIndex, 'thinking')
                if (!slot) continue
                slot.block.thinking += '\n\n'
                yield {
                    type: 'thinking-delta',
                    contentIndex: slot.contentIndex,
                    delta: '\n\n',
                    partial: output,
                }
                continue
            }

            if (type === 'response.reasoning_text.delta') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                const delta = asString(event.delta)
                if (outputIndex === undefined || delta === undefined) continue
                const slot = getSlot(outputIndex, 'thinking')
                if (!slot) continue
                slot.block.thinking += delta
                yield {
                    type: 'thinking-delta',
                    contentIndex: slot.contentIndex,
                    delta,
                    partial: output,
                }
                continue
            }

            if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                const delta = asString(event.delta)
                if (outputIndex === undefined || delta === undefined) continue
                const slot = getSlot(outputIndex, 'text')
                if (!slot) continue
                slot.block.text += delta
                yield {
                    type: 'text-delta',
                    contentIndex: slot.contentIndex,
                    delta,
                    partial: output,
                }
                continue
            }

            if (type === 'response.function_call_arguments.delta') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                const delta = asString(event.delta)
                if (outputIndex === undefined || delta === undefined) continue
                const slot = getSlot(outputIndex, 'toolCall')
                if (!slot) continue
                slot.partialJson += delta
                slot.block.arguments = parseStreamingJson(slot.partialJson)
                yield {
                    type: 'toolcall-delta',
                    contentIndex: slot.contentIndex,
                    delta,
                    partial: output,
                }
                continue
            }

            if (type === 'response.function_call_arguments.done') {
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                const args = asString(event.arguments)
                if (outputIndex === undefined || args === undefined) continue
                const slot = getSlot(outputIndex, 'toolCall')
                if (!slot) continue
                const previousPartialJson = slot.partialJson
                slot.partialJson = args
                slot.block.arguments = parseStreamingJson(slot.partialJson)
                if (args.startsWith(previousPartialJson)) {
                    const delta = args.slice(previousPartialJson.length)
                    if (delta.length > 0) {
                        yield {
                            type: 'toolcall-delta',
                            contentIndex: slot.contentIndex,
                            delta,
                            partial: output,
                        }
                    }
                }
                continue
            }

            if (type === 'response.output_item.done') {
                const item = isRecord(event.item) ? event.item : undefined
                const outputIndex =
                    typeof event.output_index === 'number' ? event.output_index : undefined
                if (!item) continue
                // Native items do not need an output slot, even when a backend omits its index.
                doneWireItems.push(deepCloneJson(item))
                collectTerminalOutput(output, [item])
                if (outputIndex === undefined) continue
                const itemType = asString(item.type)
                const slot = getOrCreateSlot(outputIndex, item)

                if (itemType === 'reasoning' && slot?.type === 'thinking') {
                    const summary = Array.isArray(item.summary) ? item.summary : []
                    const content = Array.isArray(item.content) ? item.content : []
                    const summaryText = summary
                        .map((part) => (isRecord(part) ? asString(part.text) : undefined))
                        .filter((text): text is string => typeof text === 'string')
                        .join('\n\n')
                    const contentText = content
                        .map((part) => (isRecord(part) ? asString(part.text) : undefined))
                        .filter((text): text is string => typeof text === 'string')
                        .join('\n\n')
                    slot.block.thinking = summaryText || contentText || slot.block.thinking
                    slot.block.signature = JSON.stringify(item)
                    yield {
                        type: 'thinking-end',
                        contentIndex: slot.contentIndex,
                        content: slot.block.thinking,
                        partial: output,
                    }
                    outputSlots.delete(outputIndex)
                    continue
                }

                if (itemType === 'message' && slot?.type === 'text') {
                    // Missing content must preserve delta-accumulated text; never overwrite with ''.
                    if (Array.isArray(item.content)) {
                        slot.block.text = item.content
                            .map((part) => {
                                if (!isRecord(part)) return ''
                                if (part.type === 'output_text') return asString(part.text) ?? ''
                                if (part.type === 'refusal') return asString(part.refusal) ?? ''
                                return ''
                            })
                            .join('')
                    }
                    const id = asString(item.id) ?? `msg_${slot.contentIndex}`
                    const phase = asString(item.phase)
                    slot.block.signature = encodeTextSignatureV1(id, phase)
                    yield {
                        type: 'text-end',
                        contentIndex: slot.contentIndex,
                        content: slot.block.text,
                        partial: output,
                    }
                    outputSlots.delete(outputIndex)
                    continue
                }

                if (itemType === 'function_call' && slot?.type === 'toolCall') {
                    // Empty final arguments string must fall back to accumulated partialJson.
                    // Only a non-empty final string overrides the streaming buffer.
                    const finalArgs = asString(item.arguments)
                    const rawArgs =
                        finalArgs !== undefined && finalArgs.length > 0
                            ? finalArgs
                            : slot.partialJson.length > 0
                              ? slot.partialJson
                              : '{}'
                    try {
                        slot.block.arguments = parseFinalToolArguments(rawArgs)
                    } catch (error) {
                        clearPartialState(output, outputSlots)
                        const message =
                            error instanceof Error
                                ? error.message
                                : 'Invalid tool call arguments: expected strict JSON object'
                        markError(output, message)
                        throw error instanceof Error ? error : new Error(message)
                    }
                    // Ensure call id is composite when item id is present.
                    const callId = asString(item.call_id)
                    const itemId = asString(item.id)
                    if (callId) {
                        slot.block.id = itemId ? `${callId}|${itemId}` : callId
                    }
                    if (asString(item.name)) {
                        slot.block.name = asString(item.name)!
                    }
                    slot.partialJson = ''
                    yield {
                        type: 'toolcall-end',
                        contentIndex: slot.contentIndex,
                        toolCall: {
                            type: 'toolCall',
                            id: slot.block.id,
                            name: slot.block.name,
                            arguments: slot.block.arguments,
                        },
                        partial: output,
                    }
                    outputSlots.delete(outputIndex)
                    continue
                }
                continue
            }

            if (type === 'response.completed' || type === 'response.incomplete') {
                const response = isRecord(event.response)
                    ? (event.response as WireResponse)
                    : undefined
                const terminalItems =
                    Array.isArray(response?.output) && response.output.length > 0
                        ? response.output
                        : doneWireItems
                collectTerminalOutput(output, terminalItems)
                // Some backends return text only in the terminal response. Reconcile
                // by wire output index rather than duplicating earlier text deltas.
                if (Array.isArray(response?.output)) {
                    response.output.forEach((item, index) => {
                        if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) return
                        const slot = messageSlots.get(index) ?? getOrCreateSlot(index, item)
                        if (slot?.type !== 'text') return
                        slot.block.text = item.content.map((part) => {
                            if (!isRecord(part)) return ''
                            if (part.type === 'output_text') return asString(part.text) ?? ''
                            if (part.type === 'refusal') return asString(part.refusal) ?? ''
                            return ''
                        }).join('')
                        slot.block.signature = encodeTextSignatureV1(asString(item.id) ?? `msg_${slot.contentIndex}`, asString(item.phase))
                    })
                }
                finalizeResponse(response, type)
                clearPartialState(output, outputSlots)
                const wireOutput = deepCloneJson(terminalItems)
                options?.onTerminal?.({
                    type: type === 'response.incomplete' ? 'incomplete' : 'completed',
                    responseId: response?.id ?? output.responseId,
                    responseOutput: wireOutput,
                })
                const reason =
                    output.stopReason === 'length' || output.stopReason === 'toolUse'
                        ? output.stopReason
                        : 'stop'
                yield {
                    type: 'done',
                    reason,
                    message: output,
                }
                return output
            }

            if (type === 'response.failed') {
                sawTerminalResponseEvent = true
                const response = isRecord(event.response)
                    ? (event.response as WireResponse)
                    : undefined
                if (response?.id) {
                    output.responseId = response.id
                }
                const failureItems =
                    Array.isArray(response?.output) && response.output.length > 0
                        ? response.output
                        : doneWireItems
                collectTerminalOutput(output, failureItems)
                if (response?.usage) output.usage = mapUsage(response.usage)
                const error = response?.error
                const details = response?.incomplete_details
                const msg = error
                    ? `${error.code || 'unknown'}: ${error.message || 'no message'}`
                    : details?.reason
                      ? `incomplete: ${details.reason}`
                      : 'Unknown error (no error details in response)'
                clearPartialState(output, outputSlots)
                markError(output, msg)
                options?.onTerminal?.({
                    type: 'failed',
                    responseId: response?.id ?? output.responseId,
                    responseOutput: deepCloneJson(failureItems),
                })
                throw new Error(msg)
            }

            if (type === 'error') {
                const nested = isRecord(event.error) ? event.error : undefined
                const code =
                    asString(event.code) ?? (nested ? asString(nested.code) : undefined)
                const message =
                    asString(event.message) ?? (nested ? asString(nested.message) : undefined)
                const msg = `Codex error: ${message || code || JSON.stringify(event)}`
                clearPartialState(output, outputSlots)
                markError(output, msg)
                throw new Error(msg)
            }
        }

        if (!sawTerminalResponseEvent) {
            clearPartialState(output, outputSlots)
            markError(output, CLOSED_BEFORE_COMPLETED)
            throw new Error(CLOSED_BEFORE_COMPLETED)
        }

        return output
    } catch (error) {
        clearPartialState(output, outputSlots)
        if (output.status === 'streaming') {
            markError(
                output,
                error instanceof Error ? error.message : String(error),
            )
        }
        throw error
    }
}

export const CODEX_STREAM_CLOSED_BEFORE_COMPLETED = CLOSED_BEFORE_COMPLETED
