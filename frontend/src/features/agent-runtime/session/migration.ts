import type {
    AssistantEntry,
    ContentBlock,
    ConversationEntry,
    EntryStatus,
    StopReason,
    ToolResultContentBlock,
    ToolResultEntry,
    Usage,
    UserEntry,
} from './types'

const LEGACY_SYSTEM_PREFIX = '[Legacy system context]\n'
const CANONICAL_KINDS = new Set([
    'user',
    'assistant',
    'toolResult',
    'compaction',
])
export const RESTART_STREAMING_ERROR = 'Interrupted by session restart'

export type MigrateMode = 'restart' | 'live'

export type MigrateOptions = {
    /**
     * `restart` (default): normalize leftover streaming state to aborted for
     * safe hydrate/persist recovery.
     * `live`: preserve streaming status for in-flight legacy API bridges.
     */
    mode?: MigrateMode
}

/**
 * Convert persisted session history into canonical ConversationEntry[].
 * Accepts legacy Message arrays, already-migrated entries, or unknown junk.
 * Never throws; invalid payloads become an empty list so startup cannot stall.
 */
export function migrateLegacyMessages(
    sessionId: string,
    value: unknown,
    options?: MigrateOptions,
): ConversationEntry[] {
    if (!Array.isArray(value)) return []
    const mode: MigrateMode = options?.mode === 'live' ? 'live' : 'restart'

    const entries: ConversationEntry[] = []
    const seenToolResultKeys = new Set<string>()
    for (let index = 0; index < value.length; index += 1) {
        const item = value[index]
        if (!isRecord(item)) continue

        if (isCanonicalEntry(item)) {
            const normalized = normalizeCanonicalEntry(item, sessionId, mode)
            if (!normalized) continue
            if (normalized.kind === 'toolResult') {
                const key = normalizedToolResultKey(
                    normalized.sessionId,
                    normalized.toolCallId,
                )
                if (seenToolResultKeys.has(key)) continue
                seenToolResultKeys.add(key)
            }
            entries.push(normalized)
            continue
        }

        const migrated = migrateLegacyMessage(item, sessionId, index, mode)
        for (const entry of migrated) {
            if (entry.kind === 'toolResult') {
                const key = normalizedToolResultKey(
                    entry.sessionId,
                    entry.toolCallId,
                )
                if (seenToolResultKeys.has(key)) continue
                seenToolResultKeys.add(key)
            }
            entries.push(entry)
        }
    }
    return entries
}

/** First segment of composite tool ids (`call_id|item_id`). */
export function normalizeToolCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

export function deterministicToolResultId(
    sessionId: string,
    toolCallId: string,
): string {
    return `tool-result:${sessionId}:${normalizeToolCallId(toolCallId)}`
}

function normalizedToolResultKey(
    sessionId: string,
    toolCallId: string,
): string {
    return `${sessionId}::${normalizeToolCallId(toolCallId)}`
}

function migrateLegacyMessage(
    item: Record<string, unknown>,
    sessionId: string,
    index: number,
    mode: MigrateMode,
): ConversationEntry[] {
    const role = typeof item.role === 'string' ? item.role : ''
    const resolvedSessionId =
        asNonEmptyString(item.sessionId) ?? sessionId
    const createdAt = asFiniteNumber(item.createdAt) ?? 0
    const id =
        asNonEmptyString(item.id) ??
        stableFallbackId('legacy', resolvedSessionId, index, item)

    if (role === 'user') {
        return [buildUserEntry({
            id,
            sessionId: resolvedSessionId,
            createdAt,
            text: extractLegacyText(item),
        })]
    }

    if (role === 'system') {
        const body = extractLegacyText(item)
        return [buildUserEntry({
            id,
            sessionId: resolvedSessionId,
            createdAt,
            text: `${LEGACY_SYSTEM_PREFIX}${body}`,
        })]
    }

    if (role === 'assistant') {
        return migrateAssistantMessage(
            item,
            {
                id,
                sessionId: resolvedSessionId,
                createdAt,
            },
            mode,
        )
    }

    if (role === 'tool') {
        const toolCallId =
            asNonEmptyString(item.toolCallId) ??
            asNonEmptyString(item.tool_call_id) ??
            asNonEmptyString(item.id)
        if (!toolCallId) return []
        const toolName =
            asNonEmptyString(item.toolName) ??
            asNonEmptyString(item.name) ??
            'tool'
        const text = extractLegacyText(item)
        const toolResult: ToolResultEntry = {
            id: deterministicToolResultId(resolvedSessionId, toolCallId),
            sessionId: resolvedSessionId,
            createdAt,
            kind: 'toolResult',
            version: 1,
            toolCallId,
            toolName,
            content: text ? [{ type: 'text', text }] : [],
            isError: item.isError === true || item.status === 'error',
        }
        return [toolResult]
    }

    return []
}

