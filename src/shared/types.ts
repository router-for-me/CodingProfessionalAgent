import type {
  AgentRunStatus,
  AppSettings,
  CliProxyApiSettings,
  CommandHookHandlerConfig,
  GitMergeMethod,
  GitReviewPresentation,
  GitSettings,
  HookConfiguration,
  HookEventName,
  HookHandlerConfig,
  HookMetadata,
  HooksConfigFile,
  HostServices,
  HookService,
  Locale,
  MatcherGroup,
  MessageRole,
  MessageStatus,
  ModelCustomConfig,
  ModelSettingsConfig,
  NavigationService,
  NotificationInput,
  NotificationService,
  PersonalityTone,
  Project,
  ProjectEnvironmentAction,
  ProjectEnvironmentScripts,
  ProjectService,
  PromptHookHandlerConfig,
  ReasoningLevel,
  SavedShortcutItem,
  SessionItem,
  SessionRightSidebarState,
  SessionService,
  SessionUnreadState,
  SettingsService,
  ShortcutItem,
  ShortcutKeyBinding,
  ShortcutsConfig,
  ShortcutsMap,
  Speed,
  TerminalPosition,
  ThemeMode,
  ToolStatus,
  UserProfileSettings,
  WebServerSettings,
  WorktreeService,
  WorktreeSessionSetup,
  WorktreeSettings,
  WorktreeSetupInput,
  WorktreeSetupResult,
  WorktreeSetupStatus,
  WorktreeSetupStepStatus,
  ResolvedPluginGraphDTO,
  ResolvedPluginNodeDTO,
  BlockedPluginDTO,
} from '@cpa/plugin-api'
import type { UpdateStatusSnapshot } from './updateTypes.js'

export type {
  AgentRunStatus,
  AppSettings,
  CliProxyApiSettings,
  CommandHookHandlerConfig,
  GitMergeMethod,
  GitReviewPresentation,
  GitSettings,
  HookConfiguration,
  HookEventName,
  HookHandlerConfig,
  HookMetadata,
  HooksConfigFile,
  HostServices,
  HookService,
  Locale,
  MatcherGroup,
  MessageRole,
  MessageStatus,
  ModelCustomConfig,
  ModelSettingsConfig,
  NavigationService,
  NotificationInput,
  NotificationService,
  PersonalityTone,
  Project,
  ProjectEnvironmentAction,
  ProjectEnvironmentScripts,
  ProjectService,
  PromptHookHandlerConfig,
  ReasoningLevel,
  SavedShortcutItem,
  SessionItem,
  SessionRightSidebarState,
  SessionService,
  SessionUnreadState,
  SettingsService,
  ShortcutItem,
  ShortcutKeyBinding,
  ShortcutsConfig,
  ShortcutsMap,
  Speed,
  TerminalPosition,
  ThemeMode,
  ToolStatus,
  UserProfileSettings,
  WebServerSettings,
  WorktreeService,
  WorktreeSessionSetup,
  WorktreeSettings,
  WorktreeSetupInput,
  WorktreeSetupResult,
  WorktreeSetupStatus,
  WorktreeSetupStepStatus,
  ResolvedPluginGraphDTO,
  ResolvedPluginNodeDTO,
  BlockedPluginDTO,
}

export type NativeEventEncoding = 'utf8' | 'base64'

