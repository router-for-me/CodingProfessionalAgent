/**
 * Host Services and Shared Domain Transfer Objects (DTOs)
 * Universal Plugin Platform
 */

import type {
    ChatRendererContribution,
    ChatRendererTarget,
    HookEventName,
    NavigationContribution,
} from './contributions.js'
import type {
    PluginSummary,
} from './manifest.js'
import type {
    ResolvedPluginGraphDTO,
} from './graph.js'
import type {
    ShortcutKeyBinding,
    SavedShortcutItem,
    ShortcutItem,
    ShortcutsMap,
    ShortcutsConfig,
} from './shortcuts.js'

export type {
    ShortcutKeyBinding,
    SavedShortcutItem,
    ShortcutItem,
    ShortcutsMap,
    ShortcutsConfig,
}

export type ThemeMode = 'dark' | 'light' | 'system'
export type Locale = 'zh-CN' | 'en'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted'
export type ToolStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'done'
  | 'rejected'
  | 'error'
  | 'aborted'

export type ReasoningLevel = string
export type Speed = 'standard' | 'fast' | 'max'
export type TerminalPosition = 'bottom' | 'right'
export type PersonalityTone =
  | 'pragmatic'
  | 'casual'
  | 'professional'
  | 'enthusiastic'
  | 'humorous'
  | 'concise'

export type ActionPlatform = 'darwin' | 'linux' | 'win32'

export type AgentRunStatus = 'running' | 'thinking' | 'tool' | 'idle' | 'error'

export type ComposerAttachmentKind = 'image' | 'file' | 'folder'

export interface ComposerImage {
    id: string
    name: string
    mimeType: string
    data: string
    width: number
    height: number
    kind?: 'image'
    path?: string
}

export type ComposerRunStatus =
    | 'idle'
    | 'loading-resources'
    | 'compacting'
    | 'connecting'
    | 'retrying'
    | 'streaming'
    | 'awaiting_approval'
    | 'running_tools'
    | 'done'
    | 'error'
    | 'aborted'
    | (string & {})

export interface ActiveRunInfo {
  sessionId: string
  runId: string
  clientId: string
  status: 'running' | 'thinking' | 'tool' | 'idle' | 'error'
  error?: string
  updatedAt: number
}

export interface ProjectDirectorySelection {
  name: string
  path: string
}

export interface ProjectEnvironmentAction {
  id: string
  name: string
  script: string
  command?: string
  platform?: ActionPlatform
  icon?: string
}

export interface ProjectEnvironmentScripts {
  default?: string
  macos?: string
  linux?: string
  windows?: string
}

export interface Project {
  id: string
  name: string
  /** Primary source folder kept for persisted-state compatibility. */
  path?: string
  /** All source folders available to sessions in this project. */
  paths?: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
  setupScript?: string
  cleanupScript?: string
  setupScripts?: ProjectEnvironmentScripts
  cleanupScripts?: ProjectEnvironmentScripts
  setupPlatform?: 'default' | 'macos' | 'linux' | 'windows'
  cleanupPlatform?: 'default' | 'macos' | 'linux' | 'windows'
  actions?: ProjectEnvironmentAction[]
  workLocation?: 'local' | 'worktree'
  environmentId?: string | null
}

export interface SessionRightSidebarState {
    collapsed?: boolean
    maximized?: boolean
    width?: number | null
    activeTab?: string | null
    openTabs?: string[]
    tabParams?: Record<string, Record<string, unknown>>
}

export type SessionUnreadState = boolean | 'unread' | 'error'

export type WorktreeSetupStepStatus = 'pending' | 'running' | 'done' | 'error'
export type WorktreeSetupStatus =
    | 'idle'
    | 'preparing'
    | 'checking_out'
    | 'setting_up'
    | 'ready'
    | 'error'

export interface WorktreeSessionSetup {
    sessionId: string
    status: WorktreeSetupStatus
    stepWorkspace: WorktreeSetupStepStatus
    stepCheckout: WorktreeSetupStepStatus
    stepEnvironment: WorktreeSetupStepStatus
    worktreePath?: string
    sourceTreePath?: string
    branch?: string
    baseBranch?: string
    environmentId?: string | null
    environmentName?: string
    logs: string
    exitCode?: number
    error?: string
    expandedDetails: boolean
}

