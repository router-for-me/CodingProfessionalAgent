import { createHashRouteUrl } from '@cpa/plugin-ui'
import type {
    AppSettings,
    AgentRunStatus,
    FileSystemService,
    HookConfiguration,
    HostServices,
    HookService,
    NavigationService,
    NotificationInput,
    NotificationService,
    PendingSessionContext,
    PersistenceService,
    PersonalizationService,
    PluginManagementService,
    PluginSummary,
    Project,
    ProjectService,
    ScheduleService,
    ScheduledTaskItem,
    SessionItem,
    SessionService,
    SessionUnreadState,
    SettingsService,
    SkillUsageService,
    UiService,
    WebServerService,
    WebServerSettings,
    WebServerStatus,
    WorktreeService,
    WorktreeSessionSetup,
    WorktreeSetupInput,
    WorktreeSetupResult,
    DiscoveredWorktree,
    ForkSessionExtraOptions,
    WorktreeDeleteResult,
    SessionMetricsService,
    ProcessService,
    ProcessRunOptions,
    ProcessRunResult,
    QueryMetricsOptions,
    ChatMessageService,
    ChatSendPayload,
    AgentRunState,
    ModelCatalogService,
    RendererContributionsService,
    SubAgentService,
    GatewayDiscoveryService,
    DiscoveredGateway,
} from '@cpa/plugin-api'
import {
    PluginManagementUnavailableError,
    getAppConfigDirName,
} from '@cpa/plugin-api'
import { setDefaultHostServices } from '@cpa/plugin-ui'
import { isSessionResumable } from '@/features/agent-runtime/session/unfinished'
import { rendererRegistry, type RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { pluginPlatformCoordinator } from '@/plugins/platform/PluginPlatformCoordinator'
import { ElectronNativeBridge } from '@/features/agent-runtime/native/electronNativeBridge'
import {
    discoverAllHooks,
    loadProjectHooks,
    loadUserHooks,
    saveProjectHooks,
    saveUserHooks,
} from '@cpa/plugin-sdk'
import { forkSession } from '@/features/agent-runtime/session/forkSession'
import { executeSessionCompletionHook } from '@/features/agent-runtime/session/executeSessionHook'
import { createWorktreeForProject } from '@/lib/worktreeManager'
import { runEnvironmentSetup } from '@/lib/environmentRunner'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { agentsForParent, useSubAgentStore } from '@/stores/subAgentStore'
import {
    retainMessageSession,
    useMessageStore,
} from '@/stores/messageStore'
import { useToolOverlayStore } from '@/stores/toolOverlayStore'
import { useCompactionOverlayStore } from '@/stores/compactionOverlayStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUiStore } from '@/stores/uiStore'
import { useSkillUsageStore } from '@/stores/skillUsageStore'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { refreshModelCatalog } from '@/features/models/modelCatalogService'
import { setWorktreeRunner, useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { rendererEventBus } from '@/plugins/platform/eventBus'
import { viewRegistry } from '@/application/views/viewRegistry'
import { getHostBridge, isNativeRuntime } from './hostTransport'
import { isBrowserEnvironment } from '@/lib/platform'
import {
    initPersistence,
    flushPendingPersistence,
    ensureSessionLoaded,
    schedulePersist,
} from './persistenceService'
import { createId } from '@/lib/id'

const EMPTY_TOOL_OVERLAYS = Object.freeze({} as Record<string, never>)

function decodeProcessOutput(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) {
        return ''
    }
    try {
        if (typeof globalThis.atob === 'function') {
            const binary = globalThis.atob(value)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i)
            }
            return new TextDecoder('utf-8').decode(bytes)
        }
    } catch {
        // Fall through and treat the value as already-decoded text.
    }
    return value
}

function normalizeProcessRunResult(raw: any): ProcessRunResult {
    if (!raw || typeof raw !== 'object') {
        return { exitCode: 1, stdout: '', stderr: 'Invalid process result' }
    }
    const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : 1
    if (typeof raw.stdout === 'string' || typeof raw.stderr === 'string') {
        return {
            exitCode,
            stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
            stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
        }
    }
    return {
        exitCode,
        stdout: decodeProcessOutput(raw.stdoutBase64),
        stderr: decodeProcessOutput(raw.stderrBase64),
    }
}

function isUnknownRpcError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err ?? '')
    return /Unknown RPC method/i.test(message)
}

export interface CapabilityClientLike {
    invoke: (method: string, args?: unknown[]) => Promise<unknown>
}

export interface RouterLike {
    navigate: (to: string) => Promise<void> | void
}

export interface NotifierLike {
    show: (input: NotificationInput) => void
}

export interface CreateHostServicesOptions {
    capabilityClient?: CapabilityClientLike
    router?: RouterLike
    notifier?: NotifierLike
    webServer?: WebServerService
    fileSystem?: FileSystemService
    personalization?: PersonalizationService
    pluginManagement?: PluginManagementService
    sessionMetrics?: SessionMetricsService
    process?: ProcessService
    chatMessages?: ChatMessageService
    subAgents?: SubAgentService
    rendererContributions?: RendererContributionsService
    rendererRegistry?: RendererRegistry
    agentService?: any
}