function migrateAssistantMessage(
    item: Record<string, unknown>,
    base: { id: string; sessionId: string; createdAt: number },
    mode: MigrateMode,
): ConversationEntry[] {
    const rawStatus = item.status
    let status = normalizeEntryStatus(rawStatus, mode)
    const incompleteTools =
        mode === 'restart' && hasIncompleteToolParts(item)
    // Incomplete tool parts force aborted recovery even when top-level
    // status is missing/done and stopReason still says pending.
    if (incompleteTools) {
        status = 'aborted'
    }

    const wasStreamingRestart =
        mode === 'restart' &&
        (rawStatus === 'streaming' ||
            rawStatus === 'running' ||
            incompleteTools)

    const { content, toolResults } = migrateAssistantParts(
        item,
        base,
        status,
    )

    const hasToolCalls = content.some((block) => block.type === 'toolCall')
    let stopReason = deriveStopReason(status, hasToolCalls, item, mode)
    if (wasStreamingRestart || incompleteTools) {
        stopReason = 'aborted'
    }

    const assistant: AssistantEntry = {
        id: base.id,
        sessionId: base.sessionId,
        createdAt: base.createdAt,
        kind: 'assistant',
        version: 1,
        content,
        status,
        stopReason,
    }
    const api = asNonEmptyString(item.api)
    const provider = asNonEmptyString(item.provider)
    const model = asNonEmptyString(item.model)
    let errorMessage = asNonEmptyString(item.errorMessage)
    if (wasStreamingRestart && !errorMessage) {
        errorMessage = RESTART_STREAMING_ERROR
    }
    const responseId = asNonEmptyString(item.responseId)
    if (api) assistant.api = api
    if (provider) assistant.provider = provider
    if (model) assistant.model = model
    if (errorMessage) assistant.errorMessage = errorMessage
    if (responseId) assistant.responseId = responseId
    const usage = parseUsage(item.usage)
    if (usage) assistant.usage = usage
    const completedAt = asFiniteNumber(item.completedAt)
    if (completedAt !== undefined) assistant.completedAt = completedAt

    return [assistant, ...toolResults]
}

