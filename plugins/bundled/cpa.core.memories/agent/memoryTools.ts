/**
 * Dedicated agent tool contributions for local memories plugin.
 * Implements memories_list, memories_read, memories_search, and memories_add_ad_hoc_note.
 */

import type { AgentToolContribution } from '@cpa/plugin-api'
import {
    LocalMemoriesBackend,
    type MemoriesBridge,
} from './localMemoriesBackend'
import type {
    AddAdHocNoteRequest,
    ListMemoriesRequest,
    ReadMemoryRequest,
    SearchMatchMode,
    SearchMemoriesRequest,
} from './types'

export const MEMORIES_LIST_TOOL_NAME = 'memories_list'
export const MEMORIES_READ_TOOL_NAME = 'memories_read'
export const MEMORIES_SEARCH_TOOL_NAME = 'memories_search'
export const MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME = 'memories_add_ad_hoc_note'

export const MEMORIES_LIST_DESCRIPTION =
    'List memory files and directories within the memory store.'

export const MEMORIES_READ_DESCRIPTION =
    'Read content from a memory file within the memory store.'

export const MEMORIES_SEARCH_DESCRIPTION =
    'Search across memory files within the memory store.'

export const MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION =
    'Add an ad-hoc memory note into extensions/ad_hoc/notes/. Call to record completed task summaries, learned user preferences, project conventions, or when explicitly requested by user.'

export const MEMORIES_LIST_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Relative path within the memories directory to list.',
        },
        cursor: {
            type: 'string',
            description: 'Pagination cursor for fetching the next page.',
        },
        max_results: {
            type: 'number',
            description: 'Maximum number of results to return (up to 2000).',
        },
    },
}

export const MEMORIES_READ_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: 'Relative path to the memory file to read.',
        },
        line_offset: {
            type: 'number',
            description: 'Starting line number (1-based, default 1).',
        },
        max_lines: {
            type: 'number',
            description: 'Maximum number of lines to read.',
        },
        max_tokens: {
            type: 'number',
            description:
                'Maximum number of tokens before truncation (default 20000).',
        },
    },
    required: ['path'],
}

export const MEMORIES_SEARCH_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        queries: {
            type: 'array',
            items: {
                type: 'string',
            },
            description: 'Keywords to search for.',
        },
        path: {
            type: 'string',
            description: 'Optional subpath to scope the search.',
        },
        match_mode: {
            type: 'string',
            enum: ['any', 'all_on_same_line', 'all_within_lines'],
            description: 'Match strategy.',
        },
        line_count: {
            type: 'number',
            description: 'Window line count when match_mode is all_within_lines.',
        },
        context_lines: {
            type: 'number',
            description: 'Number of surrounding context lines to include.',
        },
        case_sensitive: {
            type: 'boolean',
            description: 'Whether matching is case-sensitive.',
        },
        normalized: {
            type: 'boolean',
            description:
                'Whether to normalize text by stripping non-alphanumeric characters.',
        },
        cursor: {
            type: 'string',
            description: 'Pagination cursor.',
        },
        max_results: {
            type: 'number',
            description: 'Maximum results to return (up to 200).',
        },
    },
    required: ['queries'],
}

export const MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        filename: {
            type: 'string',
            description:
                'Note filename matching YYYY-MM-DDTHH-MM-SS-<slug>.md',
        },
        note: {
            type: 'string',
            description: 'Markdown text content of the note.',
        },
    },
    required: ['filename', 'note'],
}

export interface CreateMemoryToolsOptions {
    backend?: LocalMemoriesBackend
    rootDir?: string
    memoryRoot?: string
    bridge?: MemoriesBridge
}

/**
 * Helper to safely extract backend instance from options.
 */
function resolveBackend(options?: CreateMemoryToolsOptions): LocalMemoriesBackend {
    if (options?.backend) {
        return options.backend
    }
    return new LocalMemoriesBackend({
        memoryRoot: options?.rootDir ?? options?.memoryRoot,
        bridge: options?.bridge,
    })
}

