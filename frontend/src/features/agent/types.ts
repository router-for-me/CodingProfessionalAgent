/**
 * Canonical agent service contracts for the production CLIProxyAPI runtime.
 * Production code streams AgentRunEvent only.
 */

import type { ModelCatalogEntry } from '@/features/models/types'
import type { GitSettings, PersonalityTone, Speed, SubagentsSettings } from '@/types/models'
import type { CompactionSettings } from '@/features/agent-runtime/context/tokenEstimate'
import type { AgentRunEvent, AgentTool } from '@/features/agent-runtime/agent/types'
import type { WorktreeRunPolicy } from '@/features/agent-runtime/context/worktreeMode'
import type {
    CompactionEntry,
    ConversationEntry,
    UserEntry,
} from '@/features/agent-runtime/session/types'
import type {
    ResourceDiagnostic,
    ResourceSnapshot,
} from '@/features/agent-runtime/context/resourceLoader'

import type { PromptTemplate, Skill } from '@cpa/plugin-sdk'
import type { AgentGenerationSnapshot } from '@/features/agent-runtime/providers/generationSnapshot'

export type AgentPreflightErrorCode =
    | 'worktree_persistence_failed'
    | 'invalid_worktree_policy'
    | 'invalid_base_url'
    | 'missing_api_key'
    | 'model_not_found'
    | 'invalid_reasoning'
    | 'disposed'
    | 'run_active'
    | 'message_gone'
    | 'compact_failed'
    | 'session_gone'
    | 'aborted'
    | 'connection_dispose_failed'
    | 'stale_prepare'
    | 'service_busy'
    | 'config_change_during_run'

export class AgentPreflightError extends Error {
    readonly code: AgentPreflightErrorCode
    readonly i18nKey: string

    constructor(
        code: AgentPreflightErrorCode,
        message: string,
        i18nKey?: string,
    ) {
        super(message)
        this.name = 'AgentPreflightError'
        this.code = code
        this.i18nKey = i18nKey ?? `agent.preflight.${code}`
    }
}

export interface AgentPrepareInput {
    baseUrl: string
    apiKey: string
    modelId: string
    models: readonly ModelCatalogEntry[]
    reasoningLevel: string
    speed: Speed
    requestApproval?: boolean
    /** Auto-compact when context exceeds this percent of the model window. */
    compactionThresholdPercent?: number
    /** Lower expensive reasoning levels for context summarization. Defaults to true. */
    fastContextCompaction?: boolean
    /** Primary absolute project path; retained for single-path callers. */
    projectPath?: string | null
    /** All absolute source folders available to this project. */
    projectPaths?: readonly string[] | null
    /** Abort prepare (resource load / config rotation wait). */
    signal?: AbortSignal
    /** User's UI language / locale (e.g. 'zh-CN', 'en'). */
    language?: string
    /** User's selected personality tone constraint. */
    personality?: PersonalityTone
    /** Enable local memory context injection and tools. Defaults to true. */
    localMemoryEnabled?: boolean
    /** Optional schedule identifier for scheduled task sessions. */
    scheduleId?: string | null
    /** Optional target session identifier. */
    sessionId?: string | null
    /** Optional loader for session entries used by subagent resume/spawn. */
    getEntries?: (sessionId: string) => Promise<ConversationEntry[]> | ConversationEntry[]
    /** Optional Git worktree runtime policy constraints. */
    worktreePolicy?: WorktreeRunPolicy
    /** Optional protocol provider ID (e.g. 'codex-responses-ws'). */
    protocolProviderId?: string
    /** Optional model catalog entry override (useful in tests). */
    model?: ModelCatalogEntry
    /** Optional Subagents execution settings. */
    subagentsSettings?: SubagentsSettings
    /** Optional Git settings. */
    gitSettings?: Partial<GitSettings>
}

/**
 * Immutable prepared run bundle. Consumers must not mutate nested refs;
 * the service owns tools/snapshot for the upcoming stream/compact call.
 */
export interface PreparedAgentRun {
    readonly baseUrl: string
    readonly apiKey: string
    readonly model: ModelCatalogEntry
    /** Immutable authorized model catalog captured during prepare. */
    readonly models?: readonly ModelCatalogEntry[]
    /** Mapped catalog requestValue; omitted when model has no reasoning options. */
    readonly reasoningEffort?: string
    readonly speed: 'standard' | 'fast' | string
    readonly requestApproval?: boolean
    readonly compactionSettings?: CompactionSettings
    readonly fastContextCompaction: boolean
    readonly agentDir: string
    /** Valid absolute existing primary directory, or undefined for pure chat. */
    readonly projectCwd?: string
    /** Valid absolute existing source folders available to the run. */
    readonly projectPaths: readonly string[]
    readonly tools: readonly AgentTool[]
    readonly snapshot: ResourceSnapshot
    readonly diagnostics: readonly ResourceDiagnostic[]
    readonly systemPrompt: string
    readonly supportsImages: boolean
    readonly skills: readonly Skill[]
    readonly prompts: readonly PromptTemplate[]
    /** User's UI language / locale (e.g. 'zh-CN', 'en'). */
    readonly language?: string
    /** User's selected personality tone constraint. */
    readonly personality?: PersonalityTone
    readonly protocolProviderId?: string
    readonly worktreePolicy?: WorktreeRunPolicy
    readonly subagentsSettings?: SubagentsSettings
    readonly gitSettings?: Partial<GitSettings>
    /** Frozen snapshot of providers, tools, resources, hooks, middleware, and lease for this run. */
    readonly generationSnapshot?: AgentGenerationSnapshot
}

export interface AgentStreamChatInput {
    prepared: PreparedAgentRun
    sessionId: string
    runId: string
    /** Existing conversation entries (before or including userEntry). */
    entries: readonly ConversationEntry[]
    userEntry?: UserEntry
    signal?: AbortSignal
    /** Optional dynamic runtime settings resolver called before each LLM turn/request */
    getRuntimeSettings?: () => {
        reasoningEffort?: string
        reasoningLevel?: string
        speed?: string
    } | undefined
    /** Optional callback returning a pending steer user entry to inject after the current LLM request or tool execution */
    consumeSteerEntry?: () => UserEntry | undefined
    /** Optional callback returning all pending steer user entries to inject after the current LLM request or tool execution */
    consumeSteerEntries?: () => UserEntry[] | undefined
}

export interface AgentCompactInput {
    prepared: PreparedAgentRun
    sessionId: string
    runId: string
    entries: readonly ConversationEntry[]
    customInstructions?: string
    signal?: AbortSignal
}

export type AgentCompactResult =
    | {
          ok: true
          entry: CompactionEntry
          events: readonly AgentRunEvent[]
      }
    | {
          ok: false
          message: string
          code?: string
          events?: readonly AgentRunEvent[]
      }

/** Legacy events retained for isolated unit fixtures. Not used in production. */
export type AgentEvent =
    | { type: 'text-delta'; text: string }
    | {
          type: 'tool-start'
          id: string
          name: string
          args: Record<string, unknown>
      }
    | { type: 'tool-approval-required'; id: string }
    | { type: 'tool-result'; id: string; result: string }
    | { type: 'message-end' }
    | { type: 'error'; message: string }

/** Legacy mock stream input. */
export interface StreamChatInput {
    sessionId: string
    messages: import('@/types/models').Message[]
    modelId: string
    requestApproval?: boolean
    signal?: AbortSignal
    locale?: import('@/types/models').Locale
    kind?: import('./templates').QuickActionKind | 'general'
}

export type ToolDecision = 'approved' | 'rejected'
