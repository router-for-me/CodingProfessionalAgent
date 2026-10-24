/**
 * Context compaction: cut points, isolated CPA summarization, and rebuild.
 * Pure planning helpers plus an isolated summary call via CPAClient.stream.
 */

import type { ModelCatalogEntry } from '@/features/models/types'
import type { AssistantStreamEvent } from '../agent/types'

import type {
    ProtocolClient,
    ProtocolToolDefinition,
} from '@cpa/plugin-api'
import type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    ToolResultEntry,
    Usage,
    UserEntry,
} from '../session/types'
import {
    DEFAULT_COMPACTION_SETTINGS,
    estimateContextTokens,
    estimateTokens,
    normalizeCompactionSettings,
    safeJsonStringify,
    type CompactionSettings,
} from './tokenEstimate'

/** Fixed system prompt for summarization (exact brief text). */
export const SUMMARIZATION_SYSTEM_PROMPT =
    'You are a context summarization assistant. Do not continue the conversation. Only output the requested structured summary.'

export { DEFAULT_COMPACTION_SETTINGS }

/** Tool result serialization budget measured in Unicode code points. */
export const TOOL_RESULT_MAX_CODE_POINTS = 2000
const IMAGE_PLACEHOLDER = '[image]'

/** Required headings the model summary must contain (exact line, order, once each). */
export const REQUIRED_SUMMARY_HEADINGS = [
    '## Goal',
    '## Constraints & Preferences',
    '## Progress',
    '### Done',
    '### In Progress',
    '### Blocked',
    '## Key Decisions',
    '## Next Steps',
    '## Critical Context',
] as const

/** Required headings for turn-prefix summaries. */
export const REQUIRED_TURN_PREFIX_HEADINGS = [
    '## Original Request',
    '## Early Progress',
    '## Context for Suffix',
] as const

/** Deterministic structured checkpoint when a split turn has no prior history. */
export const NO_PRIOR_HISTORY_SUMMARY = [
    '## Goal',
    'No prior history.',
    '## Constraints & Preferences',
    '- (none)',
    '## Progress',
    '### Done',
    '- (none)',
    '### In Progress',
    '- (none)',
    '### Blocked',
    '- (none)',
    '## Key Decisions',
    '- (none)',
    '## Next Steps',
    '1. Continue from the turn-prefix context below.',
    '## Critical Context',
    '- (none)',
].join('\n')

/** Default post-stream transient retry delays (3 retries): 2s, 4s, 8s. */
export const SUMMARY_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const

/**
 * Summarization is extraction work, so do not inherit expensive reasoning.
 * Prefer low, minimal, or medium when available. If the catalog exposes only
 * expensive levels, omit reasoning and let the provider use its default.
 * Main conversation requests stay unchanged.
 */
export function resolveSummaryReasoningEffort(
    model: ModelCatalogEntry,
    requested: string | undefined,
): string | undefined {
    const normalized = requested?.trim().toLowerCase()
    if (!normalized || normalized === 'off' || normalized === 'none') {
        return undefined
    }

    const byId = (id: string) =>
        model.reasoningLevels.find(
            (option) => option.id.trim().toLowerCase() === id,
        )
    const requestedOption = model.reasoningLevels.find(
        (option) =>
            option.id.trim().toLowerCase() === normalized ||
            option.requestValue.trim().toLowerCase() === normalized,
    )

    const requestedId = requestedOption?.id.trim().toLowerCase() ?? normalized
    const expensiveLevels = new Set(['high', 'xhigh', 'max', 'ultra'])
    if (!expensiveLevels.has(requestedId)) {
        return requestedOption?.requestValue ?? requested
    }

    const preferred = byId('low') ?? byId('minimal') ?? byId('medium')
    return preferred?.requestValue
}

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

export interface FileOps {
    read: Set<string>
    written: Set<string>
    edited: Set<string>
}

export interface CutPointResult {
    firstKeptEntryIndex: number
    turnStartIndex: number
    isSplitTurn: boolean
}

export interface CompactionPreparation {
    firstKeptEntryId: string
    firstKeptEntryIndex: number
    tokensBefore: number
    previousSummary?: string
    previousReadFiles: string[]
    previousModifiedFiles: string[]
    isSplitTurn: boolean
    turnStartIndex: number
    /** Entries discarded into the history summary [boundaryStart, historyEnd). */
    historyEntries: ConversationEntry[]
    /** Entries for turn-prefix summary when splitting [turnStart, firstKept). */
    turnPrefixEntries: ConversationEntry[]
    fileOps: FileOps
    settings: CompactionSettings
}

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>

export interface CachedCompactionContext {
    /** Exact system prompt sent in the session's last cached provider request. */
    systemPrompt: string
    /** Optional developer prompt sent in the session's last cached provider request. */
    developerPrompt?: string
    /** Tool definitions sent in the session's last cached provider request. */
    tools?: readonly ProtocolToolDefinition[]
    /** Native tools sent in the session's last cached provider request. */
    nativeTools?: readonly { type: 'web_search' }[]
    /** Model ID used in the session's last cached provider request. */
    modelId: string
    /** Pinned base reasoning effort of the session's last cached provider request. */
    baseReasoningEffort?: string
    /** Conversation entries sent in the session's last cached provider request. */
    requestEntries?: readonly ConversationEntry[]
    /** Timestamp (ms) when the prompt cache was last written or refreshed. */
    lastCachedAt?: number
    /** Timestamp (ms) when the prompt cache expires. */
    cacheExpiresAt?: number
}

export interface KeptStartInfo {
    /** Opening text preview of the first kept message in context. */
    text: string
    /** 1-based occurrence index from the end among kept messages sharing the same preview. */
    fromEnd: number
    /** Total number of kept entries from the first kept message onward. */
    count: number
}

export interface CompactConversationOptions {
    /** Protocol client used only for isolated summary streams. */
    client: ProtocolClient
    model: ModelCatalogEntry
    sessionId: string
    reasoningEffort?: string
    /** Lower expensive reasoning levels for this summarization request. */
    fastContextCompaction?: boolean
    /** Speed tier for summarization request ('fast' sends priority service tier). */
    speed?: string
    signal?: AbortSignal
    /** Manual /compact focus instructions. */
    customInstructions?: string
    settings?: Partial<CompactionSettings> | null
    /**
     * When true, compact even if shouldCompact would be false.
     * Overflow retry / manual compact use this path; Task 15 owns only-once retry.
     */
    force?: boolean
    /**
     * Optional captured session request context enabling cache-hit compaction.
     * When provided and all preconditions hold, compaction reuses the session's
     * prompt cache instead of flattening history into a cold request.
     */
    cachedContext?: CachedCompactionContext | null
    /** Compaction trigger reason ('auto' | 'manual' | 'overflow'). Overflow always uses isolated path. */
    trigger?: 'auto' | 'manual' | 'overflow'
    now?: () => number
    generateId?: () => string
    /** Injectable sleep for summary-level transient retries (Abort-interruptible). */
    sleep?: SleepFn
    /** Override post-stream transient retry delays (defaults to 2s/4s/8s). */
    summaryRetryDelaysMs?: readonly number[]
}

export interface CompactConversationResult {
    entry: CompactionEntry
    /** Defensive deep copy of input entries with the new compaction entry appended. */
    entries: ConversationEntry[]
}

// ---------------------------------------------------------------------------
// Deep clone (cycles + BigInt)
// ---------------------------------------------------------------------------

/**
 * Defensive deep clone supporting cycles and BigInt.
 * Caller mutations must not affect source or sibling results.
 */
export function deepCloneValue<T>(value: T): T {
    if (typeof globalThis.structuredClone === 'function') {
        try {
            return globalThis.structuredClone(value)
        } catch {
            // Fall through for non-cloneable values.
        }
    }
    return deepCloneFallback(value, new WeakMap()) as T
}

function deepCloneFallback(value: unknown, seen: WeakMap<object, unknown>): unknown {
    if (value === null || typeof value !== 'object') {
        if (typeof value === 'bigint') {
            return value
        }
        return value
    }
    if (seen.has(value)) {
        return seen.get(value)
    }
    if (Array.isArray(value)) {
        const copy: unknown[] = []
        seen.set(value, copy)
        for (const item of value) {
            copy.push(deepCloneFallback(item, seen))
        }
        return copy
    }
    if (value instanceof Date) {
        return new Date(value.getTime())
    }
    const proto = Object.getPrototypeOf(value)
    const copy: Record<string | symbol, unknown> = Object.create(proto)
    seen.set(value, copy)
    for (const key of Reflect.ownKeys(value)) {
        const desc = Object.getOwnPropertyDescriptor(value, key)
        if (!desc) continue
        if ('value' in desc) {
            Object.defineProperty(copy, key, {
                ...desc,
                value: deepCloneFallback(desc.value, seen),
            })
        } else {
            Object.defineProperty(copy, key, desc)
        }
    }
    return copy
}

function cloneEntries(entries: readonly ConversationEntry[]): ConversationEntry[] {
    return entries.map((entry) => deepCloneValue(entry))
}

