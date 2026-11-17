import type {
    AssistantEntry,
    ModelCatalogEntry,
    ProtocolClient,
    SystemPromptEnhancementSettings,
    SystemPromptLanguage,
    UserEntry,
} from '@cpa/plugin-api'
import { normalizeSystemPromptEnhancementSettings } from '@cpa/plugin-api'
import type { ModelSettingsConfig } from '@/types/models'
import { getFilteredModels } from '@/features/models/filteredModels'
import { AgentPreflightError } from '@/features/agent/types'

const LANGUAGE_DISPLAY_NAMES: Record<SystemPromptLanguage, string> = {
    'en': 'English',
    'zh-CN': 'Simplified Chinese (简体中文)',
    'zh-TW': 'Traditional Chinese (繁體中文)',
    'ja': 'Japanese (日本語)',
    'de': 'German (Deutsch)',
    'es': 'Spanish (Español)',
    'pt': 'Portuguese (Português)',
    'it': 'Italian (Italiano)',
}

const STRUCTURAL_STYLES: readonly string[] = [
    'Organize the entire instruction set as continuous prose paragraphs grouped logically without numbered lists or bullet points.',
    'Organize the instructions as a clean numbered operational specification with freshly invented section headings in the target language.',
    'Organize the instructions as an informal internal engineering memo with concise thematic blocks and varied phrasing.',
    'Interleave operational principles, tool usage boundaries, and workspace rules into distinct thematic clauses with unconventional ordering.',
]

const FORBIDDEN_PHRASE_FINGERPRINTS: readonly string[] = [
    'coding professional agent',
    'available tools:',
    'before starting other work, call the title tool',
]

const FORBIDDEN_TAG_REGEXES: readonly RegExp[] = [
    /\bguidelines\s*:/i,
    /^\s*#{1,6}\s+(?:(?:local\s+)?memory\b|retrieval\b|recording\b|using\s+memory\s+facts\b)/im,
    /<\s*\/?\s*skill_names(?:\s+[^>]*)?>/i,
    /<\s*\/?\s*available_roles(?:\s+[^>]*)?>/i,
    /<\s*\/?\s*role(?:\s+[^>]*)?>/i,
    /<\s*\/?\s*project_context(?:\s+[^>]*)?>/i,
    /<\s*\/?\s*project_instructions(?:\s+[^>]*)?>/i,
    /<\s*\/?\s*worktree_mode(?:\s+[^>]*)?>/i,
]

const GIT_TAG_REGEXES: readonly RegExp[] = [
    /<\s*\/?\s*git(?:\s+[^>]*)?>/i,
]

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsToolIdentifier(text: string, toolName: string): boolean {
    const pattern = new RegExp(
        `(?<![A-Za-z0-9_-])${escapeRegExp(toolName)}(?![A-Za-z0-9_-])`,
    )
    return pattern.test(text)
}

const RETRY_DELAYS_MS = [1000, 2000] as const
const MAX_SYNTHESIS_ATTEMPTS = 3

function defaultRandomFloat(): number {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
        const arr = new Uint32Array(1)
        globalThis.crypto.getRandomValues(arr)
        return (arr[0] ?? 0) / 0x100000000
    }
    return Math.random()
}

