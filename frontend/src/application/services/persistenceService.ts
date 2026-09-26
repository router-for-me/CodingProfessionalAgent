import type { PersistenceService } from '@cpa/plugin-api'
import { createId } from '@/lib/id'
import {
  createProjectPathsPatch,
  getProjectPaths,
} from '@/lib/projectPaths'
import { isBrowserEnvironment } from '@/lib/platform'
import {
  DEFAULT_SETTINGS,
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_WORKTREE_SETTINGS,
  DEFAULT_SUBAGENT_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  normalizeCompactionThresholdPercent,
  type AppSettings,
  type CacheWarmingMode,
  type EditorFollowUpMode,
  type EditorSendShortcut,
  type EditorSettings,
  type GitSettings,
  type Locale,
  type ModelCustomConfig,
  type ModelSettingsConfig,
  type Speed,
  type SubagentsSettings,
  type Project,
  type Session,
  type SessionRightSidebarState,
  type SessionUnreadState,
  type WebServerSettings,
  type WorktreeSettings,
  type WorktreeSessionSetup,
} from '@/types/models'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import type { SubAgentRecord, SubAgentIconId, SubagentRole } from '@cpa/plugin-api'
import {
  generateSavedShortcutsConfig,
  extractShortcutsOverrides,
} from '@cpa/plugin-api'
import { useMessageStore } from '@/stores/messageStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useProjectStore } from '@/stores/projectStore'
import { onRemoteSessionDelete, useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { agentsForParent, useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { subscribeMessageEvents } from '@/application/events/messageEvents'
import { canUseHostKvStore, getHostBridge } from './hostTransport'
import { stripHiddenReasoningLevels } from '@/features/models/filteredModels'

export type PersistVersion = 1 | 2

export interface SessionFilePayload {
  id: string
  version: PersistVersion
  expectedEntriesRevision?: string
  removedEntryIds?: string[]
  entries: ConversationEntry[]
  title?: string
  subAgents?: SubAgentRecord[]
  projectId?: string | null
  parentSessionId?: string | null
  isSubagent?: boolean
  branch?: string | null
  pinned?: boolean
  unread?: SessionUnreadState | boolean
  archivedAt?: number | null
  speed?: Speed
  reasoningEffort?: string
  modelId?: string
  rightSidebar?: SessionRightSidebarState
  firstPromptAt?: number
  workLocation?: 'local' | 'worktree'
  worktreePath?: string
  environmentId?: string | null
  worktreeSetup?: WorktreeSessionSetup
  pinnedSummaryVisible?: boolean
}

export interface PersistedAppState {
  /** Current schema is 2 (canonical entries). Version 1 / missing still load. */
  version: PersistVersion
  settings: AppSettings
  projects: Project[]
  sessions: Session[]
  /** Persistence key kept for compatibility; payload is ConversationEntry[]. */
  messagesBySession: Record<string, ConversationEntry[]>
  currentSessionId: string | null
  collapsedGroups: Record<string, boolean>
  /** Optional for backward-compatible snapshots. */
  sidebarCollapsed?: boolean
  /** Optional for backward-compatible snapshots. */
  sidebarWidth?: number
  /** Optional for backward-compatible snapshots. */
  rightSidebarCollapsed?: boolean
  /** Optional for backward-compatible snapshots. */
  rightSidebarMaximized?: boolean
  /** Optional for backward-compatible snapshots. */
  rightSidebarWidth?: number | null
  /** Optional for backward-compatible snapshots. */
  pinnedSummaryVisible?: boolean
  /** Optional for backward-compatible snapshots. */
  bottomPanelVisible?: boolean
  /** Optional for backward-compatible snapshots. */
  bottomPanelHeight?: number
  /** Optional legacy sub-agent metadata for backward-compatible snapshots. */
  subAgents?: SubAgentRecord[]
  /** Cached catalog models from remote endpoint. */
  cachedModels?: import('@/features/models/types').ModelCatalogEntry[]
}

export type PersistTimers = {
  setTimeout: (fn: () => void, ms: number) => number | ReturnType<typeof setTimeout>
  clearTimeout: (id: number | ReturnType<typeof setTimeout>) => void
}

export type BindPersistenceOptions = {
  write?: (state: PersistedAppState) => Promise<void>
  debounceMs?: number
  /** Fallback delay when retryDelaysMs is empty. */
  retryMs?: number
  /** Max write attempts per dirty generation (default 3). */
  maxRetryAttempts?: number
  /** Injectable per-retry delays (attempt 2..N). Missing slots reuse last/retryMs. */
  retryDelaysMs?: number[]
  /** Optional diagnostic hook invoked after each failed write attempt. */
  onWriteError?: (error: unknown, attempt: number) => void
  timers?: PersistTimers
}

const STORE_KEY = 'app-state'
const PROJECTS_KEY = 'projects'
const CACHED_MODELS_KEY = 'cachedModels'
const SHORTCUTS_KEY = 'shortcuts'
const UI_KEY = 'ui'
const LOCAL_STORAGE_KEY = 'cpa-app-state'
const LOCAL_STORAGE_SETTINGS_KEY = 'cpa-settings'
const LOCAL_STORAGE_PROJECTS_KEY = 'cpa-projects'
const LOCAL_STORAGE_CACHED_MODELS_KEY = 'cpa-cached-models'
const LOCAL_STORAGE_SHORTCUTS_KEY = 'cpa-shortcuts'
const LOCAL_STORAGE_UI_KEY = 'cpa-ui'
const DEFAULT_PERSIST_DEBOUNCE_MS = 400
const DEFAULT_RETRY_MS = 1000
const DEFAULT_MAX_RETRY_ATTEMPTS = 3
const CURRENT_VERSION: PersistVersion = 2

export const UI_SETTING_KEYS = [
  'theme',
  'themePreset',
  'accentColor',
  'backgroundColor',
  'foregroundColor',
  'uiFontFamily',
  'uiFontWeight',
  'codeFontFamily',
  'codeFontWeight',
  'contrast',
  'compactMode',
  'showLineNumbers',
  'wordWrap',
  'uiScale',
  'uiFontSize',
  'codeFontSize',
  'fontSmoothing',
  'showInMenuBar',
  'showBottomPanel',
  'terminalPosition',
] as const

export const UI_LAYOUT_KEYS = [
  'collapsedGroups',
  'sidebarCollapsed',
  'sidebarWidth',
  'rightSidebarCollapsed',
  'rightSidebarMaximized',
  'rightSidebarWidth',
  'pinnedSummaryVisible',
  'bottomPanelVisible',
  'bottomPanelHeight',
] as const

export const deletedRemoteSessionIds = new Set<string>()
const loadedSessionIds = new Set<string>()
const staleSessionIds = new Set<string>()
const sessionEntriesRevisions = new Map<string, string>()
const pendingEntryRemovals = new Map<string, Map<string, number>>()
let entryRemovalSequence = 0
const sessionReadEpochs = new Map<string, number>()
const sessionHydrations = new Map<string, { epoch: number; promise: Promise<ConversationEntry[]> }>()
const sessionWrites = new Map<string, Promise<void>>()
const sessionWriteEpochs = new Map<string, number>()
const persistingSessionIds = new Set<string>()
const historyConflicts = new Map<string, { payload: SessionFilePayload; toastId: string }>()
const historyRecoveries = new Map<string, Promise<void>>()

export function hasUnsavedSessionHistory(sessionId: string): boolean {
    return dirtySessionIds.has(sessionId) || persistingSessionIds.has(sessionId) ||
        sessionWrites.has(sessionId) || historyConflicts.has(sessionId) ||
        historyRecoveries.has(sessionId) || Boolean(pendingEntryRemovals.get(sessionId)?.size)
}
let reloadDepth = 0

export function withSuppressedPersistence<T>(fn: () => T): T {
  reloadDepth += 1
  try {
    const result = fn()
    if (result && typeof (result as any).then === 'function') {
      return (result as any).finally(() => {
        reloadDepth -= 1
      })
    }
    reloadDepth -= 1
    return result
  } catch (err) {
    reloadDepth -= 1
    throw err
  }
}

export function markRemoteSessionDeleted(sessionId: string): void {
  deletedRemoteSessionIds.add(sessionId)
  sessionWriteEpochs.set(sessionId, (sessionWriteEpochs.get(sessionId) ?? 0) + 1)
  invalidateSessionDiskCache(sessionId)
  dirtySessionIds.delete(sessionId)
  const conflict = historyConflicts.get(sessionId)
  if (conflict) useUiStore.getState().dismissToast(conflict.toastId)
  historyConflicts.delete(sessionId)
  pendingEntryRemovals.delete(sessionId)
  sessionEntriesRevisions.delete(sessionId)
}

export function invalidateSessionDiskCache(sessionId: string): void {
  loadedSessionIds.delete(sessionId)
  staleSessionIds.add(sessionId)
  sessionReadEpochs.set(sessionId, (sessionReadEpochs.get(sessionId) ?? 0) + 1)
}

onRemoteSessionDelete((sessionId) => {
  markRemoteSessionDeleted(sessionId)
})

subscribeMessageEvents((event) => {
  if ((event.type === 'session-evicted' || event.type === 'session-cleared') && !hasUnsavedSessionHistory(event.sessionId)) {
    loadedSessionIds.delete(event.sessionId)
    sessionEntriesRevisions.delete(event.sessionId)
    pendingEntryRemovals.delete(event.sessionId)
    sessionReadEpochs.set(event.sessionId, (sessionReadEpochs.get(event.sessionId) ?? 0) + 1)
  }
  if (event.type === 'entries-updated' && reloadDepth === 0 && event.removedEntryIds?.length) {
    const removed = pendingEntryRemovals.get(event.sessionId) ?? new Map<string, number>()
    for (const id of event.removedEntryIds) removed.set(id, ++entryRemovalSequence)
    pendingEntryRemovals.set(event.sessionId, removed)
  }
})

const VALID_SPEEDS = new Set<Speed>(['standard', 'fast', 'max'])
const VALID_LOCALES = new Set<Locale>(['zh-CN', 'en'])
const VALID_SUBAGENT_ICONS = new Set<SubAgentIconId>([
  'sparkle',
  'atom',
  'flower',
  'sun',
  'hexagon',
  'orbit',
  'flame',
  'brain',
])
const VALID_REASONING_EFFORTS = new Set<string>([
  'off',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
])

const LEGACY_DEMO_PROJECT_PATHS = new Map([
  ['CLIProxyAPI', '/demo/CLIProxyAPI'],
  ['CLIProxyAPIHome', '/demo/CLIProxyAPIHome'],
])

const TERMINAL_STATUSES = new Set(['done', 'aborted', 'error'])

type PersistUrgency = 'none' | 'debounce' | 'immediate'

function normalizeProjects(projects: Project[]): Project[] {
  return projects.map((project) => {
    let paths = getProjectPaths(project)
    const legacyPath = LEGACY_DEMO_PROJECT_PATHS.get(project.name)
    if (legacyPath) {
      paths = paths.filter((path) => path !== legacyPath)
    }
    return {
      ...project,
      ...createProjectPathsPatch(paths),
    }
  })
}

function sanitizeWebServer(value: unknown): WebServerSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_SETTINGS.webServer! }
  }
  const raw = value as Partial<WebServerSettings>
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : false
  const host =
    typeof raw.host === 'string' && raw.host.trim()
      ? raw.host.trim()
      : '127.0.0.1'
  const port =
    typeof raw.port === 'number' &&
    Number.isFinite(raw.port) &&
    raw.port >= 1 &&
    raw.port <= 65535
      ? Math.floor(raw.port)
      : 18080
  const password = typeof raw.password === 'string' ? raw.password : ''
  return { enabled, host, port, password }
}

function sanitizeGitSettings(value: unknown): GitSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_GIT_SETTINGS }
  }
  const raw = value as Partial<GitSettings>
  return {
    branchPrefix:
      typeof raw.branchPrefix === 'string'
        ? raw.branchPrefix
        : DEFAULT_GIT_SETTINGS.branchPrefix,
    mergeMethod: raw.mergeMethod === 'squash' ? 'squash' : 'merge',
    alwaysForcePush:
      typeof raw.alwaysForcePush === 'boolean'
        ? raw.alwaysForcePush
        : DEFAULT_GIT_SETTINGS.alwaysForcePush,
    createDraftPr:
      typeof raw.createDraftPr === 'boolean'
        ? raw.createDraftPr
        : DEFAULT_GIT_SETTINGS.createDraftPr,
    reviewPresentation:
      raw.reviewPresentation === 'inline' ? 'inline' : 'separate',
    autoMergeWhenReady:
      typeof raw.autoMergeWhenReady === 'boolean'
        ? raw.autoMergeWhenReady
        : DEFAULT_GIT_SETTINGS.autoMergeWhenReady,
    autoMergeInstructions:
      typeof raw.autoMergeInstructions === 'string'
        ? raw.autoMergeInstructions
        : '',
    commitInstructions:
      typeof raw.commitInstructions === 'string'
        ? raw.commitInstructions
        : '',
    prInstructions:
      typeof raw.prInstructions === 'string'
        ? raw.prInstructions
        : '',
  }
}