// ---------------------------------------------------------------------------
// Entry classification
// ---------------------------------------------------------------------------

/**
 * Extract Responses call_id from composite tool id (`call_id|item_id`).
 */
export function normalizeToolCallId(id: string): string {
    return id.split('|', 1)[0] ?? id
}

function isReplayableAssistant(entry: AssistantEntry): boolean {
    if (entry.status !== 'done') return false
    if (
        entry.stopReason === 'error' ||
        entry.stopReason === 'aborted' ||
        entry.stopReason === 'pending'
    ) {
        return false
    }
    // Assistants carrying errorMessage are not safe to cut/replay.
    if (entry.errorMessage) return false
    return true
}

/** Valid cut-point candidates: user, done/replayable assistant, compaction. */
export function isCutPointEntry(entry: ConversationEntry): boolean {
    if (entry.kind === 'user') return true
    if (entry.kind === 'compaction') return true
    if (entry.kind === 'assistant') return isReplayableAssistant(entry)
    return false
}

function isTurnStartEntry(entry: ConversationEntry): boolean {
    if (entry.kind === 'user') return true
    if (entry.kind === 'compaction') return true
    return false
}

// ---------------------------------------------------------------------------
// Tool pairing for cut validation
// ---------------------------------------------------------------------------

interface ToolPairing {
    /** Result entry index → selected assistant entry index (when paired). */
    resultToAssistant: ReadonlyMap<number, number>
    /** Assistant entry index → paired result entry indexes (ordered). */
    assistantToResults: ReadonlyMap<number, readonly number[]>
}

/**
 * Pre-build selected replayable toolCall raw/normalized ID → assistant index
 * and ToolResult assignments. Deterministic first-wins for duplicates/conflicts.
 */
export function buildToolPairing(
    entries: readonly ConversationEntry[],
    startIndex = 0,
    endIndex = entries.length,
): ToolPairing {
    const selectedByNormalized = new Map<
        string,
        { entryIndex: number; rawId: string }
    >()
    const skippedConflictingRawIds = new Set<string>()

    for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
        const entry = entries[entryIndex]
        if (!entry || entry.kind !== 'assistant' || !isReplayableAssistant(entry)) {
            continue
        }
        for (const block of entry.content) {
            if (block.type !== 'toolCall') continue
            const rawId = block.id
            if (typeof rawId !== 'string' || rawId.length === 0) continue
            const normalized = normalizeToolCallId(rawId)
            if (!normalized) continue
            if (selectedByNormalized.has(normalized)) {
                const prev = selectedByNormalized.get(normalized)!
                if (rawId !== prev.rawId) {
                    skippedConflictingRawIds.add(rawId)
                }
                continue
            }
            selectedByNormalized.set(normalized, { entryIndex, rawId })
        }
    }

    const resultToAssistant = new Map<number, number>()
    const assistantToResults = new Map<number, number[]>()
    const assignedNormalized = new Set<string>()

    for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
        const entry = entries[entryIndex]
        if (!entry || entry.kind !== 'toolResult') continue
        const rawId = entry.toolCallId
        if (typeof rawId !== 'string' || rawId.length === 0) continue
        const normalized = normalizeToolCallId(rawId)
        if (!normalized) continue
        const selected = selectedByNormalized.get(normalized)
        if (!selected) continue
        if (assignedNormalized.has(normalized)) continue
        if (entryIndex <= selected.entryIndex) continue

        if (rawId === selected.rawId) {
            // exact match
        } else if (skippedConflictingRawIds.has(rawId)) {
            continue
        } else if (rawId === normalized) {
            // legacy: result stores only normalized call_id
        } else {
            // Unknown composite for this normalized id: do not guess.
            continue
        }

        assignedNormalized.add(normalized)
        resultToAssistant.set(entryIndex, selected.entryIndex)
        const list = assistantToResults.get(selected.entryIndex) ?? []
        list.push(entryIndex)
        assistantToResults.set(selected.entryIndex, list)
    }

    return { resultToAssistant, assistantToResults }
}

/**
 * A cut is invalid when a retained ToolResult's matched call is dropped,
 * or when a retained ToolResult has no matched call (orphan).
 */
export function isValidCutForToolPairing(
    cutIndex: number,
    endIndex: number,
    pairing: ToolPairing,
    entries: readonly ConversationEntry[],
): boolean {
    for (let i = cutIndex; i < endIndex; i++) {
        const entry = entries[i]
        if (!entry || entry.kind !== 'toolResult') continue
        const callIndex = pairing.resultToAssistant.get(i)
        if (callIndex === undefined) {
            // Orphan result in retained region — invalid.
            return false
        }
        if (callIndex < cutIndex) {
            // Would keep result but drop its call.
            return false
        }
    }
    return true
}

// ---------------------------------------------------------------------------
// File ops
// ---------------------------------------------------------------------------

export function createFileOps(): FileOps {
    return {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
    }
}

function extractPathArg(args: Record<string, unknown>): string | undefined {
    const path = args.path
    return typeof path === 'string' && path.length > 0 ? path : undefined
}

/**
 * Extract read/write/edit paths from assistant tool calls only.
 * ToolResult entries are never used for path inference.
 */
export function extractFileOpsFromEntry(entry: ConversationEntry, fileOps: FileOps): void {
    if (entry.kind !== 'assistant') return
    for (const block of entry.content) {
        if (block.type !== 'toolCall') continue
        const path = extractPathArg(block.arguments)
        if (!path) continue
        switch (block.name) {
            case 'read':
                fileOps.read.add(path)
                break
            case 'write':
                fileOps.written.add(path)
                break
            case 'edit':
                fileOps.edited.add(path)
                break
            default:
                break
        }
    }
}

/**
 * Compute final file lists. Modified (write/edit) wins over read; codepoint sort.
 */
export function computeFileLists(fileOps: FileOps): {
    readFiles: string[]
    modifiedFiles: string[]
} {
    const modified = new Set<string>([...fileOps.edited, ...fileOps.written])
    const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort()
    const modifiedFiles = [...modified].sort()
    return { readFiles, modifiedFiles }
}

/**
 * Escape control characters and XML-significant chars so path lists stay readable
 * and cannot close the surrounding XML tags.
 */
export function escapeXmlListItem(value: string): string {
    let out = ''
    for (const ch of value) {
        const code = ch.codePointAt(0) ?? 0
        if (code < 0x20 || code === 0x7f) {
            // Drop C0 controls and DEL; keep the path readable.
            continue
        }
        if (ch === '&') {
            out += '&amp;'
            continue
        }
        if (ch === '<') {
            out += '&lt;'
            continue
        }
        if (ch === '>') {
            out += '&gt;'
            continue
        }
        out += ch
    }
    return out
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
    const sections: string[] = []
    if (readFiles.length > 0) {
        const body = readFiles.map(escapeXmlListItem).join('\n')
        sections.push(`<read-files>\n${body}\n</read-files>`)
    }
    if (modifiedFiles.length > 0) {
        const body = modifiedFiles.map(escapeXmlListItem).join('\n')
        sections.push(`<modified-files>\n${body}\n</modified-files>`)
    }
    if (sections.length === 0) return ''
    return `\n\n${sections.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Neutralize XML closing delimiters inside tagged regions while keeping text readable.
 * e.g. </conversation> -> </ conversation>
 */
export function neutralizeClosingTag(text: string, tag: string): string {
    const re = new RegExp(`</\\s*${tag}\\s*>`, 'gi')
    return text.replace(re, `</ ${tag}>`)
}

/**
 * Neutralize open/close <summary...> tags so Task7 wrappers cannot be broken.
 * Does not touch read-files / modified-files markup.
 */
export function neutralizeSummaryTags(text: string): string {
    // Open tags: <summary> or <summary attrs>
    let out = text.replace(/<\s*summary(\s[^>]*)?>/gi, (_m, attrs: string | undefined) => {
        return `< summary${attrs ?? ''}>`
    })
    // Close tags
    out = out.replace(/<\s*\/\s*summary\s*>/gi, '</ summary>')
    return out
}

/**
 * Strip illegal C0 controls (keep tab/LF/CR) so stored summaries stay safe.
 */
export function stripIllegalControls(text: string): string {
    let out = ''
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
            continue
        }
        if (code === 0x7f) continue
        out += ch
    }
    return out
}

/**
 * Strip model-echoed <read-files> / <modified-files> XML blocks so appended
 * implementation-owned file lists are never duplicated.
 */
export function stripFileOperationTags(text: string): string {
    return text.replace(
        /\s*<(read-files|modified-files)>[\s\S]*?<\/\1>/gi,
        '',
    )
}

/**
 * Sanitize model summary body before appending file-list XML and persisting.
 */
export function sanitizeSummaryBody(text: string): string {
    return neutralizeSummaryTags(
        stripIllegalControls(stripFileOperationTags(text)),
    )
}

/**
 * Truncate by Unicode code points without splitting surrogate pairs.
 */
export function truncateCodePoints(text: string, maxCodePoints: number): string {
    const units = Array.from(text)
    if (units.length <= maxCodePoints) return text
    const truncated = units.length - maxCodePoints
    return `${units.slice(0, maxCodePoints).join('')}\n\n[... ${truncated} more characters truncated]`
}

function serializeUser(entry: UserEntry): string[] {
    const parts: string[] = []
    const texts: string[] = []
    let imageCount = 0
    for (const block of entry.content) {
        if (block.type === 'text' && block.text) {
            texts.push(block.text)
        } else if (block.type === 'image') {
            imageCount += 1
        }
    }
    if (texts.length > 0) {
        parts.push(`[User]: ${texts.join('\n')}`)
    }
    for (let i = 0; i < imageCount; i++) {
        parts.push(`[User]: ${IMAGE_PLACEHOLDER}`)
    }
    return parts
}

function serializeAssistant(entry: AssistantEntry): string[] {
    const parts: string[] = []
    const textParts: string[] = []
    const thinkingParts: string[] = []
    const toolCalls: string[] = []

    for (const block of entry.content) {
        if (block.type === 'text') {
            textParts.push(block.text)
        } else if (block.type === 'thinking') {
            thinkingParts.push(block.thinking)
        } else if (block.type === 'toolCall') {
            const args = block.arguments
            const argsStr = Object.entries(args)
                .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
                .join(', ')
            // Include ids so summary association survives non-adjacent results.
            toolCalls.push(`${block.name}(id=${block.id}, ${argsStr})`)
        } else if (block.type === 'image') {
            textParts.push(IMAGE_PLACEHOLDER)
        }
    }

    if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`)
    }
    if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join('\n')}`)
    }
    if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`)
    }
    return parts
}

