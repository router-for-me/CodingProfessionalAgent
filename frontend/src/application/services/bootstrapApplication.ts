import type { ResolvedPluginGraphDTO, ResolvedPluginPackage } from '@cpa/plugin-api'
import { pluginPlatformCoordinator, type MainGenerationParticipant } from '@/plugins/platform'
import { getHostServices } from './createHostServices'
import {
    hydrateEmptySessionFromDisk,
    initPersistence,
    invalidateSessionDiskCache,
    reloadSessionFromDisk,
    withSuppressedPersistence,
} from './persistenceService'
import { getHostBridge, subscribeHostNativeEvents, onHostReconnect } from './hostTransport'
import { useMessageStore } from '@/stores/messageStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useResumePromptStore } from '@/stores/resumePromptStore'
import { useUiStore } from '@/stores/uiStore'
import { invalidateProjectEnvironmentCache } from '@/lib/environmentToml'
import { getProjectPaths } from '@/lib/projectPaths'
import type { ActiveRunInfo, ResumePromptSyncState } from '@/features/agent-runtime/native/types'
import type { SubAgentRecord } from '@cpa/plugin-api'
import type { Project, Session } from '@/types/models'

function syncProjectsFromMain(value: unknown): void {
    if (!Array.isArray(value)) return
    const projects = value as Project[]
    const currentProjects = useProjectStore.getState().projects
    if (JSON.stringify(currentProjects) === JSON.stringify(projects)) return
    withSuppressedPersistence(() => {
        useProjectStore.getState().hydrate(projects)
    })
}

/**
 * Re-fetches authoritative projects, sessions, and active runs from main process and syncs stores.
 */
export async function resyncFromMain(): Promise<void> {
    const bridge = getHostBridge()
    const hostServices = getHostServices()
    if (typeof bridge?.KVStoreGet === 'function') {
        try {
            syncProjectsFromMain(await bridge.KVStoreGet('projects'))
        } catch (err) {
            console.error('Failed to resync projects from main:', err)
        }
    }
    if (typeof bridge?.SessionListSessions === 'function') {
        try {
            const sessions = await hostServices.sessions.list()
            if (Array.isArray(sessions)) {
                const remoteIds = new Set(sessions.map((s) => s.id))
                const localSessions = useSessionStore.getState().sessions
                for (const remoteSession of sessions) {
                    useSessionStore.getState().upsertRemoteSession(remoteSession as Session)
                }
                for (const localSession of localSessions) {
                    if (!remoteIds.has(localSession.id)) {
                        useSessionStore.getState().removeRemoteSession(localSession.id)
                    }
                }
            }
        } catch (err) {
            console.error('Failed to resync sessions from main:', err)
        }
    }
    if (typeof bridge?.SessionGetActiveRuns === 'function') {
        try {
            const runs = await bridge.SessionGetActiveRuns()
            if (Array.isArray(runs)) {
                useSessionRunStore.getState().hydrate(runs)
            }
        } catch (err) {
            console.error('Failed to resync active runs from main:', err)
        }
    }
    if (typeof bridge?.SessionGetResumePromptState === 'function') {
        try {
            const promptState = await bridge.SessionGetResumePromptState()
            if (promptState && typeof promptState === 'object') {
                useResumePromptStore.getState().syncState(promptState)
            }
        } catch (err) {
            console.error('Failed to resync resume prompt state from main:', err)
        }
    }
    void hostServices.skillUsage.fetchUsageCounts().catch(() => {})
}

/**
 * Bootstraps in-memory stores and services:
 * 1. Assemble HostServices
 * 2. Stage and commit unified plugin platform generation
 * 3. Load persisted app state and hydrate stores
 * 4. Load scheduled tasks & initialize scheduler
 * 5. Fetch initial skill usage counts
 * 6. Register real-time native event listeners & subscribers
 */
