/**
 * Single-flight agent stream hook.
 * Service is injected via React context (production CLIProxyAPIAgentService).
 * Per-service external store (WeakMap) keeps Home/Chat consumers in sync while
 * isolating multiple AgentServiceProvider trees.
 */

import { isBrowserEnvironment } from '@/lib/platform'
import { getHashRoutePathname } from '@cpa/plugin-ui'
import { getHostBridge, subscribeHostNativeEvents, onHostReconnect } from '@/application/services/hostTransport'
import { registerHostAgentController } from '@/application/services/createHostServices'
import type { SessionDelegateRunRequest } from '@/features/agent-runtime/native/types'
import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from 'react'
import { createId } from '@/lib/id'
import { getProjectPaths } from '@/lib/projectPaths'
import { deriveSessionTitle } from '@/lib/title'
import { createAgentEventAdapter } from '@/features/agent-runtime/ui/eventAdapter'
import type { AgentRunEvent } from '@/features/agent-runtime/agent/types'
import {
    collectSpawnAgentToolCallIds,
    isLinkedSubAgent,
} from '@/features/agent-runtime/host/SubAgentHost'
import type { SubAgentRecord } from '@cpa/plugin-api'
import {
    isSessionResumable,
    cleanUnfinishedEntries,
} from '@/features/agent-runtime/session/unfinished'
import type {
    AssistantEntry,
    ContentBlock,
    ConversationEntry,
    UserEntry,
} from '@/features/agent-runtime/session/types'
import type { Skill, PromptTemplate } from '@cpa/plugin-sdk'
import { useMessageStore } from '@/stores/messageStore'
import {
    deleteSessionEntries,
    ensureSessionLoaded,
    flushPendingPersistence,
    schedulePersist,
    withSuppressedPersistence,
} from '@/application/services/persistenceService'
import {
    recoverWorktreeRunPolicy,
    type WorktreeRunPolicy,
} from '@/features/agent-runtime/context/worktreeMode'
import type { ModelCatalogEntry } from '@/features/models/types'
import { useModelCatalogStore } from '@/stores/modelCatalogStore'
import { useProjectStore } from '@/stores/projectStore'
import type { Session } from '@/types/models'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import { useUiStore } from '@/stores/uiStore'
import type { ComposerImage, ComposerRunStatus } from '@cpa/plugin-api'
import i18n from '@/i18n'
import type { AgentService } from './AgentService'
import {
    AgentPreflightError,
    type PreparedAgentRun,
} from './types'
import type { QuickActionKind } from './templates'

export const AgentServiceContext = createContext<AgentService | null>(null)

export function AgentServiceProvider(props: {
    service: AgentService | null
    children?: ReactNode
}) {
    return createElement(
        AgentServiceContext.Provider,
        { value: props.service },
        props.children,
    )
}

export function useAgentService(): AgentService | null {
    return useContext(AgentServiceContext)
}

export type AgentSendPayload = {
    text: string
    images?: readonly ComposerImage[]
    kind?: QuickActionKind
    /** Pending project selection — hook creates session after preflight only. */
    projectId?: string | null
    scheduleId?: string | null
    parentSessionId?: string | null
    branch?: string | null
    workLocation?: 'local' | 'worktree'
    environmentId?: string | null
    /** Explicit session target used when resending an edited history entry. */
    sessionId?: string | null
    /** Existing user entry to replace; all later context is discarded. */
    editMessageId?: string
    userEntryId?: string
    requestId?: string
    queuedUserEntryIds?: string[]
    /** Original retry start time, preserved across worktree setup and delegation. */
    userEntryCreatedAt?: number
    followUpMode?: 'steer' | 'queue'
    isQueuedExecution?: boolean
    modelId?: string
    reasoningEffort?: string
    speed?: Session['speed']
    onSessionAccepted?: (sessionId: string) => void
    onRunFinish?: (succeeded: boolean) => void
}

export type AgentSendOptions = {
    kind?: QuickActionKind
    /** Called after session and user entry creation, before worktree setup completes. */
    onSessionAccepted?: (sessionId: string) => void
}

export type StreamSnapshot = {
    isStreaming: boolean
    runStatus: ComposerRunStatus
    sessionId: string | null
    runId: string | null
    skills: readonly Skill[]
    prompts: readonly PromptTemplate[]
    lastDiagnostics: readonly string[]
}

export type SessionRunFlight = {
    sessionId: string
    runId: string
    runStatus: ComposerRunStatus
    abortController: AbortController
    flightToken: number
}

type PendingPreflight = {
    token: number
    abortController: AbortController
    targetSessionId: string | null
}

type ServiceRuntime = {
    runs: Map<string, SessionRunFlight>
    pendingPreflights: Map<number, PendingPreflight>
    pendingSteers: Map<string, UserEntry[]>
    sessionQueues: Map<string, Array<{ entry: UserEntry; payload: AgentSendPayload; options?: AgentSendOptions }>>
    pendingDelegateRuns: SessionDelegateRunRequest[]
    inFlightDelegateRuns: Set<string>
    completedDelegateRuns: Set<string>
    flightFinishCallbacks: Map<number, Array<(succeeded: boolean) => void>>
    flightToken: number
    listeners: Set<() => void>
    /** True after disposeAgentRuntime — blocks late prepare session submit. */
    disposed: boolean
    hostedRunIds: Set<string>
    pendingTakeoverAborts: Set<string>
    inFlightTakeoverRunIds: Set<string>
    deletedSessionIds: Set<string>
    pendingSteerCallbacks: Map<string, Array<(succeeded: boolean) => void>>
    pendingSteerItems: Map<string, { entry: UserEntry; payload: AgentSendPayload; options?: AgentSendOptions }>
    skills: readonly Skill[]
    prompts: readonly PromptTemplate[]
    lastDiagnostics: readonly string[]
    snapshotCache: Map<string, StreamSnapshot>
    sendHandler?: (
        input: string | AgentSendPayload,
        opts?: AgentSendOptions,
    ) => Promise<string | null>
    sendInternalHandler?: (
        payload: AgentSendPayload,
        opts?: AgentSendOptions,
    ) => Promise<string | null>
}

const IDLE_SNAPSHOT: StreamSnapshot = {
    isStreaming: false,
    runStatus: 'idle',
    sessionId: null,
    runId: null,
    skills: [],
    prompts: [],
    lastDiagnostics: [],
}

const MAX_HOSTED_RUN_IDS = 2048

function rememberHostedRunId(rt: ServiceRuntime, runId: string): void {
    if (!runId) return
    rt.hostedRunIds.delete(runId)
    rt.hostedRunIds.add(runId)
    while (rt.hostedRunIds.size > MAX_HOSTED_RUN_IDS) {
        const oldest = rt.hostedRunIds.values().next().value
        if (typeof oldest !== 'string') break
        rt.hostedRunIds.delete(oldest)
    }
}

function prepareStreamEventForBroadcast(event: AgentRunEvent): AgentRunEvent {
    if (event.type !== 'assistant-update' || !('partial' in event.streamEvent)) {
        return event
    }
    const streamEvent = { ...event.streamEvent } as Record<string, unknown>
    delete streamEvent.partial
    return {
        ...event,
        streamEvent: streamEvent as typeof event.streamEvent,
    }
}

function getCacheKey(scopedSessionId?: string | null): string {
    if (scopedSessionId === null) return '__null__'
    if (typeof scopedSessionId === 'string') return scopedSessionId
    const currentSessionId = useSessionStore.getState().currentSessionId
    return currentSessionId ? `__current__:${currentSessionId}` : '__unscoped__'
}

function getSnapshotForSession(
    rt: ServiceRuntime,
    scopedSessionId?: string | null,
): StreamSnapshot {
    const key = getCacheKey(scopedSessionId)
    const cached = rt.snapshotCache.get(key)
    if (cached) return cached

    let snap: StreamSnapshot

    if (scopedSessionId === null) {
        let hasPending = false
        for (const p of rt.pendingPreflights.values()) {
            if (p.targetSessionId === null) {
                hasPending = true
                break
            }
        }
        snap = {
            isStreaming: hasPending,
            runStatus: hasPending ? 'loading-resources' : 'idle',
            sessionId: null,
            runId: null,
            skills: rt.skills,
            prompts: rt.prompts,
            lastDiagnostics: rt.lastDiagnostics,
        }
    } else if (typeof scopedSessionId === 'string') {
        const flight = rt.runs.get(scopedSessionId)
        if (flight) {
            snap = {
                isStreaming: true,
                runStatus: flight.runStatus,
                sessionId: flight.sessionId,
                runId: flight.runId,
                skills: rt.skills,
                prompts: rt.prompts,
                lastDiagnostics: rt.lastDiagnostics,
            }
        } else {
            let hasPending = false
            for (const p of rt.pendingPreflights.values()) {
                if (p.targetSessionId === scopedSessionId) {
                    hasPending = true
                    break
                }
            }
            snap = {
                isStreaming: hasPending,
                runStatus: hasPending ? 'loading-resources' : 'idle',
                sessionId: scopedSessionId,
                runId: null,
                skills: rt.skills,
                prompts: rt.prompts,
                lastDiagnostics: rt.lastDiagnostics,
            }
        }
    } else {
        // scopedSessionId is undefined (legacy / unscoped hook)
        const currentSessionId = useSessionStore.getState().currentSessionId
        if (currentSessionId) {
            const flight = rt.runs.get(currentSessionId)
            if (flight) {
                snap = {
                    isStreaming: true,
                    runStatus: flight.runStatus,
                    sessionId: flight.sessionId,
                    runId: flight.runId,
                    skills: rt.skills,
                    prompts: rt.prompts,
                    lastDiagnostics: rt.lastDiagnostics,
                }
            } else {
                let hasPending = false
                for (const p of rt.pendingPreflights.values()) {
                    if (p.targetSessionId === currentSessionId) {
                        hasPending = true
                        break
                    }
                }
                snap = {
                    isStreaming: hasPending,
                    runStatus: hasPending ? 'loading-resources' : 'idle',
                    sessionId: hasPending ? currentSessionId : null,
                    runId: null,
                    skills: rt.skills,
                    prompts: rt.prompts,
                    lastDiagnostics: rt.lastDiagnostics,
                }
            }
        } else {
            const firstFlight = rt.runs.values().next().value
            if (firstFlight) {
                snap = {
                    isStreaming: true,
                    runStatus: firstFlight.runStatus,
                    sessionId: firstFlight.sessionId,
                    runId: firstFlight.runId,
                    skills: rt.skills,
                    prompts: rt.prompts,
                    lastDiagnostics: rt.lastDiagnostics,
                }
            } else {
                const firstPending = rt.pendingPreflights.values().next().value
                if (firstPending) {
                    snap = {
                        isStreaming: true,
                        runStatus: 'loading-resources',
                        sessionId: firstPending.targetSessionId,
                        runId: null,
                        skills: rt.skills,
                        prompts: rt.prompts,
                        lastDiagnostics: rt.lastDiagnostics,
                    }
                } else {
                    snap = {
                        isStreaming: false,
                        runStatus: 'idle',
                        sessionId: null,
                        runId: null,
                        skills: rt.skills,
                        prompts: rt.prompts,
                        lastDiagnostics: rt.lastDiagnostics,
                    }
                }
            }
        }
    }

    rt.snapshotCache.set(key, snap)
    return snap
}

/** Per-service runtime store — never module-global across providers. */
const runtimes = new WeakMap<AgentService, ServiceRuntime>()

/** One host subscription per service so Home/Chat/AppShell do not double-apply. */
const hostBindings = new WeakSet<AgentService>()
const nativeBindings = new WeakSet<AgentService>()
const nativeUnsubscribes = new WeakMap<AgentService, () => void>()

