import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AssistantEntry,
  ConversationEntry,
} from '@/features/agent-runtime/session/types'
import { DEFAULT_SETTINGS } from '@/types/models'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { getHostServices } from './createHostServices'
import { BrowserBridgeClient } from '@/features/agent-runtime/native/browserBridge'
import {
  __setCachedBrowserClientForTests,
  canUseHostKvStore,
  isNativeRuntime,
  setHostBridge,
} from './hostTransport'
import {
  __resetPersistenceForTests,
  applyPersistedState,
  bindPersistence,
  deleteSessionEntries,
  deleteSessionLocalCache,
  detectEntriesPersistUrgency,
  disposePersistence,
  ensureSessionLoaded,
  flushPendingPersistence,
  hydrateEmptySessionFromDisk,
  invalidateSessionDiskCache,
  loadPersistedState,
  loadSessionData,
  loadSessionEntries,
  markRemoteSessionDeleted,
  reloadSessionFromDisk,
  sanitizeConversationEntries,
  sanitizeSubAgents,
  savePersistedState,
  saveSessionData,
  saveSessionEntries,
  seedIfEmpty,
  serializeAppState,
  withSuppressedPersistence,
  type PersistedAppState,
} from './persistenceService'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useUiStore } from '@/stores/uiStore'

function resetAllStores(): void {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useProjectStore.setState({ projects: [] })
  useSessionStore.setState({ sessions: [], currentSessionId: null })
  useMessageStore.setState({ entriesBySession: {} })
  useSubAgentStore.setState({
    agents: [],
    openTabIdsByParent: {},
    focusedIdByParent: {},
  })
  useMessageStore.getState().clearHydrateDiagnostics?.()
  useUiStore.setState({
    collapsedGroups: {},
    sidebarCollapsed: false,
    sidebarWidth: 272,
    rightSidebarCollapsed: true,
    rightSidebarMaximized: false,
    rightSidebarWidth: null,
    pinnedSummaryVisible: true,
    bottomPanelVisible: false,
    bottomPanelHeight: 220,
    settingsOpen: false,
    composerDraft: '',
    toasts: [],
  })
  __resetPersistenceForTests()
}

function assistant(
  id: string,
  sessionId: string,
  status: 'streaming' | 'done' | 'error' | 'aborted',
  text: string,
): ConversationEntry {
  return {
    id,
    sessionId,
    kind: 'assistant',
    version: 1,
    createdAt: 1,
    content: [{ type: 'text', text }],
    status,
    stopReason:
      status === 'streaming'
        ? 'pending'
        : status === 'done'
          ? 'stop'
          : status === 'error'
            ? 'error'
            : 'aborted',
  }
}