function serializeToolResult(entry: ToolResultEntry): string[] {
    const parts: string[] = []
    const texts: string[] = []
    let imageCount = 0
    for (const block of entry.content) {
        if (block.type === 'text') {
            texts.push(block.text)
        } else if (block.type === 'image') {
            imageCount += 1
        }
    }
    const content = texts.join('')
    if (content) {
        parts.push(
            `[Tool result id=${entry.toolCallId}]: ${truncateCodePoints(content, TOOL_RESULT_MAX_CODE_POINTS)}`,
        )
    }
    for (let i = 0; i < imageCount; i++) {
        parts.push(`[Tool result id=${entry.toolCallId}]: ${IMAGE_PLACEHOLDER}`)
    }
    return parts
}

/**
 * Serialize conversation entries for summarization prompts.
 * Tool results are truncated by code points; images become placeholders.
 * Tool call/result ids are included for association.
 */
export function serializeConversation(entries: readonly ConversationEntry[]): string {
    const parts: string[] = []
    for (const entry of entries) {
        if (entry.kind === 'user') {
            parts.push(...serializeUser(entry))
        } else if (entry.kind === 'assistant') {
            parts.push(...serializeAssistant(entry))
        } else if (entry.kind === 'toolResult') {
            parts.push(...serializeToolResult(entry))
        } else if (entry.kind === 'compaction') {
            parts.push(`[Compaction summary]: ${entry.summary}`)
        }
    }
    return parts.join('\n\n')
}

/**
 * Extract markdown heading lines outside fenced code blocks.
 */
export function extractMarkdownHeadings(text: string): string[] {
    const headings: string[] = []
    let inFence = false
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('```')) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        if (/^#{1,6}\s+\S/.test(trimmed)) {
            headings.push(trimmed)
        }
    }
    return headings
}

function validateHeadingsExactOnceInOrder(
    summary: string,
    required: readonly string[],
    label: string,
): void {
    const trimmed = summary.trim()
    if (!trimmed) {
        throw new Error(`Summarization failed: empty ${label}`)
    }
    const headings = extractMarkdownHeadings(trimmed)
    // Each required heading must appear exactly once among extracted headings.
    for (const heading of required) {
        const count = headings.filter((h) => h === heading).length
        if (count === 0) {
            throw new Error(`Summarization failed: missing required headings: ${heading}`)
        }
        if (count > 1) {
            throw new Error(
                `Summarization failed: duplicate required heading: ${heading}`,
            )
        }
    }
    // Strict order: required headings appear in the specified order in the heading list.
    let cursor = 0
    for (const heading of required) {
        let found = -1
        for (let i = cursor; i < headings.length; i++) {
            if (headings[i] === heading) {
                found = i
                break
            }
        }
        if (found < 0) {
            throw new Error(
                `Summarization failed: required headings out of order near: ${heading}`,
            )
        }
        cursor = found + 1
    }
}

export function validateSummaryStructure(summary: string): void {
    validateHeadingsExactOnceInOrder(summary, REQUIRED_SUMMARY_HEADINGS, 'summary')
}

export function validateTurnPrefixStructure(summary: string): void {
    validateHeadingsExactOnceInOrder(
        summary,
        REQUIRED_TURN_PREFIX_HEADINGS,
        'turn-prefix summary',
    )
}

// ---------------------------------------------------------------------------
// Cut point
// ---------------------------------------------------------------------------

function findValidCutPoints(
    entries: readonly ConversationEntry[],
    startIndex: number,
    endIndex: number,
    pairing: ToolPairing,
): number[] {
    const cutPoints: number[] = []
    for (let i = startIndex; i < endIndex; i++) {
        const entry = entries[i]
        if (!entry || !isCutPointEntry(entry)) continue
        if (!isValidCutForToolPairing(i, endIndex, pairing, entries)) continue
        cutPoints.push(i)
    }
    return cutPoints
}

export function findTurnStartIndex(
    entries: readonly ConversationEntry[],
    entryIndex: number,
    startIndex: number,
): number {
    for (let i = entryIndex; i >= startIndex; i--) {
        const entry = entries[i]
        if (entry && isTurnStartEntry(entry)) {
            return i
        }
    }
    return -1
}

/**
 * Find the cut that retains approximately keepRecentTokens of recent context.
 * Never cuts on ToolResult. Invalid tool-pairing candidates advance to the next valid.
 * Mid-turn assistant cuts record turnStart for split.
 */
export function findCutPoint(
    entries: readonly ConversationEntry[],
    startIndex: number,
    endIndex: number,
    keepRecentTokens: number,
): CutPointResult {
    const pairing = buildToolPairing(entries, startIndex, endIndex)
    const cutPoints = findValidCutPoints(entries, startIndex, endIndex, pairing)
    if (cutPoints.length === 0) {
        return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false }
    }

    let accumulatedTokens = 0
    let preferredMin = cutPoints[0]!
    let hitBudget = false

    for (let i = endIndex - 1; i >= startIndex; i--) {
        const entry = entries[i]
        if (!entry) continue
        const messageTokens = estimateTokens(entry)
        if (messageTokens === 0) continue
        accumulatedTokens += messageTokens
        if (accumulatedTokens >= keepRecentTokens) {
            preferredMin = i
            hitBudget = true
            break
        }
    }

    // Choose the earliest valid cut point that still keeps the recent budget
    // (candidate >= preferredMin). Advance to subsequent valid when pairing fails.
    let cutIndex = cutPoints[cutPoints.length - 1]!
    if (hitBudget) {
        let found = false
        for (const candidate of cutPoints) {
            if (candidate >= preferredMin) {
                cutIndex = candidate
                found = true
                break
            }
        }
        if (!found) {
            // No valid candidate after preferredMin — keep the latest valid cut
            // (most retention while remaining pair-safe).
            cutIndex = cutPoints[cutPoints.length - 1]!
        }
    } else {
        // Everything fits: keep from the earliest valid cut.
        cutIndex = cutPoints[0]!
    }

    const cutEntry = entries[cutIndex]
    const startsTurn = cutEntry ? isTurnStartEntry(cutEntry) : true
    const turnStartIndex = startsTurn
        ? -1
        : findTurnStartIndex(entries, cutIndex, startIndex)

    return {
        firstKeptEntryIndex: cutIndex,
        turnStartIndex,
        isSplitTurn: !startsTurn && turnStartIndex !== -1,
    }
}

// ---------------------------------------------------------------------------
// Logical active tail (multi-cycle)
// ---------------------------------------------------------------------------

interface LogicalActiveTail {
    /** Non-compaction retained + new entries (no markers). */
    logical: ConversationEntry[]
    /** logical index → original entries index. */
    originalIndexes: number[]
    previousSummary?: string
    previousReadFiles: string[]
    previousModifiedFiles: string[]
}

/**
 * Build the logical active tail from the latest compaction marker.
 * logical = non-compaction retained entries from firstKeptId + new entries after marker.
 * Markers are excluded; never scan cuts on raw markers.
 */
