import { describe, expect, it, vi } from 'vitest'
import type { AssistantEntry, ModelCatalogEntry } from '@cpa/plugin-api'
import { createWebSearchTool } from './webSearchTool.js'
import { normalizeSearchResponse } from './normalizeSearchResponse.js'
import { MAX_QUERY_LENGTH, MAX_SOURCES, MAX_TEXT_LENGTH, parseSettings } from '../shared/types.js'

const model: ModelCatalogEntry = { id: 'search-B', label: 'Search B', supportsFast: false, reasoningLevels: [], input: ['text'], contextWindow: 100000, maxTokens: 4096, cpaCapabilities: { webSearch: true } }
function response(patch: Partial<AssistantEntry> = {}): AssistantEntry {
    return { id: 'B-response', sessionId: 'isolated-B', kind: 'assistant', createdAt: 1, status: 'done', stopReason: 'stop', content: [{ type: 'text', text: 'Current findings' }], nativeToolCalls: [{ id: 'ws_B', type: 'web_search_call', status: 'completed', action: { type: 'search' } }], ...patch }
}
const normalize = (patch: Partial<AssistantEntry> = {}) => normalizeSearchResponse('query', model.id, response(patch))

// Representative existing Responses shapes; these are not live-upstream captures.
describe('web search response normalization', () => {
    it('accepts Codex completed execution without an unavailable sources include', () => {
        expect(normalize()).toMatchObject({ status: 'completed', text: 'Current findings', sources: [], searchExecuted: true })
    })
    it('collects xAI sources and OpenAI citations and deduplicates URLs', () => {
        const result = normalize({
            nativeToolCalls: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://example.org/page#fragment', title: 'Search result', snippet: 'Actual snippet' }] } }],
            annotations: [{ type: 'url_citation', url: 'https://example.org/page', title: 'Duplicate' }, { type: 'url_citation', url: 'https://example.net/' }],
        })
        expect(result.sources).toEqual([{ url: 'https://example.org/page', title: 'Search result', excerpt: 'Actual snippet', origin: 'search_result' }, { url: 'https://example.net/', origin: 'citation' }])
    })
    it('accepts generic citation wrappers preserved by the protocol', () => {
        const result = normalize({ content: [], annotations: [{ type: 'citation', url_citation: { url: 'https://example.org/', title: 'Reference' } }] })
        expect(result.status).toBe('completed')
        expect(result.sources).toEqual([{ url: 'https://example.org/', title: 'Reference', origin: 'citation' }])
    })
    it('supports Claude results/citations but never exposes replay encryption', () => {
        const result = normalize({
            nativeToolCalls: [{ type: 'web_search_call', status: 'completed', results: [{ type: 'web_search_result', url: 'https://example.org/', title: 'Result', encrypted_content: 'private-ciphertext' }] }],
            annotations: [{ type: 'web_search_result_location', url: 'https://example.net/', cited_text: 'A real citation', encrypted_index: 'private-index' }],
        })
        expect(result.sources).toHaveLength(2)
        expect(result.sources[1].excerpt).toBe('A real citation')
        expect(JSON.stringify(result)).not.toContain('private-')
        expect(JSON.stringify(result)).not.toContain('encrypted_')
    })
    it.each([
        { nativeToolCalls: [] },
        { nativeToolCalls: [{ type: 'x_search_call', status: 'completed' }] },
        { nativeToolCalls: [{ type: 'web_search_call', status: 'in_progress' }] },
    ])('rejects ordinary text, links, X Search and incomplete evidence: %j', (patch) => {
        expect(normalize({ ...patch, content: [{ type: 'text', text: 'I searched https://example.org/' }], annotations: [{ type: 'url_citation', url: 'https://example.org/' }] })).toMatchObject({ status: 'failed', text: '', error: { code: 'search_not_executed' } })
    })
    it.each([
        { type: 'web_search_call', status: 'failed', error: { message: 'secret-key' } },
        { type: 'web_search_call', status: 'completed', results: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
        { type: 'web_search_call', status: 'completed', results: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] },
    ])('fails native tool errors, including Claude object and array forms', (call) => {
        const result = normalize({ nativeToolCalls: [call] })
        expect(result.error?.code).toBe('native_search_error')
        expect(JSON.stringify(result)).not.toContain('secret-key')
    })
    it('distinguishes explicit empty results from missing sources or findings', () => {
        expect(normalize({ content: [], nativeToolCalls: [{ type: 'web_search_call', status: 'completed', results: [] }] }).status).toBe('no_results')
        expect(normalize({ content: [] }).error?.code).toBe('search_result_unavailable')
        expect(normalize({ nativeToolCalls: [{ type: 'web_search_call', status: 'completed', action: { sources: [] } }] }).status).toBe('completed')
    })
    it('rejects unsafe or overlong URLs and preserves only explicit snippets', () => {
        const urls = ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.org/', 'https://example.org/' + 'a'.repeat(2048), 'https://example.org/' + '中'.repeat(1000), 'https://exam\nple.org/', 'https://safe.example/']
        const result = normalize({ annotations: urls.map((url) => ({ type: 'url_citation', url })) })
        expect(result.sources).toEqual([{ url: 'https://safe.example/', origin: 'citation' }])
    })
    it('bounds text and source volume without losing source slots', () => {
        const result = normalize({ content: [{ type: 'text', text: 'a'.repeat(MAX_TEXT_LENGTH + 20) }], annotations: Array.from({ length: MAX_SOURCES + 2 }, (_, i) => ({ type: 'url_citation', url: `https://example.org/${i}`, title: 't'.repeat(500), cited_text: 's'.repeat(1000) })) })
        expect(result.text).toHaveLength(MAX_TEXT_LENGTH)
        expect(result.sources).toHaveLength(MAX_SOURCES)
        expect(result.truncated).toBe(true)
        expect(JSON.stringify(result).length).toBeLessThan(110000)
    })
    it.each([{ status: 'error' as const }, { status: 'aborted' as const }, { stopReason: 'length' as const }])('does not return partially failed responses as success', (patch) => {
        expect(normalize(patch).error?.code).toBe('response_incomplete')
    })
})

