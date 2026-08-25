/**
 * Types and schema definitions for the Hook system.
 * Follows CPA hook execution protocols and lifecycle events.
 */

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

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number]

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

export type HookHandlerType = 'command' | 'mcp_tool' | 'prompt' | 'agent'
export type HookExecutionMode = 'sync' | 'async'
export type HookSource = 'user' | 'project' | 'plugin' | 'system'
export type HookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'
export type HookRunStatus = 'running' | 'completed' | 'failed' | 'blocked' | 'stopped'
export type HookOutputEntryKind = 'warning' | 'stop' | 'feedback' | 'context' | 'error'

export interface CommandHookHandlerConfig {
    type: 'command'
    command: string
    timeout?: number
    async?: boolean
    statusMessage?: string
    additionalContextLimit?: number
}

export interface McpToolHookHandlerConfig {
    type: 'mcp_tool'
    server: string
    tool: string
    input?: Record<string, unknown>
    timeout?: number
    statusMessage?: string
}

export interface PromptHookHandlerConfig {
    type: 'prompt'
}

export interface AgentHookHandlerConfig {
    type: 'agent'
}

export type HookHandlerConfig =
    | CommandHookHandlerConfig
    | McpToolHookHandlerConfig
    | PromptHookHandlerConfig
    | AgentHookHandlerConfig

export interface MatcherGroup {
    matcher?: string
    hooks: HookHandlerConfig[]
}

export type HookEventsConfig = {
    [K in HookEventName]?: MatcherGroup[]
}

export interface HookState {
    enabled?: boolean
    trusted_hash?: string
}

export interface HooksConfigFile {
    description?: string
    hooks?: HookEventsConfig
    state?: Record<string, HookState>
}

export interface HookMetadata {
    key: string
    eventName: HookEventName
    matcher: string | null
    timeoutSec: number
    statusMessage: string | null
    additionalContextLimit: number | null
    sourcePath: string
    source: HookSource
    pluginId: string | null
    displayOrder: number
    enabled: boolean
    isManaged: boolean
    currentHash: string
    trustStatus: HookTrustStatus
    handler: HookHandlerConfig
}

export interface HookOutputEntry {
    kind: HookOutputEntryKind
    text: string
}

export interface HookRunSummary {
    id: string
    eventName: HookEventName
    handlerType: HookHandlerType
    executionMode: HookExecutionMode
    sourcePath: string
    source: HookSource
    displayOrder: number
    status: HookRunStatus
    statusMessage?: string
    startedAt: number
    completedAt?: number
    durationMs?: number
    entries: HookOutputEntry[]
}

export interface NativeStat {
    isDir: boolean
    isFile: boolean
    sizeBytes: number
    mode?: number
    mtimeMs?: number
    isSymlink?: boolean
    target?: string
}

export interface NativeDirEntry {
    name: string
    isDir: boolean
    isFile: boolean
    isSymlink?: boolean
    sizeBytes?: number
    mtimeMs?: number
}

export interface NativeEvent {
    type?: string
    kind?: string
    operationId?: string
    sequence?: number
    data?: string
    encoding?: string
    exitCode?: number
    error?: string
    [key: string]: unknown
}

export interface ProcessStartInput {
    operationId: string
    executable: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    stdin?: string
    signal?: AbortSignal
}

export interface NativeOperation {
    readonly operationId: string
    readonly events: AsyncIterable<NativeEvent>
}

export interface ProcessOperation extends NativeOperation {
    readonly fullOutputPath: string
}

export interface NativeBridge {
    stat(path: string): Promise<NativeStat>
    readFile(path: string): Promise<Uint8Array>
    readFileIfExists?(path: string): Promise<Uint8Array | null>
    writeFile(path: string, data: Uint8Array): Promise<void>
    mkdirAll(path: string): Promise<void>
    readDir(path: string): Promise<readonly NativeDirEntry[]>
    removeFile(path: string): Promise<void>
    removeDir?(path: string, options?: { recursive?: boolean }): Promise<void>
    lookPath(name: string): Promise<string | null>
    realPath(path: string): Promise<string>
    runtimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }>
    startProcess(input: ProcessStartInput): Promise<ProcessOperation>
    cancel?(operationId: string): Promise<void>
}

// Event Input Payloads

export interface PreToolUseInput {
    hook_event_name: 'PreToolUse'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    tool_name: string
    tool_input: unknown
    tool_use_id: string
    agent_id?: string
    agent_type?: string
}

export interface PostToolUseInput {
    hook_event_name: 'PostToolUse'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    tool_name: string
    tool_input: unknown
    tool_output?: unknown
    tool_error?: string
    tool_use_id: string
    agent_id?: string
    agent_type?: string
}

