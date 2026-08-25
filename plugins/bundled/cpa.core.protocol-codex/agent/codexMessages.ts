/**
 * Convert canonical conversation entries into Codex Responses input items.
 */

import type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    ModelCatalogEntry,
    ToolResultContentBlock,
    ToolResultEntry,
    UserEntry,
} from '@cpa/plugin-api'
import type {
    CodexAssistantMessageItem,
    CodexFunctionCallItem,
    CodexFunctionCallOutputItem,
    CodexInputItem,
    CodexReasoningContentPart,
    CodexReasoningItem,
    CodexReasoningStatus,
    CodexReasoningSummaryPart,
    CodexUserContentPart,
    CodexUserMessageItem,
} from './types'

const NON_VISION_USER_IMAGE_PLACEHOLDER =
    '(image omitted: model does not support images)'
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
    '(tool image omitted: model does not support images)'
const EMPTY_TOOL_OUTPUT = '(no tool output)'
const EMPTY_TOOL_ERROR_OUTPUT = '(tool execution error)'
const MISSING_TOOL_RESULT_OUTPUT =
    'Error: tool call completed without a matching tool result'

const COMPACTION_SUMMARY_PREFIX =
    'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const COMPACTION_SUMMARY_SUFFIX = '\n</summary>'

/** Responses item ids are prefix + safe charset, max 64 chars. */
const RESPONSES_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const REASONING_STATUSES = new Set<CodexReasoningStatus>([
    'in_progress',
    'completed',
    'incomplete',
])

/**
 * Extract the Responses call_id from a composite tool id (`call_id|item_id`).
 *
 * Uses JS String#split(separator, limit): limit caps the number of returned
 * segments, so `id.split('|', 1)[0]` is the head before the first pipe.
 */
export function codexCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

/** Selected replayable tool call after normalized call_id first-wins dedupe. */
interface SelectedToolCall {
    entryIndex: number
    blockIndex: number
    order: number
    rawId: string
    normalized: string
    name: string
    arguments: Record<string, unknown>
    entryModel: string | undefined
}

/** Prescan plan: one selected call per normalized id and result assignments. */
interface ConversionPlan {
    /** Selected calls keyed by entryIndex:blockIndex. */
    selectedByBlockKey: ReadonlyMap<string, SelectedToolCall>
    /** Selected calls keyed by normalized call_id. */
    selectedByNormalized: ReadonlyMap<string, SelectedToolCall>
    /** Assigned tool-result entry index per normalized call_id. */
    assignedResultByNormalized: ReadonlyMap<string, number>
    /** Entry indexes that own an assigned tool result. */
    assignedResultEntryIndexes: ReadonlySet<number>
}

function blockKey(entryIndex: number, blockIndex: number): string {
    return `${entryIndex}:${blockIndex}`
}

function isValidResponsesId(id: string, prefix: string): boolean {
    return id.startsWith(prefix) && RESPONSES_ID_RE.test(id)
}

function isValidMessageId(id: string): boolean {
    return isValidResponsesId(id, 'msg_')
}

function isValidReasoningId(id: string): boolean {
    return isValidResponsesId(id, 'rs_')
}

function isValidFunctionCallItemId(id: string): boolean {
    return isValidResponsesId(id, 'fc_')
}

/**
 * Item id is the segment after the first `|`. Multi-pipe or non-fc shapes are
 * treated as unavailable so callers omit `id` while keeping `call_id`.
 */
function codexItemId(id: string): string | undefined {
    const separator = id.indexOf('|')
    if (separator < 0) return undefined
    const itemId = id.slice(separator + 1)
    if (!itemId || itemId.includes('|')) return undefined
    if (!isValidFunctionCallItemId(itemId)) return undefined
    return itemId
}

function supportsImageInput(model: ModelCatalogEntry): boolean {
    return model.input.includes('image')
}

function buildDataUrl(mimeType: string, data: string): string {
    // If callers already stored a full data URL, keep it intact.
    if (data.startsWith('data:')) {
        return data
    }
    const mime = mimeType.trim() || 'application/octet-stream'
    return `data:${mime};base64,${data}`
}

function isReplayableAssistant(entry: AssistantEntry): boolean {
    if (entry.status === 'streaming' || entry.status === 'error' || entry.status === 'aborted') {
        return false
    }
    if (
        entry.stopReason === 'pending' ||
        entry.stopReason === 'error' ||
        entry.stopReason === 'aborted'
    ) {
        return false
    }
    return entry.status === 'done'
}