export async function bootstrapApplication(): Promise<void> {
    const hostServices = getHostServices()
    const bridge = getHostBridge()
    let graph: ResolvedPluginGraphDTO | ResolvedPluginPackage[] | undefined
    let mainParticipant: MainGenerationParticipant | undefined

    if (bridge) {
        const b = bridge as any
        if (
            typeof b.PluginsGetPreparedState === 'function' ||
            typeof b.PluginsCommitGeneration === 'function' ||
            typeof b.PluginsGetGraph === 'function'
        ) {
            mainParticipant = {
                async getPreparedState() {
                    if (typeof b.PluginsGetPreparedState === 'function') {
                        return b.PluginsGetPreparedState()
                    }
                    if (typeof b.PluginsGetGraph === 'function') {
                        try {
                            const graphResult = await b.PluginsGetGraph()
                            if (graphResult && typeof graphResult === 'object' && graphResult.revision) {
                                return {
                                    revision: graphResult.revision,
                                    generation: 1,
                                    graph: graphResult,
                                }
                            }
                        } catch (err) {
                            console.error('Failed to get plugin graph from main:', err)
                        }
                    }
                    return null
                },
                async commit(revision: string, generation: number) {
                    if (typeof b.PluginsCommitGeneration === 'function') {
                        await b.PluginsCommitGeneration(revision, generation)
                    }
                },
                async rollback(revision?: string, generation?: number) {
                    if (typeof b.PluginsRollbackGeneration === 'function') {
                        await b.PluginsRollbackGeneration(revision, generation)
                    }
                },
            }
        }

        if (typeof b.PluginsGetGraph === 'function') {
            try {
                const graphResult = await b.PluginsGetGraph()
                if (graphResult && typeof graphResult === 'object' && graphResult.revision) {
                    graph = graphResult
                }
            } catch (err) {
                console.error('Failed to get plugin graph from main:', err)
            }
        }
        if (!graph && typeof b.PluginsGetCatalog === 'function') {
            try {
                const catalogResult = await b.PluginsGetCatalog()
                if (Array.isArray(catalogResult)) {
                    graph = catalogResult
                }
            } catch (err) {
                console.error('Failed to get plugin catalog from main:', err)
            }
        }
    }

    await pluginPlatformCoordinator.activate(graph, { mainParticipant })
    await initPersistence()

    void hostServices.skillUsage.fetchUsageCounts().catch(() => {})

    subscribeHostNativeEvents(async (event) => {
        if (!event || !event.kind) return
        if (event.kind === 'projects:updated' && event.data) {
            try {
                syncProjectsFromMain(JSON.parse(event.data))
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:run-status' && event.data) {
            try {
                const runInfo = JSON.parse(event.data) as ActiveRunInfo
                if (runInfo.sessionId) {
                    useSessionRunStore.getState().setRun(runInfo.sessionId, runInfo)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:meta-updated' && event.data) {
            try {
                const sessionItem = JSON.parse(event.data) as Session
                if (sessionItem && sessionItem.id) {
                    useSessionStore.getState().upsertRemoteSession(sessionItem)
                    const current = useSessionStore.getState().currentSessionId
                    if (current === sessionItem.id && sessionItem.rightSidebar !== undefined) {
                        useUiStore.getState().restoreForSession(sessionItem.rightSidebar)
                    }
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:deleted' && event.data) {
            try {
                const { sessionId } = JSON.parse(event.data) as { sessionId: string }
                if (sessionId) {
                    useSessionStore.getState().removeRemoteSession(sessionId)
                    useSessionRunStore.getState().clearRun(sessionId)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:entries-updated' && event.data) {
            try {
                void hostServices.skillUsage.fetchUsageCounts().catch(() => {})
                const { sessionId } = JSON.parse(event.data) as { sessionId: string }
                if (sessionId) {
                    invalidateSessionDiskCache(sessionId)
                    const current = useSessionStore.getState().currentSessionId
                    const isRunning =
                        useSessionRunStore.getState().activeRuns[sessionId]?.status !== undefined &&
                        useSessionRunStore.getState().activeRuns[sessionId]?.status !== 'idle'
                    if (current === sessionId) {
                        if (!isRunning) {
                            await reloadSessionFromDisk(sessionId)
                        } else if (useMessageStore.getState().getEntries(sessionId).length === 0) {
                            await hydrateEmptySessionFromDisk(sessionId)
                        }
                    }
                }
            } catch {
                // Ignore error
            }
        } else if (event.kind === 'session:subagent-state' && event.data) {
            try {
                const { agents } = JSON.parse(event.data) as {
                    parentSessionId?: string
                    agents?: SubAgentRecord[]
                }
                if (agents && Array.isArray(agents)) {
                    useSubAgentStore.getState().mergeHostAgents(agents)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:resume-prompt-state' && event.data) {
            try {
                const promptState = JSON.parse(event.data) as ResumePromptSyncState
                if (promptState && typeof promptState === 'object') {
                    useResumePromptStore.getState().syncState(promptState)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'environment:changed' && event.data) {
            try {
                const payload = JSON.parse(event.data) as {
                    projectPath: string
                    hasEnv: boolean
                    filePath?: string
                    content?: string
                }
                if (payload.projectPath) {
                    invalidateProjectEnvironmentCache(payload.projectPath)
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(
                            new CustomEvent('cpa:environment-changed', { detail: payload }),
                        )
                    }
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'plugins:updated') {
            void hostServices.pluginManagement?.refresh?.().catch(() => {})
        }
    })

    onHostReconnect(() => {
        void resyncFromMain()
    })

    // Initial authoritative synchronization from main process (projects, sessions, active runs, resume prompts)
    await resyncFromMain()

    // Synchronize watched project environments
    if (typeof bridge?.WatchProjectEnvironments === 'function') {
        const initialPaths = useProjectStore.getState().projects.flatMap((p) => getProjectPaths(p))
        if (initialPaths.length > 0) {
            bridge.WatchProjectEnvironments(initialPaths).catch(() => {})
        }

        useProjectStore.subscribe((state, prevState) => {
            if (state.projects !== prevState.projects) {
                const paths = state.projects.flatMap((p) => getProjectPaths(p))
                bridge?.WatchProjectEnvironments?.(paths)?.catch(() => {})
            }
        })
    }
}