function bindNativeSync(service: AgentService): void {
    if (nativeBindings.has(service)) return
    nativeBindings.add(service)

    const adapter = createAgentEventAdapter(useMessageStore)
    const rt = getRuntime(service)

    const unsubscribe = subscribeHostNativeEvents((nativeEvent) => {
        if (!nativeEvent || !nativeEvent.kind || !nativeEvent.data) return

        if (nativeEvent.kind === 'session:stream-event') {
            try {
                const parsed = JSON.parse(nativeEvent.data) as {
                    sessionId?: string
                    runId?: string
                    event?: AgentRunEvent
                }
                if (!parsed.sessionId || !parsed.event || !parsed.runId) return

                if (rt.hostedRunIds.has(parsed.runId)) {
                    return // Ignore self-echo from runs hosted by this client (even after flight is released)
                }

                const currentSessionId = useSessionStore.getState().currentSessionId
                const isCurrentSession = currentSessionId === parsed.sessionId
                const isKnownSubAgent = useSubAgentStore
                    .getState()
                    .agents.some(
                        (a) =>
                            a.sessionId === parsed.sessionId ||
                            a.id === parsed.sessionId,
                    )
                const isSubAgentOfCurrent =
                    Boolean(currentSessionId) &&
                    useSubAgentStore
                        .getState()
                        .agents.some(
                            (a) =>
                                (a.sessionId === parsed.sessionId ||
                                    a.id === parsed.sessionId) &&
                                a.parentSessionId === currentSessionId,
                        )

                if (!isCurrentSession && !isKnownSubAgent && !isSubAgentOfCurrent) {
                    return
                }

                withSuppressedPersistence(() => {
                    adapter.apply(parsed.event!)
                })
            } catch {
                // Ignore JSON parse error
            }
        } else if (nativeEvent.kind === 'session:subagent-state') {
            try {
                const parsed = JSON.parse(nativeEvent.data) as {
                    parentSessionId?: string
                    agents?: SubAgentRecord[]
                }
                if (parsed.agents && Array.isArray(parsed.agents)) {
                    useSubAgentStore.getState().mergeHostAgents(parsed.agents)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (nativeEvent.kind === 'session:abort-run') {
            try {
                const parsed = JSON.parse(nativeEvent.data) as {
                    sessionId?: string
                }
                if (!parsed.sessionId) return

                // Swallow exactly the first abort-run after this client initiated a takeover
                if (rt.pendingTakeoverAborts.delete(parsed.sessionId)) {
                    return
                }

                handleSessionAbort(rt, service, parsed.sessionId)
            } catch {
                // Ignore JSON parse error
            }
        } else if (nativeEvent.kind === 'session:deleted') {
            try {
                const parsed = JSON.parse(nativeEvent.data) as {
                    sessionId?: string
                }
                if (parsed.sessionId) {
                    handleSessionDeleted(rt, service, parsed.sessionId)
                }
            } catch {
                // Ignore JSON parse error
            }
        } else if (nativeEvent.kind === 'session:delegate-run') {
            if (!isBrowserEnvironment()) {
                try {
                    const req = JSON.parse(
                        nativeEvent.data,
                    ) as SessionDelegateRunRequest
                    if (
                        req &&
                        (req.text?.trim() || (req.images && req.images.length > 0))
                    ) {
                        if (!rt.sendHandler) {
                            rt.pendingDelegateRuns.push(req)
                        } else {
                            void queueDelegateRun(rt, req)
                        }
                    }
                } catch {
                    // Ignore JSON parse error
                }
            }
        }
    })

    if (typeof unsubscribe === 'function') {
        nativeUnsubscribes.set(service, unsubscribe)
    }
}

function pruneHistoricalSubAgents(
    service: AgentService,
    parentSessionId: string,
    keptEntries: readonly ConversationEntry[],
): void {
    const keepIds = collectSpawnAgentToolCallIds(keptEntries)
    const current = useSubAgentStore.getState().agents
    const removedFromStore = current.filter(
        (agent) =>
            agent.parentSessionId === parentSessionId &&
            !isLinkedSubAgent(agent, keepIds),
    )
    const removedFromHost = service.subAgents
        ? service.subAgents.removeUnlinkedForParent(
              parentSessionId,
              keptEntries,
          )
        : []
    const removedById = new Map<string, SubAgentRecord>()
    for (const agent of removedFromHost) removedById.set(agent.id, agent)
    for (const agent of removedFromStore) removedById.set(agent.id, agent)
    if (removedById.size === 0) return
    const removedIds = new Set(removedById.keys())
    useSubAgentStore.getState().replaceAll(
        useSubAgentStore
            .getState()
            .agents.filter((agent) => !removedIds.has(agent.id)),
    )
    for (const agent of removedById.values()) {
        useMessageStore.getState().removeSessionMessages(agent.sessionId)
        void deleteSessionEntries(agent.sessionId)
        service.cancelSessionWarmers?.(agent.sessionId)
    }
}

function hydrateSubAgentHost(service: AgentService): void {
    service.subAgents?.hydrate(useSubAgentStore.getState().agents)
}

function bindSubAgentHost(service: AgentService): void {
    if (hostBindings.has(service) || !service.subAgents) return
    hostBindings.add(service)
    const host = service.subAgents
    const rt = getRuntime(service)
    host.hydrate(useSubAgentStore.getState().agents)
    const adapter = createAgentEventAdapter(useMessageStore)
    host.subscribe({
        onStateChange(agents) {
            useSubAgentStore.getState().mergeHostAgents(agents)
            schedulePersist(false)
            for (const agent of agents) {
                if (
                    agent.status === 'completed' ||
                    agent.status === 'aborted' ||
                    agent.status === 'error'
                ) {
                    const childSessionId = agent.sessionId || agent.id
                    const entries = useMessageStore.getState().getEntries(childSessionId)
                    if (entries.length > 0) {
                        const completedTimestamp =
                            agent.completedAt ?? agent.updatedAt ?? Date.now()
                        let updated = false
                        const nextEntries = entries.map((entry) => {
                            if (
                                entry.kind === 'assistant' &&
                                (entry.status === 'streaming' ||
                                    entry.stopReason === 'pending' ||
                                    entry.completedAt === undefined)
                            ) {
                                updated = true
                                return {
                                    ...entry,
                                    status:
                                        agent.status === 'aborted'
                                            ? ('aborted' as const)
                                            : agent.status === 'error'
                                              ? ('error' as const)
                                              : ('done' as const),
                                    stopReason:
                                        entry.stopReason === 'pending'
                                            ? agent.status === 'aborted'
                                                ? ('aborted' as const)
                                                : ('stop' as const)
                                            : entry.stopReason,
                                    completedAt: entry.completedAt ?? completedTimestamp,
                                }
                            }
                            return entry
                        })
                        if (updated) {
                            useMessageStore.getState().replaceSessionEntries(childSessionId, nextEntries)
                            schedulePersist(true)
                        }
                    }
                }
            }
            const bridge = getHostBridge()
            if (bridge?.SessionBroadcastSubAgentState) {
                const agentsByParentSession = new Map<string, SubAgentRecord[]>()
                for (const agent of agents) {
                    const parentAgents =
                        agentsByParentSession.get(agent.parentSessionId) ?? []
                    parentAgents.push(agent)
                    agentsByParentSession.set(agent.parentSessionId, parentAgents)
                }
                for (const [
                    parentSessionId,
                    parentAgents,
                ] of agentsByParentSession) {
                    void bridge.SessionBroadcastSubAgentState(
                        parentSessionId,
                        parentAgents as unknown[],
                    )
                }
            }
            if (bridge?.SessionUpdateSubAgent) {
                for (const agent of agents) {
                    void bridge.SessionUpdateSubAgent(agent)
                }
            }
        },
        onEvent(event) {
            rememberHostedRunId(rt, event.runId)
            const applyResult = adapter.apply(event)
            scheduleFromUrgency(applyResult.urgency)
            const bridge = getHostBridge()
            if (bridge?.SessionBroadcastStreamEvent) {
                void bridge.SessionBroadcastStreamEvent(
                    event.sessionId,
                    event.runId,
                    prepareStreamEventForBroadcast(event),
                )
            }
        },
        onUserEntry(entry) {
            const existing = useMessageStore.getState().getEntries(entry.sessionId)
            if (existing.some((item) => item.id === entry.id)) return
            useMessageStore.getState().appendEntry(entry)
            schedulePersist(true)
            const bridge = getHostBridge()
            if (bridge?.SessionBroadcastStreamEvent) {
                void bridge.SessionBroadcastStreamEvent(
                    entry.sessionId,
                    'subagent-stream',
                    {
                        type: 'user-entry',
                        sessionId: entry.sessionId,
                        entry,
                    },
                )
            }
        },
    })
}

function createRuntime(): ServiceRuntime {
    return {
        runs: new Map(),
        pendingPreflights: new Map(),
        pendingSteers: new Map(),
        sessionQueues: new Map(),
        pendingDelegateRuns: [],
        inFlightDelegateRuns: new Set(),
        completedDelegateRuns: new Set(),
        flightFinishCallbacks: new Map(),
        flightToken: 0,
        listeners: new Set(),
        disposed: false,
        hostedRunIds: new Set(),
        pendingTakeoverAborts: new Set(),
        inFlightTakeoverRunIds: new Set(),
        deletedSessionIds: new Set(),
        pendingSteerCallbacks: new Map(),
        pendingSteerItems: new Map(),
        skills: [],
        prompts: [],
        lastDiagnostics: [],
        snapshotCache: new Map(),
        sendHandler: undefined,
    }
}

function registerFlightFinishCallback(
    rt: ServiceRuntime,
    token: number,
    callback: ((succeeded: boolean) => void) | undefined,
): void {
    if (!callback) return
    let list = rt.flightFinishCallbacks.get(token)
    if (!list) {
        list = []
        rt.flightFinishCallbacks.set(token, list)
    }
    if (!list.includes(callback)) {
        list.push(callback)
    }
}

function flushFlightFinishCallbacks(
    rt: ServiceRuntime,
    token: number,
    succeeded: boolean,
): void {
    const list = rt.flightFinishCallbacks.get(token)
    if (!list || list.length === 0) {
        rt.flightFinishCallbacks.delete(token)
        return
    }
    rt.flightFinishCallbacks.delete(token)
    for (const cb of list) {
        try {
            cb(succeeded)
        } catch (err) {
            console.error('[AgentStream] Error in flightFinishCallback:', err)
        }
    }
}

const pendingAcks = new Set<string>()
let ackRetryTimer: NodeJS.Timeout | null = null

const sessionActionQueues = new Map<string, Promise<any>>()

export interface ActionEpoch {
    global: number
    session: number
}

let globalActionEpoch = 0
const sessionActionEpochs = new Map<string, number>()

export function getSessionActionEpoch(sessionId: string): ActionEpoch {
    return {
        global: globalActionEpoch,
        session: sessionActionEpochs.get(sessionId) ?? 0,
    }
}

export function isEpochValid(sessionId: string, queued: ActionEpoch): boolean {
    if (queued.global !== globalActionEpoch) return false
    const currentSession = sessionActionEpochs.get(sessionId) ?? 0
    return currentSession === queued.session
}

export function bumpSessionActionEpoch(sessionId?: string): void {
    if (sessionId) {
        const cur = sessionActionEpochs.get(sessionId) ?? 0
        sessionActionEpochs.set(sessionId, cur + 1)
    } else {
        globalActionEpoch++
    }
}

export function __resetDelegateRunsForTests(): void {
    pendingAcks.clear()
    sessionActionQueues.clear()
    sessionActionEpochs.clear()
    globalActionEpoch = 0
    if (ackRetryTimer) {
        clearTimeout(ackRetryTimer)
        ackRetryTimer = null
    }
}

function queueSessionAction<T>(
    sessionId: string | null | undefined,
    action: () => Promise<T>,
    onCancelled?: () => void,
): Promise<T | undefined> {
    if (!sessionId) {
        return action()
    }
    const queueKey = sessionId
    const queuedEpoch = getSessionActionEpoch(queueKey)
    const prev = sessionActionQueues.get(queueKey)

    const executeIfEpochMatches = async (): Promise<T | undefined> => {
        if (!isEpochValid(queueKey, queuedEpoch)) {
            onCancelled?.()
            return undefined
        }
        return action()
    }

    if (!prev) {
        let run: Promise<T | undefined>
        try {
            run = executeIfEpochMatches()
        } catch (err) {
            return Promise.reject(err)
        }
        const cleanup = run.catch(() => {}).finally(() => {
            if (sessionActionQueues.get(queueKey) === cleanup) {
                sessionActionQueues.delete(queueKey)
            }
        })
        sessionActionQueues.set(queueKey, cleanup)
        return run
    }
    const next = prev.catch(() => {}).then(executeIfEpochMatches)
    const cleanup = next.catch(() => {}).finally(() => {
        if (sessionActionQueues.get(queueKey) === cleanup) {
            sessionActionQueues.delete(queueKey)
        }
    })
    sessionActionQueues.set(queueKey, cleanup)
    return next
}

function queueDelegateRun(
    rt: ServiceRuntime,
    req: SessionDelegateRunRequest,
): Promise<void> {
    const markDelegateRunFinished = (_succeeded: boolean) => {
        const ackId = req.requestId || req.userEntryId
        if (ackId) {
            void ackDelegateRunSafely(ackId)
        }
    }
    return queueSessionAction(
        req.sessionId,
        async () => {
            if (rt.disposed) {
                markDelegateRunFinished(false)
                return
            }
            await executeDelegateRun(rt, req)
        },
        () => {
            markDelegateRunFinished(false)
        },
    ).then(() => {})
}

function schedulePendingAcksRetry(): void {
    if (ackRetryTimer || pendingAcks.size === 0) return
    ackRetryTimer = setTimeout(async () => {
        ackRetryTimer = null
        if (pendingAcks.size === 0) return
        const ids = Array.from(pendingAcks)
        for (const ackId of ids) {
            await ackDelegateRunSafely(ackId, 1)
        }
        if (pendingAcks.size > 0) {
            schedulePendingAcksRetry()
        }
    }, 5000)
    ackRetryTimer.unref?.()
}

async function ackDelegateRunSafely(ackId: string, maxAttempts = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const fn = getHostBridge()?.SessionAckDelegateRun
            if (typeof fn !== 'function') {
                throw new Error('SessionAckDelegateRun is not available on host bridge')
            }
            await fn(ackId)
            pendingAcks.delete(ackId)
            return
        } catch (err) {
            if (attempt === maxAttempts) {
                pendingAcks.add(ackId)
                schedulePendingAcksRetry()
                console.warn(`[AgentStream] Failed to ack delegate run ${ackId} after ${maxAttempts} attempts:`, err)
            } else {
                await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
            }
        }
    }
}

function handleSessionAbort(
    rt: ServiceRuntime,
    service: AgentService,
    sessionId: string,
): void {
    if (!sessionId) return
    bumpSessionActionEpoch(sessionId)
    service.cancelSessionWarmers?.(sessionId)

    const flight = rt.runs.get(sessionId)
    if (flight) {
        abortFlightAndCleanup(rt, service, sessionId, flight)
    }

    for (const [t, p] of rt.pendingPreflights) {
        if (p.targetSessionId === sessionId) {
            p.abortController.abort()
            rt.pendingPreflights.delete(t)
        }
    }

    const steers = rt.pendingSteers.get(sessionId)
    if (steers) {
        rt.pendingSteers.delete(sessionId)
        for (const steer of steers) {
            const cbs = rt.pendingSteerCallbacks.get(steer.id)
            rt.pendingSteerCallbacks.delete(steer.id)
            rt.pendingSteerItems.delete(steer.id)
            if (cbs) {
                for (const cb of cbs) {
                    try {
                        cb(false)
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }

    const queue = rt.sessionQueues.get(sessionId)
    if (queue) {
        rt.sessionQueues.delete(sessionId)
        for (const item of queue) {
            try {
                item.payload.onRunFinish?.(false)
            } catch {
                // ignore
            }
        }
    }

    emit(rt)
}

function handleSessionDeleted(
    rt: ServiceRuntime,
    service: AgentService,
    sessionId: string,
): void {
    if (!sessionId) return
    rt.deletedSessionIds.add(sessionId)
    while (rt.deletedSessionIds.size > 1000) {
        const oldest = rt.deletedSessionIds.values().next().value
        if (oldest) rt.deletedSessionIds.delete(oldest)
        else break
    }
    bumpSessionActionEpoch(sessionId)

    useSessionStore.getState().removeRemoteSession(sessionId)

    const flight = rt.runs.get(sessionId)
    if (flight) {
        abortFlightAndCleanup(rt, service, sessionId, flight)
    }

    for (const [t, p] of rt.pendingPreflights) {
        if (p.targetSessionId === sessionId) {
            p.abortController.abort()
            rt.pendingPreflights.delete(t)
        }
    }

    const steers = rt.pendingSteers.get(sessionId)
    if (steers) {
        rt.pendingSteers.delete(sessionId)
        for (const steer of steers) {
            const cbs = rt.pendingSteerCallbacks.get(steer.id)
            rt.pendingSteerCallbacks.delete(steer.id)
            rt.pendingSteerItems.delete(steer.id)
            if (cbs) {
                for (const cb of cbs) {
                    try {
                        cb(false)
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }

    const queue = rt.sessionQueues.get(sessionId)
    if (queue) {
        rt.sessionQueues.delete(sessionId)
        for (const item of queue) {
            try {
                item.payload.onRunFinish?.(false)
            } catch {
                // ignore
            }
        }
    }

    rt.pendingTakeoverAborts.delete(sessionId)
    sessionActionQueues.delete(sessionId)
    emit(rt)
}

async function executeDelegateRun(
    rt: ServiceRuntime,
    req: SessionDelegateRunRequest,
): Promise<void> {
    if (req.sessionId && rt.deletedSessionIds.has(req.sessionId)) {
        const ackId = req.requestId || req.userEntryId
        if (ackId) {
            void ackDelegateRunSafely(ackId)
        }
        return
    }
    const startEpoch = req.sessionId ? getSessionActionEpoch(req.sessionId) : null
    const dedupeKey =
        req.requestId ||
        (req.userEntryId ? `entry-${req.userEntryId}` : '') ||
        (req.sessionId ? `${req.sessionId}:${req.userEntryCreatedAt ?? req.text ?? ''}` : '')
    if (dedupeKey) {
        if (rt.completedDelegateRuns.has(dedupeKey)) {
            // Already completed successfully: re-send ACK to ensure cleanup on host/main process
            const ackId = req.requestId || req.userEntryId
            if (ackId) {
                void ackDelegateRunSafely(ackId)
            }
            return
        }
        if (rt.inFlightDelegateRuns.has(dedupeKey)) {
            // Currently executing: deduplicate without prematurely sending ACK
            return
        }
        rt.inFlightDelegateRuns.add(dedupeKey)
        if (rt.inFlightDelegateRuns.size > MAX_HOSTED_RUN_IDS) {
            const oldest = rt.inFlightDelegateRuns.values().next().value
            if (oldest) rt.inFlightDelegateRuns.delete(oldest)
        }
    }
    if (rt.disposed || !rt.sendHandler) {
        if (dedupeKey) {
            rt.inFlightDelegateRuns.delete(dedupeKey)
        }
        return
    }
    let finishReported = false
    const markDelegateRunFinished = (_outcome: boolean) => {
        if (finishReported) return
        finishReported = true
        const ackId = req.requestId || req.userEntryId
        if (!rt.disposed) {
            if (dedupeKey) {
                rt.inFlightDelegateRuns.delete(dedupeKey)
                rt.completedDelegateRuns.add(dedupeKey)
                while (rt.completedDelegateRuns.size > MAX_HOSTED_RUN_IDS) {
                    const oldest = rt.completedDelegateRuns.values().next().value
                    if (oldest) rt.completedDelegateRuns.delete(oldest)
                    else break
                }
            }
            if (ackId) {
                void ackDelegateRunSafely(ackId)
            }
        } else {
            if (dedupeKey) {
                rt.inFlightDelegateRuns.delete(dedupeKey)
            }
        }
    }

    try {
        if (req.sessionId) {
            const exists = useSessionStore
                .getState()
                .sessions.some((s) => s.id === req.sessionId)
            if (!exists) {
                const titleSource =
                    req.text?.trim() ||
                    (req.images && req.images.length > 0
                        ? req.images[0]?.name || 'image'
                        : '')
                const now = Date.now()
                useSessionStore.getState().upsertRemoteSession({
                    id: req.sessionId,
                    title: deriveSessionTitle(
                        titleSource,
                        useSettingsStore.getState().settings.locale,
                    ),
                    projectId: req.projectId ?? undefined,
                    branch: req.branch ?? undefined,
                    pinned: false,
                    createdAt: now,
                    updatedAt: now,
                })
            }

            const runtimeSettings: Pick<Session, 'modelId' | 'reasoningEffort' | 'speed'> = {}
            if (typeof req.modelId === 'string') {
                runtimeSettings.modelId = req.modelId
            }
            if (typeof req.reasoningEffort === 'string') {
                runtimeSettings.reasoningEffort = req.reasoningEffort
            }
            if (req.speed === 'standard' || req.speed === 'fast' || req.speed === 'max') {
                runtimeSettings.speed = req.speed
            }
            if (Object.keys(runtimeSettings).length > 0) {
                useSessionStore
                    .getState()
                    .setSessionRuntimeSettings(req.sessionId, runtimeSettings)
            }
            await ensureSessionLoaded(req.sessionId)
        }
        if (
            rt.disposed ||
            (req.sessionId && rt.deletedSessionIds.has(req.sessionId)) ||
            (req.sessionId && startEpoch && !isEpochValid(req.sessionId, startEpoch))
        ) {
            markDelegateRunFinished(false)
            return
        }
        const handler = rt.sendInternalHandler ?? rt.sendHandler
        if (rt.disposed || !handler) {
            markDelegateRunFinished(false)
            return
        }
        const sendResult = await handler({
            text: req.text ?? '',
            images: req.images?.map((img) => ({
                id: createId(),
                data: img.data,
                mimeType: img.mimeType,
                name: img.name ?? 'image',
                width: 0,
                height: 0,
            })),
            projectId: req.projectId,
            branch: req.branch,
            sessionId: req.sessionId,
            modelId: req.modelId,
            reasoningEffort: req.reasoningEffort,
            speed: req.speed,
            editMessageId: req.editMessageId,
            userEntryId: req.userEntryId,
            userEntryCreatedAt: req.userEntryCreatedAt,
            followUpMode: req.followUpMode,
            onRunFinish: markDelegateRunFinished,
        })
        if (!sendResult) {
            markDelegateRunFinished(false)
        }
    } catch (error) {
        markDelegateRunFinished(false)
        if (req.sessionId) {
            void getHostBridge()?.SessionBroadcastRunStatus(
                req.sessionId,
                'idle',
                '',
                '',
            )
        }
        toastPreflight(error)
    }
}

export function getRuntime(service: AgentService): ServiceRuntime {
    let rt = runtimes.get(service)
    if (!rt) {
        rt = createRuntime()
        runtimes.set(service, rt)
    }
    return rt
}

function emit(rt: ServiceRuntime): void {
    rt.snapshotCache.clear()
    for (const listener of rt.listeners) listener()
}

function joinUserEntryText(entry: UserEntry): string {
    return entry.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
}

function extractUserEntryImages(entry: UserEntry): ComposerImage[] {
    return entry.content
        .filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image')
        .map((b, index) => ({
            id: `img-${entry.id}-${index}`,
            name: 'image',
            mimeType: b.mimeType,
            data: b.data,
            width: 0,
            height: 0,
            kind: 'image' as const,
        }))
}

function removeEntryFromStore(sessionId: string, entryId: string): void {
    const list = useMessageStore.getState().getEntries(sessionId)
    const next = list.filter((e) => e.id !== entryId)
    useMessageStore.getState().replaceSessionEntries(sessionId, next)
    schedulePersist(true)
}

function processNextQueuedMessage(rt: ServiceRuntime, sessionId: string): void {
    void queueSessionAction(sessionId, async () => {
        if (rt.disposed || !rt.sendHandler) return
        if (rt.runs.has(sessionId)) {
            // Already a flight active (e.g. newly arrived delegation started), leave queue intact
            return
        }
        const queue = rt.sessionQueues.get(sessionId)
        if (!queue || queue.length === 0) return
        const queuedItems = queue.splice(0, queue.length)
        rt.sessionQueues.delete(sessionId)

        const executionStartTime = Date.now()
        const entries = useMessageStore.getState().getEntries(sessionId)
        const queuedUserEntryIds: string[] = []

        queuedItems.forEach((item, idx) => {
            queuedUserEntryIds.push(item.entry.id)
            const existing = entries.find((e) => e.id === item.entry.id)
            if (existing && existing.kind === 'user') {
                useMessageStore.getState().replaceEntry({
                    ...existing,
                    pendingStatus: undefined,
                    createdAt: executionStartTime + idx,
                })
            }
        })

        const firstItem = queuedItems[0]
        const lastItem = queuedItems[queuedItems.length - 1]

        const callbacks = queuedItems
            .map((item) => item.payload.onRunFinish)
            .filter((cb): cb is (succeeded: boolean) => void => typeof cb === 'function')

        const combinedOnRunFinish = callbacks.length > 0
            ? (succeeded: boolean) => {
                  for (const cb of callbacks) {
                      try {
                          cb(succeeded)
                      } catch (err) {
                          console.error('[AgentStream] Error in queued onRunFinish:', err)
                      }
                  }
              }
            : undefined

        try {
            const handler = rt.sendInternalHandler ?? rt.sendHandler
            if (handler) {
                await handler(
                    {
                        ...lastItem.payload,
                        sessionId,
                        userEntryId: firstItem.entry.id,
                        queuedUserEntryIds,
                        userEntryCreatedAt: executionStartTime,
                        isQueuedExecution: true,
                        onRunFinish: combinedOnRunFinish,
                    },
                    lastItem.options,
                )
            }
        } catch (err) {
            console.error('[AgentStream] Queued execution failed:', err)
            try {
                combinedOnRunFinish?.(false)
            } catch {
                // best-effort
            }
        }
    })
}

export function dequeueQueuedMessage(
    rt: ServiceRuntime,
    sessionId: string,
    messageId: string,
): { text: string; images?: ComposerImage[] } | null {
    // 1. Pending steer check
    const steers = rt.pendingSteers.get(sessionId)
    if (steers) {
        const index = steers.findIndex((s) => s.id === messageId)
        if (index !== -1) {
            const [removed] = steers.splice(index, 1)
            if (steers.length === 0) {
                rt.pendingSteers.delete(sessionId)
            }
            const cbs = rt.pendingSteerCallbacks.get(removed.id)
            rt.pendingSteerCallbacks.delete(removed.id)
            rt.pendingSteerItems.delete(removed.id)
            if (cbs && cbs.length > 0) {
                for (const c of cbs) {
                    try {
                        c(false)
                    } catch (err) {
                        console.error('[AgentStream] Error in dequeued steer onRunFinish:', err)
                    }
                }
            }
            const text = joinUserEntryText(removed)
            const images = extractUserEntryImages(removed)
            removeEntryFromStore(sessionId, messageId)
            emit(rt)
            return { text, images }
        }
    }

    // 2. Session queue check
    const queue = rt.sessionQueues.get(sessionId)
    if (queue) {
        const index = queue.findIndex((item) => item.entry.id === messageId)
        if (index !== -1) {
            const [removed] = queue.splice(index, 1)
            if (queue.length === 0) {
                rt.sessionQueues.delete(sessionId)
            }
            try {
                removed.payload.onRunFinish?.(false)
            } catch (err) {
                console.error('[AgentStream] Error in dequeued onRunFinish:', err)
            }
            const text = joinUserEntryText(removed.entry)
            const images = extractUserEntryImages(removed.entry)
            removeEntryFromStore(sessionId, messageId)
            emit(rt)
            return { text, images }
        }
    }

    // 3. Fallback: check messageStore entry directly
    const entries = useMessageStore.getState().getEntries(sessionId)
    const entry = entries.find((e) => e.id === messageId)
    if (entry && entry.kind === 'user' && entry.pendingStatus) {
        const text = joinUserEntryText(entry)
        const images = extractUserEntryImages(entry)
        removeEntryFromStore(sessionId, messageId)
        emit(rt)
        return { text, images }
    }

    return null
}

function releaseFlight(
    rt: ServiceRuntime,
    sessionId: string,
    flightToken: number,
    wasAborted = false,
): void {
    const flight = rt.runs.get(sessionId)
    if (flight && flight.flightToken === flightToken) {
        rt.runs.delete(sessionId)
        emit(rt)
        if (!wasAborted) {
            processNextQueuedMessage(rt, sessionId)
        }
    }
}

function abortFlightAndCleanup(
    rt: ServiceRuntime,
    service: AgentService,
    sessionId: string,
    flight: SessionRunFlight,
): void {
    const runId = flight.runId
    flight.abortController.abort()
    if (runId) {
        try {
            service.abort(runId)
        } catch {
            // best-effort
        }
        const adapter = createAgentEventAdapter(useMessageStore)
        adapter.apply({
            type: 'aborted',
            sessionId,
            runId,
        })
        adapter.apply({
            type: 'agent-end',
            sessionId,
            runId,
        })
    }
    const entries = useMessageStore.getState().getEntries(sessionId)
    const now = Date.now()
    let lastAssistantIndex = -1
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.kind === 'assistant') {
            lastAssistantIndex = i
            break
        }
    }
    if (lastAssistantIndex >= 0) {
        const target = entries[lastAssistantIndex] as AssistantEntry
        if (target.status === 'streaming') {
            useMessageStore.getState().replaceEntry({
                ...target,
                status: 'aborted',
                stopReason: 'aborted',
                completedAt: now,
            })
        } else {
            useMessageStore.getState().replaceEntry({
                ...target,
                completedAt: now,
                interrupted: true,
            } as any)
        }
    }
    useSessionRunStore.getState().clearRun(sessionId)
    void getHostBridge()?.SessionBroadcastRunStatus(
        sessionId,
        'idle',
        runId,
        '',
    )
    rt.runs.delete(sessionId)
    emit(rt)
}

/** Test helper — reset a service runtime (or no-op when service is null). */
export function __resetAgentStreamForTests(service?: AgentService | null): void {
    if (service) {
        nativeBindings.delete(service)
        const unsub = nativeUnsubscribes.get(service)
        if (unsub) {
            try {
                unsub()
            } catch {
                // best-effort
            }
            nativeUnsubscribes.delete(service)
        }
        const rt = runtimes.get(service)
        if (!rt) return
        for (const p of rt.pendingPreflights.values()) {
            try {
                p.abortController.abort()
            } catch {
                // best-effort
            }
        }
        rt.pendingPreflights.clear()
        for (const flight of rt.runs.values()) {
            try {
                flight.abortController.abort()
            } catch {
                // best-effort
            }
        }
        rt.runs.clear()
        rt.flightToken += 1
        rt.disposed = false
        rt.hostedRunIds.clear()
        rt.pendingTakeoverAborts.clear()
        rt.sendHandler = undefined
        rt.skills = []
        rt.prompts = []
        rt.lastDiagnostics = []
        emit(rt)
        return
    }
    // Legacy no-arg reset cannot clear WeakMap entries; tests should pass service.
}

/**
 * Dispose per-service hook runtime first, then the service itself.
 * Sets disposed + idle snapshot and notifies current listeners, aborts controllers.
 * Keeps the WeakMap tombstone so the same service cannot recreate flight state;
 * listeners may still unsubscribe after notify. Idempotent.
 */
export async function disposeAgentRuntime(service: AgentService): Promise<void> {
    const rt = runtimes.get(service) ?? getRuntime(service)
    if (!rt.disposed) {
        rt.disposed = true
        rt.flightToken += 1
        for (const p of rt.pendingPreflights.values()) {
            try {
                p.abortController.abort()
            } catch {
                // best-effort
            }
        }
        rt.pendingPreflights.clear()
        for (const [sessionId, flight] of rt.runs) {
            const runId = flight.runId
            try {
                flight.abortController.abort()
            } catch {
                // best-effort
            }
            if (runId) {
                try {
                    service.abort(runId)
                } catch {
                    // best-effort
                }
            }
            void getHostBridge()?.SessionBroadcastRunStatus(
                sessionId,
                'idle',
                runId,
                '',
            )
        }
        rt.runs.clear()
        const unsub = nativeUnsubscribes.get(service)
        if (unsub) {
            try {
                unsub()
            } catch {
                // best-effort
            }
            nativeUnsubscribes.delete(service)
        }
        emit(rt)
        // Keep the set so unsubscribe still works; do not delete WeakMap entry
        // (tombstone prevents a fresh non-disposed runtime for this service).
    }
    await Promise.resolve(service.dispose())
}

/** Test helper — read current snapshot for a service. */
export function __getAgentStreamSnapshotForTests(
    service: AgentService,
    scopedSessionId?: string | null,
): StreamSnapshot {
    const rt = getRuntime(service)
    return getSnapshotForSession(rt, scopedSessionId)
}

function resolveProjectPathsById(
    projectId: string | null | undefined,
): string[] {
    if (!projectId) return []
    const project = useProjectStore
        .getState()
        .projects.find((item) => item.id === projectId)
    return project ? getProjectPaths(project) : []
}

function resolveProjectIdForSession(sessionId: string | null): string | null {
    if (!sessionId) return null
    const session = useSessionStore
        .getState()
        .sessions.find((item) => item.id === sessionId)
    return session?.projectId ?? null
}

function resolveSettingsForSession(session: Session) {
    const settings = { ...useSettingsStore.getState().settings }
    return {
        ...settings,
        modelId: session.modelId ?? settings.modelId,
        reasoningLevel: session.reasoningEffort ?? settings.reasoningLevel,
        speed: session.speed ?? settings.speed,
    }
}

function resolveSettingsForPayload(
    session: Session | undefined,
    payload: Pick<AgentSendPayload, 'modelId' | 'reasoningEffort' | 'speed'>,
) {
    const settings = session
        ? resolveSettingsForSession(session)
        : { ...useSettingsStore.getState().settings }
    return {
        ...settings,
        modelId: payload.modelId ?? settings.modelId,
        reasoningLevel: payload.reasoningEffort ?? settings.reasoningLevel,
        speed: payload.speed ?? settings.speed,
    }
}

function createRuntimeSettingsResolver(targetSessionId: string) {
    return () => {
        const session = useSessionStore
            .getState()
            .sessions.find((s) => s.id === targetSessionId)
        const settings = useSettingsStore.getState().settings
        return {
            reasoningLevel: session?.reasoningEffort ?? settings.reasoningLevel,
            reasoningEffort: session?.reasoningEffort ?? settings.reasoningLevel,
            speed: session?.speed ?? settings.speed,
            modelSettings: settings.modelSettings,
        }
    }
}

function buildUserEntry(
    sessionId: string,
    text: string,
    images: readonly ComposerImage[],
): UserEntry {
    const content: ContentBlock[] = []
    const trimmed = text.trim()
    if (trimmed) {
        content.push({ type: 'text', text: trimmed })
    }
    for (const image of images) {
        content.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
        })
    }
    return {
        id: createId(),
        sessionId,
        createdAt: Date.now(),
        kind: 'user',
        content,
    }
}

function replaceUserEntryText(entry: UserEntry, text: string): UserEntry {
    const nextContent: UserEntry['content'] = entry.content.filter(
        (block) => block.type !== 'text',
    )
    nextContent.unshift({ type: 'text', text: text.trim() })
    return {
        ...entry,
        createdAt: Date.now(),
        content: nextContent,
    }
}

function mapEventToBroadcastStatus(
    event: AgentRunEvent,
): 'running' | 'thinking' | 'tool' | 'idle' | null {
    switch (event.type) {
        case 'tool-approval-required':
        case 'tool-start':
        case 'tool-update':
        case 'tool-end':
            return 'tool'
        case 'assistant-update': {
            const streamType = event.streamEvent.type
            if (
                streamType === 'thinking-start' ||
                streamType === 'thinking-delta'
            ) {
                return 'thinking'
            }
            if (
                streamType === 'toolcall-start' ||
                streamType === 'toolcall-delta' ||
                streamType === 'toolcall-end'
            ) {
                return 'tool'
            }
            return 'running'
        }
        case 'assistant-start':
        case 'assistant-end':
        case 'agent-start':
        case 'compaction-start':
        case 'compaction-end':
        case 'retrying':
            return 'running'
        case 'agent-end':
        case 'error':
        case 'aborted':
            return 'idle'
        default:
            return null
    }
}

function mapRunStatus(
    event: AgentRunEvent,
    current: ComposerRunStatus,
): ComposerRunStatus {
    switch (event.type) {
        case 'agent-start':
            return current === 'compacting' ? 'compacting' : 'connecting'
        case 'assistant-start':
        case 'assistant-update':
            return 'streaming'
        case 'tool-approval-required':
            return 'awaiting_approval'
        case 'tool-start':
        case 'tool-update':
        case 'tool-end':
            return 'running_tools'
        case 'retrying':
            return 'retrying'
        case 'compaction-start':
            return 'compacting'
        case 'compaction-end':
            return current === 'compacting' ? 'connecting' : current
        case 'agent-end':
            return 'done'
        case 'error':
            return 'error'
        case 'aborted':
            return 'aborted'
        default:
            return current
    }
}

function toastPreflight(error: unknown): void {
    const message =
        error instanceof AgentPreflightError
            ? i18n.t(error.i18nKey, { defaultValue: error.message })
            : error instanceof Error
              ? error.message
              : i18n.t('composer.sendFailed')
    useUiStore.getState().pushToast(String(message))
}

function scheduleFromUrgency(urgency: 'none' | 'debounce' | 'immediate'): void {
    if (urgency === 'none') return
    schedulePersist(urgency === 'immediate')
}

function modelSupportsImages(
    modelId: string,
    models: readonly { id: string; input?: readonly string[] }[],
): boolean {
    const model = models.find((entry) => entry.id === modelId)
    return Boolean(model?.input?.includes('image'))
}

function isAbortError(error: unknown): boolean {
    if (!error) return false
    if (error instanceof DOMException && error.name === 'AbortError') return true
    if (error instanceof Error) {
        return error.name === 'AbortError' || /abort/i.test(error.message)
    }
    return false
}

function createAbortError(): Error {
    const error = new Error('Request was aborted')
    error.name = 'AbortError'
    return error
}

/** Reject when signal aborts so never-resolving prepare cannot pin flight state. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(createAbortError())
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            reject(createAbortError())
        }
        signal.addEventListener('abort', onAbort)
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

interface PrepareExecutionRunParams {
    service: AgentService
    sessionId: string
    session?: Session | null
    settings: ReturnType<typeof resolveSettingsForSession>
    catalog: readonly ModelCatalogEntry[]
    workLocation?: 'local' | 'worktree'
    projectPaths: readonly string[]
    branch?: string | null
    environmentId?: string | null
    scheduleId?: string | null
    signal: AbortSignal
    allowSetup?: boolean
}

type PrepareExecutionRunResult =
    | { ok: true; prepared: PreparedAgentRun; worktreePolicy?: WorktreeRunPolicy }
    | { ok: false; prepared?: undefined; worktreePolicy?: undefined }

async function prepareExecutionRun(
    params: PrepareExecutionRunParams,
): Promise<PrepareExecutionRunResult> {
    const effectiveWorkLocation =
        params.workLocation ??
        params.session?.workLocation ??
        'local'
    const isWorktree = effectiveWorkLocation === 'worktree'

    if (!isWorktree) {
        const prepared = await abortable(
            params.service.prepare({
                baseUrl: params.settings.cliProxyApi.baseUrl,
                apiKey: params.settings.cliProxyApi.apiKey,
                modelId: params.settings.modelId,
                models: params.catalog,
                reasoningLevel: params.settings.reasoningLevel,
                speed: params.settings.speed,
                compactionThresholdPercent:
                    params.settings.compactionThresholdPercent,
                fastContextCompaction:
                    params.settings.fastContextCompaction,
                projectPath: params.projectPaths[0] ?? null,
                projectPaths: params.projectPaths,
                signal: params.signal,
                language: params.settings.locale,
                personality: params.settings.personality,
                localMemoryEnabled: params.settings.localMemoryEnabled,
                scheduleId: params.scheduleId ?? null,
                sessionId: params.sessionId,
                subagentsSettings: params.settings.subagents,
                gitSettings: params.settings.git,
                modelSettings: params.settings.modelSettings,
                getEntries: async (sid: string) => {
                    await ensureSessionLoaded(sid)
                    return useMessageStore.getState().getEntries(sid)
                },
            }),
            params.signal,
        )
        return { ok: true, prepared }
    }

    const liveSession =
        useSessionStore
            .getState()
            .sessions.find((s) => s.id === params.sessionId) ?? params.session
    let setupState = useWorktreeSetupStore.getState().getSetup(params.sessionId)
    let effectiveWorktreePath =
        liveSession?.worktreePath ?? setupState?.worktreePath

    if (!effectiveWorktreePath || setupState?.status !== 'ready') {
        if (params.allowSetup) {
            const sourcePath =
                setupState?.sourceTreePath ?? params.projectPaths[0]
            if (!sourcePath) {
                throw new AgentPreflightError(
                    'invalid_worktree_policy',
                    'Git worktree session is missing sourceTreePath',
                    'agent.preflight.invalid_worktree_policy',
                )
            }
            const setupResult = await abortable(
                useWorktreeSetupStore.getState().startSetup({
                    sessionId: params.sessionId,
                    sourceTreePath: sourcePath,
                    branch: params.branch,
                    environmentId: params.environmentId ?? undefined,
                }),
                params.signal,
            )
            if (!setupResult.ok) {
                return { ok: false }
            }
            effectiveWorktreePath = setupResult.worktreePath
            setupState = useWorktreeSetupStore
                .getState()
                .getSetup(params.sessionId)
        } else {
            throw new AgentPreflightError(
                'invalid_worktree_policy',
                'Git worktree setup is not ready',
                'agent.preflight.invalid_worktree_policy',
            )
        }
    }

    let recovered: ReturnType<typeof recoverWorktreeRunPolicy>
    try {
        recovered = recoverWorktreeRunPolicy({
            worktreePath: effectiveWorktreePath ?? setupState?.worktreePath,
            sourceTreePath: setupState?.sourceTreePath,
            projectPaths: params.projectPaths,
        })
    } catch (error) {
        throw new AgentPreflightError(
            'invalid_worktree_policy',
            error instanceof Error ? error.message : String(error),
            'agent.preflight.invalid_worktree_policy',
        )
    }

    if (recovered.sourceTreePathRecovered) {
        useWorktreeSetupStore.getState().setSetupState(params.sessionId, {
            sourceTreePath: recovered.policy.sourceTreePath,
        })
        if (liveSession && !liveSession.worktreeSetup?.sourceTreePath) {
            useSessionStore.getState().setSessionWorktreeSetup?.(
                params.sessionId,
                {
                    ...(setupState ?? {
                        sessionId: params.sessionId,
                        status: 'ready',
                        stepWorkspace: 'done',
                        stepCheckout: 'done',
                        stepEnvironment: 'done',
                        worktreePath: recovered.policy.worktreePath,
                        logs: '',
                        expandedDetails: false,
                    }),
                    sourceTreePath: recovered.policy.sourceTreePath,
                },
            )
        }
    }

    try {
        await abortable(flushPendingPersistence(), params.signal)
    } catch (error) {
        if (isAbortError(error)) {
            throw error
        }
        throw new AgentPreflightError(
            'worktree_persistence_failed',
            error instanceof Error ? error.message : String(error),
            'agent.preflight.worktree_persistence_failed',
        )
    }

    const prepared = await abortable(
        params.service.prepare({
            baseUrl: params.settings.cliProxyApi.baseUrl,
            apiKey: params.settings.cliProxyApi.apiKey,
            modelId: params.settings.modelId,
            models: params.catalog,
            reasoningLevel: params.settings.reasoningLevel,
            speed: params.settings.speed,
            compactionThresholdPercent:
                params.settings.compactionThresholdPercent,
            fastContextCompaction:
                params.settings.fastContextCompaction,
            projectPath: recovered.policy.worktreePath,
            projectPaths: [recovered.policy.worktreePath],
            worktreePolicy: recovered.policy,
            signal: params.signal,
            language: params.settings.locale,
            personality: params.settings.personality,
            localMemoryEnabled: params.settings.localMemoryEnabled,
            scheduleId: params.scheduleId ?? null,
            sessionId: params.sessionId,
            subagentsSettings: params.settings.subagents,
            gitSettings: params.settings.git,
            modelSettings: params.settings.modelSettings,
            getEntries: async (sid: string) => {
                await ensureSessionLoaded(sid)
                return useMessageStore.getState().getEntries(sid)
            },
        }),
        params.signal,
    )

    return {
        ok: true,
        prepared,
        worktreePolicy: recovered.policy,
    }
}

export interface UseAgentStreamResult {
    send: (
        input: string | AgentSendPayload,
        opts?: AgentSendOptions,
    ) => Promise<string | null>
    stop: (sessionId?: string) => void
    isStreaming: boolean
    runStatus: ComposerRunStatus
    sessionId: string | null
    runId: string | null
    supportsImages: boolean
    skills: readonly Skill[]
    prompts: readonly PromptTemplate[]
    lastDiagnostics: readonly string[]
    approveTool: (toolId: string, sessionId?: string) => void
    rejectTool: (toolId: string, sessionId?: string) => void
    compact: (focus: string, sessionId?: string) => Promise<void>
    resumeSession: (sessionId?: string) => Promise<string | null>
    retrySession: (sessionId?: string, messageId?: string) => Promise<string | null>
    isReady?: boolean
}

/**
 * Shared agent stream hook. Reserve single-flight before async preflight so
 * double-send cannot race two prepares. Config failure leaves no session/user
 * side effects. Events always apply to the original session/run of the send.
 */
export function useAgentStream(
    scopedSessionId?: string | null,
): UseAgentStreamResult {
    const service = useAgentService()

    const subscribe = useCallback(
        (listener: () => void) => {
            if (!service) return () => {}
            const rt = getRuntime(service)
            rt.listeners.add(listener)
            return () => {
                rt.listeners.delete(listener)
            }
        },
        [service],
    )

    const getSnap = useCallback((): StreamSnapshot => {
        if (!service) return IDLE_SNAPSHOT
        return getSnapshotForSession(getRuntime(service), scopedSessionId)
    }, [service, scopedSessionId])

    const snap = useSyncExternalStore(subscribe, getSnap, getSnap)

    // Derive vision support from live catalog + settings — never last prepare.
    const sessionModelId = useSessionStore((s) =>
        scopedSessionId
            ? s.sessions.find((session) => session.id === scopedSessionId)?.modelId
            : undefined,
    )
    const settingsModelId = useSettingsStore((s) => s.settings.modelId)
    const activeModelId = sessionModelId ?? settingsModelId
    const models = useModelCatalogStore((s) => s.models)
    const supportsImages = useMemo(
        () => modelSupportsImages(activeModelId, models),
        [activeModelId, models],
    )

    const stop = useCallback(
        (sessionIdToStop?: string) => {
            const target =
                sessionIdToStop ??
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : useSessionStore.getState().currentSessionId)

            if (service) {
                const rt = getRuntime(service)
                if (target) {
                    const hadLocalFlight = rt.runs.has(target)
                    const hadLocalPreflight = Array.from(rt.pendingPreflights.values()).some(
                        (p) => p.targetSessionId === target,
                    )
                    const hadLocalSteer = (rt.pendingSteers.get(target)?.length ?? 0) > 0
                    const hadLocalQueue = (rt.sessionQueues.get(target)?.length ?? 0) > 0
                    const hadSessionActionQueue = sessionActionQueues.has(target)

                    handleSessionAbort(rt, service, target)

                    if (
                        hadLocalFlight ||
                        hadLocalPreflight ||
                        hadLocalSteer ||
                        hadLocalQueue ||
                        hadSessionActionQueue
                    ) {
                        return
                    }
                } else {
                    bumpSessionActionEpoch()
                    let handledLocally = false
                    if (rt.runs.size > 0) {
                        for (const [sId, flight] of [...rt.runs.entries()]) {
                            abortFlightAndCleanup(rt, service, sId, flight)
                            handledLocally = true
                        }
                    }
                    if (rt.pendingPreflights.size > 0) {
                        for (const p of rt.pendingPreflights.values()) {
                            p.abortController.abort()
                        }
                        rt.pendingPreflights.clear()
                        handledLocally = true
                    }
                    for (const steers of rt.pendingSteers.values()) {
                        handledLocally = true
                        for (const steer of steers) {
                            const cbs = rt.pendingSteerCallbacks.get(steer.id)
                            rt.pendingSteerCallbacks.delete(steer.id)
                            rt.pendingSteerItems.delete(steer.id)
                            if (cbs) {
                                for (const cb of cbs) {
                                    try {
                                        cb(false)
                                    } catch {
                                        // ignore
                                    }
                                }
                            }
                        }
                    }
                    rt.pendingSteers.clear()
                    for (const queue of rt.sessionQueues.values()) {
                        handledLocally = true
                        for (const item of queue) {
                            try {
                                item.payload.onRunFinish?.(false)
                            } catch {
                                // ignore
                            }
                        }
                    }
                    rt.sessionQueues.clear()
                    if (handledLocally) {
                        emit(rt)
                        return
                    }
                }
            }
            if (target) {
                void getHostBridge()?.SessionAbortRun(target)
            }
        },
        [service, scopedSessionId],
    )

    const approveTool = useCallback(
        (toolId: string, targetSessionId?: string) => {
            if (!service) return
            const target =
                targetSessionId ??
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : useSessionStore.getState().currentSessionId)
            const rt = getRuntime(service)
            const flight = target ? rt.runs.get(target) : undefined
            const runId =
                flight?.runId ??
                (rt.runs.size === 1
                    ? rt.runs.values().next().value?.runId
                    : undefined)
            if (!runId || !toolId) return
            service.approve(runId, toolId)
        },
        [service, scopedSessionId],
    )

    const rejectTool = useCallback(
        (toolId: string, targetSessionId?: string) => {
            if (!service) return
            const target =
                targetSessionId ??
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : useSessionStore.getState().currentSessionId)
            const rt = getRuntime(service)
            const flight = target ? rt.runs.get(target) : undefined
            const runId =
                flight?.runId ??
                (rt.runs.size === 1
                    ? rt.runs.values().next().value?.runId
                    : undefined)
            if (!runId || !toolId) return
            service.reject(runId, toolId)
        },
        [service, scopedSessionId],
    )

    const compact = useCallback(
        async (focus: string, targetSessionId?: string): Promise<void> => {
            if (!service) {
                throw new Error('Agent service is not ready')
            }
            const rt = getRuntime(service)
            if (rt.disposed) {
                throw new AgentPreflightError(
                    'disposed',
                    'Agent runtime has been disposed',
                    'agent.preflight.disposed',
                )
            }

            const sessionId =
                targetSessionId ??
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : useSessionStore.getState().currentSessionId)
            if (!sessionId) {
                throw new Error('No active session')
            }
            const existingFlight = rt.runs.get(sessionId)
            if (
                existingFlight &&
                (existingFlight.runStatus === 'compacting' ||
                    existingFlight.runStatus !== 'idle')
            ) {
                throw new Error('A run is already active')
            }

            await ensureSessionLoaded(sessionId)
            const entries = useMessageStore.getState().getEntries(sessionId)
            if (entries.length === 0) {
                throw new Error('No conversation entries to compact')
            }

            // Capture immutable settings for this compact call.
            const session = useSessionStore
                .getState()
                .sessions.find((item) => item.id === sessionId)
            const settings = session
                ? resolveSettingsForSession(session)
                : { ...useSettingsStore.getState().settings }
            const catalog = useModelCatalogStore.getState().models.slice()
            const projectId = resolveProjectIdForSession(sessionId)
            const projectPaths = resolveProjectPathsById(projectId)

            const token = ++rt.flightToken
            const runId = createId()
            rememberHostedRunId(rt, runId)
            const ac = new AbortController()

            const flight: SessionRunFlight = {
                sessionId,
                runId,
                runStatus: 'compacting',
                abortController: ac,
                flightToken: token,
            }
            rt.runs.set(sessionId, flight)
            emit(rt)

            // Activate adapter before compact so agent-start is received.
            const adapter = createAgentEventAdapter(useMessageStore)

            try {
                const prepResult = await prepareExecutionRun({
                    service,
                    sessionId,
                    session,
                    settings,
                    catalog,
                    workLocation: session?.workLocation,
                    projectPaths,
                    branch: session?.branch,
                    environmentId: session?.environmentId,
                    scheduleId: session?.scheduleId ?? null,
                    signal: ac.signal,
                    allowSetup: false,
                })
                if (!prepResult.ok || !prepResult.prepared) {
                    throw new AgentPreflightError(
                        'invalid_worktree_policy',
                        'Git worktree setup is not ready',
                        'agent.preflight.invalid_worktree_policy',
                    )
                }
                const prepared = prepResult.prepared

                if (
                    token !== rt.runs.get(sessionId)?.flightToken ||
                    ac.signal.aborted ||
                    rt.disposed
                ) {
                    throw createAbortError()
                }

                // Session must still exist after prepare.
                const still = useSessionStore
                    .getState()
                    .sessions.find((item) => item.id === sessionId)
                if (!still) {
                    throw new AgentPreflightError(
                        'session_gone',
                        'Session was removed during preflight',
                        'agent.preflight.session_gone',
                    )
                }

                rt.skills = prepared.skills
                rt.prompts = prepared.prompts
                rt.lastDiagnostics = prepared.diagnostics.map((d) => d.message)
                emit(rt)

                // Show the in-progress divider before the compact request starts.
                adapter.apply({
                    type: 'agent-start',
                    runId,
                    sessionId,
                })
                adapter.apply({
                    type: 'compaction-start',
                    runId,
                    sessionId,
                })

                void getHostBridge()?.SessionBroadcastRunStatus(
                    sessionId,
                    'running',
                    runId,
                    '',
                )

                const result = await service.compact({
                    prepared,
                    sessionId,
                    runId,
                    entries,
                    customInstructions: focus?.trim() || undefined,
                    signal: ac.signal,
                })

                for (const event of result.events ?? []) {
                    void getHostBridge()?.SessionBroadcastStreamEvent(
                        sessionId,
                        runId,
                        prepareStreamEventForBroadcast(event),
                    )
                    const applyResult = adapter.apply(event)
                    scheduleFromUrgency(applyResult.urgency)
                    const currentFlight = rt.runs.get(sessionId)
                    if (currentFlight && currentFlight.flightToken === token) {
                        currentFlight.runStatus = mapRunStatus(
                            event,
                            currentFlight.runStatus,
                        )
                        emit(rt)
                    }
                }

                if (!result.ok) {
                    const message =
                        result.code === 'compact_failed'
                            ? i18n.t('agent.preflight.compact_failed', {
                                  defaultValue: result.message,
                              })
                            : result.message
                    throw new Error(message)
                }
            } catch (error) {
                flushFlightFinishCallbacks(rt, token, false)
                if (!isAbortError(error)) {
                    toastPreflight(error)
                }
                throw error
            } finally {
                void getHostBridge()?.SessionBroadcastRunStatus(
                    sessionId,
                    'idle',
                    runId,
                    '',
                )
                releaseFlight(rt, sessionId, token)
                flushFlightFinishCallbacks(rt, token, true)
            }
        },
        [service, scopedSessionId],
    )

    const sendInternal = useCallback(
        async (
            payload: AgentSendPayload,
            opts?: AgentSendOptions,
        ): Promise<string | null> => {
            const trimmed = payload.text.trim()
            const images = payload.images ? payload.images.slice() : []

            if (!service) {
                const err = new AgentPreflightError(
                    'disposed',
                    'Agent service is not ready',
                    'agent.preflight.service_unavailable',
                )
                toastPreflight(err)
                throw err
            }

            const rt = getRuntime(service)
            if (rt.disposed) {
                const err = new AgentPreflightError(
                    'disposed',
                    'Agent runtime has been disposed',
                    'agent.preflight.disposed',
                )
                toastPreflight(err)
                throw err
            }

            const sessionState = useSessionStore.getState()
            const targetSessionId =
                payload.sessionId !== undefined
                    ? (payload.sessionId || null)
                    : (scopedSessionId !== undefined
                        ? (scopedSessionId || null)
                        : (sessionState.currentSessionId || null))

            const capturedSessionId = targetSessionId
            const targetSession = capturedSessionId
                ? sessionState.sessions.find((s) => s.id === capturedSessionId)
                : undefined
            const settings = resolveSettingsForPayload(targetSession, payload)

            if (payload.editMessageId && targetSessionId) {
                const oldSteers = rt.pendingSteers.get(targetSessionId)
                if (oldSteers && oldSteers.length > 0) {
                    rt.pendingSteers.delete(targetSessionId)
                    for (const steer of oldSteers) {
                        const cbs = rt.pendingSteerCallbacks.get(steer.id)
                        rt.pendingSteerCallbacks.delete(steer.id)
                        rt.pendingSteerItems.delete(steer.id)
                        if (cbs) {
                            for (const cb of cbs) {
                                try {
                                    cb(false)
                                } catch {
                                    // best-effort
                                }
                            }
                        }
                    }
                }
            }

            if (targetSessionId && rt.runs.has(targetSessionId) && !payload.editMessageId && !payload.isQueuedExecution) {
                const activeFlight = rt.runs.get(targetSessionId)!
                const isCompacting = activeFlight.runStatus === 'compacting'
                const effectiveFollowUpMode: 'steer' | 'queue' =
                    isCompacting
                        ? 'queue' // Compaction cannot accept steer messages mid-stream; force queue
                        : (payload.followUpMode ??
                            (settings.editor?.followUpMode === 'queue' ? 'queue' : 'steer'))

                const trimmed = payload.text.trim()
                const images = payload.images ? payload.images.slice() : []

                if (effectiveFollowUpMode === 'steer') {
                    const steerEntry: UserEntry = {
                        ...buildUserEntry(targetSessionId, trimmed, images),
                        pendingStatus: 'steer',
                    }
                    if (payload.userEntryId) {
                        steerEntry.id = payload.userEntryId
                    }
                    const existing = useMessageStore.getState().getEntries(targetSessionId)
                    const existingEntry = payload.userEntryId
                        ? existing.find((e): e is UserEntry => e.id === payload.userEntryId && e.kind === 'user')
                        : undefined
                    if (existingEntry) {
                        useMessageStore.getState().replaceEntry({
                            ...existingEntry,
                            pendingStatus: 'steer',
                        })
                    } else {
                        useMessageStore.getState().appendEntry(steerEntry)
                    }
                    let steerList = rt.pendingSteers.get(targetSessionId)
                    if (!steerList) {
                        steerList = []
                        rt.pendingSteers.set(targetSessionId, steerList)
                    }
                    if (!steerList.some((s) => s.id === steerEntry.id)) {
                        steerList.push(steerEntry)
                    }
                    if (payload.onRunFinish) {
                        let cbs = rt.pendingSteerCallbacks.get(steerEntry.id)
                        if (!cbs) {
                            cbs = []
                            rt.pendingSteerCallbacks.set(steerEntry.id, cbs)
                        }
                        cbs.push(payload.onRunFinish)
                    }
                    rt.pendingSteerItems.set(steerEntry.id, {
                        entry: steerEntry,
                        payload: {
                            ...payload,
                            sessionId: targetSessionId,
                        },
                        options: opts,
                    })
                    schedulePersist(true)
                    const onAccepted = payload.onSessionAccepted ?? opts?.onSessionAccepted
                    onAccepted?.(targetSessionId)
                    emit(rt)
                    return targetSessionId
                } else {
                    const queueEntry: UserEntry = {
                        ...buildUserEntry(targetSessionId, trimmed, images),
                        pendingStatus: 'queue',
                    }
                    if (payload.userEntryId) {
                        queueEntry.id = payload.userEntryId
                    }
                    const existing = useMessageStore.getState().getEntries(targetSessionId)
                    const existingEntry = payload.userEntryId
                        ? existing.find((e): e is UserEntry => e.id === payload.userEntryId && e.kind === 'user')
                        : undefined
                    if (existingEntry) {
                        useMessageStore.getState().replaceEntry({
                            ...existingEntry,
                            pendingStatus: 'queue',
                        })
                    } else {
                        useMessageStore.getState().appendEntry(queueEntry)
                    }
                    let queue = rt.sessionQueues.get(targetSessionId)
                    if (!queue) {
                        queue = []
                        rt.sessionQueues.set(targetSessionId, queue)
                    }
                    queue.push({
                        entry: queueEntry,
                        payload: {
                            ...payload,
                            sessionId: targetSessionId,
                            userEntryId: queueEntry.id,
                            userEntryCreatedAt: queueEntry.createdAt,
                            onRunFinish: payload.onRunFinish,
                        },
                        options: opts,
                    })
                    schedulePersist(true)
                    const onAccepted = payload.onSessionAccepted ?? opts?.onSessionAccepted
                    onAccepted?.(targetSessionId)
                    emit(rt)
                    return targetSessionId
                }
            } else if (targetSessionId && rt.runs.has(targetSessionId)) {
                if (payload.isQueuedExecution) {
                    // A queued execution must NEVER interrupt an active flight!
                    // Re-queue it into sessionQueues
                    let queue = rt.sessionQueues.get(targetSessionId)
                    if (!queue) {
                        queue = []
                        rt.sessionQueues.set(targetSessionId, queue)
                    }
                    queue.push({
                        entry: buildUserEntry(targetSessionId, payload.text, payload.images ?? []),
                        payload,
                        options: opts,
                    })
                    return targetSessionId
                }
                // Local flight interrupt for this specific session
                const existing = rt.runs.get(targetSessionId)!
                abortFlightAndCleanup(rt, service, targetSessionId, existing)
            }
            const catalog = useModelCatalogStore.getState().models.slice()
            const capturedProjectId =
                payload.projectId !== undefined
                    ? payload.projectId
                    : (resolveProjectIdForSession(capturedSessionId) ??
                       useUiStore.getState().pendingSessionContext.projectId)
            const capturedBranch =
                payload.branch !== undefined
                    ? payload.branch
                    : capturedSessionId
                      ? (sessionState.sessions.find(
                            (s) => s.id === capturedSessionId,
                        )?.branch ?? null)
                      : useUiStore.getState().pendingSessionContext.branch
            const capturedWorkLocation =
                payload.workLocation !== undefined
                    ? payload.workLocation
                    : (capturedSessionId
                        ? (sessionState.sessions.find(
                              (s) => s.id === capturedSessionId,
                          )?.workLocation ?? 'local')
                        : (useUiStore.getState().pendingSessionContext.workLocation ?? 'local'))
            const capturedEnvironmentId =
                payload.environmentId !== undefined
                    ? payload.environmentId
                    : (capturedSessionId
                        ? (sessionState.sessions.find(
                              (s) => s.id === capturedSessionId,
                          )?.environmentId ?? null)
                        : (useUiStore.getState().pendingSessionContext.environmentId ?? null))
            const capturedProjectPaths =
                resolveProjectPathsById(capturedProjectId)

            const token = ++rt.flightToken
            if (payload.onRunFinish) {
                registerFlightFinishCallback(rt, token, payload.onRunFinish)
            }
            const ac = new AbortController()
            for (const [t, p] of rt.pendingPreflights) {
                if (
                    p.targetSessionId === capturedSessionId ||
                    (capturedSessionId === null && p.targetSessionId === null) ||
                    (!capturedSessionId && !p.targetSessionId)
                ) {
                    p.abortController.abort()
                    rt.pendingPreflights.delete(t)
                }
            }
            rt.pendingPreflights.set(token, {
                token,
                abortController: ac,
                targetSessionId: capturedSessionId,
            })
            emit(rt)

            let boundSessionId: string | null = null
            let boundRunId: string | null = null
            let streamStarted = false

            try {
                // Preflight first — no session/user side effects on failure.
                // Pass signal into prepare (service aborts each await) and keep
                // outer abortable race as a double-guard for never-resolving loads.
                let prepared: PreparedAgentRun = await abortable(
                    service.prepare({
                        baseUrl: settings.cliProxyApi.baseUrl,
                        apiKey: settings.cliProxyApi.apiKey,
                        modelId: settings.modelId,
                        models: catalog,
                        reasoningLevel: settings.reasoningLevel,
                        speed: settings.speed,
                        compactionThresholdPercent:
                            settings.compactionThresholdPercent,
                        fastContextCompaction:
                            settings.fastContextCompaction,
                        projectPath: capturedProjectPaths[0] ?? null,
                        projectPaths: capturedProjectPaths,
                        signal: ac.signal,
                        language: settings.locale,
                        personality: settings.personality,
                        localMemoryEnabled: settings.localMemoryEnabled,
                        scheduleId: payload.scheduleId ?? targetSession?.scheduleId ?? null,
                        sessionId: targetSessionId ?? null,
                        subagentsSettings: settings.subagents,
                        gitSettings: settings.git,
                        modelSettings: settings.modelSettings,
                        getEntries: async (sid: string) => {
                            await ensureSessionLoaded(sid)
                            return useMessageStore.getState().getEntries(sid)
                        },
                    }),
                    ac.signal,
                )

                // Abort after prepare must throw (not bare return) so draft is kept.
                // disposed/flight token guards block late session submit after runtime dispose.
                if (
                    !rt.pendingPreflights.has(token) ||
                    ac.signal.aborted ||
                    rt.disposed
                ) {
                    throw createAbortError()
                }

                const titleSource =
                    trimmed ||
                    (images.length > 0
                        ? images[0]?.name || 'image'
                        : '')
                const title = deriveSessionTitle(titleSource, settings.locale)

                // Only write the captured session target (or create with captured project).
                let sessionId = capturedSessionId
                if (sessionId) {
                    await ensureSessionLoaded(sessionId)
                    const still = useSessionStore
                        .getState()
                        .sessions.find((item) => item.id === sessionId)
                    if (!still) {
                        throw new AgentPreflightError(
                            'session_gone',
                            'Session was removed during preflight',
                            'agent.preflight.session_gone',
                        )
                    }
                    const existing = useMessageStore
                        .getState()
                        .getEntries(sessionId)
                    if (
                        payload.editMessageId &&
                        !existing.some(
                            (entry) =>
                                entry.id === payload.editMessageId &&
                                entry.kind === 'user',
                        )
                    ) {
                        throw new AgentPreflightError(
                            'message_gone',
                            'Message to edit was not found',
                            'agent.preflight.message_gone',
                        )
                    }
                    if (existing.length === 0) {
                        useSessionStore
                            .getState()
                            .renameSession(sessionId, title)
                    }
                    // Bind captured project/branch to the captured session only.
                    if (capturedProjectId) {
                        useSessionStore
                            .getState()
                            .setSessionProject(sessionId, capturedProjectId)
                    }
                    if (capturedBranch) {
                        useSessionStore
                            .getState()
                            .setSessionBranch(sessionId, capturedBranch)
                    }
                    if (capturedWorkLocation) {
                        useSessionStore
                            .getState()
                            .setSessionWorktree(
                                sessionId,
                                capturedWorkLocation,
                                still.worktreePath,
                                capturedEnvironmentId,
                            )
                    }
                } else {
                    if (payload.editMessageId) {
                        throw new AgentPreflightError(
                            'message_gone',
                            'Message to edit was not found',
                            'agent.preflight.message_gone',
                        )
                    }
                    sessionId = useSessionStore.getState().createSession({
                        title,
                        projectId: capturedProjectId ?? undefined,
                        branch: capturedBranch ?? undefined,
                        workLocation: capturedWorkLocation,
                        environmentId: capturedEnvironmentId,
                        modelId: settings.modelId,
                        reasoningEffort: settings.reasoningLevel,
                        speed: settings.speed,
                    })
                }

                useSessionStore.getState().setSessionRuntimeSettings(sessionId, {
                    modelId: settings.modelId,
                    reasoningEffort: settings.reasoningLevel,
                    speed: settings.speed,
                })

                const pendingPreflight = rt.pendingPreflights.get(token)
                if (pendingPreflight) {
                    pendingPreflight.targetSessionId = sessionId
                }
                boundSessionId = sessionId

                // Append user entry immediately so UI displays user message and setup card
                const existingEntries = useMessageStore
                    .getState()
                    .getEntries(sessionId)
                let priorEntries: ConversationEntry[]
                let userEntry: UserEntry
                let activatedUserEntries: UserEntry[] = []
                if (payload.isQueuedExecution) {
                    const queuedIds =
                        payload.queuedUserEntryIds && payload.queuedUserEntryIds.length > 0
                            ? payload.queuedUserEntryIds
                            : payload.userEntryId
                              ? [payload.userEntryId]
                              : []
                    const executionStartTime = payload.userEntryCreatedAt ?? Date.now()

                    for (let idx = 0; idx < queuedIds.length; idx++) {
                        const qId = queuedIds[idx]
                        const target = existingEntries.find(
                            (e) => e.id === qId && e.kind === 'user',
                        ) as UserEntry | undefined
                        if (target) {
                            const updated: UserEntry = {
                                ...target,
                                pendingStatus: undefined,
                                createdAt: executionStartTime + idx,
                            }
                            useMessageStore.getState().replaceEntry(updated)
                            activatedUserEntries.push(updated)
                        }
                    }

                    const firstQueuedId = queuedIds[0]
                    const firstIndex = existingEntries.findIndex(
                        (entry) => entry.id === firstQueuedId,
                    )
                    const rawPrior =
                        firstIndex !== -1
                            ? existingEntries.slice(0, firstIndex)
                            : existingEntries
                    priorEntries = rawPrior.filter(
                        (e) => !(e.kind === 'user' && e.pendingStatus === 'queue'),
                    )

                    userEntry =
                        activatedUserEntries[0] ?? {
                            ...buildUserEntry(sessionId, trimmed, images),
                            createdAt: executionStartTime,
                        }
                    if (activatedUserEntries.length === 0) {
                        useMessageStore.getState().appendEntry(userEntry)
                        activatedUserEntries.push(userEntry)
                    }
                } else if (payload.editMessageId) {
                    const targetIndex = existingEntries.findIndex(
                        (entry) => entry.id === payload.editMessageId,
                    )
                    const target = existingEntries[targetIndex]
                    if (!target || target.kind !== 'user') {
                        throw new AgentPreflightError(
                            'message_gone',
                            'Message to edit was not found',
                            'agent.preflight.message_gone',
                        )
                    }
                    userEntry = replaceUserEntryText(target, trimmed)
                    priorEntries = existingEntries.slice(0, targetIndex)
                    const keptEntries = [...priorEntries, userEntry]
                    useMessageStore
                        .getState()
                        .replaceSessionEntries(sessionId, keptEntries, { historyMutation: 'truncate' })
                    pruneHistoricalSubAgents(service, sessionId, keptEntries)
                } else if (
                    payload.userEntryId &&
                    existingEntries.some(
                        (entry) =>
                            entry.id === payload.userEntryId &&
                            entry.kind === 'user',
                    )
                ) {
                    const targetIndex = existingEntries.findIndex(
                        (entry) =>
                            entry.id === payload.userEntryId &&
                            entry.kind === 'user',
                    )
                    const target = existingEntries[targetIndex] as UserEntry
                    userEntry = {
                        ...target,
                        createdAt: payload.userEntryCreatedAt ?? Date.now(),
                    }
                    priorEntries = existingEntries.slice(0, targetIndex)
                    const keptEntries = [...priorEntries, userEntry]
                    useMessageStore
                        .getState()
                        .replaceSessionEntries(sessionId, keptEntries, { historyMutation: 'truncate' })
                    pruneHistoricalSubAgents(service, sessionId, keptEntries)
                } else {
                    priorEntries = existingEntries
                    userEntry = buildUserEntry(sessionId, trimmed, images)
                    if (payload.userEntryId) {
                        userEntry.id = payload.userEntryId
                    }
                    useMessageStore.getState().appendEntry(userEntry)
                }
                const liveSessionObj = useSessionStore
                    .getState()
                    .sessions.find((s) => s.id === sessionId)
                if (
                    liveSessionObj &&
                    (liveSessionObj.firstPromptAt === undefined ||
                        liveSessionObj.firstPromptAt === 0)
                ) {
                    useSessionStore
                        .getState()
                        .setSessionFirstPromptAt(sessionId, userEntry.createdAt)
                }
                schedulePersist(true)
                const onAccepted = payload.onSessionAccepted ?? opts?.onSessionAccepted
                onAccepted?.(sessionId)

                // Worktree and environment initialization if worktree mode selected
                if (capturedWorkLocation === 'worktree') {
                    const prepResult = await prepareExecutionRun({
                        service,
                        sessionId,
                        session: liveSessionObj,
                        settings,
                        catalog,
                        workLocation: capturedWorkLocation,
                        projectPaths: capturedProjectPaths,
                        branch: capturedBranch,
                        environmentId: capturedEnvironmentId,
                        scheduleId: payload.scheduleId ?? targetSession?.scheduleId ?? null,
                        signal: ac.signal,
                        allowSetup: true,
                    })
                    if (!prepResult.ok || !prepResult.prepared) {
                        flushFlightFinishCallbacks(rt, token, false)
                        if (sessionId) {
                            void getHostBridge()?.SessionBroadcastRunStatus(
                                sessionId,
                                'idle',
                                '',
                                '',
                            )
                        }
                        return null
                    }
                    prepared = prepResult.prepared
                }

                if (
                    !rt.pendingPreflights.has(token) ||
                    ac.signal.aborted ||
                    rt.disposed
                ) {
                    throw createAbortError()
                }

                const diagMessages = prepared.diagnostics.map((d) => d.message)
                rt.skills = prepared.skills
                rt.prompts = prepared.prompts
                rt.lastDiagnostics = diagMessages
                emit(rt)

                for (const message of diagMessages) {
                    if (message) {
                        useUiStore
                            .getState()
                            .pushToast(
                                i18n.t('composer.resourceWarning', {
                                    message,
                                }),
                            )
                    }
                }

                const runId = createId()
                rememberHostedRunId(rt, runId)

                useUiStore.getState().setPinnedSummaryVisible(true)

                const entries: ConversationEntry[] = [
                    ...priorEntries,
                    ...(activatedUserEntries.length > 0 ? activatedUserEntries : [userEntry]),
                ]

                boundSessionId = sessionId
                boundRunId = runId

                const flight: SessionRunFlight = {
                    sessionId,
                    runId,
                    runStatus: 'connecting',
                    abortController: ac,
                    flightToken: token,
                }
                rt.runs.set(sessionId, flight)
                rt.pendingPreflights.delete(token)
                emit(rt)

                const adapter = createAgentEventAdapter(useMessageStore)
                streamStarted = true

                void getHostBridge()?.SessionBroadcastRunStatus(
                    boundSessionId,
                    'running',
                    boundRunId,
                    '',
                )
                const entriesToBroadcast =
                    activatedUserEntries.length > 0
                        ? activatedUserEntries
                        : [userEntry]
                for (const entry of entriesToBroadcast) {
                    void getHostBridge()?.SessionBroadcastStreamEvent(
                        boundSessionId,
                        boundRunId,
                        {
                            type: 'user-entry',
                            sessionId: boundSessionId,
                            runId: boundRunId,
                            entry,
                        },
                    )
                }

                // Background lifecycle — callers may navigate immediately after accept.
                void (async () => {
                    let currentBroadcastStatus: 'running' | 'thinking' | 'tool' | 'idle' =
                        'running'
                    let runSucceeded = false
                    let hasError = false
                    try {
                        for await (const event of service.streamChat({
                            prepared,
                            sessionId: boundSessionId!,
                            runId: boundRunId!,
                            entries,
                            userEntry,
                            signal: ac.signal,
                            getRuntimeSettings: createRuntimeSettingsResolver(boundSessionId!),
                            consumeSteerEntries: () => {
                                const steers = rt.pendingSteers.get(boundSessionId!)
                                if (steers && steers.length > 0) {
                                    rt.pendingSteers.delete(boundSessionId!)
                                    const now = Date.now()
                                    const consumed = steers.map((steer, idx) => {
                                        const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                        if (cbs) {
                                            rt.pendingSteerCallbacks.delete(steer.id)
                                            for (const cb of cbs) {
                                                registerFlightFinishCallback(rt, token, cb)
                                            }
                                        }
                                        rt.pendingSteerItems.delete(steer.id)
                                        const entry: UserEntry = {
                                            ...steer,
                                            pendingStatus: undefined,
                                            createdAt: now + idx,
                                        }
                                        useMessageStore.getState().replaceEntry(entry)
                                        return entry
                                    })
                                    emit(rt)
                                    return consumed
                                }
                                return undefined
                            },
                            consumeSteerEntry: () => {
                                const steers = rt.pendingSteers.get(boundSessionId!)
                                if (steers && steers.length > 0) {
                                    const steer = steers.shift()!
                                    if (steers.length === 0) {
                                        rt.pendingSteers.delete(boundSessionId!)
                                    }
                                    const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                    if (cbs) {
                                        rt.pendingSteerCallbacks.delete(steer.id)
                                        for (const cb of cbs) {
                                            registerFlightFinishCallback(rt, token, cb)
                                        }
                                    }
                                    rt.pendingSteerItems.delete(steer.id)
                                    const consumed: UserEntry = {
                                        ...steer,
                                        pendingStatus: undefined,
                                        createdAt: Date.now(),
                                    }
                                    useMessageStore.getState().replaceEntry(consumed)
                                    emit(rt)
                                    return consumed
                                }
                                return undefined
                            },
                        })) {
                            if (event.type === 'error') {
                                hasError = true
                            }
                            if (rt.runs.get(boundSessionId!)?.flightToken !== token) break
                            void getHostBridge()?.SessionBroadcastStreamEvent(
                                boundSessionId!,
                                boundRunId!,
                                prepareStreamEventForBroadcast(event),
                            )
                            const nextBroadcastStatus =
                                mapEventToBroadcastStatus(event)
                            if (
                                nextBroadcastStatus &&
                                nextBroadcastStatus !== currentBroadcastStatus
                            ) {
                                currentBroadcastStatus = nextBroadcastStatus
                                void getHostBridge()?.SessionBroadcastRunStatus(
                                    boundSessionId!,
                                    nextBroadcastStatus,
                                    boundRunId!,
                                    '',
                                )
                            }
                            const applyResult = adapter.apply(event)
                            scheduleFromUrgency(applyResult.urgency)
                            const currentFlight = rt.runs.get(boundSessionId!)
                            if (currentFlight && currentFlight.flightToken === token) {
                                currentFlight.runStatus = mapRunStatus(
                                    event,
                                    currentFlight.runStatus,
                                )
                                emit(rt)
                            }
                        }
                        if (!hasError && rt.runs.get(boundSessionId!)?.flightToken === token) {
                            runSucceeded = true
                        }
                    } catch (error) {
                        hasError = true
                        runSucceeded = false
                        if (ac.signal.aborted || isAbortError(error)) {
                            // silent abort
                        } else if (!(error instanceof AgentPreflightError)) {
                            const message =
                                error instanceof Error
                                    ? error.message
                                    : String(error ?? 'stream error')
                            adapter.apply({
                                type: 'error',
                                runId: boundRunId!,
                                sessionId: boundSessionId!,
                                message,
                            })
                            schedulePersist(true)
                            if (boundSessionId !== useSessionStore.getState().currentSessionId && typeof window !== 'undefined' && getHashRoutePathname() !== `/chat/${boundSessionId}`) {
                                useSessionStore.getState().markUnread(boundSessionId!, 'error')
                            }
                            const errorToast = message
                                ? `${i18n.t('composer.sendFailed', { defaultValue: 'Send failed' })}: ${message}`
                                : i18n.t('composer.sendFailed', { defaultValue: 'Send failed' })
                            useUiStore.getState().pushToast(errorToast)
                        }
                    } finally {
                        if (boundSessionId && boundRunId && adapter.getActiveRunId(boundSessionId) === boundRunId) {
                            if (ac.signal.aborted) {
                                adapter.apply({
                                    type: 'aborted',
                                    sessionId: boundSessionId,
                                    runId: boundRunId,
                                })
                            }
                            adapter.apply({
                                type: 'agent-end',
                                sessionId: boundSessionId,
                                runId: boundRunId,
                            })
                        }
                        if (boundSessionId !== useSessionStore.getState().currentSessionId && typeof window !== 'undefined' && getHashRoutePathname() !== `/chat/${boundSessionId}`) {
                            const session = useSessionStore.getState().sessions.find((s) => s.id === boundSessionId)
                            if (session && session.unread !== 'error') {
                                useSessionStore.getState().markUnread(boundSessionId!, true)
                            }
                        }
                        void getHostBridge()?.SessionBroadcastRunStatus(
                            boundSessionId!,
                            'idle',
                            boundRunId!,
                            '',
                        )
                        if (!ac.signal.aborted && runSucceeded && boundSessionId) {
                            const session = useSessionStore.getState().sessions.find((s) => s.id === boundSessionId)
                            const title = session?.title || ''
                            void getHostBridge()?.NotificationTaskCompleted?.({
                                sessionId: boundSessionId,
                                sessionTitle: title,
                            })
                        }
                        const isOwnerFlight = rt.runs.get(boundSessionId!)?.flightToken === token
                        if (isOwnerFlight) {
                            const unconsumedSteers = rt.pendingSteers.get(boundSessionId!)
                            if (unconsumedSteers && unconsumedSteers.length > 0) {
                                rt.pendingSteers.delete(boundSessionId!)
                                let queue = rt.sessionQueues.get(boundSessionId!)
                                if (!queue) {
                                    queue = []
                                    rt.sessionQueues.set(boundSessionId!, queue)
                                }
                                for (const steer of unconsumedSteers) {
                                    const item = rt.pendingSteerItems.get(steer.id)
                                    const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                    rt.pendingSteerItems.delete(steer.id)
                                    rt.pendingSteerCallbacks.delete(steer.id)
                                    useMessageStore.getState().replaceEntry({
                                        ...steer,
                                        pendingStatus: 'queue',
                                    })
                                    const combinedCb = cbs && cbs.length > 0
                                        ? (succeeded: boolean) => {
                                              for (const cb of cbs) {
                                                  try {
                                                      cb(succeeded)
                                                  } catch (err) {
                                                      console.error('[AgentStream] Error in transferred steer callback:', err)
                                                  }
                                              }
                                          }
                                        : undefined

                                    queue.push(item ? {
                                        ...item,
                                        payload: {
                                            ...item.payload,
                                            onRunFinish: combinedCb,
                                        },
                                    } : {
                                        entry: steer,
                                        payload: {
                                            text: joinUserEntryText(steer),
                                            images: extractUserEntryImages(steer),
                                            sessionId: boundSessionId!,
                                            onRunFinish: combinedCb,
                                        },
                                    })
                                }
                                schedulePersist(true)
                            }
                        }
                        releaseFlight(rt, boundSessionId!, token, ac.signal.aborted)
                        const succeeded = !ac.signal.aborted && !hasError && runSucceeded
                        flushFlightFinishCallbacks(rt, token, succeeded)
                    }
                })()

                return sessionId
            } catch (error) {
                rt.pendingPreflights.delete(token)
                emit(rt)
                flushFlightFinishCallbacks(rt, token, false)
                const sid = boundSessionId || targetSessionId
                if (sid) {
                    void getHostBridge()?.SessionBroadcastRunStatus(
                        sid,
                        'idle',
                        '',
                        '',
                    )
                }
                if (!isAbortError(error)) {
                    toastPreflight(error)
                }
                // Reject so Composer retains draft on preflight/abort failure.
                throw error
            } finally {
                rt.pendingPreflights.delete(token)
                emit(rt)
                // Owner-token finally: release when prepare failed before stream.
                if (!streamStarted && boundSessionId) {
                    releaseFlight(rt, boundSessionId, token, true)
                }
            }
        },
        [service, scopedSessionId],
    )

    const send = useCallback(
        async (
            input: string | AgentSendPayload,
            opts?: AgentSendOptions,
        ): Promise<string | null> => {
            const payload: AgentSendPayload =
                typeof input === 'string'
                    ? { text: input, images: [], kind: opts?.kind, onSessionAccepted: opts?.onSessionAccepted }
                    : {
                          text: input.text,
                          images: input.images ?? [],
                          kind: input.kind ?? opts?.kind,
                          projectId: input.projectId,
                          scheduleId: input.scheduleId,
                          parentSessionId: input.parentSessionId,
                          branch: input.branch,
                          workLocation: input.workLocation,
                          environmentId: input.environmentId,
                          sessionId: input.sessionId,
                          editMessageId: input.editMessageId,
                          userEntryId: input.userEntryId,
                          queuedUserEntryIds: input.queuedUserEntryIds,
                          userEntryCreatedAt: input.userEntryCreatedAt,
                          followUpMode: input.followUpMode,
                          isQueuedExecution: input.isQueuedExecution,
                          modelId: input.modelId,
                          reasoningEffort: input.reasoningEffort,
                          speed: input.speed,
                          onSessionAccepted: input.onSessionAccepted ?? opts?.onSessionAccepted,
                          onRunFinish: input.onRunFinish,
                      }

            const trimmed = payload.text.trim()
            const images = payload.images ?? []
            if (!trimmed && images.length === 0) return null

            if (isBrowserEnvironment()) {
                const sessionState = useSessionStore.getState()
                const targetSessionId =
                    payload.sessionId !== undefined
                        ? (payload.sessionId || null)
                        : (scopedSessionId !== undefined
                            ? (scopedSessionId || null)
                            : (sessionState.currentSessionId || null))
                const targetSession = targetSessionId
                    ? sessionState.sessions.find((s) => s.id === targetSessionId)
                    : undefined
                const settings = resolveSettingsForPayload(targetSession, payload)
                const capturedProjectId =
                    payload.projectId !== undefined
                        ? payload.projectId
                        : (resolveProjectIdForSession(targetSessionId) ??
                           useUiStore.getState().pendingSessionContext.projectId)
                const capturedBranch =
                    payload.branch !== undefined
                        ? payload.branch
                        : targetSessionId
                          ? (sessionState.sessions.find(
                                (s) => s.id === targetSessionId,
                            )?.branch ?? null)
                          : useUiStore.getState().pendingSessionContext.branch
                const capturedWorkLocation =
                    payload.workLocation !== undefined
                        ? payload.workLocation
                        : (targetSessionId
                            ? (sessionState.sessions.find(
                                  (s) => s.id === targetSessionId,
                              )?.workLocation ?? 'local')
                            : (useUiStore.getState().pendingSessionContext.workLocation ?? 'local'))
                const capturedEnvironmentId =
                    payload.environmentId !== undefined
                        ? payload.environmentId
                        : (targetSessionId
                            ? (sessionState.sessions.find(
                                  (s) => s.id === targetSessionId,
                              )?.environmentId ?? null)
                            : (useUiStore.getState().pendingSessionContext.environmentId ?? null))

                const titleSource =
                    trimmed ||
                    (images.length > 0
                        ? images[0]?.name || 'image'
                        : '')
                const title = deriveSessionTitle(titleSource, settings.locale)

                let sessionId = targetSessionId
                if (sessionId) {
                    await ensureSessionLoaded(sessionId)
                    const still = sessionState.sessions.find((s) => s.id === sessionId)
                    if (!still) {
                        sessionId = useSessionStore.getState().createSession({
                            id: sessionId,
                            title,
                            projectId: capturedProjectId ?? undefined,
                            scheduleId: payload.scheduleId ?? undefined,
                            parentSessionId: payload.parentSessionId ?? undefined,
                            branch: capturedBranch ?? undefined,
                            workLocation: capturedWorkLocation,
                            environmentId: capturedEnvironmentId,
                            modelId: settings.modelId,
                            reasoningEffort: settings.reasoningLevel,
                            speed: settings.speed,
                        })
                    } else {
                        const existing = useMessageStore.getState().getEntries(sessionId)
                        if (existing.length === 0) {
                            useSessionStore.getState().renameSession(sessionId, title)
                        }
                        if (capturedProjectId) {
                            useSessionStore.getState().setSessionProject(sessionId, capturedProjectId)
                        }
                        if (payload.scheduleId) {
                            useSessionStore.getState().setSessionScheduleId(sessionId, payload.scheduleId)
                        }
                        if (payload.parentSessionId) {
                            useSessionStore.getState().setSessionParentId(sessionId, payload.parentSessionId)
                        }
                        if (capturedBranch) {
                            useSessionStore.getState().setSessionBranch(sessionId, capturedBranch)
                        }
                        if (capturedWorkLocation) {
                            useSessionStore.getState().setSessionWorktree(sessionId, capturedWorkLocation, still.worktreePath, capturedEnvironmentId)
                        }
                    }
                } else {
                    sessionId = useSessionStore.getState().createSession({
                        title,
                        projectId: capturedProjectId ?? undefined,
                        scheduleId: payload.scheduleId ?? undefined,
                        parentSessionId: payload.parentSessionId ?? undefined,
                        branch: capturedBranch ?? undefined,
                        workLocation: capturedWorkLocation,
                        environmentId: capturedEnvironmentId,
                        modelId: settings.modelId,
                        reasoningEffort: settings.reasoningLevel,
                        speed: settings.speed,
                    })
                }

                useSessionStore.getState().setSessionRuntimeSettings(sessionId, {
                    modelId: settings.modelId,
                    reasoningEffort: settings.reasoningLevel,
                    speed: settings.speed,
                })

                let userEntry: UserEntry
                if (payload.editMessageId) {
                    const existingEntries = useMessageStore.getState().getEntries(sessionId)
                    const targetIndex = existingEntries.findIndex(
                        (entry) => entry.id === payload.editMessageId,
                    )
                    const target = existingEntries[targetIndex]
                    if (target && target.kind === 'user') {
                        userEntry = replaceUserEntryText(target, trimmed)
                        const priorEntries = existingEntries.slice(0, targetIndex)
                        const keptEntries = [...priorEntries, userEntry]
                        useMessageStore.getState().replaceSessionEntries(sessionId, keptEntries, { historyMutation: 'truncate' })
                    } else {
                        userEntry = buildUserEntry(sessionId, trimmed, images)
                        useMessageStore.getState().appendEntry(userEntry)
                    }
                } else if (
                    payload.userEntryId &&
                    useMessageStore.getState().getEntries(sessionId).some(
                        (entry) =>
                            entry.id === payload.userEntryId &&
                            entry.kind === 'user',
                    )
                ) {
                    const existingEntries = useMessageStore.getState().getEntries(sessionId)
                    const targetIndex = existingEntries.findIndex(
                        (entry) =>
                            entry.id === payload.userEntryId &&
                            entry.kind === 'user',
                    )
                    const target = existingEntries[targetIndex] as UserEntry
                    userEntry = {
                        ...target,
                        createdAt: payload.userEntryCreatedAt ?? Date.now(),
                    }
                    const priorEntries = existingEntries.slice(0, targetIndex)
                    const keptEntries = [...priorEntries, userEntry]
                    useMessageStore.getState().replaceSessionEntries(sessionId, keptEntries, { historyMutation: 'truncate' })
                } else {
                    userEntry = buildUserEntry(sessionId, trimmed, images)
                    if (payload.userEntryId) {
                        userEntry.id = payload.userEntryId
                    }
                    useMessageStore.getState().appendEntry(userEntry)
                }
                const currentSessionObj = useSessionStore
                    .getState()
                    .sessions.find((s) => s.id === sessionId)
                if (
                    currentSessionObj &&
                    (currentSessionObj.firstPromptAt === undefined ||
                        currentSessionObj.firstPromptAt === 0)
                ) {
                    useSessionStore
                        .getState()
                        .setSessionFirstPromptAt(sessionId, userEntry.createdAt)
                }
                schedulePersist(true)
                const onAccepted = payload.onSessionAccepted ?? opts?.onSessionAccepted
                onAccepted?.(sessionId)

                const bridge = getHostBridge()
                if (bridge?.SessionDelegateRun) {
                    const previousRun = useSessionRunStore.getState().activeRuns[sessionId]
                    const isAlreadyRunning = previousRun && previousRun.status !== 'idle'
                    const optimisticRunId = isAlreadyRunning ? null : `delegated-${Date.now()}`
                    if (!isAlreadyRunning) {
                        useSessionRunStore.getState().setRun(sessionId, {
                            sessionId,
                            status: 'running',
                            runId: optimisticRunId!,
                            clientId: 'browser-local',
                            updatedAt: Date.now(),
                        })
                    }
                    try {
                        const stableRequestId = payload.requestId || (userEntry.id ? `req-${userEntry.id}` : undefined)
                        await bridge.SessionDelegateRun({
                            requestId: stableRequestId,
                            sessionId,
                            text: trimmed,
                            images: images.length > 0 ? [...images] : undefined,
                            projectId: capturedProjectId ?? null,
                            branch: capturedBranch ?? null,
                            modelId: settings.modelId,
                            reasoningEffort: settings.reasoningLevel,
                            speed: settings.speed,
                            editMessageId: payload.editMessageId,
                            userEntryId: userEntry.id,
                            userEntryCreatedAt: userEntry.createdAt,
                            followUpMode: payload.followUpMode,
                        })
                    } catch (error) {
                        if (!isAlreadyRunning) {
                            const current = useSessionRunStore.getState().activeRuns[sessionId]
                            if (current?.runId === optimisticRunId) {
                                useSessionRunStore.getState().clearRun(sessionId)
                            }
                        }
                        throw error
                    }
                }

                useUiStore.getState().setPinnedSummaryVisible(true)

                return sessionId
            }

            const sessionState = useSessionStore.getState()
            const targetSessionId =
                payload.sessionId !== undefined
                    ? (payload.sessionId || null)
                    : (scopedSessionId !== undefined
                        ? (scopedSessionId || null)
                        : (sessionState.currentSessionId || null))

            const fixedPayload: AgentSendPayload = {
                ...payload,
                sessionId: targetSessionId,
            }

            if (!service) {
                const err = new AgentPreflightError(
                    'disposed',
                    'Agent service is not ready',
                    'agent.preflight.service_unavailable',
                )
                toastPreflight(err)
                throw err
            }

            const rt = getRuntime(service)
            if (targetSessionId && !payload.isQueuedExecution && !rt.runs.has(targetSessionId)) {
                const remoteRun = useSessionRunStore.getState().activeRuns[targetSessionId]
                if (remoteRun && remoteRun.status !== 'idle' && remoteRun.runId) {
                    if (!rt.inFlightTakeoverRunIds.has(remoteRun.runId)) {
                        rt.inFlightTakeoverRunIds.add(remoteRun.runId)
                        rt.pendingTakeoverAborts.add(targetSessionId)
                        const runIdToClear = remoteRun.runId
                        setTimeout(() => {
                            rt.inFlightTakeoverRunIds.delete(runIdToClear)
                            rt.pendingTakeoverAborts.delete(targetSessionId)
                        }, 3000)
                        rememberHostedRunId(rt, remoteRun.runId)
                        void getHostBridge()?.SessionAbortRun(targetSessionId)
                    }
                }
            }

            const actionResult = await queueSessionAction(
                targetSessionId,
                () => sendInternal(fixedPayload, opts),
            )
            return actionResult ?? null
        },
        [sendInternal, scopedSessionId],
    )

    const runPreparedChat = async (
        sessionId: string,
        session: Session,
        entries: ConversationEntry[],
    ): Promise<string | null> => {
        if (!service) return null
        const rt = getRuntime(service)

        if (rt.runs.has(sessionId)) {
            const existing = rt.runs.get(sessionId)!
            abortFlightAndCleanup(rt, service, sessionId, existing)
        }

        // Preserve the settings that started this session when recovering it.
        const settings = resolveSettingsForSession(session)
        const catalog = useModelCatalogStore.getState().models.slice()
        const capturedProjectId = session.projectId ?? null
        const capturedProjectPaths = resolveProjectPathsById(capturedProjectId)

        const token = ++rt.flightToken
        const runId = createId()
        rememberHostedRunId(rt, runId)
        const ac = new AbortController()

        const flight: SessionRunFlight = {
            sessionId,
            runId,
            runStatus: 'connecting',
            abortController: ac,
            flightToken: token,
        }
        rt.runs.set(sessionId, flight)
        emit(rt)

        let streamStarted = false

        try {
            const prepResult = await prepareExecutionRun({
                service,
                sessionId,
                session,
                settings,
                catalog,
                workLocation: session.workLocation,
                projectPaths: capturedProjectPaths,
                branch: session.branch,
                environmentId: session.environmentId,
                scheduleId: session.scheduleId ?? null,
                signal: ac.signal,
                allowSetup: false,
            })
            if (!prepResult.ok || !prepResult.prepared) {
                throw new AgentPreflightError(
                    'invalid_worktree_policy',
                    'Git worktree setup is not ready',
                    'agent.preflight.invalid_worktree_policy',
                )
            }
            const prepared: PreparedAgentRun = prepResult.prepared

            if (
                rt.runs.get(sessionId)?.flightToken !== token ||
                ac.signal.aborted ||
                rt.disposed
            ) {
                throw createAbortError()
            }

            rt.skills = prepared.skills
            rt.prompts = prepared.prompts
            rt.lastDiagnostics = prepared.diagnostics.map((d) => d.message)
            emit(rt)

            const adapter = createAgentEventAdapter(useMessageStore)
            const boundSessionId = sessionId
            const boundRunId = runId
            streamStarted = true

            void getHostBridge()?.SessionBroadcastRunStatus(
                boundSessionId,
                'running',
                boundRunId,
                '',
            )

            void (async () => {
                let currentBroadcastStatus: 'running' | 'thinking' | 'tool' | 'idle' = 'running'
                let runSucceeded = false
                let hasError = false
                try {
                    for await (const event of service.streamChat({
                        prepared,
                        sessionId: boundSessionId,
                        runId: boundRunId,
                        entries,
                        signal: ac.signal,
                        getRuntimeSettings: createRuntimeSettingsResolver(boundSessionId),
                        consumeSteerEntries: () => {
                            const steers = rt.pendingSteers.get(boundSessionId)
                            if (steers && steers.length > 0) {
                                rt.pendingSteers.delete(boundSessionId)
                                const now = Date.now()
                                const consumed = steers.map((steer, idx) => {
                                    const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                    if (cbs) {
                                        rt.pendingSteerCallbacks.delete(steer.id)
                                        for (const cb of cbs) {
                                            registerFlightFinishCallback(rt, token, cb)
                                        }
                                    }
                                    rt.pendingSteerItems.delete(steer.id)
                                    const entry: UserEntry = {
                                        ...steer,
                                        pendingStatus: undefined,
                                        createdAt: now + idx,
                                    }
                                    useMessageStore.getState().replaceEntry(entry)
                                    return entry
                                })
                                emit(rt)
                                return consumed
                            }
                            return undefined
                        },
                        consumeSteerEntry: () => {
                            const steers = rt.pendingSteers.get(boundSessionId)
                            if (steers && steers.length > 0) {
                                const steer = steers.shift()!
                                if (steers.length === 0) {
                                    rt.pendingSteers.delete(boundSessionId)
                                }
                                const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                if (cbs) {
                                    rt.pendingSteerCallbacks.delete(steer.id)
                                    for (const cb of cbs) {
                                        registerFlightFinishCallback(rt, token, cb)
                                    }
                                }
                                rt.pendingSteerItems.delete(steer.id)
                                const consumed: UserEntry = {
                                    ...steer,
                                    pendingStatus: undefined,
                                    createdAt: Date.now(),
                                }
                                useMessageStore.getState().replaceEntry(consumed)
                                emit(rt)
                                return consumed
                            }
                            return undefined
                        },
                    })) {
                        if (event.type === 'error') {
                            hasError = true
                        }
                        if (rt.runs.get(boundSessionId)?.flightToken !== token) break
                        void getHostBridge()?.SessionBroadcastStreamEvent(
                            boundSessionId,
                            boundRunId,
                            prepareStreamEventForBroadcast(event),
                        )
                        const nextBroadcastStatus = mapEventToBroadcastStatus(event)
                        if (nextBroadcastStatus && nextBroadcastStatus !== currentBroadcastStatus) {
                            currentBroadcastStatus = nextBroadcastStatus
                            void getHostBridge()?.SessionBroadcastRunStatus(
                                boundSessionId,
                                nextBroadcastStatus,
                                boundRunId,
                                '',
                            )
                        }
                        const applyResult = adapter.apply(event)
                        scheduleFromUrgency(applyResult.urgency)
                        const currentFlight = rt.runs.get(boundSessionId)
                        if (currentFlight && currentFlight.flightToken === token) {
                            currentFlight.runStatus = mapRunStatus(event, currentFlight.runStatus)
                            emit(rt)
                        }
                    }
                    if (!hasError && rt.runs.get(boundSessionId)?.flightToken === token) {
                        runSucceeded = true
                    }
                } catch (error) {
                    hasError = true
                    runSucceeded = false
                    if (ac.signal.aborted || isAbortError(error)) {
                        // silent abort
                    } else if (!(error instanceof AgentPreflightError)) {
                        const message =
                            error instanceof Error
                                ? error.message
                                : String(error ?? 'stream error')
                        adapter.apply({
                            type: 'error',
                            runId: boundRunId,
                            sessionId: boundSessionId,
                            message,
                        })
                        schedulePersist(true)
                        if (boundSessionId !== useSessionStore.getState().currentSessionId && typeof window !== 'undefined' && getHashRoutePathname() !== `/chat/${boundSessionId}`) {
                            useSessionStore.getState().markUnread(boundSessionId, 'error')
                        }
                        const errorToast = message
                            ? `${i18n.t('composer.sendFailed', { defaultValue: 'Send failed' })}: ${message}`
                            : i18n.t('composer.sendFailed', { defaultValue: 'Send failed' })
                        useUiStore.getState().pushToast(errorToast)
                    }
                } finally {
                    if (boundSessionId && boundRunId && adapter.getActiveRunId(boundSessionId) === boundRunId) {
                        if (ac.signal.aborted) {
                            adapter.apply({
                                type: 'aborted',
                                sessionId: boundSessionId,
                                runId: boundRunId,
                            })
                        }
                        adapter.apply({
                            type: 'agent-end',
                            sessionId: boundSessionId,
                            runId: boundRunId,
                        })
                    }
                    if (boundSessionId !== useSessionStore.getState().currentSessionId && typeof window !== 'undefined' && getHashRoutePathname() !== `/chat/${boundSessionId}`) {
                        const session = useSessionStore.getState().sessions.find((s) => s.id === boundSessionId)
                        if (session && session.unread !== 'error') {
                            useSessionStore.getState().markUnread(boundSessionId, true)
                        }
                    }
                    void getHostBridge()?.SessionBroadcastRunStatus(
                        boundSessionId,
                        'idle',
                        boundRunId,
                        '',
                    )
                    if (!ac.signal.aborted && runSucceeded && boundSessionId) {
                        const session = useSessionStore.getState().sessions.find((s) => s.id === boundSessionId)
                        const title = session?.title || ''
                        void getHostBridge()?.NotificationTaskCompleted?.({
                            sessionId: boundSessionId,
                            sessionTitle: title,
                        })
                    }
                    const isOwnerFlight = rt.runs.get(boundSessionId)?.flightToken === token
                    if (isOwnerFlight) {
                        const unconsumedSteers = rt.pendingSteers.get(boundSessionId)
                        if (unconsumedSteers && unconsumedSteers.length > 0) {
                            rt.pendingSteers.delete(boundSessionId)
                            let queue = rt.sessionQueues.get(boundSessionId)
                            if (!queue) {
                                queue = []
                                rt.sessionQueues.set(boundSessionId, queue)
                            }
                            for (const steer of unconsumedSteers) {
                                const item = rt.pendingSteerItems.get(steer.id)
                                const cbs = rt.pendingSteerCallbacks.get(steer.id)
                                rt.pendingSteerItems.delete(steer.id)
                                rt.pendingSteerCallbacks.delete(steer.id)
                                useMessageStore.getState().replaceEntry({
                                    ...steer,
                                    pendingStatus: 'queue',
                                })
                                const combinedCb = cbs && cbs.length > 0
                                    ? (succeeded: boolean) => {
                                          for (const cb of cbs) {
                                              try {
                                                  cb(succeeded)
                                              } catch (err) {
                                                  console.error('[AgentStream] Error in transferred steer callback:', err)
                                              }
                                          }
                                      }
                                    : undefined

                                queue.push(item ? {
                                    ...item,
                                    payload: {
                                        ...item.payload,
                                        onRunFinish: combinedCb,
                                    },
                                } : {
                                    entry: steer,
                                    payload: {
                                        text: joinUserEntryText(steer),
                                        images: extractUserEntryImages(steer),
                                        sessionId: boundSessionId,
                                        onRunFinish: combinedCb,
                                    },
                                })
                            }
                            schedulePersist(true)
                        }
                    }
                    releaseFlight(rt, boundSessionId, token, ac.signal.aborted)
                    const succeeded = !ac.signal.aborted && runSucceeded
                    flushFlightFinishCallbacks(rt, token, succeeded)
                }
            })()

            return sessionId
        } catch (error) {
            flushFlightFinishCallbacks(rt, token, false)
            if (!isAbortError(error)) {
                toastPreflight(error)
            }
            throw error
        } finally {
            if (!streamStarted) {
                releaseFlight(rt, sessionId, token, true)
            }
        }
    }

function applyTurnPauseDelta(entries: readonly ConversationEntry[]): ConversationEntry[] {
    if (!entries || entries.length === 0) return []

    let lastUserIndex = -1
    for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.kind === 'user') {
            lastUserIndex = i
            break
        }
    }

    const targetIndex = lastUserIndex >= 0 ? lastUserIndex : 0
    const targetEntry = entries[targetIndex]
    if (!targetEntry) return entries.slice()

    const trailingEntries = entries.slice(targetIndex)
    let stoppedAt: number | undefined
    for (const entry of trailingEntries) {
        if (!entry) continue
        if (typeof (entry as any).completedAt === 'number' && Number.isFinite((entry as any).completedAt)) {
            const c = (entry as any).completedAt as number
            stoppedAt = stoppedAt === undefined ? c : Math.max(stoppedAt, c)
        }
        if (typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)) {
            stoppedAt = stoppedAt === undefined ? entry.createdAt : Math.max(stoppedAt, entry.createdAt)
        }
    }

    if (typeof stoppedAt !== 'number' || !Number.isFinite(stoppedAt)) {
        return entries.slice()
    }

    const now = Date.now()
    const pauseDelta = Math.max(0, now - stoppedAt)
    if (pauseDelta <= 0) {
        return entries.slice()
    }

    const currentPaused =
        typeof targetEntry.pausedMs === 'number' && Number.isFinite(targetEntry.pausedMs) && targetEntry.pausedMs > 0
            ? targetEntry.pausedMs
            : 0

    const updatedTarget: ConversationEntry = {
        ...targetEntry,
        pausedMs: currentPaused + pauseDelta,
    }

    const result = entries.slice()
    result[targetIndex] = updatedTarget
    return result
}

    const resumeSession = useCallback(
        async (targetSessionId?: string): Promise<string | null> => {
            if (!service) return null
            const rt = getRuntime(service)
            if (rt.disposed) return null

            const sessionState = useSessionStore.getState()
            const sessionId =
                targetSessionId ||
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : sessionState.currentSessionId)
            if (!sessionId) return null
            if (rt.runs.has(sessionId)) return null

            const session = sessionState.sessions.find((s) => s.id === sessionId)
            if (!session) return null

            await ensureSessionLoaded(sessionId)
            const rawEntries = useMessageStore.getState().getEntries(sessionId)
            const unfinishedSubAgents = useSubAgentStore.getState().agents.filter(
                (a) =>
                    a.parentSessionId === sessionId &&
                    (a.status === 'running' || a.status === 'queued' || a.status === 'aborted'),
            )

            if (!isSessionResumable(rawEntries) && unfinishedSubAgents.length === 0) {
                return null
            }

            const entriesWithPause = applyTurnPauseDelta(rawEntries)
            const entries = cleanUnfinishedEntries(entriesWithPause)
            if (entries.length !== rawEntries.length || entries.some((e, i) => e !== rawEntries[i])) {
                useMessageStore.getState().replaceSessionEntries(sessionId, entries, { historyMutation: 'truncate' })
                schedulePersist(true)
            }

            // Ensure child subagent sessions are loaded and cleaned
            for (const subAgent of unfinishedSubAgents) {
                await ensureSessionLoaded(subAgent.sessionId)
                const childRaw = useMessageStore.getState().getEntries(subAgent.sessionId)
                const childWithPause = applyTurnPauseDelta(childRaw)
                const childEntries = cleanUnfinishedEntries(childWithPause)
                if (childEntries.length !== childRaw.length || childEntries.some((e, i) => e !== childRaw[i])) {
                    useMessageStore.getState().replaceSessionEntries(subAgent.sessionId, childEntries, { historyMutation: 'truncate' })
                    schedulePersist(true)
                }
            }

            const refreshedEntries = useMessageStore.getState().getEntries(sessionId)
            const cleanedRefreshed = cleanUnfinishedEntries(refreshedEntries)
            if (cleanedRefreshed.length !== refreshedEntries.length || cleanedRefreshed.some((e, i) => e !== refreshedEntries[i])) {
                useMessageStore.getState().replaceSessionEntries(sessionId, cleanedRefreshed, { historyMutation: 'truncate' })
                schedulePersist(true)
            }

            // The host binds before lazy SQLite hydration, so refresh it immediately
            // before replaying a pending spawn call or resuming a child directly.
            hydrateSubAgentHost(service)

            if (!isSessionResumable(cleanedRefreshed)) {
                // If parent session is not unfinished, resume any unfinished subagents under prepared host
                const settings = resolveSettingsForSession(session)
                const catalog = useModelCatalogStore.getState().models.slice()
                const capturedProjectId = session.projectId ?? null
                const capturedProjectPaths = resolveProjectPathsById(capturedProjectId)
                const ac = new AbortController()
                const prepResult = await prepareExecutionRun({
                    service,
                    sessionId: session.id,
                    session,
                    settings,
                    catalog,
                    workLocation: session.workLocation,
                    projectPaths: capturedProjectPaths,
                    branch: session.branch,
                    environmentId: session.environmentId,
                    scheduleId: session.scheduleId ?? null,
                    signal: ac.signal,
                    allowSetup: false,
                })
                if (!prepResult.ok || !prepResult.prepared) {
                    return null
                }
                for (const subAgent of unfinishedSubAgents) {
                    const childEntries = useMessageStore.getState().getEntries(subAgent.sessionId)
                    if (service.subAgents) {
                        try {
                            await service.subAgents.resumeSubAgent(subAgent.id, {
                                signal: ac.signal,
                                entries: childEntries,
                            })
                        } catch (e) {
                            console.error('Failed to resume subagent:', e)
                        }
                    }
                }
                return sessionId
            }

            return runPreparedChat(sessionId, session, cleanedRefreshed)
        },
        [service, scopedSessionId],
    )

    const retrySession = useCallback(
        async (
            targetSessionId?: string,
            targetMessageId?: string,
        ): Promise<string | null> => {
            if (!service) return null
            const rt = getRuntime(service)
            if (rt.disposed) return null

            const sessionState = useSessionStore.getState()
            const sessionId =
                targetSessionId ||
                (scopedSessionId !== undefined
                    ? scopedSessionId
                    : sessionState.currentSessionId)
            if (!sessionId) return null
            if (rt.runs.has(sessionId)) return null

            const session = sessionState.sessions.find((s) => s.id === sessionId)
            if (!session) return null

            await ensureSessionLoaded(sessionId)
            const rawEntries = useMessageStore.getState().getEntries(sessionId)
            if (rawEntries.length === 0) return null

            // Find the last user entry index in rawEntries
            let lastUserIndex = -1
            for (let i = rawEntries.length - 1; i >= 0; i -= 1) {
                if (rawEntries[i]?.kind === 'user') {
                    lastUserIndex = i
                    break
                }
            }

            let cutEntries: ConversationEntry[]
            if (targetMessageId) {
                const targetIndex = rawEntries.findIndex(
                    (e) => e.id === targetMessageId,
                )
                // If target message belongs to an older turn (before the last user message),
                // cut back to that target point. Otherwise, keep the full turn's progress.
                if (targetIndex >= 0 && lastUserIndex >= 0 && targetIndex < lastUserIndex) {
                    cutEntries = rawEntries.slice(0, targetIndex + 1)
                } else {
                    cutEntries = rawEntries.slice()
                }
            } else {
                cutEntries = rawEntries.slice()
            }

            const cleanedEntries = cleanUnfinishedEntries(cutEntries)
            if (cleanedEntries.length === 0) return null

            let lastUserIdx = -1
            for (let i = cleanedEntries.length - 1; i >= 0; i -= 1) {
                if (cleanedEntries[i]?.kind === 'user') {
                    lastUserIdx = i
                    break
                }
            }
            const refreshedEntries = cleanedEntries.map((entry, idx) => {
                if (idx === lastUserIdx && entry.kind === 'user') {
                    const copy: ConversationEntry = { ...entry, createdAt: Date.now() }
                    delete copy.pausedMs
                    return copy
                }
                return entry
            })

            useMessageStore
                .getState()
                .replaceSessionEntries(sessionId, refreshedEntries, { historyMutation: 'truncate' })
            schedulePersist(true)
            hydrateSubAgentHost(service)

            return runPreparedChat(sessionId, session, refreshedEntries)
        },
        [service, scopedSessionId],
    )

    useEffect(() => {
        if (service) {
            const rt = getRuntime(service)
            rt.sendHandler = send
            rt.sendInternalHandler = sendInternal
            if (rt.pendingDelegateRuns.length > 0) {
                const pending = rt.pendingDelegateRuns.slice()
                rt.pendingDelegateRuns.length = 0
                for (const req of pending) {
                    void queueDelegateRun(rt, req)
                }
            }
            if (!isBrowserEnvironment()) {
                void (async () => {
                    try {
                        const claimed = await getHostBridge()?.SessionClaimPendingDelegateRuns?.()
                        if (claimed && Array.isArray(claimed) && claimed.length > 0 && !rt.disposed) {
                            for (const req of claimed) {
                                if (rt.disposed || !rt.sendHandler) break
                                void queueDelegateRun(rt, req)
                            }
                        }
                    } catch {
                        // Ignore claim error
                    }
                })()
            }
            bindSubAgentHost(service)
            bindNativeSync(service)
            const unsubReconnect = onHostReconnect(() => {
                if (pendingAcks.size > 0) {
                    for (const ackId of Array.from(pendingAcks)) {
                        void ackDelegateRunSafely(ackId)
                    }
                }
            })
            const unregisterController = registerHostAgentController({
                send: (payload, opts) => send(payload, opts),
                stop,
                abort: stop,
                cancelSessionWarmers: (targetSessionId?: string | null) => {
                    void service.cancelSessionWarmers?.(targetSessionId ?? undefined)
                },
                compact: (focus: string, targetSessionId?: string | null) =>
                    compact(focus, targetSessionId ?? undefined),
                retrySession: async (targetSessionId: string) => {
                    await retrySession(targetSessionId)
                },
                resumeSession: async (targetSessionId: string) => {
                    return await resumeSession(targetSessionId)
                },
                approveTool,
                rejectTool,
                dequeueMessage: (sId: string, mId: string) => {
                    return dequeueQueuedMessage(rt, sId, mId)
                },
                getPrompts: () => rt.prompts,
                subscribePrompts: (listener: () => void) => {
                    rt.listeners.add(listener)
                    return () => {
                        rt.listeners.delete(listener)
                    }
                },
                getRunState: (sId: string) => {
                    const snap = getSnapshotForSession(rt, sId)
                    return {
                        isStreaming: snap.isStreaming,
                        activeRunId: snap.runId,
                        runState:
                            snap.runStatus !== 'idle'
                                ? { status: snap.runStatus, sessionId: sId, runId: snap.runId }
                                : undefined,
                    }
                },
                subscribeRunState: (_sId: string, listener: () => void) => {
                    rt.listeners.add(listener)
                    return () => {
                        rt.listeners.delete(listener)
                    }
                },
            })
            return () => {
                unsubReconnect()
                unregisterController()
            }
        }
    }, [service, send, stop, compact, retrySession, resumeSession, approveTool, rejectTool])

    return useMemo(
        () => ({
            send,
            resumeSession,
            retrySession,
            stop,
            isStreaming: snap.isStreaming,
            isReady: Boolean(service),
            runStatus: snap.runStatus,
            sessionId: snap.sessionId,
            runId: snap.runId,
            supportsImages,
            skills: snap.skills,
            prompts: snap.prompts,
            lastDiagnostics: snap.lastDiagnostics,
            approveTool,
            rejectTool,
            compact,
        }),
        [
            send,
            resumeSession,
            retrySession,
            stop,
            snap.isStreaming,
            service,
            snap.runStatus,
            snap.sessionId,
            snap.runId,
            supportsImages,
            snap.skills,
            snap.prompts,
            snap.lastDiagnostics,
            approveTool,
            rejectTool,
            compact,
        ],
    )
}

/**
 * Lightweight hook that only subscribes to active skills, avoiding re-renders
 * during high-frequency token streaming.
 */
export function useAgentSkills(): readonly Skill[] {
    const service = useAgentService()
    const getSkills = useCallback((): readonly Skill[] => {
        if (!service) return []
        return getRuntime(service).skills
    }, [service])

    const subscribe = useCallback(
        (listener: () => void) => {
            if (!service) return () => {}
            const rt = getRuntime(service)
            rt.listeners.add(listener)
            return () => {
                rt.listeners.delete(listener)
            }
        },
        [service],
    )

    return useSyncExternalStore(subscribe, getSkills, () => [])
}