describe('web search tool', () => {
    function setup(settings = { enabled: true, modelId: model.id }, models = [model], ready = true) {
        const invoke = vi.fn().mockResolvedValue(response())
        const tool = createWebSearchTool({ getSettings: async () => settings, getModels: () => models, isCatalogReady: () => ready })
        return { tool, invoke, context: { modelInvoker: { invoke } } }
    }
    it('invokes only the selected model with query and native tools, not parent call ID or history', async () => {
        const { tool, invoke, context } = setup()
        const result = await tool.execute('call_A', { query: 'latest releases' }, context)
        expect(result.isError).toBe(false)
        expect(invoke).toHaveBeenCalledTimes(1)
        expect(invoke.mock.calls[0][0]).toEqual({ model, query: 'latest releases', instructions: expect.any(String), nativeTools: [{ type: 'web_search' }], toolChoice: 'required' })
        expect(JSON.stringify(result)).not.toContain('ws_B')
        expect(JSON.stringify(result)).not.toContain('B-response')
    })
    it.each([
        [{ enabled: false, modelId: model.id }, [model], true, 'search_disabled'],
        [{ enabled: true, modelId: 'missing' }, [model], true, 'search_model_unavailable'],
        [{ enabled: true, modelId: model.id }, [{ ...model, cpaCapabilities: undefined }], true, 'search_model_unavailable'],
        [{ enabled: true, modelId: model.id }, [model], false, 'catalog_unavailable'],
    ] as const)('does not invoke disabled, unknown, stale, or invalid candidates', async (settings, models, ready, code) => {
        const { tool, invoke, context } = setup(settings, [...models], ready)
        const result = await tool.execute('call_A', { query: 'query' }, context)
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe(code)
        expect(invoke).not.toHaveBeenCalled()
    })
    it('rechecks settings and catalog at execution rather than using stale captured candidates', async () => {
        const settings = { enabled: true, modelId: model.id }
        const { tool, invoke, context } = setup(settings)
        settings.enabled = false
        expect((await tool.execute('call_A', { query: 'query' }, context)).isError).toBe(true)
        expect(invoke).not.toHaveBeenCalled()
    })
    it('returns a local failure without credential-bearing upstream messages or retries', async () => {
        const { tool, invoke, context } = setup()
        invoke.mockRejectedValue(new Error('https://secret:password@example.org secret-key'))
        const result = await tool.execute('call_A', { query: 'query' }, context)
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it.each([
        ['TimeoutError', 'search_request_timeout'],
        ['AbortError', 'search_request_failed'],
    ])('reports an upstream %s as a failure when the caller has not cancelled', async (name, code) => {
        const { tool, invoke, context } = setup()
        const controller = new AbortController()
        const error = new Error('https://secret:password@example.org secret-key')
        error.name = name
        invoke.mockRejectedValue(error)
        const result = await tool.execute('call_A', { query: 'query' }, { ...context, signal: controller.signal })
        expect(result.isError).toBe(true)
        expect(JSON.parse((result.content[0] as { text: string }).text).error.code).toBe(code)
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(controller.signal.aborted).toBe(false)
        expect(invoke).toHaveBeenCalledTimes(1)
    })
    it('propagates abort and ignores a late response', async () => {
        const { tool, invoke, context } = setup()
        const controller = new AbortController()
        invoke.mockImplementation(async () => { controller.abort(); return response() })
        await expect(tool.execute('call_A', { query: 'query' }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    })
    it('validates query-only arguments', () => {
        const { tool } = setup()
        expect(tool.validate({ query: ' query ' })).toEqual({ query: 'query' })
        for (const args of [null, [], {}, { query: ' ' }, { query: 3 }, { query: 'a'.repeat(MAX_QUERY_LENGTH + 1) }, { query: 'x', model: 'evil' }, { query: 'x', url: 'https://evil.test' }]) expect(() => tool.validate(args)).toThrow()
        expect(parseSettings({ enabled: 'true', modelId: 7 })).toEqual({ enabled: false, modelId: '' })
    })
})
