export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 95
export const ESTIMATED_IMAGE_CHARS = 4800

export interface ContextUsageBreakdown {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    compactionWindow: number
    contextWindow: number
    percentUsed: number
    percentLabel: string
}

export function normalizeCompactionThresholdPercent(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_COMPACTION_THRESHOLD_PERCENT
    }
    const rounded = Math.round(value)
    if (rounded <= 0) {
        return DEFAULT_COMPACTION_THRESHOLD_PERCENT
    }
    return Math.min(100, Math.max(1, rounded))
}

export function thresholdRatioFromPercent(percent?: number): number {
    return normalizeCompactionThresholdPercent(percent) / 100
}

function safeJsonStringify(value: unknown): string {
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

function estimateTextAndImageBlocks(content: readonly any[]): number {
    let chars = 0
    for (const block of content) {
        if (!block) continue
        if (block.type === 'text' && typeof block.text === 'string') {
            chars += block.text.length
        } else if (block.type === 'image') {
            chars += ESTIMATED_IMAGE_CHARS
        }
    }
    return chars
}

export function estimateTokens(entry: any): number {
    if (!entry) return 0
    switch (entry.kind) {
        case 'user':
            return Math.ceil(estimateTextAndImageBlocks(entry.content || []) / 4)
        case 'assistant': {
            let chars = 0
            for (const block of entry.content || []) {
                if (!block) continue
                if (block.type === 'text' && typeof block.text === 'string') {
                    chars += block.text.length
                } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                    chars += block.thinking.length
                } else if (block.type === 'toolCall') {
                    chars += (block.name?.length || 0) + safeJsonStringify(block.arguments).length
                } else if (block.type === 'image') {
                    chars += ESTIMATED_IMAGE_CHARS
                }
            }
            return Math.ceil(chars / 4)
        }
        case 'toolResult':
            return Math.ceil(estimateTextAndImageBlocks(entry.content || []) / 4)
        case 'compaction':
            return Math.ceil((entry.summary?.length || 0) / 4)
        default:
            return 0
    }
}

export function estimateContextTokens(entries: readonly any[]): {
    tokens: number
    usage: number
    trailing: number
    index: number | null
} {
    let latestCompactionIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.kind === 'compaction') {
            latestCompactionIndex = i
            break
        }
    }

    const searchStart = latestCompactionIndex >= 0 ? latestCompactionIndex + 1 : 0
    let lastUsageIndex: number | null = null
    let lastUsage: any = undefined

    for (let i = entries.length - 1; i >= searchStart; i--) {
        const entry = entries[i]
        if (entry?.kind === 'assistant' && entry.usage) {
            lastUsageIndex = i
            lastUsage = entry.usage
            break
        }
    }

    if (lastUsageIndex === null || !lastUsage) {
        let estimated = 0
        const start = searchStart
        for (let i = start; i < entries.length; i++) {
            const entry = entries[i]
            if (entry) estimated += estimateTokens(entry)
        }
        return {
            tokens: estimated,
            usage: 0,
            trailing: estimated,
            index: null,
        }
    }

    const usageTokens =
        typeof lastUsage.totalTokens === 'number' && lastUsage.totalTokens > 0
            ? lastUsage.totalTokens
            : (lastUsage.input || 0) +
              (lastUsage.output || 0) +
              (lastUsage.cacheRead || 0) +
              (lastUsage.cacheWrite || 0)

    let trailingTokens = 0
    for (let i = lastUsageIndex + 1; i < entries.length; i++) {
        const e = entries[i]
        if (e) trailingTokens += estimateTokens(e)
    }

    return {
        tokens: usageTokens + trailingTokens,
        usage: usageTokens,
        trailing: trailingTokens,
        index: lastUsageIndex,
    }
}

export function computeContextUsageBreakdown(
    entries: readonly any[],
    contextWindow: number,
    compactionThresholdPercent: number = DEFAULT_COMPACTION_THRESHOLD_PERCENT,
): ContextUsageBreakdown {
    const safeContextWindow = Math.max(1, contextWindow || DEFAULT_CONTEXT_WINDOW)
    const thresholdRatio = thresholdRatioFromPercent(compactionThresholdPercent)
    const compactionWindow = Math.round(safeContextWindow * thresholdRatio)

    let latestCompactionIndex = -1
    for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.kind === 'compaction') {
            latestCompactionIndex = i
            break
        }
    }

    const searchStart = latestCompactionIndex >= 0 ? latestCompactionIndex + 1 : 0
    let lastAssistantIndex: number | null = null
    let lastAssistantUsage: any = undefined

    for (let i = entries.length - 1; i >= searchStart; i--) {
        const entry = entries[i]
        if (entry?.kind === 'assistant' && entry.usage) {
            lastAssistantIndex = i
            lastAssistantUsage = entry.usage
            break
        }
    }

    let totalTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0

    if (lastAssistantIndex !== null && lastAssistantUsage) {
        const baseInput = typeof lastAssistantUsage.input === 'number' ? lastAssistantUsage.input : 0
        const baseOutput = typeof lastAssistantUsage.output === 'number' ? lastAssistantUsage.output : 0
        const baseCacheRead = typeof lastAssistantUsage.cacheRead === 'number' ? lastAssistantUsage.cacheRead : 0
        const baseCacheWrite = typeof lastAssistantUsage.cacheWrite === 'number' ? lastAssistantUsage.cacheWrite : 0
        const baseTotal =
            typeof lastAssistantUsage.totalTokens === 'number' && lastAssistantUsage.totalTokens > 0
                ? lastAssistantUsage.totalTokens
                : baseInput + baseOutput + baseCacheRead + baseCacheWrite

        let trailingTokens = 0
        for (let i = lastAssistantIndex + 1; i < entries.length; i++) {
            const e = entries[i]
            if (e) trailingTokens += estimateTokens(e)
        }

        inputTokens = baseInput + trailingTokens
        outputTokens = baseOutput
        cacheReadTokens = baseCacheRead
        cacheWriteTokens = baseCacheWrite
        totalTokens = baseTotal + trailingTokens
    } else {
        const estimate = estimateContextTokens(entries)
        totalTokens = estimate.tokens
        inputTokens = estimate.tokens
        outputTokens = 0
        cacheReadTokens = 0
        cacheWriteTokens = 0
    }

    const ratio = totalTokens / safeContextWindow
    const percentUsed = Math.min(100, Math.max(0, ratio * 100))
    let percentLabel = `${Math.round(percentUsed)}%`
    if (totalTokens === 0) {
        percentLabel = '0%'
    } else if (percentUsed > 0 && percentUsed < 1) {
        percentLabel = '<1%'
    }

    return {
        totalTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        compactionWindow,
        contextWindow: safeContextWindow,
        percentUsed,
        percentLabel,
    }
}
