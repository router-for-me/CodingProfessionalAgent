import { SearchMatcher } from './memorySearch.js'
import {
    DEFAULT_READ_MAX_TOKENS,
    DEFAULT_SEARCH_RESULTS,
    MAX_READ_IDS,
    MAX_SEARCH_RESULTS,
    MAX_TITLE_CHARS,
    type AddMemoryRequest,
    type ReadMemoriesRequest,
    type SearchMemoriesRequest,
} from './types.js'

function validateRequestObject(req: unknown): void {
    if (req === null || typeof req !== 'object' || Array.isArray(req)) {
        throw new Error('request must be an object')
    }
}

export function validateSearchRequest(
    req: SearchMemoriesRequest,
): Required<Pick<SearchMemoriesRequest, 'queries' | 'matchMode' | 'caseSensitive' | 'normalized'>> & {
    lineCount?: number
    startIndex: number
    maxResults: number
} {
    validateRequestObject(req)
    if (!Array.isArray(req.queries) || req.queries.length === 0 || req.queries.some((q) => typeof q !== 'string')) {
        throw new Error('queries must not be empty or contain empty strings')
    }
    const queries = req.queries.map((q) => q.trim())
    if (queries.some((q) => q.length === 0)) {
        throw new Error('queries must not be empty or contain empty strings')
    }

    const matchMode = req.matchMode === undefined ? 'any' : req.matchMode
    if (matchMode !== 'any' && matchMode !== 'all_on_same_line' && matchMode !== 'all_within_lines') {
        throw new Error("match_mode must be one of 'any', 'all_on_same_line', 'all_within_lines'")
    }
    if (
        matchMode === 'all_within_lines' &&
        (typeof req.lineCount !== 'number' || !Number.isInteger(req.lineCount) || req.lineCount <= 0)
    ) {
        throw new Error('all_within_lines.line_count must be a positive integer')
    }

    const caseSensitive = req.caseSensitive ?? false
    const normalized = req.normalized ?? false
    // Use the matcher's preparation to reject queries that normalize to empty.
    new SearchMatcher(queries, matchMode, caseSensitive, normalized, req.lineCount)

    let maxResults = DEFAULT_SEARCH_RESULTS
    if (req.maxResults !== undefined) {
        if (typeof req.maxResults !== 'number' || !Number.isFinite(req.maxResults) || Math.floor(req.maxResults) < 1) {
            throw new Error('max_results must be a positive integer')
        }
        maxResults = Math.min(Math.floor(req.maxResults), MAX_SEARCH_RESULTS)
    }

    let startIndex = 0
    if (req.cursor !== undefined && req.cursor !== null && req.cursor !== '') {
        const parsed = Number(req.cursor)
        if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error(`cursor '${req.cursor}' must be a non-negative integer`)
        }
        startIndex = parsed
    }

    return { queries, matchMode, caseSensitive, normalized, lineCount: req.lineCount, startIndex, maxResults }
}

export function validateReadRequest(req: ReadMemoriesRequest): { ids: number[]; maxTokens: number } {
    validateRequestObject(req)
    if (!Array.isArray(req.ids) || req.ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error('ids is required and must be an array of 1 to 20 positive integers')
    }
    const ids = [...new Set(req.ids)]
    if (ids.length === 0 || ids.length > MAX_READ_IDS) {
        throw new Error('ids is required and must be an array of 1 to 20 positive integers')
    }
    const maxTokens =
        typeof req.maxTokens === 'number' && Number.isFinite(req.maxTokens) && req.maxTokens > 0
            ? Math.floor(req.maxTokens)
            : DEFAULT_READ_MAX_TOKENS
    return { ids, maxTokens }
}

export function validateAddRequest(req: AddMemoryRequest): { title: string; note: string } {
    validateRequestObject(req)
    if (
        typeof req.title !== 'string' ||
        !req.title.trim() ||
        /[\r\n]/.test(req.title) ||
        req.title.trim().length > MAX_TITLE_CHARS
    ) {
        throw new Error('title must be non-empty, single-line and at most 120 characters')
    }
    if (typeof req.note !== 'string' || !req.note.trim()) {
        throw new Error('note must not be empty')
    }
    return { title: req.title.trim(), note: req.note }
}