export type AgentRunEvent =
  | { type: 'agent-start'; runId: string; sessionId: string }
  | {
      type: 'agent-end'
      runId: string
      sessionId: string
      entries?: readonly unknown[]
    }
  | {
      type: 'user-entry'
      sessionId: string
      runId: string
      entry: unknown
    }
  | {
      type: 'assistant-start'
      runId: string
      sessionId: string
      entry: unknown
    }
  | {
      type: 'assistant-update'
      runId: string
      sessionId: string
      entry: unknown
      streamEvent: unknown
    }
  | {
      type: 'assistant-end'
      runId: string
      sessionId: string
      entry: unknown
    }
  | {
      type: 'tool-approval-required'
      runId: string
      sessionId: string
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool-start'
      runId: string
      sessionId: string
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
    }
  | {
      type: 'tool-update'
      runId: string
      sessionId: string
      toolCallId: string
      toolName: string
      result: unknown
    }
  | {
      type: 'tool-end'
      runId: string
      sessionId: string
      toolCallId: string
      toolName: string
      result: unknown
      isError: boolean
      entry?: unknown
    }
  | {
      type: 'retrying'
      runId: string
      sessionId: string
      attempt: number
      delayMs: number
      error?: string
    }
  | {
      type: 'compaction-start'
      runId: string
      sessionId: string
    }
  | {
      type: 'compaction-end'
      runId: string
      sessionId: string
      entry?: unknown
    }
  | { type: 'error'; runId: string; sessionId: string; message: string }
  | { type: 'aborted'; runId: string; sessionId: string }
  | {
      type: 'diagnostic'
      runId: string
      sessionId: string
      message: string
      code?: string
    }

export type NativeEventKind =
  | 'websocket-open'
  | 'websocket-text'
  | 'websocket-binary'
  | 'process-stdout'
  | 'process-stderr'
  | 'pty-stdout'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'projects:updated'
  | 'session:meta-updated'
  | 'session:deleted'
  | 'session:entries-updated'
  | 'session:run-status'
  | 'session:stream-event'
  | 'session:subagent-state'
  | 'session:abort-run'
  | 'session:delegate-run'
  | 'session:resume-prompt-state'
  | 'session:resume-prompt-action'
  | (string & {})

export interface NativeEvent {
  operationId: string
  sequence: number
  kind: NativeEventKind
  /** Origin client omitted from fan-out to prevent expensive transport self-echo. */
  sourceClientId?: string
  data?: string
  encoding?: NativeEventEncoding
  exitCode?: number
  closeCode?: number
  reason?: string
  error?: string
}

export const DEFAULT_APP_CONFIG_DIR_NAME = '.coding-professional-agent'
export const DEV_APP_CONFIG_DIR_NAME = '.coding-professional-agent-dev'

export function getAppConfigDirName(isDev?: boolean): string {
  if (typeof isDev === 'boolean') {
    return isDev ? DEV_APP_CONFIG_DIR_NAME : DEFAULT_APP_CONFIG_DIR_NAME
  }
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.CPA_CONFIG_DIR_NAME) {
      return process.env.CPA_CONFIG_DIR_NAME
    }
    if (process.env.CPA_DEV === '1' || process.env.CPA_DEV === 'true') {
      return DEV_APP_CONFIG_DIR_NAME
    }
    if (process.env.CPA_DEV === '0' || process.env.CPA_DEV === 'false') {
      return DEFAULT_APP_CONFIG_DIR_NAME
    }
    if (process.env.NODE_ENV === 'development') {
      return DEV_APP_CONFIG_DIR_NAME
    }
    if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)) {
      return DEFAULT_APP_CONFIG_DIR_NAME
    }
  }
  if (typeof import.meta !== 'undefined') {
    const env = (import.meta as any)?.env
    if (env?.MODE === 'test' || env?.VITEST) {
      return DEFAULT_APP_CONFIG_DIR_NAME
    }
    if (env?.DEV) {
      return DEV_APP_CONFIG_DIR_NAME
    }
  }
  return DEFAULT_APP_CONFIG_DIR_NAME
}

export interface RuntimeInfo {
  platform: string
  userConfigDir: string
  tempDir: string
  homeDir: string
  isDebug?: boolean
  appConfigDirName?: string
}

export interface ProjectDirectorySelection {
  name: string
  path: string
}

export interface SelectedFileOrFolder {
  name: string
  path: string
  isDirectory: boolean
}

export interface FileData {
  dataBase64: string
}

export interface FileStat {
  name: string
  size: number
  mode: number
  isDir: boolean
}

export interface DirEntry {
  name: string
  isDir: boolean
  isSymbolicLink?: boolean
}

export interface ScannedPlugin {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  entryPath: string
  manifestPath: string
  location: 'global' | 'project'
  dirPath: string
  manifest: Record<string, unknown>
}

