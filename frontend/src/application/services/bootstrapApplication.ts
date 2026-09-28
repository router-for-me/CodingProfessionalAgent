import type { ResolvedPluginGraphDTO, ResolvedPluginPackage } from '@cpa/plugin-api'
import { pluginPlatformCoordinator, type MainGenerationParticipant } from '@/plugins/platform'
import { getHostServices } from './createHostServices'
import {
    hydrateEmptySessionFromDisk,
    fastForwardSessionOnWake,
    hasPendingSessionMetadata,
    deleteSessionLocalCache,
    hasUnsavedSessionHistory,
    initPersistence,
    invalidateSessionDiskCache,
    reloadSessionFromDisk,
    withSuppressedPersistence,
} from './persistenceService'
import { getHostBridge, subscribeHostNativeEvents, onHostReconnect } from './hostTransport'
import { isBrowserEnvironment } from '@/lib/platform'
import { setProtectedSessionPredicate, useMessageStore } from '@/stores/messageStore'
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

let bootstrapDisposers: Array<() => void> = []
let bootstrapGeneration = 0
let wakeTask: Promise<void> | null = null
let wakeSessionId: string | null = null
let wakeAgain = false
let runRecheck: ReturnType<typeof setTimeout> | null = null
let wakeRetryTimer: ReturnType<typeof setTimeout> | null = null
let wakeRetryCount = 0
let cancelWakeStatus: (() => void) | null = null
const pendingRunReads = new Set<string>()

export function disposeBootstrapSubscriptions(): void {
    bootstrapGeneration += 1
    cancelWakeStatus?.()
    cancelWakeStatus = null
    for (const dispose of bootstrapDisposers.splice(0)) dispose()
    if (runRecheck !== null) clearTimeout(runRecheck)
    if (wakeRetryTimer !== null) clearTimeout(wakeRetryTimer)
    runRecheck = null
    wakeRetryTimer = null
    wakeRetryCount = 0
    pendingRunReads.clear()
    wakeTask = null
    wakeSessionId = null
    wakeAgain = false
}