function migrateAssistantParts(
    item: Record<string, unknown>,
    base: { id: string; sessionId: string; createdAt: number },
    assistantStatus: EntryStatus,
): { content: ContentBlock[]; toolResults: ToolResultEntry[] } {
    const content: ContentBlock[] = []
    const toolResults: ToolResultEntry[] = []
    const parts = Array.isArray(item.parts) ? item.parts : null
    let toolPartIndex = 0

    if (parts) {
        for (const part of parts) {
            if (!isRecord(part)) continue
            const type = part.type

            if (type === 'text') {
                const text = typeof part.text === 'string' ? part.text : ''
                if (text) content.push({ type: 'text', text })
                continue
            }

            if (type === 'thinking') {
                const thinking =
                    typeof part.thinking === 'string' ? part.thinking : ''
                if (thinking) content.push({ type: 'thinking', thinking })
                continue
            }

            if (type === 'tool_call' || type === 'toolCall') {
                const toolId =
                    asNonEmptyString(part.id) ??
                    stableFallbackId(
                        'tool',
                        base.sessionId,
                        toolPartIndex,
                        {
                            messageId: base.id,
                            name: part.name,
                            args: part.args ?? part.arguments,
                        },
                    )
                toolPartIndex += 1
                const toolName =
                    asNonEmptyString(part.name) ?? 'tool'
                const args = isRecord(part.args)
                    ? part.args
                    : isRecord(part.arguments)
                      ? part.arguments
                      : {}

                content.push({
                    type: 'toolCall',
                    id: toolId,
                    name: toolName,
                    arguments: args,
                })

                const toolResult = migrateInlineToolResult(
                    part,
                    toolId,
                    toolName,
                    base,
                    assistantStatus,
                )
                if (toolResult) toolResults.push(toolResult)
            }
        }
    }

    // Preserve top-level text when parts only carry tool calls / thinking.
    const hasTextBlock = content.some((block) => block.type === 'text')
    if (!hasTextBlock) {
        const fallbackText =
            typeof item.content === 'string' ? item.content : ''
        if (fallbackText) {
            content.unshift({ type: 'text', text: fallbackText })
        }
    }

    return { content, toolResults }
}

function hasIncompleteToolParts(item: Record<string, unknown>): boolean {
    if (!Array.isArray(item.parts)) return false
    for (const part of item.parts) {
        if (!isRecord(part)) continue
        if (part.type !== 'tool_call' && part.type !== 'toolCall') continue
        const rawStatus =
            typeof part.status === 'string' ? part.status : undefined
        if (rawStatus === 'running' || rawStatus === 'awaiting_approval') {
            return true
        }
    }
    return false
}

function migrateInlineToolResult(
    part: Record<string, unknown>,
    toolId: string,
    toolName: string,
    base: { id: string; sessionId: string; createdAt: number },
    assistantStatus: EntryStatus,
): ToolResultEntry | null {
    const rawStatus =
        typeof part.status === 'string' ? part.status : undefined
    const hasResult = typeof part.result === 'string'
    const isRejected = rawStatus === 'rejected'
    const isRunning =
        rawStatus === 'running' || rawStatus === 'awaiting_approval'

    // Incomplete in-flight tool calls do not persist a result entry.
    if (isRunning && !hasResult) return null

    if (!hasResult && !isRejected) return null

    const resultText = hasResult ? (part.result as string) : ''
    const content: ToolResultContentBlock[] = resultText
        ? [{ type: 'text', text: resultText }]
        : []

    const isError =
        isRejected ||
        part.isError === true ||
        rawStatus === 'error' ||
        assistantStatus === 'error'

    return {
        id: deterministicToolResultId(base.sessionId, toolId),
        sessionId: base.sessionId,
        createdAt: base.createdAt,
        kind: 'toolResult',
        version: 1,
        toolCallId: toolId,
        toolName,
        content,
        isError,
    }
}

function buildUserEntry(input: {
    id: string
    sessionId: string
    createdAt: number
    text: string
}): UserEntry {
    return {
        id: input.id,
        sessionId: input.sessionId,
        createdAt: input.createdAt,
        kind: 'user',
        version: 1,
        content: input.text
            ? [{ type: 'text', text: input.text }]
            : [],
    }
}

function normalizeEntryStatus(
    value: unknown,
    mode: MigrateMode,
): EntryStatus {
    if (mode === 'live') {
        if (value === 'streaming' || value === 'running') return 'streaming'
        if (value === 'error') return 'error'
        if (value === 'aborted') return 'aborted'
        if (value === 'done') return 'done'
        if (value === undefined || value === null) return 'done'
        return 'streaming'
    }
    if (value === 'streaming' || value === 'running') return 'aborted'
    if (value === 'error') return 'error'
    if (value === 'aborted') return 'aborted'
    if (value === 'done') return 'done'
    // Unknown or missing terminal state defaults to done for completed history.
    if (value === undefined || value === null) return 'done'
    return 'aborted'
}