export interface PluginSourceConfigEntry {
  source: string
  enabled?: boolean
  capabilities?: string[]
}

export interface PluginSourceConfig {
  sources: PluginSourceConfigEntry[]
}

export interface PluginSettings {
  enabledPluginIds?: string[]
  sources?: PluginSourceConfigEntry[]
  [key: string]: unknown
}

export interface ProcessStartRequest {
  operationId: string
  executable: string
  args: string[] | null
  cwd: string
  env: Record<string, string> | null
  stdin?: string
}

export interface ProcessStartResult {
  fullOutputPath: string
}

export interface ProcessRunResult {
  fullOutputPath: string
  stdoutBase64: string
  stderrBase64: string
  exitCode: number
  cancelled?: boolean
  error?: string
}

export interface PtyStartRequest {
  operationId: string
  shell?: string
  cwd: string
  cols: number
  rows: number
}

export interface WebSocketOpenRequest {
  operationId: string
  url: string
  headers: Record<string, string> | null
  connectTimeoutMs: number
}

export interface HttpRequest {
  urlString: string
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

export interface ActiveRunInfo {
  sessionId: string
  runId: string
  clientId: string
  status: 'running' | 'thinking' | 'tool' | 'idle' | 'error'
  error?: string
  updatedAt: number
}

export interface ResumePromptSyncState {
  isOpen: boolean
  totalCount: number
  countdown: number
  unfinishedSessionIds: string[]
  unfinishedSubAgentIds: string[]
}

export interface SessionSearchResultItem {
  sessionId: string
  title: string
  projectId?: string
  branch?: string
  updatedAt: number
  matchType: 'title' | 'content'
  snippet?: string
}

export interface SubAgentItem {
  id: string
  sessionId?: string
  parentSessionId?: string
  parentToolCallId?: string | null
  name?: string
  modelId?: string | null
  reasoningEffort?: string | null
  status?: string
  color?: string | null
  icon?: string | null
  lastMessage?: string | null
  errorMessage?: string | null
  createdAt?: number
  updatedAt?: number
}

export interface SessionDelegateRunRequest {
  sessionId?: string | null
  scheduleId?: string | null
  text: string
  images?: Array<{ data: string; mimeType: string; name?: string }>
  projectId?: string | null
  branch?: string | null
  editMessageId?: string
  userEntryId?: string
  userEntryCreatedAt?: number
}

export interface WebServerStatus {
  running: boolean
  host: string
  port: number
  url: string
  error?: string
  isDebug?: boolean
}

export type MetricTimeGranularity =
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'year'
  | 'all'

export type SubAgentMetricMode =
  | 'rollup_all'
  | 'main_only'
  | 'subagent_only'
  | 'session_id'

export interface QueryMetricsOptions {
  timeGranularity?: MetricTimeGranularity
  timeRange?: [number, number]         // [startTimeMs, endTimeMs]
  projectId?: string                   // filter by project
  modelId?: string                     // filter by model
  groupByProject?: boolean             // group output by projectId
  groupByModel?: boolean               // group output by modelId
  subAgentMode?: SubAgentMetricMode    // default 'rollup_all'
  sessionId?: string                   // when subAgentMode is 'session_id'
  topSkillsLimit?: number              // default 10
  topModelsLimit?: number              // default 10
}

export interface ModelMetricItem {
  modelId: string
  count: number
  totalTokens: number
  percentage?: number
}

export interface AggregateMetrics {
  totalTokens: number
  totalTokensBreakdown: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
  }
  totalCost: number
  maxTaskDurationMs: number
  currentStreakDays: number
  longestStreakDays: number
  fastMode: {
    count: number
    percentage: number
  }
  topReasoningEffort: {
    level: string
    count: number
    percentage: number
  } | null
  uniqueSkillsCount: number
  totalSkillInvocations: number
  totalChats: number
  topSkills: Array<{ name: string; count: number }>
  topModels?: ModelMetricItem[]
}

