import type { AssistantEntry, PluginCapabilityClient, ProtocolStreamInput, Usage } from '@cpa/plugin-api'

// generateContent returns only after grounding and generation finish. Give
// reasoning/search models time to complete rather than aborting at 60 seconds.
export const GEMINI_SEARCH_TIMEOUT_MS = 180_000

export interface GeminiSearchHttpRequest {
    urlString: string
    method: string
    headers: Record<string, string>
    body: string
    timeoutMs: number
}

export type GeminiSearchTransport = (request: GeminiSearchHttpRequest) => Promise<{ status: number; body: string }>

export function createGeminiSearchTransport(client?: PluginCapabilityClient): GeminiSearchTransport {
    return (request) => {
        if (!client?.has('network.http')) throw new Error('Gemini search HTTP capability is unavailable')
        return client.invoke('http:request', [request])
    }
}

export function geminiSearchUrl(baseUrl: string, modelId: string): string {
    const raw = baseUrl.trim()
    const url = new URL(/^\w[\w+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Invalid Gemini search endpoint')
    }
    const root = url.pathname.replace(/\/+$/, '').replace(/\/(?:v1|v1beta|backend-api)$/, '')
    // Strip only the standard Google resource prefix, preserving CPA routing prefixes.
    const model = modelId.replace(/^models\//, '')
    url.pathname = `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    url.search = ''
    url.hash = ''
    return url.toString()
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

function parseUsage(value: unknown): Usage | undefined {
    const raw = object(value)
    if (!Object.keys(raw).length) return undefined
    const prompt = count(raw.promptTokenCount)
    const cacheRead = Math.min(prompt, count(raw.cachedContentTokenCount))
    const reasoning = count(raw.thoughtsTokenCount)
    const output = count(raw.candidatesTokenCount) + reasoning
    return {
        input: prompt - cacheRead, output, cacheRead, cacheWrite: 0, reasoning,
        totalTokens: count(raw.totalTokenCount) || prompt + output,
        costKnown: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
}

/** Adapt grounding evidence to the neutral native-search result contract.
 * Never expose thought signatures, search widget HTML, or arbitrary provider fields.
 */
export function parseGeminiSearchResponse(payload: unknown, seed: AssistantEntry): AssistantEntry {
    const raw = object(payload)
    const candidate = object(array(raw.candidates)[0])
    const grounding = object(candidate.groundingMetadata)
    const chunks = array(grounding.groundingChunks)
    const sources = chunks.flatMap((chunk) => {
        const web = object(object(chunk).web)
        if (typeof web.uri !== 'string' || !web.uri.trim()) return []
        return [{ url: web.uri, ...(typeof web.title === 'string' ? { title: web.title } : {}) }]
    })
    const queried = array(grounding.webSearchQueries).some((query) => typeof query === 'string' && query.trim())
    const executed = queried || sources.length > 0
    const finish = candidate.finishReason
    const complete = !raw.error && !object(raw.promptFeedback).blockReason && finish === 'STOP'
    const usage = parseUsage(raw.usageMetadata)
    return {
        ...seed,
        status: complete || finish === 'MAX_TOKENS' ? 'done' : 'error',
        stopReason: complete ? 'stop' : finish === 'MAX_TOKENS' ? 'length' : 'error',
        ...(!complete && finish !== 'MAX_TOKENS' ? { errorMessage: 'Gemini search response did not complete successfully.' } : {}),
        content: array(object(candidate.content).parts).flatMap((part) => {
            const rawPart = object(part)
            return rawPart.thought !== true && typeof rawPart.text === 'string'
                ? [{ type: 'text' as const, text: rawPart.text }]
                : []
        }),
        nativeToolCalls: executed ? [{
            type: 'web_search_call', status: 'completed', action: { type: 'search', sources },
            // Missing grounding sources does not prove zero results.
        }] : [],
        annotations: array(grounding.groundingSupports).flatMap((support) => {
            const item = object(support)
            const text = object(item.segment).text
            return array(item.groundingChunkIndices).flatMap((index) => {
                if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return []
                const web = object(object(chunks[index]).web)
                if (typeof web.uri !== 'string') return []
                return [{ type: 'url_citation', url: web.uri,
                    ...(typeof web.title === 'string' ? { title: web.title } : {}),
                    ...(typeof text === 'string' ? { cited_text: text } : {}),
                }]
            })
        }),
        ...(usage ? { usage } : {}),
    }
}

/** The capability RPC is bounded by its host timeout. Abort stops waiting and
 * ignores late results; AbortSignal itself must never cross the IPC boundary.
 */
async function awaitResponse<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new DOMException('Gemini search aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
}

export async function requestGeminiSearch(
    input: ProtocolStreamInput,
    config: { baseUrl: string; apiKey: string; transport?: GeminiSearchTransport },
    signal: AbortSignal,
    maxOutputTokens?: number,
): Promise<AssistantEntry> {
    signal.throwIfAborted()
    if (!config.transport) throw new Error('Gemini search HTTP transport is unavailable')
    // This adapter is deliberately only for one-shot isolated searches, never a
    // conversion of the parent conversation or local function tools.
    if (input.entries.length !== 1 || input.entries[0].kind !== 'user' || input.tools?.length || input.developerPrompt) {
        throw new Error('Gemini search requires an isolated text query')
    }
    const parts = input.entries[0].content
    if (parts.some((part) => part.type !== 'text')) throw new Error('Gemini search requires text input')
    const response = await awaitResponse(config.transport({
        urlString: geminiSearchUrl(config.baseUrl, input.model.id),
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: parts.map((part) => ({ text: (part as { text: string }).text })) }],
            systemInstruction: { parts: [{ text: input.systemPrompt }] },
            tools: [{ googleSearch: {} }],
            // Gemini's ANY function-calling mode does not force built-in Google
            // Search. Require actual grounding evidence in the returned result.
            generationConfig: { candidateCount: 1, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
        }),
        timeoutMs: GEMINI_SEARCH_TIMEOUT_MS,
    }), signal)
    signal.throwIfAborted()
    if (response.status < 200 || response.status >= 300) throw new Error(`Gemini search request failed (${response.status})`)
    if (response.body.length > 1_000_000) throw new Error('Gemini search response exceeds size limit')
    return parseGeminiSearchResponse(JSON.parse(response.body), input.seed)
}