function deriveStopReason(
    status: EntryStatus,
    hasToolCalls: boolean,
    item: Record<string, unknown>,
    mode: MigrateMode = 'restart',
): StopReason {
    // Restart recovery always forces aborted stopReason for aborted status.
    if (mode === 'restart' && status === 'aborted') return 'aborted'

    if (typeof item.stopReason === 'string') {
        const candidate = item.stopReason as StopReason
        if (
            candidate === 'pending' ||
            candidate === 'stop' ||
            candidate === 'length' ||
            candidate === 'toolUse' ||
            candidate === 'error' ||
            candidate === 'aborted'
        ) {
            // Live streaming may legitimately keep pending; restart never does.
            if (mode === 'restart' && candidate === 'pending' && status !== 'streaming') {
                if (status === 'aborted') return 'aborted'
                if (status === 'error') return 'error'
            }
            return candidate
        }
    }

    if (status === 'aborted') return 'aborted'
    if (status === 'error') return 'error'
    if (status === 'streaming') return 'pending'
    if (hasToolCalls) return 'toolUse'
    return 'stop'
}

function extractLegacyText(item: Record<string, unknown>): string {
    if (typeof item.content === 'string' && item.content) {
        return item.content
    }
    if (Array.isArray(item.parts)) {
        for (const part of item.parts) {
            if (
                isRecord(part) &&
                part.type === 'text' &&
                typeof part.text === 'string' &&
                part.text
            ) {
                return part.text
            }
        }
    }
    return typeof item.content === 'string' ? item.content : ''
}

function isCanonicalEntry(item: Record<string, unknown>): boolean {
    if (item.version === 1) return true
    return typeof item.kind === 'string' && CANONICAL_KINDS.has(item.kind)
}

function normalizeCanonicalEntry(
    item: Record<string, unknown>,
    sessionId: string,
    mode: MigrateMode,
): ConversationEntry | null {
    const kind = item.kind
    const id = asNonEmptyString(item.id)
    if (!id || typeof kind !== 'string' || !CANONICAL_KINDS.has(kind)) {
        return null
    }

    const createdAt = asFiniteNumber(item.createdAt) ?? 0
    const resolvedSessionId =
        asNonEmptyString(item.sessionId) ?? sessionId
    const version = 1 as const

    if (kind === 'user') {
        return {
            id,
            sessionId: resolvedSessionId,
            createdAt,
            kind: 'user',
            version,
            // Deep-clone so caller mutation of input cannot touch store data.
            content: deepCloneJson(normalizeContentBlocks(item.content)),
        }
    }

    if (kind === 'assistant') {
        const rawStatus = item.status
        const status = normalizeCanonicalStatus(rawStatus, mode)
        const content = deepCloneJson(normalizeContentBlocks(item.content))
        const wasStreamingRestart =
            mode === 'restart' && rawStatus === 'streaming'
        let stopReason = deriveStopReason(
            status,
            content.some((block) => block.type === 'toolCall'),
            item,
            mode,
        )
        if (wasStreamingRestart) stopReason = 'aborted'

        const assistant: AssistantEntry = {
            id,
            sessionId: resolvedSessionId,
            createdAt,
            kind: 'assistant',
            version,
            content,
            status,
            stopReason,
        }
        const api = asNonEmptyString(item.api)
        const provider = asNonEmptyString(item.provider)
        const model = asNonEmptyString(item.model)
        let errorMessage = asNonEmptyString(item.errorMessage)
        if (wasStreamingRestart && !errorMessage) {
            errorMessage = RESTART_STREAMING_ERROR
        }
        const responseId = asNonEmptyString(item.responseId)
        if (api) assistant.api = api
        if (provider) assistant.provider = provider
        if (model) assistant.model = model
        if (errorMessage) assistant.errorMessage = errorMessage
        if (responseId) assistant.responseId = responseId
        const usage = parseUsage(item.usage)
        if (usage) assistant.usage = usage
        const completedAt = asFiniteNumber(item.completedAt)
        if (completedAt !== undefined) assistant.completedAt = completedAt
        return assistant
    }

    if (kind === 'toolResult') {
        const toolCallId = asNonEmptyString(item.toolCallId)
        if (!toolCallId) return null
        return {
            // Normalize id to deterministic form; keep content and raw toolCallId.
            id: deterministicToolResultId(resolvedSessionId, toolCallId),
            sessionId: resolvedSessionId,
            createdAt,
            kind: 'toolResult',
            version,
            toolCallId,
            toolName: asNonEmptyString(item.toolName) ?? 'tool',
            content: deepCloneJson(normalizeToolResultContent(item.content)),
            isError: item.isError === true,
        }
    }

    if (kind === 'compaction') {
        const summary = typeof item.summary === 'string' ? item.summary : ''
        const firstKeptEntryId =
            asNonEmptyString(item.firstKeptEntryId) ?? ''
        const tokensBefore = asFiniteNumber(item.tokensBefore)
        const readFiles = asStringArray(item.readFiles)
        const modifiedFiles = asStringArray(item.modifiedFiles)
        const usage = parseUsage(item.usage)
        return {
            id,
            sessionId: resolvedSessionId,
            createdAt,
            kind: 'compaction',
            version,
            summary,
            firstKeptEntryId,
            ...(tokensBefore !== undefined ? { tokensBefore } : {}),
            ...(readFiles ? { readFiles } : {}),
            ...(modifiedFiles ? { modifiedFiles } : {}),
            ...(usage ? { usage } : {}),
        }
    }

    return null
}