function defaultGenerateId(): string {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
    }
    return `spe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return
    if (signal?.aborted) {
        throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            reject(new AgentPreflightError('aborted', 'System prompt enhancement aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/**
 * Resolve the model used to synthesize an enhanced system prompt.
 * Respects `modelSettings` ordering and enablement filtering.
 */
export function resolveEnhancementModel(
    models: readonly ModelCatalogEntry[],
    enhancement: SystemPromptEnhancementSettings | undefined,
    fallbackModelId: string,
    modelSettings?: ModelSettingsConfig,
): ModelCatalogEntry | null {
    const enabledModels = getFilteredModels(models, modelSettings)
    if (enabledModels.length === 0) {
        return null
    }

    const configuredId = enhancement?.modelId?.trim() ?? ''
    if (configuredId) {
        const matched = enabledModels.find((m) => m.id === configuredId)
        if (matched) {
            return matched
        }
    }

    const defaultId = fallbackModelId?.trim() ?? ''
    if (defaultId) {
        const matchedDefault = enabledModels.find((m) => m.id === defaultId)
        if (matchedDefault) {
            return matchedDefault
        }
    }

    return enabledModels[0] ?? null
}

/**
 * Pick the target writing language for the synthesized system prompt.
 * When `multilingualEnabled` is false, always returns `'en'`.
 */
export function pickTargetPromptLanguage(
    enhancement: SystemPromptEnhancementSettings,
    randomFloat: () => number = defaultRandomFloat,
): SystemPromptLanguage {
    const normalized = normalizeSystemPromptEnhancementSettings(enhancement)
    if (!normalized.multilingualEnabled) {
        return 'en'
    }
    const pool = normalized.allowedLanguages
    if (pool.length === 0) {
        return 'en'
    }
    const raw = randomFloat()
    const clamped = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0
    const idx = Math.floor(clamped * pool.length)
    return pool[idx] ?? 'en'
}

/**
 * Strip a single pair of outer markdown code fences if the model wrapped the whole output.
 */
function stripOuterCodeFence(raw: string): string {
    const trimmed = raw.trim()
    const match = trimmed.match(/^```[^\n\r]*\r?\n([\s\S]*?)\r?\n```$/)
    if (match && typeof match[1] === 'string') {
        return match[1].trim()
    }
    return trimmed
}

/**
 * Validate rewritten core prompt against built-in fingerprints and required technical identifiers.
 */
export function validateEnhancedCorePrompt(
    candidate: string,
    options: {
        requiredToolNames: readonly string[]
        requiredCwd?: string
        hadGitSection?: boolean
        mutableCorePrompt?: string
    },
): { ok: true; cleaned: string } | { ok: false; reasons: string[] } {
    const cleaned = stripOuterCodeFence(candidate)
    const reasons: string[] = []

    let prose = cleaned
    for (const identifier of [...options.requiredToolNames, options.requiredCwd ?? ''].filter(Boolean).sort((a, b) => b.length - a.length)) {
        prose = prose.replace(new RegExp(escapeRegExp(identifier), 'g'), '')
    }
    const proseLength = prose.replace(/[^\p{L}]/gu, '').length
    const sourceLength = options.mutableCorePrompt?.length ?? 0
    const minLength = Math.max(20, Math.ceil(sourceLength * 0.2))
    if (cleaned.length < minLength || proseLength < Math.max(12, Math.ceil(sourceLength * 0.1))) {
        reasons.push(`Synthesized prompt has insufficient instruction substance or is too short (${cleaned.length} chars).`)
    }

    const lower = cleaned.toLowerCase()
    for (const marker of FORBIDDEN_PHRASE_FINGERPRINTS) {
        if (lower.includes(marker)) {
            reasons.push(`Contains forbidden built-in fingerprint: "${marker}"`)
        }
    }
    for (const tagRegex of FORBIDDEN_TAG_REGEXES) {
        const match = cleaned.match(tagRegex)
        if (match) {
            reasons.push(`Contains forbidden built-in fingerprint tag: "${match[0]}"`)
        }
    }
    if (options.hadGitSection) {
        for (const gitRegex of GIT_TAG_REGEXES) {
            const match = cleaned.match(gitRegex)
            if (match) {
                reasons.push(`Contains forbidden built-in fingerprint tag: "${match[0]}"`)
            }
        }
    }

    for (const toolName of options.requiredToolNames) {
        if (toolName && !containsToolIdentifier(cleaned, toolName)) {
            reasons.push(`Missing required exact tool identifier: "${toolName}"`)
        }
    }

    if (options.requiredCwd) {
        const normalizedCwd = options.requiredCwd.replace(/\\/g, '/')
        if (!cleaned.includes(normalizedCwd) && !cleaned.includes(options.requiredCwd)) {
            reasons.push(`Missing required working directory path: "${normalizedCwd}"`)
        }
    }

    if (reasons.length > 0) {
        return { ok: false, reasons }
    }
    return { ok: true, cleaned }
}

function resolveBuilderReasoningEffort(model: ModelCatalogEntry): string | undefined {
    const levels = model.reasoningLevels ?? []
    if (levels.length === 0) return undefined
    const preferred = ['low', 'medium', 'minimal', 'off']
    for (const target of preferred) {
        const found = levels.find((lvl) => lvl.id === target)
        if (found) return found.requestValue
    }
    return levels[0]?.requestValue
}

function buildMetaSystemPrompt(): string {
    return [
        'You are a precision technical prompt architect.',
        'Your sole task is to completely rewrite and restructure a software assistant system prompt into a brand-new, natural, semantically equivalent instruction document.',
        'You must strictly preserve every behavioral constraint, security rule, tool contract, execution order, path, and user-facing reply-language rule while completely eliminating all original phrasing patterns, headings, and XML-like wrapper tags.',
        'Return ONLY the rewritten system prompt body without any preamble, commentary, or markdown code fences.',
    ].join(' ')
}

function buildSynthesisUserPrompt(params: {
    targetLanguage: SystemPromptLanguage
    structuralStyle: string
    entropySeed: string
    mutableCorePrompt: string
    requiredToolNames: readonly string[]
    requiredCwd?: string
    previousViolations?: readonly string[]
}): string {
    const langLabel = LANGUAGE_DISPLAY_NAMES[params.targetLanguage] ?? 'English'
    const lines: string[] = [
        `Target prompt authoring language: ${langLabel}.`,
        `Structural style directive (seed ${params.entropySeed}): ${params.structuralStyle}`,
        '',
        'Mandatory rewriting rules:',
        `1. Write the entire rewritten system prompt itself in ${langLabel}.`,
        '2. Preserve 100% of the operational semantics, tool conditions, sequential requirements (such as calling `title` only when present in declared tools, memory retrieval/recording rules, Code Mode direct vs batching rules, forbidden commands and required replacements, Git/worktree rules, and sub-agent constraints).',
        '3. Decouple prompt language from user reply language: if the source prompt instructs the assistant to respond to the user in a specific language (for example Simplified Chinese or English), preserve that user-facing reply language requirement faithfully in the rewritten prompt even when the prompt itself is authored in another language.',
        '4. Completely eliminate all built-in template headers and XML/pseudo tags such as "Coding Professional Agent", "Available tools:", "Guidelines:", "<skill_names>", "<available_roles>", "<role>", "<git>", "<worktree_mode>", "<project_context>", and "<project_instructions>". Express all such sections naturally in the target language.',
        '5. Verbatim identifier preservation: never translate, alter, or omit any tool name, skill name, sub-agent role id/model id, filesystem path, or git branch name.',
        '6. Output ONLY the final system prompt text. Do NOT wrap the output in ``` code fences or add explanatory remarks.',
    ]

    if (params.requiredToolNames.length > 0) {
        lines.push(
            `7. Exact tool names that MUST appear verbatim in your output: ${params.requiredToolNames.join(', ')}`,
        )
    }
    if (params.requiredCwd) {
        lines.push(
            `8. Exact working directory path that MUST appear verbatim in your output: ${params.requiredCwd.replace(/\\/g, '/')}`,
        )
    }

    if (params.previousViolations && params.previousViolations.length > 0) {
        lines.push(
            '',
            'CRITICAL CORRECTION REQUIRED — Your previous draft failed validation for these exact reasons:',
            ...params.previousViolations.map((v) => `- ${v}`),
            'Fix every listed violation in this attempt.',
        )
    }

    lines.push(
        '',
        'Source system prompt to rewrite:',
        '<<<SOURCE_PROMPT_START>>>',
        params.mutableCorePrompt,
        '<<<SOURCE_PROMPT_END>>>',
    )

    return lines.join('\n')
}

