import type { AgentToolContribution, PluginCapabilityClient } from '@cpa/plugin-api'
import type { AddMemoryRequest, ReadMemoriesRequest, SearchMemoriesRequest } from '../shared/types.js'
import { validateAddRequest, validateReadRequest, validateSearchRequest } from '../shared/validation.js'

export const MEMORIES_SEARCH_TOOL_NAME = 'memories_search'
export const MEMORIES_READ_TOOL_NAME = 'memories_read'
export const MEMORIES_ADD_TOOL_NAME = 'memories_add'

export const MEMORIES_SEARCH_DESCRIPTION =
    'Search memories by keywords. Returns memory ids with titles and short snippets; use memories_read to fetch full content.'
export const MEMORIES_READ_DESCRIPTION =
    'Read full content of memories by ids (batch supported).'
export const MEMORIES_ADD_DESCRIPTION =
    'Add a memory note. Call to record completed task summaries, learned user preferences, project conventions, or when explicitly requested by user.'

export const MEMORIES_SEARCH_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        queries: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Keywords to search for.',
        },
        match_mode: {
            type: 'string',
            enum: ['any', 'all_on_same_line', 'all_within_lines'],
            description: 'Match strategy (default any).',
        },
        line_count: {
            type: 'integer',
            minimum: 1,
            description: 'Required window line count when match_mode is all_within_lines.',
        },
        case_sensitive: {
            type: 'boolean',
            description: 'Whether matching is case-sensitive (default false).',
        },
        normalized: {
            type: 'boolean',
            description: 'Whether to normalize text by stripping non-alphanumeric characters (default false).',
        },
        cursor: {
            type: 'string',
            description: 'Pagination cursor (non-negative integer string).',
        },
        max_results: {
            type: 'number',
            description: 'Maximum results to return (default 20, up to 100).',
        },
    },
    required: ['queries'],
}

export const MEMORIES_READ_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        ids: {
            type: 'array',
            items: { type: 'integer', minimum: 1 },
            minItems: 1,
            description: 'Memory ids to read (1 to 20 unique positive integers).',
        },
        max_tokens: {
            type: 'number',
            description: 'Total token budget across all returned content (default 20000).',
        },
    },
    required: ['ids'],
}

export const MEMORIES_ADD_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description: 'Short, non-empty, single-line title (up to 120 characters after trimming).',
        },
        note: {
            type: 'string',
            description: 'Non-empty Markdown text content of the note.',
        },
    },
    required: ['title', 'note'],
}

export interface CreateMemoryToolsOptions {
    client?: Pick<PluginCapabilityClient, 'invoke'>
}

function formatToolError(error: unknown): string {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
}

function validateOptionalTypes(args: Record<string, unknown>, fields: Record<string, string>): void {
    for (const [field, type] of Object.entries(fields)) {
        if (args[field] !== undefined && typeof args[field] !== type) {
            throw new Error(`${field} must be a ${type}`)
        }
    }
}

export function createMemoryTools(options: CreateMemoryToolsOptions = {}): AgentToolContribution[] {
    const { client } = options

    return [
        {
            name: MEMORIES_SEARCH_TOOL_NAME,
            description: MEMORIES_SEARCH_DESCRIPTION,
            parameters: MEMORIES_SEARCH_PARAMETERS,
            execute: async (args) => {
                if (!client) return 'Error: memories service is unavailable'
                try {
                    validateOptionalTypes(args, {
                        match_mode: 'string', line_count: 'number', case_sensitive: 'boolean',
                        normalized: 'boolean', max_results: 'number',
                    })
                    if (args.cursor !== undefined && typeof args.cursor !== 'string' && typeof args.cursor !== 'number') {
                        throw new Error('cursor must be a string or number')
                    }
                    const request: SearchMemoriesRequest = {
                        queries: args.queries as string[],
                        matchMode: args.match_mode as SearchMemoriesRequest['matchMode'],
                        lineCount: args.line_count as number | undefined,
                        caseSensitive: args.case_sensitive as boolean | undefined,
                        normalized: args.normalized as boolean | undefined,
                        cursor: args.cursor === undefined ? undefined : String(args.cursor),
                        maxResults: args.max_results as number | undefined,
                    }
                    validateSearchRequest(request)
                    return await client.invoke('memories:search', [request])
                } catch (error) {
                    return formatToolError(error)
                }
            },
        },
        {
            name: MEMORIES_READ_TOOL_NAME,
            description: MEMORIES_READ_DESCRIPTION,
            parameters: MEMORIES_READ_PARAMETERS,
            execute: async (args) => {
                if (!client) return 'Error: memories service is unavailable'
                try {
                    validateOptionalTypes(args, { max_tokens: 'number' })
                    const request: ReadMemoriesRequest = {
                        ids: args.ids as number[],
                        maxTokens: args.max_tokens as number | undefined,
                    }
                    validateReadRequest(request)
                    return await client.invoke('memories:read', [request])
                } catch (error) {
                    return formatToolError(error)
                }
            },
        },
        {
            name: MEMORIES_ADD_TOOL_NAME,
            description: MEMORIES_ADD_DESCRIPTION,
            parameters: MEMORIES_ADD_PARAMETERS,
            execute: async (args) => {
                if (!client) return 'Error: memories service is unavailable'
                try {
                    const request: AddMemoryRequest = {
                        title: args.title as string,
                        note: args.note as string,
                    }
                    validateAddRequest(request)
                    return await client.invoke('memories:add', [request])
                } catch (error) {
                    return formatToolError(error)
                }
            },
        },
    ]
}