/**
 * Format error caught during tool execution into safe message string for agent loop.
 */
function formatToolError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    return `Error: ${message}`
}

/**
 * Creates the 4 memory tools for agent interaction matching CPA specification.
 */
export function createMemoryTools(
    options?: CreateMemoryToolsOptions
): AgentToolContribution[] {
    const backend = resolveBackend(options)

    const memoriesListTool: AgentToolContribution = {
        name: MEMORIES_LIST_TOOL_NAME,
        description: MEMORIES_LIST_DESCRIPTION,
        parameters: MEMORIES_LIST_PARAMETERS,
        execute: async (args: Record<string, unknown>) => {
            try {
                if (args.path !== undefined && typeof args.path !== 'string') {
                    throw new Error('path must be a string')
                }
                let cursor: string | undefined
                if (args.cursor !== undefined && args.cursor !== null) {
                    if (
                        typeof args.cursor !== 'string' &&
                        typeof args.cursor !== 'number'
                    ) {
                        throw new Error('cursor must be a string')
                    }
                    cursor = String(args.cursor)
                }

                let maxResults: number | undefined
                const rawMaxResults = args.max_results ?? args.maxResults
                if (rawMaxResults !== undefined) {
                    if (typeof rawMaxResults !== 'number') {
                        throw new Error('max_results must be a number')
                    }
                    maxResults = rawMaxResults
                }

                const request: ListMemoriesRequest = {
                    path: args.path as string | undefined,
                    cursor,
                    maxResults,
                }

                return await backend.listMemories(request)
            } catch (err) {
                return formatToolError(err)
            }
        },
    }

    const memoriesReadTool: AgentToolContribution = {
        name: MEMORIES_READ_TOOL_NAME,
        description: MEMORIES_READ_DESCRIPTION,
        parameters: MEMORIES_READ_PARAMETERS,
        execute: async (args: Record<string, unknown>) => {
            try {
                if (
                    typeof args.path !== 'string' ||
                    args.path.trim().length === 0
                ) {
                    throw new Error(
                        'path is required and must be a non-empty string'
                    )
                }

                let lineOffset: number | undefined
                const rawLineOffset = args.line_offset ?? args.lineOffset
                if (rawLineOffset !== undefined) {
                    if (typeof rawLineOffset !== 'number') {
                        throw new Error('line_offset must be a number')
                    }
                    lineOffset = rawLineOffset
                }

                let maxLines: number | undefined
                const rawMaxLines = args.max_lines ?? args.maxLines
                if (rawMaxLines !== undefined) {
                    if (typeof rawMaxLines !== 'number') {
                        throw new Error('max_lines must be a number')
                    }
                    maxLines = rawMaxLines
                }

                let maxTokens: number | undefined
                const rawMaxTokens = args.max_tokens ?? args.maxTokens
                if (rawMaxTokens !== undefined) {
                    if (typeof rawMaxTokens !== 'number') {
                        throw new Error('max_tokens must be a number')
                    }
                    maxTokens = rawMaxTokens
                }

                const request: ReadMemoryRequest = {
                    path: args.path,
                    lineOffset,
                    maxLines,
                    maxTokens,
                }

                return await backend.readMemory(request)
            } catch (err) {
                return formatToolError(err)
            }
        },
    }

    const memoriesSearchTool: AgentToolContribution = {
        name: MEMORIES_SEARCH_TOOL_NAME,
        description: MEMORIES_SEARCH_DESCRIPTION,
        parameters: MEMORIES_SEARCH_PARAMETERS,
        execute: async (args: Record<string, unknown>) => {
            try {
                if (!Array.isArray(args.queries)) {
                    throw new Error(
                        'queries is required and must be an array of strings'
                    )
                }
                for (let i = 0; i < args.queries.length; i++) {
                    if (typeof args.queries[i] !== 'string') {
                        throw new Error('queries must contain only strings')
                    }
                }

                const queries = args.queries as string[]

                if (args.path !== undefined && typeof args.path !== 'string') {
                    throw new Error('path must be a string')
                }
                const path = args.path as string | undefined

                const rawMatchMode = args.match_mode ?? args.matchMode
                let matchMode: SearchMatchMode | undefined
                if (rawMatchMode !== undefined) {
                    if (
                        rawMatchMode !== 'any' &&
                        rawMatchMode !== 'all_on_same_line' &&
                        rawMatchMode !== 'all_within_lines'
                    ) {
                        throw new Error(
                            "match_mode must be one of 'any', 'all_on_same_line', 'all_within_lines'"
                        )
                    }
                    matchMode = rawMatchMode as SearchMatchMode
                }

                let lineCount: number | undefined
                const rawLineCount = args.line_count ?? args.lineCount
                if (rawLineCount !== undefined) {
                    if (typeof rawLineCount !== 'number') {
                        throw new Error('line_count must be a number')
                    }
                    lineCount = rawLineCount
                }

                let contextLines: number | undefined
                const rawContextLines =
                    args.context_lines ?? args.contextLines
                if (rawContextLines !== undefined) {
                    if (typeof rawContextLines !== 'number') {
                        throw new Error('context_lines must be a number')
                    }
                    contextLines = rawContextLines
                }

                const rawCaseSensitive =
                    args.case_sensitive ?? args.caseSensitive
                let caseSensitive: boolean | undefined
                if (rawCaseSensitive !== undefined) {
                    if (typeof rawCaseSensitive !== 'boolean') {
                        throw new Error('case_sensitive must be a boolean')
                    }
                    caseSensitive = rawCaseSensitive
                }

                let normalized: boolean | undefined
                if (args.normalized !== undefined) {
                    if (typeof args.normalized !== 'boolean') {
                        throw new Error('normalized must be a boolean')
                    }
                    normalized = args.normalized
                }

                let cursor: string | undefined
                if (args.cursor !== undefined && args.cursor !== null) {
                    if (
                        typeof args.cursor !== 'string' &&
                        typeof args.cursor !== 'number'
                    ) {
                        throw new Error('cursor must be a string')
                    }
                    cursor = String(args.cursor)
                }

                let maxResults: number | undefined
                const rawMaxResults = args.max_results ?? args.maxResults
                if (rawMaxResults !== undefined) {
                    if (typeof rawMaxResults !== 'number') {
                        throw new Error('max_results must be a number')
                    }
                    maxResults = rawMaxResults
                }

                const request: SearchMemoriesRequest = {
                    queries,
                    path,
                    matchMode,
                    lineCount,
                    contextLines,
                    caseSensitive,
                    normalized,
                    cursor,
                    maxResults,
                }

                return await backend.searchMemories(request)
            } catch (err) {
                return formatToolError(err)
            }
        },
    }

    const memoriesAddAdHocNoteTool: AgentToolContribution = {
        name: MEMORIES_ADD_AD_HOC_NOTE_TOOL_NAME,
        description: MEMORIES_ADD_AD_HOC_NOTE_DESCRIPTION,
        parameters: MEMORIES_ADD_AD_HOC_NOTE_PARAMETERS,
        execute: async (args: Record<string, unknown>) => {
            try {
                if (
                    typeof args.filename !== 'string' ||
                    args.filename.trim().length === 0
                ) {
                    throw new Error(
                        'filename is required and must be a non-empty string'
                    )
                }
                if (
                    typeof args.note !== 'string' ||
                    args.note.trim().length === 0
                ) {
                    throw new Error(
                        'note is required and must be a non-empty string'
                    )
                }

                const request: AddAdHocNoteRequest = {
                    filename: args.filename.trim(),
                    note: args.note,
                }

                return await backend.addAdHocNote(request)
            } catch (err) {
                return formatToolError(err)
            }
        },
    }

    return [
        memoriesListTool,
        memoriesReadTool,
        memoriesSearchTool,
        memoriesAddAdHocNoteTool,
    ]
}
