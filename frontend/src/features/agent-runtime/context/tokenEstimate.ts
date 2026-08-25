/**
 * Token budgeting helpers for context compaction decisions.
 * Conservative char/4 estimates; real assistant usage is preferred as a baseline.
 */

import type {
    AssistantEntry,
    CompactionEntry,
    ContentBlock,
    ConversationEntry,
    ToolResultContentBlock,
    ToolResultEntry,
    Usage,
    UserEntry,
} from '../session/types'

/** Fallback when model.contextWindow is missing/invalid. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Fixed image character weight for estimation (matches Pi). */
export const ESTIMATED_IMAGE_CHARS = 4800

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 95
export const MIN_COMPACTION_THRESHOLD_PERCENT = 1
export const MAX_COMPACTION_THRESHOLD_PERCENT = 100

export const DEFAULT_COMPACTION_SETTINGS = {
    enabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    thresholdRatio: DEFAULT_COMPACTION_THRESHOLD_PERCENT / 100,
} as const

export interface CompactionSettings {
    enabled: boolean
    reserveTokens: number
    keepRecentTokens: number
    /** Trigger when estimated tokens exceed contextWindow * thresholdRatio. */
    thresholdRatio: number
}

export interface ContextTokenEstimate {
    /** usage baseline + trailing estimate. */
    tokens: number
    /** Trusted assistant usage total, or 0 when none. */
    usage: number
    /** Estimated tokens after the usage baseline entry. */
    trailing: number
    /** Index of the usage baseline entry within the provided array, or null. */
    index: number | null
}

/**
 * Clamp a user-facing percent (50-100) used as the auto-compaction trigger.
 */
export function normalizeCompactionThresholdPercent(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_COMPACTION_THRESHOLD_PERCENT
    }
    const rounded = Math.round(value)
    if (rounded <= 0) {
        return DEFAULT_COMPACTION_THRESHOLD_PERCENT
    }
    return Math.min(
        MAX_COMPACTION_THRESHOLD_PERCENT,
        Math.max(MIN_COMPACTION_THRESHOLD_PERCENT, rounded),
    )
}

export function thresholdRatioFromPercent(percent?: number): number {
    return normalizeCompactionThresholdPercent(percent) / 100
}

function normalizeThresholdRatio(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_COMPACTION_SETTINGS.thresholdRatio
    }
    if (value > 1 && value <= MAX_COMPACTION_THRESHOLD_PERCENT) {
        return thresholdRatioFromPercent(value)
    }
    if (value <= 0 || value > 1) {
        return DEFAULT_COMPACTION_SETTINGS.thresholdRatio
    }
    return value
}

/**
 * Normalize compaction settings: disabled stays disabled; non-positive budgets fall back.
 */
export function normalizeCompactionSettings(
    settings?: Partial<CompactionSettings> | null,
): CompactionSettings {
    const enabled = settings?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled
    const reserveTokens =
        typeof settings?.reserveTokens === 'number' &&
        Number.isFinite(settings.reserveTokens) &&
        settings.reserveTokens > 0
            ? Math.floor(settings.reserveTokens)
            : DEFAULT_COMPACTION_SETTINGS.reserveTokens
    const keepRecentTokens =
        typeof settings?.keepRecentTokens === 'number' &&
        Number.isFinite(settings.keepRecentTokens) &&
        settings.keepRecentTokens > 0
            ? Math.floor(settings.keepRecentTokens)
            : DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
    return {
        enabled,
        reserveTokens,
        keepRecentTokens,
        thresholdRatio: normalizeThresholdRatio(settings?.thresholdRatio),
    }
}

export function compactionSettingsFromThresholdPercent(
    percent?: number,
    extras?: Partial<CompactionSettings> | null,
): CompactionSettings {
    return normalizeCompactionSettings({
        ...(extras ?? {}),
        thresholdRatio: thresholdRatioFromPercent(percent),
    })
}