export function buildLogicalActiveTail(
    entries: readonly ConversationEntry[],
): LogicalActiveTail | undefined {
    if (entries.length === 0) return undefined
    if (entries[entries.length - 1]?.kind === 'compaction') {
        // Last entry is a marker with no new entries.
        return undefined
    }

    let latestIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.kind === 'compaction') {
            latestIndex = i
            break
        }
    }

    if (latestIndex < 0) {
        const logical: ConversationEntry[] = []
        const originalIndexes: number[] = []
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]
            if (!entry || entry.kind === 'compaction') continue
            logical.push(entry)
            originalIndexes.push(i)
        }
        if (logical.length === 0) return undefined
        return {
            logical,
            originalIndexes,
            previousSummary: undefined,
            previousReadFiles: [],
            previousModifiedFiles: [],
        }
    }

    const latest = entries[latestIndex] as CompactionEntry
    let firstKeptIndex = -1
    if (latest.firstKeptEntryId) {
        for (let i = 0; i < entries.length; i++) {
            if (i === latestIndex) continue
            if (entries[i]?.id === latest.firstKeptEntryId) {
                firstKeptIndex = i
                break
            }
        }
    }
    const tailStart = firstKeptIndex >= 0 ? firstKeptIndex : latestIndex + 1

    const logical: ConversationEntry[] = []
    const originalIndexes: number[] = []
    for (let i = tailStart; i < entries.length; i++) {
        if (i === latestIndex) continue
        const entry = entries[i]
        if (!entry || entry.kind === 'compaction') continue
        logical.push(entry)
        originalIndexes.push(i)
    }
    if (logical.length === 0) return undefined

    return {
        logical,
        originalIndexes,
        previousSummary: latest.summary,
        previousReadFiles: latest.readFiles ? [...latest.readFiles] : [],
        previousModifiedFiles: latest.modifiedFiles ? [...latest.modifiedFiles] : [],
    }
}

/**
 * Plan a compaction without side effects.
 * Returns undefined when there is nothing to summarize or the last entry is already a compaction.
 */
export function prepareCompaction(
    entries: readonly ConversationEntry[],
    settings?: Partial<CompactionSettings> | null,
): CompactionPreparation | undefined {
    const active = buildLogicalActiveTail(entries)
    if (!active) return undefined

    const normalized = normalizeCompactionSettings(settings)
    const { logical, originalIndexes } = active

    // tokensBefore uses the effective compacted view (latest + retained/new).
    const tokensBefore = estimateContextTokens(entries).tokens

    const cutPoint = findCutPoint(logical, 0, logical.length, normalized.keepRecentTokens)

    const firstKeptLogical = logical[cutPoint.firstKeptEntryIndex]
    if (!firstKeptLogical?.id) {
        return undefined
    }

    const historyEnd = cutPoint.isSplitTurn
        ? cutPoint.turnStartIndex
        : cutPoint.firstKeptEntryIndex

    const historyEntries: ConversationEntry[] = []
    for (let i = 0; i < historyEnd; i++) {
        const entry = logical[i]
        if (entry) historyEntries.push(entry)
    }

    const turnPrefixEntries: ConversationEntry[] = []
    if (cutPoint.isSplitTurn) {
        for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
            const entry = logical[i]
            if (entry) turnPrefixEntries.push(entry)
        }
    }

    if (historyEntries.length === 0 && turnPrefixEntries.length === 0) {
        return undefined
    }

    const fileOps = createFileOps()
    for (const f of active.previousReadFiles) fileOps.read.add(f)
    for (const f of active.previousModifiedFiles) fileOps.edited.add(f)
    for (const entry of historyEntries) {
        extractFileOpsFromEntry(entry, fileOps)
    }
    for (const entry of turnPrefixEntries) {
        extractFileOpsFromEntry(entry, fileOps)
    }

    // Map logical firstKept index back to original raw index for callers that need it.
    const originalFirstKept = originalIndexes[cutPoint.firstKeptEntryIndex] ?? -1
    const originalTurnStart =
        cutPoint.isSplitTurn && cutPoint.turnStartIndex >= 0
            ? (originalIndexes[cutPoint.turnStartIndex] ?? -1)
            : -1

    return {
        firstKeptEntryId: firstKeptLogical.id,
        firstKeptEntryIndex: originalFirstKept,
        tokensBefore,
        previousSummary: active.previousSummary,
        previousReadFiles: active.previousReadFiles,
        previousModifiedFiles: active.previousModifiedFiles,
        isSplitTurn: cutPoint.isSplitTurn,
        turnStartIndex: originalTurnStart,
        historyEntries,
        turnPrefixEntries,
        fileOps,
        settings: normalized,
    }
}

// ---------------------------------------------------------------------------
// Summary via isolated CPAClient.stream
// ---------------------------------------------------------------------------

function defaultId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

export async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
        throw new Error('Request was aborted')
    }
    if (ms <= 0) return
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(new Error('Request was aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

export const MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS = 1_024
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000
const SUMMARY_INPUT_SAFETY_MARGIN_TOKENS = 512

function estimateIsolatedPromptInputTokens(promptText: string): number {
    return (
        Math.ceil(
            (SUMMARIZATION_SYSTEM_PROMPT.length + promptText.length) / 4,
        ) + SUMMARY_INPUT_SAFETY_MARGIN_TOKENS
    )
}

function sliceUtf16PrefixSafe(text: string, maxUnits: number): string {
    if (maxUnits <= 0) return ''
    if (text.length <= maxUnits) return text
    let end = maxUnits
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) {
        end -= 1
    }
    return text.slice(0, end)
}

function sliceUtf16SuffixSafe(text: string, maxUnits: number): string {
    if (maxUnits <= 0) return ''
    if (text.length <= maxUnits) return text
    let start = text.length - maxUnits
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) {
        start += 1
    }
    return text.slice(start)
}

function trimSectionBody(
    body: string,
    budget: number,
    marker: string,
): string {
    if (budget <= 0) return ''
    if (body.length <= budget) return body
    const contentBudget = budget - marker.length
    if (contentBudget > 64) {
        const half = Math.floor(contentBudget / 2)
        const head = sliceUtf16PrefixSafe(body, half)
        const tail = sliceUtf16SuffixSafe(body, contentBudget - head.length)
        return head + marker + tail
    }
    return sliceUtf16PrefixSafe(body, budget)
}

/**
 * Ensure an isolated summarization prompt leaves at least MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS
 * (when model.contextWindow permits) so input + output never exceed model.contextWindow,
 * while always preserving XML delimiters, <previous-summary>, and the trailing format instructions.
 */