function normalizeCanonicalStatus(
    value: unknown,
    mode: MigrateMode,
): EntryStatus {
    if (
        value === 'streaming' ||
        value === 'done' ||
        value === 'error' ||
        value === 'aborted'
    ) {
        // Canonical streaming left over from a crash is treated as aborted
        // on restart hydrate; live mode preserves in-flight streams.
        if (value === 'streaming') {
            return mode === 'live' ? 'streaming' : 'aborted'
        }
        return value
    }
    return 'done'
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

function normalizeContentBlocks(value: unknown): ContentBlock[] {
    if (!Array.isArray(value)) return []
    const blocks: ContentBlock[] = []
    for (const item of value) {
        if (!isRecord(item) || typeof item.type !== 'string') continue
        if (item.type === 'text' && typeof item.text === 'string') {
            blocks.push({
                type: 'text',
                text: item.text,
                signature:
                    typeof item.signature === 'string'
                        ? item.signature
                        : undefined,
            })
            continue
        }
        if (
            item.type === 'image' &&
            typeof item.data === 'string' &&
            typeof item.mimeType === 'string'
        ) {
            blocks.push({
                type: 'image',
                data: item.data,
                mimeType: item.mimeType,
            })
            continue
        }
        if (item.type === 'thinking' && typeof item.thinking === 'string') {
            blocks.push({
                type: 'thinking',
                thinking: item.thinking,
                signature:
                    typeof item.signature === 'string'
                        ? item.signature
                        : undefined,
            })
            continue
        }
        if (
            (item.type === 'toolCall' || item.type === 'tool_call') &&
            typeof item.id === 'string' &&
            typeof item.name === 'string'
        ) {
            const args = isRecord(item.arguments)
                ? item.arguments
                : isRecord(item.args)
                  ? item.args
                  : {}
            blocks.push({
                type: 'toolCall',
                id: item.id,
                name: item.name,
                arguments: args,
            })
        }
    }
    return blocks
}

function normalizeToolResultContent(
    value: unknown,
): ToolResultContentBlock[] {
    if (!Array.isArray(value)) return []
    const blocks: ToolResultContentBlock[] = []
    for (const item of value) {
        if (!isRecord(item) || typeof item.type !== 'string') continue
        if (item.type === 'text' && typeof item.text === 'string') {
            blocks.push({ type: 'text', text: item.text })
            continue
        }
        if (
            item.type === 'image' &&
            typeof item.data === 'string' &&
            typeof item.mimeType === 'string'
        ) {
            blocks.push({
                type: 'image',
                data: item.data,
                mimeType: item.mimeType,
            })
        }
    }
    return blocks
}

function parseUsage(value: unknown): Usage | undefined {
    if (!isRecord(value)) return undefined
    const input = asFiniteNumber(value.input)
    const output = asFiniteNumber(value.output)
    const cacheRead = asFiniteNumber(value.cacheRead)
    const cacheWrite = asFiniteNumber(value.cacheWrite)
    const totalTokens = asFiniteNumber(value.totalTokens)
    if (
        input === undefined ||
        output === undefined ||
        cacheRead === undefined ||
        cacheWrite === undefined ||
        totalTokens === undefined ||
        !isRecord(value.cost)
    ) {
        return undefined
    }
    const costInput = asFiniteNumber(value.cost.input)
    const costOutput = asFiniteNumber(value.cost.output)
    const costCacheRead = asFiniteNumber(value.cost.cacheRead)
    const costCacheWrite = asFiniteNumber(value.cost.cacheWrite)
    const costTotal = asFiniteNumber(value.cost.total)
    if (
        costInput === undefined ||
        costOutput === undefined ||
        costCacheRead === undefined ||
        costCacheWrite === undefined ||
        costTotal === undefined
    ) {
        return undefined
    }
    const usage: Usage = {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost: {
            input: costInput,
            output: costOutput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            total: costTotal,
        },
    }
    const reasoning = asFiniteNumber(value.reasoning)
    if (reasoning !== undefined) usage.reasoning = reasoning
    return usage
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonEmptyString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value
    return undefined
}

function asFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return undefined
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const result = value.filter((item): item is string => typeof item === 'string')
    return result.length > 0 ? result : undefined
}