async function collectSynthesisStreamText(
    stream: AsyncIterable<any>,
    signal?: AbortSignal,
): Promise<string> {
    const chunksByIndex = new Map<number, string>()
    let fallbackContentIndex = 0
    let finalEntry: AssistantEntry | undefined
    let doneReason: string | undefined
    const iterator = stream[Symbol.asyncIterator]()

    let failed = false
    try {
        while (true) {
            const next = await iterator.next()
            if (signal?.aborted) {
                throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
            }
            if (next.done) {
                if (next.value && typeof next.value === 'object' && 'kind' in next.value) {
                    finalEntry = next.value as AssistantEntry
                }
                break
            }
            const event = next.value
            if (!event || typeof event !== 'object') continue

            if (event.type === 'text-delta') {
                const idx =
                    typeof event.contentIndex === 'number' && Number.isFinite(event.contentIndex)
                        ? event.contentIndex
                        : fallbackContentIndex
                const delta =
                    typeof event.delta === 'string'
                        ? event.delta
                        : typeof event.text === 'string'
                          ? event.text
                          : ''
                if (delta.length > 0) {
                    chunksByIndex.set(idx, (chunksByIndex.get(idx) ?? '') + delta)
                }
            } else if (event.type === 'text-end') {
                const idx =
                    typeof event.contentIndex === 'number' && Number.isFinite(event.contentIndex)
                        ? event.contentIndex
                        : fallbackContentIndex++
                if (
                    typeof event.content === 'string' &&
                    (event.content.length > 0 || !chunksByIndex.has(idx))
                ) {
                    chunksByIndex.set(idx, event.content)
                }
            } else if (event.type === 'done') {
                if (typeof event.reason === 'string') {
                    doneReason = event.reason
                }
                if (event.message) {
                    finalEntry = event.message as AssistantEntry
                }
            } else if (event.type === 'error') {
                if (event.reason === 'aborted') {
                    throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
                }
                const errMsg = event.error?.errorMessage || 'Synthesis model returned stream error'
                throw new Error(errMsg)
            }
        }
    } catch (error) {
        failed = true
        throw error
    } finally {
        try {
            await iterator.return?.()
        } catch (error) {
            // Preserve the original stream failure or cancellation when cleanup also fails.
            if (!failed) throw error
        }
    }

    if (
        signal?.aborted ||
        doneReason === 'aborted' ||
        finalEntry?.stopReason === 'aborted' ||
        finalEntry?.status === 'aborted'
    ) {
        throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
    }
    if (finalEntry?.stopReason === 'error' || finalEntry?.status === 'error') {
        throw new Error(finalEntry.errorMessage || 'Synthesis model returned error entry')
    }
    if (doneReason === 'length' || finalEntry?.stopReason === 'length') {
        throw new Error('Synthesis output truncated (max tokens length reached)')
    }
    if (doneReason !== 'stop' && finalEntry?.stopReason !== 'stop') {
        throw new Error('Synthesis stream ended without clean stop completion')
    }

    if (finalEntry && Array.isArray(finalEntry.content)) {
        const finalText = finalEntry.content
            .filter(
                (block): block is { type: 'text'; text: string } =>
                    block.type === 'text' && typeof block.text === 'string',
            )
            .map((block) => block.text)
            .join('')
        if (finalText.trim().length > 0) {
            return finalText
        }
    }
    const streamedText = Array.from(chunksByIndex.entries())
        .sort(([a], [b]) => a - b)
        .map(([, chunk]) => chunk)
        .join('')
    if (streamedText.trim().length > 0) {
        return streamedText
    }
    return ''
}