function sanitizeWorktreeSettings(value: unknown): WorktreeSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_WORKTREE_SETTINGS }
  }
  const raw = value as Partial<WorktreeSettings>
  const deleteLimit =
    typeof raw.deleteLimit === 'number' &&
    Number.isFinite(raw.deleteLimit) &&
    raw.deleteLimit >= 0
      ? Math.round(raw.deleteLimit)
      : DEFAULT_WORKTREE_SETTINGS.deleteLimit

  return {
    rootDir:
      typeof raw.rootDir === 'string'
        ? raw.rootDir
        : DEFAULT_WORKTREE_SETTINGS.rootDir,
    fetchUpstream:
      typeof raw.fetchUpstream === 'boolean'
        ? raw.fetchUpstream
        : DEFAULT_WORKTREE_SETTINGS.fetchUpstream,
    autoDeleteOld:
      typeof raw.autoDeleteOld === 'boolean'
        ? raw.autoDeleteOld
        : DEFAULT_WORKTREE_SETTINGS.autoDeleteOld,
    deleteLimit,
  }
}

export function sanitizeSubagentRoles(value: unknown): SubagentRole[] {
  if (!Array.isArray(value)) {
    return Array.isArray(DEFAULT_SUBAGENT_SETTINGS.roles)
      ? [...DEFAULT_SUBAGENT_SETTINGS.roles]
      : []
  }
  const roles: SubagentRole[] = []
  for (const item of value) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : createId()
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const description = typeof item.description === 'string' ? item.description : ''
    const modelId = typeof item.modelId === 'string' ? item.modelId.trim() : ''
    const reasoningEffort = typeof item.reasoningEffort === 'string' ? item.reasoningEffort.trim() : 'default'
    roles.push({
      id,
      name,
      description,
      modelId,
      reasoningEffort,
    })
  }
  return roles
}

function sanitizeSubagentsSettings(raw: any): SubagentsSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_SUBAGENT_SETTINGS,
      roles: Array.isArray(DEFAULT_SUBAGENT_SETTINGS.roles)
        ? [...DEFAULT_SUBAGENT_SETTINGS.roles]
        : [],
    }
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SUBAGENT_SETTINGS.enabled,
    concurrency:
      typeof raw.concurrency === 'number' && raw.concurrency > 0
        ? Math.round(raw.concurrency)
        : DEFAULT_SUBAGENT_SETTINGS.concurrency,
    maxPerSession:
      typeof raw.maxPerSession === 'number' && raw.maxPerSession > 0
        ? Math.round(raw.maxPerSession)
        : DEFAULT_SUBAGENT_SETTINGS.maxPerSession,
    maxDepth:
      typeof raw.maxDepth === 'number' && raw.maxDepth > 0
        ? Math.round(raw.maxDepth)
        : DEFAULT_SUBAGENT_SETTINGS.maxDepth,
    roles: sanitizeSubagentRoles(raw.roles),
  }
}

function sanitizeEditorSettings(value: unknown): EditorSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_EDITOR_SETTINGS }
  }
  const raw = value as Partial<EditorSettings>
  const sendShortcut: EditorSendShortcut =
    raw.sendShortcut === 'enter' ? 'enter' : 'cmdEnter'
  const followUpMode: EditorFollowUpMode =
    raw.followUpMode === 'queue' ? 'queue' : 'steer'
  return {
    showContextUsage:
      typeof raw.showContextUsage === 'boolean'
        ? raw.showContextUsage
        : DEFAULT_EDITOR_SETTINGS.showContextUsage,
    sendShortcut,
    followUpMode,
  }
}

function sanitizeModelSettings(value: unknown): ModelSettingsConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_MODEL_SETTINGS }
  }
  const raw = value as Partial<ModelSettingsConfig>
  const models: Record<string, ModelCustomConfig> = {}
  if (typeof raw.models === 'object' && raw.models !== null) {
    for (const [key, val] of Object.entries(raw.models)) {
      if (typeof val === 'object' && val !== null) {
        const item = val as Partial<ModelCustomConfig>
        models[key] = {
          enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
          enabledReasoningLevels: Array.isArray(item.enabledReasoningLevels)
            ? item.enabledReasoningLevels.filter((lvl: unknown): lvl is string => typeof lvl === 'string')
            : undefined,
          ttl:
            typeof item.ttl === 'number' && Number.isFinite(item.ttl) && item.ttl > 0
              ? Math.floor(item.ttl)
              : undefined,
          contextWindow:
            typeof item.contextWindow === 'number' && Number.isFinite(item.contextWindow) && item.contextWindow > 0
              ? Math.floor(item.contextWindow)
              : undefined,
        }
      }
    }
  }

  const cacheWarmingRaw = raw.cacheWarming
  const mode: CacheWarmingMode =
    cacheWarmingRaw?.mode === 'streaming' ||
    cacheWarmingRaw?.mode === 'idle' ||
    cacheWarmingRaw?.mode === 'off'
      ? cacheWarmingRaw.mode
      : (DEFAULT_MODEL_SETTINGS.cacheWarming?.mode ?? 'off')
  const maxWarmingTime =
    typeof cacheWarmingRaw?.maxWarmingTime === 'number' &&
    Number.isFinite(cacheWarmingRaw.maxWarmingTime) &&
    cacheWarmingRaw.maxWarmingTime > 0
      ? Math.floor(cacheWarmingRaw.maxWarmingTime)
      : (DEFAULT_MODEL_SETTINGS.cacheWarming?.maxWarmingTime ?? 3600)

  return {
    enableAll:
      typeof raw.enableAll === 'boolean'
        ? raw.enableAll
        : DEFAULT_MODEL_SETTINGS.enableAll,
    defaultTtl:
      typeof raw.defaultTtl === 'number' && Number.isFinite(raw.defaultTtl) && raw.defaultTtl > 0
        ? Math.floor(raw.defaultTtl)
        : (DEFAULT_MODEL_SETTINGS.defaultTtl ?? 300),
    models,
    modelOrder: Array.isArray(raw.modelOrder)
      ? raw.modelOrder.filter((id: unknown): id is string => typeof id === 'string')
      : [],
    cacheWarming: {
      mode,
      maxWarmingTime,
    },
  }
}

function normalizeSettings(
  partial: Partial<AppSettings> | null | undefined,
): AppSettings {
  const next = { ...DEFAULT_SETTINGS, ...(partial ?? {}) }
  const rawCliProxyApi = partial?.cliProxyApi
  const cliProxyApi = {
    baseUrl:
      rawCliProxyApi && typeof rawCliProxyApi.baseUrl === 'string'
        ? rawCliProxyApi.baseUrl.trim()
        : '',
    apiKey:
      rawCliProxyApi && typeof rawCliProxyApi.apiKey === 'string'
        ? rawCliProxyApi.apiKey
        : '',
  }
  const reasoningLevel =
    typeof next.reasoningLevel === 'string' && next.reasoningLevel.trim()
      ? next.reasoningLevel
      : DEFAULT_SETTINGS.reasoningLevel

  return {
    ...next,
    cliProxyApi,
    reasoningLevel,
    speed: VALID_SPEEDS.has(next.speed)
      ? next.speed
      : DEFAULT_SETTINGS.speed,
    locale: VALID_LOCALES.has(next.locale)
      ? next.locale
      : DEFAULT_SETTINGS.locale,
    compactionThresholdPercent: normalizeCompactionThresholdPercent(
      next.compactionThresholdPercent,
    ),
    fastContextCompaction:
      typeof next.fastContextCompaction === 'boolean'
        ? next.fastContextCompaction
        : DEFAULT_SETTINGS.fastContextCompaction,
    resumeUnfinishedConversations:
      typeof next.resumeUnfinishedConversations === 'boolean'
        ? next.resumeUnfinishedConversations
        : DEFAULT_SETTINGS.resumeUnfinishedConversations,
    preventSleep:
      typeof next.preventSleep === 'boolean'
        ? next.preventSleep
        : DEFAULT_SETTINGS.preventSleep,
    showInMenuBar:
      typeof next.showInMenuBar === 'boolean'
        ? next.showInMenuBar
        : DEFAULT_SETTINGS.showInMenuBar,
    headlessCloseAction:
      next.headlessCloseAction === 'quit' || next.headlessCloseAction === 'continue_headless'
        ? next.headlessCloseAction
        : DEFAULT_SETTINGS.headlessCloseAction,
    showBottomPanel:
      typeof next.showBottomPanel === 'boolean'
        ? next.showBottomPanel
        : DEFAULT_SETTINGS.showBottomPanel,
    terminalPosition:
      next.terminalPosition === 'right' || next.terminalPosition === 'bottom'
        ? next.terminalPosition
        : DEFAULT_SETTINGS.terminalPosition,
    themePreset:
      typeof next.themePreset === 'string' && next.themePreset
        ? next.themePreset
        : DEFAULT_SETTINGS.themePreset,
    accentColor:
      typeof next.accentColor === 'string' && next.accentColor
        ? next.accentColor
        : DEFAULT_SETTINGS.accentColor,
    backgroundColor:
      typeof next.backgroundColor === 'string' && next.backgroundColor
        ? next.backgroundColor
        : DEFAULT_SETTINGS.backgroundColor,
    foregroundColor:
      typeof next.foregroundColor === 'string' && next.foregroundColor
        ? next.foregroundColor
        : DEFAULT_SETTINGS.foregroundColor,
    uiFontFamily:
      typeof next.uiFontFamily === 'string' && next.uiFontFamily
        ? next.uiFontFamily
        : DEFAULT_SETTINGS.uiFontFamily,
    uiFontWeight:
      typeof next.uiFontWeight === 'string' && next.uiFontWeight
        ? next.uiFontWeight
        : DEFAULT_SETTINGS.uiFontWeight,
    codeFontFamily:
      typeof next.codeFontFamily === 'string' && next.codeFontFamily
        ? next.codeFontFamily
        : DEFAULT_SETTINGS.codeFontFamily,
    codeFontWeight:
      typeof next.codeFontWeight === 'string' && next.codeFontWeight
        ? next.codeFontWeight
        : DEFAULT_SETTINGS.codeFontWeight,
    contrast:
      typeof next.contrast === 'number' && Number.isFinite(next.contrast)
        ? Math.min(100, Math.max(0, Math.round(next.contrast)))
        : DEFAULT_SETTINGS.contrast,
    compactMode:
      typeof next.compactMode === 'boolean'
        ? next.compactMode
        : DEFAULT_SETTINGS.compactMode,
    showLineNumbers:
      typeof next.showLineNumbers === 'boolean'
        ? next.showLineNumbers
        : DEFAULT_SETTINGS.showLineNumbers,
    wordWrap:
      typeof next.wordWrap === 'boolean'
        ? next.wordWrap
        : DEFAULT_SETTINGS.wordWrap,
    uiScale:
      typeof next.uiScale === 'number' && Number.isFinite(next.uiScale)
        ? next.uiScale
        : DEFAULT_SETTINGS.uiScale,
    uiFontSize:
      typeof next.uiFontSize === 'number' && Number.isFinite(next.uiFontSize)
        ? Math.max(9, Math.min(24, Math.round(next.uiFontSize)))
        : DEFAULT_SETTINGS.uiFontSize,
    codeFontSize:
      typeof next.codeFontSize === 'number' && Number.isFinite(next.codeFontSize)
        ? Math.max(9, Math.min(24, Math.round(next.codeFontSize)))
        : DEFAULT_SETTINGS.codeFontSize,
    fontSmoothing:
      typeof next.fontSmoothing === 'boolean'
        ? next.fontSmoothing
        : DEFAULT_SETTINGS.fontSmoothing,
    webServer: sanitizeWebServer(next.webServer),
    shortcuts:
      typeof next.shortcuts === 'object' && next.shortcuts !== null
        ? next.shortcuts
        : undefined,
    modelSettings: sanitizeModelSettings(next.modelSettings),
    git: sanitizeGitSettings(next.git),
    worktrees: sanitizeWorktreeSettings(next.worktrees),
    subagents: sanitizeSubagentsSettings(next.subagents),
    editor: sanitizeEditorSettings(next.editor),
  }
}

let persistTimer: ReturnType<typeof setTimeout> | number | null = null
let retryTimer: ReturnType<typeof setTimeout> | number | null = null
let bound = false
let disposed = false
let debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
let retryMs = DEFAULT_RETRY_MS
let maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS
let retryDelaysMs: number[] = []
let onWriteError: ((error: unknown, attempt: number) => void) | null = null
let customWrite: ((state: PersistedAppState) => Promise<void>) | null = null
let timers: PersistTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}
let unsubscribers: Array<() => void> = []
let writeInFlight = false
let writeQueued = false
let dirtyGeneration = 0
/** Session payloads changed since the last durable write. */
const dirtySessionIds = new Set<string>()
/** Epoch tokens so stale debounce/retry callbacks no-op after clear. */
let debounceEpoch = 0
let retryEpoch = 0
/** Attempts consumed for the current dirty generation. */
let writeAttempt = 0
let attemptGeneration = -1
let lastWriteError: string | null = null
/** Resolvers waiting on the current/next durable write cycle. */
let writeWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> =
  []

async function getNativeStore() {
  // Electron, test overrides, and browser clients talking to the desktop host.
  // Browser must reuse desktop ~/.coding-professional-agent settings via RPC;
  // otherwise web login falls back to empty localStorage and shows startup-config-form.
  if (!canUseHostKvStore()) {
    console.warn('[PersistenceService] canUseHostKvStore() is false')
    return null
  }
  const bridge = getHostBridge()
  if (bridge?.KVStoreGet && bridge?.KVStoreSet) {
    return {
      Get: (key: string) => bridge.KVStoreGet(key),
      Set: async (key: string, value: unknown) => {
        await bridge.KVStoreSet(key, value)
      },
    }
  }
  console.warn('[PersistenceService] bridge KVStore methods unavailable')
  return null
}

export function setPersistTimers(next: PersistTimers): void {
  timers = next
}