export interface SessionItem {
    id: string
    projectId?: string
    scheduleId?: string
    parentSessionId?: string
    branch?: string
    baseBranch?: string
    title: string
    pinned: boolean
    archivedAt?: number
    unread?: SessionUnreadState
    rightSidebar?: SessionRightSidebarState
    firstPromptAt?: number
    modelId?: string
    reasoningEffort?: string
    speed?: Speed
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    environmentId?: string | null
    worktreeSetup?: WorktreeSessionSetup
    pinnedSummaryVisible?: boolean
    createdAt: number
    updatedAt: number
}


export interface CliProxyApiSettings {
  baseUrl: string
  apiKey: string
}

export interface WebServerSettings {
  enabled: boolean
  host: string
  port: number
  password: string
}

export interface UserProfileSettings {
  displayName: string
  handle: string
  avatarUrl: string
  isPrivate: boolean
  tier: string
}

export interface ModelCustomConfig {
  enabled: boolean
  enabledReasoningLevels?: string[]
}

export interface ModelSettingsConfig {
  enableAll: boolean
  models: Record<string, ModelCustomConfig>
  modelOrder?: string[]
}

export type GitMergeMethod = 'merge' | 'squash'
export type GitReviewPresentation = 'inline' | 'separate'

export interface GitSettings {
  branchPrefix: string
  mergeMethod: GitMergeMethod
  alwaysForcePush: boolean
  createDraftPr: boolean
  reviewPresentation: GitReviewPresentation
  autoMergeWhenReady: boolean
  autoMergeInstructions: string
  commitInstructions: string
  prInstructions: string
}

export interface WorktreeSettings {
  rootDir: string
  fetchUpstream: boolean
  autoDeleteOld: boolean
  deleteLimit: number
}

export interface SubagentsSettings {
  enabled: boolean
  concurrency: number
  maxPerSession: number
  maxDepth: number
}

export type EditorSendShortcut = 'enter' | 'cmdEnter'
export type EditorFollowUpMode = 'queue' | 'steer'

export interface EditorSettings {
  showContextUsage: boolean
  sendShortcut: EditorSendShortcut
  followUpMode: EditorFollowUpMode
}

export interface AppSettings {
  theme: ThemeMode
  locale: Locale
  modelId: string
  reasoningLevel: ReasoningLevel
  speed: Speed
  requestApproval: boolean
  compactionThresholdPercent: number
  fastContextCompaction: boolean
  resumeUnfinishedConversations?: boolean
  preventSleep?: boolean
  showInMenuBar: boolean
  showBottomPanel: boolean
  terminalPosition: TerminalPosition
  cliProxyApi: CliProxyApiSettings
  webServer?: WebServerSettings
  profile?: UserProfileSettings
  themePreset?: string
  accentColor?: string
  backgroundColor?: string
  foregroundColor?: string
  uiFontFamily?: string
  uiFontWeight?: string
  codeFontFamily?: string
  codeFontWeight?: string
  contrast?: number
  compactMode?: boolean
  showLineNumbers?: boolean
  wordWrap?: boolean
  uiScale?: number
  uiFontSize?: number
  codeFontSize?: number
  fontSmoothing?: boolean
  localMemoryEnabled?: boolean
  toolAssistedMemoryEnabled?: boolean
  personality?: PersonalityTone
  shortcuts?: Record<string, ShortcutKeyBinding[]>
  modelSettings?: ModelSettingsConfig
  git?: GitSettings
  worktrees?: WorktreeSettings
  subagents?: SubagentsSettings
  editor?: EditorSettings
}

export interface WorktreeSetupInput {
    sessionId: string
    sourceTreePath: string
    worktreePath?: string
    branch?: string | null
    baseBranch?: string | null
    branchPrefix?: string | null
    environmentId?: string | null
    worktreeRootDir?: string
    fetchUpstream?: boolean
    onProgress?: (step: 'preparing' | 'checking_out' | 'setting_up' | 'ready' | 'error') => void
    onLog?: (chunk: string) => void
}