export function createHostServices(options: CreateHostServicesOptions = {}): HostServices {
    const { capabilityClient, router, notifier } = options
    const agentRunStateCache = new Map<string, AgentRunState>()

    const sessions: SessionService = {
        getSnapshot(): readonly SessionItem[] {
            return useSessionStore.getState().sessions
        },

        subscribe(listener: (sessions: readonly SessionItem[]) => void): () => void {
            return useSessionStore.subscribe((state) => {
                listener(state.sessions)
            })
        },

        getCurrentSessionId(): string | null {
            return useSessionStore.getState().currentSessionId
        },

        setCurrentSessionId(id: string | null): void {
            useSessionStore.getState().setCurrentSession(id)
        },

        create(input?: any): string {
            return useSessionStore.getState().createSession(input)
        },

        async delete(sessionId: string): Promise<void> {
            useSessionStore.getState().removeSession(sessionId)
        },

        setProject(sessionId: string, projectId: string | null): void {
            useSessionStore.getState().setSessionProject(sessionId, projectId ?? undefined)
        },

        setBranch(sessionId: string, branch: string | null): void {
            useSessionStore.getState().setSessionBranch(sessionId, branch ?? undefined)
        },

        setWorktree(sessionId: string, setup: Partial<WorktreeSessionSetup>): void {
            const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
            const mergedSetup = { ...(currentSession?.worktreeSetup ?? {}), ...setup } as WorktreeSessionSetup
            useSessionStore.getState().setSessionWorktreeSetup?.(sessionId, mergedSetup)
        },

        renameSession(sessionId: string, title: string): void {
            useSessionStore.getState().renameSession(sessionId, title)
        },

        togglePin(sessionId: string): void {
            useSessionStore.getState().togglePin(sessionId)
        },

        markUnread(sessionId: string, unread: SessionUnreadState): void {
            useSessionStore.getState().markUnread(sessionId, unread)
        },

        markRead(sessionId: string): void {
            useSessionStore.getState().markRead(sessionId)
        },

        markUnreadManually(sessionId: string): void {
            useSessionStore.getState().markUnreadManually(sessionId)
        },

        isManuallyMarkedUnread(sessionId: string): boolean {
            return useSessionStore.getState().manuallyMarkedUnreadSessionIds.includes(sessionId)
        },

        getActiveRun(sessionId: string): any {
            return useSessionRunStore.getState().activeRuns[sessionId]
        },

        subscribeRuns(listener: () => void): () => void {
            return useSessionRunStore.subscribe(() => listener())
        },

        getEntriesBySession(): Record<string, any[]> {
            return useMessageStore.getState().entriesBySession
        },

        async list(): Promise<readonly SessionItem[]> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('sessions.list')
                if (Array.isArray(res)) return res as SessionItem[]
            }
            const bridge = getHostBridge()
            if (typeof bridge?.SessionListSessions === 'function') {
                try {
                    const res = await bridge.SessionListSessions()
                    if (Array.isArray(res)) return res as SessionItem[]
                } catch {
                    // Fall back to local store
                }
            }
            return useSessionStore.getState().sessions
        },

        async get(sessionId: string): Promise<SessionItem | undefined> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('sessions.get', [sessionId])
                if (res) return res as SessionItem
            }
            return useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        },

        async update(sessionId: string, patch: Partial<SessionItem>): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('sessions.update', [sessionId, patch])
                return
            }
            const bridge = getHostBridge()
            if (typeof bridge?.SessionSetMeta === 'function') {
                const current = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                if (current) {
                    const merged = { ...current, ...patch }
                    const unread = merged.unread === 'error' ? 'error' : merged.unread === true
                    void bridge.SessionSetMeta({ ...merged, unread }).catch(() => {})
                }
            }
            if (patch.rightSidebar) {
                useSessionStore.getState().setSessionRightSidebar?.(sessionId, patch.rightSidebar)
            }
            if (patch.pinnedSummaryVisible !== undefined) {
                useSessionStore.getState().setSessionPinnedSummaryVisible?.(sessionId, patch.pinnedSummaryVisible)
            }
            if (patch.title !== undefined) {
                useSessionStore.getState().renameSession?.(sessionId, patch.title)
            }
            if (patch.pinned !== undefined) {
                useSessionStore.getState().togglePin?.(sessionId)
            }
            if (patch.unread !== undefined) {
                useSessionStore.getState().markUnread?.(sessionId, patch.unread)
            }
            if (patch.archivedAt !== undefined) {
                if (patch.archivedAt === null) {
                    useSessionStore.getState().unarchiveSession?.(sessionId)
                } else {
                    useSessionStore.getState().archiveSession?.(sessionId)
                }
            } else if ('archivedAt' in patch) {
                useSessionStore.getState().unarchiveSession?.(sessionId)
            }
            if ('projectId' in patch) {
                useSessionStore.getState().setSessionProject?.(sessionId, patch.projectId ?? undefined)
            }
            if (patch.workLocation !== undefined) {
                const cur = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                if (cur) {
                    useSessionStore.getState().setSessionWorktree?.(
                        sessionId,
                        patch.workLocation,
                        patch.worktreePath !== undefined ? patch.worktreePath : cur.worktreePath,
                        patch.environmentId !== undefined ? patch.environmentId : cur.environmentId,
                    )
                }
            } else if (patch.environmentId !== undefined || patch.worktreePath !== undefined) {
                const cur = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
                if (cur && cur.workLocation) {
                    useSessionStore.getState().setSessionWorktree?.(
                        sessionId,
                        cur.workLocation,
                        patch.worktreePath !== undefined ? patch.worktreePath : cur.worktreePath,
                        patch.environmentId !== undefined ? patch.environmentId : cur.environmentId,
                    )
                }
            }
        },

        setSessionRuntimeSettings(
            sessionId: string,
            settings: { modelId?: string; reasoningEffort?: string; speed?: any },
        ): void {
            useSessionStore.getState().setSessionRuntimeSettings?.(sessionId, settings as any)
        },

        async forkSession(
            sessionId: string,
            atEntryId?: string,
            options?: ForkSessionExtraOptions,
        ): Promise<string | undefined> {
            await ensureSessionLoaded(sessionId)
            const res = forkSession({
                sessionId,
                messageId: atEntryId,
                ...options,
            })
            return res ?? undefined
        },

        async broadcastRunStatus(sessionId: string, status: AgentRunStatus): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('sessions.broadcastRunStatus', [sessionId, status])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.SessionBroadcastRunStatus) {
                const runStatus = status === 'error' ? 'idle' : status
                await bridge.SessionBroadcastRunStatus(
                    sessionId,
                    runStatus,
                    `run-${Date.now()}`,
                    'desktop-host',
                )
            }
        },
    }

    const projects: ProjectService = {
        getSnapshot(): readonly Project[] {
            return useProjectStore.getState().projects
        },

        subscribe(listener: (projects: readonly Project[]) => void): () => void {
            return useProjectStore.subscribe((state) => {
                listener(state.projects)
            })
        },

        togglePin(id: string): void {
            useProjectStore.getState().togglePin(id)
        },

        update(id: string, patch: Partial<Project>): void {
            useProjectStore.getState().updateProject(id, patch)
        },

        async list(): Promise<readonly Project[]> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('projects.list')
                if (Array.isArray(res)) return res as Project[]
            }
            return useProjectStore.getState().projects
        },

        async save(project: Project): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('projects.save', [project])
                return
            }
            const exists = useProjectStore.getState().projects.some((p) => p.id === project.id)
            if (exists) {
                useProjectStore.getState().updateProject(project.id, project)
            } else {
                useProjectStore.getState().addProject(project)
            }
        },

        async remove(projectPath: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('projects.remove', [projectPath])
                return
            }
            useProjectStore.getState().removeProject(projectPath)
        },

        async selectDirectory(title?: string): Promise<{ name: string; path: string } | null> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('native:selectProjectDirectory', [title])
                return res as { name: string; path: string } | null
            }
            const { pickProjectDirectory: picker } = await import('@/lib/projectDirectoryPicker')
            return await picker(title ?? '')
        },

        async revealPath(path: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('native:revealInFileManager', [path])
                return
            }
            const { revealProjectPath: reveal } = await import('@/lib/projectReveal')
            await reveal(path)
        },
    }

    const settings: SettingsService = {
        async get(): Promise<AppSettings> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('settings.get')
                if (res) return res as AppSettings
            }
            return useSettingsStore.getState().settings
        },

        async update(patch: Partial<AppSettings>): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('settings.update', [patch])
                return
            }
            useSettingsStore.getState().hydrate(patch)
        },

        getSnapshot(): AppSettings {
            return useSettingsStore.getState().settings
        },

        subscribe(listener: (settings: AppSettings) => void): () => void {
            return useSettingsStore.subscribe((state) => {
                listener(state.settings)
            })
        },

        setTheme(theme) {
            useSettingsStore.getState().setTheme(theme)
        },
        setLocale(locale) {
            useSettingsStore.getState().setLocale(locale)
        },
        setModelId(modelId) {
            useSettingsStore.getState().setModelId(modelId)
        },
        setReasoningLevel(reasoningLevel) {
            useSettingsStore.getState().setReasoningLevel(reasoningLevel)
        },
        setSpeed(speed) {
            useSettingsStore.getState().setSpeed(speed)
        },
        setCompactionThresholdPercent(percent) {
            useSettingsStore.getState().setCompactionThresholdPercent(percent)
        },
        setFastContextCompaction(enabled) {
            useSettingsStore.getState().setFastContextCompaction(enabled)
        },
        setResumeUnfinishedConversations(enabled) {
            useSettingsStore.getState().setResumeUnfinishedConversations(enabled)
        },
        setPreventSleep(enabled) {
            useSettingsStore.getState().setPreventSleep(enabled)
        },
        setShowInMenuBar(enabled) {
            useSettingsStore.getState().setShowInMenuBar(enabled)
        },
        setShowBottomPanel(enabled) {
            useSettingsStore.getState().setShowBottomPanel(enabled)
        },
        setTerminalPosition(position) {
            useSettingsStore.getState().setTerminalPosition(position)
        },
        setCliProxyApi(partial) {
            useSettingsStore.getState().setCliProxyApi(partial)
        },
        setWebServer(partial) {
            useSettingsStore.getState().setWebServer(partial)
        },
        setProfile(partial) {
            useSettingsStore.getState().setProfile(partial)
        },
        setModelSettings(partial) {
            useSettingsStore.getState().setModelSettings(partial)
        },
        setModelOrder(modelOrder) {
            useSettingsStore.getState().setModelOrder(modelOrder)
        },
        setModelEnabled(modelId, enabled) {
            useSettingsStore.getState().setModelEnabled(modelId, enabled)
        },
        setModelReasoningLevelEnabled(modelId, reasoningLevel, enabled, allReasoningLevels) {
            useSettingsStore.getState().setModelReasoningLevelEnabled(modelId, reasoningLevel, enabled, allReasoningLevels)
        },
        setThemePreset(themePreset) {
            useSettingsStore.getState().setThemePreset(themePreset)
        },
        setAccentColor(accentColor) {
            useSettingsStore.getState().setAccentColor(accentColor)
        },
        setBackgroundColor(backgroundColor) {
            useSettingsStore.getState().setBackgroundColor(backgroundColor)
        },
        setForegroundColor(foregroundColor) {
            useSettingsStore.getState().setForegroundColor(foregroundColor)
        },
        setUiFontFamily(uiFontFamily) {
            useSettingsStore.getState().setUiFontFamily(uiFontFamily)
        },
        setUiFontWeight(uiFontWeight) {
            useSettingsStore.getState().setUiFontWeight(uiFontWeight)
        },
        setCodeFontFamily(codeFontFamily) {
            useSettingsStore.getState().setCodeFontFamily(codeFontFamily)
        },
        setCodeFontWeight(codeFontWeight) {
            useSettingsStore.getState().setCodeFontWeight(codeFontWeight)
        },
        setContrast(contrast) {
            useSettingsStore.getState().setContrast(contrast)
        },
        setCompactMode(compactMode) {
            useSettingsStore.getState().setCompactMode(compactMode)
        },
        setShowLineNumbers(showLineNumbers) {
            useSettingsStore.getState().setShowLineNumbers(showLineNumbers)
        },
        setWordWrap(wordWrap) {
            useSettingsStore.getState().setWordWrap(wordWrap)
        },
        setUiScale(uiScale) {
            useSettingsStore.getState().setUiScale(uiScale)
        },
        setUiFontSize(uiFontSize) {
            useSettingsStore.getState().setUiFontSize(uiFontSize)
        },
        setCodeFontSize(codeFontSize) {
            useSettingsStore.getState().setCodeFontSize(codeFontSize)
        },
        setFontSmoothing(fontSmoothing) {
            useSettingsStore.getState().setFontSmoothing(fontSmoothing)
        },
        setLocalMemoryEnabled(enabled) {
            useSettingsStore.getState().setLocalMemoryEnabled(enabled)
        },
        setToolAssistedMemoryEnabled(enabled) {
            useSettingsStore.getState().setToolAssistedMemoryEnabled(enabled)
        },
        setPersonality(personality) {
            useSettingsStore.getState().setPersonality(personality)
        },
        setGitSettings(partial) {
            useSettingsStore.getState().setGitSettings(partial)
        },
        setWorktreeSettings(partial) {
            useSettingsStore.getState().setWorktreeSettings(partial)
        },
        setSubagentSettings(partial) {
            useSettingsStore.getState().setSubagentSettings(partial)
        },
        setEditorSettings(partial) {
            useSettingsStore.getState().setEditorSettings(partial)
        },
        setAppearance(partial) {
            useSettingsStore.getState().setAppearance(partial)
        },
        hydrate(partial) {
            useSettingsStore.getState().hydrate(partial)
        },
    }

    const worktrees: WorktreeService = {
        async resolveRootDir(configuredRootDir?: string): Promise<string> {
            const trimmed = configuredRootDir?.trim()
            let homeDir: string | undefined
            try {
                const info = await fileSystem.getRuntimeInfo?.()
                if (info?.homeDir) {
                    homeDir = info.homeDir
                }
            } catch {
                // Fallback
            }

            let configDirName = getAppConfigDirName()
            if (fileSystem.getRuntimeInfo) {
                try {
                    const info = await fileSystem.getRuntimeInfo()
                    if (info?.homeDir) {
                        homeDir = info.homeDir
                    }
                    if ((info as any)?.appConfigDirName) {
                        configDirName = (info as any).appConfigDirName
                    } else if (typeof (info as any)?.isDebug === 'boolean') {
                        configDirName = getAppConfigDirName((info as any).isDebug)
                    }
                } catch {
                    // Fallback
                }
            }

            if (trimmed) {
                if (trimmed.startsWith('~') && homeDir) {
                    return trimmed.replace(/^~(?=$|\/|\\)/, homeDir)
                }
                return trimmed
            }

            if (homeDir) {
                return `${homeDir}/${configDirName}/worktrees`
            }
            return `~/${configDirName}/worktrees`
        },

        async listWorktrees(rootDir?: string): Promise<DiscoveredWorktree[]> {
            const targetDir = await this.resolveRootDir!(rootDir)
            const entries = await fileSystem.readDir?.(targetDir)
            if (!entries || !Array.isArray(entries)) {
                return []
            }

            const discovered: DiscoveredWorktree[] = []
            for (const entry of entries) {
                if (!entry.isDirectory) continue

                const wtPath = `${targetDir}/${entry.name}`
                const gitFilePath = `${wtPath}/.git`

                let gitFileContent = ''
                try {
                    const res = fileSystem.readFileIfExists
                        ? await fileSystem.readFileIfExists(gitFilePath)
                        : await fileSystem.readFile(gitFilePath)
                    if (res?.dataBase64) {
                        gitFileContent = atob(res.dataBase64)
                    }
                } catch {
                    continue
                }

                if (!gitFileContent || !gitFileContent.trim().startsWith('gitdir:')) {
                    continue
                }

                let gitDirPath = gitFileContent.replace(/^gitdir:\s*/, '').trim()
                if (!gitDirPath.startsWith('/') && !/^[a-zA-Z]:/.test(gitDirPath)) {
                    gitDirPath = `${wtPath}/${gitDirPath}`
                }

                let branch: string | undefined
                let headSha: string | undefined
                let mainRepoPath: string | undefined
                let mainRepo: string | undefined

                try {
                    const headRes = fileSystem.readFileIfExists
                        ? await fileSystem.readFileIfExists(`${gitDirPath}/HEAD`)
                        : await fileSystem.readFile(`${gitDirPath}/HEAD`)
                    if (headRes?.dataBase64) {
                        const headText = atob(headRes.dataBase64).trim()
                        if (headText.startsWith('ref:')) {
                            branch = headText.replace(/^ref:\s*/, '').replace(/^refs\/heads\//, '')
                        } else {
                            headSha = headText.slice(0, 8)
                        }
                    }
                } catch {
                    // ignore
                }

                try {
                    const commonRes = fileSystem.readFileIfExists
                        ? await fileSystem.readFileIfExists(`${gitDirPath}/commondir`)
                        : await fileSystem.readFile(`${gitDirPath}/commondir`)
                    if (commonRes?.dataBase64) {
                        const commondirText = atob(commonRes.dataBase64).trim()
                        let fullCommonDir = commondirText
                        if (!fullCommonDir.startsWith('/') && !/^[a-zA-Z]:/.test(fullCommonDir)) {
                            fullCommonDir = `${gitDirPath}/${commondirText}`
                        }
                        mainRepoPath = fullCommonDir.replace(/\\/g, '/').replace(/\/\.git\/?$/, '')
                        const parts = mainRepoPath.split('/').filter(Boolean)
                        mainRepo = parts[parts.length - 1] ?? mainRepoPath
                    }
                } catch {
                    // ignore
                }

                discovered.push({
                    name: entry.name,
                    path: wtPath,
                    branch,
                    headSha,
                    mainRepo,
                    mainRepoPath,
                    gitDir: gitDirPath,
                    isGitWorktree: true,
                })
            }
            return discovered
        },

        async deleteWorktree(wt: DiscoveredWorktree): Promise<WorktreeDeleteResult> {
            if (wt.mainRepoPath && processService) {
                const res = await processService.run({
                    command: 'git',
                    args: ['worktree', 'remove', '--force', wt.path],
                    cwd: wt.mainRepoPath,
                })
                if (res.exitCode === 0) {
                    return { ok: true }
                }
            }
            if (fileSystem.removeDir) {
                try {
                    await fileSystem.removeDir(wt.path)
                    return { ok: true }
                } catch (err) {
                    return { ok: false, error: err instanceof Error ? err.message : String(err) }
                }
            }
            return { ok: false, error: 'No directory removal handler available' }
        },

        async setup(input: WorktreeSetupInput): Promise<WorktreeSetupResult> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('worktrees.setup', [input])
                if (res && typeof res === 'object' && 'ok' in res) {
                    return res as WorktreeSetupResult
                }
            }

            const {
                sessionId,
                sourceTreePath,
                worktreePath: existingWorktreePath,
                branch,
                branchPrefix,
                environmentId,
                worktreeRootDir,
                fetchUpstream,
                onProgress,
                onLog,
            } = input

            let worktreePath = existingWorktreePath
            let currentBranch = branch || undefined

            try {
                if (!worktreePath) {
                    onProgress?.('preparing')
                    const wtResult = await createWorktreeForProject({
                        sourceTreePath,
                        branch: branch || undefined,
                        branchPrefix: branchPrefix || undefined,
                        worktreeRootDir,
                        fetchUpstream,
                        onProgress: (step) => {
                            if (step === 'preparing') {
                                onProgress?.('preparing')
                            } else if (step === 'checking_out') {
                                onProgress?.('checking_out')
                            }
                        },
                    })
                    worktreePath = wtResult.worktreePath
                    currentBranch = wtResult.branch
                }

                onProgress?.('setting_up')

                let envResult: { ok: boolean; scriptRan?: boolean; error?: string; exitCode?: number } = {
                    ok: true,
                    scriptRan: false,
                }

                const project = environmentId
                    ? useProjectStore
                          .getState()
                          .projects.find((p) => p.id === environmentId || p.name === environmentId)
                    : undefined

                if (project) {
                    envResult = await runEnvironmentSetup({
                        sourceTreePath: sourceTreePath || worktreePath,
                        worktreePath,
                        project,
                        onLog: (chunk) => {
                            onLog?.(chunk)
                        },
                    })
                }

                if (envResult.ok) {
                    onProgress?.('ready')
                    useSessionStore.getState().setSessionWorktree?.(
                        sessionId,
                        'worktree',
                        worktreePath,
                        environmentId,
                    )
                    if (currentBranch) {
                        useSessionStore.getState().setSessionBranch?.(sessionId, currentBranch)
                    }
                    return { ok: true, worktreePath, branch: currentBranch }
                } else {
                    onProgress?.('error')
                    return {
                        ok: false,
                        worktreePath,
                        branch: currentBranch,
                        error: envResult.error,
                        exitCode: envResult.exitCode ?? 1,
                    }
                }
            } catch (err) {
                onProgress?.('error')
                const errorMsg = err instanceof Error ? err.message : String(err)
                return {
                    ok: false,
                    worktreePath,
                    branch: currentBranch,
                    error: errorMsg,
                }
            }
        },
    }

    const hooks: HookService = {
        async load(projectPath: string): Promise<HookConfiguration> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('hooks.read', [projectPath])
                return (res ?? {}) as HookConfiguration
            }
            const bridge = new ElectronNativeBridge()
            const userRes = await loadUserHooks(bridge)
            const discovered = await discoverAllHooks(bridge, projectPath || null)
            const projRes = projectPath ? await loadProjectHooks(bridge, projectPath) : null
            return {
                userConfigFile: userRes.file,
                userConfigPath: userRes.path,
                userHooks: discovered.userHooks,
                projectHooks: discovered.projectHooks,
                file: projRes?.file,
                path: projRes?.path,
            }
        },

        async save(projectPath: string, config: HookConfiguration): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('hooks.write', [projectPath, config])
                return
            }
            const bridge = new ElectronNativeBridge()
            if (projectPath === 'user' || !projectPath) {
                if (config.file) {
                    await saveUserHooks(bridge, config.file)
                }
            } else {
                if (config.file) {
                    await saveProjectHooks(bridge, projectPath, config.file)
                }
            }
        },
    }

    const navigation: NavigationService = {
        async navigate(to: string | { to: string; params?: Record<string, string> }): Promise<void> {
            const target = typeof to === 'string' ? to : to.to
            const navOptions = typeof to === 'string' ? { to } : to
            const activeRouter = router ?? getHostRouter()
            if (activeRouter) {
                if (typeof activeRouter.navigate === 'function') {
                    try {
                        await activeRouter.navigate(navOptions as any)
                        return
                    } catch {
                        await activeRouter.navigate(target as any)
                        return
                    }
                }
            }
            if (typeof window !== 'undefined' && typeof (window as any).__cpa_navigate === 'function') {
                await (window as any).__cpa_navigate(to)
                return
            }
            if (typeof window !== 'undefined') {
                window.location.assign(createHashRouteUrl(target))
            }
        },

        getNavigationItems(): readonly any[] {
            return viewRegistry.listNavigationItems()
        },

        subscribe(listener: () => void): () => void {
            return viewRegistry.subscribe(listener)
        },
    }

    const notifications: NotificationService = {
        show(input: NotificationInput): void {
            if (notifier) {
                notifier.show(input)
                return
            }
            if (typeof window !== 'undefined') {
                console.log(`[Notification] ${input.type ?? 'info'}: ${input.message}`)
            }
        },
    }

    let fallbackScheduleTasks: readonly ScheduledTaskItem[] = []

    const schedule: ScheduleService = {
        async list(): Promise<readonly ScheduledTaskItem[]> {
            if (capabilityClient) {
                try {
                    const res = await capabilityClient.invoke('schedule:list')
                    if (Array.isArray(res)) return res as ScheduledTaskItem[]
                } catch (err) {
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to load schedule via capability client:', err)
                    }
                }
            }
            const bridge = getHostBridge()
            if (bridge?.ScheduleList) {
                try {
                    const res = await bridge.ScheduleList()
                    if (Array.isArray(res)) return res as ScheduledTaskItem[]
                } catch (err) {
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to load schedule via ScheduleList:', err)
                    }
                }
            }
            if (bridge?.KVStoreGet) {
                try {
                    const data = await bridge.KVStoreGet('schedule')
                    if (Array.isArray(data)) {
                        return data as ScheduledTaskItem[]
                    }
                } catch (err) {
                    // Main may still be staged during early renderer activation.
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to load schedule from KV store:', err)
                    }
                }
            }
            return fallbackScheduleTasks
        },

        async save(tasks: readonly ScheduledTaskItem[]): Promise<void> {
            fallbackScheduleTasks = [...tasks]
            let persisted = false

            if (capabilityClient) {
                try {
                    await capabilityClient.invoke('schedule:save', [tasks])
                    persisted = true
                } catch (err) {
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to save schedule via capability client:', err)
                    }
                }
            }

            const bridge = getHostBridge()
            if (!persisted && bridge?.ScheduleSave) {
                try {
                    await bridge.ScheduleSave(tasks as any)
                    persisted = true
                } catch (err) {
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to save schedule via ScheduleSave:', err)
                    }
                }
            }

            // Keep KV as durable fallback when schedule RPCs are unavailable.
            if (!persisted && bridge?.KVStoreSet) {
                try {
                    await bridge.KVStoreSet('schedule', tasks as any)
                } catch (err) {
                    if (!isUnknownRpcError(err)) {
                        console.error('Failed to save schedule to KV store:', err)
                    }
                }
            }
        },
    }

    let availableComposerSkills: readonly any[] | null = null
    const availableSkillsListeners = new Set<() => void>()

    const skillUsage: SkillUsageService = {
        async fetchUsageCounts(): Promise<Record<string, number>> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('skillUsage.query')
                if (res && typeof res === 'object') {
                    const map = res as Record<string, number>
                    useSkillUsageStore.getState().setUsageCounts(map)
                    return map
                }
            }
            const bridge = getHostBridge()
            if (typeof bridge?.SessionQueryMetrics === 'function') {
                try {
                    const res = await bridge.SessionQueryMetrics({
                        topSkillsLimit: 10000,
                    })
                    if (res?.summary?.topSkills && Array.isArray(res.summary.topSkills)) {
                        const map: Record<string, number> = {}
                        for (const item of res.summary.topSkills) {
                            if (
                                item &&
                                typeof item.name === 'string' &&
                                typeof item.count === 'number'
                            ) {
                                map[item.name.toLowerCase()] = item.count
                            }
                        }
                        const currentCounts = useSkillUsageStore.getState().usageCounts
                        const merged: Record<string, number> = { ...map }
                        for (const [key, count] of Object.entries(currentCounts)) {
                            if (typeof merged[key] === 'number') {
                                merged[key] = Math.max(merged[key], count)
                            } else {
                                merged[key] = count
                            }
                        }
                        useSkillUsageStore.getState().setUsageCounts(merged)
                        return merged
                    }
                } catch (err) {
                    console.error('Failed to fetch skill usage metrics:', err)
                }
            }
            return useSkillUsageStore.getState().usageCounts
        },

        recordUsage(skillName: string, delta = 1): void {
            useSkillUsageStore.getState().recordUsage(skillName, delta)
        },

        getSnapshot(): Record<string, number> {
            return useSkillUsageStore.getState().usageCounts
        },

        subscribe(listener: () => void): () => void {
            return useSkillUsageStore.subscribe(() => {
                listener()
            })
        },

        getAvailableSkills(): readonly any[] {
            if (availableComposerSkills !== null) {
                return availableComposerSkills
            }
            if (typeof globalThis !== 'undefined' && (globalThis as any).__cpaComposerSkills) {
                return (globalThis as any).__cpaComposerSkills
            }
            return []
        },

        setAvailableSkills(skills: readonly any[]): void {
            availableComposerSkills = Array.isArray(skills) ? skills : []
            if (typeof globalThis !== 'undefined') {
                ;(globalThis as any).__cpaComposerSkills = availableComposerSkills
            }
            for (const listener of availableSkillsListeners) listener()
        },

        subscribeAvailableSkills(listener: () => void): () => void {
            availableSkillsListeners.add(listener)
            return () => { availableSkillsListeners.delete(listener) }
        },
    }

    const persistence: PersistenceService = {
        async init(): Promise<void> {
            await initPersistence()
        },
        async flush(): Promise<void> {
            await flushPendingPersistence()
        },
    }

    const ui: UiService = {
        getPendingSessionContext(): PendingSessionContext {
            return useUiStore.getState().pendingSessionContext
        },

        setPendingSessionContext(context: Partial<PendingSessionContext>): void {
            useUiStore.getState().setPendingSessionContext(context as any)
        },

        isGroupCollapsed(groupKey: string): boolean {
            return !!useUiStore.getState().collapsedGroups[groupKey]
        },

        toggleGroup(groupKey: string): void {
            useUiStore.getState().toggleGroup(groupKey)
        },

        setSidebarCollapsed(collapsed: boolean): void {
            useUiStore.getState().setSidebarCollapsed(collapsed)
        },

        isSidebarCollapsed(): boolean {
            return useUiStore.getState().sidebarCollapsed
        },

        toggleSidebar(): void {
            useUiStore.getState().toggleSidebarCollapsed()
        },

        togglePinnedSummaryVisible(): void {
            useUiStore.getState().togglePinnedSummaryVisible()
        },

        openSettings(section?: string, options?: unknown): void {
            if (typeof section === 'object' && section !== null) {
                const sObj = section as Record<string, unknown>
                const targetSection = typeof sObj.section === 'string' ? sObj.section : undefined
                const params = { ...sObj }
                delete params.section
                useUiStore.getState().setSettingsOpen(true, targetSection, params)
                return
            }
            const params = typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : undefined
            useUiStore.getState().setSettingsOpen(true, section, params)
        },

        closeSettings(): void {
            useUiStore.getState().setSettingsOpen(false)
        },

        pushToast(message: string, _type?: 'info' | 'success' | 'warning' | 'error'): void {
            useUiStore.getState().pushToast(message)
        },

        getComposerDraft(key: string): string | undefined {
            return useUiStore.getState().composerDrafts[key]
        },

        setComposerDraft(key: string, draft: string): void {
            useUiStore.getState().setComposerDraftForSession?.(key, draft)
        },

        clearComposerDraft(key: string): void {
            useUiStore.getState().setComposerDraftForSession?.(key, '')
        },

        subscribe(listener: () => void): () => void {
            return useUiStore.subscribe(() => {
                listener()
            })
        },

        getSnapshot(): any {
            return useUiStore.getState()
        },

        emitEvent(eventName: string, payload?: any): void {
            void rendererEventBus.emit(eventName as any, payload)
        },

        async writeClipboard(text: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('native:clipboardSetText', [text])
                return
            }
            if (isNativeRuntime()) {
                const bridge = getHostBridge()
                if (bridge?.ClipboardSetText) {
                    await bridge.ClipboardSetText(text)
                    return
                }
            }
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text)
            }
        },

        openRightPanelTab(tabId: string, options?: { activate?: boolean; params?: Record<string, unknown> }): void {
            useUiStore.getState().openRightPanelTab(tabId, options)
        },

        closeRightPanelTab(tabId: string): void {
            useUiStore.getState().closeRightPanelTab(tabId)
        },

        toggleRightSidebarCollapsed(): void {
            useUiStore.getState().toggleRightSidebarCollapsed()
        },

        setRightSidebarCollapsed(collapsed: boolean): void {
            useUiStore.getState().setRightSidebarCollapsed(collapsed)
        },

        toggleBottomPanelVisible(): void {
            useUiStore.getState().toggleBottomPanelVisible()
        },

        setBottomPanelVisible(visible: boolean): void {
            useUiStore.getState().setBottomPanelVisible(visible)
        },

        setBottomPanelHeight(height: number): void {
            useUiStore.getState().setBottomPanelHeight(height)
        },
    }

    const webServer: WebServerService = options.webServer ?? {
        async getStatus(): Promise<WebServerStatus> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('webserver:getStatus')
                if (res) return res as WebServerStatus
            }
            const bridge = getHostBridge()
            if (bridge?.WebServerGetStatus) {
                return bridge.WebServerGetStatus()
            }
            return {
                running: false,
                host: useSettingsStore.getState().settings.webServer?.host || '127.0.0.1',
                port: useSettingsStore.getState().settings.webServer?.port || 18080,
                url: '',
            }
        },
        async start(config?: Partial<WebServerSettings>): Promise<WebServerStatus> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('webserver:start', [config])
                if (res) return res as WebServerStatus
            }
            const bridge = getHostBridge()
            if (bridge?.WebServerStart) {
                return bridge.WebServerStart(config as any)
            }
            return {
                running: true,
                host: config?.host || '127.0.0.1',
                port: config?.port || 18080,
                url: `http://${config?.host || '127.0.0.1'}:${config?.port || 18080}`,
            }
        },
        async stop(): Promise<WebServerStatus> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('webserver:stop')
                if (res) return res as WebServerStatus
            }
            const bridge = getHostBridge()
            if (bridge?.WebServerStop) {
                return bridge.WebServerStop()
            }
            return {
                running: false,
                host: useSettingsStore.getState().settings.webServer?.host || '127.0.0.1',
                port: useSettingsStore.getState().settings.webServer?.port || 18080,
                url: '',
            }
        },
    }

    const fileSystem: FileSystemService = options.fileSystem ?? {
        async readFile(path: string): Promise<{ dataBase64: string }> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('filesystem.readFile', [path])
                return res as { dataBase64: string }
            }
            const bridge = getHostBridge()
            if (bridge?.ReadFile) {
                return bridge.ReadFile(path)
            }
            throw new Error(`Cannot readFile ${path}: no filesystem capability`)
        },
        async readFileIfExists(path: string): Promise<{ dataBase64: string } | null> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('filesystem.readFileIfExists', [path])
                return res as { dataBase64: string } | null
            }
            const bridge = getHostBridge()
            if (bridge?.ReadFileIfExists) {
                return bridge.ReadFileIfExists(path)
            }
            if (bridge?.ReadFile) {
                try {
                    return await bridge.ReadFile(path)
                } catch {
                    return null
                }
            }
            return null
        },
        async writeFile(path: string, dataBase64: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('filesystem.writeFile', [path, dataBase64])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.WriteFile) {
                await bridge.WriteFile(path, dataBase64)
            }
        },
        async mkdirAll(path: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('native:mkdirAll', [path])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.MkdirAll) {
                await bridge.MkdirAll(path)
                return
            }
            throw new Error('MkdirAll is unavailable')
        },
        async readDir(path: string): Promise<{ name: string; isDirectory: boolean; isFile: boolean; path: string; isSymbolicLink?: boolean }[]> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('native:readDir', [path]) as Array<{ name: string; isDir: boolean; isSymbolicLink?: boolean }> | null
                if (!res) throw new Error(`Unable to read directory '${path}'`)
                return res.map((item) => ({
                    name: item.name,
                    isDirectory: item.isDir,
                    isFile: !item.isDir && !item.isSymbolicLink,
                    isSymbolicLink: item.isSymbolicLink,
                    path: `${path}/${item.name}`,
                }))
            }
            const bridge = getHostBridge()
            if (bridge?.ReadDir) {
                const list = await bridge.ReadDir(path)
                if (!list) throw new Error(`Unable to read directory '${path}'`)
                return list.map((item) => ({
                    name: item.name,
                    isDirectory: item.isDir,
                    isFile: !item.isDir && !item.isSymbolicLink,
                    isSymbolicLink: item.isSymbolicLink,
                    path: `${path}/${item.name}`,
                }))
            }
            throw new Error('ReadDir is unavailable')
        },
        async selectFilesAndFolders(title?: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('native:selectFilesAndFolders', [title])
                return (res ?? []) as any[]
            }
            const bridge = getHostBridge()
            if (bridge?.SelectFilesAndFolders) {
                return bridge.SelectFilesAndFolders(title)
            }
            return []
        },
        async revealInFileManager(path: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('native:revealInFileManager', [path])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.RevealInFileManager) {
                await bridge.RevealInFileManager(path)
            }
        },
        async stat(path: string): Promise<any> {
            if (capabilityClient) {
                return capabilityClient.invoke('native:stat', [path])
            }
            const bridge = getHostBridge()
            if (bridge?.Stat) {
                return bridge.Stat(path)
            }
            throw new Error('Stat is unavailable')
        },
        async removeDir(dirPath: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('filesystem.removeDir', [dirPath])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.RemoveDir) {
                await bridge.RemoveDir(dirPath)
            }
        },
        async removeFile(filePath: string): Promise<void> {
            if (capabilityClient) {
                await capabilityClient.invoke('native:removeFile', [filePath])
                return
            }
            const bridge = getHostBridge()
            if (bridge?.RemoveFile) {
                await bridge.RemoveFile(filePath)
                return
            }
            throw new Error('RemoveFile is unavailable')
        },
        async getRuntimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('native:runtimeInfo')
                if (res) return res as any
            }
            const bridge = getHostBridge()
            if (bridge?.RuntimeInfo) {
                return bridge.RuntimeInfo()
            }
            throw new Error('RuntimeInfo is unavailable')
        },
    }

    const personalization: PersonalizationService = options.personalization ?? {
        async loadInstructions(): Promise<string> {
            try {
                const info = await fileSystem.getRuntimeInfo?.()
                const homeDir = info?.homeDir || ''
                const configDirName = (info as any)?.appConfigDirName || getAppConfigDirName((info as any)?.isDebug)
                const filePath = `${homeDir}/${configDirName}/AGENTS.md`
                const res = fileSystem.readFileIfExists
                    ? await fileSystem.readFileIfExists(filePath)
                    : await fileSystem.readFile(filePath)
                if (res?.dataBase64) {
                    const binary = atob(res.dataBase64)
                    const bytes = new Uint8Array(binary.length)
                    for (let i = 0; i < binary.length; i += 1) {
                        bytes[i] = binary.charCodeAt(i)
                    }
                    return new TextDecoder().decode(bytes)
                }
                return ''
            } catch {
                return ''
            }
        },
        async saveInstructions(content: string): Promise<void> {
            const info = await fileSystem.getRuntimeInfo?.()
            const homeDir = info?.homeDir || ''
            const configDirName = (info as any)?.appConfigDirName || getAppConfigDirName((info as any)?.isDebug)
            const dir = `${homeDir}/${configDirName}`
            const filePath = `${dir}/AGENTS.md`
            if (fileSystem.mkdirAll) {
                await fileSystem.mkdirAll(dir).catch(() => {})
            }
            let dataBase64 = ''
            if (content) {
                const bytes = new TextEncoder().encode(content)
                let binary = ''
                for (let i = 0; i < bytes.length; i += 1) {
                    binary += String.fromCharCode(bytes[i])
                }
                dataBase64 = btoa(binary)
            }
            await fileSystem.writeFile(filePath, dataBase64)
        },
        async deleteMemories(): Promise<void> {
            useUiStore.getState().pushToast('Local memories deleted')
        },
    }

    const methodToBridgeMap: Record<string, string> = {
        'plugins:prepareEnable': 'PluginsPrepareEnable',
        'plugins:prepareDisable': 'PluginsPrepareDisable',
        'plugins:prepareReload': 'PluginsPrepareReload',
        'plugins:prepareInstall': 'PluginsPrepareInstall',
        'plugins:prepareUninstall': 'PluginsPrepareUninstall',
        'plugins:prepareConfig': 'PluginsPrepareConfig',
        'plugins:commit': 'PluginsCommit',
        'plugins:finalize': 'PluginsFinalize',
        'plugins:rollback': 'PluginsRollback',
        'plugins:list': 'PluginsList',
        'plugins:getGraph': 'PluginsGetGraph',
        'plugins:getPreparedState': 'PluginsGetPreparedState',
    }

    function isHostCapabilityConnected(): boolean {
        if (isNativeRuntime()) {
            return true
        }
        if (typeof window !== 'undefined' && isBrowserEnvironment()) {
            return true
        }
        return false
    }

    function getEffectiveCapabilityClient(): CapabilityClientLike | null {
        if (capabilityClient) {
            return capabilityClient
        }
        // If capabilityClient was explicitly passed as undefined, honor it as disconnected
        if ('capabilityClient' in options && options.capabilityClient === undefined) {
            return null
        }
        if (!isHostCapabilityConnected()) {
            return null
        }
        const bridge = getHostBridge() as any
        if (
            bridge &&
            (typeof bridge.PluginsPrepareDisable === 'function' ||
                typeof bridge.PluginsPrepareEnable === 'function' ||
                typeof bridge.PluginsList === 'function')
        ) {
            return {
                async invoke(method: string, args: unknown[] = []): Promise<unknown> {
                    const bridgeMethodName = methodToBridgeMap[method]
                    const safeArgs = Array.isArray(args) ? args : args !== undefined ? [args] : []
                    if (bridgeMethodName && typeof bridge[bridgeMethodName] === 'function') {
                        return bridge[bridgeMethodName](...safeArgs)
                    }
                    if (typeof bridge[method] === 'function') {
                        return bridge[method](...safeArgs)
                    }
                    throw new Error(`Unsupported capability method: ${method}`)
                },
            }
        }
        return null
    }

    async function executeCoordinatedAction(
        prepareMethod: string,
        args: unknown[],
        clientParam?: CapabilityClientLike,
    ): Promise<void> {
        const client = clientParam ?? getEffectiveCapabilityClient()
        if (!client) {
            throw new PluginManagementUnavailableError(
                'Plugin management is unavailable when capability client is not connected',
            )
        }

        // 1. Main candidate prepare
        const preparedState = (await client.invoke(prepareMethod, args)) as any
        if (!preparedState || !preparedState.candidateRevision) {
            throw new Error(`Failed to prepare candidate generation for ${prepareMethod}`)
        }

        const { candidateRevision, generation, graph } = preparedState

        // 2. Renderer & Agent stage in isolation
        const preparedGen = await pluginPlatformCoordinator.prepareGeneration(
            graph,
            {
                generation,
            },
        )

        let committedLocally = false
        try {
            // 3. Main durable config prepare (writes temp files + fsync + journal prepared)
            await client.invoke('plugins:prepareConfig', [candidateRevision])

            // 4. Commit all runtimes: Main runtime commit + Renderer/Agent commit
            await client.invoke('plugins:commit', [candidateRevision, generation])
            await preparedGen.commit()
            committedLocally = true

            // 5. Finalize transaction on Main (marks journal committed -> atomic rename -> cleanup journal)
            await client.invoke('plugins:finalize', [candidateRevision])
            pluginPlatformCoordinator.notify()
            await refreshSummaries()
        } catch (err) {
            // Rollback on any error: rollback Main + rollback coordinator
            try {
                await client.invoke('plugins:rollback', [candidateRevision, generation])
            } catch {
                // Ignore secondary rollback error
            }
            try {
                if (!committedLocally) {
                    await preparedGen.rollback()
                }
            } catch {
                // Ignore secondary rollback error
            }
            throw err
        }
    }

    let authoritativeSummaries: readonly PluginSummary[] | null = null
    const pluginManagementListeners = new Set<() => void>()

    function notifyPluginManagementListeners(): void {
        pluginPlatformCoordinator.notify()
        for (const listener of Array.from(pluginManagementListeners)) {
            try {
                listener()
            } catch {
                // Ignore listener error
            }
        }
    }

    async function refreshSummaries(): Promise<void> {
        const client = getEffectiveCapabilityClient()
        if (!client) return
        try {
            const res = (await client.invoke('plugins:list', [])) as any
            if (res && Array.isArray(res.plugins)) {
                authoritativeSummaries = Object.freeze([...res.plugins])
                notifyPluginManagementListeners()
            }
        } catch {
            // Ignore list invocation failure
        }
    }

    const pluginManagement: PluginManagementService = options.pluginManagement ?? {
        getPluginSummaries() {
            const localSummaries = pluginPlatformCoordinator.getPluginSummaries()
            if (!authoritativeSummaries || authoritativeSummaries.length === 0) {
                return localSummaries
            }
            const localMap = new Map(localSummaries.map((s) => [s.manifest.id, s]))
            return authoritativeSummaries.map((mainSummary) => {
                const local = localMap.get(mainSummary.manifest.id)
                if (local) {
                    if (local.status === 'active' || local.status === 'error') {
                        return {
                            ...mainSummary,
                            status: local.status,
                            error: local.error || mainSummary.error,
                        }
                    }
                    if (mainSummary.status === 'inactive') {
                        return { ...mainSummary, status: 'inactive' }
                    }
                }
                return mainSummary
            })
        },
        subscribe(listener) {
            pluginManagementListeners.add(listener)
            const unsubCoordinator = pluginPlatformCoordinator.subscribe(listener)
            if (!authoritativeSummaries) {
                void refreshSummaries().catch(() => {})
            }
            return () => {
                pluginManagementListeners.delete(listener)
                unsubCoordinator()
            }
        },
        async activatePlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareEnable', [id, opt], client)
        },
        async enablePlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareEnable', [id, opt], client)
        },
        async deactivatePlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareDisable', [id, opt], client)
        },
        async disablePlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareDisable', [id, opt], client)
        },
        async reloadPlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareReload', [id, opt], client)
        },
        async installPlugin(spec, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                )
            }
            await executeCoordinatedAction('plugins:prepareInstall', [spec, opt], client)
        },
        async uninstallPlugin(id, opt) {
            const client = getEffectiveCapabilityClient()
            if (!client) {
                throw new PluginManagementUnavailableError(
                    'Plugin management is unavailable when capability client is not connected',
                    { pluginId: id },
                )
            }
            await executeCoordinatedAction('plugins:prepareUninstall', [id, opt], client)
        },
        isPluginActive(id) {
            if (authoritativeSummaries) {
                const found = authoritativeSummaries.find((s) => s.manifest.id === id)
                if (found) {
                    return found.status === 'active'
                }
            }
            return pluginPlatformCoordinator.isPluginActive(id)
        },
        async refresh() {
            await refreshSummaries()
        },
    }

    const processService: ProcessService = options.process ?? {
        async run(runOptions: ProcessRunOptions): Promise<ProcessRunResult> {
            // Injected capability client is used by unit tests and alternate hosts.
            if (capabilityClient) {
                const res = await capabilityClient.invoke('process.run', [runOptions])
                return normalizeProcessRunResult(res)
            }

            const bridge = getHostBridge()

            // Preferred production path: host capability facade exposes RunProcess.
            if (typeof bridge?.RunProcess === 'function') {
                let executable = runOptions.command
                if (typeof bridge.LookPath === 'function') {
                    const resolved = await bridge.LookPath(runOptions.command)
                    if (!resolved) {
                        return {
                            exitCode: 127,
                            stdout: '',
                            stderr: `${runOptions.command} executable not found`,
                        }
                    }
                    executable = resolved
                }

                const raw = await bridge.RunProcess({
                    operationId: createId(),
                    executable,
                    args: [...runOptions.args],
                    cwd: runOptions.cwd ?? '',
                    env: runOptions.env ?? null,
                })
                return normalizeProcessRunResult(raw)
            }

            // Legacy convenience API (older bridges).
            if (typeof bridge?.ProcessRun === 'function') {
                return normalizeProcessRunResult(await (bridge.ProcessRun as any)(runOptions))
            }

            return { exitCode: 1, stdout: '', stderr: 'Native process execution unavailable' }
        },
    }

    const sessionMetrics: SessionMetricsService = options.sessionMetrics ?? {
        async queryMetrics(queryOptions?: QueryMetricsOptions): Promise<any> {
            if (capabilityClient) {
                const res = await capabilityClient.invoke('session:queryMetrics', [queryOptions])
                return res
            }
            const bridge = getHostBridge()
            if (typeof bridge?.SessionQueryMetrics === 'function') {
                return bridge.SessionQueryMetrics(queryOptions as any)
            }
            return {
                summary: {
                    totalTokens: 0,
                    totalCost: 0,
                    maxTaskDurationMs: 0,
                    currentStreakDays: 0,
                    longestStreakDays: 0,
                    fastMode: { count: 0, percentage: 0 },
                    topReasoningEffort: null,
                    uniqueSkillsCount: 0,
                    totalSkillInvocations: 0,
                    totalChats: 0,
                    topSkills: [],
                    topModels: [],
                },
                buckets: [],
            }
        },
    }

    const displayMessagesCache = new WeakMap<any[], any[]>()
    const emptyDisplayMessagesCache = new Map<string, any[]>()

    const chatMessages: ChatMessageService = options.chatMessages ?? {
        getDisplayMessages(sessionId: string): readonly any[] {
            const entries = useMessageStore.getState().entriesBySession[sessionId]
            if (!entries || entries.length === 0) {
                let cachedEmpty = emptyDisplayMessagesCache.get(sessionId)
                if (!cachedEmpty) {
                    cachedEmpty = Object.freeze([]) as unknown as any[]
                    emptyDisplayMessagesCache.set(sessionId, cachedEmpty)
                }
                return cachedEmpty
            }
            const cached = displayMessagesCache.get(entries)
            if (cached) return cached
            const projected = Object.freeze(useMessageStore.getState().getDisplayMessages(sessionId)) as any[]
            displayMessagesCache.set(entries, projected)
            return projected
        },
        getEntries(sessionId: string): readonly any[] {
            return useMessageStore.getState().getEntries(sessionId)
        },
        replaceSessionEntries(sessionId: string, entries: readonly any[]): void {
            useMessageStore.getState().replaceSessionEntries(sessionId, entries as any)
        },
        subscribeMessages(sessionId: string, listener: () => void): () => void {
            const releaseSession = retainMessageSession(sessionId)
            let previousEntries = useMessageStore.getState().entriesBySession[sessionId]
            const unsubscribe = useMessageStore.subscribe((state) => {
                const nextEntries = state.entriesBySession[sessionId]
                if (Object.is(previousEntries, nextEntries)) return
                previousEntries = nextEntries
                listener()
            })
            return () => {
                unsubscribe()
                releaseSession()
            }
        },
        async ensureSessionLoaded(sessionId: string): Promise<void> {
            await ensureSessionLoaded(sessionId)
        },
        schedulePersist(immediate?: boolean): void {
            schedulePersist(immediate)
        },
        async forkSession(
            sessionId: string,
            atEntryId?: string,
            options?: ForkSessionExtraOptions,
        ): Promise<string | undefined> {
            await ensureSessionLoaded(sessionId)
            const res = forkSession({
                sessionId,
                messageId: atEntryId,
                ...options,
            })
            return res ?? undefined
        },
        async executeHook(_hookName: string, sessionId: string, _context?: unknown): Promise<void> {
            await executeSessionCompletionHook(sessionId)
        },
        getToolOverlays(sessionId: string): Readonly<Record<string, any>> {
            return useToolOverlayStore.getState().bySession[sessionId] ?? EMPTY_TOOL_OVERLAYS
        },
        subscribeToolOverlays(_sessionId: string, listener: () => void): () => void {
            return useToolOverlayStore.subscribe(() => {
                listener()
            })
        },
        isCompacting(sessionId: string): boolean {
            return Boolean(useCompactionOverlayStore.getState().bySession[sessionId])
        },
        subscribeCompaction(_sessionId: string, listener: () => void): () => void {
            return useCompactionOverlayStore.subscribe(() => {
                listener()
            })
        },
        getWorktreeSetup(sessionId: string): any {
            return useWorktreeSetupStore.getState().setups[sessionId]
        },
        subscribeWorktreeSetup(_sessionId: string, listener: () => void): () => void {
            return useWorktreeSetupStore.subscribe(() => {
                listener()
            })
        },
        async retryWorktreeSetup(sessionId: string): Promise<{ ok: boolean }> {
            return useWorktreeSetupStore.getState().retrySetup(sessionId)
        },
        async continueAnywayWorktreeSetup(sessionId: string): Promise<void> {
            await useWorktreeSetupStore.getState().continueAnyway(sessionId)
        },
        async autoFixWorktreeSetup(_sessionId: string): Promise<void> {
            // Handled via agent prompt in UI
        },
        toggleWorktreeSetupDetails(sessionId: string): void {
            useWorktreeSetupStore.getState().toggleDetails(sessionId)
        },
        approveTool(toolId: string): void {
            const controller = options.agentService ?? activeAgentController
            if (controller?.approveTool) {
                controller.approveTool(toolId)
            }
        },
        rejectTool(toolId: string): void {
            const controller = options.agentService ?? activeAgentController
            if (controller?.rejectTool) {
                controller.rejectTool(toolId)
            }
        },
        async dequeueMessage(sessionId: string, messageId: string): Promise<{ text: string; images?: any[] } | null | undefined> {
            const controller = options.agentService ?? activeAgentController
            if (controller?.dequeueMessage) {
                return controller.dequeueMessage(sessionId, messageId)
            }
            return null
        },
        async send(payload: ChatSendPayload): Promise<string | null | undefined> {
            const controller = options.agentService ?? activeAgentController
            if (controller?.send) {
                return controller.send(payload)
            }
            return undefined
        },
        async retrySession(sessionId: string): Promise<void> {
            const controller = options.agentService ?? activeAgentController
            if (controller?.retrySession) {
                await controller.retrySession(sessionId)
            }
        },
        async resumeSession(sessionId: string): Promise<string | null> {
            const controller = options.agentService ?? activeAgentController
            if (controller?.resumeSession) {
                return controller.resumeSession(sessionId)
            }
            return null
        },
        isSessionResumable(sessionId: string): boolean {
            if (!sessionId) return false
            const activeRuns = useSessionRunStore.getState().activeRuns
            const runState = activeRuns[sessionId]
            if (runState && runState.status && runState.status !== 'idle') {
                return false
            }
            const entries = useMessageStore.getState().getEntries(sessionId)
            const subAgents = useSubAgentStore.getState().agents
            return isSessionResumable(entries, subAgents, sessionId)
        },
        subscribeSessionResumable(sessionId: string, listener: () => void): () => void {
            if (!sessionId) return () => {}
            const unsubMessages = useMessageStore.subscribe(listener)
            const unsubRuns = useSessionRunStore.subscribe(listener)
            const unsubSubAgents = useSubAgentStore.subscribe(listener)
            return () => {
                unsubMessages()
                unsubRuns()
                unsubSubAgents()
            }
        },
        stop(sessionId?: string | null): void {
            const controller = options.agentService ?? activeAgentController
            const target = sessionId !== undefined ? (sessionId || undefined) : (useSessionStore.getState().currentSessionId ?? undefined)
            if (controller?.stop) {
                controller.stop(target ?? undefined)
                return
            }
            if (controller?.abort) {
                controller.abort(target ?? undefined)
                return
            }
            if (target) {
                void capabilityClient?.invoke('sessions:abortRun', [target]).catch(() => {
                    // best-effort
                })
                const bridge = getHostBridge()
                if (bridge?.SessionAbortRun) {
                    void bridge.SessionAbortRun(target)
                }
            }
        },
        abort(sessionId?: string | null): void {
            const controller = options.agentService ?? activeAgentController
            const target = sessionId !== undefined ? (sessionId || undefined) : (useSessionStore.getState().currentSessionId ?? undefined)
            if (controller?.abort) {
                controller.abort(target ?? undefined)
                return
            }
            if (controller?.stop) {
                controller.stop(target ?? undefined)
                return
            }
            if (target) {
                void capabilityClient?.invoke('sessions:abortRun', [target]).catch(() => {
                    // best-effort
                })
                const bridge = getHostBridge()
                if (bridge?.SessionAbortRun) {
                    void bridge.SessionAbortRun(target)
                }
            }
        },
        async compact(focus: string, sessionId?: string | null): Promise<void> {
            const controller = options.agentService ?? activeAgentController
            const target = sessionId ?? useSessionStore.getState().currentSessionId
            if (controller?.compact) {
                await controller.compact(focus, target)
                return
            }
            if (target && controller?.send) {
                await controller.send({
                    text: `/compact ${focus}`.trim(),
                    sessionId: target,
                })
            }
        },
        getPrompts(): readonly any[] {
            const controller = options.agentService ?? activeAgentController
            if (controller?.getPrompts) {
                return controller.getPrompts() ?? EMPTY_PROMPTS_LIST
            }
            return EMPTY_PROMPTS_LIST
        },
        subscribePrompts(listener: () => void): () => void {
            const controller = options.agentService ?? activeAgentController
            if (controller?.subscribePrompts) {
                return controller.subscribePrompts(listener)
            }
            return () => {}
        },
        getSupportsImages(sessionId?: string | null): boolean {
            const target = sessionId ?? useSessionStore.getState().currentSessionId
            const session = target ? useSessionStore.getState().sessions.find((s) => s.id === target) : undefined
            const effectiveModelId = session?.modelId ?? useSettingsStore.getState().settings.modelId
            const models = useModelCatalogStore.getState().models
            const model = models.find((m) => m.id === effectiveModelId)
            return Boolean(model?.input?.includes('image'))
        },
        subscribeSupportsImages(_sessionId: string | null, listener: () => void): () => void {
            const unsubSettings = useSettingsStore.subscribe(listener)
            const unsubSessions = useSessionStore.subscribe(listener)
            const unsubCatalog = useModelCatalogStore.subscribe(listener)
            return () => {
                unsubSettings()
                unsubSessions()
                unsubCatalog()
            }
        },
        getAgentRunState(sessionId: string): AgentRunState {
            if (!sessionId) {
                return { isStreaming: false, activeRunId: null }
            }
            const controller = options.agentService ?? activeAgentController
            const controllerState = controller?.getRunState?.(sessionId)
            const activeRuns = useSessionRunStore.getState().activeRuns
            const runState = activeRuns[sessionId]
            const isRemoteStreaming = Boolean(
                runState &&
                runState.status !== 'idle' &&
                runState.status !== 'error'
            )
            const isStreaming = Boolean(controllerState?.isStreaming || isRemoteStreaming)
            const activeRunId = controllerState?.activeRunId ?? runState?.runId ?? null
            const cached = agentRunStateCache.get(sessionId)
            if (
                cached &&
                cached.isStreaming === isStreaming &&
                cached.activeRunId === activeRunId &&
                cached.runState === runState
            ) {
                return cached
            }
            const nextState: AgentRunState = {
                isStreaming,
                activeRunId,
                runState,
            }
            agentRunStateCache.set(sessionId, nextState)
            return nextState
        },
        subscribeAgentRunState(sessionId: string, listener: () => void): () => void {
            if (!sessionId) return () => {}
            const unsubStore = useSessionRunStore.subscribe(() => {
                listener()
            })
            const controller = options.agentService ?? activeAgentController
            const unsubController = controller?.subscribeRunState?.(sessionId, listener)
            return () => {
                unsubStore()
                unsubController?.()
            }
        },
    }

    const effectiveRendererRegistry = options.rendererRegistry ?? rendererRegistry

    const rendererContributions: RendererContributionsService = {
        getSlotContributions<T = Record<string, unknown>>(slotName: string) {
            return effectiveRendererRegistry.getSlotContributions<T>(slotName) as any
        },
        subscribeSlot(slotName: string, listener: () => void) {
            return effectiveRendererRegistry.subscribe(`slot:${slotName}`, listener)
        },
        getChatRenderers<T = unknown>() {
            return effectiveRendererRegistry.getChatRenderers<T>()
        },
        selectChatRenderer<T = unknown>(value: T, opts?: any) {
            return effectiveRendererRegistry.selectChatRenderer<T>(value, opts)
        },
        subscribeChatRenderers(listener: () => void) {
            return effectiveRendererRegistry.subscribe('chat-renderer', listener)
        },
        getComposerControls(placement?: 'context' | 'toolbar-left' | 'toolbar-right') {
            return effectiveRendererRegistry.getComposerControls(placement)
        },
        subscribeComposerControls(listener: () => void) {
            return effectiveRendererRegistry.subscribe('composer', listener)
        },
        getAttachmentProviders() {
            return effectiveRendererRegistry.getAttachmentProviders()
        },
        subscribeAttachmentProviders(listener: () => void) {
            return effectiveRendererRegistry.subscribe('composer', listener)
        },
        getSubmitPreprocessors() {
            return effectiveRendererRegistry.getSubmitPreprocessors()
        },
        subscribeSubmitPreprocessors(listener: () => void) {
            return effectiveRendererRegistry.subscribe('composer', listener)
        },
        runSubmitPreprocessors(payload: any, ctx?: any) {
            const preprocessors = effectiveRendererRegistry.getSubmitPreprocessors()
            let currentPayload = { ...payload }
            for (let i = 0; i < preprocessors.length; i++) {
                const prep = preprocessors[i]!
                try {
                    const next = prep.preprocess(currentPayload, ctx)
                    if (next && typeof (next as any).then === 'function') {
                        return (async () => {
                            let accum = currentPayload
                            try {
                                const resolved = await next
                                if (resolved && typeof resolved === 'object') {
                                    accum = resolved
                                }
                            } catch (err) {
                                console.error(`[runSubmitPreprocessors] Error in preprocessor "${prep.id}":`, err)
                            }
                            for (let j = i + 1; j < preprocessors.length; j++) {
                                const nextP = preprocessors[j]!
                                try {
                                    const res = await nextP.preprocess(accum, ctx)
                                    if (res && typeof res === 'object') {
                                        accum = res
                                    }
                                } catch (err) {
                                    console.error(`[runSubmitPreprocessors] Error in preprocessor "${nextP.id}":`, err)
                                }
                            }
                            return accum
                        })()
                    }
                    if (next && typeof next === 'object') {
                        currentPayload = next
                    }
                } catch (err) {
                    console.error(`[runSubmitPreprocessors] Error in preprocessor "${prep.id}":`, err)
                }
            }
            return currentPayload
        },
        getComponentWrappers<P extends object = Record<string, unknown>>(componentName: string) {
            return effectiveRendererRegistry.getComponentWrappers<P>(componentName) as any
        },
        subscribeComponentWrappers(componentName: string, listener: () => void) {
            return effectiveRendererRegistry.subscribe(`componentWrapper:${componentName}`, listener)
        },
    }

    const modelsService: ModelCatalogService = {
        getModels() {
            return useModelCatalogStore.getState().models
        },
        getStatus() {
            return useModelCatalogStore.getState().status
        },
        getError() {
            return useModelCatalogStore.getState().error
        },
        subscribe(listener: () => void) {
            return useModelCatalogStore.subscribe(listener)
        },
        async refresh() {
            const settings = useSettingsStore.getState().settings
            await refreshModelCatalog({
                baseUrl: settings.cliProxyApi.baseUrl,
                apiKey: settings.cliProxyApi.apiKey,
            })
        },
    }

    const subAgentsByParentCache = new WeakMap<any[], Map<string, readonly any[]>>()
    const EMPTY_STRING_LIST: readonly string[] = Object.freeze([])

    const subAgents: SubAgentService = options.subAgents ?? {
        getAgents(parentSessionId?: string) {
            const all = useSubAgentStore.getState().agents
            if (!parentSessionId) return all
            let parentMap = subAgentsByParentCache.get(all)
            if (!parentMap) {
                parentMap = new Map()
                subAgentsByParentCache.set(all, parentMap)
            }
            let cached = parentMap.get(parentSessionId)
            if (!cached) {
                cached = Object.freeze(agentsForParent(all, parentSessionId))
                parentMap.set(parentSessionId, cached)
            }
            return cached
        },
        getAgent(agentId: string) {
            return useSubAgentStore.getState().agents.find((a) => a.id === agentId)
        },
        subscribe(listener: () => void) {
            return useSubAgentStore.subscribe(listener)
        },
        openTab(parentSessionId: string, agentId: string) {
            useSubAgentStore.getState().openTab(parentSessionId, agentId)
        },
        closeTab(parentSessionId: string, agentId: string) {
            useSubAgentStore.getState().closeTab(parentSessionId, agentId)
        },
        focusTab(parentSessionId: string, agentId: string | null) {
            useSubAgentStore.getState().focusTab(parentSessionId, agentId)
        },
        getOpenTabIds(parentSessionId: string) {
            return useSubAgentStore.getState().openTabIdsByParent[parentSessionId] ?? EMPTY_STRING_LIST
        },
        getFocusedId(parentSessionId: string) {
            return useSubAgentStore.getState().focusedIdByParent[parentSessionId] ?? null
        },
    }

    setWorktreeRunner(worktrees.setup)

    const gatewayDiscoveryService: GatewayDiscoveryService = {
        discover: async (timeoutMs = 3000) => {
            const bridge = getHostBridge()
            return (await bridge.GatewayDiscover(timeoutMs)) as DiscoveredGateway[]
        },
    }

    const hostServices: HostServices = {
        sessions,
        projects,
        settings,
        worktrees,
        hooks,
        navigation,
        notifications,
        schedule,
        skillUsage,
        persistence,
        ui,
        webServer,
        fileSystem,
        personalization,
        pluginManagement,
        sessionMetrics,
        process: processService,
        chatMessages,
        agentRun: {
            send: (payload: any) => (chatMessages.send ? chatMessages.send(payload) : Promise.resolve(undefined)),
            stop: (sId: any) => chatMessages.stop?.(sId),
            abort: (sId: any) => chatMessages.abort?.(sId),
            compact: (focus: any, sId: any) => (chatMessages.compact ? chatMessages.compact(focus, sId) : Promise.resolve()),
            retrySession: (sId: any) => (chatMessages.retrySession ? chatMessages.retrySession(sId) : Promise.resolve()),
            resumeSession: (sId: any) => (chatMessages.resumeSession ? chatMessages.resumeSession(sId) : Promise.resolve(null)),
            getRunState: (sId: any) => (chatMessages.getAgentRunState ? chatMessages.getAgentRunState(sId) : { isStreaming: false, activeRunId: null }),
            subscribeRunState: (sId: any, listener: any) => (chatMessages.subscribeAgentRunState ? chatMessages.subscribeAgentRunState(sId, listener) : () => {}),
            getSupportsImages: (sId: any) => (chatMessages.getSupportsImages ? chatMessages.getSupportsImages(sId) : true),
            subscribeSupportsImages: (sId: any, listener: any) => (chatMessages.subscribeSupportsImages ? chatMessages.subscribeSupportsImages(sId, listener) : () => {}),
            getPrompts: () => (chatMessages.getPrompts ? chatMessages.getPrompts() : EMPTY_PROMPTS_LIST),
            subscribePrompts: (listener: any) => (chatMessages.subscribePrompts ? chatMessages.subscribePrompts(listener) : () => {}),
        },
        models: modelsService,
        rendererContributions,
        subAgents,
        gatewayDiscovery: gatewayDiscoveryService,
    }

    setDefaultHostServices(hostServices)

    return hostServices
}