function clearPersistTimer(): void {
  if (persistTimer !== null) {
    timers.clearTimeout(persistTimer)
    persistTimer = null
  }
  // Invalidate any in-flight debounce callback that still holds a closed-over handle.
  debounceEpoch += 1
}

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    timers.clearTimeout(retryTimer)
    retryTimer = null
  }
  retryEpoch += 1
}

function clearAllPersistTimers(): void {
  clearPersistTimer()
  clearRetryTimer()
}

function delayForRetryAttempt(failedAttempt: number): number {
  // failedAttempt is 1-based count of the attempt that just failed.
  // Delay index 0 applies before attempt 2, etc.
  const index = Math.max(0, failedAttempt - 1)
  if (retryDelaysMs.length === 0) return retryMs
  if (index < retryDelaysMs.length) return retryDelaysMs[index]
  return retryDelaysMs[retryDelaysMs.length - 1] ?? retryMs
}

function createSessionMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * Recursively sanitize conversation payloads for persistence.
 * Keeps only canonical JSON-safe fields; strips scratch/runtime/cycles.
 * Image base64 data is part of the canonical schema and is retained.
 */
export function sanitizeConversationEntries(
  bySession: Record<string, ConversationEntry[]>,
): Record<string, ConversationEntry[]> {
  const out = createSessionMap<ConversationEntry[]>()
  const source = bySession ?? createSessionMap<ConversationEntry[]>()
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') continue
    const sessionId = key
    const entries = (source as Record<string, ConversationEntry[]>)[sessionId]
    if (!Array.isArray(entries)) {
      out[sessionId] = []
      continue
    }
    out[sessionId] = entries
      .map((entry) => sanitizeEntry(entry))
      .filter((entry): entry is ConversationEntry => entry !== null)
  }
  return out
}

function sanitizeEntry(value: unknown): ConversationEntry | null {
  if (!isPlainObject(value)) return null
  const kind = value.kind
  if (kind !== 'user' && kind !== 'assistant' && kind !== 'toolResult' && kind !== 'compaction') {
    return null
  }
  const id = asString(value.id)
  const sessionId = asString(value.sessionId)
  if (!id || !sessionId) return null
  const createdAt = asFiniteNumber(value.createdAt) ?? 0
  const version = 1 as const

  if (kind === 'user') {
    const pausedMs = asFiniteNumber(value.pausedMs)
    const reasoningEffort = asString(value.reasoningEffort)
    return {
      id,
      sessionId,
      createdAt,
      kind: 'user',
      version,
      content: sanitizeContentBlocks(value.content),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(pausedMs !== undefined && pausedMs > 0 ? { pausedMs } : {}),
    }
  }

  if (kind === 'assistant') {
    const status = sanitizeStatus(value.status)
    const stopReason = sanitizeStopReason(value.stopReason, status)
    const entry: import('@/features/agent-runtime/session/types').AssistantEntry = {
      id,
      sessionId,
      createdAt,
      kind: 'assistant',
      version,
      content: sanitizeContentBlocks(value.content),
      status,
      stopReason,
    }
    const api = asString(value.api)
    const provider = asString(value.provider)
    const model = asString(value.model)
    const errorMessage = asString(value.errorMessage)
    const responseId = asString(value.responseId)
    if (api) entry.api = api
    if (provider) entry.provider = provider
    if (model) entry.model = model
    const reasoningEffort = asString(value.reasoningEffort)
    if (reasoningEffort) entry.reasoningEffort = reasoningEffort
    if (errorMessage) entry.errorMessage = errorMessage
    if (responseId) entry.responseId = responseId
    const usage = sanitizeUsage(value.usage)
    if (usage) entry.usage = usage
    const completedAt = asFiniteNumber(value.completedAt)
    if (completedAt !== undefined) entry.completedAt = completedAt
    const pausedMs = asFiniteNumber(value.pausedMs)
    if (pausedMs !== undefined && pausedMs > 0) entry.pausedMs = pausedMs
    return entry
  }

  if (kind === 'toolResult') {
    const toolCallId = asString(value.toolCallId)
    if (!toolCallId) return null
    return {
      id,
      sessionId,
      createdAt,
      kind: 'toolResult',
      version,
      toolCallId,
      toolName: asString(value.toolName) ?? 'tool',
      content: sanitizeToolResultContent(value.content),
      isError: value.isError === true,
    }
  }

  // compaction
  const summary = typeof value.summary === 'string' ? value.summary : ''
  const firstKeptEntryId = asString(value.firstKeptEntryId) ?? ''
  const entry: import('@/features/agent-runtime/session/types').CompactionEntry = {
    id,
    sessionId,
    createdAt,
    kind: 'compaction',
    version,
    summary,
    firstKeptEntryId,
  }
  const tokensBefore = asFiniteNumber(value.tokensBefore)
  if (tokensBefore !== undefined) entry.tokensBefore = tokensBefore
  const usage = sanitizeUsage(value.usage)
  if (usage) entry.usage = usage
  const readFiles = asStringArray(value.readFiles)
  if (readFiles) entry.readFiles = readFiles
  const modifiedFiles = asStringArray(value.modifiedFiles)
  if (modifiedFiles) entry.modifiedFiles = modifiedFiles
  return entry
}

function sanitizeContentBlocks(value: unknown): ConversationEntry extends never ? never : import('@/features/agent-runtime/session/types').ContentBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: import('@/features/agent-runtime/session/types').ContentBlock[] = []
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.type !== 'string') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      const block: import('@/features/agent-runtime/session/types').ContentBlock = {
        type: 'text',
        text: item.text,
      }
      if (typeof item.signature === 'string') block.signature = item.signature
      blocks.push(block)
      continue
    }
    if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      blocks.push({
        type: 'image',
        data: item.data,
        mimeType: item.mimeType,
      })
      continue
    }
    if (item.type === 'thinking' && typeof item.thinking === 'string') {
      const block: import('@/features/agent-runtime/session/types').ContentBlock = {
        type: 'thinking',
        thinking: item.thinking,
      }
      if (typeof item.signature === 'string') block.signature = item.signature
      blocks.push(block)
      continue
    }
    if (
      (item.type === 'toolCall' || item.type === 'tool_call') &&
      typeof item.id === 'string' &&
      typeof item.name === 'string'
    ) {
      const args = isPlainObject(item.arguments)
        ? sanitizeJsonValue(item.arguments, new WeakSet()) as Record<string, unknown>
        : isPlainObject(item.args)
          ? sanitizeJsonValue(item.args, new WeakSet()) as Record<string, unknown>
          : {}
      blocks.push({
        type: 'toolCall',
        id: item.id,
        name: item.name,
        arguments: args ?? {},
      })
    }
  }
  return blocks
}

function sanitizeToolResultContent(
  value: unknown,
): import('@/features/agent-runtime/session/types').ToolResultContentBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: import('@/features/agent-runtime/session/types').ToolResultContentBlock[] = []
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.type !== 'string') continue
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
      continue
    }
    if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    ) {
      blocks.push({
        type: 'image',
        data: item.data,
        mimeType: item.mimeType,
      })
    }
  }
  return blocks
}

function sanitizeUsage(
  value: unknown,
): import('@/features/agent-runtime/session/types').Usage | undefined {
  if (!isPlainObject(value)) return undefined
  const input = asFiniteNumber(value.input)
  const output = asFiniteNumber(value.output)
  const cacheRead = asFiniteNumber(value.cacheRead)
  const cacheWrite = asFiniteNumber(value.cacheWrite)
  const totalTokens = asFiniteNumber(value.totalTokens)
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined ||
    !isPlainObject(value.cost)
  ) {
    return undefined
  }
  const costInput = asFiniteNumber(value.cost.input)
  const costOutput = asFiniteNumber(value.cost.output)
  const costCacheRead = asFiniteNumber(value.cost.cacheRead)
  const costCacheWrite = asFiniteNumber(value.cost.cacheWrite)
  const costTotal = asFiniteNumber(value.cost.total)
  if (
    costInput === undefined ||
    costOutput === undefined ||
    costCacheRead === undefined ||
    costCacheWrite === undefined ||
    costTotal === undefined
  ) {
    return undefined
  }
  const usage: import('@/features/agent-runtime/session/types').Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  }
  const reasoning = asFiniteNumber(value.reasoning)
  if (reasoning !== undefined) usage.reasoning = reasoning
  return usage
}

function sanitizeStatus(
  value: unknown,
): import('@/features/agent-runtime/session/types').EntryStatus {
  if (value === 'streaming' || value === 'done' || value === 'error' || value === 'aborted') {
    return value
  }
  return 'done'
}

function sanitizeStopReason(
  value: unknown,
  status: import('@/features/agent-runtime/session/types').EntryStatus,
): import('@/features/agent-runtime/session/types').StopReason {
  if (
    value === 'pending' ||
    value === 'stop' ||
    value === 'length' ||
    value === 'toolUse' ||
    value === 'error' ||
    value === 'aborted'
  ) {
    return value
  }
  if (status === 'aborted') return 'aborted'
  if (status === 'error') return 'error'
  if (status === 'streaming') return 'pending'
  return 'stop'
}

/**
 * Strip non-JSON values and break true cycles for nested plain data (tool args).
 * Uses path-scoped ancestor tracking so shared (non-cyclic) refs are preserved
 * at every occurrence; true cycles become null placeholders.
 */
function sanitizeJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  // Deterministic BigInt tag so sanitize does not drop the parent entry.
  if (typeof value === 'bigint') {
    return { $type: 'bigint', value: value.toString() }
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (typeof value !== 'object') return undefined
  if (ancestors.has(value)) return null
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value
        .map((item) => sanitizeJsonValue(item, ancestors))
        .filter((item) => item !== undefined)
    }
    const out = Object.create(null) as Record<string, unknown>
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        key === 'partialJson' ||
        key === 'runtimeDetails' ||
        key === 'details' ||
        key === 'signal'
      ) {
        continue
      }
      const cleaned = sanitizeJsonValue(nested, ancestors)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next = value.filter((item): item is string => typeof item === 'string')
  return next.length > 0 ? next : undefined
}

function sanitizeSubAgentIcon(
  value: unknown,
): SubAgentIconId {
  if (
    typeof value === 'string' &&
    VALID_SUBAGENT_ICONS.has(
      value as SubAgentIconId,
    )
  ) {
    return value as SubAgentIconId
  }
  return 'sparkle'
}

function sanitizeSubAgentReasoningEffort(
  value: unknown,
): string | undefined {
  if (
    typeof value === 'string' &&
    VALID_REASONING_EFFORTS.has(value.toLowerCase())
  ) {
    return value.toLowerCase()
  }
  return undefined
}

export function sanitizeSubAgents(
  agents: readonly SubAgentRecord[],
): SubAgentRecord[] {
  if (!Array.isArray(agents)) return []
  const result: SubAgentRecord[] = []
  for (const item of agents) {
    if (!isPlainObject(item)) continue
    const id = asString(item.id)
    const sessionId = asString(item.sessionId)
    if (!id || !sessionId) continue
    const name = asString(item.name) ?? 'agent'
    const parentSessionId = asString(item.parentSessionId) ?? ''
    const modelId = asString(item.modelId) ?? ''
    const status = sanitizeSubAgentStatus(item.status)
    const createdAt = asFiniteNumber(item.createdAt) ?? 0
    const updatedAt = asFiniteNumber(item.updatedAt) ?? 0

    const record: SubAgentRecord = {
      id,
      name,
      parentSessionId,
      sessionId,
      modelId,
      status,
      createdAt,
      updatedAt,
      color: typeof item.color === 'string' ? item.color : '#9b7dff',
      icon: sanitizeSubAgentIcon(item.icon),
    }
    const parentToolCallId = asString(item.parentToolCallId)
    if (parentToolCallId) record.parentToolCallId = parentToolCallId
    const lastMessage =
      typeof item.lastMessage === 'string' ? item.lastMessage : undefined
    if (lastMessage) record.lastMessage = lastMessage
    const errorMessage =
      typeof item.errorMessage === 'string' ? item.errorMessage : undefined
    if (errorMessage) record.errorMessage = errorMessage
    const reasoningEffort = sanitizeSubAgentReasoningEffort(item.reasoningEffort)
    if (reasoningEffort) {
      record.reasoningEffort = reasoningEffort
    }
    const completedAt = asFiniteNumber(item.completedAt)
    if (completedAt !== undefined) {
      record.completedAt = completedAt
    }
    const pausedMs = asFiniteNumber(item.pausedMs)
    if (pausedMs !== undefined && pausedMs > 0) {
      record.pausedMs = pausedMs
    }
    result.push(record)
  }
  return result
}

function sanitizeSubAgentStatus(
  value: unknown,
): SubAgentRecord['status'] {
  if (
    value === 'running' ||
    value === 'queued' ||
    value === 'completed' ||
    value === 'error' ||
    value === 'aborted'
  ) {
    return value
  }
  return 'aborted'
}

export function serializeAppState(): PersistedAppState {
  const rawEntries = useMessageStore.getState().entriesBySession
  return {
    version: CURRENT_VERSION,
    settings: useSettingsStore.getState().settings,
    projects: useProjectStore.getState().projects,
    sessions: useSessionStore.getState().sessions,
    // Session payloads are sanitized individually by saveSessionData. Keeping
    // store references here lets incremental persistence avoid cloning every
    // cached conversation when only one session changed.
    messagesBySession: rawEntries,
    currentSessionId: useSessionStore.getState().currentSessionId,
    collapsedGroups: useUiStore.getState().collapsedGroups,
    sidebarCollapsed: useUiStore.getState().sidebarCollapsed,
    sidebarWidth: useUiStore.getState().sidebarWidth,
    rightSidebarCollapsed: useUiStore.getState().rightSidebarCollapsed,
    rightSidebarMaximized: useUiStore.getState().rightSidebarMaximized,
    rightSidebarWidth: useUiStore.getState().rightSidebarWidth,
    pinnedSummaryVisible: useUiStore.getState().pinnedSummaryVisible,
    bottomPanelVisible: useUiStore.getState().bottomPanelVisible,
    bottomPanelHeight: useUiStore.getState().bottomPanelHeight,
    cachedModels: useModelCatalogStore.getState().models as import('@/features/models/types').ModelCatalogEntry[],
  }
}