/**
 * Deterministic short id for legacy payloads missing ids.
 * Same session/content/position must always yield the same id across runs.
 */
function stableFallbackId(
    prefix: string,
    sessionId: string,
    index: number,
    material: unknown,
): string {
    const seed = `${sessionId}|${index}|${stableSerialize(material)}`
    return `${prefix}-${shortHash(seed)}`
}

/** Fixed markers keep hash seeds deterministic when structure cannot be fully walked. */
const STABLE_SERIALIZE_CIRCULAR = '"[Circular]"'
const STABLE_SERIALIZE_MAX_DEPTH = '"[MaxDepth]"'
/** Hard cap so migration never blows the stack on hostile or pathological payloads. */
const STABLE_SERIALIZE_DEPTH_LIMIT = 32

function stableSerialize(
    value: unknown,
    depth = 0,
    ancestors: Set<object> = new Set(),
): string {
    if (value === null || value === undefined) return String(value)
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value)
    }
    if (typeof value !== 'object') {
        return String(value)
    }

    // Depth bound before cycle check so pathological nests still terminate.
    if (depth >= STABLE_SERIALIZE_DEPTH_LIMIT) {
        return STABLE_SERIALIZE_MAX_DEPTH
    }
    if (ancestors.has(value)) {
        return STABLE_SERIALIZE_CIRCULAR
    }

    ancestors.add(value)
    try {
        if (Array.isArray(value)) {
            return `[${value
                .map((item) => stableSerialize(item, depth + 1, ancestors))
                .join(',')}]`
        }
        const record = value as Record<string, unknown>
        // Sorted keys preserve deterministic ordering for object shapes.
        const keys = Object.keys(record).sort()
        return `{${keys
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stableSerialize(record[key], depth + 1, ancestors)}`,
            )
            .join(',')}}`
    } finally {
        ancestors.delete(value)
    }
}

function shortHash(input: string): string {
    // FNV-1a 32-bit, hex encoded — stable across independent migration calls.
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