export interface GranularBucketMetrics {
  bucketKey: string                    // e.g. "2026-08-24", "2026-08-24 14:00", "2026-08", "all"
  startTimeMs: number
  endTimeMs: number
  metrics: AggregateMetrics
}

export interface GroupedMetricsItem {
  groupKey: string                     // projectId or modelId
  summary: AggregateMetrics
  buckets?: GranularBucketMetrics[]
}

export interface QueryMetricsResult {
  summary: AggregateMetrics
  buckets?: GranularBucketMetrics[]
  groups?: GroupedMetricsItem[]
}

export interface HostTransportApi {
  invoke(handle: string, method: string, args?: unknown[]): Promise<unknown>
  claimPlatformHandle?(): Promise<{ ok: boolean; value?: string; error?: unknown }>
  grantTicket?(ticket: string): Promise<unknown>
  subscribeNativeEvents(listener: (event: NativeEvent) => void): () => void
  subscribe?(handle: string, eventName: string, listener: (payload: unknown) => void): () => void
}

export interface ElectronBridgeApi {
  // File & OS
  RuntimeInfo(): Promise<RuntimeInfo>
  ReadFile(path: string): Promise<FileData>
  ReadFileIfExists?(path: string): Promise<FileData | null>
  FileExists?(path: string): Promise<boolean>
  WriteFile(path: string, dataBase64: string): Promise<void>
  MkdirAll(path: string): Promise<void>
  RemoveFile(path: string): Promise<void>
  RemoveDir?(path: string): Promise<void>
  Stat(path: string): Promise<FileStat>
  ReadDir(path: string): Promise<DirEntry[] | null>
  RealPath(path: string): Promise<string>
  LookPath(name: string): Promise<string>

  // Environment Watcher
  GetProjectEnvironment?(projectPath: string): Promise<{ filePath: string; content: string } | null>
  WatchProjectEnvironments?(projectPaths: string[]): Promise<void>
  InvalidateEnvironmentCache?(projectPath?: string): Promise<void>