function parseTextSignature(
    signature: string | undefined,
): { id: string; phase?: 'commentary' | 'final_answer' } | undefined {
    if (!signature) return undefined

    if (signature.startsWith('{')) {
        try {
            const parsed: unknown = JSON.parse(signature)
            if (
                typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                (parsed as { v?: unknown }).v === 1 &&
                typeof (parsed as { id?: unknown }).id === 'string'
            ) {
                const id = (parsed as { id: string }).id
                // Empty restored ids are illegal; keep non-empty string ids (prefix optional).
                if (id.length === 0) {
                    return undefined
                }
                const phase = (parsed as { phase?: unknown }).phase
                if (phase === 'commentary' || phase === 'final_answer') {
                    return { id, phase }
                }
                if (phase === undefined) {
                    return { id }
                }
                // Unknown phase: keep id only.
                return { id }
            }
        } catch {
            // JSON-looking but illegal: fall through to stable fallback.
        }
        return undefined
    }

    // Legacy plain signature: only accept valid msg_* item ids.
    if (isValidMessageId(signature)) {
        return { id: signature }
    }
    return undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReasoningSummary(value: unknown): CodexReasoningSummaryPart[] | undefined {
    if (!Array.isArray(value)) return undefined
    const summary: CodexReasoningSummaryPart[] = []
    for (const part of value) {
        if (!isPlainObject(part)) return undefined
        if (part.type !== 'summary_text' || typeof part.text !== 'string') {
            return undefined
        }
        summary.push({ type: 'summary_text', text: part.text })
    }
    return summary
}

function parseReasoningContent(value: unknown): CodexReasoningContentPart[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) return undefined
    const content: CodexReasoningContentPart[] = []
    for (const part of value) {
        if (!isPlainObject(part)) return undefined
        if (part.type !== 'reasoning_text' || typeof part.text !== 'string') {
            return undefined
        }
        content.push({ type: 'reasoning_text', text: part.text })
    }
    return content
}

/**
 * Strictly reconstruct a Responses reasoning item from a thinking signature.
 * Invalid or dangerous shapes are omitted without throwing.
 */
function tryParseReasoningSignature(signature: string): CodexReasoningItem | undefined {
    try {
        const parsed: unknown = JSON.parse(signature)
        if (!isPlainObject(parsed)) return undefined
        if (parsed.type !== 'reasoning') return undefined
        // Reject error envelopes and unknown dangerous shapes.
        if ('error' in parsed) return undefined

        if (typeof parsed.id !== 'string' || !isValidReasoningId(parsed.id)) {
            return undefined
        }

        const summary = parseReasoningSummary(parsed.summary)
        if (!summary) return undefined

        let encryptedContent: string | null | undefined
        if ('encrypted_content' in parsed) {
            const value = parsed.encrypted_content
            if (value !== null && typeof value !== 'string') {
                return undefined
            }
            encryptedContent = value
        }

        let status: CodexReasoningStatus | undefined
        if ('status' in parsed) {
            if (typeof parsed.status !== 'string' || !REASONING_STATUSES.has(parsed.status as CodexReasoningStatus)) {
                return undefined
            }
            status = parsed.status as CodexReasoningStatus
        }

        const content = parseReasoningContent(parsed.content)
        if ('content' in parsed && content === undefined) {
            return undefined
        }

        const item: CodexReasoningItem = {
            type: 'reasoning',
            id: parsed.id,
            summary,
        }
        if (encryptedContent !== undefined) {
            item.encrypted_content = encryptedContent
        }
        if (status !== undefined) {
            item.status = status
        }
        if (content !== undefined) {
            item.content = content
        }
        return item
    } catch {
        // Stable fallback: caller skips forged reasoning items.
    }
    return undefined
}

function convertUserContent(
    content: readonly ContentBlock[],
    model: ModelCatalogEntry,
): CodexUserContentPart[] {
    const parts: CodexUserContentPart[] = []
    let previousWasImagePlaceholder = false
    const allowImages = supportsImageInput(model)

    for (const block of content) {
        if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text })
            previousWasImagePlaceholder = false
            continue
        }
        if (block.type === 'image') {
            if (allowImages) {
                parts.push({
                    type: 'input_image',
                    detail: 'auto',
                    image_url: buildDataUrl(block.mimeType, block.data),
                })
                previousWasImagePlaceholder = false
            } else if (!previousWasImagePlaceholder) {
                parts.push({
                    type: 'input_text',
                    text: NON_VISION_USER_IMAGE_PLACEHOLDER,
                })
                previousWasImagePlaceholder = true
            }
        }
    }

    return parts
}

function convertUserEntry(entry: UserEntry, model: ModelCatalogEntry): CodexUserMessageItem | undefined {
    const content = convertUserContent(entry.content, model)
    if (content.length === 0) return undefined
    return { role: 'user', content }
}

function convertCompactionEntry(entry: CompactionEntry): CodexUserMessageItem {
    return {
        role: 'user',
        content: [
            {
                type: 'input_text',
                text: COMPACTION_SUMMARY_PREFIX + entry.summary + COMPACTION_SUMMARY_SUFFIX,
            },
        ],
    }
}