/** Flush async persist write queue (write is fire-and-forget). */
async function flushWrites(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('persist pure helpers', () => {
  beforeEach(() => {
    setHostBridge(null)
    resetAllStores()
  })

  afterEach(() => {
    // Hard reset so a hung write cycle cannot block later tests.
    setHostBridge(null)
    __resetPersistenceForTests()
    vi.useRealTimers()
  })

  it('normalizes a missing Web Server password to empty string', () => {
    const legacy = serializeAppState()
    legacy.settings = {
      ...legacy.settings,
      webServer: {
        enabled: true,
        host: '0.0.0.0',
        port: 18080,
      },
    } as typeof legacy.settings

    applyPersistedState(legacy)

    expect(useSettingsStore.getState().settings.webServer).toEqual({
      enabled: true,
      host: '0.0.0.0',
      port: 18080,
      password: '',
    })
  })

  it('serializes and hydrates the exact Web Server password', () => {
    useSettingsStore.getState().setWebServer({ password: '  lan secret  ' })

    const snapshot = serializeAppState()
    expect(snapshot.settings.webServer?.password).toBe('  lan secret  ')

    resetAllStores()
    applyPersistedState(snapshot)

    expect(useSettingsStore.getState().settings.webServer?.password).toBe(
      '  lan secret  ',
    )
  })

  it('serialize then apply restores sessions and canonical entries', () => {
    useSettingsStore.getState().setTheme('light')
    useSettingsStore.getState().setLocale('en')
    useSettingsStore.getState().setReasoningLevel('high')
    useSettingsStore.getState().setSpeed('fast')
    const projectId = useProjectStore.getState().addProject({
      name: 'Demo',
      path: '/demo',
    })
    const sessionId = useSessionStore.getState().createSession({
      title: 'Session A',
      projectId,
    })
    useMessageStore.getState().appendEntry({
      id: 'u1',
      sessionId,
      kind: 'user',
      version: 1,
      createdAt: 1,
      content: [{ type: 'text', text: 'hello' }],
    })
    useUiStore.getState().toggleGroup('pinned')

    const snapshot = serializeAppState()
    expect(snapshot.version).toBe(2)
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.messagesBySession[sessionId]).toHaveLength(1)
    expect(snapshot.messagesBySession[sessionId][0]).toMatchObject({
      kind: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })

    resetAllStores()
    expect(useSessionStore.getState().sessions).toHaveLength(0)

    applyPersistedState(snapshot)

    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().currentSessionId).toBe(sessionId)
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(useMessageStore.getState().getEntries(sessionId)).toHaveLength(1)
    expect(useSettingsStore.getState().settings.theme).toBe('light')
    expect(useSettingsStore.getState().settings.locale).toBe('en')
    expect(useSettingsStore.getState().settings.reasoningLevel).toBe('high')
    expect(useSettingsStore.getState().settings.speed).toBe('fast')
    expect(useUiStore.getState().collapsedGroups.pinned).toBe(true)
  })

  it('serialize then apply restores right sidebar and pinned summary chrome', () => {
    useUiStore.getState().setRightSidebarCollapsed(false)
    useUiStore.getState().setRightSidebarMaximized(true)
    useUiStore.getState().setPinnedSummaryVisible(false)
    useUiStore.getState().setSidebarWidth(360)
    useUiStore.getState().setRightSidebarWidth(480)
    useUiStore.getState().setBottomPanelVisible(true)
    useUiStore.getState().setBottomPanelHeight(320)

    const snapshot = serializeAppState()
    expect(snapshot.rightSidebarCollapsed).toBe(false)
    expect(snapshot.rightSidebarMaximized).toBe(true)
    expect(snapshot.pinnedSummaryVisible).toBe(false)
    expect(snapshot.sidebarWidth).toBe(360)
    expect(snapshot.rightSidebarWidth).toBe(480)
    expect(snapshot.bottomPanelVisible).toBe(true)
    expect(snapshot.bottomPanelHeight).toBe(320)

    resetAllStores()
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(true)
    expect(useUiStore.getState().rightSidebarMaximized).toBe(false)
    expect(useUiStore.getState().pinnedSummaryVisible).toBe(true)
    expect(useUiStore.getState().sidebarWidth).toBe(272)
    expect(useUiStore.getState().rightSidebarWidth).toBeNull()
    expect(useUiStore.getState().bottomPanelVisible).toBe(false)
    expect(useUiStore.getState().bottomPanelHeight).toBe(220)

    applyPersistedState(snapshot)
    expect(useUiStore.getState().rightSidebarCollapsed).toBe(false)
    expect(useUiStore.getState().rightSidebarMaximized).toBe(true)
    expect(useUiStore.getState().pinnedSummaryVisible).toBe(false)
    expect(useUiStore.getState().sidebarWidth).toBe(360)
    expect(useUiStore.getState().rightSidebarWidth).toBe(480)
    expect(useUiStore.getState().bottomPanelVisible).toBe(true)
    expect(useUiStore.getState().bottomPanelHeight).toBe(320)
  })

  it('accepts version 1 and missing version snapshots', () => {
    const v1 = {
      version: 1,
      settings: {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: 'cpa-mock-pro',
        requestApproval: false,
      },
      projects: [],
      sessions: [],
      messagesBySession: {
        s1: [
          {
            id: 'm1',
            sessionId: 's1',
            role: 'assistant',
            content: 'done',
            status: 'done',
            createdAt: 13,
          },
        ],
      },
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(v1)
    expect(useMessageStore.getState().getEntries('s1')[0]).toMatchObject({
      kind: 'assistant',
      status: 'done',
    })

    resetAllStores()
    const missingVersion = {
      settings: { ...DEFAULT_SETTINGS },
      projects: [],
      sessions: [],
      messagesBySession: {
        s2: [
          {
            id: 'u1',
            sessionId: 's2',
            role: 'user',
            content: 'hi',
            createdAt: 1,
          },
        ],
      },
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState
    applyPersistedState(missingVersion)
    expect(useMessageStore.getState().getEntries('s2')).toHaveLength(1)
  })

  it('uses default composer preferences for legacy snapshots', () => {
    const legacyState = {
      version: 1,
      settings: {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: 'cpa-mock-pro',
        requestApproval: false,
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(legacyState)

    expect(useSettingsStore.getState().settings.reasoningLevel).toBe(
      DEFAULT_SETTINGS.reasoningLevel,
    )
    expect(useSettingsStore.getState().settings.speed).toBe(DEFAULT_SETTINGS.speed)
    expect(
      useSettingsStore.getState().settings.compactionThresholdPercent,
    ).toBe(DEFAULT_SETTINGS.compactionThresholdPercent)
  })

  it('restores CLIProxyAPI settings', () => {
    useSettingsStore.getState().setCliProxyApi({
      baseUrl: 'http://127.0.0.1:8317',
      apiKey: 'secret-key',
    })
    const snapshot = serializeAppState()

    resetAllStores()
    applyPersistedState(snapshot)

    expect(useSettingsStore.getState().settings.cliProxyApi).toEqual({
      baseUrl: 'http://127.0.0.1:8317',
      apiKey: 'secret-key',
    })
  })

  it('fills CLIProxyAPI defaults for legacy snapshots', () => {
    const legacyState = {
      version: 1,
      settings: {
        theme: 'dark',
        locale: 'zh-CN',
        modelId: 'cpa-mock-pro',
        reasoningLevel: 'medium',
        speed: 'standard',
        requestApproval: false,
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(legacyState)

    expect(useSettingsStore.getState().settings.cliProxyApi).toEqual({
      baseUrl: '',
      apiKey: '',
    })
  })

  it('normalizes malformed CLIProxyAPI settings', () => {
    const state = {
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        cliProxyApi: { baseUrl: 123, apiKey: null },
      },
    } as unknown as PersistedAppState

    applyPersistedState(state)

    expect(useSettingsStore.getState().settings.cliProxyApi).toEqual({
      baseUrl: '',
      apiKey: '',
    })
  })

  it('preserves unknown reasoning efforts for remote model preferences', () => {
    const state = {
      ...serializeAppState(),
      settings: { ...DEFAULT_SETTINGS, reasoningLevel: 'custom-effort' },
    } as PersistedAppState

    applyPersistedState(state)

    expect(useSettingsStore.getState().settings.reasoningLevel).toBe(
      'custom-effort',
    )
  })

  it('uses default composer preferences for unknown persisted values', () => {
    const state = {
      version: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        cliProxyApi: { baseUrl: '', apiKey: '' },
        reasoningLevel: 'unknown',
        speed: 'unknown',
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(state)

    expect(useSettingsStore.getState().settings.reasoningLevel).toBe('unknown')
    expect(useSettingsStore.getState().settings.speed).toBe(DEFAULT_SETTINGS.speed)
  })

  it('normalizes invalid locale to default locale', () => {
    const state = {
      version: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        locale: 'invalid-locale',
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(state)

    expect(useSettingsStore.getState().settings.locale).toBe(DEFAULT_SETTINGS.locale)
  })

  it('updates composer preferences with their setters', () => {
    useSettingsStore.getState().setReasoningLevel('ultraHigh')
    useSettingsStore.getState().setSpeed('max')
    useSettingsStore.getState().setCompactionThresholdPercent(80)
    useSettingsStore.getState().setFastContextCompaction(false)

    expect(useSettingsStore.getState().settings.reasoningLevel).toBe('ultraHigh')
    expect(useSettingsStore.getState().settings.speed).toBe('max')
    expect(useSettingsStore.getState().settings.compactionThresholdPercent).toBe(80)
    expect(useSettingsStore.getState().settings.fastContextCompaction).toBe(false)
  })

  it('defaults missing fast context compaction to enabled', () => {
    const legacySettings = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>
    delete legacySettings.fastContextCompaction

    applyPersistedState({
      ...serializeAppState(),
      settings: legacySettings as typeof DEFAULT_SETTINGS,
    })

    expect(useSettingsStore.getState().settings.fastContextCompaction).toBe(true)
  })

  it('clamps persisted compaction threshold percents', () => {
    applyPersistedState({
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        compactionThresholdPercent: 140,
      },
    })
    expect(useSettingsStore.getState().settings.compactionThresholdPercent).toBe(
      100,
    )

    applyPersistedState({
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        compactionThresholdPercent: 10,
      },
    })
    expect(useSettingsStore.getState().settings.compactionThresholdPercent).toBe(
      10,
    )

    applyPersistedState({
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        compactionThresholdPercent: 0,
      },
    })
    expect(useSettingsStore.getState().settings.compactionThresholdPercent).toBe(
      95,
    )

    applyPersistedState({
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        terminalPosition: 'right',
      },
    })
    expect(useSettingsStore.getState().settings.terminalPosition).toBe('right')

    applyPersistedState({
      ...serializeAppState(),
      settings: {
        ...DEFAULT_SETTINGS,
        // @ts-expect-error test fallback
        terminalPosition: 'invalid',
      },
    })
    expect(useSettingsStore.getState().settings.terminalPosition).toBe('bottom')
  })

  it('persists and restores git and worktree settings', () => {
    useSettingsStore.getState().setGitSettings({
      branchPrefix: 'task/',
      mergeMethod: 'squash',
      alwaysForcePush: true,
      createDraftPr: false,
      reviewPresentation: 'inline',
      autoMergeWhenReady: true,
      autoMergeInstructions: 'auto merge test',
      commitInstructions: 'commit instructions test',
      prInstructions: 'pr instructions test',
    })
    useSettingsStore.getState().setWorktreeSettings({
      rootDir: '/path/to/worktrees',
      fetchUpstream: true,
      autoDeleteOld: false,
      deleteLimit: 25,
    })

    const snapshot = serializeAppState()
    resetAllStores()
    applyPersistedState(snapshot)

    expect(useSettingsStore.getState().settings.git).toEqual({
      branchPrefix: 'task/',
      mergeMethod: 'squash',
      alwaysForcePush: true,
      createDraftPr: false,
      reviewPresentation: 'inline',
      autoMergeWhenReady: true,
      autoMergeInstructions: 'auto merge test',
      commitInstructions: 'commit instructions test',
      prInstructions: 'pr instructions test',
    })
    expect(useSettingsStore.getState().settings.worktrees).toEqual({
      rootDir: '/path/to/worktrees',
      fetchUpstream: true,
      autoDeleteOld: false,
      deleteLimit: 25,
    })
  })

  it('normalizes malformed git and worktree settings', () => {
    const malformedState = {
      version: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        git: {
          branchPrefix: 123,
          mergeMethod: 'unknown-method',
          alwaysForcePush: 'yes',
        },
        worktrees: {
          rootDir: 456,
          deleteLimit: -5,
        },
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(malformedState)

    expect(useSettingsStore.getState().settings.git?.branchPrefix).toBe('codex/')
    expect(useSettingsStore.getState().settings.git?.mergeMethod).toBe('merge')
    expect(useSettingsStore.getState().settings.git?.alwaysForcePush).toBe(false)
    expect(useSettingsStore.getState().settings.worktrees?.rootDir).toBe(
      '~/.coding-professional-agent/worktrees'
    )
    expect(useSettingsStore.getState().settings.worktrees?.deleteLimit).toBe(15)
  })

  it('persists and restores editor settings', () => {
    useSettingsStore.getState().setEditorSettings({
      showContextUsage: false,
      sendShortcut: 'enter',
      followUpMode: 'queue',
    })

    const snapshot = serializeAppState()
    resetAllStores()
    applyPersistedState(snapshot)

    expect(useSettingsStore.getState().settings.editor).toEqual({
      showContextUsage: false,
      sendShortcut: 'enter',
      followUpMode: 'queue',
    })
  })

  it('normalizes malformed editor settings', () => {
    const malformedState = {
      version: 2,
      settings: {
        ...DEFAULT_SETTINGS,
        editor: {
          showContextUsage: 0,
          sendShortcut: 'invalid-shortcut',
          followUpMode: 'invalid-mode',
        },
      },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
    } as unknown as PersistedAppState

    applyPersistedState(malformedState)

    expect(useSettingsStore.getState().settings.editor).toEqual({
      showContextUsage: true,
      sendShortcut: 'cmdEnter',
      followUpMode: 'steer',
    })
  })

  it('seedIfEmpty creates demo projects when empty', () => {
    seedIfEmpty()

    const projects = useProjectStore.getState().projects
    const sessions = useSessionStore.getState().sessions

    expect(projects.length).toBeGreaterThanOrEqual(1)
    expect(projects.some((p) => p.name === 'CLIProxyAPI')).toBe(true)
    expect(projects.some((p) => p.name === 'CLIProxyAPIHome')).toBe(true)
    expect(projects.every((project) => project.path === undefined)).toBe(true)
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(useSessionStore.getState().currentSessionId).not.toBeNull()
  })

  it('seedIfEmpty is a no-op when projects already exist', () => {
    useProjectStore.getState().addProject({ name: 'Existing' })
    seedIfEmpty()
    expect(useProjectStore.getState().projects).toHaveLength(1)
    expect(useProjectStore.getState().projects[0].name).toBe('Existing')
    expect(useSessionStore.getState().sessions).toHaveLength(0)
  })

  it('applyPersistedState migrates full legacy snapshot without resetting other stores incorrectly', () => {
    const state: PersistedAppState = {
      version: 1,
      settings: {
        theme: 'system',
        locale: 'zh-CN',
        modelId: 'cpa-mock-fast',
        reasoningLevel: 'high',
        speed: 'fast',
        requestApproval: true,
        compactionThresholdPercent: 95,
        fastContextCompaction: true,
        showInMenuBar: true,
        showBottomPanel: true,
        terminalPosition: 'bottom',
        cliProxyApi: { baseUrl: '', apiKey: '' },
      },
      projects: [
        {
          id: 'p1',
          name: 'CLIProxyAPI',
          path: '/demo/CLIProxyAPI',
          pinned: true,
          createdAt: 10,
          updatedAt: 10,
        },
        {
          id: 'p2',
          name: 'Repo',
          path: '/workspace/repo',
          pinned: false,
          createdAt: 9,
          updatedAt: 9,
        },
      ],
      sessions: [
        {
          id: 's1',
          projectId: 'p1',
          title: 'Fix auth middleware',
          pinned: false,
          createdAt: 11,
          updatedAt: 12,
        },
      ],
      messagesBySession: {
        s1: [
          {
            id: 'm1',
            sessionId: 's1',
            role: 'assistant',
            content: 'done',
            status: 'done',
            createdAt: 13,
          } as unknown as ConversationEntry,
        ],
      },
      currentSessionId: 's1',
      collapsedGroups: { p1: true },
    }

    applyPersistedState(state)

    expect(useSettingsStore.getState().settings.modelId).toBe('cpa-mock-fast')
    expect(useSettingsStore.getState().settings.reasoningLevel).toBe('high')
    expect(useSettingsStore.getState().settings.speed).toBe('fast')
    expect(useSettingsStore.getState().settings.requestApproval).toBe(true)
    expect(useProjectStore.getState().projects[0]).toMatchObject({
      name: 'CLIProxyAPI',
      path: undefined,
      paths: [],
    })
    expect(useProjectStore.getState().projects[1]).toMatchObject({
      name: 'Repo',
      path: '/workspace/repo',
      paths: ['/workspace/repo'],
    })
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useMessageStore.getState().getEntries('s1')[0]).toMatchObject({
      kind: 'assistant',
      status: 'done',
    })
    expect(useUiStore.getState().collapsedGroups.p1).toBe(true)
  })

  it('sanitize strips scratch fields, cycles, functions and keeps image base64', () => {
    const cyclic: Record<string, unknown> = {
      id: 'a1',
      sessionId: 's1',
      kind: 'assistant',
      version: 1,
      createdAt: 1,
      status: 'done',
      stopReason: 'stop',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'base64-IMAGE-DATA', mimeType: 'image/png' },
      ],
      partialJson: '{"x":1}',
      runtimeDetails: { signal: {} },
    }
    cyclic.self = cyclic

    const sanitized = sanitizeConversationEntries({
      s1: [cyclic as unknown as ConversationEntry],
    })
    const entry = sanitized.s1[0] as unknown as Record<string, unknown>
    expect(entry.partialJson).toBeUndefined()
    expect(entry.runtimeDetails).toBeUndefined()
    expect(entry.self).toBeUndefined()
    expect(entry.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'base64-IMAGE-DATA', mimeType: 'image/png' },
    ])
    expect(() => JSON.stringify(sanitized)).not.toThrow()
  })

  it('debounces streaming deltas and flushes terminal/tool/compaction immediately', async () => {
    vi.useFakeTimers()
    let writeCount = 0

    bindPersistence({
      write: async () => {
        writeCount += 1
      },
      debounceMs: 400,
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'streaming', 'h'))
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'streaming', 'he'))
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'streaming', 'hel'))
    expect(writeCount).toBe(0)

    await vi.advanceTimersByTimeAsync(399)
    expect(writeCount).toBe(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(writeCount).toBe(1)

    writeCount = 0
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'done', 'hello'))
    await flushWrites()
    expect(writeCount).toBe(1)

    writeCount = 0
    useMessageStore.getState().appendEntry({
      id: 'tr1',
      sessionId: 's1',
      kind: 'toolResult',
      version: 1,
      createdAt: 2,
      toolCallId: 'tc1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    await flushWrites()
    expect(writeCount).toBe(1)

    writeCount = 0
    useMessageStore.getState().appendEntry({
      id: 'c1',
      sessionId: 's1',
      kind: 'compaction',
      version: 1,
      createdAt: 3,
      summary: 'sum',
      firstKeptEntryId: 'a1',
    })
    await flushWrites()
    expect(writeCount).toBe(1)

    writeCount = 0
    useMessageStore.getState().appendEntry({
      id: 'u1',
      sessionId: 's1',
      kind: 'user',
      version: 1,
      createdAt: 0,
      content: [{ type: 'text', text: 'user' }],
    })
    await flushWrites()
    expect(writeCount).toBe(1)
  })

  it('cancels debounced snapshot when immediate terminal arrives for same session', async () => {
    vi.useFakeTimers()
    const payloads: Array<Record<string, ConversationEntry[]>> = []
    bindPersistence({
      write: async (state) => {
        payloads.push(state.messagesBySession)
      },
      debounceMs: 400,
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'streaming', 'a'))
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'streaming', 'ab'))
    // Immediate terminal must flush latest, not stale debounced 'ab' only if later.
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'done', 'abc'))
    await flushWrites()
    expect(payloads).toHaveLength(1)
    expect(
      (payloads[0].s1.find((e) => e.id === 'a1') as { content: { text: string }[] })
        .content[0].text,
    ).toBe('abc')

    await vi.advanceTimersByTimeAsync(500)
    // No second write from the cancelled debounce.
    expect(payloads).toHaveLength(1)
  })

  it('multi-session dirty writes do not drop sibling sessions', async () => {
    vi.useFakeTimers()
    const payloads: Array<Record<string, ConversationEntry[]>> = []
    bindPersistence({
      write: async (state) => {
        payloads.push(structuredClone(state.messagesBySession))
      },
      debounceMs: 400,
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'streaming', 's1'))
    useMessageStore.getState().appendEntry(assistant('a2', 's2', 'done', 's2-done'))
    await flushWrites()
    // s2 immediate should include current s1 streaming state.
    expect(payloads.length).toBeGreaterThanOrEqual(1)
    const last = payloads[payloads.length - 1]
    expect(last.s2?.[0]).toMatchObject({ id: 'a2', status: 'done' })
    expect(last.s1?.[0]).toMatchObject({ id: 'a1' })

    await vi.advanceTimersByTimeAsync(500)
    const final = payloads[payloads.length - 1]
    expect(final.s1?.[0]).toMatchObject({ id: 'a1' })
    expect(final.s2?.[0]).toMatchObject({ id: 'a2' })
  })

  it('write failure is retried and does not throw unhandled', async () => {
    vi.useFakeTimers()
    let attempts = 0
    bindPersistence({
      write: async () => {
        attempts += 1
        if (attempts < 2) throw new Error('disk full')
      },
      debounceMs: 10,
      retryMs: 20,
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'done', 'ok'))
    await flushWrites()
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(25)
    expect(attempts).toBe(2)
  })

  it('flushPendingPersistence and dispose clear timers safely', async () => {
    vi.useFakeTimers()
    let writes = 0
    bindPersistence({
      write: async () => {
        writes += 1
      },
      debounceMs: 400,
    })
    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'streaming', 'x'))
    await flushPendingPersistence()
    expect(writes).toBe(1)
    await disposePersistence()
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'streaming', 'xy'))
    await vi.advanceTimersByTimeAsync(1000)
    // Disposed: no additional automatic writes.
    expect(writes).toBe(1)
  })

  it('urgency compare tolerates cycles and BigInt without throwing', () => {
    const shared = { n: 1 as unknown }
    const cyclic: Record<string, unknown> = {
      id: 'a1',
      sessionId: 's1',
      kind: 'assistant',
      version: 1,
      createdAt: 1,
      status: 'streaming',
      stopReason: 'pending',
      content: [
        {
          type: 'toolCall',
          id: 't1',
          name: 'bash',
          arguments: {
            shared,
            alsoShared: shared,
            big: BigInt(10),
          },
        },
      ],
    }
    cyclic.self = cyclic

    const next = { s1: [cyclic as unknown as ConversationEntry] }
    const prev = { s1: [] as ConversationEntry[] }
    expect(() => detectEntriesPersistUrgency(next, prev)).not.toThrow()
    expect(detectEntriesPersistUrgency(next, prev)).toBe('debounce')
  })

  it('sanitize preserves shared refs, cycles become null, BigInt becomes tagged string', () => {
    const shared = { keep: true }
    const args: Record<string, unknown> = {
      left: shared,
      right: shared,
      big: BigInt(42),
    }
    args.loop = args

    const sanitized = sanitizeConversationEntries({
      s1: [
        {
          id: 'a1',
          sessionId: 's1',
          kind: 'assistant',
          version: 1,
          createdAt: 1,
          status: 'done',
          stopReason: 'stop',
          content: [
            {
              type: 'toolCall',
              id: 't1',
              name: 'bash',
              arguments: args as Record<string, unknown>,
            },
          ],
        } as ConversationEntry,
      ],
    })
    const tool = (sanitized.s1[0] as {
      content: Array<{ arguments: Record<string, unknown> }>
    }).content[0]
    expect(tool.arguments.left).toEqual({ keep: true })
    expect(tool.arguments.right).toEqual({ keep: true })
    expect(tool.arguments.big).toEqual({ $type: 'bigint', value: '42' })
    expect(tool.arguments.loop).toBeNull()
    expect(() => JSON.stringify(sanitized)).not.toThrow()
  })

  it('rewrites latest snapshot when state changes during an in-flight write', async () => {
    vi.useFakeTimers()
    const payloads: string[] = []
    const releases: Array<() => void> = []
    bindPersistence({
      write: async (state) => {
        await new Promise<void>((resolve) => {
          releases.push(resolve)
        })
        const entry = state.messagesBySession.s1?.[0] as {
          content: Array<{ text: string }>
        }
        payloads.push(entry.content[0].text)
      },
      debounceMs: 10,
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'done', 'first'))
    await flushWrites()
    expect(releases.length).toBe(1)
    // State changes while first write is still in-flight.
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'done', 'second'))
    await flushWrites()
    // Complete the first write; generation loop should immediately rewrite.
    releases[0]()
    await flushWrites()
    expect(releases.length).toBeGreaterThanOrEqual(2)
    releases[1]()
    await flushWrites()
    expect(payloads[payloads.length - 1]).toBe('second')
  })

  it('dangerous session keys round-trip through sanitize without pollution', () => {
    const entry = assistant('a1', '__proto__', 'done', 'x')
    const input = Object.create(null) as Record<string, ConversationEntry[]>
    input['__proto__'] = [entry]
    input['constructor'] = [assistant('a2', 'constructor', 'done', 'y')]
    input['prototype'] = [assistant('a3', 'prototype', 'done', 'z')]
    const sanitized = sanitizeConversationEntries(input)
    expect(
      Object.prototype.hasOwnProperty.call(sanitized, '__proto__'),
    ).toBe(true)
    expect(
      Object.prototype.hasOwnProperty.call(sanitized, 'constructor'),
    ).toBe(true)
    expect(sanitized['__proto__'][0]).toMatchObject({ id: 'a1' })
    expect(sanitized['constructor'][0]).toMatchObject({ id: 'a2' })
    expect(sanitized['prototype'][0]).toMatchObject({ id: 'a3' })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('permanent backend failure rejects flush after exact bounded attempts and leaves no timers', async () => {
    const handles = new Map<number, { fn: () => void; ms: number }>()
    let nextHandle = 1
    const attempts: string[] = []
    const diagnostics: Array<{ attempt: number; error: unknown }> = []
    const retryDelaysSeen: number[] = []

    // Seed before bind so flush owns the only write generation (exact 3 attempts).
    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'done', 'payload-v1'))
    bindPersistence({
      write: async (state) => {
        const text = (
          state.messagesBySession.s1?.[0] as {
            content: Array<{ text: string }>
          } | undefined
        )?.content?.[0]?.text ?? ''
        attempts.push(text)
        throw new Error('permanent-fail')
      },
      debounceMs: 10,
      maxRetryAttempts: 3,
      retryDelaysMs: [5, 7],
      onWriteError: (error, attempt) => {
        diagnostics.push({ attempt, error })
      },
      timers: {
        setTimeout: (fn, ms) => {
          const id = nextHandle++
          handles.set(id, { fn, ms })
          return id
        },
        clearTimeout: (id) => {
          handles.delete(id as number)
        },
      },
    })

    const pumpUntil = async <T,>(pending: Promise<T>): Promise<T> => {
      const box: {
        settled: { ok: true; value: T } | { ok: false; error: unknown } | null
      } = { settled: null }
      void pending.then(
        (value) => {
          box.settled = { ok: true, value }
        },
        (error: unknown) => {
          box.settled = { ok: false, error }
        },
      )
      for (let i = 0; i < 100 && !box.settled; i += 1) {
        await Promise.resolve()
        await Promise.resolve()
        if (handles.size > 0) {
          // One-shot like real timers: remove handle before invoking.
          const [id, handle] = [...handles.entries()][0]
          handles.delete(id)
          if (handle.ms === 5 || handle.ms === 7 || handle.ms === 1) {
            retryDelaysSeen.push(handle.ms)
          }
          handle.fn()
        }
        await Promise.resolve()
      }
      const settled = box.settled
      if (!settled) {
        throw new Error('timed out pumping persist timers')
      }
      if (!settled.ok) throw settled.error
      return settled.value
    }

    await expect(pumpUntil(flushPendingPersistence())).rejects.toThrow(
      /permanent-fail/,
    )
    expect(attempts).toEqual(['payload-v1', 'payload-v1', 'payload-v1'])
    expect(diagnostics.map((d) => d.attempt)).toEqual([1, 2, 3])
    expect(handles.size).toBe(0)
    expect(retryDelaysSeen).toEqual([5, 7])

    // Fresh state change starts a new generation cycle with latest payload.
    attempts.length = 0
    diagnostics.length = 0
    retryDelaysSeen.length = 0
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'done', 'payload-v2'))
    await expect(pumpUntil(flushPendingPersistence())).rejects.toThrow(
      /permanent-fail/,
    )
    expect(diagnostics.map((d) => d.attempt).slice(-3)).toEqual([1, 2, 3])
    expect(attempts.filter((text) => text === 'payload-v2').slice(-3)).toEqual([
      'payload-v2',
      'payload-v2',
      'payload-v2',
    ])
    expect(handles.size).toBe(0)
  })

  it('dispose rejects after retry exhaustion and clears all timer handles', async () => {
    const handles = new Map<number, { fn: () => void; ms: number }>()
    let nextHandle = 1
    const attempts: number[] = []

    bindPersistence({
      write: async () => {
        attempts.push(1)
        throw new Error('permanent-fail')
      },
      debounceMs: 10,
      maxRetryAttempts: 3,
      retryDelaysMs: [1, 1],
      timers: {
        setTimeout: (fn, ms) => {
          const id = nextHandle++
          handles.set(id, { fn, ms })
          return id
        },
        clearTimeout: (id) => {
          handles.delete(id as number)
        },
      },
    })

    const pumpUntil = async <T,>(pending: Promise<T>): Promise<T> => {
      const box: {
        settled: { ok: true; value: T } | { ok: false; error: unknown } | null
      } = { settled: null }
      void pending.then(
        (value) => {
          box.settled = { ok: true, value }
        },
        (error: unknown) => {
          box.settled = { ok: false, error }
        },
      )
      for (let i = 0; i < 100 && !box.settled; i += 1) {
        await Promise.resolve()
        await Promise.resolve()
        if (handles.size > 0) {
          const [id, handle] = [...handles.entries()][0]
          handles.delete(id)
          handle.fn()
        }
        await Promise.resolve()
      }
      const settled = box.settled
      if (!settled) {
        throw new Error('timed out pumping persist timers')
      }
      if (!settled.ok) throw settled.error
      return settled.value
    }

    // Trigger a pending write cycle, then dispose while it is active.
    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'done', 'x'))
    await expect(pumpUntil(disposePersistence())).rejects.toThrow(/permanent-fail/)
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    expect(handles.size).toBe(0)
  })

  it('stale timer callbacks no-op and never duplicate writes after generation change', async () => {
    const handles = new Map<number, { fn: () => void; ms: number; cleared?: boolean }>()
    let nextHandle = 1
    const writes: string[] = []

    bindPersistence({
      write: async (state) => {
        const text = (
          state.messagesBySession.s1?.[0] as {
            content: Array<{ text: string }>
          }
        ).content[0].text
        writes.push(text)
      },
      debounceMs: 50,
      maxRetryAttempts: 3,
      retryDelaysMs: [10, 10],
      timers: {
        setTimeout: (fn, ms) => {
          const id = nextHandle++
          handles.set(id, { fn, ms })
          return id
        },
        clearTimeout: (id) => {
          const handle = handles.get(id as number)
          if (handle) handle.cleared = true
          handles.delete(id as number)
        },
      },
    })

    useMessageStore.getState().appendEntry(assistant('a1', 's1', 'streaming', 'v1'))
    expect(handles.size).toBe(1)
    const stale = [...handles.values()][0]

    // Immediate terminal cancels debounce and writes once.
    useMessageStore.getState().replaceEntry(assistant('a1', 's1', 'done', 'v2'))
    await flushWrites()
    expect(writes).toEqual(['v2'])
    expect(stale.cleared).toBe(true)

    // Manually fire the stale debounce callback; must no-op.
    stale.fn()
    await flushWrites()
    expect(writes).toEqual(['v2'])
    // At most one active debounce/retry handle of each kind (none when idle).
    expect(handles.size).toBe(0)
  })

  it('serializes and hydrates cachedModels correctly', async () => {
    const customModels = [
      {
        id: 'remote-custom-model',
        label: 'Remote Custom Model',
        supportsFast: true,
        reasoningLevels: [{ id: 'high', requestValue: 'high' }],
        input: ['text'] as const,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
    ]

    const state: PersistedAppState = {
      version: 2,
      settings: { ...DEFAULT_SETTINGS, modelId: 'remote-custom-model', reasoningLevel: 'high' },
      projects: [],
      sessions: [],
      messagesBySession: {},
      currentSessionId: null,
      collapsedGroups: {},
      cachedModels: customModels,
    }

    applyPersistedState(state)

    const { useModelCatalogStore } = await import('@/stores/modelCatalogStore')
    expect(useModelCatalogStore.getState().models).toEqual(customModels)

    const serialized = serializeAppState()
    expect(serialized.cachedModels).toEqual(customModels)
    expect(serialized.settings.modelId).toBe('remote-custom-model')
    expect(serialized.settings.reasoningLevel).toBe('high')
  })

  describe('individual session storage and on-demand loading', () => {
    it('saves and loads individual session files via host bridge', async () => {
      const savedSessions: Record<string, unknown> = {}
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const entries = [
        assistant('a1', 'session-custom', 'done', 'hello from split session'),
      ]

      useSessionStore.setState({
        sessions: [
          {
            id: 'session-custom',
            projectId: 'proj-123',
            title: 'Custom Session',
            pinned: false,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      })
      useSettingsStore.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          speed: 'fast',
          reasoningLevel: 'high',
          modelId: 'gpt-5.4',
        },
      })

      await saveSessionEntries('session-custom', entries)
      expect(mockBridge.SessionSet).toHaveBeenCalledWith('session-custom', expect.objectContaining({
        id: 'session-custom',
        projectId: 'proj-123',
        speed: 'fast',
        reasoningEffort: 'high',
        modelId: 'gpt-5.4',
        entries: expect.arrayContaining([expect.objectContaining({ id: 'a1' })]),
      }))

      const loaded = await loadSessionEntries('session-custom')
      expect(loaded).toHaveLength(1)
      expect(loaded?.[0].id).toBe('a1')

      // Ensure on-demand loading populates messageStore
      expect(useMessageStore.getState().entriesBySession['session-custom']).toBeUndefined()
      await ensureSessionLoaded('session-custom')
      expect(useMessageStore.getState().entriesBySession['session-custom']).toHaveLength(1)

      // Test delete
      await deleteSessionEntries('session-custom')
      expect(mockBridge.SessionDelete).toHaveBeenCalledWith('session-custom')
      setHostBridge(null)
    })

    it('persists only changed session payloads without cloning every cached conversation', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async (_id: string, _data: unknown) => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useMessageStore.getState().replaceSessionEntries('session-a', [
        assistant('a1', 'session-a', 'streaming', 'latest'),
      ])
      useMessageStore.getState().replaceSessionEntries('session-b', [
        assistant('b1', 'session-b', 'done', 'cached'),
      ])

      const rawEntries = useMessageStore.getState().entriesBySession
      const snapshot = serializeAppState()
      expect(snapshot.messagesBySession).toBe(rawEntries)

      await savePersistedState(snapshot, {
        sessionIds: new Set(['session-a']),
      })

      expect(mockBridge.SessionSet).toHaveBeenCalledTimes(1)
      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'session-a',
        expect.objectContaining({
          entries: [expect.objectContaining({ id: 'a1' })],
        }),
      )
      setHostBridge(null)
    })

    it('tracks the changed message session through the persistence queue', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async (_id: string, _data: unknown) => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)
      useMessageStore.getState().replaceSessionEntries('session-a', [
        assistant('a1', 'session-a', 'streaming', 'before'),
      ])
      useMessageStore.getState().replaceSessionEntries('session-b', [
        assistant('b1', 'session-b', 'done', 'cached'),
      ])

      bindPersistence()
      useMessageStore
        .getState()
        .replaceEntry(assistant('a1', 'session-a', 'done', 'after'))
      await flushPendingPersistence()

      expect(mockBridge.SessionSet).toHaveBeenCalled()
      expect(
        mockBridge.SessionSet.mock.calls.map(([sessionId]) => sessionId),
      ).toEqual(['session-a'])
      setHostBridge(null)
    })

    it('keeps recorded session runtime settings when global selections change', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          {
            id: 'interrupted-session',
            title: 'Interrupted',
            pinned: false,
            modelId: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
            speed: 'standard',
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        currentSessionId: null,
      })
      useSettingsStore.getState().hydrate({
        modelId: 'gemini-3.7-flash',
        reasoningLevel: 'high',
        speed: 'fast',
      })

      await saveSessionData('interrupted-session', [
        assistant('a1', 'interrupted-session', 'streaming', 'partial response'),
      ])

      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'interrupted-session',
        expect.objectContaining({
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
          speed: 'standard',
        }),
      )
      setHostBridge(null)
    })

    it('saves subagents inside the parent session file and loads them on demand', async () => {
      const savedSessions: Record<string, unknown> = {}
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const parentSessionId = 'parent-sess-1'
      const childSessionId = 'child-subagent-1'

      const subAgent = {
        id: childSessionId,
        parentSessionId,
        sessionId: childSessionId,
        name: 'Worker',
        modelId: 'gpt-5.6',
        status: 'completed' as const,
        color: '#9b7dff',
        icon: 'sparkle' as const,
        createdAt: 100,
        updatedAt: 200,
        lastMessage: 'Task finished',
      }

      useSubAgentStore.setState({ agents: [subAgent] })

      await saveSessionEntries(parentSessionId, [
        assistant('a1', parentSessionId, 'done', 'main chat message'),
      ])

      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        parentSessionId,
        expect.objectContaining({
          id: parentSessionId,
          subAgents: expect.arrayContaining([
            expect.objectContaining({ id: childSessionId, name: 'Worker' }),
          ]),
        }),
      )

      // Clear store to verify on-demand loading
      resetAllStores()
      expect(useSubAgentStore.getState().agents).toHaveLength(0)

      const loadedData = await loadSessionData(parentSessionId)
      expect(loadedData?.subAgents).toHaveLength(1)
      expect(loadedData?.subAgents?.[0].id).toBe(childSessionId)

      await ensureSessionLoaded(parentSessionId)
      expect(useSubAgentStore.getState().agents).toHaveLength(1)
      expect(useSubAgentStore.getState().agents[0].name).toBe('Worker')

      setHostBridge(null)
    })

    it('sets isSubagent, parentSessionId, and inherits parent projectId when saving subagent session', async () => {
      const savedSessions: Record<string, unknown> = {}
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          {
            id: 'parent-123',
            projectId: 'proj-omega',
            title: 'Parent Session',
            pinned: false,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      })

      useSettingsStore.setState({
        settings: {
          ...useSettingsStore.getState().settings,
          modelId: 'settings-global-model',
          reasoningLevel: 'medium',
        },
      })

      useSubAgentStore.setState({
        agents: [
          {
            id: 'agent-sub-1',
            name: 'Sub Explorer',
            color: '#4f46e5',
            icon: 'sparkle',
            modelId: 'gpt-4o',
            reasoningEffort: 'high',
            parentSessionId: 'parent-123',
            sessionId: 'child-session-1',
            status: 'completed',
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      })

      const entries = [
        assistant('a1', 'child-session-1', 'done', 'child response'),
      ]

      await saveSessionData('child-session-1', entries)

      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'child-session-1',
        expect.objectContaining({
          id: 'child-session-1',
          isSubagent: true,
          parentSessionId: 'parent-123',
          projectId: 'proj-omega',
          modelId: 'gpt-4o',
          reasoningEffort: 'high',
        }),
      )

      setHostBridge(null)
    })

    it('saveSessionData includes session title from useSessionStore in payload', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.getState().hydrate({
        sessions: [
          {
            id: 'title-sess-1',
            title: 'Custom Saved Title',
            pinned: false,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      })

      const entries = [
        assistant('a1', 'title-sess-1', 'done', 'assistant response'),
      ]

      await saveSessionData('title-sess-1', entries)

      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'title-sess-1',
        expect.objectContaining({
          id: 'title-sess-1',
          title: 'Custom Saved Title',
        }),
      )

      setHostBridge(null)
    })

    it('saveSessionData includes session rightSidebar from useSessionStore in payload', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const rightSidebar = {
        collapsed: true,
        maximized: false,
        width: 320,
        activeTab: 'files',
        openTabs: ['files'],
        tabParams: { files: { rootPath: '/src' } },
      }

      useSessionStore.getState().hydrate({
        sessions: [
          {
            id: 'sidebar-sess-1',
            title: 'Sidebar Sess',
            pinned: false,
            createdAt: 100,
            updatedAt: 100,
            rightSidebar,
          },
        ],
      })

      const entries = [
        assistant('a1', 'sidebar-sess-1', 'done', 'assistant response'),
      ]

      await saveSessionData('sidebar-sess-1', entries)

      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'sidebar-sess-1',
        expect.objectContaining({
          id: 'sidebar-sess-1',
          title: 'Sidebar Sess',
          rightSidebar,
        }),
      )

      setHostBridge(null)
    })

    it('saveSessionData includes explicit unread state in payload to ensure read state is reliably persisted to database', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.getState().hydrate({
        sessions: [
          {
            id: 'read-sess-1',
            title: 'Read Session',
            pinned: false,
            unread: undefined,
            createdAt: 100,
            updatedAt: 100,
          },
          {
            id: 'unread-sess-2',
            title: 'Unread Session',
            pinned: false,
            unread: true,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
      })

      const entries = [
        assistant('a1', 'read-sess-1', 'done', 'response'),
      ]

      await saveSessionData('read-sess-1', entries)
      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'read-sess-1',
        expect.objectContaining({
          id: 'read-sess-1',
          unread: false,
        }),
      )

      await saveSessionData('unread-sess-2', entries)
      expect(mockBridge.SessionSet).toHaveBeenCalledWith(
        'unread-sess-2',
        expect.objectContaining({
          id: 'unread-sess-2',
          unread: true,
        }),
      )

      setHostBridge(null)
    })

    it('cascade deletes child subagent sessions when parent session is deleted', async () => {
      const savedSessions: Record<string, unknown> = {}
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const parentSessionId = 'parent-sess-del'
      const childSessionId = 'child-agent-del'

      useSubAgentStore.setState({
        agents: [
          {
            id: childSessionId,
            parentSessionId,
            sessionId: childSessionId,
            name: 'ChildWorker',
            modelId: 'gpt-5.6',
            status: 'completed',
            color: '#9b7dff',
            icon: 'sparkle',
            createdAt: 100,
            updatedAt: 200,
          },
        ],
      })
      useMessageStore.getState().replaceSessionEntries(parentSessionId, [
        assistant('m1', parentSessionId, 'done', 'parent message'),
      ])
      useMessageStore.getState().replaceSessionEntries(childSessionId, [
        assistant('c1', childSessionId, 'done', 'child message'),
      ])

      await deleteSessionEntries(parentSessionId)

      // Both child and parent sessions should be deleted via bridge
      expect(mockBridge.SessionDelete).toHaveBeenCalledWith(childSessionId)
      expect(mockBridge.SessionDelete).toHaveBeenCalledWith(parentSessionId)

      // Stores should be cleaned up
      expect(useSubAgentStore.getState().agents).toHaveLength(0)
      expect(useMessageStore.getState().entriesBySession[parentSessionId]).toBeUndefined()
      expect(useMessageStore.getState().entriesBySession[childSessionId]).toBeUndefined()

      setHostBridge(null)
    })

    it('cascade deletes child subagent sessions even when parent was never loaded in memory', async () => {
      const savedSessions: Record<string, unknown> = {
        'unloaded-parent': {
          id: 'unloaded-parent',
          version: 2,
          entries: [{ id: 'm1', kind: 'user', content: [{ type: 'text', text: 'hi' }] }],
          subAgents: [
            {
              id: 'unloaded-child',
              sessionId: 'unloaded-child',
              parentSessionId: 'unloaded-parent',
              name: 'DiskChild',
              modelId: 'gpt-5.6',
              status: 'completed',
            },
          ],
        },
        'unloaded-child': {
          id: 'unloaded-child',
          version: 2,
          entries: [{ id: 'cm1', kind: 'assistant', content: [{ type: 'text', text: 'child reply' }] }],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Parent was never loaded into store
      expect(useSubAgentStore.getState().agents).toHaveLength(0)

      await deleteSessionEntries('unloaded-parent')

      // Bridge should have deleted both disk child and parent
      expect(mockBridge.SessionDelete).toHaveBeenCalledWith('unloaded-child')
      expect(mockBridge.SessionDelete).toHaveBeenCalledWith('unloaded-parent')

      setHostBridge(null)
    })

    it('savePersistedState never overwrites unvisited sessions and never puts subAgents into app-data.json', async () => {
      let savedKvState: any = null
      const savedSessions: Record<string, unknown> = {
        'unvisited-sess': {
          id: 'unvisited-sess',
          version: 2,
          entries: [{ id: 'u1', kind: 'user', content: [{ type: 'text', text: 'preserved' }] }],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async (_k: string, val: unknown) => {
          savedKvState = val
        }),
      }
      setHostBridge(mockBridge as any)

      const activeSessId = 'active-sess'
      useSessionStore.setState({
        sessions: [
          { id: activeSessId, title: 'Active', pinned: false, createdAt: 1, updatedAt: 1 },
          { id: 'unvisited-sess', title: 'Unvisited', pinned: false, createdAt: 2, updatedAt: 2 },
        ],
        currentSessionId: activeSessId,
      })
      useMessageStore.getState().replaceSessionEntries(activeSessId, [
        assistant('a1', activeSessId, 'done', 'active message'),
      ])

      const snapshot = serializeAppState()
      expect((snapshot as any).subAgents).toBeUndefined()

      await savePersistedState(snapshot)

      // KV store should NOT contain subAgents
      expect(savedKvState).not.toBeNull()
      expect(savedKvState.subAgents).toBeUndefined()

      // Active session should be saved
      expect(mockBridge.SessionSet).toHaveBeenCalledWith(activeSessId, expect.anything())
      // Unvisited session must NOT have been called with empty array
      expect(mockBridge.SessionSet).not.toHaveBeenCalledWith('unvisited-sess', expect.anything())

      setHostBridge(null)
    })

    it('ensureSessionLoaded preserves live in-memory entries while loading subagents', async () => {
      const parentSessionId = 'live-sess-1'
      const savedSessions: Record<string, unknown> = {
        [parentSessionId]: {
          id: parentSessionId,
          version: 2,
          entries: [assistant('old-1', parentSessionId, 'done', 'old snapshot')],
          subAgents: [
            {
              id: 'child-1',
              sessionId: 'child-1',
              parentSessionId,
              name: 'LiveChild',
              modelId: 'gpt-5.6',
              status: 'completed',
            },
          ],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Set live in-memory entries (e.g. active stream)
      useMessageStore.getState().replaceSessionEntries(parentSessionId, [
        assistant('live-1', parentSessionId, 'streaming', 'live text chunk'),
      ])

      await ensureSessionLoaded(parentSessionId)

      // Live messages in memory must NOT be overwritten by old snapshot
      const currentEntries = useMessageStore.getState().entriesBySession[parentSessionId]
      expect(currentEntries).toHaveLength(1)
      expect(currentEntries[0].id).toBe('live-1')

      // But subagents from disk must be loaded
      expect(useSubAgentStore.getState().agents).toHaveLength(1)
      expect(useSubAgentStore.getState().agents[0].name).toBe('LiveChild')

      setHostBridge(null)
    })

    it('sanitizeSubAgents properly cleans up invalid fields and timestamps while preserving running and queued statuses', () => {
      const dirtyAgents = [
        {
          id: 'ag-1',
          sessionId: 'ag-1',
          name: 'Valid',
          parentSessionId: 'p-1',
          modelId: 'm-1',
          status: 'running' as const,
          color: '#123456',
          icon: 'unknown_icon' as any,
          reasoningEffort: 'off' as any,
        },
        {
          id: 'ag-ultra',
          sessionId: 'ag-ultra',
          name: 'Ultra',
          parentSessionId: 'p-1',
          modelId: 'm-ultra',
          status: 'queued' as const,
          icon: 'atom' as const,
          reasoningEffort: 'ultra' as any,
        },
        {
          id: 'ag-invalid-status',
          sessionId: 'ag-invalid-status',
          name: 'InvalidStatus',
          parentSessionId: 'p-1',
          status: 'weird_status' as any,
        },
        {
          // missing id - should be dropped
          sessionId: 'ag-2',
          name: 'Invalid',
        } as any,
      ]

      const sanitized = sanitizeSubAgents(dirtyAgents)
      expect(sanitized).toHaveLength(3)
      expect(sanitized[0].id).toBe('ag-1')
      expect(sanitized[0].status).toBe('running') // running preserved
      expect(sanitized[0].icon).toBe('sparkle') // fallback icon
      expect(sanitized[0].reasoningEffort).toBe('off') // preserved off effort
      expect(sanitized[0].createdAt).toBe(0) // default timestamp

      expect(sanitized[1].id).toBe('ag-ultra')
      expect(sanitized[1].status).toBe('queued') // queued preserved
      expect(sanitized[1].reasoningEffort).toBe('ultra') // preserved ultra effort

      expect(sanitized[2].id).toBe('ag-invalid-status')
      expect(sanitized[2].status).toBe('aborted') // invalid status coerced to aborted
    })

    it('mergeHostAgents preserves subagents from other parent sessions', () => {
      const agentA = {
        id: 'child-a',
        sessionId: 'child-a',
        parentSessionId: 'parent-a',
        name: 'Agent A',
        modelId: 'gpt-5.6',
        status: 'completed' as const,
        color: '#9b7dff',
        icon: 'sparkle' as const,
        createdAt: 1,
        updatedAt: 1,
      }
      const agentB = {
        id: 'child-b',
        sessionId: 'child-b',
        parentSessionId: 'parent-b',
        name: 'Agent B',
        modelId: 'gpt-5.6',
        status: 'completed' as const,
        color: '#3dd68c',
        icon: 'atom' as const,
        createdAt: 2,
        updatedAt: 2,
      }

      useSubAgentStore.setState({ agents: [agentA, agentB] })

      // Host for parent A emits updated agentA only
      const updatedAgentA = { ...agentA, lastMessage: 'Updated message' }
      useSubAgentStore.getState().mergeHostAgents([updatedAgentA])

      // Both agentA (updated) and agentB (retained) must be present
      const storeAgents = useSubAgentStore.getState().agents
      expect(storeAgents).toHaveLength(2)
      expect(storeAgents.find((a) => a.id === 'child-a')?.lastMessage).toBe('Updated message')
      expect(storeAgents.find((a) => a.id === 'child-b')?.name).toBe('Agent B')
    })

    it('migrates legacy app-data subagents to unvisited parent sessions without wiping entries', async () => {
      const savedSessions: Record<string, unknown> = {
        'unvisited-legacy-parent': {
          id: 'unvisited-legacy-parent',
          version: 2,
          entries: [
            assistant('u1', 'unvisited-legacy-parent', 'done', 'original entries'),
          ],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async (id: string) => {
          delete savedSessions[id]
        }),
        SessionList: vi.fn(async () => Object.keys(savedSessions)),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const legacySubAgent = {
        id: 'legacy-child-1',
        sessionId: 'legacy-child-1',
        parentSessionId: 'unvisited-legacy-parent',
        name: 'LegacyWorker',
        modelId: 'gpt-5.6',
        status: 'running' as const, // Should be sanitized to aborted
        color: '#9b7dff',
        icon: 'sparkle' as const,
        createdAt: 10,
        updatedAt: 20,
      }

      // applyPersistedState with legacy subAgents in app-state
      applyPersistedState({
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [],
        sessions: [
          { id: 'unvisited-legacy-parent', title: 'Legacy Parent', pinned: false, createdAt: 1, updatedAt: 1 },
        ],
        messagesBySession: {},
        currentSessionId: null,
        collapsedGroups: {},
        subAgents: [legacySubAgent],
      })

      // Store should have merged and sanitized the subagent
      expect(useSubAgentStore.getState().agents).toHaveLength(1)
      expect(useSubAgentStore.getState().agents[0].status).toBe('aborted')

      // Trigger persist write
      await savePersistedState(serializeAppState())

      // unvisited-legacy-parent session file should now have entries preserved AND subAgents updated
      const updatedFile = savedSessions['unvisited-legacy-parent'] as any
      expect(updatedFile).toBeDefined()
      expect(updatedFile.entries).toHaveLength(1)
      expect(updatedFile.entries[0].id).toBe('u1')
      expect(updatedFile.subAgents).toHaveLength(1)
      expect(updatedFile.subAgents[0].name).toBe('LegacyWorker')

      setHostBridge(null)
    })

    it('ensureSessionLoaded protects entries appended during loadSessionData await', async () => {
      const parentSessionId = 'race-parent-sess'
      let resolveSessionGet: (data: unknown) => void
      const getPromise = new Promise((resolve) => {
        resolveSessionGet = resolve
      })

      const mockBridge = {
        SessionGet: vi.fn(async () => getPromise),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Start loading
      const ensurePromise = ensureSessionLoaded(parentSessionId)

      // In flight, user sends a message
      useMessageStore.getState().appendEntry(assistant('live-append', parentSessionId, 'streaming', 'user chunk'))

      // Now resolve the disk read with old snapshot
      resolveSessionGet!({
        id: parentSessionId,
        version: 2,
        entries: [assistant('disk-old', parentSessionId, 'done', 'old data')],
        subAgents: [
          {
            id: 'child-race',
            sessionId: 'child-race',
            parentSessionId,
            name: 'RaceChild',
            modelId: 'gpt-5.6',
            status: 'completed',
          },
        ],
      })

      await ensurePromise

      // Live message must NOT be replaced
      const entries = useMessageStore.getState().entriesBySession[parentSessionId]
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('live-append')

      // Subagent must be loaded
      expect(useSubAgentStore.getState().agents).toHaveLength(1)
      expect(useSubAgentStore.getState().agents[0].name).toBe('RaceChild')

      setHostBridge(null)
    })

    it('ensureSessionLoaded preserves live spawned subagents while merging missing disk subagents', async () => {
      const parentSessionId = 'live-spawn-parent'
      const savedSessions: Record<string, unknown> = {
        [parentSessionId]: {
          id: parentSessionId,
          version: 2,
          entries: [assistant('m1', parentSessionId, 'done', 'hello')],
          subAgents: [
            {
              id: 'disk-sub-1',
              sessionId: 'disk-sub-1',
              parentSessionId,
              name: 'DiskSub',
              modelId: 'gpt-5.6',
              status: 'completed',
            },
          ],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Live newly spawned subagent in store before ensureSessionLoaded resolves
      useSubAgentStore.setState({
        agents: [
          {
            id: 'live-sub-1',
            sessionId: 'live-sub-1',
            parentSessionId,
            name: 'LiveSub',
            modelId: 'gpt-5.6',
            status: 'running',
            color: '#9b7dff',
            icon: 'sparkle',
            createdAt: 50,
            updatedAt: 50,
          },
        ],
      })

      await ensureSessionLoaded(parentSessionId)

      const storeAgents = useSubAgentStore.getState().agents
      expect(storeAgents).toHaveLength(2)
      expect(storeAgents.find((a) => a.id === 'live-sub-1')?.name).toBe('LiveSub')
      expect(storeAgents.find((a) => a.id === 'disk-sub-1')?.name).toBe('DiskSub')

      setHostBridge(null)
    })

    it('savePersistedState saves settings.json with stripped projects and cachedModels, and saves them to separate keys', async () => {
      const savedKvStore: Record<string, any> = {}
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async (k: string, val: unknown) => {
          savedKvStore[k] = val
        }),
      }
      setHostBridge(mockBridge as any)

      const testProject = {
        id: 'p-1',
        name: 'Project 1',
        path: '/test/path',
        pinned: true,
        createdAt: 100,
        updatedAt: 200,
      }
      const testModel = {
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
      }

      useProjectStore.setState({ projects: [testProject] })
      useSessionStore.setState({ sessions: [], currentSessionId: null })

      const snapshot = serializeAppState()
      snapshot.cachedModels = [testModel as any]
      await savePersistedState(snapshot)

      // projects, cachedModels, shortcuts, and ui should be saved to separate keys
      expect(savedKvStore['projects']).toEqual([testProject])
      expect(savedKvStore['cachedModels']).toEqual([testModel])
      expect(Array.isArray(savedKvStore['shortcuts'])).toBe(true)
      expect(savedKvStore['ui']).toBeDefined()
      expect(savedKvStore['ui'].theme).toBeDefined()

      // In app-state (settings.json), sessions, projects, cachedModels, subAgents, and UI settings should be stripped
      expect(savedKvStore['app-state']).not.toBeNull()
      expect(savedKvStore['app-state'].sessions).toEqual([])
      expect(savedKvStore['app-state'].projects).toBeUndefined()
      expect(savedKvStore['app-state'].cachedModels).toBeUndefined()
      expect(savedKvStore['app-state'].subAgents).toBeUndefined()
      expect(savedKvStore['app-state'].sidebarWidth).toBeUndefined()
      expect(savedKvStore['app-state'].settings.theme).toBeUndefined()

      setHostBridge(null)
    })

    it('loadPersistedState loads projects, cachedModels, and shortcuts from separate keys', async () => {
      const testProject = {
        id: 'p-separate',
        name: 'Separate Project',
        path: '/test/sep',
        pinned: false,
        createdAt: 100,
        updatedAt: 200,
      }
      const testModel = {
        id: 'claude-3-5-sonnet',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
      }
      const testShortcuts = [
        {
          id: 'new-chat',
          shortcuts: [
            { ctrl: false, alt: false, shift: false, meta: true, key: 'N' },
            { ctrl: true, alt: false, shift: false, meta: false, key: 'N' },
          ],
        },
      ]

      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async (key: string) => {
          if (key === 'app-state') {
            return {
              version: 2,
              settings: { ...DEFAULT_SETTINGS },
              projects: [],
              sessions: [],
              messagesBySession: {},
              currentSessionId: null,
              collapsedGroups: {},
            }
          }
          if (key === 'projects') {
            return [testProject]
          }
          if (key === 'cachedModels') {
            return [testModel]
          }
          if (key === 'shortcuts') {
            return testShortcuts
          }
          if (key === 'ui') {
            return {
              theme: 'light',
              accentColor: '#123456',
              sidebarWidth: 350,
              showBottomPanel: true,
            }
          }
          return null
        }),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(loaded?.projects).toEqual([testProject])
      expect(loaded?.cachedModels).toEqual([testModel])
      expect(loaded?.settings.shortcuts?.['new-chat']).toEqual([
        { ctrl: false, alt: false, shift: false, meta: true, key: 'N' },
        { ctrl: true, alt: false, shift: false, meta: false, key: 'N' },
      ])
      expect(loaded?.settings.theme).toBe('light')
      expect(loaded?.settings.accentColor).toBe('#123456')
      expect(loaded?.sidebarWidth).toBe(350)
      expect(loaded?.settings.showBottomPanel).toBe(true)

      setHostBridge(null)
    })

    it('savePersistedState saves app-data.json with empty sessions array without calling SessionSetMeta', async () => {
      let savedKvState: any = null
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async (_k: string, val: unknown) => {
          savedKvState = val
        }),
      }
      setHostBridge(mockBridge as any)

      const session1 = {
        id: 's-1',
        title: 'Session One',
        projectId: 'p-1',
        branch: 'main',
        pinned: true,
        createdAt: 100,
        updatedAt: 200,
      }
      const session2 = {
        id: 's-2',
        title: 'Session Two',
        pinned: false,
        createdAt: 300,
        updatedAt: 400,
      }

      useSessionStore.setState({
        sessions: [session1, session2],
        currentSessionId: 's-1',
      })

      const snapshot = serializeAppState()
      await savePersistedState(snapshot)

      // In app-data.json (KVStore), sessions must be empty array and messagesBySession empty
      expect(savedKvState).not.toBeNull()
      expect(savedKvState.sessions).toEqual([])
      expect(savedKvState.messagesBySession).toEqual({})
      expect(savedKvState.subAgents).toBeUndefined()

      // SessionSetMeta should NOT be called during global persist
      expect(mockBridge.SessionSetMeta).not.toHaveBeenCalled()

      setHostBridge(null)
    })

    it('loadPersistedState populates sessions directly from SessionListSessions', async () => {
      const sqliteSessions = [
        {
          id: 'sqlite-s1',
          title: 'SQLite Session 1',
          projectId: 'p-1',
          branch: 'dev',
          pinned: true,
          createdAt: 100,
          updatedAt: 200,
        },
        {
          id: 'sqlite-s2',
          title: 'SQLite Session 2',
          pinned: false,
          createdAt: 300,
          updatedAt: 400,
        },
      ]

      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['sqlite-s1', 'sqlite-s2']),
        SessionListSessions: vi.fn(async () => sqliteSessions),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => ({
          version: 2,
          settings: { ...DEFAULT_SETTINGS },
          projects: [],
          sessions: [], // stripped in app-data.json
          messagesBySession: {},
          currentSessionId: 'sqlite-s1',
          collapsedGroups: {},
        })),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(loaded?.sessions).toEqual(sqliteSessions)
      expect(loaded?.currentSessionId).toBe('sqlite-s1')

      setHostBridge(null)
    })

    it('loadPersistedState does not migrate legacy sessions from settings.json / app-data.json to SQLite via SessionSetMeta when SQLite is empty', async () => {
      const legacySessions = [
        {
          id: 'legacy-s1',
          title: 'Legacy Session 1',
          pinned: false,
          createdAt: 100,
          updatedAt: 200,
        },
      ]
      const sqliteStore = new Map<string, any>()

      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => Array.from(sqliteStore.keys())),
        SessionListSessions: vi.fn(async () => Array.from(sqliteStore.values())),
        SessionSetMeta: vi.fn(async (meta: any) => {
          sqliteStore.set(meta.id, {
            ...meta,
            unread: meta.unread === true ? true : undefined,
          })
        }),
        KVStoreGet: vi.fn(async () => ({
          version: 2,
          settings: { ...DEFAULT_SETTINGS },
          projects: [],
          sessions: legacySessions,
          messagesBySession: {},
          currentSessionId: 'legacy-s1',
          collapsedGroups: {},
        })),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(loaded?.sessions).toEqual([])
      expect(mockBridge.SessionSetMeta).not.toHaveBeenCalled()

      setHostBridge(null)
    })

    it('loadPersistedState uses authoritative SQLite sessions and ignores legacy metadata in settings.json', async () => {
      const legacySessions = [
        {
          id: 's-1',
          title: 'Customized Title From App Data',
          pinned: true,
          branch: 'feat/legacy-branch',
          createdAt: 100,
          updatedAt: 300,
        },
      ]

      const sqliteStore = new Map<string, any>([
        [
          's-1',
          {
            id: 's-1',
            title: 'Initial DB Title',
            pinned: false,
            createdAt: 100,
            updatedAt: 200,
          },
        ],
        [
          's-2',
          {
            id: 's-2',
            title: 'Session Two In SQLite',
            pinned: false,
            createdAt: 200,
            updatedAt: 250,
          },
        ],
      ])

      const callOrder: string[] = []

      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => Array.from(sqliteStore.keys())),
        SessionListSessions: vi.fn(async () => {
          callOrder.push('SessionListSessions')
          return Array.from(sqliteStore.values())
        }),
        SessionSetMeta: vi.fn(async (meta: any) => {
          callOrder.push(`SessionSetMeta:${meta.id}`)
          const existing = sqliteStore.get(meta.id) ?? {}
          sqliteStore.set(meta.id, {
            ...existing,
            ...meta,
            unread: meta.unread === true ? true : undefined,
          })
        }),
        KVStoreGet: vi.fn(async () => ({
          version: 2,
          settings: { ...DEFAULT_SETTINGS },
          projects: [],
          sessions: legacySessions,
          messagesBySession: {},
          currentSessionId: 's-1',
          collapsedGroups: {},
        })),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      // SessionSetMeta should NOT be called
      expect(mockBridge.SessionSetMeta).not.toHaveBeenCalled()
      // SQLite store retains its original data without overwrite
      expect(sqliteStore.get('s-1')).toEqual(
        expect.objectContaining({
          id: 's-1',
          title: 'Initial DB Title',
          pinned: false,
        }),
      )
      // Authoritative list returned from SQLite
      expect(loaded?.sessions).toHaveLength(2)
      expect(loaded?.sessions.find((s) => s.id === 's-1')?.title).toBe('Initial DB Title')

      setHostBridge(null)
    })

    it('preserves and loads cliProxyApi settings when app-state in KVStore lacks projects array', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async (key: string) => {
          if (key === 'app-state') {
            return {
              version: 2,
              settings: {
                ...DEFAULT_SETTINGS,
                cliProxyApi: {
                  baseUrl: 'http://127.0.0.1:8317',
                  apiKey: 'sk-persisted-secret-key',
                },
              },
            }
          }
          if (key === 'projects') return []
          return null
        }),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(loaded?.settings.cliProxyApi).toEqual({
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'sk-persisted-secret-key',
      })

      setHostBridge(null)
    })

    it('loads desktop cliProxyApi through browser host KV store without Electron native runtime', async () => {
      const originalWebSocket = globalThis.WebSocket
      class MockWebSocket {
        static OPEN = 1
        readyState = 1
        send = vi.fn()
        close = vi.fn()
        addEventListener = vi.fn()
        removeEventListener = vi.fn()
      }
      globalThis.WebSocket = MockWebSocket as any

      setHostBridge(null)
      __setCachedBrowserClientForTests(null)
      expect(isNativeRuntime()).toBe(false)

      const client = new BrowserBridgeClient()
      client.invoke = vi.fn(async (_handle: string, method: string, args?: unknown[]) => {
        if (method === 'kvstore:get') {
          const key = Array.isArray(args) ? args[0] : undefined
          if (key === 'app-state') {
            return {
              version: 2,
              settings: {
                ...DEFAULT_SETTINGS,
                cliProxyApi: {
                  baseUrl: 'http://127.0.0.1:8317',
                  apiKey: 'sk-browser-reuse-key',
                },
              },
              sessions: [],
              messagesBySession: {},
              currentSessionId: null,
              collapsedGroups: {},
            }
          }
          if (key === 'projects') return []
          return null
        }
        if (method === 'session:listSessions') return []
        return undefined
      }) as typeof client.invoke

      __setCachedBrowserClientForTests(client)
      expect(isNativeRuntime()).toBe(false)
      expect(canUseHostKvStore()).toBe(true)

      const loaded = await loadPersistedState()
      expect(loaded?.settings.cliProxyApi).toEqual({
        baseUrl: 'http://127.0.0.1:8317',
        apiKey: 'sk-browser-reuse-key',
      })

      __setCachedBrowserClientForTests(null)
      client.dispose()
      globalThis.WebSocket = originalWebSocket
    })

    it('loadPersistedState loads sessions from SQLite when settings.json / app-data.json data is null or empty', async () => {
      const sqliteSessions = [
        {
          id: 'fresh-db-s1',
          title: 'Fresh DB Session',
          pinned: false,
          createdAt: 500,
          updatedAt: 600,
        },
      ]

      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['fresh-db-s1']),
        SessionListSessions: vi.fn(async () => sqliteSessions),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null), // settings.json is missing/empty
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(loaded?.sessions).toEqual(sqliteSessions)
      expect(loaded?.currentSessionId).toBe('fresh-db-s1')

      setHostBridge(null)
    })

    it('persists and loads unread session state via SessionSetMeta and SessionListSessions', async () => {
      const syncedMeta: any[] = []
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['unread-s1']),
        SessionListSessions: vi.fn<() => Promise<any[]>>(async () => [
          {
            id: 'unread-s1',
            title: 'Unread Chat',
            pinned: false,
            unread: true,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ]),
        SessionSetMeta: vi.fn(async (meta: unknown) => {
          syncedMeta.push(meta)
        }),
        KVStoreGet: vi.fn(async () => ({
          version: 2,
          settings: { ...DEFAULT_SETTINGS },
          projects: [],
          sessions: [],
          messagesBySession: {},
          currentSessionId: 'unread-s1',
          collapsedGroups: {},
        })),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          {
            id: 'unread-s1',
            title: 'Unread Chat',
            pinned: false,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        currentSessionId: 'unread-s1',
      })

      // Mark unread triggers SessionService.update -> SessionSetMeta({ id: 'unread-s1', unread: true })
      await getHostServices().sessions.update('unread-s1', { unread: true })

      expect(mockBridge.SessionSetMeta).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'unread-s1',
          unread: true,
        }),
      )

      const loaded = await loadPersistedState()
      expect(loaded?.sessions[0].unread).toBe(true)

      // Mark read and verify SessionSetMeta called with unread: false
      mockBridge.SessionListSessions.mockResolvedValueOnce([
        {
          id: 'unread-s1',
          title: 'Unread Chat',
          pinned: false,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ])

      await getHostServices().sessions.update('unread-s1', { unread: false })

      expect(mockBridge.SessionSetMeta).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 'unread-s1',
          unread: false,
        }),
      )

      const loadedAfterRead = await loadPersistedState()
      expect(loadedAfterRead?.sessions[0].unread).toBeUndefined()

      setHostBridge(null)
    })

    it('reloadSessionFromDisk replaces session entries in messageStore even if session was already loaded', async () => {
      const diskEntries = [
        assistant('m-disk-1', 's-reload', 'done', 'fresh text from disk'),
      ]
      const diskSubAgents = [
        {
          id: 'sub-disk-1',
          sessionId: 'sub-disk-1',
          parentSessionId: 's-reload',
          name: 'FreshSub',
          modelId: 'gpt-5.6',
          status: 'completed' as const,
        },
      ]

      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => {
          if (id === 's-reload') {
            return {
              id: 's-reload',
              version: 2,
              entries: diskEntries,
              subAgents: diskSubAgents,
            }
          }
          return null
        }),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s-reload']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Pre-populate messageStore with stale entries
      useMessageStore.getState().replaceSessionEntries('s-reload', [
        assistant('m-stale-1', 's-reload', 'done', 'stale text'),
      ])
      // Ensure session is marked as already loaded
      await ensureSessionLoaded('s-reload')
      expect(useMessageStore.getState().entriesBySession['s-reload'][0].id).toBe('m-stale-1')

      // Call reloadSessionFromDisk
      const result = await reloadSessionFromDisk('s-reload')

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('m-disk-1')

      // Message store entries must be replaced with fresh disk entries
      const currentEntries = useMessageStore.getState().entriesBySession['s-reload']
      expect(currentEntries).toHaveLength(1)
      expect(currentEntries[0].id).toBe('m-disk-1')

      // Subagent store must have subagent merged
      const agents = useSubAgentStore.getState().agents
      expect(agents.some((a) => a.id === 'sub-disk-1')).toBe(true)

      setHostBridge(null)
    })

    it('removeRemoteSession cleans local cache without calling SessionDelete on bridge', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          { id: 'sess-remote-del', title: 'Remote Del', pinned: false, createdAt: 1, updatedAt: 1 },
        ],
        currentSessionId: 'sess-remote-del',
      })

      useMessageStore.getState().replaceSessionEntries('sess-remote-del', [
        assistant('m1', 'sess-remote-del', 'done', 'hello'),
      ])

      useSubAgentStore.setState({
        agents: [
          {
            id: 'child-remote-1',
            sessionId: 'child-remote-1',
            parentSessionId: 'sess-remote-del',
            name: 'Child',
            modelId: 'gpt-4o',
            status: 'completed',
            color: '#9b7dff',
            icon: 'sparkle',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      })

      bindPersistence()

      // Call removeRemoteSession
      useSessionStore.getState().removeRemoteSession('sess-remote-del')

      // Flush microtasks for store subscriber
      await Promise.resolve()
      await Promise.resolve()

      // SessionDelete must NOT be called on bridge
      expect(mockBridge.SessionDelete).not.toHaveBeenCalled()

      // Local memory / cache must be cleaned
      expect(useSessionStore.getState().sessions).toHaveLength(0)
      expect(useMessageStore.getState().entriesBySession['sess-remote-del']).toBeUndefined()
      expect(useSubAgentStore.getState().agents).toHaveLength(0)

      // Directly invoking deleteSessionLocalCache should also be safe and idempotent
      deleteSessionLocalCache('sess-remote-del')
      expect(mockBridge.SessionDelete).not.toHaveBeenCalled()

      setHostBridge(null)
    })

    it('loadPersistedState does not sync legacy metadata from settings.json with explicit unread boolean', async () => {
      const syncedMeta: any[] = []
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['legacy-s1', 'legacy-s2']),
        SessionListSessions: vi.fn(async () => [
          {
            id: 'legacy-s1',
            title: 'Legacy S1',
            pinned: false,
            createdAt: 100,
            updatedAt: 200,
          },
          {
            id: 'legacy-s2',
            title: 'Legacy S2',
            pinned: true,
            unread: true,
            createdAt: 300,
            updatedAt: 400,
          },
        ]),
        SessionSetMeta: vi.fn(async (meta: any) => {
          if (meta.id === 'legacy-fail') {
            throw new Error('Individual meta sync failure')
          }
          syncedMeta.push(meta)
        }),
        KVStoreGet: vi.fn(async () => ({
          version: 2,
          settings: { ...DEFAULT_SETTINGS },
          projects: [],
          sessions: [
            {
              id: 'legacy-s1',
              title: 'Legacy S1',
              pinned: false,
              createdAt: 100,
              updatedAt: 200,
            },
            {
              id: 'legacy-fail',
              title: 'Legacy Fail',
              pinned: false,
              createdAt: 200,
              updatedAt: 250,
            },
            {
              id: 'legacy-s2',
              title: 'Legacy S2',
              pinned: true,
              unread: true,
              createdAt: 300,
              updatedAt: 400,
            },
          ],
          messagesBySession: {},
          currentSessionId: 'legacy-s1',
          collapsedGroups: {},
        })),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const loaded = await loadPersistedState()
      expect(loaded).not.toBeNull()
      expect(mockBridge.SessionSetMeta).not.toHaveBeenCalled()
      expect(loaded?.sessions).toHaveLength(2)
      expect(loaded?.sessions[0].id).toBe('legacy-s1')
      expect(loaded?.sessions[1].id).toBe('legacy-s2')

      setHostBridge(null)
    })

    it('reloadSessionFromDisk suppresses persistence and does not trigger SessionSet echo loop', async () => {
      __resetPersistenceForTests()
      const savedSessions: Record<string, unknown> = {
        's-echo': {
          id: 's-echo',
          version: 2,
          entries: [assistant('m-disk', 's-echo', 'done', 'disk content')],
          subAgents: [
            {
              id: 'sub-echo-1',
              sessionId: 'sub-echo-1',
              parentSessionId: 's-echo',
              name: 'DiskSub',
              modelId: 'gpt-5.6',
              status: 'completed',
              color: '#9b7dff',
              icon: 'sparkle',
              createdAt: 10,
              updatedAt: 20,
            },
          ],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: vi.fn(async (id: string, data: unknown) => {
          savedSessions[id] = data
        }),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s-echo']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      bindPersistence()

      // Initial entries in message store
      useMessageStore.getState().replaceSessionEntries('s-echo', [
        assistant('m-init', 's-echo', 'done', 'initial content'),
      ])

      // Flush debounce timer from initial setup
      await flushPendingPersistence()
      mockBridge.SessionSet.mockClear()

      // Reload from disk
      await reloadSessionFromDisk('s-echo')

      // Wait past debounce time
      await new Promise((resolve) => setTimeout(resolve, 500))

      // SessionSet must NOT have been called due to reloadDepth suppression
      expect(mockBridge.SessionSet).not.toHaveBeenCalled()

      setHostBridge(null)
    })

    it('invalidateSessionDiskCache allows ensureSessionLoaded to fetch fresh data from disk', async () => {
      let fetchCount = 0
      const savedSessions: Record<string, unknown> = {
        s1: {
          id: 's1',
          version: 2,
          entries: [assistant('m1', 's1', 'done', 'first disk read')],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => {
          fetchCount += 1
          return savedSessions[id] ?? null
        }),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s1']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // 1. Call ensureSessionLoaded('s1') when disk has msg-1 (memory now has msg-1).
      const first = await ensureSessionLoaded('s1')
      expect(first).toHaveLength(1)
      expect(first[0].id).toBe('m1')
      expect(useMessageStore.getState().getEntries('s1')[0].id).toBe('m1')
      expect(fetchCount).toBe(1)

      // Calling ensureSessionLoaded again while cached does not re-fetch
      await ensureSessionLoaded('s1')
      expect(fetchCount).toBe(1)

      // 2. Invalidate cache with invalidateSessionDiskCache('s1').
      invalidateSessionDiskCache('s1')

      // 3. Update disk mock to return msg-2.
      savedSessions['s1'] = {
        id: 's1',
        version: 2,
        entries: [assistant('m2', 's1', 'done', 'fresh disk read')],
      }

      // 4. Call ensureSessionLoaded('s1') again.
      const second = await ensureSessionLoaded('s1')

      // 5. Assert that ensureSessionLoaded('s1') returns msg-2 and useMessageStore.getState().getEntries('s1') has msg-2.
      expect(fetchCount).toBe(2)
      expect(second).toHaveLength(1)
      expect(second[0].id).toBe('m2')
      const freshEntries = useMessageStore.getState().getEntries('s1')
      expect(freshEntries).toHaveLength(1)
      expect(freshEntries[0].id).toBe('m2')

      setHostBridge(null)
    })

    it('ensureSessionLoaded guards against stale disk overwrite while session is running', async () => {
      let fetchCount = 0
      const savedSessions: Record<string, unknown> = {
        's-running': {
          id: 's-running',
          version: 2,
          entries: [{ ...assistant('m-disk', 's-running', 'done', 'old disk version'), createdAt: 10 }],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => {
          fetchCount += 1
          return savedSessions[id] ?? null
        }),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s-running']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Put live in-memory entry
      useMessageStore
        .getState()
        .replaceSessionEntries('s-running', [
          { ...assistant('m-live', 's-running', 'done', 'live in-memory message'), createdAt: 20 },
        ])

      // Mark session as actively running
      useSessionRunStore.getState().setRun('s-running', {
        sessionId: 's-running',
        runId: 'run-1',
        status: 'running',
        clientId: 'c1',
        updatedAt: Date.now(),
      })

      // Invalidate disk cache
      invalidateSessionDiskCache('s-running')

      // Call ensureSessionLoaded while running — merges disk entries while preserving live entry
      const runningEntries = await ensureSessionLoaded('s-running')
      expect(fetchCount).toBe(1)
      expect(runningEntries).toHaveLength(2)
      expect(runningEntries.map((e) => e.id)).toEqual(['m-disk', 'm-live'])
      expect(useMessageStore.getState().getEntries('s-running').map((e) => e.id)).toEqual(['m-disk', 'm-live'])

      // Now session becomes idle
      useSessionRunStore.getState().clearRun('s-running')

      // Call ensureSessionLoaded when idle — returns cached merged entries
      const idleEntries = await ensureSessionLoaded('s-running')
      expect(fetchCount).toBe(1)
      expect(idleEntries).toHaveLength(2)
      expect(idleEntries.map((e) => e.id)).toEqual(['m-disk', 'm-live'])

      setHostBridge(null)
    })

    it('markRemoteSessionDeleted prevents SessionDelete when session is removed from store', async () => {
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          { id: 'sess-marked', title: 'Marked Session', pinned: false, createdAt: 1, updatedAt: 1 },
        ],
        currentSessionId: 'sess-marked',
      })

      bindPersistence()

      // Mark session as remotely deleted
      markRemoteSessionDeleted('sess-marked')

      // Remove from sessionStore
      useSessionStore.setState({
        sessions: [],
        currentSessionId: null,
      })

      await Promise.resolve()
      await Promise.resolve()

      // SessionDelete must NOT have been called on bridge
      expect(mockBridge.SessionDelete).not.toHaveBeenCalled()

      setHostBridge(null)
    })

    it('withSuppressedPersistence suppresses project, message, and subagent store persistence callbacks', async () => {
      const writeSpy = vi.fn(async () => {})
      bindPersistence({ write: writeSpy, debounceMs: 10 })

      withSuppressedPersistence(() => {
        useProjectStore.getState().hydrate([
          {
            id: 'project-suppressed',
            name: 'Remote Project',
            path: '/workspace/remote-project',
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
          },
        ])
        useMessageStore.getState().appendEntry(assistant('m-suppressed', 's-test', 'done', 'hello'))
      })

      await new Promise((r) => setTimeout(r, 50))
      expect(writeSpy).not.toHaveBeenCalled()
    })

    it('hydrateEmptySessionFromDisk preserves live stream entry appended during await and prepends missing disk history', async () => {
      let resolveSessionGet!: (value: unknown) => void
      const sessionGetPromise = new Promise((resolve) => {
        resolveSessionGet = resolve
      })

      const diskPayload = {
        id: 's-race',
        version: 2,
        entries: [
          {
            id: 'u-disk-1',
            sessionId: 's-race',
            kind: 'user',
            version: 1,
            createdAt: 10,
            content: [{ type: 'text', text: 'Disk user prompt' }],
          },
        ],
      }

      const mockBridge = {
        SessionGet: vi.fn(async () => {
          await sessionGetPromise
          return diskPayload
        }),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s-race']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      // Initial in-memory state is empty
      useMessageStore.setState({ entriesBySession: { 's-race': [] } })

      // Start hydration (stays in-flight waiting for SessionGet)
      const hydratePromise = hydrateEmptySessionFromDisk('s-race')

      // Live streaming assistant entry arrives while hydration is in flight
      const liveEntry = {
        ...assistant('a-live-1', 's-race', 'streaming', 'Streaming token response...'),
        createdAt: 20,
      }
      useMessageStore.getState().appendEntry(liveEntry)

      // Resolve disk read
      resolveSessionGet(diskPayload)
      const finalEntries = await hydratePromise

      // Live entry preserved, disk entry prepended before it
      expect(finalEntries).toHaveLength(2)
      expect(finalEntries[0]?.id).toBe('u-disk-1')
      expect(finalEntries[1]?.id).toBe('a-live-1')
      expect((finalEntries[1] as AssistantEntry).content[0]).toMatchObject({
        type: 'text',
        text: 'Streaming token response...',
      })

      const storeEntries = useMessageStore.getState().getEntries('s-race')
      expect(storeEntries).toHaveLength(2)
      expect(storeEntries[0]?.id).toBe('u-disk-1')
      expect(storeEntries[1]?.id).toBe('a-live-1')

      setHostBridge(null)
    })

    it('ensureSessionLoaded on a running session with empty memory loads disk entries safely', async () => {
      const diskPayload = {
        id: 's-running-init',
        version: 2,
        entries: [
          {
            id: 'u-init-prompt',
            sessionId: 's-running-init',
            kind: 'user',
            version: 1,
            createdAt: 100,
            content: [{ type: 'text', text: 'Initial prompt from disk' }],
          },
        ],
      }

      const mockBridge = {
        SessionGet: vi.fn(async () => diskPayload),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => ['s-running-init']),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          { id: 's-running-init', title: 'Running Session', pinned: false, createdAt: 100, updatedAt: 100 },
        ],
        currentSessionId: 's-running-init',
      })

      // Mark session as running
      useSessionRunStore.getState().setRun('s-running-init', {
        sessionId: 's-running-init',
        runId: 'run-running-1',
        status: 'running',
        clientId: 'client-runner',
        updatedAt: Date.now(),
      })

      // In-memory entries empty
      useMessageStore.setState({ entriesBySession: { 's-running-init': [] } })

      const entries = await ensureSessionLoaded('s-running-init')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.id).toBe('u-init-prompt')
      expect(useMessageStore.getState().getEntries('s-running-init')[0]?.id).toBe('u-init-prompt')

      setHostBridge(null)
    })

    it('savePersistedState in browser environment skips saving session data for sessions that are currently running remotely', async () => {
      const originalUa = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 Chrome/120.0 Safari/537.36',
        configurable: true,
      })

      const savedSessions: Record<string, unknown> = {}
      const sessionSetSpy = vi.fn(async (id: string, payload: unknown) => {
        savedSessions[id] = payload
      })

      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
        SessionSet: sessionSetSpy,
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => []),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      const remoteRunningSessionId = 'sess-remote-running'
      const localIdleSessionId = 'sess-local-idle'

      // Set active remote run for sess-remote-running
      useSessionRunStore.getState().setRun(remoteRunningSessionId, {
        sessionId: remoteRunningSessionId,
        runId: 'run-remote-1',
        status: 'running',
        clientId: 'remote-client-1',
        updatedAt: Date.now(),
      })

      const snapshot: PersistedAppState = {
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [],
        sessions: [
          { id: remoteRunningSessionId, title: 'Remote Running', pinned: false, createdAt: 1, updatedAt: 1 },
          { id: localIdleSessionId, title: 'Local Idle', pinned: false, createdAt: 1, updatedAt: 1 },
        ],
        messagesBySession: {
          [remoteRunningSessionId]: [assistant('m-remote', remoteRunningSessionId, 'streaming', 'partial mirror text')],
          [localIdleSessionId]: [assistant('m-idle', localIdleSessionId, 'done', 'completed text')],
        },
        currentSessionId: remoteRunningSessionId,
        collapsedGroups: {},
      }

      await savePersistedState(snapshot)

      // sessionSetSpy must NOT be called for remote running session, but MUST be called for local idle session
      const savedIds = sessionSetSpy.mock.calls.map((call) => call[0])
      expect(savedIds).not.toContain(remoteRunningSessionId)
      expect(savedIds).toContain(localIdleSessionId)

      Object.defineProperty(navigator, 'userAgent', {
        value: originalUa,
        configurable: true,
      })
      setHostBridge(null)
    })

    it('ensureSessionLoaded on a running session with existing in-memory user entry merges missing disk assistant entries safely without destroying live streaming entries', async () => {
      const sessionId = 's-running-merge'
      const diskPayload = {
        id: sessionId,
        version: 2,
        entries: [
          {
            id: 'u-disk-hist',
            sessionId,
            kind: 'user',
            version: 1,
            createdAt: 100,
            content: [{ type: 'text', text: 'Historical question from disk' }],
          },
          {
            id: 'a-disk-hist',
            sessionId,
            kind: 'assistant',
            version: 1,
            createdAt: 200,
            content: [{ type: 'text', text: 'Historical answer from disk' }],
            status: 'done',
            stopReason: 'stop',
          },
        ],
      }

      const mockBridge = {
        SessionGet: vi.fn(async () => diskPayload),
        SessionSet: vi.fn(async () => {}),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => [sessionId]),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      useSessionStore.setState({
        sessions: [
          { id: sessionId, title: 'Running Merge Session', pinned: false, createdAt: 100, updatedAt: 100 },
        ],
        currentSessionId: sessionId,
      })

      // Mark session as actively running
      useSessionRunStore.getState().setRun(sessionId, {
        sessionId,
        runId: 'run-merge-1',
        status: 'running',
        clientId: 'client-active',
        updatedAt: Date.now(),
      })

      // Live in-memory entries: new user prompt and active streaming assistant response
      const liveUserEntry = {
        id: 'u-live-new',
        sessionId,
        kind: 'user' as const,
        version: 1 as const,
        createdAt: 300,
        content: [{ type: 'text' as const, text: 'Follow up question' }],
      }
      const liveStreamingAssistant = {
        ...assistant('a-live-streaming', sessionId, 'streaming', 'Streaming follow up answer...'),
        createdAt: 400,
      }
      useMessageStore.setState({
        entriesBySession: {
          [sessionId]: [liveUserEntry, liveStreamingAssistant],
        },
      })

      const entries = await ensureSessionLoaded(sessionId)

      // Merges disk historical entries and keeps live entries in deterministic createdAt order
      expect(entries).toHaveLength(4)
      expect(entries.map((e) => e.id)).toEqual([
        'u-disk-hist',
        'a-disk-hist',
        'u-live-new',
        'a-live-streaming',
      ])

      const storeEntries = useMessageStore.getState().getEntries(sessionId)
      expect(storeEntries).toHaveLength(4)
      expect(storeEntries.map((e) => e.id)).toEqual([
        'u-disk-hist',
        'a-disk-hist',
        'u-live-new',
        'a-live-streaming',
      ])
      // Live streaming entry is preserved intact
      expect((storeEntries[3] as AssistantEntry).status).toBe('streaming')

      setHostBridge(null)
    })

    it('persists and restores failed and ready worktree setups across session hydration', async () => {
      const sessionId = 'wt-persist-session-1'
      const failedSetup = {
        sessionId,
        status: 'error' as const,
        stepWorkspace: 'done' as const,
        stepCheckout: 'done' as const,
        stepEnvironment: 'error' as const,
        worktreePath: '/worktrees/persisted-failed',
        sourceTreePath: '/projects/repo',
        branch: 'codex/fix-something',
        environmentId: 'proj-1',
        environmentName: 'My Project',
        logs: 'Exit code 127: command not found: make',
        exitCode: 127,
        error: 'Exit code 127',
        expandedDetails: true,
      }

      useSessionStore.setState({
        sessions: [
          {
            id: sessionId,
            title: 'Failed Worktree Session',
            pinned: false,
            workLocation: 'worktree',
            worktreePath: '/worktrees/persisted-failed',
            environmentId: 'proj-1',
            worktreeSetup: failedSetup,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        currentSessionId: sessionId,
      })
      useWorktreeSetupStore.setState({
        setups: {
          [sessionId]: failedSetup,
        },
      })

      // 1. Test savePersistedState saves worktreeSetup into payload
      let savedPayload: unknown = null
      const mockBridge = {
        SessionGet: vi.fn(async () => null),
        SessionSet: vi.fn(async (_sid: string, data: unknown) => {
          savedPayload = data
        }),
        SessionDelete: vi.fn(async () => {}),
        SessionList: vi.fn(async () => [sessionId]),
        SessionListSessions: vi.fn(async () => []),
        SessionSetMeta: vi.fn(async () => {}),
        KVStoreGet: vi.fn(async () => null),
        KVStoreSet: vi.fn(async () => {}),
      }
      setHostBridge(mockBridge as any)

      await saveSessionData(sessionId, [])
      expect(savedPayload).toMatchObject({
        id: sessionId,
        workLocation: 'worktree',
        worktreePath: '/worktrees/persisted-failed',
        environmentId: 'proj-1',
        worktreeSetup: failedSetup,
      })

      // 2. Simulate application restart with applyPersistedState
      useWorktreeSetupStore.setState({ setups: {} })
      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toBeUndefined()

      applyPersistedState({
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [],
        sessions: [
          {
            id: sessionId,
            title: 'Failed Worktree Session',
            pinned: false,
            workLocation: 'worktree',
            worktreePath: '/worktrees/persisted-failed',
            environmentId: 'proj-1',
            worktreeSetup: failedSetup,
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        messagesBySession: {},
        currentSessionId: sessionId,
        collapsedGroups: {},
      })

      // Setup state must be fully restored in worktreeSetupStore and remain in failed position
      const restoredSetup = useWorktreeSetupStore.getState().getSetup(sessionId)
      expect(restoredSetup).toBeDefined()
      expect(restoredSetup?.status).toBe('error')
      expect(restoredSetup?.stepEnvironment).toBe('error')
      expect(restoredSetup?.logs).toContain('command not found: make')
      expect(restoredSetup?.exitCode).toBe(127)

      setHostBridge(null)
    })

    it('hydrates a legacy worktree session with sourceTreePath from its project', () => {
      const sessionId = 'legacy-worktree-session'
      applyPersistedState({
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [{
          id: 'project-1',
          name: 'Repo',
          path: '/projects/repo',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        }],
        sessions: [{
          id: sessionId,
          projectId: 'project-1',
          title: 'Legacy worktree',
          pinned: false,
          workLocation: 'worktree',
          worktreePath: '/worktrees/repo-session',
          createdAt: 1,
          updatedAt: 1,
        }],
        messagesBySession: {},
        currentSessionId: sessionId,
        collapsedGroups: {},
      })

      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toMatchObject({
        status: 'ready',
        worktreePath: '/worktrees/repo-session',
        sourceTreePath: '/projects/repo',
      })
    })

    it('hydrates a worktree session whose setup JSON lacks sourceTreePath and synchronizes to session store', () => {
      const sessionId = 'setup-without-source-path'
      applyPersistedState({
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [{
          id: 'project-1',
          name: 'Repo',
          path: '/projects/repo',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        }],
        sessions: [{
          id: sessionId,
          projectId: 'project-1',
          title: 'Worktree with incomplete setup',
          pinned: false,
          workLocation: 'worktree',
          worktreePath: '/worktrees/repo-session',
          worktreeSetup: {
            sessionId,
            status: 'ready',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'done',
            worktreePath: '/worktrees/repo-session',
            logs: '',
            expandedDetails: false,
          },
          createdAt: 1,
          updatedAt: 1,
        }],
        messagesBySession: {},
        currentSessionId: sessionId,
        collapsedGroups: {},
      })

      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toMatchObject({
        status: 'ready',
        worktreePath: '/worktrees/repo-session',
        sourceTreePath: '/projects/repo',
      })
      expect(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.worktreeSetup).toMatchObject({
        status: 'ready',
        worktreePath: '/worktrees/repo-session',
        sourceTreePath: '/projects/repo',
      })
    })

    it('syncs loaded worktree setup missing sourceTreePath and backfills from project', async () => {
      const sessionId = 'loaded-worktree-missing-source'
      const savedSessions: Record<string, unknown> = {
        [sessionId]: {
          version: 2,
          entries: [],
          workLocation: 'worktree',
          worktreePath: '/worktrees/loaded-session',
          worktreeSetup: {
            sessionId,
            status: 'ready',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'done',
            worktreePath: '/worktrees/loaded-session',
            logs: '',
            expandedDetails: false,
          },
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
      }
      setHostBridge(mockBridge as any)

      useProjectStore.setState({
        projects: [{
          id: 'proj-1',
          name: 'Repo',
          path: '/projects/loaded-repo',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        }],
      })
      useSessionStore.setState({
        sessions: [{
          id: sessionId,
          projectId: 'proj-1',
          title: 'Loaded Session',
          pinned: false,
          workLocation: 'worktree',
          worktreePath: '/worktrees/loaded-session',
          createdAt: 1,
          updatedAt: 1,
        }],
        currentSessionId: sessionId,
      })

      const data = await loadSessionData(sessionId)
      expect(data).toBeDefined()
      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toMatchObject({
        status: 'ready',
        worktreePath: '/worktrees/loaded-session',
        sourceTreePath: '/projects/loaded-repo',
      })
      expect(useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.worktreeSetup).toMatchObject({
        status: 'ready',
        worktreePath: '/worktrees/loaded-session',
        sourceTreePath: '/projects/loaded-repo',
      })

      setHostBridge(null)
    })

    it('keeps workLocation as local and does not import setup when persisted local session has stale worktree metadata', () => {
      const sessionId = 'stale-local-session'
      applyPersistedState({
        version: 2,
        settings: { ...DEFAULT_SETTINGS },
        projects: [{
          id: 'project-1',
          name: 'Repo',
          path: '/projects/repo',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        }],
        sessions: [{
          id: sessionId,
          projectId: 'project-1',
          title: 'Local with stale worktree',
          pinned: false,
          workLocation: 'local',
          worktreePath: '/worktrees/stale-worktree',
          worktreeSetup: {
            sessionId,
            status: 'ready',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'done',
            worktreePath: '/worktrees/stale-worktree',
            sourceTreePath: '/projects/repo',
            logs: '',
            expandedDetails: false,
          },
          createdAt: 1,
          updatedAt: 1,
        }],
        messagesBySession: {},
        currentSessionId: sessionId,
        collapsedGroups: {},
      })

      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      expect(session?.workLocation).toBe('local')
      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toBeUndefined()
    })

    it('syncs loaded local session without switching to worktree or repopulating setup store', async () => {
      const sessionId = 'loaded-stale-local-session'
      const savedSessions: Record<string, unknown> = {
        [sessionId]: {
          version: 2,
          entries: [],
          workLocation: 'local',
          worktreePath: '/worktrees/stale-session',
          worktreeSetup: {
            sessionId,
            status: 'ready',
            stepWorkspace: 'done',
            stepCheckout: 'done',
            stepEnvironment: 'done',
            worktreePath: '/worktrees/stale-session',
            sourceTreePath: '/projects/loaded-repo',
            logs: '',
            expandedDetails: false,
          },
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
      }
      setHostBridge(mockBridge as any)

      useProjectStore.setState({
        projects: [{
          id: 'proj-1',
          name: 'Repo',
          path: '/projects/loaded-repo',
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        }],
      })
      useSessionStore.setState({
        sessions: [{
          id: sessionId,
          projectId: 'proj-1',
          title: 'Loaded Stale Local Session',
          pinned: false,
          workLocation: 'local',
          worktreePath: '/worktrees/stale-session',
          createdAt: 1,
          updatedAt: 1,
        }],
        currentSessionId: sessionId,
      })

      const data = await loadSessionData(sessionId)
      expect(data).toBeDefined()
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      expect(session?.workLocation).toBe('local')
      expect(useWorktreeSetupStore.getState().getSetup(sessionId)).toBeUndefined()

      setHostBridge(null)
    })

    it('preserves pausedMs on user and assistant entries across persistence sanitization', async () => {
      const sessionId = 'paused-persist-session'
      const savedSessions: Record<string, unknown> = {
        [sessionId]: {
          session: {
            id: sessionId,
            title: 'Paused Persisted Session',
            createdAt: 1000,
            updatedAt: 1000,
          },
          entries: [
            {
              id: 'u-paused',
              sessionId,
              createdAt: 1000,
              kind: 'user',
              pausedMs: 60000,
              content: [{ type: 'text', text: 'Task' }],
            },
            {
              id: 'a-paused',
              sessionId,
              createdAt: 1000,
              completedAt: 15000,
              kind: 'assistant',
              pausedMs: 60000,
              status: 'done',
              stopReason: 'stop',
              content: [{ type: 'text', text: 'Result' }],
            },
          ],
        },
      }
      const mockBridge = {
        SessionGet: vi.fn(async (id: string) => savedSessions[id] ?? null),
      }
      setHostBridge(mockBridge as any)

      const data = await loadSessionData(sessionId)
      expect(data).toBeDefined()
      const userEntry = data?.entries.find((e) => e.id === 'u-paused')
      const assistantEntry = data?.entries.find((e) => e.id === 'a-paused')
      expect(userEntry?.pausedMs).toBe(60000)
      expect(assistantEntry?.pausedMs).toBe(60000)

      setHostBridge(null)
    })

    it('applyPersistedState preserves historical session updatedAt and does not pollute project workLocation on hydration', () => {
      const originalUpdatedAt = 123456789
      const projectOriginalUpdatedAt = 987654321
      applyPersistedState({
        version: 1,
        settings: {} as any,
        projects: [
          {
            id: 'proj-hydration-test',
            name: 'Hydration Project',
            pinned: false,
            createdAt: 1000,
            updatedAt: projectOriginalUpdatedAt,
            workLocation: 'local',
          },
        ],
        sessions: [
          {
            id: 'sess-hydrated-wt',
            projectId: 'proj-hydration-test',
            title: 'Hydrated Worktree',
            pinned: false,
            workLocation: 'worktree',
            worktreePath: '/tmp/test-wt',
            worktreeSetup: {
              sessionId: 'sess-hydrated-wt',
              status: 'ready',
              sourceTreePath: '/tmp/repo',
              branch: 'feature/test',
            },
            createdAt: 1000,
            updatedAt: originalUpdatedAt,
          },
        ],
        currentSessionId: null,
      } as any)

      const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-hydrated-wt')
      expect(session?.updatedAt).toBe(originalUpdatedAt)

      const project = useProjectStore.getState().projects.find((p) => p.id === 'proj-hydration-test')
      expect(project?.workLocation).toBe('local')
      expect(project?.updatedAt).toBe(projectOriginalUpdatedAt)
    })
  })
})
