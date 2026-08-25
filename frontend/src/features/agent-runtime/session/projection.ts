import type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    DisplayChatMessage,
    DisplayCompaction,
    DisplayMessage,
    DisplayMessagePart,
    DisplayToolStatus,
    ToolResultEntry,
    UserEntry,
} from './types'

/**
 * Project canonical conversation entries into UI-consumable display messages.
 * Tool results are attached to adjacent assistant tool cards and never emitted
 * as standalone bubbles. Compaction becomes a separator item only.
 */
export function projectConversation(
    entries: ConversationEntry[],
): DisplayMessage[] {
    const display: DisplayMessage[] = []
    let index = 0

    while (index < entries.length) {
        const entry = entries[index]

        if (entry.kind === 'user') {
            display.push(projectUser(entry))
            index += 1
            continue
        }

        if (entry.kind === 'assistant') {
            const toolResults: ToolResultEntry[] = []
            let cursor = index + 1
            while (
                cursor < entries.length &&
                entries[cursor].kind === 'toolResult'
            ) {
                toolResults.push(entries[cursor] as ToolResultEntry)
                cursor += 1
            }
            display.push(projectAssistant(entry, toolResults))
            index = cursor
            continue
        }

        if (entry.kind === 'compaction') {
            display.push(projectCompaction(entry))
            index += 1
            continue
        }

        // Orphan tool results are not shown as fallback bubbles.
        index += 1
    }

    return display
}

function projectUser(entry: UserEntry): DisplayChatMessage {
    const text = joinTextBlocks(entry.content)
    const parts = contentToDisplayParts(entry.content, new Map())
    const pausedMs =
        typeof entry.pausedMs === 'number' && Number.isFinite(entry.pausedMs) && entry.pausedMs > 0
            ? entry.pausedMs
            : undefined
    return {
        kind: 'message',
        id: entry.id,
        sessionId: entry.sessionId,
        role: 'user',
        content: text,
        parts: parts.length > 0 ? parts : [{ type: 'text', text }],
        createdAt: entry.createdAt,
        ...(entry.pendingStatus ? { pendingStatus: entry.pendingStatus } : {}),
        ...(pausedMs !== undefined ? { pausedMs } : {}),
    }
}

function projectAssistant(
    entry: AssistantEntry,
    toolResults: ToolResultEntry[],
): DisplayChatMessage {
    const byCallId = new Map<string, ToolResultEntry>()
    for (const result of toolResults) {
        // Strict normalized first-wins: only the first result per normalized
        // call_id is kept. Raw ids must not create alternate lookup keys that
        // would let a later result win over an earlier normalized match.
        const normalized = normalizeCallId(result.toolCallId)
        if (!byCallId.has(normalized)) {
            byCallId.set(normalized, result)
        }
    }

    const parts = contentToDisplayParts(entry.content, byCallId, entry.status)
    const text = joinTextBlocks(entry.content)
    const pausedMs =
        typeof entry.pausedMs === 'number' && Number.isFinite(entry.pausedMs) && entry.pausedMs > 0
            ? entry.pausedMs
            : undefined

    let effectiveCompletedAt =
        typeof entry.completedAt === 'number' && Number.isFinite(entry.completedAt)
            ? entry.completedAt
            : undefined

    for (const result of toolResults) {
        if (typeof result.createdAt === 'number' && Number.isFinite(result.createdAt)) {
            effectiveCompletedAt =
                effectiveCompletedAt === undefined
                    ? result.createdAt
                    : Math.max(effectiveCompletedAt, result.createdAt)
        }
    }

    return {
        kind: 'message',
        id: entry.id,
        sessionId: entry.sessionId,
        role: 'assistant',
        content: text,
        parts,
        status: entry.status,
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        createdAt: entry.createdAt,
        ...(effectiveCompletedAt !== undefined
            ? { completedAt: effectiveCompletedAt }
            : {}),
        ...(pausedMs !== undefined ? { pausedMs } : {}),
    }
}