export interface PermissionRequestInput {
    hook_event_name: 'PermissionRequest'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    tool_name: string
    tool_input: unknown
    tool_use_id: string
}

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

export interface SessionStartInput {
    hook_event_name: 'SessionStart'
    session_id: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    source: SessionStartSource
}

export interface SessionEndInput {
    hook_event_name: 'SessionEnd'
    session_id: string
    cwd: string
    transcript_path?: string | null
    reason: string
}

export interface UserPromptSubmitInput {
    hook_event_name: 'UserPromptSubmit'
    session_id: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    prompt: string
}

export interface PreCompactInput {
    hook_event_name: 'PreCompact'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    trigger: 'auto' | 'manual'
}

export interface PostCompactInput {
    hook_event_name: 'PostCompact'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    trigger: 'auto' | 'manual'
}

export interface SubagentStartInput {
    hook_event_name: 'SubagentStart'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    agent_id: string
    agent_type: string
}

export interface SubagentStopInput {
    hook_event_name: 'SubagentStop'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    agent_id: string
    agent_type: string
    reason: string
}

export interface StopInput {
    hook_event_name: 'Stop'
    session_id: string
    turn_id?: string
    cwd: string
    transcript_path?: string | null
    model: string
    permission_mode: string
    stop_reason: string
    last_assistant_message?: string
}

// Event Output / Wire Schemas

export interface HookOutputCommon {
    continue?: boolean
    stopReason?: string
    suppressOutput?: boolean
    systemMessage?: string
}

export interface PreToolUseSpecificOutput {
    hookEventName?: 'PreToolUse'
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: unknown
    additionalContext?: string
}

export interface PreToolUseOutput extends HookOutputCommon {
    decision?: 'approve' | 'block'
    reason?: string
    hookSpecificOutput?: PreToolUseSpecificOutput
}

export interface PermissionRequestOutput extends HookOutputCommon {
    decision?: 'allow' | 'deny' | 'ask'
    reason?: string
}

export interface PostToolUseSpecificOutput {
    hookEventName?: 'PostToolUse'
    additionalContext?: string
}

export interface PostToolUseOutput extends HookOutputCommon {
    hookSpecificOutput?: PostToolUseSpecificOutput
}

export interface SessionStartSpecificOutput {
    hookEventName?: 'SessionStart'
    additionalContext?: string
}

export interface SessionStartOutput extends HookOutputCommon {
    hookSpecificOutput?: SessionStartSpecificOutput
}

export interface UserPromptSubmitSpecificOutput {
    hookEventName?: 'UserPromptSubmit'
    additionalContext?: string
}

export interface UserPromptSubmitOutput extends HookOutputCommon {
    hookSpecificOutput?: UserPromptSubmitSpecificOutput
}

export interface SubagentStartSpecificOutput {
    hookEventName?: 'SubagentStart'
    additionalContext?: string
}

export interface SubagentStartOutput extends HookOutputCommon {
    hookSpecificOutput?: SubagentStartSpecificOutput
}

export type StatelessHookOutput = HookOutputCommon

// Outcome types from the Hook Engine

export interface PreToolUseOutcome {
    shouldStop: boolean
    stopReason?: string
    decision: 'approve' | 'block'
    blockReason?: string
    permissionDecision?: 'allow' | 'deny' | 'ask'
    permissionDecisionReason?: string
    updatedInput?: unknown
    additionalContexts: string[]
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface PostToolUseOutcome {
    shouldStop: boolean
    stopReason?: string
    additionalContexts: string[]
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface PermissionRequestOutcome {
    shouldStop: boolean
    stopReason?: string
    decision: 'allow' | 'deny' | 'ask'
    decisionReason?: string
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface SessionStartOutcome {
    shouldStop: boolean
    stopReason?: string
    additionalContexts: string[]
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface UserPromptSubmitOutcome {
    shouldStop: boolean
    stopReason?: string
    additionalContexts: string[]
    systemMessages: string[]
    systemMessage?: string
    updatedPrompt?: string
    updatedInput?: string
    hookSummaries: HookRunSummary[]
}

export interface PreCompactOutcome {
    shouldStop: boolean
    stopReason?: string
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface PostCompactOutcome {
    shouldStop: boolean
    stopReason?: string
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface SubagentStartOutcome {
    shouldStop: boolean
    stopReason?: string
    additionalContexts: string[]
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface SubagentStopOutcome {
    shouldStop: boolean
    stopReason?: string
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}

export interface StopOutcome {
    shouldStop: boolean
    stopReason?: string
    systemMessages: string[]
    hookSummaries: HookRunSummary[]
}