export function applyPersistedState(state: PersistedAppState): void {
  try {
    useSettingsStore.getState().hydrate(normalizeSettings(state.settings))
  } catch {
    useSettingsStore.getState().hydrate(DEFAULT_SETTINGS)
  }
  try {
    useProjectStore.getState().hydrate(normalizeProjects(state.projects ?? []))
  } catch {
    // Keep existing projects if hydrate fails.
  }
  try {
    const rawSessions = state.sessions ?? []
    useSessionStore.getState().hydrate({
      sessions: rawSessions,
      currentSessionId: state.currentSessionId ?? null,
    })
    const setupsToRestore: Record<string, WorktreeSessionSetup> = {}
    for (const s of rawSessions) {
      if (s.workLocation === 'worktree') {
        const resolvedSetup = resolveHydratedWorktreeSetup(s.id, s.worktreeSetup, {
          workLocation: s.workLocation,
          worktreePath: s.worktreePath,
          projectId: s.projectId,
          branch: s.branch,
          environmentId: s.environmentId,
        })
        if (resolvedSetup) {
          setupsToRestore[s.id] = resolvedSetup
          useSessionStore.getState().setSessionWorktreeSetup?.(s.id, resolvedSetup, {
            touchUpdatedAt: false,
            updateProject: false,
          })
        }
      }
    }
    if (Object.keys(setupsToRestore).length > 0) {
      useWorktreeSetupStore.getState().importSetups(setupsToRestore)
    }
  } catch {
    // Keep existing sessions if hydrate fails.
  }
  try {
    // Unified Task2 migration path for legacy / mixed / canonical payloads.
    useMessageStore.getState().hydrate(state.messagesBySession ?? {})
  } catch {
    useMessageStore.getState().hydrate({})
  }
  try {
    const activeSessionId = useSessionStore.getState().currentSessionId
    const activeSession = useSessionStore
      .getState()
      .sessions.find((s) => s.id === activeSessionId)

    useUiStore.getState().hydrate({
      collapsedGroups: state.collapsedGroups ?? {},
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      ...(!activeSession
        ? {
            rightSidebarCollapsed: state.rightSidebarCollapsed,
            rightSidebarMaximized: state.rightSidebarMaximized,
            rightSidebarWidth: state.rightSidebarWidth,
          }
        : {}),
      pinnedSummaryVisible: state.pinnedSummaryVisible,
      bottomPanelVisible: state.bottomPanelVisible,
      bottomPanelHeight: state.bottomPanelHeight,
    })

    if (activeSession) {
      useUiStore.getState().restoreForSession(activeSession.rightSidebar ?? null)
    }
  } catch {
    // Ignore UI hydrate failures.
  }
  try {
    if (
      state.subAgents &&
      Array.isArray(state.subAgents) &&
      state.subAgents.length > 0
    ) {
      const validSessionIds = new Set((state.sessions ?? []).map((s) => s.id))
      const sanitized = sanitizeSubAgents(state.subAgents).map((agent) => ({
        ...agent,
        status:
          agent.status === 'running' || agent.status === 'queued'
            ? ('aborted' as const)
            : agent.status,
      }))
      const validSubAgents = sanitized.filter(
        (agent) =>
          !agent.parentSessionId || validSessionIds.has(agent.parentSessionId),
      )
      if (validSubAgents.length > 0) {
        const currentAgents = useSubAgentStore.getState().agents
        const existingIds = new Set(currentAgents.map((a) => a.id))
        const newAgents = validSubAgents.filter((a) => !existingIds.has(a.id))
        if (newAgents.length > 0) {
          useSubAgentStore
            .getState()
            .replaceAll([...currentAgents, ...newAgents])
        }
      }
    }
  } catch {
    // Ignore legacy subagents hydrate error
  }
  try {
    if (state.cachedModels && Array.isArray(state.cachedModels) && state.cachedModels.length > 0) {
      useModelCatalogStore.getState().hydrate(stripHiddenReasoningLevels(state.cachedModels))
    }
  } catch {
    // Keep fallback models if hydrate fails.
  }
}

function isPersistedAppState(value: unknown): value is PersistedAppState {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<PersistedAppState> & { version?: unknown }
  const versionOk =
    record.version === undefined ||
    record.version === 1 ||
    record.version === 2
  return (
    versionOk &&
    (record.settings === undefined || typeof record.settings === 'object') &&
    (record.projects === undefined || Array.isArray(record.projects)) &&
    (record.sessions === undefined || Array.isArray(record.sessions)) &&
    (record.messagesBySession === undefined ||
      (typeof record.messagesBySession === 'object' &&
        record.messagesBySession !== null))
  )
}

function parseSessionFilePayload(
  sessionId: string,
  data: unknown,
): {
  entries: ConversationEntry[]
  subAgents?: SubAgentRecord[]
  modelId?: string
  reasoningEffort?: string
  speed?: Speed
  workLocation?: 'local' | 'worktree'
  worktreePath?: string
  environmentId?: string | null
  worktreeSetup?: WorktreeSessionSetup
} | null {
  if (!data) return null
  let rawEntries: unknown = data
  let rawSubAgents: unknown = undefined
  let modelId: string | undefined = undefined
  let reasoningEffort: string | undefined = undefined
  let speed: Speed | undefined = undefined
  let workLocation: 'local' | 'worktree' | undefined = undefined
  let worktreePath: string | undefined = undefined
  let environmentId: string | null | undefined = undefined
  let worktreeSetup: WorktreeSessionSetup | undefined = undefined

  if (typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>
    if ('entries' in record) {
      rawEntries = record.entries
    }
    if ('subAgents' in record && Array.isArray(record.subAgents)) {
      rawSubAgents = record.subAgents
    }
    if (typeof record.modelId === 'string' && record.modelId) {
      modelId = record.modelId
    }
    if (typeof record.reasoningEffort === 'string' && record.reasoningEffort) {
      reasoningEffort = record.reasoningEffort
    }
    if (VALID_SPEEDS.has(record.speed as Speed)) {
      speed = record.speed as Speed
    }
    if (record.workLocation === 'worktree' || record.workLocation === 'local') {
      workLocation = record.workLocation
    }
    if (typeof record.worktreePath === 'string') {
      worktreePath = record.worktreePath
    }
    if (record.environmentId !== undefined) {
      environmentId = record.environmentId as string | null
    }
    if (record.worktreeSetup && typeof record.worktreeSetup === 'object') {
      worktreeSetup = record.worktreeSetup as WorktreeSessionSetup
    }
  }
  if (Array.isArray(rawEntries)) {
    const sanitized = sanitizeConversationEntries({
      [sessionId]: rawEntries as ConversationEntry[],
    })
    const entries = sanitized[sessionId] ?? []
    const subAgents = Array.isArray(rawSubAgents)
      ? sanitizeSubAgents(rawSubAgents as SubAgentRecord[])
      : undefined
    return {
      entries,
      subAgents,
      modelId,
      reasoningEffort,
      speed,
      workLocation,
      worktreePath,
      environmentId,
      worktreeSetup,
    }
  }
  return null
}

export function resolveHydratedWorktreeSetup(
  sessionId: string,
  candidateSetup: WorktreeSessionSetup | undefined,
  sessionInfo: {
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    projectId?: string | null
    branch?: string
    environmentId?: string | null
  },
): WorktreeSessionSetup | null {
  const isWorktree = sessionInfo.workLocation === 'worktree'
  if (!isWorktree) return null

  const project = sessionInfo.projectId
    ? useProjectStore.getState().projects.find((p) => p.id === sessionInfo.projectId)
    : undefined
  const projectSourcePath = project ? getProjectPaths(project)[0] : undefined

  if (candidateSetup) {
    const sourceTreePath = candidateSetup.sourceTreePath || projectSourcePath
    const worktreePath = candidateSetup.worktreePath || sessionInfo.worktreePath
    return {
      ...candidateSetup,
      ...(sourceTreePath ? { sourceTreePath } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      branch: candidateSetup.branch ?? sessionInfo.branch,
      environmentId:
        candidateSetup.environmentId !== undefined
          ? candidateSetup.environmentId
          : sessionInfo.environmentId,
    }
  }

  return {
    sessionId,
    status: 'ready',
    stepWorkspace: 'done',
    stepCheckout: 'done',
    stepEnvironment: 'done',
    worktreePath: sessionInfo.worktreePath,
    sourceTreePath: projectSourcePath,
    branch: sessionInfo.branch,
    environmentId: sessionInfo.environmentId,
    logs: '',
    expandedDetails: false,
  }
}

function syncLoadedWorktreeSetup(
  sessionId: string,
  loaded: {
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    projectId?: string | null
    branch?: string
    environmentId?: string | null
    worktreeSetup?: WorktreeSessionSetup
  } | null,
): void {
  if (!sessionId || !loaded) return
  withSuppressedPersistence(() => {
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.id === sessionId)
    const effectiveLocation = loaded.workLocation ?? session?.workLocation
    if (effectiveLocation !== 'worktree') return

    const effectivePath = loaded.worktreePath ?? session?.worktreePath
    const effectiveEnvId =
      loaded.environmentId !== undefined
        ? loaded.environmentId
        : session?.environmentId
    const effectiveBranch = loaded.branch ?? session?.branch
    const effectiveProjectId = loaded.projectId ?? session?.projectId

    const resolvedSetup = resolveHydratedWorktreeSetup(
      sessionId,
      loaded.worktreeSetup ?? session?.worktreeSetup,
      {
        workLocation: effectiveLocation,
        worktreePath: effectivePath,
        projectId: effectiveProjectId,
        branch: effectiveBranch,
        environmentId: effectiveEnvId,
      },
    )

    if (resolvedSetup) {
      useWorktreeSetupStore.getState().importSetups({ [sessionId]: resolvedSetup })
      useSessionStore.getState().setSessionWorktreeSetup?.(sessionId, resolvedSetup, {
        touchUpdatedAt: false,
        updateProject: false,
      })
    }
  })
}

export async function loadSessionData(
  sessionId: string,
): Promise<{
  entriesRevision?: string
  entries: ConversationEntry[]
  subAgents?: SubAgentRecord[]
  modelId?: string
  reasoningEffort?: string
  speed?: Speed
  workLocation?: 'local' | 'worktree'
  worktreePath?: string
  environmentId?: string | null
  worktreeSetup?: WorktreeSessionSetup
} | null> {
  if (!sessionId) return null

  const bridge = getHostBridge()
  if (bridge?.SessionGet) {
    try {
      const baseline = sessionEntriesRevisions.get(sessionId)
      const epoch = sessionReadEpochs.get(sessionId)
      const data = await bridge.SessionGet(sessionId)
      if (data) {
        const revision = (data as { entriesRevision?: unknown }).entriesRevision
        const hasLiveEntries = useMessageStore.getState().entriesBySession[sessionId] !== undefined
        // A merge must not silently authorize old live entries against a newer remote history.
        const canReplaceBaseline = baseline === undefined || (!hasLiveEntries && !hasUnsavedSessionHistory(sessionId))
        if (typeof revision === 'string' &&
          sessionReadEpochs.get(sessionId) === epoch &&
          sessionEntriesRevisions.get(sessionId) === baseline && canReplaceBaseline) {
          sessionEntriesRevisions.set(sessionId, revision)
        }
        const parsed = parseSessionFilePayload(sessionId, data)
        if (parsed) {
          syncLoadedWorktreeSetup(sessionId, parsed)
        }
        return parsed && {
          ...parsed,
          ...(typeof revision === 'string' ? { entriesRevision: revision } : {}),
        }
      }
      return null
    } catch {
      return null
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(`cpa-session-${sessionId}`)
      if (raw) {
        const parsed = JSON.parse(raw)
        const res = parseSessionFilePayload(sessionId, parsed)
        if (res) {
          syncLoadedWorktreeSetup(sessionId, res)
        }
        return res
      }
    } catch {
      // Ignore
    }
  }

  return null
}

export async function loadSessionEntries(
  sessionId: string,
): Promise<ConversationEntry[] | null> {
  const data = await loadSessionData(sessionId)
  return data ? data.entries : null
}

export async function saveSessionData(
  sessionId: string,
  entries: ConversationEntry[],
  subAgents?: SubAgentRecord[],
): Promise<void> {
  if (!sessionId) return
  if (deletedRemoteSessionIds.has(sessionId)) return
  const epoch = sessionWriteEpochs.get(sessionId) ?? 0
  const previous = sessionWrites.get(sessionId)
  const write = (previous ?? Promise.resolve()).catch(() => {}).then(() => {
    if (deletedRemoteSessionIds.has(sessionId) || (sessionWriteEpochs.get(sessionId) ?? 0) !== epoch) return
    return writeSessionData(sessionId, entries, subAgents)
  })
  sessionWrites.set(sessionId, write)
  try {
    await write
  } finally {
    if (sessionWrites.get(sessionId) === write) sessionWrites.delete(sessionId)
  }
}