export interface WorktreeSetupResult {
    ok: boolean
    worktreePath?: string
    branch?: string
    error?: string
    exitCode?: number
}

export type { HookEventName } from './contributions.js'

export type HookHandlerType = 'command' | 'mcp_tool' | 'prompt' | 'agent'
export type HookSource = 'user' | 'project' | 'plugin' | 'system'
export type HookTrustStatus = 'managed' | 'untrusted' | 'trusted' | 'modified'

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
    id?: string
    groupIndex?: number
    handlerIndex?: number
    trustedHash?: string
}

export interface HookConfiguration {
    file?: HooksConfigFile
    path?: string
    userConfigFile?: HooksConfigFile | null
    userConfigPath?: string | null
    userHooks?: HookMetadata[]
    projectHooks?: HookMetadata[]
    projectConfigs?: Record<string, { file: HooksConfigFile; path: string; hooks: HookMetadata[] }>
    [key: string]: unknown
}

export interface NotificationInput {
    message: string
    type?: 'info' | 'success' | 'warning' | 'error'
    title?: string
    durationMs?: number
}

export interface ScheduledTaskItem {
    id: string
    title: string
    schedule: string
    description?: string
    prompt: string
    enabled: boolean
    status?: 'active' | 'paused' | 'completed'
    unread?: boolean
    createdAt: number
    lastRunAt?: number | null
    runIn?: string
    chatSessionId?: string | null
    chatTitle?: string
    notification?: string
    projectId?: string | null
    projectName?: string
    projectPath?: string
    modelId?: string
    modelLabel?: string
    reasoningLevel?: string
}

export interface ScheduleService {
    list(): Promise<readonly ScheduledTaskItem[]>
    save(tasks: readonly ScheduledTaskItem[]): Promise<void>
}

export interface SkillUsageService {
    fetchUsageCounts(): Promise<Record<string, number>>
    recordUsage(skillName: string, delta?: number): void
    /** Latest composer-discovered skills shared with other plugins (e.g. chat edit). */
    getAvailableSkills?(): readonly any[]
    /** Publish composer-discovered skills for cross-plugin consumers. */
    setAvailableSkills?(skills: readonly any[]): void
    /** Subscribe to available skill catalog changes independently of usage counts. */
    subscribeAvailableSkills?(listener: () => void): () => void
    /** Current usage counts snapshot for React subscriptions. */
    getSnapshot?(): Record<string, number>
    /** Subscribe to usage count changes. */
    subscribe?(listener: () => void): () => void
}

export interface PersistenceService {
    init(): Promise<void>
    flush(): Promise<void>
}

export interface PendingSessionContext {
    projectId: string | null
    branch: string | null
    workLocation?: 'local' | 'worktree'
    environmentId?: string | null
    standalone?: boolean
}

