/**
 * Types and interfaces for the Memories plugin.
 */

export type MemoryEntryType = 'file' | 'directory'

export interface MemoryEntry {
    path: string
    entryType: MemoryEntryType
}

export interface ListMemoriesRequest {
    path?: string
    cursor?: string
    maxResults?: number
}

export interface ListMemoriesResponse {
    path?: string
    entries: MemoryEntry[]
    nextCursor?: string
    truncated: boolean
}

export interface ReadMemoryRequest {
    path: string
    lineOffset?: number
    maxLines?: number
    maxTokens?: number
}

export interface ReadMemoryResponse {
    path: string
    startLineNumber: number
    content: string
    truncated: boolean
}

export type SearchMatchMode = 'any' | 'all_on_same_line' | 'all_within_lines'

export interface SearchMemoriesRequest {
    queries: string[]
    path?: string
    matchMode?: SearchMatchMode
    lineCount?: number
    contextLines?: number
    caseSensitive?: boolean
    normalized?: boolean
    cursor?: string
    maxResults?: number
}

export interface MemorySearchMatch {
    path: string
    matchLineNumber: number
    contentStartLineNumber: number
    content: string
    matchedQueries: string[]
}

export interface SearchMemoriesResponse {
    queries: string[]
    matchMode: SearchMatchMode
    path?: string
    matches: MemorySearchMatch[]
    nextCursor?: string
    truncated: boolean
}

export interface AddAdHocNoteRequest {
    filename: string
    note: string
}

export interface AddAdHocNoteResponse {
    success: boolean
    path: string
}

export const MAX_LIST_RESULTS = 2000
export const MAX_SEARCH_RESULTS = 200
export const DEFAULT_READ_MAX_TOKENS = 20000
export const MEMORY_TOOL_DEVELOPER_INSTRUCTIONS_SUMMARY_TOKEN_LIMIT = 2500
