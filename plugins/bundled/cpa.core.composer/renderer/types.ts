import type {
    ComposerAttachment,
    ComposerImage,
    ComposerRunStatus,
    ModelCatalogEntry,
    ModelReasoningOption,
} from '@cpa/plugin-api'
import type { ImageProcessor, SupportedImageMimeType } from './utils/image.js'
import type { SkillUsageCountsInput } from '@cpa/plugin-ui'

export type {
    ComposerAttachment,
    ComposerImage,
    ComposerRunStatus,
    ModelCatalogEntry,
    ModelReasoningOption,
    ImageProcessor,
    SupportedImageMimeType,
}

export type ComposerAttachmentKind = 'image' | 'file' | 'folder'
export type WorkLocation = 'local' | 'worktree'
export type ActiveSubmenu = 'model' | 'reasoning' | 'speed' | 'model-options' | null

export type DimensionProbe = (
    bytes: Uint8Array,
    mimeType: string,
) => Promise<{ width: number; height: number } | null>

export interface ComposerSendPayload {
    text: string
    images: ComposerImage[]
    attachments?: ComposerAttachment[]
    expandedText?: string
    projectId?: string | null
    branch?: string | null
    workLocation?: WorkLocation
    environmentId?: string | null
    followUpMode?: 'steer' | 'queue'
    [key: string]: unknown
}

export interface ComposerProps {
    sessionId?: string | null
    onSend: (payload: ComposerSendPayload) => void | Promise<void>
    isStreaming?: boolean
    runStatus?: ComposerRunStatus
    onStop?: () => void
    onResume?: () => void | Promise<void>
    canResume?: boolean
    isTurnComplete?: boolean
    onCompact?: (focus: string) => void | Promise<void>
    skills?: readonly Skill[]
    prompts?: readonly PromptTemplate[]
    skillUsageCounts?: SkillUsageCountsInput
    imageProcessor?: ImageProcessor
    dimensionProbe?: DimensionProbe
    supportsImages?: boolean
    className?: string
}

export interface Skill {
    name: string
    description: string
    filePath: string
    baseDir: string
    disableModelInvocation: boolean
    body: string
}

export interface PromptTemplate {
    name: string
    description: string
    argumentHint?: string
    content: string
    filePath: string
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

export const FALLBACK_MODEL_CATALOG: readonly ModelCatalogEntry[] = [
    {
        id: 'gpt-5-codex',
        label: 'GPT-5 CPA',
        contextWindow: 200_000,
        maxTokens: 16_384,
        supportsFast: true,
        reasoningLevels: CANONICAL_REASONING_OPTIONS,
        input: ['text', 'image'],
    },
    {
        id: 'claude-3-7-sonnet',
        label: 'Claude 3.7 Sonnet',
        contextWindow: 200_000,
        maxTokens: 16_384,
        supportsFast: false,
        reasoningLevels: CANONICAL_REASONING_OPTIONS,
        input: ['text', 'image'],
    },
]