async function writeSessionData(
  sessionId: string,
  entries: ConversationEntry[],
  subAgents?: SubAgentRecord[],
): Promise<void> {
  const sanitized =
    sanitizeConversationEntries({ [sessionId]: entries })[sessionId] ?? []
  const sessionAgents =
    subAgents ??
    agentsForParent(useSubAgentStore.getState().agents, sessionId)
  const sanitizedSubAgents = sanitizeSubAgents(sessionAgents)
  const session = useSessionStore
    .getState()
    .sessions.find((s) => s.id === sessionId)
  const settings = useSettingsStore.getState().settings

  const allAgents = useSubAgentStore.getState().agents
  const subAgentRecord = allAgents.find(
    (agent) => agent.sessionId === sessionId || agent.id === sessionId,
  )

  let isSubagent = false
  let parentSessionId: string | undefined = undefined
  let projectId: string | null = session?.projectId ?? null

  if (subAgentRecord) {
    isSubagent = true
    parentSessionId = subAgentRecord.parentSessionId
    if (!projectId && parentSessionId) {
      const parentSession = useSessionStore
        .getState()
        .sessions.find((s) => s.id === parentSessionId)
      if (parentSession?.projectId) {
        projectId = parentSession.projectId
      }
    }
  }

  const worktreeSetup =
    useWorktreeSetupStore.getState().getSetup(sessionId) ??
    session?.worktreeSetup

  const retainedIds = new Set(sanitized.map((entry) => entry.id))
  const removals = new Map(Array.from(pendingEntryRemovals.get(sessionId) ?? [])
    .filter(([id]) => !retainedIds.has(id)))
  const payload: SessionFilePayload = {
    id: sessionId,
    version: CURRENT_VERSION,
    entries: sanitized,
    expectedEntriesRevision: sessionEntriesRevisions.get(sessionId),
    removedEntryIds: Array.from(removals.keys()),
    ...(session?.title ? { title: session.title } : {}),
    ...(session?.pinned !== undefined ? { pinned: session.pinned } : {}),
    unread: session?.unread ?? false,
    ...(session?.rightSidebar ? { rightSidebar: session.rightSidebar } : {}),
    ...(session?.firstPromptAt ? { firstPromptAt: session.firstPromptAt } : {}),
    ...(session?.workLocation ? { workLocation: session.workLocation } : {}),
    ...(session?.worktreePath ? { worktreePath: session.worktreePath } : {}),
    ...(session?.environmentId !== undefined ? { environmentId: session.environmentId } : {}),
    ...(worktreeSetup ? { worktreeSetup } : {}),
    ...(session?.pinnedSummaryVisible !== undefined ? { pinnedSummaryVisible: session.pinnedSummaryVisible } : {}),
    ...(sanitizedSubAgents.length > 0 ? { subAgents: sanitizedSubAgents } : {}),
    ...(projectId ? { projectId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(isSubagent ? { isSubagent: true } : {}),
    ...(session?.speed ?? settings?.speed
      ? { speed: session?.speed ?? settings.speed }
      : {}),
    ...(subAgentRecord?.reasoningEffort ?? session?.reasoningEffort ?? settings?.reasoningLevel
      ? { reasoningEffort: subAgentRecord?.reasoningEffort ?? session?.reasoningEffort ?? settings.reasoningLevel }
      : {}),
    ...(subAgentRecord?.modelId ?? session?.modelId ?? settings?.modelId
      ? { modelId: subAgentRecord?.modelId ?? session?.modelId ?? settings.modelId }
      : {}),
  }

  const bridge = getHostBridge()
  if (bridge?.SessionSet) {
    // Freeze conflicting writes until the user preserves a copy and explicitly recovers.
    const conflict = historyConflicts.get(sessionId)
    if (conflict) {
      conflict.payload = payload
      throw new Error('SESSION_HISTORY_CONFLICT: Preserve a local copy and reload to recover')
    }
    let revision: string
    try {
      revision = await bridge.SessionSet(sessionId, payload)
    } catch (error) {
      if (String(error).includes('SESSION_DELETED')) markRemoteSessionDeleted(sessionId)
      if (String(error).includes('SESSION_HISTORY_CONFLICT') && !deletedRemoteSessionIds.has(sessionId)) {
        const toastId = useUiStore.getState().pushToast(
          `History conflict in "${payload.title || sessionId}". Stop this session, then preserve a local copy and reload.`,
          { label: 'Preserve & reload', run: () => {
            void recoverSessionHistory(sessionId).catch((recoveryError) => {
              useUiStore.getState().pushToast(String(recoveryError))
            })
          } },
        )
        historyConflicts.set(sessionId, { payload, toastId })
      }
      throw error
    }
    if (deletedRemoteSessionIds.has(sessionId)) return
    sessionEntriesRevisions.set(sessionId, revision)
    sessionReadEpochs.set(sessionId, (sessionReadEpochs.get(sessionId) ?? 0) + 1)
    const removed = pendingEntryRemovals.get(sessionId)
    for (const [id, sequence] of removals) {
      if (removed?.get(id) === sequence) removed.delete(id)
    }
    return
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(`cpa-session-${sessionId}`, JSON.stringify(payload))
    } catch {
      // Ignore
    }
  }
}

/** Preserve the complete local history before adopting a fresh remote baseline. */
export function recoverSessionHistory(sessionId: string): Promise<void> {
    const pending = historyRecoveries.get(sessionId)
    if (pending) return pending
    if (!historyConflicts.has(sessionId)) return Promise.resolve()
    const recovery = (async () => {
        if (isSessionRunning(sessionId)) throw new Error('Stop the session before recovering history.')
        // Drain failed queued snapshots before choosing the copy; invalidate leftovers only on recovery commit.
        await sessionWrites.get(sessionId)?.catch(() => {})
        const conflict = historyConflicts.get(sessionId)
        const bridge = getHostBridge()
        if (!conflict) return
        if (!bridge?.SessionSet || !bridge.SessionGet) throw new Error('Session storage is unavailable; try recovery again later.')
        if (deletedRemoteSessionIds.has(sessionId)) throw new Error('Session was deleted.')
        const conflictPayload = conflict.payload
        const live = useMessageStore.getState().entriesBySession[sessionId]
        const localEntries = live ?? conflict.payload.entries
        const localRemovals = new Map(pendingEntryRemovals.get(sessionId))
        const copyId = createId()
        const title = `${conflict.payload.title || 'Chat'} (History conflict copy)`
        const copyEntries = localEntries.map((entry) => ({ ...entry, id: createId(), sessionId: copyId }))
        // Child sessions retain their original identities; never duplicate their global IDs.
        const copyRevision = await bridge.SessionSet(copyId, {
            ...conflict.payload, id: copyId, title, pinned: false, entries: copyEntries,
            expectedEntriesRevision: undefined, removedEntryIds: [],
            subAgents: [], parentSessionId: undefined, isSubagent: false,
        })
        withSuppressedPersistence(() => {
            useSessionStore.getState().upsertRemoteSession({
                id: copyId, title, pinned: false, projectId: conflict.payload.projectId ?? undefined,
                createdAt: Date.now(), updatedAt: Date.now(),
            })
            useMessageStore.getState().replaceSessionEntries(copyId, copyEntries)
        })
        sessionEntriesRevisions.set(copyId, copyRevision)
        const remote = await loadSessionData(sessionId)
        if (!remote?.entriesRevision) throw new Error('Remote history unavailable. Local conflict copy was preserved.')
        const removals = pendingEntryRemovals.get(sessionId)
        if (conflict.payload !== conflictPayload || deletedRemoteSessionIds.has(sessionId) || isSessionRunning(sessionId) ||
            useMessageStore.getState().entriesBySession[sessionId] !== live ||
            localRemovals.size !== (removals?.size ?? 0) ||
            [...localRemovals].some(([id, sequence]) => removals?.get(id) !== sequence)) {
            throw new Error('Session changed during recovery. Local copy preserved; stop editing and try again.')
        }
        // No local changes are discarded until their independent copy is durably committed.
        withSuppressedPersistence(() => {
            useMessageStore.getState().replaceSessionEntries(sessionId, remote.entries)
            useSubAgentStore.getState().setAgentsForParent(sessionId, remote.subAgents ?? [])
        })
        sessionEntriesRevisions.set(sessionId, remote.entriesRevision)
        pendingEntryRemovals.delete(sessionId)
        dirtySessionIds.delete(sessionId)
        historyConflicts.delete(sessionId)
        sessionWriteEpochs.set(sessionId, (sessionWriteEpochs.get(sessionId) ?? 0) + 1)
        invalidateSessionDiskCache(sessionId)
        loadedSessionIds.add(sessionId)
        staleSessionIds.delete(sessionId)
        useUiStore.getState().dismissToast(conflict.toastId)
        useUiStore.getState().pushToast(`Local history preserved in "${title}". Remote history reloaded.`)
    })()
    historyRecoveries.set(sessionId, recovery)
    void recovery.finally(() => {
        if (historyRecoveries.get(sessionId) === recovery) historyRecoveries.delete(sessionId)
    }).catch(() => {})
    return recovery
}

export async function saveSessionEntries(
  sessionId: string,
  entries: ConversationEntry[],
): Promise<void> {
  return saveSessionData(sessionId, entries)
}

let sessionDeletionHook: ((sessionId: string) => void) | null = null

export function setSessionDeletionHook(fn: ((sessionId: string) => void) | null): void {
  sessionDeletionHook = fn
}

export async function deleteSessionLocalCache(sessionId: string): Promise<void> {
  if (!sessionId) return
  markRemoteSessionDeleted(sessionId)
  sessionDeletionHook?.(sessionId)
  return withSuppressedPersistence(async () => {
    loadedSessionIds.delete(sessionId)
    staleSessionIds.delete(sessionId)

    const memoryChildAgents = agentsForParent(
      useSubAgentStore.getState().agents,
      sessionId,
    )
    for (const child of memoryChildAgents) {
      const childSessionId = child.sessionId || child.id
      if (childSessionId && childSessionId !== sessionId) {
        markRemoteSessionDeleted(childSessionId)
        sessionDeletionHook?.(childSessionId)
        loadedSessionIds.delete(childSessionId)
        staleSessionIds.delete(childSessionId)
        useMessageStore.getState().removeSessionMessages(childSessionId)
        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.removeItem(`cpa-session-${childSessionId}`)
          } catch {
            // Ignore
          }
        }
      }
    }

    useSubAgentStore.getState().removeAgentsForParent(sessionId)
    useMessageStore.getState().removeSessionMessages(sessionId)

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`cpa-session-${sessionId}`)
      } catch {
        // Ignore
      }
    }
  })
}

export async function deleteSessionEntries(sessionId: string): Promise<void> {
  if (!sessionId) return
  markRemoteSessionDeleted(sessionId)
  sessionDeletionHook?.(sessionId)
  const pendingWrite = sessionWrites.get(sessionId)
  if (pendingWrite) await pendingWrite.catch(() => {})
  loadedSessionIds.delete(sessionId)
  staleSessionIds.delete(sessionId)

  // 1. Read disk subagents if available to catch unloaded children
  const diskData = await loadSessionData(sessionId)
  const diskChildAgents = diskData?.subAgents ?? []

  // 2. Read in-memory child subagents
  const memoryChildAgents = agentsForParent(
    useSubAgentStore.getState().agents,
    sessionId,
  )

  // 3. Union all child session IDs
  const allChildSessionIds = new Set<string>()
  for (const child of diskChildAgents) {
    const childSessionId = child.sessionId || child.id
    if (childSessionId && childSessionId !== sessionId) {
      allChildSessionIds.add(childSessionId)
    }
  }
  for (const child of memoryChildAgents) {
    const childSessionId = child.sessionId || child.id
    if (childSessionId && childSessionId !== sessionId) {
      allChildSessionIds.add(childSessionId)
    }
  }

  // 4. Cascade delete all child sessions
  for (const childSessionId of allChildSessionIds) {
    markRemoteSessionDeleted(childSessionId)
    sessionDeletionHook?.(childSessionId)
    const pendingChildWrite = sessionWrites.get(childSessionId)
    if (pendingChildWrite) await pendingChildWrite.catch(() => {})
    loadedSessionIds.delete(childSessionId)
    staleSessionIds.delete(childSessionId)
    useMessageStore.getState().removeSessionMessages(childSessionId)
    const bridge = getHostBridge()
    if (bridge?.SessionDelete) {
      try {
        await bridge.SessionDelete(childSessionId)
      } catch {
        // Ignore
      }
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(`cpa-session-${childSessionId}`)
      } catch {
        // Ignore
      }
    }
  }

  // 5. Remove child subagents from useSubAgentStore & message store
  useSubAgentStore.getState().removeAgentsForParent(sessionId)
  useMessageStore.getState().removeSessionMessages(sessionId)

  // 6. Delete the parent session file itself
  const bridge = getHostBridge()
  if (bridge?.SessionDelete) {
    try {
      await bridge.SessionDelete(sessionId)
    } catch {
      // Ignore
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(`cpa-session-${sessionId}`)
    } catch {
      // Ignore
    }
  }
}

function isSessionRunning(sessionId: string): boolean {
  const run = useSessionRunStore.getState().activeRuns[sessionId]
  return Boolean(run && run.status !== 'idle')
}

