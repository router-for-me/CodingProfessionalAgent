import type { ModelCatalogEntry, ModelInputModality, ModelReasoningOption } from '@cpa/plugin-api'

const MODEL_CATALOG_TIMEOUT_MS = 60_000

const CANONICAL_REASONING_ORDER = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
] as const

const REASONING_LABEL_KEYS = new Map<string, string>([
    ['off', 'composer.reasoning.off'],
    ['minimal', 'composer.reasoning.minimal'],
    ['low', 'composer.reasoning.low'],
    ['medium', 'composer.reasoning.medium'],
    ['high', 'composer.reasoning.high'],
    ['xhigh', 'composer.reasoning.xhigh'],
    ['max', 'composer.reasoning.max'],
    ['ultra', 'composer.reasoning.ultra'],
])

const CANONICAL_EFFORT_ALIASES = new Map<string, string>([
    ['none', 'off'],
])

export interface ModelCatalogConfig {
    baseUrl: string
    apiKey: string
}

export class ModelCatalogFormatError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstNonBlankString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
}

function parseInputModalities(value: unknown): readonly ModelInputModality[] {
    const result: ModelInputModality[] = []
    if (Array.isArray(value)) {
        for (const item of value) {
            if ((item === 'text' || item === 'image') && !result.includes(item)) {
                result.push(item)
            }
        }
    }
    if (!result.includes('text')) result.unshift('text')
    return result
}

function positiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : fallback
}

function reasoningOptions(value: unknown): readonly ModelReasoningOption[] {
    if (!Array.isArray(value)) return []

    const options = new Map<string, ModelReasoningOption>()
    for (const item of value) {
        const rawEffort = typeof item === 'string'
            ? item
            : isRecord(item) && typeof item.effort === 'string'
                ? item.effort
                : undefined
        const effort = rawEffort?.trim()
        if (!effort) continue

        const normalizedEffort = effort.toLowerCase()
        const id = CANONICAL_EFFORT_ALIASES.get(normalizedEffort) ?? normalizedEffort
        if (options.has(id)) continue

        const option: ModelReasoningOption = {
            id,
            requestValue: effort,
        }
        const labelKey = REASONING_LABEL_KEYS.get(id)
        if (labelKey) {
            option.labelKey = labelKey
        } else {
            option.fallbackLabel = effort
        }
        if (isRecord(item) && typeof item.description === 'string' && item.description.trim()) {
            option.description = item.description.trim()
        }
        options.set(id, option)
    }

    return [...options.values()].sort((left, right) => {
        const leftIndex = CANONICAL_REASONING_ORDER.indexOf(
            left.id as (typeof CANONICAL_REASONING_ORDER)[number],
        )
        const rightIndex = CANONICAL_REASONING_ORDER.indexOf(
            right.id as (typeof CANONICAL_REASONING_ORDER)[number],
        )
        const leftRank = leftIndex === -1 ? CANONICAL_REASONING_ORDER.length : leftIndex
        const rightRank = rightIndex === -1 ? CANONICAL_REASONING_ORDER.length : rightIndex
        return leftRank - rightRank
    })
}

/**
 * Normalize a CLIProxyAPI base URL into the CPA model catalog endpoint.
 * The `client_version=cpa` query is required to receive the rich catalog
 * payload that includes `supported_reasoning_levels` and related metadata.
 */
export function normalizeModelsUrl(baseUrl: string): string {
    const candidate = /^\w[\w+.-]*:\/\//i.test(baseUrl.trim())
        ? baseUrl.trim()
        : `http://${baseUrl.trim()}`
    const url = new URL(candidate)
    let rootPath = url.pathname.replace(/\/+$/, '')
    for (const suffix of ['/backend-api', '/v1']) {
        if (rootPath === suffix || rootPath.endsWith(suffix)) {
            rootPath = rootPath.slice(0, -suffix.length)
            break
        }
    }
    url.pathname = `${rootPath}/v1/models`.replace(/^\/\//, '/')
    url.search = ''
    url.searchParams.set('client_version', 'cpa')
    url.hash = ''
    return url.toString()
}

export function parseModelCatalog(payload: unknown): readonly ModelCatalogEntry[] {
    let rawModels: unknown[]
    if (Array.isArray(payload)) {
        rawModels = payload
    } else if (isRecord(payload) && Array.isArray(payload.models)) {
        rawModels = payload.models
    } else if (isRecord(payload) && Array.isArray(payload.data)) {
        rawModels = payload.data
    } else {
        throw new ModelCatalogFormatError('Invalid model catalog format')
    }

    return rawModels.flatMap((rawModel): ModelCatalogEntry[] => {
        if (!isRecord(rawModel) || rawModel.visibility === 'hide') return []
        const id = firstNonBlankString(rawModel.slug, rawModel.id)
        if (!id) return []
        const label = firstNonBlankString(rawModel.display_name, rawModel.name) ?? id
        const description = firstNonBlankString(rawModel.description, rawModel.summary)
        return [{
            id,
            label,
            ...(description ? { description } : {}),
            supportsFast: Array.isArray(rawModel.service_tiers) && rawModel.service_tiers.length > 0,
            reasoningLevels: reasoningOptions(rawModel.supported_reasoning_levels),
            input: parseInputModalities(rawModel.input_modalities),
            contextWindow: positiveNumber(
                rawModel.context_window,
                positiveNumber(rawModel.max_context_window, 128_000),
            ),
            maxTokens: positiveNumber(rawModel.max_tokens, 16_384),
        }]
    })
}

export async function fetchModelCatalogDirect(
    config: ModelCatalogConfig,
    transport?: { request: (req: any) => Promise<{ status: number; body: string }> },
): Promise<readonly ModelCatalogEntry[]> {
    if (!config.baseUrl.trim() || !config.apiKey.trim()) {
        throw new Error('Model catalog configuration is incomplete')
    }

    const url = normalizeModelsUrl(config.baseUrl)
    const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
    }

    if (transport) {
        const response = await transport.request({
            url,
            method: 'GET',
            headers,
            body: '',
            timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
        })
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Model catalog request failed with status ${response.status}`)
        }
        const payload = JSON.parse(response.body)
        const models = parseModelCatalog(payload)
        if (models.length === 0) throw new Error('No available models')
        return models
    }

    const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS),
    })

    if (!res.ok) {
        throw new Error(`Model catalog request failed with status ${res.status}`)
    }

    const payload = await res.json()
    const models = parseModelCatalog(payload)
    if (models.length === 0) {
        throw new Error('No available models')
    }
    return models
}