/**
 * Build selected-call records and result assignments.
 *
 * Rules:
 * - Replayable assistant tool calls only; first normalized call_id wins.
 * - Conflicting later calls are skipped (their raw ids recorded).
 * - Results must appear after the selected call entry.
 * - Prefer exact raw-id match to the selected call.
 * - Results whose raw id belongs to a skipped conflicting call are never
 *   reassigned to the first selected call.
 * - Legacy results whose raw id equals the normalized call_id may match.
 * - First valid assigned result wins; later duplicates are ignored.
 */
function buildConversionPlan(entries: readonly ConversationEntry[]): ConversionPlan {
    const selectedByNormalized = new Map<string, SelectedToolCall>()
    const selectedByBlockKey = new Map<string, SelectedToolCall>()
    const skippedConflictingRawIds = new Set<string>()
    let order = 0

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex]
        if (!entry || entry.kind !== 'assistant' || !isReplayableAssistant(entry)) {
            continue
        }

        for (let blockIndex = 0; blockIndex < entry.content.length; blockIndex += 1) {
            const block = entry.content[blockIndex]
            if (!block || block.type !== 'toolCall') {
                continue
            }

            const rawId = block.id
            const normalized = codexCallId(rawId)
            if (selectedByNormalized.has(normalized)) {
                // Deterministic first-wins: skip exact duplicates and conflicting composites.
                if (rawId !== selectedByNormalized.get(normalized)?.rawId) {
                    skippedConflictingRawIds.add(rawId)
                }
                continue
            }

            const selected: SelectedToolCall = {
                entryIndex,
                blockIndex,
                order,
                rawId,
                normalized,
                name: block.name,
                arguments: block.arguments ?? {},
                entryModel: entry.model,
            }
            order += 1
            selectedByNormalized.set(normalized, selected)
            selectedByBlockKey.set(blockKey(entryIndex, blockIndex), selected)
        }
    }

    const assignedResultByNormalized = new Map<string, number>()
    const assignedResultEntryIndexes = new Set<number>()

    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex]
        if (!entry || entry.kind !== 'toolResult') {
            continue
        }

        const rawId = entry.toolCallId
        const normalized = codexCallId(rawId)
        const selected = selectedByNormalized.get(normalized)
        if (!selected) {
            // Orphan result for a non-selected / non-replayable call.
            continue
        }
        if (assignedResultByNormalized.has(normalized)) {
            // Duplicate results: keep the first valid assignment only.
            continue
        }
        // Only results positioned after the selected call may pair.
        if (entryIndex <= selected.entryIndex) {
            continue
        }

        if (rawId === selected.rawId) {
            assignedResultByNormalized.set(normalized, entryIndex)
            assignedResultEntryIndexes.add(entryIndex)
            continue
        }

        // Never reassign a result that clearly belongs to a skipped conflicting raw id.
        if (skippedConflictingRawIds.has(rawId)) {
            continue
        }

        // Legacy results store only the normalized call_id.
        if (rawId === normalized) {
            assignedResultByNormalized.set(normalized, entryIndex)
            assignedResultEntryIndexes.add(entryIndex)
            continue
        }

        // Unknown composite for this normalized id: do not guess.
    }

    return {
        selectedByBlockKey,
        selectedByNormalized,
        assignedResultByNormalized,
        assignedResultEntryIndexes,
    }
}

