/**
 * Context compaction: cut points, isolated CPA summarization, and rebuild.
 * Pure planning helpers plus an isolated summary call via CPAClient.stream.
 */

import type { ModelCatalogEntry } from '@/features/models/types'
import type { AssistantStreamEvent } from '../agent/types'

import type { ProtocolClient } from '@cpa/plugin-api'
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
 * Sanitize model summary body before appending file-list XML and persisting.
 */
export function sanitizeSummaryBody(text: string): string {
    return neutralizeSummaryTags(stripIllegalControls(text))
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

function summaryMaxTokens(reserveTokens: number, model: ModelCatalogEntry): number {
    const fromReserve = Math.floor(reserveTokens * 0.8)
    const modelMax =
        typeof model.maxTokens === 'number' &&
        Number.isFinite(model.maxTokens) &&
        model.maxTokens > 0
            ? Math.floor(model.maxTokens)
            : Number.POSITIVE_INFINITY
    return Math.min(fromReserve, modelMax)
}

function turnPrefixMaxTokens(reserveTokens: number, model: ModelCatalogEntry): number {
    const fromReserve = Math.floor(reserveTokens * 0.5)
    const modelMax =
        typeof model.maxTokens === 'number' &&
        Number.isFinite(model.maxTokens) &&
        model.maxTokens > 0
            ? Math.floor(model.maxTokens)
            : Number.POSITIVE_INFINITY
    return Math.min(fromReserve, modelMax)
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

    const historyBudget = summaryMaxTokens(settings.reserveTokens, options.model)
    const prefixBudget = turnPrefixMaxTokens(settings.reserveTokens, options.model)
    const summaryReasoningEffort =
        options.fastContextCompaction === false
            ? options.reasoningEffort
            : resolveSummaryReasoningEffort(
                  options.model,
                  options.reasoningEffort,
              )

    let summaryText: string
    let usage: Usage | undefined

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
            const historyPrompt = buildHistoryPromptText(
                preparation.historyEntries,
                preparation.previousSummary,
                options.customInstructions,
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

        const prefixPrompt = buildTurnPrefixPromptText(preparation.turnPrefixEntries)
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
        const historyPrompt = buildHistoryPromptText(
            preparation.historyEntries,
            preparation.previousSummary,
            options.customInstructions,
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