  // Dialog & Reveal & Clipboard
  SelectProjectDirectory(title: string): Promise<ProjectDirectorySelection>
  SelectFilesAndFolders?(title?: string): Promise<SelectedFileOrFolder[]>
  RevealInFileManager(path: string): Promise<void>
  ClipboardSetText(text: string): Promise<void>
  ClipboardGetText(): Promise<string>
  SaveFile?(options: {
    defaultPath?: string
    title?: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ saved: boolean; filePath?: string }>
  saveFile?(options: {
    defaultPath?: string
    title?: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ saved: boolean; filePath?: string }>
  startProfiling?(options?: { durationMs?: number; target?: string }): Promise<{ ok: boolean; session?: any; error?: string }>
  stopProfiling?(): Promise<{ ok: boolean; report?: any; rawProfile?: any; error?: string }>
  ProfilingGetStatus?(): Promise<any>
  getProfilingReport?(): Promise<{ ok: boolean; report?: any; error?: string }>

  // Process & PTY
  StartProcess(req: ProcessStartRequest): Promise<ProcessStartResult>
  RunProcess(req: ProcessStartRequest): Promise<ProcessRunResult>
  ProcessRun?(options: {
    command: string
    args: readonly string[] | string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  StartPty(req: PtyStartRequest): Promise<void>
  WritePty(operationId: string, dataBase64: string): Promise<void>
  ResizePty(operationId: string, cols: number, rows: number): Promise<void>
  ClosePty(operationId: string): Promise<void>

  // WebSocket
  OpenWebSocket(req: WebSocketOpenRequest): Promise<void>
  SendWebSocket(operationId: string, payload: string): Promise<void>
  CancelOperation(operationId: string): Promise<void>

  // HTTP
  HttpRequest(req: HttpRequest): Promise<HttpResponse>

  // KVStore
  KVStoreGet(key: string): Promise<unknown>
  KVStoreSet(key: string, value: unknown): Promise<void>
  KVStoreSave(): Promise<void>

  // Schedule
  ScheduleList(): Promise<unknown>
  ScheduleSave(tasks: unknown): Promise<void>
  ScheduleTrigger(taskId: string): Promise<void>

  // Sessions
  SessionGet(sessionId: string): Promise<unknown>
  SessionSet(sessionId: string, data: unknown): Promise<void>
  SessionDelete(sessionId: string): Promise<void>
  SessionList(): Promise<string[]>
  SessionListSessions(): Promise<SessionItem[]>
  SessionListSessionsByScheduleId(scheduleId: string): Promise<SessionItem[]>
  SessionSetMeta(session: Partial<SessionItem> & { id: string }): Promise<void>
  SessionBroadcastRunStatus(
    sessionId: string,
    status: 'running' | 'thinking' | 'tool' | 'idle',
    runId: string,
    clientId: string,
  ): Promise<void>
  SessionBroadcastStreamEvent(
    sessionId: string,
    runId: string,
    event: unknown,
  ): Promise<void>
  SessionBroadcastSubAgentState(
    parentSessionId: string,
    agents: unknown[],
  ): Promise<void>
  SessionUpdateSubAgent(subAgent: SubAgentItem): Promise<void>
  SessionAbortRun(sessionId: string, reason?: string): Promise<void>
  SessionGetActiveRuns(): Promise<ActiveRunInfo[]>
  SessionGetResumePromptState(): Promise<ResumePromptSyncState>
  SessionBroadcastResumePromptState(state: ResumePromptSyncState): Promise<void>
  SessionResumePromptAction(action: 'continue' | 'abort'): Promise<void>
  SessionDelegateRun(req: SessionDelegateRunRequest): Promise<string>
  SessionSearch(query: string, limit?: number): Promise<SessionSearchResultItem[]>

  // Metrics Analytics
  SessionQueryMetrics(options: QueryMetricsOptions): Promise<QueryMetricsResult>


  // Tray (macOS menu bar)
  SetTrayEnabled(enabled: boolean, locale?: 'zh-CN' | 'en'): Promise<void>
  SetTrayLocale(locale: 'zh-CN' | 'en'): Promise<void>

  // Notification & Badge
  NotificationTaskCompleted(payload: { sessionId: string; sessionTitle?: string }): Promise<void>
  NotificationClearBadge(): Promise<void>

  // Power / Sleep
  SetPreventSleep(enabled: boolean): Promise<void>
  GetPreventSleep(): Promise<boolean>

  // Web Server
  WebServerStart(config?: {
    host?: string
    port?: number
    password?: string
  }): Promise<WebServerStatus>
  WebServerStop(): Promise<WebServerStatus>
  WebServerGetStatus(): Promise<WebServerStatus>

  // Plugins
  PluginsList?(): Promise<any>
  PluginsGetGraph?(): Promise<ResolvedPluginGraphDTO | null>
  PluginsGetPreparedState?(): Promise<{
    revision: string
    generation: number
    graph?: ResolvedPluginGraphDTO | null
  } | null>
  PluginsPrepareEnable?(pluginId: string, options?: any): Promise<any>
  PluginsPrepareDisable?(pluginId: string, options?: any): Promise<any>
  PluginsPrepareReload?(pluginId: string, options?: any): Promise<any>
  PluginsPrepareInstall?(spec: string, options?: any): Promise<any>
  PluginsPrepareUninstall?(pluginId: string, options?: any): Promise<any>
  PluginsCommit?(revision: string, generation?: number): Promise<{ ok: boolean }>
  PluginsRollback?(revision?: string, generation?: number): Promise<{ ok: boolean }>
  PluginsCommitGeneration?(revision: string, generation: number): Promise<{ ok: boolean }>
  PluginsRollbackGeneration?(revision?: string, generation?: number): Promise<{ ok: boolean }>

  // Update
  UpdateCheck(): Promise<UpdateStatusSnapshot>
  UpdateDownload(): Promise<void>
  UpdateCancel(): Promise<void>
  UpdateApply(): Promise<void>
  UpdateGetState(): Promise<UpdateStatusSnapshot>

  // Event stream subscription
  onNativeEvent(callback: (event: NativeEvent) => void): () => void
}