export interface SynthesizeEnhancedSystemPromptInput {
    client: ProtocolClient
    model: ModelCatalogEntry
    mutableCorePrompt: string
    verbatimContextPrompt: string
    enhancement: SystemPromptEnhancementSettings
    requiredToolNames: readonly string[]
    requiredCwd?: string
    hadGitSection?: boolean
    sessionId?: string
    signal?: AbortSignal
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    randomFloat?: () => number
    generateId?: () => string
    now?: () => number
}

/**
 * Synthesize a unique per-session enhanced system prompt via an isolated model call.
 * Retries up to 2 times on validation or transient errors, and fails closed on exhaustion.
 */
export async function synthesizeEnhancedSystemPrompt(
    input: SynthesizeEnhancedSystemPromptInput,
): Promise<string> {
    const randomFloat = input.randomFloat ?? defaultRandomFloat
    const generateId = input.generateId ?? defaultGenerateId
    const now = input.now ?? Date.now
    const sleep = input.sleep ?? defaultSleep

    const targetLanguage = pickTargetPromptLanguage(input.enhancement, randomFloat)
    const styleRaw = randomFloat()
    const styleIdx = Math.floor(
        (Number.isFinite(styleRaw) ? Math.min(0.999999999, Math.max(0, styleRaw)) : 0) *
            STRUCTURAL_STYLES.length,
    )
    const structuralStyle = STRUCTURAL_STYLES[styleIdx] ?? STRUCTURAL_STYLES[0]!
    const entropySeed = generateId().slice(0, 12)
    const reasoningEffort = resolveBuilderReasoningEffort(input.model)
    const metaSystemPrompt = buildMetaSystemPrompt()

    let previousViolations: string[] | undefined
    let lastErrorMessage = 'System prompt enhancement synthesis failed'

    for (let attempt = 0; attempt < MAX_SYNTHESIS_ATTEMPTS; attempt++) {
        if (input.signal?.aborted) {
            throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
        }

        const userPromptText = buildSynthesisUserPrompt({
            targetLanguage,
            structuralStyle,
            entropySeed,
            mutableCorePrompt: input.mutableCorePrompt,
            requiredToolNames: input.requiredToolNames,
            requiredCwd: input.requiredCwd,
            previousViolations,
        })

        const userEntry: UserEntry = {
            id: generateId(),
            sessionId: input.sessionId ?? 'system-prompt-enhancer',
            createdAt: now(),
            kind: 'user',
            content: [{ type: 'text', text: userPromptText }],
        }
        const seed: AssistantEntry = {
            id: generateId(),
            sessionId: input.sessionId ?? 'system-prompt-enhancer',
            createdAt: now(),
            kind: 'assistant',
            model: input.model.id,
            content: [],
            status: 'streaming',
            stopReason: 'pending',
        }

        try {
            const stream = input.client.stream(
                {
                    model: input.model,
                    systemPrompt: metaSystemPrompt,
                    entries: [userEntry],
                    tools: [],
                    reasoningEffort,
                    seed,
                },
                {
                    connectionMode: 'isolated',
                    promptCacheKey: generateId(),
                    signal: input.signal,
                },
            )

            const candidate = await collectSynthesisStreamText(stream, input.signal)
            const validation = validateEnhancedCorePrompt(candidate, {
                requiredToolNames: input.requiredToolNames,
                requiredCwd: input.requiredCwd,
                hadGitSection: input.hadGitSection,
                mutableCorePrompt: input.mutableCorePrompt,
            })

            if (validation.ok) {
                const verbatim = input.verbatimContextPrompt
                return verbatim ? `${validation.cleaned}\n\n${verbatim}` : validation.cleaned
            }

            previousViolations = validation.reasons
            lastErrorMessage = `Validation failed: ${validation.reasons.join('; ')}`
        } catch (error) {
            if (
                input.signal?.aborted ||
                (error instanceof AgentPreflightError && error.code === 'aborted') ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                throw new AgentPreflightError('aborted', 'System prompt enhancement aborted')
            }
            lastErrorMessage = error instanceof Error ? error.message : String(error)
            previousViolations = undefined
        }

        if (attempt < MAX_SYNTHESIS_ATTEMPTS - 1) {
            const delayMs = RETRY_DELAYS_MS[attempt] ?? 1000
            if (!previousViolations) {
                await sleep(delayMs, input.signal)
            }
        }
    }

    throw new AgentPreflightError(
        'system_prompt_enhancement_failed',
        `Failed to synthesize enhanced system prompt after ${MAX_SYNTHESIS_ATTEMPTS} attempts: ${lastErrorMessage}`,
    )
}
