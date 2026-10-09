import { describe, expect, it, vi } from 'vitest'
import {
    createMemoryTools,
    MEMORIES_SEARCH_TOOL_NAME,
    MEMORIES_READ_TOOL_NAME,
    MEMORIES_ADD_TOOL_NAME,
    MEMORIES_SEARCH_DESCRIPTION,
    MEMORIES_READ_DESCRIPTION,
    MEMORIES_ADD_DESCRIPTION,
    MEMORIES_SEARCH_PARAMETERS,
    MEMORIES_READ_PARAMETERS,
    MEMORIES_ADD_PARAMETERS,
} from './memoryTools.js'

function setup() {
    const client = { invoke: vi.fn() }
    const [search, read, add] = createMemoryTools({ client })
    return { client, search, read, add }
}

describe('createMemoryTools', () => {
    it('exposes only the three database tools in search/read/add order', () => {
        const tools = createMemoryTools()
        expect(tools.map((tool) => tool.name)).toEqual([
            'memories_search', 'memories_read', 'memories_add',
        ])
        expect([MEMORIES_SEARCH_TOOL_NAME, MEMORIES_READ_TOOL_NAME, MEMORIES_ADD_TOOL_NAME])
            .toEqual(tools.map((tool) => tool.name))
        expect(tools.map((tool) => tool.description)).toEqual([
            'Search memories by keywords. Returns memory ids with titles and short snippets; use memories_read to fetch full content.',
            'Read full content of memories by ids (batch supported).',
            'Add a memory note. Call to record completed task summaries, learned user preferences, project conventions, or when explicitly requested by user.',
        ])
        expect([MEMORIES_SEARCH_DESCRIPTION, MEMORIES_READ_DESCRIPTION, MEMORIES_ADD_DESCRIPTION])
            .toEqual(tools.map((tool) => tool.description))
        expect([MEMORIES_SEARCH_PARAMETERS, MEMORIES_READ_PARAMETERS, MEMORIES_ADD_PARAMETERS])
            .toEqual(tools.map((tool) => tool.parameters))
        expect(tools.map((tool) => tool.parameters.required)).toEqual([
            ['queries'], ['ids'], ['title', 'note'],
        ])
        expect(Object.keys(MEMORIES_SEARCH_PARAMETERS.properties as object)).toEqual([
            'queries', 'match_mode', 'line_count', 'case_sensitive', 'normalized', 'cursor', 'max_results',
        ])
        expect(Object.keys(MEMORIES_READ_PARAMETERS.properties as object)).toEqual(['ids', 'max_tokens'])
        expect(Object.keys(MEMORIES_ADD_PARAMETERS.properties as object)).toEqual(['title', 'note'])
        for (const tool of tools) {
            for (const removed of ['path', 'context_lines', 'line_offset', 'max_lines', 'filename']) {
                expect(tool.parameters.properties).not.toHaveProperty(removed)
            }
        }
    })

    it('maps search parameters to the RPC request and passes the response through', async () => {
        const { client, search } = setup()
        const response = { matches: [{ id: 7, title: 'a', matchedQueries: ['a'], snippet: 'a' }], truncated: false }
        client.invoke.mockResolvedValue(response)
        expect(await search.execute({
            queries: ['a'], match_mode: 'all_within_lines', line_count: 3,
            case_sensitive: true, normalized: false, cursor: 5, max_results: 10,
        }, undefined)).toBe(response)
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith('memories:search', [{
            queries: ['a'], matchMode: 'all_within_lines', lineCount: 3,
            caseSensitive: true, normalized: false, cursor: '5', maxResults: 10,
        }])
    })

    it('passes a minimal search request without filling main-layer defaults', async () => {
        const { client, search } = setup()
        await search.execute({ queries: ['preferences'] }, undefined)
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith('memories:search', [{ queries: ['preferences'] }])
    })

    it('maps batch read parameters and passes the response through', async () => {
        const { client, read } = setup()
        const response = { memories: [], missingIds: [2, 1] }
        client.invoke.mockResolvedValue(response)
        expect(await read.execute({ ids: [2, 1], max_tokens: 500 }, undefined)).toBe(response)
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith('memories:read', [{ ids: [2, 1], maxTokens: 500 }])
    })

    it('passes title and Markdown note to add and passes the response through', async () => {
        const { client, add } = setup()
        const response = { success: true, id: 3 }
        client.invoke.mockResolvedValue(response)
        expect(await add.execute({ title: 'pref', note: '## User Preferences\n- x' }, undefined)).toBe(response)
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith('memories:add', [{ title: 'pref', note: '## User Preferences\n- x' }])
    })

    it('accepts padded titles whose trimmed length is within the limit', async () => {
        const { client, add } = setup()
        const title = ` ${'a'.repeat(120)} `
        await add.execute({ title, note: 'note' }, undefined)
        expect(client.invoke).toHaveBeenCalledExactlyOnceWith('memories:add', [{ title, note: 'note' }])
        expect(MEMORIES_ADD_PARAMETERS.properties).not.toHaveProperty('title.maxLength')
    })

    it.each([
        {}, { queries: [] }, { queries: [' '] }, { queries: [1] },
        { queries: ['!!!'], normalized: true },
        { queries: ['a'], match_mode: 'invalid' },
        { queries: ['a'], match_mode: 'all_within_lines' },
        { queries: ['a'], match_mode: 'all_within_lines', line_count: 1.5 },
        { queries: ['a'], cursor: -1 }, { queries: ['a'], cursor: {} },
        { queries: ['a'], max_results: 0 },
        { queries: ['a'], case_sensitive: 'true' },
        { queries: ['a'], normalized: 'true' },
        { queries: ['a'], line_count: '3' },
    ])('rejects invalid search input before RPC: %j', async (args) => {
        const { client, search } = setup()
        expect(await search.execute(args, undefined)).toMatch(/^Error:/)
        expect(client.invoke).not.toHaveBeenCalled()
    })

    it.each([{}, { ids: [] }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ['1'] },
        { ids: Array.from({ length: 21 }, (_, i) => i + 1) }, { ids: [1], max_tokens: '500' },
    ])('rejects invalid read input before RPC: %j', async (args) => {
        const { client, read } = setup()
        expect(await read.execute(args, undefined)).toMatch(/^Error:/)
        expect(client.invoke).not.toHaveBeenCalled()
    })

    it.each([
        { note: 'note' }, { title: ' ', note: 'note' }, { title: 'a\nb', note: 'note' },
        { title: 'a'.repeat(121), note: 'note' }, { title: 'pref' }, { title: 'pref', note: ' ' },
    ])('rejects invalid add input before RPC: %j', async (args) => {
        const { client, add } = setup()
        expect(await add.execute(args, undefined)).toMatch(/^Error:/)
        expect(client.invoke).not.toHaveBeenCalled()
    })

    it.each([0, 1, 2])('returns the unavailable error without a client (tool %i)', async (index) => {
        const args = [{ queries: ['a'] }, { ids: [1] }, { title: 'pref', note: 'note' }][index]
        expect(await createMemoryTools()[index].execute(args, undefined))
            .toBe('Error: memories service is unavailable')
    })

    it.each([0, 1, 2])('returns RPC rejection as an error string (tool %i)', async (index) => {
        const client = { invoke: vi.fn().mockRejectedValue(new Error('db locked')) }
        const args = [{ queries: ['a'] }, { ids: [1] }, { title: 'pref', note: 'note' }][index]
        expect(await createMemoryTools({ client })[index].execute(args, undefined)).toBe('Error: db locked')
    })

    it('formats non-Error RPC rejections', async () => {
        const { client, search } = setup()
        client.invoke.mockRejectedValue('offline')
        expect(await search.execute({ queries: ['a'] }, undefined)).toBe('Error: offline')
    })
})
