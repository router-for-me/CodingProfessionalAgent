import type {
    ModelCatalogEntry,
    ModelInputModality,
    ModelReasoningOption,
} from '@cpa/plugin-api'

export type { ModelCatalogEntry, ModelInputModality, ModelReasoningOption }

export interface HttpRequest {
    url: string
    method: string
    headers: Record<string, string>
    body: string
    timeoutMs: number
}

export interface HttpResponse {
    status: number
    headers: Record<string, string[]>
    body: string
}

export interface HttpTransport {
    request(input: HttpRequest): Promise<HttpResponse>
}

export interface ModelCatalogConfig {
    baseUrl: string
    apiKey: string
}

export const CANONICAL_REASONING_ORDER = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const

const REASONING_LABEL_KEYS: Record<string, string> = {
    off: 'composer.reasoning.off',
    minimal: 'composer.reasoning.minimal',
    low: 'composer.reasoning.low',
    medium: 'composer.reasoning.medium',
    high: 'composer.reasoning.high',
    xhigh: 'composer.reasoning.xhigh',
    max: 'composer.reasoning.max',
    ultra: 'composer.reasoning.ultra',
}

export const CANONICAL_REASONING_OPTIONS: readonly ModelReasoningOption[] =
    CANONICAL_REASONING_ORDER.map((effort) => ({
        id: effort,
        requestValue: effort,
        labelKey: REASONING_LABEL_KEYS[effort],
    }))

export class ModelCatalogFormatError extends Error {}