function fitIsolatedPromptToContextWindow(
    promptText: string,
    model: ModelCatalogEntry,
): string {
    if (
        typeof model.contextWindow !== 'number' ||
        !Number.isFinite(model.contextWindow) ||
        model.contextWindow <= 0
    ) {
        return promptText
    }
    const contextWindow = Math.floor(model.contextWindow)
    const minOutput = Math.min(
        typeof model.maxTokens === 'number' && model.maxTokens > 0
            ? Math.floor(model.maxTokens)
            : MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS,
        MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS,
    )
    const convOpen = '<conversation>\n'
    const convClose = '\n</conversation>\n\n'
    if (promptText.startsWith(convOpen)) {
        const convCloseIdx = promptText.indexOf(convClose, convOpen.length)
        if (convCloseIdx >= convOpen.length) {
            const conversationBody = promptText.slice(convOpen.length, convCloseIdx)
            const rest = promptText.slice(convCloseIdx + convClose.length)

            const prevOpen = '<previous-summary>\n'
            const prevClose = '\n</previous-summary>\n\n'
            let previousSummaryBody: string | undefined
            let instructions = rest
            if (rest.startsWith(prevOpen)) {
                const prevCloseIdx = rest.indexOf(prevClose, prevOpen.length)
                if (prevCloseIdx >= prevOpen.length) {
                    previousSummaryBody = rest.slice(prevOpen.length, prevCloseIdx)
                    instructions = rest.slice(prevCloseIdx + prevClose.length)
                }
            }

            const focusPrefix = '\n\nAdditional focus: '
            const focusIdx = instructions.indexOf(focusPrefix)
            const coreInstructions =
                focusIdx >= 0 ? instructions.slice(0, focusIdx) : instructions
            const focusBody =
                focusIdx >= 0
                    ? instructions.slice(focusIdx + focusPrefix.length)
                    : undefined

            const fixedChars =
                convOpen.length +
                convClose.length +
                (previousSummaryBody !== undefined
                    ? prevOpen.length + prevClose.length
                    : 0) +
                coreInstructions.length

            const totalFixedTokens =
                Math.ceil((SUMMARIZATION_SYSTEM_PROMPT.length + fixedChars) / 4) +
                SUMMARY_INPUT_SAFETY_MARGIN_TOKENS
            const remainingForBodyAndOutput = contextWindow - totalFixedTokens
            if (remainingForBodyAndOutput <= 1) {
                return promptText
            }
            const targetOutputReserve =
                remainingForBodyAndOutput - minOutput >= 64
                    ? minOutput
                    : Math.min(
                          minOutput,
                          Math.max(1, Math.floor(remainingForBodyAndOutput / 2)),
                      )
            const maxTotalInputTokens = contextWindow - targetOutputReserve
            const maxPromptChars =
                (maxTotalInputTokens - SUMMARY_INPUT_SAFETY_MARGIN_TOKENS) * 4 -
                SUMMARIZATION_SYSTEM_PROMPT.length
            if (promptText.length <= maxPromptChars) {
                return promptText
            }

            let remainingBudget = Math.max(4, maxPromptChars - fixedChars)
            let trimmedFocus = ''
            if (focusBody !== undefined && remainingBudget > focusPrefix.length + 8) {
                const maxFocusChars = Math.min(
                    focusBody.length,
                    Math.max(8, Math.floor((remainingBudget - focusPrefix.length) * 0.2)),
                )
                const safeFocus = sliceUtf16PrefixSafe(focusBody, maxFocusChars)
                if (safeFocus.length > 0) {
                    trimmedFocus = focusPrefix + safeFocus
                    remainingBudget -= trimmedFocus.length
                }
            }

            const convMarker =
                '\n...[earlier conversation truncated to fit context window]...\n'
            if (previousSummaryBody === undefined) {
                const trimmedConv = trimSectionBody(
                    conversationBody,
                    remainingBudget,
                    convMarker,
                )
                return convOpen + trimmedConv + convClose + coreInstructions + trimmedFocus
            }

            const half = Math.floor(remainingBudget / 2)
            let convBudget: number
            let prevBudget: number
            if (previousSummaryBody.length <= half) {
                prevBudget = previousSummaryBody.length
                convBudget = remainingBudget - prevBudget
            } else if (conversationBody.length <= remainingBudget - half) {
                convBudget = conversationBody.length
                prevBudget = remainingBudget - convBudget
            } else {
                convBudget = remainingBudget - half
                prevBudget = half
            }
            const prevMarker =
                '\n...[previous summary truncated to fit context window]...\n'
            const trimmedConv = trimSectionBody(
                conversationBody,
                convBudget,
                convMarker,
            )
            const trimmedPrev = trimSectionBody(
                previousSummaryBody,
                prevBudget,
                prevMarker,
            )
            return (
                convOpen +
                trimmedConv +
                convClose +
                prevOpen +
                trimmedPrev +
                prevClose +
                coreInstructions +
                trimmedFocus
            )
        }
    }

    const fallbackFixedTokens =
        Math.ceil(SUMMARIZATION_SYSTEM_PROMPT.length / 4) +
        SUMMARY_INPUT_SAFETY_MARGIN_TOKENS
    const fallbackRemaining = contextWindow - fallbackFixedTokens
    if (fallbackRemaining <= 1) {
        return promptText
    }
    const fallbackOutputReserve =
        fallbackRemaining - minOutput >= 64
            ? minOutput
            : Math.min(minOutput, Math.max(1, Math.floor(fallbackRemaining / 2)))
    const fallbackMaxChars =
        (contextWindow - fallbackOutputReserve - SUMMARY_INPUT_SAFETY_MARGIN_TOKENS) *
            4 -
        SUMMARIZATION_SYSTEM_PROMPT.length
    if (promptText.length <= fallbackMaxChars) {
        return promptText
    }
    return sliceUtf16PrefixSafe(promptText, Math.max(1, fallbackMaxChars))
}

function estimateCachedSummaryInputTokens(
    protocolEntries: readonly ConversationEntry[],
    cachedContext: CachedCompactionContext,
): number {
    const est = estimateContextTokens(protocolEntries)
    // When a trusted assistant usage baseline is present (est.usage > 0),
    // usage.totalTokens already includes systemPrompt, developerPrompt, and tools.
    if (est.usage > 0) {
        return est.tokens + SUMMARY_INPUT_SAFETY_MARGIN_TOKENS
    }
    const systemChars =
        (cachedContext.systemPrompt?.length ?? 0) +
        (cachedContext.developerPrompt?.length ?? 0)
    const toolsChars = cachedContext.tools?.length
        ? JSON.stringify(cachedContext.tools).length
        : 0
    const nativeToolsChars = cachedContext.nativeTools?.length
        ? JSON.stringify(cachedContext.nativeTools).length
        : 0
    return (
        est.tokens +
        Math.ceil((systemChars + toolsChars + nativeToolsChars) / 4) +
        SUMMARY_INPUT_SAFETY_MARGIN_TOKENS
    )
}

/**
 * Compute summary output token budget (Pi 1.4+ semantics):
 * Uses the model's own maxTokens instead of capping by reserveTokens,
 * and dynamically shrinks when needed so input + output fit within contextWindow.
 */
export function resolveSummaryMaxTokens(
    model: ModelCatalogEntry,
    estimatedInputTokens = 0,
    fallbackReserveTokens: number = DEFAULT_COMPACTION_SETTINGS.reserveTokens,
): number {
    const hasModelMax =
        typeof model.maxTokens === 'number' &&
        Number.isFinite(model.maxTokens) &&
        model.maxTokens > 0
    const modelMax = hasModelMax
        ? Math.floor(model.maxTokens)
        : Math.max(1, Math.floor(fallbackReserveTokens * 0.8))

    if (
        typeof estimatedInputTokens === 'number' &&
        Number.isFinite(estimatedInputTokens) &&
        estimatedInputTokens > 0 &&
        typeof model.contextWindow === 'number' &&
        Number.isFinite(model.contextWindow) &&
        model.contextWindow > 0
    ) {
        const contextWindow = Math.floor(model.contextWindow)
        const remaining = contextWindow - Math.ceil(estimatedInputTokens)
        if (remaining < modelMax) {
            if (remaining > 0) {
                return remaining
            }
            return Math.min(
                modelMax,
                 Math.min(contextWindow, MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS),
            )
        }
    }

    return modelMax
}

function summaryMaxTokens(
    reserveTokens: number,
    model: ModelCatalogEntry,
    estimatedInputTokens = 0,
): number {
    return resolveSummaryMaxTokens(model, estimatedInputTokens, reserveTokens)
}

function turnPrefixMaxTokens(
    reserveTokens: number,
    model: ModelCatalogEntry,
    estimatedInputTokens = 0,
): number {
    return resolveSummaryMaxTokens(
        model,
        estimatedInputTokens,
         Math.max(1, Math.floor(reserveTokens * 0.625)),
    )
}

function extractAssistantText(entry: AssistantEntry): string {
    return entry.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
}

function emptyUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

export function mergeUsage(a?: Usage, b?: Usage): Usage | undefined {
    if (!a && !b) return undefined
    const left = a ?? emptyUsage()
    const right = b ?? emptyUsage()
    return {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        totalTokens: left.totalTokens + right.totalTokens,
        reasoning:
            left.reasoning !== undefined || right.reasoning !== undefined
                ? (left.reasoning ?? 0) + (right.reasoning ?? 0)
                : undefined,
        cost: {
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            total: left.cost.total + right.cost.total,
        },
    }
}

