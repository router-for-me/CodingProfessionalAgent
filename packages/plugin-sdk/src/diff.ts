/**
 * Neutral diff utilities for browser and node runtimes.
 */

import * as Diff from 'diff'

export function normalizeToLF(text: string): string {
    if (typeof text !== 'string') return ''
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

const LINE_DIFF_CACHE_MAX = 2000
const lineDiffCache = new Map<string, { additions: number; deletions: number; addedLines: number; removedLines: number }>()

export function computeLineDiffStats(
    oldText: string,
    newText: string,
): { additions: number; deletions: number; addedLines: number; removedLines: number } {
    if (oldText === newText) {
        return { additions: 0, deletions: 0, addedLines: 0, removedLines: 0 }
    }

    const normOld = normalizeToLF(oldText)
    const normNew = normalizeToLF(newText)

    if (normOld === normNew) {
        return { additions: 0, deletions: 0, addedLines: 0, removedLines: 0 }
    }

    const cacheKey = `${normOld.length}:${normNew.length}:${normOld}\0${normNew}`
    if (cacheKey.length < 200_000) {
        const cached = lineDiffCache.get(cacheKey)
        if (cached) {
            return cached
        }
    }

    const changes = Diff.diffLines(normOld, normNew)
    let additions = 0
    let deletions = 0

    for (const change of changes) {
        if (change.added) {
            additions += change.count ?? change.value.split('\n').filter(Boolean).length
        } else if (change.removed) {
            deletions += change.count ?? change.value.split('\n').filter(Boolean).length
        }
    }

    const result = {
        additions,
        deletions,
        addedLines: additions,
        removedLines: deletions,
    }

    if (cacheKey.length < 200_000) {
        if (lineDiffCache.size >= LINE_DIFF_CACHE_MAX) {
            const firstKey = lineDiffCache.keys().next().value
            if (firstKey !== undefined) {
                lineDiffCache.delete(firstKey)
            }
        }
        lineDiffCache.set(cacheKey, result)
    }

    return result
}