const EMPTY_PROMPTS_LIST: readonly any[] = Object.freeze([])

let defaultHostServices: HostServices | null = null
let defaultHostRouter: RouterLike | null = null

export interface HostAgentController {
    send(payload: ChatSendPayload, opts?: { onSessionAccepted?: (sessionId: string) => void }): Promise<string | null | undefined>
    stop?(sessionId?: string | null): void
    abort?(sessionId?: string | null): void
    compact?(focus: string, sessionId?: string | null): Promise<void>
    retrySession?(sessionId: string): Promise<void>
    resumeSession?(sessionId: string): Promise<string | null>
    approveTool?(toolId: string): void
    rejectTool?(toolId: string): void
    dequeueMessage?(sessionId: string, messageId: string): Promise<{ text: string; images?: any[] } | null | undefined> | { text: string; images?: any[] } | null | undefined
    getPrompts?(): readonly any[]
    subscribePrompts?(listener: () => void): () => void
    getRunState?(sessionId: string): AgentRunState | undefined
    subscribeRunState?(sessionId: string, listener: () => void): () => void
}

let activeAgentController: HostAgentController | null = null
const activeControllers = new Set<HostAgentController>()

export function registerHostAgentController(controller: HostAgentController): () => void {
    activeControllers.add(controller)
    activeAgentController = controller
    return () => {
        activeControllers.delete(controller)
        if (activeAgentController === controller) {
            const remaining = Array.from(activeControllers)
            activeAgentController = remaining.length > 0 ? remaining[remaining.length - 1]! : null
        }
    }
}

export function getHostAgentController(): HostAgentController | null {
    return activeAgentController
}

export function getHostRouter(): RouterLike | null {
    return defaultHostRouter
}

export function setHostRouter(router: RouterLike | null): void {
    defaultHostRouter = router
}

export function getHostServices(): HostServices {
    if (!defaultHostServices) {
        defaultHostServices = createHostServices()
        setDefaultHostServices(defaultHostServices)
    }
    return defaultHostServices
}

export function setHostServices(services: HostServices): void {
    defaultHostServices = services
    setDefaultHostServices(services)
}

// Eagerly initialize default host services for global access
getHostServices()
