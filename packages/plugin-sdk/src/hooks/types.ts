/**
 * Types and schema definitions for the Hook system.
 * Follows CPA hook execution protocols and lifecycle events.
 */

import type {
    AgentHookHandlerConfig,
    CommandHookHandlerConfig,
    HookConfiguration,
    HookEventName,
    HookEventsConfig,
    HookHandlerConfig,
    HookHandlerType,
    HookMetadata,
    HookSource,
    HookState,
    HookTrustStatus,
    HooksConfigFile,
    MatcherGroup,
    McpToolHookHandlerConfig,
    PromptHookHandlerConfig,
} from '@cpa/plugin-api'
import type { NativeBridge } from '../agentAdapter.js'

export type {
    NativeBridge,
    AgentHookHandlerConfig,
    CommandHookHandlerConfig,
    HookConfiguration,
    HookEventName,
    HookEventsConfig,
    HookHandlerConfig,
    HookHandlerType,
    HookMetadata,
    HookSource,
    HookState,
    HookTrustStatus,
    HooksConfigFile,
    MatcherGroup,
    McpToolHookHandlerConfig,
    PromptHookHandlerConfig,
}

export const HOOK_EVENT_NAMES = [
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'SubagentStart',
    'SubagentStop',
    'Stop',
] as const

export const HOOK_EVENT_NAMES_WITH_MATCHERS: readonly HookEventName[] = [
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
]

export type HookExecutionMode = 'sync' | 'async'
export type HookRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'stopped'
export type HookOutputEntryKind = 'warning' | 'stop' | 'feedback' | 'context' | 'error'

export interface HookOutputEntry {
    kind: HookOutputEntryKind
    text: string
}

export interface HookRunSummary {
    id: string
    eventName: HookEventName
    handlerType: HookHandlerType
    executionMode: HookExecutionMode
    command?: string
    mcpServer?: string
    mcpTool?: string
    status: HookRunStatus
    startTime: number
    endTime?: number
    durationMs?: number
    exitCode?: number
    entries: HookOutputEntry[]
    error?: string
    source: HookSource
    sourcePath: string
    pluginId: string | null
}

export interface BaseHookInput {
    hook_event_name: HookEventName
    session_id: string
    cwd: string
}

export interface PreToolUseInput extends BaseHookInput {
    hook_event_name: 'PreToolUse'
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id?: string
    model?: string
    permission_mode?: string
}

export interface PermissionRequestInput extends BaseHookInput {
    hook_event_name: 'PermissionRequest'
    tool_name: string
    tool_input: Record<string, unknown>
    tool_use_id?: string
    model?: string
    permission_mode?: string
}

export interface PostToolUseInput extends BaseHookInput {
    hook_event_name: 'PostToolUse'
    tool_name: string
    tool_input: Record<string, unknown>
    tool_output?: unknown
    tool_error?: boolean
    tool_use_id?: string
    model?: string
    permission_mode?: string
}

export interface UserPromptSubmitInput extends BaseHookInput {
    hook_event_name: 'UserPromptSubmit'
    prompt: string
    model?: string
    permission_mode?: string
}

export interface SessionStartInput extends BaseHookInput {
    hook_event_name: 'SessionStart'
    source: 'startup' | 'resume' | 'clear'
    model?: string
    permission_mode?: string
}

export interface SessionEndInput extends BaseHookInput {
    hook_event_name: 'SessionEnd'
    reason?: string
}

export interface PreCompactInput extends BaseHookInput {
    hook_event_name: 'PreCompact'
    trigger: 'auto' | 'manual'
}

export interface PostCompactInput extends BaseHookInput {
    hook_event_name: 'PostCompact'
    trigger: 'auto' | 'manual'
}

export interface SubagentStartInput extends BaseHookInput {
    hook_event_name: 'SubagentStart'
    subagent_id: string
    name?: string
    task?: string
    model?: string
}

export interface SubagentStopInput extends BaseHookInput {
    hook_event_name: 'SubagentStop'
    subagent_id: string
    name?: string
    outcome?: string
    error?: string
}

export interface StopInput extends BaseHookInput {
    hook_event_name: 'Stop'
    stop_reason?: string
    reason?: string
    model?: string
    permission_mode?: string
}

export type HookInputPayload =
    | PreToolUseInput
    | PermissionRequestInput
    | PostToolUseInput
    | UserPromptSubmitInput
    | SessionStartInput
    | SessionEndInput
    | PreCompactInput
    | PostCompactInput
    | SubagentStartInput
    | SubagentStopInput
    | StopInput

export interface StatelessHookOutput {
    continue?: boolean
    stopReason?: string
    systemMessage?: string
}

export interface PreToolUseSpecificOutput {
    hookEventName: 'PreToolUse'
    permissionDecision?: 'allow' | 'deny' | 'ask'
    updatedInput?: Record<string, unknown>
    additionalContext?: string
}

export interface PreToolUseOutput extends StatelessHookOutput {
    decision?: 'approve' | 'block'
    reason?: string
    hookSpecificOutput?: PreToolUseSpecificOutput
}

export interface PermissionRequestSpecificOutput {
    hookEventName: 'PermissionRequest'
    decision?: 'allow' | 'deny' | 'ask'
}

export interface PermissionRequestOutput extends StatelessHookOutput {
    decision?: 'allow' | 'deny' | 'ask'
    hookSpecificOutput?: PermissionRequestSpecificOutput
}

export interface PostToolUseSpecificOutput {
    hookEventName: 'PostToolUse'
    additionalContext?: string
}

export interface PostToolUseOutput extends StatelessHookOutput {
    hookSpecificOutput?: PostToolUseSpecificOutput
}

export interface UserPromptSubmitSpecificOutput {
    hookEventName: 'UserPromptSubmit'
    additionalContext?: string
    updatedPrompt?: string
}

export interface UserPromptSubmitOutput extends StatelessHookOutput {
    hookSpecificOutput?: UserPromptSubmitSpecificOutput
}

export interface SessionStartSpecificOutput {
    hookEventName: 'SessionStart'
    additionalContext?: string
}

export interface SessionStartOutput extends StatelessHookOutput {
    hookSpecificOutput?: SessionStartSpecificOutput
}

export interface SubagentStartSpecificOutput {
    hookEventName: 'SubagentStart'
    additionalContext?: string
}

export interface SubagentStartOutput extends StatelessHookOutput {
    hookSpecificOutput?: SubagentStartSpecificOutput
}

export interface HookOutcome {
    shouldStop: boolean
    stopReason?: string
    systemMessage?: string
    additionalContexts: string[]
    summaries: HookRunSummary[]
}

export interface PreToolUseOutcome extends HookOutcome {
    decision: 'approve' | 'block'
    blockReason?: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    updatedInput?: Record<string, unknown>
}

export interface PermissionRequestOutcome extends HookOutcome {
    decision?: 'allow' | 'deny' | 'ask'
}

export interface PostToolUseOutcome extends HookOutcome {}

export interface UserPromptSubmitOutcome extends HookOutcome {
    updatedPrompt?: string
    updatedInput?: string
}

export interface SessionStartOutcome extends HookOutcome {}

export interface PreCompactOutcome extends HookOutcome {}

export interface PostCompactOutcome extends HookOutcome {}

export interface SubagentStartOutcome extends HookOutcome {}

export interface SubagentStopOutcome extends HookOutcome {}

export interface StopOutcome extends HookOutcome {}
