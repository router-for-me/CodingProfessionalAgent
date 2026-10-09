import { SNIPPET_MAX_CHARS, type SearchMatchMode } from './types.js'

/**
 * Split content into lines matching Rust `str.lines()` semantics:
 * - Empty string results in 0 lines ([]).
 * - Trailing newline (\n or \r\n) does not create an extra trailing empty line.
 * - Handles both CRLF (\r\n) and LF (\n).
 */
export function splitLines(content: string): string[] {
    if (content.length === 0) {
        return []
    }
    let text = content
    if (text.endsWith('\r\n')) {
        text = text.slice(0, -2)
    } else if (text.endsWith('\n')) {
        text = text.slice(0, -1)
    }
    if (text.length === 0) {
        return ['']
    }
    return text.split(/\r?\n/)
}

class SearchComparison {
    constructor(
        public caseSensitive: boolean,
        public normalized: boolean,
    ) {}

    prepare(value: string): string {
        let val = value
        if (!this.caseSensitive) {
            val = val.toLowerCase()
        }
        if (this.normalized) {
            val = val.replace(/[^\p{L}\p{N}]/gu, '')
        }
        return val
    }
}

export class SearchMatcher {
    comparison: SearchComparison
    preparedQueries: string[]

    constructor(
        public queries: string[],
        public matchMode: SearchMatchMode,
        caseSensitive: boolean,
        normalized: boolean,
        public lineCount?: number,
    ) {
        this.comparison = new SearchComparison(caseSensitive, normalized)
        this.preparedQueries = queries.map((q) => this.comparison.prepare(q))
        if (this.preparedQueries.some((q) => q.length === 0)) {
            throw new Error('queries must not be empty or contain empty strings')
        }
    }

    matchedQueryFlags(line: string): boolean[] {
        const preparedLine = this.comparison.prepare(line)
        return this.preparedQueries.map((q) => preparedLine.includes(q))
    }

    matchedQueries(flags: boolean[]): string[] {
        return this.queries.filter((_, idx) => flags[idx])
    }
}

export function matchMemoryContent(
    content: string,
    matcher: SearchMatcher,
): { matchedQueries: string[]; firstMatchLine: string } | null {
    const lines = splitLines(content)
    if (lines.length === 0) {
        return null
    }
    const lineMatches = lines.map((line) => matcher.matchedQueryFlags(line))
    const matchedFlags = new Array<boolean>(matcher.queries.length).fill(false)
    let firstMatchIndex: number | undefined

    function collectMatch(index: number, flags: boolean[]): void {
        firstMatchIndex ??= index
        for (let q = 0; q < flags.length; q++) {
            matchedFlags[q] = matchedFlags[q] || flags[q]
        }
    }

    if (matcher.matchMode === 'any') {
        for (let idx = 0; idx < lines.length; idx++) {
            const flags = lineMatches[idx]
            if (flags.some(Boolean)) {
                collectMatch(idx, flags)
            }
        }
    } else if (matcher.matchMode === 'all_on_same_line') {
        for (let idx = 0; idx < lines.length; idx++) {
            const flags = lineMatches[idx]
            if (flags.every(Boolean)) {
                collectMatch(idx, flags)
            }
        }
    } else if (matcher.matchMode === 'all_within_lines') {
        const lineCount = matcher.lineCount ?? 1
        interface WindowMatch {
            startIndex: number
            endIndex: number
            flags: boolean[]
        }
        const windows: WindowMatch[] = []
        for (let startIndex = 0; startIndex < lines.length; startIndex++) {
            if (!lineMatches[startIndex].some(Boolean)) {
                continue
            }
            const lastAllowedIndex = Math.min(startIndex + lineCount - 1, lines.length - 1)
            const accumulatedFlags = new Array(matcher.queries.length).fill(false)
            for (let endIndex = startIndex; endIndex <= lastAllowedIndex; endIndex++) {
                const lineFlags = lineMatches[endIndex]
                for (let q = 0; q < matcher.queries.length; q++) {
                    accumulatedFlags[q] = accumulatedFlags[q] || lineFlags[q]
                }
                if (accumulatedFlags.every(Boolean)) {
                    windows.push({ startIndex, endIndex, flags: [...accumulatedFlags] })
                    break
                }
            }
        }

        for (let i = 0; i < windows.length; i++) {
            const current = windows[i]
            const strictlyContainsAnother = windows.some((other, j) => {
                if (i === j) return false
                return (
                    current.startIndex <= other.startIndex &&
                    current.endIndex >= other.endIndex &&
                    (current.startIndex !== other.startIndex || current.endIndex !== other.endIndex)
                )
            })
            if (strictlyContainsAnother) {
                continue
            }
            collectMatch(current.startIndex, current.flags)
        }
    }

    if (firstMatchIndex === undefined) {
        return null
    }
    return { matchedQueries: matcher.matchedQueries(matchedFlags), firstMatchLine: lines[firstMatchIndex] }
}

export function buildSnippet(line: string): string {
    const trimmed = line.trim()
    const characters = Array.from(trimmed)
    return characters.length > SNIPPET_MAX_CHARS ? characters.slice(0, SNIPPET_MAX_CHARS).join('') + '…' : trimmed
}