function buildHistoryPromptText(
    entries: readonly ConversationEntry[],
    previousSummary: string | undefined,
    customInstructions: string | undefined,
): string {
    const conversationText = neutralizeClosingTag(
        serializeConversation(entries),
        'conversation',
    )
    let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT
    if (customInstructions) {
        basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`
    }

    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`
    if (previousSummary) {
        const safePrevious = neutralizeClosingTag(
            neutralizeSummaryTags(previousSummary),
            'previous-summary',
        )
        promptText += `<previous-summary>\n${safePrevious}\n</previous-summary>\n\n`
    }
    promptText += basePrompt
    return promptText
}

function buildTurnPrefixPromptText(entries: readonly ConversationEntry[]): string {
    const conversationText = neutralizeClosingTag(
        serializeConversation(entries),
        'conversation',
    )
    return `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
}

const KEPT_START_PREVIEW_MAX_CODE_POINTS = 400

function entryPreviewText(entry: ConversationEntry): string | undefined {
    let raw: string | undefined
    if (entry.kind === 'user') {
        const texts: string[] = []
        let hasImage = false
        for (const block of entry.content) {
            if (block.type === 'text' && block.text.trim()) {
                texts.push(block.text)
            } else if (block.type === 'image') {
                hasImage = true
            }
        }
        if (texts.length > 0) {
            raw = texts.join('\n')
        } else if (hasImage) {
            raw = IMAGE_PLACEHOLDER
        }
    } else if (entry.kind === 'assistant') {
        const parts: string[] = []
        for (const block of entry.content) {
            if (block.type === 'text' && block.text.trim()) {
                parts.push(block.text)
            } else if (block.type === 'toolCall') {
                parts.push(
                    `[tool call: ${block.name} ${safeJsonStringify(block.arguments ?? {})}]`,
                )
            }
        }
        if (parts.length > 0) {
            raw = parts.join('\n')
        }
    }

    const trimmed = raw?.trim()
    if (!trimmed) return undefined
    const units = Array.from(trimmed)
    if (units.length <= KEPT_START_PREVIEW_MAX_CODE_POINTS) {
        return trimmed
    }
    return `${units.slice(0, KEPT_START_PREVIEW_MAX_CODE_POINTS).join('')}…`
}

/**
 * Locate the opening preview text of the first kept message in the compacted view.
 * Returns undefined if there are no prior entries to summarize or no kept message has preview text.
 */
export function findKeptStart(
    compactedEntries: readonly ConversationEntry[],
    firstKeptEntryId: string,
): KeptStartInfo | undefined {
    const startIndex = compactedEntries.findIndex(
        (entry) => entry.id === firstKeptEntryId,
    )
    if (startIndex <= 0) return undefined

    const keptEntries = compactedEntries.slice(startIndex)
    const previews = keptEntries.map((entry) => entryPreviewText(entry))
    // Only accept a preview from the exact firstKeptEntryId entry (index 0 of keptEntries)
    // so the <kept-start> boundary never drifts past kept messages without text.
    const firstText = previews[0]
    if (typeof firstText !== 'string' || firstText.length === 0) return undefined

    const fromEnd = previews.filter((preview) => preview === firstText).length
    const count = keptEntries.filter(
        (entry) =>
            entry.kind === 'user' ||
            entry.kind === 'assistant' ||
            entry.kind === 'toolResult',
    ).length
    if (count <= 0) return undefined

    return {
        text: firstText,
        fromEnd,
        count,
    }
}

export function resolveSessionBaseReasoningEffort(
    entries: readonly ConversationEntry[],
    fallback?: string,
): string | undefined {
    for (const entry of entries) {
        if (
            (entry.kind === 'user' || entry.kind === 'assistant') &&
            entry.reasoningEffort
        ) {
            return entry.reasoningEffort
        }
    }
    return fallback
}

function stableJsonEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false
        }
        for (let i = 0; i < a.length; i++) {
            if (!stableJsonEqual(a[i], b[i])) return false
        }
        return true
    }
    const objA = a as Record<string, unknown>
    const objB = b as Record<string, unknown>
    const keysA = Object.keys(objA)
    const keysB = Object.keys(objB)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
        if (!Object.prototype.hasOwnProperty.call(objB, key)) return false
        if (!stableJsonEqual(objA[key], objB[key])) return false
    }
    return true
}

function areEntriesPrefixEquivalent(
    expected: ConversationEntry,
    actual: ConversationEntry,
): boolean {
    if (expected.id !== actual.id || expected.kind !== actual.kind) {
        return false
    }
    switch (expected.kind) {
        case 'user': {
            const act = actual as UserEntry
            return (
                expected.reasoningEffort === act.reasoningEffort &&
                stableJsonEqual(expected.content, act.content)
            )
        }
        case 'assistant': {
            const act = actual as AssistantEntry
            return (
                expected.model === act.model &&
                expected.stopReason === act.stopReason &&
                expected.status === act.status &&
                expected.reasoningEffort === act.reasoningEffort &&
                stableJsonEqual(expected.content, act.content)
            )
        }
        case 'toolResult': {
            const act = actual as ToolResultEntry
            return (
                expected.toolCallId === act.toolCallId &&
                expected.toolName === act.toolName &&
                Boolean(expected.isError) === Boolean(act.isError) &&
                stableJsonEqual(expected.content, act.content)
            )
        }
        case 'compaction': {
            const act = actual as CompactionEntry
            return (
                expected.summary === act.summary &&
                expected.firstKeptEntryId === act.firstKeptEntryId
            )
        }
    }
}

/**
 * Build the trailing user instruction for cache-hit compaction.
 * Quotes the <kept-start> boundary so the model summarizes only messages before it.
 */
export function buildCachedSummaryPrompt(
    kept: KeptStartInfo,
    customInstructions?: string,
): string {
    const repeated =
        kept.fromEnd > 1
            ? ` Several kept messages begin with this text: it is number ${kept.fromEnd} of them, counting back from the end.`
            : ''
    const toolCalls = kept.text.includes('[tool call: ')
        ? ' Tool calls are written as [tool call: name arguments].'
        : ''
    const focus = customInstructions?.trim()
        ? `\n\nAdditional focus: ${customInstructions.trim()}`
        : ''
    const safeKeptText = neutralizeClosingTag(kept.text, 'kept-start')

    return `Stop working on the task and do not call any tools. Write a structured context checkpoint summary of the earlier part of the conversation above. Another LLM will continue the work from your summary, followed by the last ${kept.count} messages of the conversation, which stay in context verbatim.

The kept messages start with the message that begins with the text below.${repeated}${toolCalls}

<kept-start>
${safeKeptText}
</kept-start>

Summarize only the messages before it, as if the conversation ended right there. Done lists only work finished before it. Whatever happens from that message on, including its tool calls, their results, and later replies, has not happened as far as your summary knows: leave it out, or list it under Next Steps if it was already planned.

If the conversation starts with an earlier <summary>, fold it into the new one: preserve its facts, move finished items from "In Progress" to "Done", and update "Next Steps".

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages. Do not include <read-files> or <modified-files> blocks; they are appended automatically. Reply with the summary only, and stop it right before the message that begins with the <kept-start> text.${focus}`
}

/**
 * On OpenAI Responses API models, tool_choice is not part of the cached prefix,
 * so setting toolChoice: 'none' disables tool calls while preserving cache hits.
 * On Claude/Anthropic models, changing tool_choice invalidates the message cache,
 * so toolChoice is left undefined ('auto') and the prompt instructs no tool calls.
 */
export function shouldDisableToolsForCachedSummary(
    modelId: string,
    tools?: readonly ProtocolToolDefinition[],
    nativeTools?: readonly { type: 'web_search' }[],
): boolean {
    const hasTools =
        (Array.isArray(tools) && tools.length > 0) ||
        (Array.isArray(nativeTools) && nativeTools.length > 0)
    if (!hasTools) return false
    return !/claude|anthropic/i.test(modelId)
}

function isAbortSummaryError(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return true
    if (error instanceof Error && error.name === 'AbortError') return true
    const message =
        error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : String(error ?? '')
    return /request was aborted|aborted by user|the operation was aborted/i.test(
        message,
    )
}

/**
 * Validate the preconditions for cache-hit compaction:
 * 0. Fast context compaction MUST be disabled (`fastContextCompaction === false`).
 *    When fast context compaction is enabled, legacy isolated compaction is used.
 * 1. Valid cachedContext & non-overflow trigger
 * 2. Same model as the last cached turn
 * 3. Prompt cache has not expired
 * 4. Conversation only grew by appending (strictly extends requestEntries) & has valid <kept-start>
 */
export function canUseCachedCompaction(
    compactedEntries: readonly ConversationEntry[],
    preparation: CompactionPreparation,
    options: CompactConversationOptions,
    nowTime: number,
): { keptStart: KeptStartInfo; cachedContext: CachedCompactionContext } | undefined {
    if (options.fastContextCompaction !== false) return undefined
    const cachedContext = options.cachedContext
    if (!cachedContext) return undefined
    if (options.trigger === 'overflow') return undefined
    if (cachedContext.modelId !== options.model.id) {
        return undefined
    }
    const effectiveExpiresAt =
        typeof cachedContext.cacheExpiresAt === 'number' &&
        Number.isFinite(cachedContext.cacheExpiresAt)
            ? cachedContext.cacheExpiresAt
            : typeof cachedContext.lastCachedAt === 'number' &&
                Number.isFinite(cachedContext.lastCachedAt)
              ? cachedContext.lastCachedAt + DEFAULT_PROMPT_CACHE_TTL_MS
              : undefined
    if (effectiveExpiresAt === undefined || nowTime >= effectiveExpiresAt) {
        return undefined
    }

    // Must have at least one completed replayable assistant in the active context
    // and its model (when recorded) must match the current model.
    let lastReplayableAssistant: AssistantEntry | undefined
    for (let i = compactedEntries.length - 1; i >= 0; i--) {
        const entry = compactedEntries[i]
        if (entry?.kind === 'assistant' && isReplayableAssistant(entry)) {
            lastReplayableAssistant = entry
            break
        }
    }
    if (!lastReplayableAssistant) {
        return undefined
    }
    if (
        lastReplayableAssistant.model &&
        lastReplayableAssistant.model !== options.model.id
    ) {
        return undefined
    }

    // Verify append-only growth and content equivalence against the captured request entries.
    const prefix = cachedContext.requestEntries
    if (
        !prefix ||
        prefix.length === 0 ||
        compactedEntries.length < prefix.length
    ) {
        return undefined
    }
    for (let i = 0; i < prefix.length; i++) {
        const expected = prefix[i]
        const actual = compactedEntries[i]
        if (
            !expected ||
            !actual ||
            !areEntriesPrefixEquivalent(expected, actual)
        ) {
            return undefined
        }
    }

    const keptStart = findKeptStart(
        compactedEntries,
        preparation.firstKeptEntryId,
    )
    if (!keptStart) return undefined

    return { keptStart, cachedContext }
}

async function collectStream(
    stream: AsyncIterable<AssistantStreamEvent>,
): Promise<AssistantEntry> {
    const iterator = stream[Symbol.asyncIterator]()
    let lastAssistant: AssistantEntry | undefined
    while (true) {
        const next = await iterator.next()
        if (next.done) {
            if (next.value && typeof next.value === 'object' && 'kind' in next.value) {
                return next.value as AssistantEntry
            }
            if (lastAssistant) {
                return lastAssistant
            }
            throw new Error('Stream ended without completing')
        }
        const event = next.value
        if (event.type === 'done') {
            lastAssistant = event.message
        } else if (event.type === 'error') {
            lastAssistant = event.error
        }
    }
}

/**
 * True for post-stream transient failures eligible for summary-level retry.
 * Abort, deterministic 4xx, and validation failures are never retried.
 */
export function isTransientSummaryError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') {
        return false
    }
    const message =
        error instanceof Error
            ? error.message
            : typeof error === 'string'
              ? error
              : String(error ?? '')
    if (!message) return false
    if (/request was aborted|aborted by user|the operation was aborted/i.test(message)) {
        return false
    }
    if (/missing required headings|duplicate required heading|empty summary|empty turn-prefix|out of order/i.test(message)) {
        return false
    }
    if (/summarization failed:.*tool/i.test(message)) {
        return false
    }
    // Deterministic summary completion failures (length / incomplete / wrong stop / errorMessage).
    if (
        /stopReason length|response\.incomplete|incomplete summary|expected stop|has errorMessage|unexpected stopReason/i.test(
            message,
        )
    ) {
        return false
    }
    // Deterministic 4xx / auth — do not retry.
    if (
        /\b(401|403|404|422|400)\b/.test(message) ||
        /unauthorized|forbidden|invalid.?api.?key|authentication|permission denied/i.test(
            message,
        )
    ) {
        return false
    }
    if (/closed before response\.completed/i.test(message)) return true
    if (/network|econnreset|econnrefused|etimedout|socket|websocket|connection (closed|reset|lost)/i.test(message)) {
        return true
    }
    if (/missing completed|did not complete|stream (ended|closed|failed)/i.test(message)) {
        return true
    }
    if (/summarization failed:/i.test(message) && /timeout|temporar|unavailable|503|502|500|429/i.test(message)) {
        return true
    }
    return false
}

/**
 * Summary success is strict: status==='done' && stopReason==='stop',
 * no tool calls, no errorMessage. Shared by history and turn-prefix paths.
 * stopReason 'length' (response.incomplete) is a deterministic output-limit
 * failure and must never be treated as success or as a transient retry.
 */
function assertSummaryAssistantOk(result: AssistantEntry, label: string): void {
    if (result.status === 'aborted' || result.stopReason === 'aborted') {
        throw new Error('Request was aborted')
    }
    if (result.status === 'error' || result.stopReason === 'error') {
        throw new Error(
            `${label} failed: ${result.errorMessage || 'Unknown error'}`,
        )
    }
    // Deterministic output budget hit — incomplete summary, no retry.
    if (result.stopReason === 'length') {
        throw new Error(
            `${label} failed: incomplete summary (stopReason length / response.incomplete)`,
        )
    }
    if (result.stopReason === 'toolUse' || result.stopReason === 'pending') {
        throw new Error(
            `${label} failed: unexpected stopReason ${result.stopReason}`,
        )
    }
    if (result.status !== 'done') {
        throw new Error(`${label} failed: status is ${result.status}, expected done`)
    }
    if (result.stopReason !== 'stop') {
        throw new Error(
            `${label} failed: unexpected stopReason ${result.stopReason}, expected stop`,
        )
    }
    if (typeof result.errorMessage === 'string' && result.errorMessage.length > 0) {
        throw new Error(
            `${label} failed: summary response has errorMessage: ${result.errorMessage}`,
        )
    }
    for (const block of result.content) {
        if (block.type === 'toolCall') {
            throw new Error(`${label} failed: summary response contained toolCall`)
        }
    }
}

async function runIsolatedSummary(params: {
    client: ProtocolClient
    model: ModelCatalogEntry
    sessionId: string
    promptText: string
    maxOutputTokens: number
    reasoningEffort?: string
    speed?: string
    signal: AbortSignal
    now: () => number
    generateId: () => string
    sleep: SleepFn
    retryDelaysMs: readonly number[]
    label: string
}): Promise<AssistantEntry> {
    const {
        client,
        model,
        sessionId,
        promptText,
        maxOutputTokens,
        reasoningEffort,
        speed,
        signal,
        now,
        generateId,
        sleep,
        retryDelaysMs,
        label,
    } = params

    const maxAttempts = 1 + retryDelaysMs.length
    let lastError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal.aborted) {
            throw new Error('Request was aborted')
        }
        // Fresh ids / prompt cache key on every attempt (including retries).
        const freshCacheKey = generateId()
        const userEntry: UserEntry = {
            id: generateId(),
            sessionId,
            createdAt: now(),
            kind: 'user',
            content: [{ type: 'text', text: promptText }],
        }
        const seed: AssistantEntry = {
            id: generateId(),
            sessionId,
            createdAt: now(),
            kind: 'assistant',
            model: model.id,
            content: [],
            status: 'streaming',
            stopReason: 'pending',
        }

        try {
            const gen = client.stream(
                {
                    model,
                    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
                    entries: [userEntry],
                    tools: [],
                    reasoningEffort,
                    speed,
                    seed,
                },
                {
                    connectionMode: 'isolated',
                    promptCacheKey: freshCacheKey,
                    maxOutputTokens,
                    signal,
                },
            )

            const result = await collectStream(gen)

            if (signal.aborted) {
                throw new Error('Request was aborted')
            }
            assertSummaryAssistantOk(result, label)
            return result
        } catch (error) {
            lastError = error
            const canRetry =
                attempt < maxAttempts - 1 && isTransientSummaryError(error) && !signal.aborted
            if (!canRetry) {
                throw error instanceof Error ? error : new Error(String(error))
            }
            const delay = retryDelaysMs[attempt] ?? 0
            await sleep(delay, signal)
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function runCachedSummary(params: {
    client: ProtocolClient
    model: ModelCatalogEntry
    sessionId: string
    compactedEntries: readonly ConversationEntry[]
    keptStart: KeptStartInfo
    cachedContext: CachedCompactionContext
    customInstructions?: string
    reserveTokens: number
    reasoningEffort?: string
    baseReasoningEffort?: string
    speed?: string
    signal: AbortSignal
    now: () => number
    generateId: () => string
}): Promise<AssistantEntry> {
    const {
        client,
        model,
        sessionId,
        compactedEntries,
        keptStart,
        cachedContext,
        customInstructions,
        reserveTokens,
        reasoningEffort,
        baseReasoningEffort,
        speed,
        signal,
        now,
        generateId,
    } = params

    if (signal.aborted) {
        throw new Error('Request was aborted')
    }

    const promptText = buildCachedSummaryPrompt(keptStart, customInstructions)
    const instructionEntry: UserEntry = {
        id: generateId(),
        sessionId,
        createdAt: now(),
        kind: 'user',
        content: [{ type: 'text', text: promptText }],
    }

    const protocolEntries: ConversationEntry[] = compactedEntries.map(
        (entry) => {
            if (entry.kind !== 'toolResult') return deepCloneValue(entry)
            const cloned = deepCloneValue(entry)
            const { displayMetadata: _displayMetadata, ...rest } = cloned
            return rest
        },
    )
    protocolEntries.push(instructionEntry)

    const estimatedInputTokens = estimateCachedSummaryInputTokens(
        protocolEntries,
        cachedContext,
    )
    if (
        typeof model.contextWindow === 'number' &&
        Number.isFinite(model.contextWindow) &&
        model.contextWindow > 0
    ) {
        const minRequiredOutput = Math.min(
            typeof model.maxTokens === 'number' && model.maxTokens > 0
                ? Math.floor(model.maxTokens)
                : MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS,
            MIN_DYNAMIC_SUMMARY_OUTPUT_TOKENS,
        )
        if (
            Math.floor(model.contextWindow) - Math.ceil(estimatedInputTokens) <
            minRequiredOutput
        ) {
            throw new Error(
                'Cached summarization skipped: insufficient remaining context window for summary output',
            )
        }
    }
    const maxOutputTokens = summaryMaxTokens(
        reserveTokens,
        model,
        estimatedInputTokens,
    )

    const seed: AssistantEntry = {
        id: generateId(),
        sessionId,
        createdAt: now(),
        kind: 'assistant',
        model: model.id,
        content: [],
        status: 'streaming',
        stopReason: 'pending',
    }

    const disableTools = shouldDisableToolsForCachedSummary(
        model.id,
        cachedContext.tools,
        cachedContext.nativeTools,
    )

    const gen = client.stream(
        {
            model,
            systemPrompt: cachedContext.systemPrompt,
            developerPrompt: cachedContext.developerPrompt,
            entries: protocolEntries,
            tools: cachedContext.tools ? [...cachedContext.tools] : undefined,
            nativeTools: cachedContext.nativeTools
                ? [...cachedContext.nativeTools]
                : undefined,
            ...(disableTools ? { toolChoice: 'none' as const } : {}),
            reasoningEffort,
            baseReasoningEffort:
                cachedContext.baseReasoningEffort ??
                resolveSessionBaseReasoningEffort(
                    protocolEntries,
                    baseReasoningEffort,
                ),
            speed,
            seed,
        },
        {
            connectionMode: 'isolated',
            promptCacheKey: sessionId,
            maxOutputTokens,
            signal,
        },
    )

    const result = await collectStream(gen)
    if (signal.aborted) {
        throw new Error('Request was aborted')
    }
    assertSummaryAssistantOk(result, 'Cached summarization')
    return result
}

/**
 * Compact a conversation by summarizing discarded history into a single CompactionEntry.
 * On failure/abort the input entries array is never mutated; a new deep-cloned array is returned on success.
 */
export async function compactConversation(
    entries: readonly ConversationEntry[],
    options: CompactConversationOptions,
): Promise<CompactConversationResult> {
    const settings = normalizeCompactionSettings(options.settings)
    const preparation = prepareCompaction(entries, settings)
    if (!preparation) {
        throw new Error('Compaction not possible: nothing to summarize')
    }

    const now = options.now ?? (() => Date.now())
    const generateId = options.generateId ?? defaultId
    const signal = options.signal ?? new AbortController().signal
    const sleep = options.sleep ?? defaultSleep
    const retryDelaysMs = options.summaryRetryDelaysMs ?? SUMMARY_RETRY_DELAYS_MS

    const summaryReasoningEffort =
        options.fastContextCompaction === false
            ? options.reasoningEffort
            : resolveSummaryReasoningEffort(
                  options.model,
                  options.reasoningEffort,
              )

    let summaryText: string | undefined
    let usage: Usage | undefined

    const compactedEntries = buildCompactedContext(entries)
    const cachedPlan = canUseCachedCompaction(
        compactedEntries,
        preparation,
        options,
        now(),
    )

    if (cachedPlan) {
        try {
            const cachedEntry = await runCachedSummary({
                client: options.client,
                model: options.model,
                sessionId: options.sessionId,
                compactedEntries,
                keptStart: cachedPlan.keptStart,
                cachedContext: cachedPlan.cachedContext,
                customInstructions: options.customInstructions,
                reserveTokens: settings.reserveTokens,
                reasoningEffort: summaryReasoningEffort,
                baseReasoningEffort: options.reasoningEffort,
                speed: options.speed,
                signal,
                now,
                generateId,
            })
            const candidateText = stripFileOperationTags(
                extractAssistantText(cachedEntry),
            )
            validateSummaryStructure(candidateText)
            summaryText = candidateText
            usage = cachedEntry.usage
        } catch (error) {
            if (isAbortSummaryError(error, signal)) {
                throw error instanceof Error
                    ? error
                    : new Error(String(error))
            }
            // Any non-abort failure on cached path falls back cleanly to isolated compaction.
            summaryText = undefined
            usage = undefined
        }
    }

    if (summaryText === undefined) {
        if (preparation.isSplitTurn && preparation.turnPrefixEntries.length > 0) {
            const hasHistoryMessages = preparation.historyEntries.length > 0
            const hasPreviousSummary = Boolean(preparation.previousSummary)

            // History side: model call when there are messages (or previous summary update),
            // otherwise a deterministic structured "no prior history" checkpoint.
            // Prefix always uses an independent isolated call. Final merge is always
            // history + Turn Context (split turn).
            let historyResult: string
            let historyUsage: Usage | undefined

            if (hasHistoryMessages || hasPreviousSummary) {
                const historyPrompt = fitIsolatedPromptToContextWindow(
                    buildHistoryPromptText(
                        preparation.historyEntries,
                        preparation.previousSummary,
                        options.customInstructions,
                    ),
                    options.model,
                )
                const historyBudget = summaryMaxTokens(
                    settings.reserveTokens,
                    options.model,
                    estimateIsolatedPromptInputTokens(historyPrompt),
                )
                const historyEntry = await runIsolatedSummary({
                    client: options.client,
                    model: options.model,
                    sessionId: options.sessionId,
                    promptText: historyPrompt,
                    maxOutputTokens: historyBudget,
                    reasoningEffort: summaryReasoningEffort,
                    speed: options.speed,
                    signal,
                    now,
                    generateId,
                    sleep,
                    retryDelaysMs,
                    label: 'Summarization',
                })
                historyResult = extractAssistantText(historyEntry)
                validateSummaryStructure(historyResult)
                historyUsage = historyEntry.usage
            } else {
                historyResult = NO_PRIOR_HISTORY_SUMMARY
                historyUsage = undefined
            }

            const prefixPrompt = fitIsolatedPromptToContextWindow(
                buildTurnPrefixPromptText(preparation.turnPrefixEntries),
                options.model,
            )
            const prefixBudget = turnPrefixMaxTokens(
                settings.reserveTokens,
                options.model,
                estimateIsolatedPromptInputTokens(prefixPrompt),
            )
            const prefixEntry = await runIsolatedSummary({
                client: options.client,
                model: options.model,
                sessionId: options.sessionId,
                promptText: prefixPrompt,
                maxOutputTokens: prefixBudget,
                reasoningEffort: summaryReasoningEffort,
                speed: options.speed,
                signal,
                now,
                generateId,
                sleep,
                retryDelaysMs,
                label: 'Turn prefix summarization',
            })
            const prefixResult = extractAssistantText(prefixEntry)
            validateTurnPrefixStructure(prefixResult)

            summaryText = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixResult}`
            usage = mergeUsage(historyUsage, prefixEntry.usage)
        } else {
            const historyPrompt = fitIsolatedPromptToContextWindow(
                buildHistoryPromptText(
                    preparation.historyEntries,
                    preparation.previousSummary,
                    options.customInstructions,
                ),
                options.model,
            )
            const historyBudget = summaryMaxTokens(
                settings.reserveTokens,
                options.model,
                estimateIsolatedPromptInputTokens(historyPrompt),
            )
            const historyEntry = await runIsolatedSummary({
                client: options.client,
                model: options.model,
                sessionId: options.sessionId,
                promptText: historyPrompt,
                maxOutputTokens: historyBudget,
                reasoningEffort: summaryReasoningEffort,
                speed: options.speed,
                signal,
                now,
                generateId,
                sleep,
                retryDelaysMs,
                label: 'Summarization',
            })
            summaryText = extractAssistantText(historyEntry)
            validateSummaryStructure(summaryText)
            usage = historyEntry.usage
        }
    }

    // Sanitize model body before appending implementation-owned file list XML.
    summaryText = sanitizeSummaryBody(summaryText)
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps)
    summaryText += formatFileOperations(readFiles, modifiedFiles)

    const entry: CompactionEntry = {
        id: generateId(),
        sessionId: options.sessionId,
        createdAt: now(),
        kind: 'compaction',
        summary: summaryText,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        usage: usage ? deepCloneValue(usage) : undefined,
        readFiles: deepCloneValue(readFiles),
        modifiedFiles: deepCloneValue(modifiedFiles),
    }

    // Defensive deep clones so caller mutation cannot affect source / sibling results.
    const clonedEntries = cloneEntries(entries)
    const clonedEntry = deepCloneValue(entry)
    clonedEntries.push(clonedEntry)

    return {
        entry: clonedEntry,
        entries: clonedEntries,
    }
}