function projectCompaction(entry: CompactionEntry): DisplayCompaction {
    return {
        kind: 'compaction',
        id: entry.id,
        sessionId: entry.sessionId,
        createdAt: entry.createdAt,
        firstKeptEntryId: entry.firstKeptEntryId || undefined,
    }
}

function contentToDisplayParts(
    content: ContentBlock[],
    toolResults: Map<string, ToolResultEntry>,
    assistantStatus?: AssistantEntry['status'],
): DisplayMessagePart[] {
    const parts: DisplayMessagePart[] = []

    for (const block of content) {
        if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
            continue
        }

        if (block.type === 'thinking') {
            parts.push({ type: 'thinking', thinking: block.thinking })
            continue
        }

        if (block.type === 'toolCall') {
            // Lookup only by normalized key so raw exact keys cannot bypass first-wins.
            const result = toolResults.get(normalizeCallId(block.id))
            const status = resolveToolStatus(result, assistantStatus)
            const part: DisplayMessagePart = {
                type: 'tool_call',
                id: block.id,
                name: block.name,
                // Defensive clone so UI mutation cannot touch store state.
                args: deepCloneJson(block.arguments ?? {}),
                status,
            }
            if (result) {
                const resultText = joinToolResultText(result)
                if (resultText !== undefined) part.result = resultText
                if (result.isError) part.isError = true
                const resultImages = extractToolResultImages(result)
                if (resultImages) part.resultImages = resultImages
            }
            parts.push(part)
            continue
        }

        // Images in assistant content are not yet first-class DisplayMessagePart.
        // They remain available on the canonical entry for later UI work.
    }

    return parts
}

function normalizeCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

function deepCloneJson<T>(value: T): T {
    return deepCloneValue(value) as T
}

function deepCloneValue(
    value: unknown,
    seen = new WeakMap<object, unknown>(),
): unknown {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value as object)) return seen.get(value as object)
    if (Array.isArray(value)) {
        const arr: unknown[] = []
        seen.set(value as object, arr)
        for (const item of value) arr.push(deepCloneValue(item, seen))
        return arr
    }
    const out: Record<string, unknown> = {}
    seen.set(value as object, out)
    for (const [key, nested] of Object.entries(
        value as Record<string, unknown>,
    )) {
        out[key] = deepCloneValue(nested, seen)
    }
    return out
}

function resolveToolStatus(
    result: ToolResultEntry | undefined,
    assistantStatus?: AssistantEntry['status'],
): DisplayToolStatus {
    if (result) {
        if (result.isError) return 'error'
        return 'done'
    }
    // Live status (awaiting_approval/running/rejected/aborted) comes from the
    // ephemeral overlay store. Projection only encodes what canonical entries know.
    if (assistantStatus === 'streaming') return 'running'
    if (assistantStatus === 'aborted') return 'aborted'
    if (assistantStatus === 'error') return 'error'
    // No result yet and assistant is stable → queued until tool-start overlay.
    return 'queued'
}

function extractToolResultImages(
    result: ToolResultEntry,
): { data: string; mimeType: string }[] | undefined {
    const images: { data: string; mimeType: string }[] = []
    for (const block of result.content) {
        if (block.type !== 'image') continue
        if (typeof block.data !== 'string' || typeof block.mimeType !== 'string') {
            continue
        }
        // Defensive copy so UI mutation cannot touch store image buffers.
        images.push({ data: block.data, mimeType: block.mimeType })
    }
    return images.length > 0 ? images : undefined
}

function joinTextBlocks(content: ContentBlock[]): string {
    const chunks: string[] = []
    for (const block of content) {
        if (block.type === 'text' && block.text) chunks.push(block.text)
    }
    return chunks.join('')
}

function joinToolResultText(result: ToolResultEntry): string | undefined {
    const chunks: string[] = []
    for (const block of result.content) {
        if (block.type === 'text') chunks.push(block.text)
    }
    if (chunks.length === 0) return undefined
    return chunks.join('')
}