function hydrateSessionFromDisk(
  sessionId: string,
  replaceIdle: boolean,
): Promise<ConversationEntry[]> {
  if (!sessionId) return Promise.resolve([])
  const epoch = sessionReadEpochs.get(sessionId) ?? 0
  const pending = sessionHydrations.get(sessionId)
  if (pending?.epoch === epoch) return pending.promise
  const initialEntries = useMessageStore.getState().entriesBySession[sessionId]
  const initiallyUnsaved = hasUnsavedSessionHistory(sessionId)
  const promise = (async () => {
    const loaded = await loadSessionData(sessionId)
    const live = useMessageStore.getState().getEntries(sessionId)
    if (deletedRemoteSessionIds.has(sessionId) || (sessionReadEpochs.get(sessionId) ?? 0) !== epoch) return live
    if (!loaded) return live

    const changed = useMessageStore.getState().entriesBySession[sessionId] !== initialEntries
    const mergeLive = !replaceIdle || changed || isSessionRunning(sessionId) ||
      initiallyUnsaved || hasUnsavedSessionHistory(sessionId)
    const removed = pendingEntryRemovals.get(sessionId)
    const diskEntries = loaded.entries.filter((entry) => !removed?.has(entry.id))
    const liveIds = new Set(live.map((entry) => entry.id))
    const entries = mergeLive && live.length > 0
      ? [...diskEntries.filter((entry) => !liveIds.has(entry.id)), ...live]
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      : diskEntries

    // Suppress only our synchronous hydration, not live events arriving during I/O.
    withSuppressedPersistence(() => {
      useMessageStore.getState().replaceSessionEntries(sessionId, entries)
      if (mergeLive) {
        if (loaded.subAgents) useSubAgentStore.getState().mergeAgentsForParent(sessionId, loaded.subAgents)
      } else {
        useSubAgentStore.getState().setAgentsForParent(sessionId, loaded.subAgents ?? [])
      }
    })
    if (!mergeLive && loaded.entriesRevision) {
      sessionEntriesRevisions.set(sessionId, loaded.entriesRevision)
    }
    loadedSessionIds.add(sessionId)
    staleSessionIds.delete(sessionId)
    return entries
  })()
  sessionHydrations.set(sessionId, { epoch, promise })
  void promise.finally(() => {
    if (sessionHydrations.get(sessionId)?.promise === promise) sessionHydrations.delete(sessionId)
  }).catch(() => {})
  return promise
}

export async function reloadSessionFromDisk(
  sessionId: string,
): Promise<ConversationEntry[]> {
  return hydrateSessionFromDisk(sessionId, true)
}

export async function hydrateEmptySessionFromDisk(
  sessionId: string,
): Promise<ConversationEntry[]> {
  return hydrateSessionFromDisk(sessionId, false)
}

export async function ensureSessionLoaded(
  sessionId: string,
): Promise<ConversationEntry[]> {
  if (!sessionId) return []
  if (!staleSessionIds.has(sessionId) && loadedSessionIds.has(sessionId)) {
    const inMem = useMessageStore.getState().getEntries(sessionId)
    if (inMem.length > 0) return inMem
  }
  return hydrateSessionFromDisk(sessionId, staleSessionIds.has(sessionId) && !isSessionRunning(sessionId))
}

function loadFromLocalStorage(): PersistedAppState | null {
  try {
    if (typeof localStorage === 'undefined') return null

    const rawSettings = localStorage.getItem(LOCAL_STORAGE_SETTINGS_KEY)
    const rawProjects = localStorage.getItem(LOCAL_STORAGE_PROJECTS_KEY)
    const rawCachedModels = localStorage.getItem(LOCAL_STORAGE_CACHED_MODELS_KEY)
    const rawShortcuts = localStorage.getItem(LOCAL_STORAGE_SHORTCUTS_KEY)
    const rawUi = localStorage.getItem(LOCAL_STORAGE_UI_KEY)

    if (rawSettings) {
      const parsed = JSON.parse(rawSettings)
      if (isPersistedAppState(parsed)) {
        const state: PersistedAppState = { ...parsed }
        if (rawProjects) {
          try {
            const parsedProjects = JSON.parse(rawProjects)
            if (Array.isArray(parsedProjects)) {
              state.projects = parsedProjects
            }
          } catch {
            // Ignore
          }
        }
        if (rawCachedModels) {
          try {
            const parsedModels = JSON.parse(rawCachedModels)
            if (Array.isArray(parsedModels)) {
              state.cachedModels = parsedModels
            }
          } catch {
            // Ignore
          }
        }
        if (rawShortcuts) {
          try {
            const parsedShortcuts = JSON.parse(rawShortcuts)
            const overrides = extractShortcutsOverrides(parsedShortcuts)
            state.settings.shortcuts = overrides
          } catch {
            // Ignore
          }
        }
        if (rawUi) {
          try {
            const parsedUi = JSON.parse(rawUi)
            if (parsedUi && typeof parsedUi === 'object' && !Array.isArray(parsedUi)) {
              const uiSettingsPatch: Record<string, unknown> = {}
              for (const key of UI_SETTING_KEYS) {
                if (key in parsedUi) {
                  uiSettingsPatch[key] = parsedUi[key]
                }
              }
              state.settings = { ...state.settings, ...uiSettingsPatch }
              if (typeof parsedUi.collapsedGroups === 'object' && parsedUi.collapsedGroups !== null) {
                state.collapsedGroups = parsedUi.collapsedGroups
              }
              if (typeof parsedUi.sidebarCollapsed === 'boolean') {
                state.sidebarCollapsed = parsedUi.sidebarCollapsed
              }
              if (typeof parsedUi.sidebarWidth === 'number') {
                state.sidebarWidth = parsedUi.sidebarWidth
              }
              if (typeof parsedUi.rightSidebarCollapsed === 'boolean') {
                state.rightSidebarCollapsed = parsedUi.rightSidebarCollapsed
              }
              if (typeof parsedUi.rightSidebarMaximized === 'boolean') {
                state.rightSidebarMaximized = parsedUi.rightSidebarMaximized
              }
              if (typeof parsedUi.rightSidebarWidth === 'number' || parsedUi.rightSidebarWidth === null) {
                state.rightSidebarWidth = parsedUi.rightSidebarWidth
              }
              if (typeof parsedUi.pinnedSummaryVisible === 'boolean') {
                state.pinnedSummaryVisible = parsedUi.pinnedSummaryVisible
              }
              if (typeof parsedUi.bottomPanelVisible === 'boolean') {
                state.bottomPanelVisible = parsedUi.bottomPanelVisible
              }
              if (typeof parsedUi.bottomPanelHeight === 'number') {
                state.bottomPanelHeight = parsedUi.bottomPanelHeight
              }
            }
          } catch {
            // Ignore
          }
        }
        return state
      }
    }

    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isPersistedAppState(parsed) ? parsed : null
  } catch {
    return null
  }
}

function saveToLocalStorage(state: PersistedAppState): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage unavailable')
  }
  // Sanitize already made the payload JSON-safe; still surface quota failures.
  try {
    localStorage.setItem(LOCAL_STORAGE_PROJECTS_KEY, JSON.stringify(state.projects ?? []))
    if (state.cachedModels && Array.isArray(state.cachedModels)) {
      localStorage.setItem(LOCAL_STORAGE_CACHED_MODELS_KEY, JSON.stringify(state.cachedModels))
    }
    const shortcutsConfig = generateSavedShortcutsConfig(state.settings?.shortcuts)
    localStorage.setItem(LOCAL_STORAGE_SHORTCUTS_KEY, JSON.stringify(shortcutsConfig))

    const uiPayload: Record<string, unknown> = {
      collapsedGroups: state.collapsedGroups,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      rightSidebarCollapsed: state.rightSidebarCollapsed,
      rightSidebarMaximized: state.rightSidebarMaximized,
      rightSidebarWidth: state.rightSidebarWidth,
      pinnedSummaryVisible: state.pinnedSummaryVisible,
      bottomPanelVisible: state.bottomPanelVisible,
      bottomPanelHeight: state.bottomPanelHeight,
    }
    if (state.settings) {
      for (const key of UI_SETTING_KEYS) {
        if (key in state.settings) {
          uiPayload[key] = (state.settings as unknown as Record<string, unknown>)[key]
        }
      }
    }
    localStorage.setItem(LOCAL_STORAGE_UI_KEY, JSON.stringify(uiPayload))

    const strippedSettings = { ...(state.settings ?? {}) }
    for (const key of UI_SETTING_KEYS) {
      delete (strippedSettings as Record<string, unknown>)[key]
    }
    delete (strippedSettings as Record<string, unknown>).shortcuts

    const stateToSave: PersistedAppState = {
      ...state,
      settings: strippedSettings as AppSettings,
      sessions: [],
      messagesBySession: {},
      projects: [],
    }
    delete (stateToSave as unknown as Record<string, unknown>).subAgents
    delete (stateToSave as unknown as Record<string, unknown>).cachedModels
    for (const key of UI_LAYOUT_KEYS) {
      delete (stateToSave as unknown as Record<string, unknown>)[key]
    }
    localStorage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(stateToSave))
  } catch {
    // Ignore separate storage error and fall back to full state key
  }
  const fullStateToSave: PersistedAppState = {
    ...state,
    sessions: [],
    messagesBySession: {},
  }
  delete (fullStateToSave as unknown as Record<string, unknown>).subAgents
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(fullStateToSave))
}

export function cleanLegacyLocalStorageSessions(): void {
  try {
    if (typeof localStorage === 'undefined') return
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('cpa-session-') || key === 'cpa-app-state' || key === 'cpa-settings')) {
        keysToRemove.push(key)
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key)
    }
  } catch {
    // Ignore
  }
}

export async function loadPersistedState(): Promise<PersistedAppState | null> {
  const store = await getNativeStore()
  if (store) {
    cleanLegacyLocalStorageSessions()
    try {
      const data = await store.Get(STORE_KEY)
      let projectsData: unknown = undefined
      let cachedModelsData: unknown = undefined
      let shortcutsData: unknown = undefined
      let uiData: unknown = undefined
      try {
        projectsData = await store.Get(PROJECTS_KEY)
      } catch {
        // Ignore
      }
      try {
        cachedModelsData = await store.Get(CACHED_MODELS_KEY)
      } catch {
        // Ignore
      }
      try {
        shortcutsData = await store.Get(SHORTCUTS_KEY)
      } catch {
        // Ignore
      }
      try {
        uiData = await store.Get(UI_KEY)
      } catch {
        // Ignore
      }

      let state: PersistedAppState
      if (isPersistedAppState(data)) {
        state = {
          version: (data as PersistedAppState).version ?? CURRENT_VERSION,
          settings:
            (data as PersistedAppState).settings && typeof (data as PersistedAppState).settings === 'object'
              ? { ...(data as PersistedAppState).settings }
              : { ...DEFAULT_SETTINGS },
          projects:
            (data as PersistedAppState).projects && Array.isArray((data as PersistedAppState).projects)
              ? (data as PersistedAppState).projects
              : [],
          sessions:
            (data as PersistedAppState).sessions && Array.isArray((data as PersistedAppState).sessions)
              ? (data as PersistedAppState).sessions
              : [],
          messagesBySession:
            (data as PersistedAppState).messagesBySession &&
            typeof (data as PersistedAppState).messagesBySession === 'object'
              ? (data as PersistedAppState).messagesBySession
              : {},
          currentSessionId: (data as PersistedAppState).currentSessionId ?? null,
          collapsedGroups: (data as PersistedAppState).collapsedGroups ?? {},
          ...((data as PersistedAppState).cachedModels ? { cachedModels: (data as PersistedAppState).cachedModels } : {}),
        }

        if (Array.isArray(projectsData)) {
          state.projects = projectsData as Project[]
        }
        if (Array.isArray(cachedModelsData)) {
          state.cachedModels = cachedModelsData as import('@/features/models/types').ModelCatalogEntry[]
        }
        if (shortcutsData) {
          const overrides = extractShortcutsOverrides(shortcutsData)
          state.settings = {
            ...state.settings,
            shortcuts: overrides,
          }
        }
      } else {
        const rawSettings =
          data &&
          typeof data === 'object' &&
          'settings' in data &&
          typeof (data as Record<string, unknown>).settings === 'object'
            ? ((data as Record<string, unknown>).settings as AppSettings)
            : DEFAULT_SETTINGS
        const fallbackProjects = Array.isArray(projectsData)
          ? (projectsData as Project[])
          : []
        const fallbackModels = Array.isArray(cachedModelsData)
          ? (cachedModelsData as import('@/features/models/types').ModelCatalogEntry[])
          : undefined
        state = {
          version: CURRENT_VERSION,
          settings: { ...rawSettings },
          projects: fallbackProjects,
          sessions: [],
          messagesBySession: {},
          currentSessionId: null,
          collapsedGroups: {},
          ...(fallbackModels ? { cachedModels: fallbackModels } : {}),
        }
      }

      if (uiData && typeof uiData === 'object' && !Array.isArray(uiData)) {
        const uiObj = uiData as Record<string, unknown>
        const uiSettingsPatch: Record<string, unknown> = {}
        for (const key of UI_SETTING_KEYS) {
          if (key in uiObj) {
            uiSettingsPatch[key] = uiObj[key]
          }
        }
        state.settings = {
          ...state.settings,
          ...uiSettingsPatch,
        }
        if (typeof uiObj.collapsedGroups === 'object' && uiObj.collapsedGroups !== null) {
          state.collapsedGroups = uiObj.collapsedGroups as Record<string, boolean>
        }
        if (typeof uiObj.sidebarCollapsed === 'boolean') {
          state.sidebarCollapsed = uiObj.sidebarCollapsed
        }
        if (typeof uiObj.sidebarWidth === 'number') {
          state.sidebarWidth = uiObj.sidebarWidth
        }
        if (typeof uiObj.rightSidebarCollapsed === 'boolean') {
          state.rightSidebarCollapsed = uiObj.rightSidebarCollapsed
        }
        if (typeof uiObj.rightSidebarMaximized === 'boolean') {
          state.rightSidebarMaximized = uiObj.rightSidebarMaximized
        }
        if (typeof uiObj.rightSidebarWidth === 'number' || uiObj.rightSidebarWidth === null) {
          state.rightSidebarWidth = uiObj.rightSidebarWidth as number | null
        }
        if (typeof uiObj.pinnedSummaryVisible === 'boolean') {
          state.pinnedSummaryVisible = uiObj.pinnedSummaryVisible
        }
        if (typeof uiObj.bottomPanelVisible === 'boolean') {
          state.bottomPanelVisible = uiObj.bottomPanelVisible
        }
        if (typeof uiObj.bottomPanelHeight === 'number') {
          state.bottomPanelHeight = uiObj.bottomPanelHeight
        }
      }

      // Query authoritative sessions list from SQLite
      const bridge = getHostBridge()
      if (typeof bridge?.SessionListSessions === 'function') {
        try {
          const sqliteSessions =
            await bridge.SessionListSessions()
          state.sessions = sqliteSessions ?? []
        } catch {
          state.sessions = []
        }
      } else {
        state.sessions = []
      }

      if (!state.currentSessionId || !state.sessions.some((s) => s.id === state.currentSessionId)) {
        state.currentSessionId = state.sessions[0]?.id ?? null
      }

      const messagesBySession: Record<string, ConversationEntry[]> = {}

      // Preload current active session if available
      if (state.currentSessionId) {
        const loadedData = await loadSessionData(state.currentSessionId)
        if (loadedData) {
          if (loadedData.entries && loadedData.entries.length > 0) {
            messagesBySession[state.currentSessionId] = loadedData.entries
          }
          if (loadedData.subAgents && loadedData.subAgents.length > 0) {
            useSubAgentStore
              .getState()
              .setAgentsForParent(state.currentSessionId, loadedData.subAgents)
          }
          loadedSessionIds.add(state.currentSessionId)
        }
      }

      state.messagesBySession = messagesBySession
      return state
    } catch {
      // Return empty default state for desktop mode if native store reading throws
      return {
        version: CURRENT_VERSION,
        settings: { ...DEFAULT_SETTINGS },
        projects: [],
        sessions: [],
        messagesBySession: {},
        currentSessionId: null,
        collapsedGroups: {},
      }
    }
  }

  const localState = loadFromLocalStorage()
  if (localState) {
    if (localState.currentSessionId) {
      const loadedData = await loadSessionData(localState.currentSessionId)
      if (loadedData) {
        if (loadedData.entries && loadedData.entries.length > 0) {
          localState.messagesBySession[localState.currentSessionId] = loadedData.entries
        }
        if (loadedData.subAgents && loadedData.subAgents.length > 0) {
          useSubAgentStore
            .getState()
            .setAgentsForParent(localState.currentSessionId, loadedData.subAgents)
        }
        loadedSessionIds.add(localState.currentSessionId)
      }
    }
  }
  return localState
}