export interface UiService {
    getPendingSessionContext(): PendingSessionContext
    setPendingSessionContext(context: Partial<PendingSessionContext>): void
    isGroupCollapsed(groupKey: string): boolean
    toggleGroup(groupKey: string): void
    setSidebarCollapsed(collapsed: boolean): void
    isSidebarCollapsed?(): boolean
    toggleSidebar?(): void
    togglePinnedSummaryVisible?(): void
    openSettings(section?: string, options?: unknown): void
    closeSettings?(): void
    pushToast(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void
    subscribe?(listener: () => void): () => void
    getSnapshot?(): any
    emitEvent?(eventName: string, payload?: unknown): void
    writeClipboard?(text: string): Promise<void>
    getComposerDraft?(key: string): string | undefined
    setComposerDraft?(key: string, draft: string): void
    clearComposerDraft?(key: string): void
    openRightPanelTab?(tabId: string, options?: { activate?: boolean; params?: Record<string, unknown> }): void
    closeRightPanelTab?(tabId: string): void
    toggleRightSidebarCollapsed?(): void
    setRightSidebarCollapsed?(collapsed: boolean): void
    toggleBottomPanelVisible?(): void
    setBottomPanelVisible?(visible: boolean): void
    setBottomPanelHeight?(height: number): void
}

export interface ForkSessionExtraOptions {
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    environmentId?: string | null
    branch?: string | null
}

export interface SessionService {
    list(): Promise<readonly SessionItem[]>
    get(sessionId: string): Promise<SessionItem | undefined>
    create?(input?: {
        id?: string
        title?: string
        projectId?: string
        scheduleId?: string
        branch?: string
        workLocation?: string
        environmentId?: string | null
        modelId?: string
        reasoningEffort?: string
        [key: string]: unknown
    }): string | Promise<string>
    update(sessionId: string, patch: Partial<SessionItem>): Promise<void>
    broadcastRunStatus(sessionId: string, status: AgentRunStatus): Promise<void>
    getSnapshot?(): readonly SessionItem[]
    subscribe?(listener: (sessions: readonly SessionItem[]) => void): () => void
    getCurrentSessionId?(): string | null
    setCurrentSessionId?(id: string | null): void
    delete?(sessionId: string): Promise<void>
    setProject?(sessionId: string, projectId: string | null): Promise<void> | void
    setBranch?(sessionId: string, branch: string | null): Promise<void> | void
    setWorktree?(sessionId: string, setup: Partial<WorktreeSessionSetup>): Promise<void> | void
    renameSession?(sessionId: string, title: string): Promise<void> | void
    togglePin?(sessionId: string): Promise<void> | void
    markUnread?(sessionId: string, unread: SessionUnreadState): Promise<void> | void
    markRead?(sessionId: string): Promise<void> | void
    markUnreadManually?(sessionId: string): Promise<void> | void
    isManuallyMarkedUnread?(sessionId: string): boolean
    getEntriesBySession?(): Record<string, any[]>
    getActiveRun?(sessionId: string): ActiveRunInfo | undefined
    subscribeRuns?(listener: () => void): () => void
    setSessionRuntimeSettings?(
        sessionId: string,
        settings: { modelId?: string; reasoningEffort?: string; speed?: Speed },
    ): void
    forkSession?(
        sessionId: string,
        atEntryId?: string,
        options?: ForkSessionExtraOptions,
    ): Promise<string | undefined>
}

export interface ProjectService {
    list(): Promise<readonly Project[]>
    save(project: Project): Promise<void>
    remove(projectPath: string): Promise<void>
    getSnapshot?(): readonly Project[]
    subscribe?(listener: (projects: readonly Project[]) => void): () => void
    togglePin?(projectId: string): Promise<void> | void
    update?(id: string, patch: Partial<Project>): Promise<void> | void
    selectDirectory?(title?: string): Promise<ProjectDirectorySelection | null>
    revealPath?(path: string): Promise<void>
}

export interface SettingsService {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<void>
    getSnapshot?(): AppSettings
    subscribe?(listener: (settings: AppSettings) => void): () => void
    setTheme?(theme: ThemeMode): void
    setLocale?(locale: Locale): void
    setModelId?(modelId: string): void
    setReasoningLevel?(reasoningLevel: ReasoningLevel): void
    setSpeed?(speed: Speed): void
    setRequestApproval?(requestApproval: boolean): void
    setCompactionThresholdPercent?(percent: number): void
    setFastContextCompaction?(enabled: boolean): void
    setResumeUnfinishedConversations?(enabled: boolean): void
    setPreventSleep?(enabled: boolean): void
    setShowInMenuBar?(enabled: boolean): void
    setShowBottomPanel?(enabled: boolean): void
    setTerminalPosition?(position: TerminalPosition): void
    setCliProxyApi?(partial: Partial<CliProxyApiSettings>): void
    setWebServer?(partial: Partial<WebServerSettings>): void
    setProfile?(partial: Partial<UserProfileSettings>): void
    setModelSettings?(partial: Partial<ModelSettingsConfig>): void
    setModelOrder?(modelOrder: string[]): void
    setModelEnabled?(modelId: string, enabled: boolean): void
    setModelReasoningLevelEnabled?(
        modelId: string,
        reasoningLevel: string,
        enabled: boolean,
        allReasoningLevels?: readonly string[],
    ): void
    setThemePreset?(themePreset: string): void
    setAccentColor?(accentColor: string): void
    setBackgroundColor?(backgroundColor: string): void
    setForegroundColor?(foregroundColor: string): void
    setUiFontFamily?(uiFontFamily: string): void
    setUiFontWeight?(uiFontWeight: string): void
    setCodeFontFamily?(codeFontFamily: string): void
    setCodeFontWeight?(codeFontWeight: string): void
    setContrast?(contrast: number): void
    setCompactMode?(compactMode: boolean): void
    setShowLineNumbers?(showLineNumbers: boolean): void
    setWordWrap?(wordWrap: boolean): void
    setUiScale?(uiScale: number): void
    setUiFontSize?(uiFontSize: number): void
    setCodeFontSize?(codeFontSize: number): void
    setFontSmoothing?(fontSmoothing: boolean): void
    setLocalMemoryEnabled?(enabled: boolean): void
    setToolAssistedMemoryEnabled?(enabled: boolean): void
    setPersonality?(personality: PersonalityTone): void
    setGitSettings?(partial: Partial<GitSettings>): void
    setWorktreeSettings?(partial: Partial<WorktreeSettings>): void
    setSubagentSettings?(partial: Partial<SubagentsSettings>): void
    setEditorSettings?(partial: Partial<EditorSettings>): void
    setAppearance?(partial: Partial<AppSettings>): void
    hydrate?(partial: Partial<AppSettings>): void
}

export interface DiscoveredWorktree {
    name: string
    path: string
    branch?: string
    headSha?: string
    mainRepo?: string
    mainRepoPath?: string
    gitDir?: string
    isGitWorktree?: boolean
}

export interface WorktreeDeleteResult {
    ok: boolean
    error?: string
}

export interface WorktreeService {
    setup(input: WorktreeSetupInput): Promise<WorktreeSetupResult>
    listWorktrees?(rootDir?: string): Promise<DiscoveredWorktree[]>
    deleteWorktree?(worktree: DiscoveredWorktree): Promise<WorktreeDeleteResult>
    resolveRootDir?(configuredRootDir?: string): Promise<string>
}

export interface HookService {
    load(projectPath: string): Promise<HookConfiguration>
    save(projectPath: string, config: HookConfiguration): Promise<void>
}

export interface NavigationService {
    navigate(to: string | { to: string; params?: Record<string, string> }): Promise<void>
    getNavigationItems?(): readonly NavigationContribution[]
    subscribe?(listener: () => void): () => void
}

export interface NotificationService {
    show(input: NotificationInput): void
}

export interface WebServerStatus {
    running: boolean
    host: string
    port: number
    url: string
    error?: string
}

export interface WebServerService {
    getStatus(): Promise<WebServerStatus>
    start(config?: Partial<WebServerSettings>): Promise<WebServerStatus>
    stop(): Promise<WebServerStatus>
}

export interface FileSystemService {
    readFile(path: string): Promise<{ dataBase64: string }>
    readFileIfExists?(path: string): Promise<{ dataBase64: string } | null>
    writeFile(path: string, dataBase64: string): Promise<void>
    mkdirAll?(path: string): Promise<void>
    readDir?(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean; path: string; isSymbolicLink?: boolean }[]>
    stat?(path: string): Promise<any>
    removeDir?(path: string): Promise<void>
    removeFile?(path: string): Promise<void>
    selectFilesAndFolders?(title?: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>>
    revealInFileManager?(path: string): Promise<void>
    getRuntimeInfo?(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string; isDebug?: boolean; appConfigDirName?: string }>
}

export interface ProcessRunOptions {
    command: string
    args: readonly string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number
}

export interface ProcessRunResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface ProcessService {
    run(options: ProcessRunOptions): Promise<ProcessRunResult>
}

export interface QueryMetricsOptions {
    timeGranularity?: 'hour' | 'day' | 'week' | 'month' | 'year'
    projectId?: string
    modelId?: string
    startTimeMs?: number
    endTimeMs?: number
    topSkillsLimit?: number
    topModelsLimit?: number
    groupBy?: 'project' | 'model'
    subAgentMode?: 'exclude' | 'include' | 'rollup'
}

export interface SessionMetricsService {
    queryMetrics(options?: QueryMetricsOptions): Promise<any>
}

export interface ChatSendPayload {
    text: string
    sessionId: string
    editMessageId?: string
    userEntryId?: string
    userEntryCreatedAt?: number
    images?: ComposerImage[]
    projectId?: string | null
    branch?: string | null
    workLocation?: 'local' | 'worktree'
    environmentId?: string | null
    followUpMode?: 'steer' | 'queue'
    onSessionAccepted?: (sessionId: string) => void
}

export interface AgentRunState {
    isStreaming: boolean
    activeRunId: string | null
    runState?: any
}

export interface ChatMessageService {
    getDisplayMessages(sessionId: string): readonly any[]
    getEntries(sessionId: string): readonly any[]
    replaceSessionEntries(sessionId: string, entries: readonly any[]): void
    subscribeMessages?(sessionId: string, listener: () => void): () => void
    ensureSessionLoaded?(sessionId: string): Promise<void>
    schedulePersist?(immediate?: boolean): void
    forkSession?(
        sessionId: string,
        atEntryId?: string,
        options?: ForkSessionExtraOptions,
    ): Promise<string | undefined>
    executeHook?(hookName: string, sessionId: string, context?: unknown): Promise<void>
    getToolOverlays?(sessionId: string): Readonly<Record<string, any>>
    subscribeToolOverlays?(sessionId: string, listener: () => void): () => void
    isCompacting?(sessionId: string): boolean
    subscribeCompaction?(sessionId: string, listener: () => void): () => void
    getWorktreeSetup?(sessionId: string): any
    subscribeWorktreeSetup?(sessionId: string, listener: () => void): () => void
    retryWorktreeSetup?(sessionId: string): Promise<{ ok: boolean }>
    continueAnywayWorktreeSetup?(sessionId: string): Promise<void>
    autoFixWorktreeSetup?(sessionId: string): Promise<void>
    toggleWorktreeSetupDetails?(sessionId: string): void
    approveTool?(toolId: string): void
    rejectTool?(toolId: string): void
    dequeueMessage?(sessionId: string, messageId: string): Promise<{ text: string; images?: any[] } | null | undefined>
    send?(payload: ChatSendPayload): Promise<string | null | undefined>
    stop?(sessionId?: string | null): void
    abort?(sessionId?: string | null): void
    compact?(focus: string, sessionId?: string | null): Promise<void>
    retrySession?(sessionId: string): Promise<void>
    resumeSession?(sessionId: string): Promise<string | null>
    isSessionResumable?(sessionId: string): boolean
    subscribeSessionResumable?(sessionId: string, listener: () => void): () => void
    getAgentRunState?(sessionId: string): AgentRunState
    subscribeAgentRunState?(sessionId: string, listener: () => void): () => void
    getSupportsImages?(sessionId?: string | null): boolean
    subscribeSupportsImages?(sessionId: string | null, listener: () => void): () => void
    getPrompts?(): readonly any[]
    subscribePrompts?(listener: () => void): () => void
}

export interface AgentRunService {
    send(payload: ChatSendPayload): Promise<string | null | undefined>
    stop(sessionId?: string | null): void
    abort(sessionId?: string | null): void
    compact?(focus: string, sessionId?: string | null): Promise<void>
    retrySession?(sessionId: string): Promise<void>
    resumeSession?(sessionId: string): Promise<string | null>
    getRunState(sessionId: string): AgentRunState
    subscribeRunState(sessionId: string, listener: () => void): () => void
    getSupportsImages?(sessionId?: string | null): boolean
    subscribeSupportsImages?(sessionId: string | null, listener: () => void): () => void
    getPrompts?(): readonly any[]
    subscribePrompts?(listener: () => void): () => void
}

export interface ModelCatalogService {
    getModels(): readonly any[]
    getStatus?(): 'idle' | 'loading' | 'success' | 'error' | 'ready'
    getError?(): string | null
    subscribe?(listener: () => void): () => void
    refresh?(): Promise<void>
}

export interface SlotContributionItem<T = Record<string, unknown>> {
    id: string
    pluginId?: string
    slotName?: string
    order?: number
    component: any
    visible?: boolean | ((props: T) => boolean)
}

export interface SelectChatRendererOptions {
    target?: ChatRendererTarget | string
    scope?: ChatRendererTarget | string
    excludeIds?: readonly string[]
}

export interface RendererContributionsService {
    getSlotContributions<T = Record<string, unknown>>(slotName: string): readonly SlotContributionItem<T>[]
    subscribeSlot?(slotName: string, listener: () => void): () => void
    getChatRenderers?<T = unknown>(): readonly ChatRendererContribution<T>[]
    selectChatRenderer?<T = unknown>(value: T, options?: SelectChatRendererOptions): ChatRendererContribution<T> | undefined
    subscribeChatRenderers?(listener: () => void): () => void
    getComposerControls?(placement?: 'context' | 'toolbar-left' | 'toolbar-right'): readonly any[]
    subscribeComposerControls?(listener: () => void): () => void
    getAttachmentProviders?(): readonly any[]
    subscribeAttachmentProviders?(listener: () => void): () => void
    getSubmitPreprocessors?(): readonly any[]
    subscribeSubmitPreprocessors?(listener: () => void): () => void
    runSubmitPreprocessors?(payload: any, context?: any): Promise<any> | any
    getComponentWrappers?<P extends object = Record<string, unknown>>(componentName: string): readonly any[]
    subscribeComponentWrappers?(componentName: string, listener: () => void): () => void
}

export interface PersonalizationService {
    loadInstructions(): Promise<string>
    saveInstructions(content: string): Promise<void>
    deleteMemories?(): Promise<void>
}

export type SubAgentStatus =
    | 'queued'
    | 'running'
    | 'completed'
    | 'error'
    | 'aborted'

export type SubAgentIconId =
    | 'sparkle'
    | 'atom'
    | 'flower'
    | 'sun'
    | 'hexagon'
    | 'orbit'
    | 'flame'
    | 'brain'

export interface SubAgentAppearance {
    color: string
    icon: SubAgentIconId
}

export interface SubAgentRecord {
    id: string
    name: string
    color: string
    icon: SubAgentIconId
    parentSessionId: string
    sessionId: string
    modelId: string
    reasoningEffort?: string
    status: SubAgentStatus
    createdAt: number
    updatedAt: number
    parentToolCallId?: string
    lastMessage?: string
    errorMessage?: string
    completedAt?: number
    pausedMs?: number
    depth?: number
    parentAgentId?: string
}

export interface SubAgentService {
    getAgents(parentSessionId?: string): readonly SubAgentRecord[]
    getAgent(agentId: string): SubAgentRecord | undefined
    subscribe(listener: () => void): () => void
    openTab(parentSessionId: string, agentId: string): void
    closeTab(parentSessionId: string, agentId: string): void
    focusTab(parentSessionId: string, agentId: string | null): void
    getOpenTabIds(parentSessionId: string): readonly string[]
    getFocusedId(parentSessionId: string): string | null
    spawn?(prompt: string, options?: any): Promise<any>
    sendMessage?(agentId: string, message: string): Promise<any>
    stopAgent?(agentId: string): Promise<any>
}

export interface PluginManagementInstallOptions {
    scope?: 'project' | 'global'
    expectedRevision?: string
}

export interface PluginManagementActionOptions {
    scope?: 'project' | 'global'
    expectedRevision?: string
}

export interface PluginManagementService {
    getPluginSummaries(): readonly PluginSummary[]
    subscribe?(listener: () => void): () => void
    activatePlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    deactivatePlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    enablePlugin?(id: string, options?: PluginManagementActionOptions): Promise<void>
    disablePlugin?(id: string, options?: PluginManagementActionOptions): Promise<void>
    reloadPlugin(id: string, options?: PluginManagementActionOptions): Promise<void>
    installPlugin?(spec: string, options?: PluginManagementInstallOptions): Promise<void>
    uninstallPlugin?(id: string, options?: PluginManagementActionOptions): Promise<void>
    isPluginActive(id: string): boolean
    getGraphDTO?(): ResolvedPluginGraphDTO | undefined
    refresh?(): Promise<void>
}

export interface ServiceToken<T = unknown> {
    readonly id: string
    readonly __serviceType?: T
}

export function createServiceToken<T = unknown>(id: string): ServiceToken<T> {
    return { id }
}

export const SessionServiceToken = createServiceToken<SessionService>('host.services.sessions')
export const ProjectServiceToken = createServiceToken<ProjectService>('host.services.projects')
export const SettingsServiceToken = createServiceToken<SettingsService>('host.services.settings')
export const WorktreeServiceToken = createServiceToken<WorktreeService>('host.services.worktrees')
export const HookServiceToken = createServiceToken<HookService>('host.services.hooks')
export const NavigationServiceToken = createServiceToken<NavigationService>('host.services.navigation')
export const NotificationServiceToken = createServiceToken<NotificationService>('host.services.notifications')
export const ScheduleServiceToken = createServiceToken<ScheduleService>('host.services.schedule')
export const SkillUsageServiceToken = createServiceToken<SkillUsageService>('host.services.skillUsage')
export const PersistenceServiceToken = createServiceToken<PersistenceService>('host.services.persistence')
export const UiServiceToken = createServiceToken<UiService>('host.services.ui')
export const WebServerServiceToken = createServiceToken<WebServerService>('host.services.webserver')
export const FileSystemServiceToken = createServiceToken<FileSystemService>('host.services.filesystem')
export const PersonalizationServiceToken = createServiceToken<PersonalizationService>('host.services.personalization')
export const PluginManagementServiceToken = createServiceToken<PluginManagementService>('host.services.pluginManagement')
export const SessionMetricsServiceToken = createServiceToken<SessionMetricsService>('host.services.sessionMetrics')
export const ProcessServiceToken = createServiceToken<ProcessService>('host.services.process')
export const ChatMessageServiceToken = createServiceToken<ChatMessageService>('host.services.chatMessages')
export const AgentRunServiceToken = createServiceToken<AgentRunService>('host.services.agentRun')
export const AgentRuntimeServiceToken = createServiceToken<AgentRunService>('host.services.agentRuntime')
export const SubAgentServiceToken = createServiceToken<SubAgentService>('host.services.subAgents')
export const ModelCatalogServiceToken = createServiceToken<ModelCatalogService>('host.services.modelCatalog')
export const RendererContributionsServiceToken = createServiceToken<RendererContributionsService>('host.services.rendererContributions')

export const HOST_SERVICE_TOKENS = {
    sessions: SessionServiceToken,
    projects: ProjectServiceToken,
    settings: SettingsServiceToken,
    models: ModelCatalogServiceToken,
    modelCatalog: ModelCatalogServiceToken,
    worktrees: WorktreeServiceToken,
    hooks: HookServiceToken,
    navigation: NavigationServiceToken,
    notifications: NotificationServiceToken,
    schedule: ScheduleServiceToken,
    skillUsage: SkillUsageServiceToken,
    persistence: PersistenceServiceToken,
    ui: UiServiceToken,
    webServer: WebServerServiceToken,
    fileSystem: FileSystemServiceToken,
    personalization: PersonalizationServiceToken,
    pluginManagement: PluginManagementServiceToken,
    sessionMetrics: SessionMetricsServiceToken,
    process: ProcessServiceToken,
    chatMessages: ChatMessageServiceToken,
    agentRun: AgentRunServiceToken,
    agentRuntime: AgentRuntimeServiceToken,
    subAgents: SubAgentServiceToken,
    rendererContributions: RendererContributionsServiceToken,
} as const

export interface HostServices {
    sessions: SessionService
    projects: ProjectService
    settings: SettingsService
    worktrees: WorktreeService
    hooks: HookService
    navigation: NavigationService
    notifications: NotificationService
    schedule: ScheduleService
    skillUsage: SkillUsageService
    persistence: PersistenceService
    ui?: UiService
    webServer?: WebServerService
    fileSystem?: FileSystemService
    personalization?: PersonalizationService
    pluginManagement?: PluginManagementService
    sessionMetrics?: SessionMetricsService
    process?: ProcessService
    chatMessages?: ChatMessageService
    agentRun?: AgentRunService
    models?: ModelCatalogService
    rendererContributions?: RendererContributionsService
    subAgents?: SubAgentService
}