function coordinateWake(invalidated = false): void {
    if (!isBrowserEnvironment()) return
    const sessionId = useSessionStore.getState().currentSessionId
    if (wakeTask) {
        if (invalidated || sessionId !== wakeSessionId) wakeAgain = true
        return
    }
    const generation = bootstrapGeneration
    wakeSessionId = sessionId
    // Register the read barrier before the first network response or a new send can race it.
    let valid = true
    let resolveStatus!: (known: boolean) => void
    const statusReady = new Promise<boolean>((resolve) => { resolveStatus = resolve })
    const timeout = setTimeout(() => finishStatus(false), 5000)
    const finishStatus = (known: boolean) => {
        clearTimeout(timeout)
        if (!known) valid = false
        if (cancelWakeStatus === cancelStatus) cancelWakeStatus = null
        resolveStatus(valid && known)
    }
    const cancelStatus = () => finishStatus(false)
    cancelWakeStatus = cancelStatus
    const sync = resyncFromMain(generation, finishStatus, sessionId ?? undefined, () => valid)
      .catch((error) => { finishStatus(false); throw error })
    const readyForRead = statusReady.then((known) => {
        if (known && sessionId && useSessionRunStore.getState().activeRuns[sessionId] &&
            useSessionRunStore.getState().activeRuns[sessionId].status !== 'idle') pendingRunReads.add(sessionId)
        if (!known) throw new Error('Unable to verify session run status after reconnect')
        return known
    })
    const read = sessionId
        ? fastForwardSessionOnWake(sessionId, readyForRead, () => generation === bootstrapGeneration)
        : readyForRead.then(() => {})
    wakeTask = Promise.all([read, sync]).then(() => {
        wakeRetryCount = 0
        if (generation !== bootstrapGeneration || !sessionId) return
        if (useSessionRunStore.getState().activeRuns[sessionId]?.status !== undefined &&
            useSessionRunStore.getState().activeRuns[sessionId]?.status !== 'idle') {
            pendingRunReads.add(sessionId)
            const run = useSessionRunStore.getState().activeRuns[sessionId]
            if (run && Date.now() - run.updatedAt < 2000 && runRecheck === null) {
                runRecheck = setTimeout(() => {
                    runRecheck = null
                    if (generation === bootstrapGeneration) coordinateWake(true)
                }, Math.max(1, 2000 - (Date.now() - run.updatedAt)))
            }
        } else {
            pendingRunReads.delete(sessionId)
        }
    }).catch((err) => {
        console.warn('Session wake synchronization deferred:', err)
        if (generation === bootstrapGeneration && sessionId === useSessionStore.getState().currentSessionId &&
            wakeRetryCount < 3 && wakeRetryTimer === null) {
            wakeRetryCount += 1
            wakeRetryTimer = setTimeout(() => {
                wakeRetryTimer = null
                coordinateWake(true)
            }, 250 * wakeRetryCount)
        }
    }).finally(() => {
        if (generation !== bootstrapGeneration) return
        wakeTask = null
        wakeSessionId = null
        if (wakeAgain) {
            wakeAgain = false
            coordinateWake()
        }
    })
}

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
export async function resyncFromMain(
    generation?: number,
    onRunsReady?: (known: boolean) => void,
    targetSessionId?: string,
    isValid: () => boolean = () => true,
): Promise<boolean> {
    const stillActive = () => (generation === undefined || generation === bootstrapGeneration) && isValid()
    const bridge = getHostBridge()
    const hostServices = getHostServices()
    let runsKnown = false
    if (typeof bridge?.SessionGetActiveRuns === 'function') {
        const runsAtRequest = useSessionRunStore.getState().activeRuns
        try {
            const runs = await bridge.SessionGetActiveRuns()
            if (!stillActive()) {
                onRunsReady?.(false)
                return false
            }
            const currentRuns = useSessionRunStore.getState().activeRuns
            if (Array.isArray(runs) && (targetSessionId
                ? currentRuns[targetSessionId] === runsAtRequest[targetSessionId]
                : currentRuns === runsAtRequest)) {
                const changedIds = Object.keys({ ...runsAtRequest, ...currentRuns })
                    .filter((id) => id !== targetSessionId && currentRuns[id] !== runsAtRequest[id])
                const freshRuns = runs.filter((run: ActiveRunInfo) => !changedIds.includes(run.sessionId))
                for (const id of changedIds) {
                    if (currentRuns[id]) freshRuns.push(currentRuns[id])
                }
                useSessionRunStore.getState().hydrate(freshRuns)
                runsKnown = true
            }
        } catch (err) {
            console.error('Failed to resync active runs from main:', err)
        }
    }
    onRunsReady?.(runsKnown)
    if (typeof bridge?.KVStoreGet === 'function') {
        try {
            const projects = await bridge.KVStoreGet('projects')
            if (!stillActive()) return false
            syncProjectsFromMain(projects)
        } catch (err) {
            console.error('Failed to resync projects from main:', err)
        }
    }
    if (typeof bridge?.SessionListSessions === 'function') {
        try {
            const sessions = await hostServices.sessions.list()
            if (!stillActive()) return false
            if (Array.isArray(sessions)) {
                const remoteIds = new Set(sessions.map((s) => s.id))
                const localSessions = useSessionStore.getState().sessions
                withSuppressedPersistence(() => {
                    for (const remoteSession of sessions) {
                        if (!hasPendingSessionMetadata(remoteSession.id)) {
                            useSessionStore.getState().upsertRemoteSession(remoteSession as Session)
                        }
                    }
                    for (const localSession of localSessions) {
                        if (!remoteIds.has(localSession.id)) {
                            useSessionStore.getState().removeRemoteSession(localSession.id)
                            void deleteSessionLocalCache(localSession.id)
                        }
                    }
                })
            }
        } catch (err) {
            console.error('Failed to resync sessions from main:', err)
        }
    }
    if (typeof bridge?.SessionGetResumePromptState === 'function') {
        try {
            const promptState = await bridge.SessionGetResumePromptState()
            if (!stillActive()) return false
            if (promptState && typeof promptState === 'object') {
                useResumePromptStore.getState().syncState(promptState)
            }
        } catch (err) {
            console.error('Failed to resync resume prompt state from main:', err)
        }
    }
    if (!stillActive()) return false
    void hostServices.skillUsage.fetchUsageCounts().catch(() => {})
    return runsKnown
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
    disposeBootstrapSubscriptions()
    const generation = bootstrapGeneration
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
    setProtectedSessionPredicate((sessionId) => {
        const run = useSessionRunStore.getState().activeRuns[sessionId]
        return useSessionStore.getState().currentSessionId === sessionId ||
            Boolean(run && run.status !== 'idle') || hasUnsavedSessionHistory(sessionId)
    })
    await initPersistence()

    void hostServices.skillUsage.fetchUsageCounts().catch(() => {})

    bootstrapDisposers.push(subscribeHostNativeEvents(async (event) => {
        if (generation !== bootstrapGeneration) return
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
                if (sessionItem && sessionItem.id && !hasPendingSessionMetadata(sessionItem.id)) {
                    withSuppressedPersistence(() => {
                        useSessionStore.getState().upsertRemoteSession(sessionItem)
                        const current = useSessionStore.getState().currentSessionId
                        if (current === sessionItem.id && sessionItem.rightSidebar !== undefined) {
                            useUiStore.getState().restoreForSession(sessionItem.rightSidebar)
                        }
                    })
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (event.kind === 'session:deleted' && event.data) {
            try {
                const { sessionId } = JSON.parse(event.data) as { sessionId: string }
                if (sessionId) {
                    useSessionStore.getState().removeRemoteSession(sessionId)
                    void deleteSessionLocalCache(sessionId)
                    useSessionRunStore.getState().clearRun(sessionId)
                    pendingRunReads.delete(sessionId)
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
                        if (isRunning) pendingRunReads.add(sessionId)
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
                    withSuppressedPersistence(() => useSubAgentStore.getState().mergeHostAgents(agents))
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
        } else if (event.kind === 'notification:navigate-session' && event.data) {
            try {
                const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
                const targetSessionId = payload?.sessionId || payload
                if (typeof targetSessionId === 'string' && targetSessionId) {
                    window.location.hash = `#/chat/${targetSessionId}`
                }
            } catch (err) {
                console.warn('[Bootstrap] Failed to parse notification navigate session event:', err)
            }
        } else if (event.kind === 'plugins:updated') {
            void hostServices.pluginManagement?.refresh?.().catch(() => {})
        }
    }))

    bootstrapDisposers.push(onHostReconnect(() => {
        if (isBrowserEnvironment()) {
            const current = useSessionStore.getState().currentSessionId
            for (const sessionId of Object.keys(useMessageStore.getState().entriesBySession)) {
                if (sessionId !== current) invalidateSessionDiskCache(sessionId)
            }
            coordinateWake()
        } else {
            void resyncFromMain(generation)
        }
    }))
    if (isBrowserEnvironment() && typeof document !== 'undefined') {
        let previousVisibility = document.visibilityState
        const onVisibility = () => {
            const wasHidden = previousVisibility === 'hidden'
            previousVisibility = document.visibilityState
            if (wasHidden && previousVisibility === 'visible') coordinateWake()
        }
        document.addEventListener('visibilitychange', onVisibility)
        bootstrapDisposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
    }
    bootstrapDisposers.push(useSessionRunStore.subscribe((state, previous) => {
        for (const sessionId of pendingRunReads) {
            if (previous.activeRuns[sessionId] && previous.activeRuns[sessionId].status !== 'idle' &&
                (!state.activeRuns[sessionId] || state.activeRuns[sessionId].status === 'idle')) {
                pendingRunReads.delete(sessionId)
                if (sessionId === useSessionStore.getState().currentSessionId) coordinateWake(true)
            }
        }
    }))
    bootstrapDisposers.push(useSessionStore.subscribe((state, previous) => {
        if (state.currentSessionId !== previous.currentSessionId && wakeTask) wakeAgain = true
    }))

    // Initial authoritative synchronization from main process (projects, sessions, active runs, resume prompts)
    await resyncFromMain(generation)

    // Synchronize watched project environments
    if (typeof bridge?.WatchProjectEnvironments === 'function') {
        const initialPaths = useProjectStore.getState().projects.flatMap((p) => getProjectPaths(p))
        if (initialPaths.length > 0) {
            bridge.WatchProjectEnvironments(initialPaths).catch(() => {})
        }

        bootstrapDisposers.push(useProjectStore.subscribe((state, prevState) => {
            if (state.projects !== prevState.projects) {
                const paths = state.projects.flatMap((p) => getProjectPaths(p))
                bridge?.WatchProjectEnvironments?.(paths)?.catch(() => {})
            }
        }))
    }
}