/**
 * Resolve a positive finite context window or fall back to 128000.
 */
export function resolveContextWindow(contextWindow?: number | null): number {
    if (
        typeof contextWindow === 'number' &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0
    ) {
        return Math.floor(contextWindow)
    }
    return DEFAULT_CONTEXT_WINDOW
}

/**
 * Safe JSON serialization for tool arguments.
 * Cyclic structures and BigInt must not throw; produce a deterministic fallback.
 */
export function safeJsonStringify(value: unknown): string {
    const seen = new WeakSet<object>()
    try {
        const result = JSON.stringify(value, (_key, current: unknown) => {
            if (typeof current === 'bigint') {
                return `${current.toString()}n`
            }
            if (typeof current === 'symbol') {
                return current.toString()
            }
            if (typeof current === 'function') {
                return undefined
            }
            if (typeof current === 'object' && current !== null) {
                if (seen.has(current)) {
                    return '[Circular]'
                }
                seen.add(current)
            }
            return current
        })
        return result === undefined ? 'null' : result
    } catch {
        return '"[Unserializable]"'
    }
}

function estimateTextAndImageBlocks(
    content: readonly (ContentBlock | ToolResultContentBlock)[],
): number {
    let chars = 0
    for (const block of content) {
        if (block.type === 'text') {
            chars += block.text.length
        } else if (block.type === 'image') {
            chars += ESTIMATED_IMAGE_CHARS
        }
    }
    return chars
}

function estimateUserTokens(entry: UserEntry): number {
    return Math.ceil(estimateTextAndImageBlocks(entry.content) / 4)
}

function estimateAssistantTokens(entry: AssistantEntry): number {
    let chars = 0
    for (const block of entry.content) {
        if (block.type === 'text') {
            chars += block.text.length
        } else if (block.type === 'thinking') {
            chars += block.thinking.length
        } else if (block.type === 'toolCall') {
            chars += block.name.length + safeJsonStringify(block.arguments).length
        } else if (block.type === 'image') {
            chars += ESTIMATED_IMAGE_CHARS
        }
    }
    return Math.ceil(chars / 4)
}

function estimateToolResultTokens(entry: ToolResultEntry): number {
    return Math.ceil(estimateTextAndImageBlocks(entry.content) / 4)
}

function estimateCompactionTokens(entry: CompactionEntry): number {
    return Math.ceil(entry.summary.length / 4)
}

/**
 * Estimate tokens for a single conversation entry using ceil(chars / 4).
 */
export function estimateTokens(entry: ConversationEntry): number {
    switch (entry.kind) {
        case 'user':
            return estimateUserTokens(entry)
        case 'assistant':
            return estimateAssistantTokens(entry)
        case 'toolResult':
            return estimateToolResultTokens(entry)
        case 'compaction':
            return estimateCompactionTokens(entry)
        default: {
            const _exhaustive: never = entry
            void _exhaustive
            return 0
        }
    }
}

/**
 * Total context tokens from a trusted Usage object.
 * Prefers totalTokens when positive and finite; otherwise sums components.
 */
export function calculateContextTokens(usage: Usage): number {
    if (
        typeof usage.totalTokens === 'number' &&
        Number.isFinite(usage.totalTokens) &&
        usage.totalTokens > 0
    ) {
        return usage.totalTokens
    }
    const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    let sum = 0
    for (const part of parts) {
        if (typeof part === 'number' && Number.isFinite(part) && part >= 0) {
            sum += part
        }
    }
    return sum
}

/**
 * Whether an assistant entry may provide a trusted usage baseline.
 * Only done assistants with finite totalTokens > 0 are trusted.
 * totalTokens === 0 is untrusted even when component fields are non-zero.
 */
