export interface WebSearchSettings {
    enabled: boolean
    modelId: string
}

export interface WebSearchResult {
    status: 'completed' | 'no_results' | 'failed'
    query: string
    text: string
    sources: Array<{
        url: string
        title?: string
        excerpt?: string
        origin: 'search_result' | 'citation'
    }>
    searchExecuted: boolean
    searchModel: string
    truncated: boolean
    error?: { code: string; message: string }
}

export const SETTINGS_KEY = 'cpa.core.web-search'
export const MAX_QUERY_LENGTH = 4000
export const MAX_TEXT_LENGTH = 16000
export const MAX_SOURCES = 24

export function parseSettings(value: unknown): WebSearchSettings {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    return {
        enabled: raw.enabled === true,
        modelId: typeof raw.modelId === 'string' ? raw.modelId.trim() : '',
    }
}