export async function savePersistedState(
  state: PersistedAppState,
  options?: { sessionIds?: ReadonlySet<string> },
): Promise<void> {
  if (customWrite) {
    await customWrite(state)
    return
  }

  const isRemoteActive = (id: string) => {
    const run = useSessionRunStore.getState().activeRuns[id]
    return Boolean(run && run.status !== 'idle' && isBrowserEnvironment())
  }

  const errors: unknown[] = []
  let succeeded = false

  const store = await getNativeStore()
  if (store) {
    try {
      const requestedSessionIds = options?.sessionIds
      const activeMemorySessionIds = new Set(
        Object.keys(state.messagesBySession).filter(
          (sessionId) =>
            requestedSessionIds === undefined ||
            requestedSessionIds.has(sessionId),
        ),
      )

      const historyErrors: unknown[] = []
      const captureHistoryError = (error: unknown) => { historyErrors.push(error) }
      // 1. Save only changed in-memory session files when a scope is provided.
      await Promise.all(
        Array.from(activeMemorySessionIds)
          .filter((sessionId) => !isRemoteActive(sessionId))
          .map((sessionId) =>
            saveSessionData(
              sessionId,
              state.messagesBySession[sessionId] ?? [],
            ).catch(captureHistoryError),
          ),
      )

      // 2. For unvisited parent sessions that have subagents in store, RMW their files
      // to ensure subagents are migrated to disk before app-data subagents are stripped
      const allAgents = useSubAgentStore.getState().agents
      const unvisitedParentIds = new Set(
        allAgents
          .map((a) => a.parentSessionId)
          .filter(
            (id) =>
              id &&
              !activeMemorySessionIds.has(id) &&
              (requestedSessionIds === undefined ||
                requestedSessionIds.has(id)),
          ),
      )
      await Promise.all(
        Array.from(unvisitedParentIds)
          .filter((parentId) => !isRemoteActive(parentId))
          .map(async (parentId) => {
            if (loadedSessionIds.has(parentId)) return
            const diskData = await loadSessionData(parentId)
            const liveEntries = useMessageStore.getState().entriesBySession[parentId]
            const entries =
              liveEntries && liveEntries.length > 0
                ? liveEntries
                : diskData?.entries ?? []
            const diskAgents = diskData?.subAgents ?? []
            const storeAgents = agentsForParent(
              useSubAgentStore.getState().agents,
              parentId,
            )
            const mergedAgentsMap = new Map<string, SubAgentRecord>()
            for (const a of diskAgents) mergedAgentsMap.set(a.id, a)
            for (const a of storeAgents) mergedAgentsMap.set(a.id, a)
            await saveSessionData(parentId, entries, Array.from(mergedAgentsMap.values())).catch(captureHistoryError)
          }),
      )

      // 3. Save projects separately to projects.json
      try {
        await store.Set(PROJECTS_KEY, state.projects ?? [])
      } catch {
        // Ignore
      }

      // 4. Save cached models separately to cached_models.json
      try {
        if (state.cachedModels && Array.isArray(state.cachedModels)) {
          await store.Set(CACHED_MODELS_KEY, state.cachedModels)
        }
      } catch {
        // Ignore
      }

      // 5. Save shortcuts separately to shortcuts.json
      try {
        const shortcutsConfig = generateSavedShortcutsConfig(state.settings?.shortcuts)
        await store.Set(SHORTCUTS_KEY, shortcutsConfig)
      } catch {
        // Ignore
      }

      // 6. Save UI settings and layout state separately to ui.json
      try {
        const uiPayload: Record<string, unknown> = {
          collapsedGroups: state.collapsedGroups,
          sidebarCollapsed: state.sidebarCollapsed,
          sidebarWidth: state.sidebarWidth,
          rightSidebarCollapsed: state.rightSidebarCollapsed,
          rightSidebarMaximized: state.rightSidebarMaximized,
          rightSidebarWidth: state.rightSidebarWidth,
          pinnedSummaryVisible: state.pinnedSummaryVisible,
          bottomPanelVisible: state.bottomPanelVisible,
          bottomPanelHeight: state.bottomPanelHeight,
        }
        if (state.settings) {
          for (const key of UI_SETTING_KEYS) {
            if (key in state.settings) {
              uiPayload[key] = (state.settings as unknown as Record<string, unknown>)[key]
            }
          }
        }
        await store.Set(UI_KEY, uiPayload)
      } catch {
        // Ignore
      }

      // 7. Save global app-state with sessions, subAgents, projects, cachedModels, and UI settings stripped
      const strippedSettings = { ...(state.settings ?? {}) }
      for (const key of UI_SETTING_KEYS) {
        delete (strippedSettings as Record<string, unknown>)[key]
      }
      delete (strippedSettings as Record<string, unknown>).shortcuts

      const stateToSave: PersistedAppState = {
        ...state,
        settings: strippedSettings as AppSettings,
        sessions: [],
        messagesBySession: {},
      }
      delete (stateToSave as unknown as Record<string, unknown>).subAgents
      delete (stateToSave as unknown as Record<string, unknown>).cachedModels
      delete (stateToSave as unknown as Record<string, unknown>).projects
      for (const key of UI_LAYOUT_KEYS) {
        delete (stateToSave as unknown as Record<string, unknown>)[key]
      }
      await store.Set(STORE_KEY, stateToSave)
      if (historyErrors.length) throw historyErrors[0]

      succeeded = true
      return
    } catch (error) {
      if (typeof getHostBridge()?.SessionSet === 'function') throw error
      errors.push(error)
    }
  }

  // Fall back to localStorage when native store is unavailable or failed; one success is enough.
  try {
    const activeMemorySessionIds = new Set(Object.keys(state.messagesBySession))
    for (const sessionId of activeMemorySessionIds) {
      if (isRemoteActive(sessionId)) continue
      const entries = state.messagesBySession[sessionId] ?? []
      if (entries.length > 0) {
        await saveSessionData(sessionId, entries)
      }
    }
    const allAgents = useSubAgentStore.getState().agents
    const unvisitedParentIds = new Set(
      allAgents
        .map((a) => a.parentSessionId)
        .filter((id) => id && !activeMemorySessionIds.has(id)),
    )
    for (const parentId of unvisitedParentIds) {
      if (isRemoteActive(parentId)) continue
      if (loadedSessionIds.has(parentId)) continue
      const diskData = await loadSessionData(parentId)
      const liveEntries = useMessageStore.getState().entriesBySession[parentId]
      const entries =
        liveEntries && liveEntries.length > 0
          ? liveEntries
          : diskData?.entries ?? []
      const diskAgents = diskData?.subAgents ?? []
      const storeAgents = agentsForParent(
        useSubAgentStore.getState().agents,
        parentId,
      )
      const mergedAgentsMap = new Map<string, SubAgentRecord>()
      for (const a of diskAgents) mergedAgentsMap.set(a.id, a)
      for (const a of storeAgents) mergedAgentsMap.set(a.id, a)
      await saveSessionData(parentId, entries, Array.from(mergedAgentsMap.values()))
    }
    saveToLocalStorage(state)
    succeeded = true
  } catch (error) {
    errors.push(error)
  }

  if (!succeeded) {
    const first = errors[0]
    throw first instanceof Error
      ? first
      : new Error('persist write failed on all backends')
  }
}

function markDirty(): void {
  dirtyGeneration += 1
}

function notifyWriteWaiters(error: unknown | null): void {
  const waiters = writeWaiters
  writeWaiters = []
  for (const waiter of waiters) {
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}

async function runPersistWrite(): Promise<void> {
  if (disposed) {
    notifyWriteWaiters(null)
    return
  }
  if (writeInFlight) {
    writeQueued = true
    return
  }
  writeInFlight = true
  writeQueued = false
  const generationAtStart = dirtyGeneration
  if (attemptGeneration !== generationAtStart) {
    attemptGeneration = generationAtStart
    writeAttempt = 0
  }
  writeAttempt += 1
  const attempt = writeAttempt
  let writeError: unknown = null
  let scheduledRetry = false
  const sessionIdsAtStart = new Set(dirtySessionIds)
  for (const sessionId of sessionIdsAtStart) {
    dirtySessionIds.delete(sessionId)
    persistingSessionIds.add(sessionId)
  }
  try {
    // Always snapshot at write time so retries use the latest state.
    const snapshot = serializeAppState()
    await savePersistedState(snapshot, {
      sessionIds: sessionIdsAtStart,
    })
    lastWriteError = null
    writeAttempt = 0
    clearRetryTimer()
  } catch (error) {
    writeError = error
    for (const sessionId of sessionIdsAtStart) {
      if (!deletedRemoteSessionIds.has(sessionId)) dirtySessionIds.add(sessionId)
    }
    lastWriteError =
      error instanceof Error ? error.message : 'persist write failed'
    try {
      onWriteError?.(error, attempt)
    } catch {
      // Diagnostic hooks must never break persistence.
    }
    // Bounded retry with injectable delays; never a permanent timer loop.
    if (attempt < maxRetryAttempts && !disposed && !String(error).includes('SESSION_HISTORY_CONFLICT')) {
      clearRetryTimer()
      const delay = delayForRetryAttempt(attempt)
      const epoch = retryEpoch + 1
      retryEpoch = epoch
      retryTimer = timers.setTimeout(() => {
        // Stale handle after clear/generation change: no-op.
        if (epoch !== retryEpoch) return
        retryTimer = null
        void runPersistWrite()
      }, delay)
      scheduledRetry = true
    } else {
      clearRetryTimer()
    }
  } finally {
    for (const sessionId of sessionIdsAtStart) persistingSessionIds.delete(sessionId)
    writeInFlight = false
    // Generation loop: state changed during the write → rewrite immediately.
    if (!disposed && dirtyGeneration !== generationAtStart) {
      // Fresh generation: drop stale retry so new cycle owns the only timer.
      clearRetryTimer()
      writeQueued = false
      void runPersistWrite()
      return
    }
    if (writeQueued && !disposed) {
      clearRetryTimer()
      writeQueued = false
      void runPersistWrite()
      return
    }
    if (!writeInFlight && !writeQueued && !scheduledRetry && retryTimer === null) {
      notifyWriteWaiters(writeError)
    }
  }
}

function waitForIdleWrite(): Promise<void> {
  if (!writeInFlight && persistTimer === null && retryTimer === null) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    writeWaiters.push({ resolve, reject })
  })
}

export function schedulePersist(immediate = false): void {
  if (disposed || reloadDepth > 0) return
  markDirty()
  // Generation change owns at most one debounce + one retry handle.
  clearAllPersistTimers()
  const epoch = debounceEpoch + 1
  debounceEpoch = epoch
  const run = () => {
    if (epoch !== debounceEpoch) return
    persistTimer = null
    void runPersistWrite()
  }
  if (immediate) {
    run()
    return
  }
  persistTimer = timers.setTimeout(run, debounceMs)
}

