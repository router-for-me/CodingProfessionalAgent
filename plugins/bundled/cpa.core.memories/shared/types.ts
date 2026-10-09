export type SearchMatchMode = 'any' | 'all_on_same_line' | 'all_within_lines'

export interface SearchMemoriesRequest {
    queries: string[]
    matchMode?: SearchMatchMode
    lineCount?: number
    caseSensitive?: boolean
    normalized?: boolean
    cursor?: string
    maxResults?: number
}

export interface MemorySearchHit {
    id: number
    title: string
    matchedQueries: string[]
    snippet: string
}

export interface SearchMemoriesResponse {
    matches: MemorySearchHit[]
    nextCursor?: string
    truncated: boolean
}

export interface ReadMemoriesRequest {
    ids: number[]
    maxTokens?: number
}

export interface MemoryContentView {
    id: number
    title: string
    content: string
    truncated: boolean
}

export interface ReadMemoriesResponse {
    memories: MemoryContentView[]
    missingIds: number[]
}

export interface AddMemoryRequest {
    title: string
    note: string
}

export interface AddMemoryResponse {
    success: true
    id: number
}

export const DEFAULT_SEARCH_RESULTS = 20
export const MAX_SEARCH_RESULTS = 100
export const SNIPPET_MAX_CHARS = 120
export const MAX_READ_IDS = 20
export const DEFAULT_READ_MAX_TOKENS = 20000
export const MAX_TITLE_CHARS = 120
