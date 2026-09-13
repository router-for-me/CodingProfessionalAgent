import type { AssistantEntry } from '@cpa/plugin-api'
import { MAX_SOURCES, MAX_TEXT_LENGTH, type WebSearchResult } from '../shared/types.js'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined

export function failedSearch(query: string, searchModel: string, code: string, message: string, searchExecuted = false): WebSearchResult {
    return { status: 'failed', query, searchModel, text: '', sources: [], searchExecuted, truncated: false, error: { code, message } }
}

/** Never fetch URLs, forward embedded credentials, or expose provider replay fields. */
function sourceUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return
    try {
        const url = new URL(value)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
        url.hash = ''
        if (url.href.length > 2048) return
        return url.href
    } catch { return }
}

export function normalizeSearchResponse(query: string, searchModel: string, response: AssistantEntry): WebSearchResult {
    const calls = response.nativeToolCalls ?? []
    const searches = calls.filter((item) => item.type === 'web_search_call')
    const executed = searches.some((item) => item.status === 'completed')
    if (response.status !== 'done' || response.stopReason === 'error' || response.stopReason === 'aborted' || response.stopReason === 'length') {
        return failedSearch(query, searchModel, 'response_incomplete', 'The search response did not complete successfully.', executed)
    }
    const nativeError = searches.some((item) => {
        const results = Array.isArray(item.results) ? item.results : [item.results]
        return item.status === 'failed' || item.status === 'incomplete' || Boolean(item.error) || results.some((result) => {
            const raw = record(result)
            return raw?.type === 'web_search_tool_result_error' || Boolean(raw?.error || raw?.error_code)
        })
    })
    if (nativeError) return failedSearch(query, searchModel, 'native_search_error', 'The upstream native web search tool reported an error.', executed)
    if (!executed) return failedSearch(query, searchModel, 'search_not_executed', 'No completed native Web Search execution was returned. Ordinary text or X Search is not Web Search evidence.')
    if (searches.some((item) => item.status !== 'completed')) {
        return failedSearch(query, searchModel, 'search_unverified', 'One or more native search calls did not complete.', true)
    }

    const result: WebSearchResult = {
        status: 'completed', query, searchModel, text: '', sources: [], searchExecuted: true, truncated: false,
    }
    const seen = new Set<string>()
    const boundedString = (value: unknown, max: number): string | undefined => {
        if (typeof value !== 'string' || !value.trim()) return
        if (value.length > max) result.truncated = true
        return value.slice(0, max)
    }
    const addSource = (value: unknown, origin: 'search_result' | 'citation') => {
        const raw = record(value)
        if (!raw) return
        const url = sourceUrl(raw.url)
        if (!url || seen.has(url)) return
        seen.add(url)
        if (result.sources.length >= MAX_SOURCES) { result.truncated = true; return }
        const title = boundedString(raw.title, 240)
        const excerpt = boundedString(raw.excerpt ?? raw.snippet ?? raw.cited_text, 800)
        result.sources.push({ url, ...(title ? { title } : {}), ...(excerpt ? { excerpt } : {}), origin })
    }
    const explicitlyEmpty = searches.every((item) => Array.isArray(item.results) && item.results.length === 0)
    for (const item of searches) {
        const action = record(item.action)
        if (Array.isArray(action?.sources)) for (const source of action.sources) addSource(source, 'search_result')
        if (Array.isArray(item.results)) {
            for (const source of item.results) addSource(source, 'search_result')
        }
    }
    for (const annotation of response.annotations ?? []) {
        if (annotation.type === 'url_citation' || annotation.type === 'web_search_result_location' || annotation.type === 'citation') {
            addSource(record(annotation.url_citation) ?? annotation, 'citation')
        }
    }
    for (const block of response.content) {
        if (block.type !== 'text') continue
        const remaining = MAX_TEXT_LENGTH - result.text.length
        const text = `${result.text ? '\n' : ''}${block.text}`
        if (text.length > remaining) result.truncated = true
        result.text += text.slice(0, Math.max(0, remaining))
    }
    // A missing sources include is NOT zero hits. Only an explicit results array
    // on every call proves zero results; returned citations still take precedence.
    if (explicitlyEmpty && !result.sources.length) result.status = 'no_results'
    else if (!result.text.trim() && !result.sources.length) {
        return failedSearch(query, searchModel, 'search_result_unavailable', 'Search completed but returned neither findings nor usable sources.', true)
    }
    return result
}