export function isTrustedAssistantUsage(entry: AssistantEntry): boolean {
    if (entry.status !== 'done') return false
    if (
        entry.stopReason === 'error' ||
        entry.stopReason === 'aborted' ||
        entry.stopReason === 'pending'
    ) {
        return false
    }
    if (entry.errorMessage) return false
    const usage = entry.usage
    if (!usage) return false
    // Only totalTokens is authoritative for the compaction baseline.
    return (
        typeof usage.totalTokens === 'number' &&
        Number.isFinite(usage.totalTokens) &&
        usage.totalTokens > 0
    )
}

/**
 * Build the estimation view when no post-compaction assistant usage exists:
 * latest CompactionEntry summary + non-compaction retained tail (firstKeptId → end).
 */
function buildEstimationView(
    entries: readonly ConversationEntry[],
    latestCompactionIndex: number,
): ConversationEntry[] {
    if (latestCompactionIndex < 0) {
        return entries as ConversationEntry[]
    }
    const latest = entries[latestCompactionIndex] as CompactionEntry
    const result: ConversationEntry[] = [latest]
    let firstKeptIndex = -1
    if (latest.firstKeptEntryId) {
        for (let i = 0; i < entries.length; i++) {
            if (i === latestCompactionIndex) continue
            if (entries[i]?.id === latest.firstKeptEntryId) {
                firstKeptIndex = i
                break
            }
        }
    }
    const tailStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1
    for (let i = tailStart; i < entries.length; i++) {
        const entry = entries[i]
        if (!entry || entry.kind === 'compaction') continue
        if (entry.id === latest.id) continue
        result.push(entry)
    }
    return result
}

/**
 * Estimate context size.
 * After the latest compaction marker, only trust done assistants whose original
 * index is strictly after that marker and whose usage.totalTokens is finite > 0.
 * That usage already represents the compacted context; only trailing entries are estimated.
 * When no such assistant exists, fully estimate [latest summary + retained tail].
 * With no compaction, behaves as a normal baseline-or-full estimate over all entries.
 */
export function estimateContextTokens(
    entries: readonly ConversationEntry[],
): ContextTokenEstimate {
    let latestCompactionIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.kind === 'compaction') {
            latestCompactionIndex = i
            break
        }
    }

    const searchStart = latestCompactionIndex >= 0 ? latestCompactionIndex + 1 : 0
    let lastUsageIndex: number | null = null
    let lastUsage: Usage | undefined

    for (let i = entries.length - 1; i >= searchStart; i--) {
        const entry = entries[i]
        if (entry?.kind === 'assistant' && isTrustedAssistantUsage(entry) && entry.usage) {
            lastUsageIndex = i
            lastUsage = entry.usage
            break
        }
    }

    if (lastUsageIndex === null || !lastUsage) {
        const view = buildEstimationView(entries, latestCompactionIndex)
        let estimated = 0
        for (const entry of view) {
            estimated += estimateTokens(entry)
        }
        return {
            tokens: estimated,
            usage: 0,
            trailing: estimated,
            index: null,
        }
    }

    // Trusted totalTokens already covers the compacted context at that assistant.
    const usageTokens = lastUsage.totalTokens
    let trailingTokens = 0
    for (let i = lastUsageIndex + 1; i < entries.length; i++) {
        trailingTokens += estimateTokens(entries[i]!)
    }

    return {
        tokens: usageTokens + trailingTokens,
        usage: usageTokens,
        trailing: trailingTokens,
        index: lastUsageIndex,
    }
}

/**
 * Trigger when contextTokens strictly exceeds contextWindow * thresholdRatio.
 * Invalid/missing contextWindow falls back to 128000. Disabled settings never trigger.
 */
export function shouldCompact(
    contextTokens: number,
    contextWindow: number | null | undefined,
    settings?: Partial<CompactionSettings> | null,
): boolean {
    const normalized = normalizeCompactionSettings(settings)
    if (!normalized.enabled) return false
    if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) {
        return false
    }
    const window = resolveContextWindow(contextWindow)
    return contextTokens > window * normalized.thresholdRatio
}
