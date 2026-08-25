import type {
  AppSettings,
  EditorSettings,
  GitSettings,
  ModelSettingsConfig,
  SubagentsSettings,
  UserProfileSettings,
  WorktreeSettings,
} from '@cpa/plugin-api'

export type {
  ActionPlatform,
  ActiveRunInfo,
  AgentRunStatus,
  AppSettings,
  CliProxyApiSettings,
  CommandHookHandlerConfig,
  EditorFollowUpMode,
  EditorSendShortcut,
  EditorSettings,
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
  SubagentsSettings,
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
} from '@cpa/plugin-api'

export type Session = import('@cpa/plugin-api').SessionItem

export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id: string
      name: string
      args: Record<string, unknown>
      status: import('@cpa/plugin-api').ToolStatus
      result?: string
    }

export interface Message {
  id: string
  sessionId: string
  role: import('@cpa/plugin-api').MessageRole
  content: string
  parts?: MessagePart[]
  status?: import('@cpa/plugin-api').MessageStatus
  createdAt: number
}

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 95
export const MIN_COMPACTION_THRESHOLD_PERCENT = 1
export const MAX_COMPACTION_THRESHOLD_PERCENT = 100

export function normalizeCompactionThresholdPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_COMPACTION_THRESHOLD_PERCENT
  }
  const rounded = Math.round(value)
  if (rounded <= 0) {
    return DEFAULT_COMPACTION_THRESHOLD_PERCENT
  }
  return Math.min(
    MAX_COMPACTION_THRESHOLD_PERCENT,
    Math.max(MIN_COMPACTION_THRESHOLD_PERCENT, rounded),
  )
}

export const DEFAULT_PROFILE: UserProfileSettings = {
  displayName: 'Luis Pater',
  handle: 'luispater',
  avatarUrl: '/avatar.png',
  isPrivate: true,
  tier: 'Pro',
}

export const DEFAULT_MODEL_SETTINGS: ModelSettingsConfig = {
  enableAll: true,
  models: {},
  modelOrder: [],
}

export const DEFAULT_GIT_SETTINGS: GitSettings = {
  branchPrefix: 'codex/',
  mergeMethod: 'merge',
  alwaysForcePush: false,
  createDraftPr: true,
  reviewPresentation: 'separate',
  autoMergeWhenReady: false,
  autoMergeInstructions: '',
  commitInstructions: '',
  prInstructions: '',
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  rootDir: '~/.coding-professional-agent/worktrees',
  fetchUpstream: false,
  autoDeleteOld: true,
  deleteLimit: 15,
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentsSettings = {
  enabled: true,
  concurrency: 10,
  maxPerSession: 3,
  maxDepth: 1,
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  showContextUsage: true,
  sendShortcut: 'cmdEnter',
  followUpMode: 'steer',
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  locale: 'zh-CN',
  modelId: '',
  reasoningLevel: '',
  speed: 'standard',
  requestApproval: false,
  compactionThresholdPercent: DEFAULT_COMPACTION_THRESHOLD_PERCENT,
  fastContextCompaction: true,
  resumeUnfinishedConversations: true,
  showInMenuBar: true,
  showBottomPanel: true,
  terminalPosition: 'bottom',
  cliProxyApi: { baseUrl: '', apiKey: '' },
  webServer: {
    enabled: false,
    host: '127.0.0.1',
    port: 18080,
    password: '',
  },
  profile: DEFAULT_PROFILE,
  themePreset: 'codex',
  accentColor: '#339CFF',
  backgroundColor: '#181818',
  foregroundColor: '#FFFFFF',
  uiFontFamily: 'system',
  uiFontWeight: 'normal',
  codeFontFamily: 'system',
  codeFontWeight: 'normal',
  contrast: 60,
  compactMode: false,
  showLineNumbers: true,
  wordWrap: true,
  uiScale: 100,
  uiFontSize: 14,
  codeFontSize: 12,
  fontSmoothing: true,
  localMemoryEnabled: true,
  toolAssistedMemoryEnabled: false,
  personality: 'pragmatic',
  modelSettings: DEFAULT_MODEL_SETTINGS,
  git: DEFAULT_GIT_SETTINGS,
  worktrees: DEFAULT_WORKTREE_SETTINGS,
  subagents: DEFAULT_SUBAGENT_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
}

export const MOCK_MODELS: readonly { id: string; label: string }[] = []

export type {
  AssistantEntry,
  CompactionEntry,
  ContentBlock,
  ConversationEntry,
  DisplayMessage,
  StopReason,
  ToolResultEntry,
  Usage,
  UserEntry,
} from '@/features/agent-runtime/session/types'