/**
 * Flush pending debounce and wait until the latest durable write settles.
 * Rejects when retries are exhausted for the flushed generation.
 */
export async function flushPendingPersistence(): Promise<void> {
  clearAllPersistTimers()
  if (disposed) return
  markDirty()
  void runPersistWrite()
  await waitForIdleWrite()
}

/**
 * Flush latest dirty/pending state, then unsubscribe and clear timers.
 * Rejects after retry exhaustion; teardown still completes first.
 */
export async function disposePersistence(): Promise<void> {
  let disposeError: unknown = null
  if (!disposed) {
    const hadPending =
      persistTimer !== null ||
      writeInFlight ||
      writeQueued ||
      retryTimer !== null
    // Drop stale debounce/retry handles; dispose owns a fresh final write cycle.
    clearAllPersistTimers()
    if (hadPending) {
      try {
        markDirty()
        void runPersistWrite()
        await waitForIdleWrite()
      } catch (error) {
        disposeError = error
      }
    }
  }
  disposed = true
  clearAllPersistTimers()
  for (const unsub of unsubscribers) {
    try {
      unsub()
    } catch {
      // ignore
    }
  }
  unsubscribers = []
  bound = false
  customWrite = null
  onWriteError = null
  writeWaiters = []
  if (disposeError) {
    throw disposeError instanceof Error
      ? disposeError
      : new Error(String(disposeError))
  }
}

/**
 * Deterministic, cycle-safe compare for urgency detection.
 * Path-scoped ancestors preserve shared refs; true cycles use a placeholder.
 * Never throws — subscriber must remain exception-free.
 */
function stableEntriesEqual(a: unknown, b: unknown): boolean {
  try {
    return stableCompareSerialize(a) === stableCompareSerialize(b)
  } catch {
    return false
  }
}

function stableCompareSerialize(
  value: unknown,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const valueType = typeof value
  if (valueType === 'string') return JSON.stringify(value)
  if (valueType === 'boolean') return value ? 'true' : 'false'
  if (valueType === 'number') {
    return Number.isFinite(value as number) ? String(value) : 'null'
  }
  if (valueType === 'bigint') {
    return 'bigint:' + (value as bigint).toString()
  }
  if (valueType === 'function' || valueType === 'symbol') {
    return '"[NonJSON]"'
  }
  if (valueType !== 'object') return String(value)
  if (depth > 32) return '"[MaxDepth]"'
  if (ancestors.has(value as object)) return '"[Circular]"'
  ancestors.add(value as object)
  try {
    if (Array.isArray(value)) {
      return (
        '[' +
        value
          .map((item) => stableCompareSerialize(item, ancestors, depth + 1))
          .join(',') +
        ']'
      )
    }
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return (
      '{' +
      keys
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            stableCompareSerialize(record[key], ancestors, depth + 1),
        )
        .join(',') +
      '}'
    )
  } finally {
    ancestors.delete(value as object)
  }
}

/**
 * Detect whether entry changes should flush immediately (terminal / tool /
 * compaction / user) or can wait for streaming debounce.
 */
export function detectEntriesPersistUrgency(
  next: Record<string, ConversationEntry[]>,
  prev: Record<string, ConversationEntry[]>,
): PersistUrgency {
  const sessionIds = new Set<string>()
  for (const key of Reflect.ownKeys(next ?? {})) {
    if (typeof key === 'string') sessionIds.add(key)
  }
  for (const key of Reflect.ownKeys(prev ?? {})) {
    if (typeof key === 'string') sessionIds.add(key)
  }
  let sawDebounce = false

  for (const sessionId of sessionIds) {
    const nextList = Object.prototype.hasOwnProperty.call(next ?? {}, sessionId)
      ? next[sessionId] ?? []
      : []
    const prevList = Object.prototype.hasOwnProperty.call(prev ?? {}, sessionId)
      ? prev[sessionId] ?? []
      : []
    if (nextList === prevList) continue

    if (nextList.length !== prevList.length) {
      // New entry appended or removed.
      for (let i = 0; i < nextList.length; i += 1) {
        const entry = nextList[i]
        const indexedPrevious = prevList[i]
        const prevEntry =
          indexedPrevious?.id === entry.id
            ? indexedPrevious
            : prevList.find((item) => item.id === entry.id)
        if (!prevEntry) {
          if (
            entry.kind === 'user' ||
            entry.kind === 'toolResult' ||
            entry.kind === 'compaction'
          ) {
            return 'immediate'
          }
          if (entry.kind === 'assistant') {
            if (entry.status !== 'streaming') return 'immediate'
            sawDebounce = true
          }
        }
      }
      // Removals still need to persist; treat as immediate for safety.
      if (nextList.length < prevList.length) return 'immediate'
      continue
    }

    for (let i = 0; i < nextList.length; i += 1) {
      const entry = nextList[i]
      const indexedPrevious = prevList[i]
      const prevEntry =
        indexedPrevious?.id === entry.id
          ? indexedPrevious
          : prevList.find((item) => item.id === entry.id)
      if (!prevEntry || prevEntry === entry) continue

      if (
        entry.kind === 'assistant' &&
        prevEntry.kind === 'assistant' &&
        entry.status === 'streaming' &&
        prevEntry.status === 'streaming'
      ) {
        sawDebounce = true
        continue
      }
      if (stableEntriesEqual(entry, prevEntry)) continue

      if (entry.kind === 'user') return 'immediate'
      if (entry.kind === 'toolResult' || entry.kind === 'compaction') {
        return 'immediate'
      }
      if (entry.kind === 'assistant') {
        const wasStreaming =
          prevEntry.kind === 'assistant' && prevEntry.status === 'streaming'
        const isStreaming = entry.status === 'streaming'
        const becameTerminal =
          TERMINAL_STATUSES.has(entry.status) &&
          (prevEntry.kind !== 'assistant' ||
            prevEntry.status !== entry.status ||
            wasStreaming)
        if (becameTerminal || (!isStreaming && entry.status !== 'streaming')) {
          return 'immediate'
        }
        if (isStreaming) {
          sawDebounce = true
        }
      }
    }
  }

  return sawDebounce ? 'debounce' : 'debounce'
}

export function bindPersistence(options?: BindPersistenceOptions): void {
  if (bound) return
  bound = true
  disposed = false
  debounceMs = options?.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  retryMs = options?.retryMs ?? DEFAULT_RETRY_MS
  maxRetryAttempts = options?.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS
  retryDelaysMs = options?.retryDelaysMs ? [...options.retryDelaysMs] : []
  onWriteError = options?.onWriteError ?? null
  if (options?.timers) timers = options.timers
  customWrite = options?.write ?? null

  unsubscribers.push(
    useSettingsStore.subscribe(() => {
      if (reloadDepth > 0) return
      schedulePersist(true)
    }),
  )
  unsubscribers.push(
    useModelCatalogStore.subscribe(() => {
      if (reloadDepth > 0) return
      schedulePersist()
    }),
  )
  unsubscribers.push(
    useProjectStore.subscribe(() => {
      if (reloadDepth > 0) return
      schedulePersist()
    }),
  )
  let previousSessionIds = new Set(
    useSessionStore.getState().sessions.map((s) => s.id),
  )
  let previousSessionsById = new Map(
    useSessionStore.getState().sessions.map((session) => [session.id, session]),
  )
  unsubscribers.push(
    useSessionStore.subscribe((state) => {
      if (reloadDepth > 0) return
      const currentIds = new Set(state.sessions.map((s) => s.id))
      for (const session of state.sessions) {
        if (previousSessionsById.get(session.id) !== session) {
          dirtySessionIds.add(session.id)
        }
      }
      for (const id of previousSessionIds) {
        if (!currentIds.has(id)) {
          if (deletedRemoteSessionIds.has(id)) {
            void deleteSessionLocalCache(id)
          } else {
            void deleteSessionEntries(id)
          }
        }
      }
      previousSessionIds = currentIds
      previousSessionsById = new Map(
        state.sessions.map((session) => [session.id, session]),
      )
      schedulePersist()
    }),
  )
  unsubscribers.push(
    useUiStore.subscribe(() => {
      if (reloadDepth > 0) return
      schedulePersist()
    }),
  )
  let previousAgents = useSubAgentStore.getState().agents
  unsubscribers.push(
    useSubAgentStore.subscribe((state) => {
      if (reloadDepth > 0) {
        previousAgents = state.agents
        return
      }
      if (state.agents !== previousAgents) {
        const previousById = new Map(
          previousAgents.map((agent) => [agent.id, agent]),
        )
        const nextIds = new Set(state.agents.map((agent) => agent.id))
        for (const agent of state.agents) {
          if (previousById.get(agent.id) !== agent) {
            dirtySessionIds.add(agent.parentSessionId)
          }
        }
        for (const agent of previousAgents) {
          if (!nextIds.has(agent.id)) {
            dirtySessionIds.add(agent.parentSessionId)
          }
        }
        previousAgents = state.agents
        schedulePersist()
      }
    }),
  )
  unsubscribers.push(
    useMessageStore.subscribe((state, prev) => {
      if (reloadDepth > 0) return
      for (const sessionId of Object.keys(state.entriesBySession)) {
        if (
          state.entriesBySession[sessionId] !==
          prev.entriesBySession[sessionId]
        ) {
          dirtySessionIds.add(sessionId)
        }
      }
      let urgency: PersistUrgency = 'debounce'
      try {
        urgency = detectEntriesPersistUrgency(
          state.entriesBySession,
          prev.entriesBySession,
        )
      } catch {
        // Subscriber must never throw; prefer durable flush on compare failure.
        urgency = 'immediate'
      }
      if (urgency === 'immediate') {
        // Cancel pending debounced snapshot so it cannot overwrite terminal.
        schedulePersist(true)
        return
      }
      schedulePersist(false)
    }),
  )
}

export function seedIfEmpty(): void {
  const projects = useProjectStore.getState().projects
  const sessions = useSessionStore.getState().sessions
  if (projects.length > 0 || sessions.length > 0) return

  const now = Date.now()

  const cliProxyApi: Project = {
    id: createId(),
    name: 'CLIProxyAPI',
    pinned: true,
    createdAt: now,
    updatedAt: now,
  }
  const cliProxyApiHome: Project = {
    id: createId(),
    name: 'CLIProxyAPIHome',
    pinned: false,
    createdAt: now + 1,
    updatedAt: now + 1,
  }

  const sessionAuth: Session = {
    id: createId(),
    projectId: cliProxyApi.id,
    branch: 'dev',
    title: 'Fix auth middleware',
    pinned: true,
    createdAt: now,
    updatedAt: now + 3,
  }
  const sessionPlugin: Session = {
    id: createId(),
    projectId: cliProxyApi.id,
    branch: 'dev',
    title: 'Add plugin marketplace routes',
    pinned: false,
    createdAt: now + 1,
    updatedAt: now + 2,
  }
  const sessionHome: Session = {
    id: createId(),
    projectId: cliProxyApiHome.id,
    branch: 'main',
    title: 'Home layout adjustment',
    pinned: false,
    createdAt: now + 2,
    updatedAt: now + 1,
  }

  useProjectStore.getState().hydrate([cliProxyApi, cliProxyApiHome])
  useSessionStore.getState().hydrate({
    sessions: [sessionAuth, sessionPlugin, sessionHome],
    currentSessionId: sessionAuth.id,
  })
  useMessageStore.getState().hydrate({})
  useUiStore.getState().hydrate({ collapsedGroups: {} })
}

export async function initPersistence(): Promise<void> {
  try {
    const loaded = await loadPersistedState()
    if (loaded) {
      applyPersistedState(loaded)
    } else {
      console.warn('[PersistenceService] loadPersistedState returned null, seeding empty state')
      seedIfEmpty()
    }
  } catch (err) {
    console.error('[PersistenceService] initPersistence failed with error:', err)
    // Storage / JSON failures must not crash startup.
    try {
      seedIfEmpty()
    } catch {
      // ignore
    }
  }
  bindPersistence()

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
      void flushPendingPersistence()
    })
  }
}

export function getLastPersistWriteError(): string | null {
  return lastWriteError
}

/** Test helper: clear debounce timer and re-enable binding. */
export function __resetPersistenceForTests(): void {
  clearAllPersistTimers()
  for (const unsub of unsubscribers) {
    try {
      unsub()
    } catch {
      // ignore
    }
  }
  unsubscribers = []
  bound = false
  disposed = false
  customWrite = null
  onWriteError = null
  writeInFlight = false
  writeQueued = false
  dirtyGeneration = 0
  dirtySessionIds.clear()
  debounceEpoch = 0
  retryEpoch = 0
  writeAttempt = 0
  attemptGeneration = -1
  writeWaiters = []
  lastWriteError = null
  debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  retryMs = DEFAULT_RETRY_MS
  maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS
  retryDelaysMs = []
  timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }
  reloadDepth = 0
  loadedSessionIds.clear()
  staleSessionIds.clear()
  sessionEntriesRevisions.clear()
  pendingEntryRemovals.clear()
  entryRemovalSequence = 0
  sessionReadEpochs.clear()
  sessionHydrations.clear()
  sessionWrites.clear()
  sessionWriteEpochs.clear()
  persistingSessionIds.clear()
  historyConflicts.clear()
  historyRecoveries.clear()
  deletedRemoteSessionIds.clear()
}

export const persistenceService: PersistenceService = {
  async init(): Promise<void> {
    await initPersistence()
  },
  async flush(): Promise<void> {
    await flushPendingPersistence()
  },
}