/**
 * Build the provider-facing context: latest CompactionEntry + retained tail.
 * Filters older compaction entries; defensive deep clones of every entry.
 */
export function buildCompactedContext(
    entries: readonly ConversationEntry[],
): ConversationEntry[] {
    let latestIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.kind === 'compaction') {
            latestIndex = i
            break
        }
    }

    if (latestIndex < 0) {
        return cloneEntries(entries)
    }

    const latest = entries[latestIndex] as CompactionEntry
    const firstKeptId = latest.firstKeptEntryId
    let firstKeptIndex = -1
    if (firstKeptId) {
        for (let i = latestIndex + 1; i < entries.length; i++) {
            if (entries[i]?.id === firstKeptId) {
                firstKeptIndex = i
                break
            }
        }
        // Also allow firstKept to be before the compaction marker (historical order).
        if (firstKeptIndex < 0) {
            for (let i = 0; i < entries.length; i++) {
                if (i === latestIndex) continue
                if (entries[i]?.id === firstKeptId) {
                    firstKeptIndex = i
                    break
                }
            }
        }
    }

    const tailStart = firstKeptIndex >= 0 ? firstKeptIndex : latestIndex + 1
    const result: ConversationEntry[] = [deepCloneValue(latest)]
    for (let i = tailStart; i < entries.length; i++) {
        const entry = entries[i]
        if (!entry) continue
        if (entry.kind === 'compaction') continue
        if (entry.id === latest.id) continue
        result.push(deepCloneValue(entry))
    }
    return result
}