function convertAssistantEntry(
    entry: AssistantEntry,
    entryIndex: number,
    model: ModelCatalogEntry,
    plan: ConversionPlan,
): CodexInputItem[] {
    // Replayable assistant items keep their original relative order.
    // Missing-result synthetics are collected separately and appended after
    // all of this assistant's output items so multiple function_calls stay contiguous.
    const output: CodexInputItem[] = []
    const missingSynthetics: CodexFunctionCallOutputItem[] = []
    let textBlockIndex = 0
    const sameModel = entry.model !== undefined && entry.model === model.id

    for (let blockIndex = 0; blockIndex < entry.content.length; blockIndex += 1) {
        const block = entry.content[blockIndex]
        if (!block) continue

        if (block.type === 'thinking') {
            if (!block.signature || !sameModel) {
                // Model-bound encrypted reasoning only; never fake thinking text as user content.
                continue
            }
            const reasoningItem = tryParseReasoningSignature(block.signature)
            if (reasoningItem) {
                output.push(reasoningItem)
            }
            continue
        }

        if (block.type === 'text') {
            const parsedSignature = parseTextSignature(block.signature)
            const fallbackId =
                textBlockIndex === 0
                    ? `msg_${entryIndex}`
                    : `msg_${entryIndex}_${textBlockIndex}`
            textBlockIndex += 1

            let msgId = parsedSignature?.id
            if (!msgId) {
                msgId = fallbackId
            } else if (msgId.length > 64) {
                // OpenAI Responses message ids are capped at 64 characters.
                msgId = `msg_${hashId(msgId)}`
            }

            const message: CodexAssistantMessageItem = {
                type: 'message',
                role: 'assistant',
                content: [
                    {
                        type: 'output_text',
                        text: block.text,
                        annotations: [],
                    },
                ],
                status: 'completed',
                id: msgId,
            }
            if (parsedSignature?.phase) {
                message.phase = parsedSignature.phase
            }
            output.push(message)
            continue
        }

        if (block.type === 'toolCall') {
            const selected = plan.selectedByBlockKey.get(blockKey(entryIndex, blockIndex))
            if (!selected) {
                // Skipped conflicting / duplicate normalized call_id.
                continue
            }

            const itemId = sameModel ? codexItemId(selected.rawId) : undefined
            const functionCall: CodexFunctionCallItem = {
                type: 'function_call',
                call_id: selected.normalized,
                name: selected.name,
                arguments: JSON.stringify(selected.arguments),
            }
            if (itemId !== undefined) {
                functionCall.id = itemId
            }
            output.push(functionCall)

            // Defer synthetic outputs until all assistant items are emitted.
            if (!plan.assignedResultByNormalized.has(selected.normalized)) {
                missingSynthetics.push({
                    type: 'function_call_output',
                    call_id: selected.normalized,
                    output: MISSING_TOOL_RESULT_OUTPUT,
                })
            }
        }
    }

    // Synthetic order matches the order of missing function_calls above.
    return [...output, ...missingSynthetics]
}

function convertToolResultEntry(
    entry: ToolResultEntry,
    model: ModelCatalogEntry,
    callId: string,
): CodexFunctionCallOutputItem {
    const textResult = entry.content
        .filter((block): block is Extract<ToolResultContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
    const imageBlocks = entry.content.filter(
        (block): block is Extract<ToolResultContentBlock, { type: 'image' }> => block.type === 'image',
    )
    const hasImages = imageBlocks.length > 0
    const hasText = textResult.length > 0

    if (hasImages && supportsImageInput(model)) {
        const contentParts: CodexUserContentPart[] = []
        if (hasText) {
            contentParts.push({ type: 'input_text', text: textResult })
        }
        for (const block of imageBlocks) {
            contentParts.push({
                type: 'input_image',
                detail: 'auto',
                image_url: buildDataUrl(block.mimeType, block.data),
            })
        }
        return {
            type: 'function_call_output',
            call_id: callId,
            output: contentParts,
        }
    }

    let output: string
    if (hasText && hasImages) {
        // Non-vision: keep text and append one explicit placeholder per image.
        const placeholders = imageBlocks.map(() => NON_VISION_TOOL_IMAGE_PLACEHOLDER)
        output = [textResult, ...placeholders].join('\n')
    } else if (hasText) {
        output = textResult
    } else if (hasImages) {
        output = imageBlocks.map(() => NON_VISION_TOOL_IMAGE_PLACEHOLDER).join('\n')
    } else if (entry.isError) {
        output = EMPTY_TOOL_ERROR_OUTPUT
    } else {
        output = EMPTY_TOOL_OUTPUT
    }

    return {
        type: 'function_call_output',
        call_id: callId,
        output,
    }
}

/** Stable short id for oversized message signatures (no crypto dependency). */
function hashId(value: string): string {
    let hash = 2166136261
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Convert canonical conversation history into Codex Responses `input` items.
 * System prompts must never appear as system-role input items.
 */
export function convertConversationToCodexInput(
    entries: readonly ConversationEntry[],
    model: ModelCatalogEntry,
): CodexInputItem[] {
    const input: CodexInputItem[] = []
    const plan = buildConversionPlan(entries)

    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (!entry) continue

        if (entry.kind === 'user') {
            const item = convertUserEntry(entry, model)
            if (item) input.push(item)
            continue
        }

        if (entry.kind === 'assistant') {
            if (!isReplayableAssistant(entry)) {
                continue
            }
            input.push(...convertAssistantEntry(entry, index, model, plan))
            continue
        }

        if (entry.kind === 'toolResult') {
            // Emit only pre-assigned results (after-call, first valid, exact/legacy match).
            if (!plan.assignedResultEntryIndexes.has(index)) {
                continue
            }
            const normalized = codexCallId(entry.toolCallId)
            const assignedIndex = plan.assignedResultByNormalized.get(normalized)
            if (assignedIndex !== index) {
                continue
            }
            input.push(convertToolResultEntry(entry, model, normalized))
            continue
        }

        if (entry.kind === 'compaction') {
            input.push(convertCompactionEntry(entry))
        }
    }

    return input
}
