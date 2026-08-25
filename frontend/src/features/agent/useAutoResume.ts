import { useEffect, useRef } from 'react'
import { createId } from '@/lib/id'
import { isBrowserEnvironment } from '@/lib/platform'
import { getHostBridge, subscribeHostNativeEvents } from '@/application/services/hostTransport'
import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSessionRunStore } from '@/stores/sessionRunStore'
import { useMessageStore } from '@/stores/messageStore'
import { useSubAgentStore } from '@/stores/subAgentStore'
import { useResumePromptStore } from '@/stores/resumePromptStore'
import { useWorktreeSetupStore } from '@/stores/worktreeSetupStore'
import {
  ensureSessionLoaded,
  loadSessionEntries,
  schedulePersist,
} from '@/application/services/persistenceService'
import {
  isSessionUnfinished,
  isSubAgentUnfinished,
  subAgentParentCallState,
} from '@/features/agent-runtime/session/unfinished'
import type { SubAgentRecord } from '@cpa/plugin-api'
import type { AssistantEntry } from '@/features/agent-runtime/session/types'

let hasAutoResumed = false
let activeTimer: ReturnType<typeof setInterval> | null = null

/** Reset flag and timer for unit tests */
export function __resetAutoResumedForTests(): void {
  hasAutoResumed = false
  if (activeTimer) {
    clearInterval(activeTimer)
    activeTimer = null
  }
  useResumePromptStore.getState().closePrompt()
}

export interface ScanResult {
  totalCount: number
  unfinishedSessionIds: string[]
  unfinishedSubAgentIds: string[]
}

function healSubAgent(
  subAgent: SubAgentRecord,
  status: 'completed' | 'aborted',
  updatedAt: number,
): void {
  const healed: SubAgentRecord = {
    ...subAgent,
    status,
    updatedAt,
  }
  useSubAgentStore.getState().mergeHostAgents([healed])
  const bridge = getHostBridge()
  if (bridge?.SessionUpdateSubAgent) {
    void bridge.SessionUpdateSubAgent(healed)
  }
}

export async function scanUnfinishedTasks(): Promise<ScanResult> {
  let sessions = useSessionStore.getState().sessions

  // In desktop/electron mode, ensure we query the authoritative sessions list from SQLite
  const bridge = getHostBridge()
  if (typeof bridge?.SessionListSessions === 'function') {
    try {
      const remote = await bridge.SessionListSessions()
      if (Array.isArray(remote) && remote.length > 0) {
        for (const s of remote) {
          useSessionStore.getState().upsertRemoteSession(s)
        }
        sessions = useSessionStore.getState().sessions
      }
    } catch {
      // Ignore
    }
  }

  // Exclude active running sessions (status !== 'idle') from unfinished scan
  const activeRunningSessionIds = new Set<string>()
  const localActiveRuns = useSessionRunStore.getState().activeRuns
  for (const [id, run] of Object.entries(localActiveRuns)) {
    if (run && run.status && run.status !== 'idle') {
      activeRunningSessionIds.add(id)
    }
  }

  if (typeof bridge?.SessionGetActiveRuns === 'function') {
    try {
      const remoteRuns = await bridge.SessionGetActiveRuns()
      if (Array.isArray(remoteRuns)) {
        for (const run of remoteRuns) {
          if (run && run.sessionId && run.status && run.status !== 'idle') {
            activeRunningSessionIds.add(run.sessionId)
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  // Filter out archived sessions from auto-resume scan
  const activeSessions = sessions.filter((s) => !s.archivedAt)
  const activeSessionIdSet = new Set(activeSessions.map((s) => s.id))

  const unfinishedSessionIds: string[] = []
  const unfinishedSubAgentIds: string[] = []

  const sessionIdsToScan = new Set(activeSessionIdSet)
  const currentSessionId = useSessionStore.getState().currentSessionId
  if (currentSessionId && activeSessionIdSet.has(currentSessionId)) {
    sessionIdsToScan.add(currentSessionId)
  }

  for (const sessionId of sessionIdsToScan) {
    if (activeRunningSessionIds.has(sessionId)) {
      continue
    }
    try {
      const inMemory = useMessageStore.getState().getEntries(sessionId)
      const entries =
        inMemory && inMemory.length > 0
          ? inMemory
          : (await loadSessionEntries(sessionId)) ?? []
      // If worktree setup failed (checkout or environment script), do not treat as an unfinished task to resume
      const worktreeSetup =
        useWorktreeSetupStore.getState().getSetup(sessionId) ??
        useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.worktreeSetup
      if (worktreeSetup && worktreeSetup.status === 'error') {
        continue
      }
      if (isSessionUnfinished(entries)) {
        unfinishedSessionIds.push(sessionId)
      }
    } catch {
      // Ignore load failure
    }
  }

  // Re-fetch all subagents after sessions have been loaded into memory
  const allSubAgents = useSubAgentStore.getState().agents
  for (const sa of allSubAgents) {
    if (sa.status !== 'running' && sa.status !== 'queued') {
      continue
    }
    // Skip subagents whose parent session is archived, not active, or currently running
    if (
      sa.parentSessionId &&
      (!activeSessionIdSet.has(sa.parentSessionId) || activeRunningSessionIds.has(sa.parentSessionId))
    ) {
      continue
    }
    if (activeRunningSessionIds.has(sa.sessionId)) {
      continue
    }
    // Skip subagents if parent session or subagent session had failed worktree setup
    if (sa.parentSessionId) {
      const parentSetup =
        useWorktreeSetupStore.getState().getSetup(sa.parentSessionId) ??
        useSessionStore.getState().sessions.find((s) => s.id === sa.parentSessionId)?.worktreeSetup
      if (parentSetup && parentSetup.status === 'error') {
        continue
      }
    }
    const childSetup =
      useWorktreeSetupStore.getState().getSetup(sa.sessionId) ??
      useSessionStore.getState().sessions.find((s) => s.id === sa.sessionId)?.worktreeSetup
    if (childSetup && childSetup.status === 'error') {
      continue
    }

    const inMemoryParent = sa.parentSessionId
      ? useMessageStore.getState().getEntries(sa.parentSessionId)
      : undefined
    const parentEntries =
      inMemoryParent && inMemoryParent.length > 0
        ? inMemoryParent
        : sa.parentSessionId
          ? ((await loadSessionEntries(sa.parentSessionId)) ?? undefined)
          : undefined
    const parentCallState = subAgentParentCallState(sa, parentEntries)
    if (parentCallState === 'missing' || parentCallState === 'fulfilled') {
      const lastParentEntry = parentEntries?.[parentEntries.length - 1]
      const healedAt =
        typeof lastParentEntry?.createdAt === 'number' ? lastParentEntry.createdAt : Date.now()
      healSubAgent(
        sa,
        parentCallState === 'fulfilled' ? 'completed' : 'aborted',
        healedAt,
      )
      continue
    }

    try {
      const inMemoryChild = useMessageStore.getState().getEntries(sa.sessionId)
      const childEntries =
        inMemoryChild && inMemoryChild.length > 0
          ? inMemoryChild
          : (await loadSessionEntries(sa.sessionId)) ?? []
      if (isSubAgentUnfinished(sa, childEntries)) {
        unfinishedSubAgentIds.push(sa.id)
      } else {
        // Self-heal a persisted active state after the child finished cleanly.
        const lastEntry = childEntries[childEntries.length - 1]
        const completedAt =
          typeof lastEntry?.createdAt === 'number' ? lastEntry.createdAt : Date.now()
        healSubAgent(sa, 'completed', completedAt)
      }
    } catch {
      if (isSubAgentUnfinished(sa)) {
        unfinishedSubAgentIds.push(sa.id)
      }
    }
  }

  const resumableParentIds = new Set(unfinishedSessionIds)
  const subAgentsById = new Map(allSubAgents.map((agent) => [agent.id, agent]))
  for (const subAgentId of unfinishedSubAgentIds) {
    const subAgent = subAgentsById.get(subAgentId)
    resumableParentIds.add(subAgent?.parentSessionId || subAgent?.sessionId || subAgentId)
  }
  const totalCount = resumableParentIds.size
  return { totalCount, unfinishedSessionIds, unfinishedSubAgentIds }
}

/**
 * Automatically prompts or resumes unfinished conversations and subagents on application start
 * if the `resumeUnfinishedConversations` setting is enabled.
 */
export function useAutoResume(
  resumeSession: (sessionId?: string) => Promise<string | null>,
  isReady = true,
): void {
  const executedRef = useRef(false)
  const resumeSessionRef = useRef(resumeSession)
  resumeSessionRef.current = resumeSession

  useEffect(() => {
    if (!isReady) {
      if (!hasAutoResumed && !executedRef.current) {
        if (activeTimer) {
          clearInterval(activeTimer)
          activeTimer = null
        }
        useResumePromptStore.getState().closePrompt()
      }
      return
    }
    // Only desktop/Electron environment actively runs unfinished task scanning and countdown control.
    // In web browser environment, prompt visibility and countdown are synchronized from the desktop main process.
    if (isBrowserEnvironment()) {
      return
    }
    if (hasAutoResumed || executedRef.current) return
    executedRef.current = true
    hasAutoResumed = true

    let unsubscribeAction: (() => void) | null = null

    void (async () => {
      const settings = useSettingsStore.getState().settings
      const bridge = getHostBridge()
      if (!settings.resumeUnfinishedConversations) {
        if (typeof bridge?.SessionBroadcastResumePromptState === 'function') {
          void bridge.SessionBroadcastResumePromptState({
            isOpen: false,
            totalCount: 0,
            countdown: 0,
            unfinishedSessionIds: [],
            unfinishedSubAgentIds: [],
          })
        }
        return
      }

      const { totalCount, unfinishedSessionIds, unfinishedSubAgentIds } =
        await scanUnfinishedTasks()

      if (totalCount === 0) {
        if (typeof bridge?.SessionBroadcastResumePromptState === 'function') {
          void bridge.SessionBroadcastResumePromptState({
            isOpen: false,
            totalCount: 0,
            countdown: 0,
            unfinishedSessionIds: [],
            unfinishedSubAgentIds: [],
          })
        }
        return
      }

      const broadcastClose = () => {
        if (typeof bridge?.SessionBroadcastResumePromptState === 'function') {
          void bridge.SessionBroadcastResumePromptState({
            isOpen: false,
            totalCount: 0,
            countdown: 0,
            unfinishedSessionIds: [],
            unfinishedSubAgentIds: [],
          })
        }
      }

      const doResume = async () => {
        if (activeTimer) {
          clearInterval(activeTimer)
          activeTimer = null
        }
        useResumePromptStore.getState().closePrompt()
        broadcastClose()

        // 1. Ensure subagent sessions are loaded
        for (const subAgentId of unfinishedSubAgentIds) {
          const sa = useSubAgentStore.getState().agents.find((a) => a.id === subAgentId)
          if (!sa) continue
          await ensureSessionLoaded(sa.sessionId)
        }

        // 2. Resume every unfinished parent session, with the visible session first
        const agents = useSubAgentStore.getState().agents
        const subAgentParentIds = unfinishedSubAgentIds.flatMap((subAgentId) => {
          const parentSessionId = agents.find((agent) => agent.id === subAgentId)?.parentSessionId
          return parentSessionId ? [parentSessionId] : []
        })
        const sessionIds = [...new Set([...unfinishedSessionIds, ...subAgentParentIds])]
        const currentSessionId = useSessionStore.getState().currentSessionId
        const orderedSessionIds =
          currentSessionId && sessionIds.includes(currentSessionId)
            ? [currentSessionId, ...sessionIds.filter((id) => id !== currentSessionId)]
            : sessionIds

        for (const sessionId of orderedSessionIds) {
          try {
            await resumeSessionRef.current(sessionId)
          } catch (error) {
            console.error(`Failed to resume session ${sessionId}:`, error)
          }
        }
      }

      const doAbort = async () => {
        if (activeTimer) {
          clearInterval(activeTimer)
          activeTimer = null
        }
        useResumePromptStore.getState().closePrompt()
        broadcastClose()

        // 1. Mark unfinished sessions as aborted
        for (const sessionId of unfinishedSessionIds) {
          await ensureSessionLoaded(sessionId)
          const entries = useMessageStore.getState().getEntries(sessionId)
          if (entries.length === 0) continue
          const last = entries[entries.length - 1]
          if (last && last.kind === 'assistant') {
            const updated = entries.map((entry, idx) =>
              idx === entries.length - 1 && entry.kind === 'assistant'
                ? {
                    ...entry,
                    status: 'aborted' as const,
                    stopReason: 'aborted' as const,
                    errorMessage: undefined,
                    completedAt:
                      typeof (entry as any).completedAt === 'number'
                        ? (entry as any).completedAt
                        : Date.now(),
                  }
                : entry,
            )
            useMessageStore.getState().replaceSessionEntries(sessionId, updated)
          } else {
            const abortedEntry: AssistantEntry = {
              id: createId(),
              sessionId,
              createdAt: Date.now(),
              kind: 'assistant',
              content: [],
              stopReason: 'aborted',
              status: 'aborted',
            }
            useMessageStore.getState().appendEntry(abortedEntry)
          }
        }

        // 2. Mark unfinished subagents as aborted
        const currentAgents = useSubAgentStore.getState().agents
        const updatedAgents = currentAgents.map((a) =>
          unfinishedSubAgentIds.includes(a.id)
            ? { ...a, status: 'aborted' as const }
            : a,
        )
        useSubAgentStore.getState().replaceAll(updatedAgents)
        schedulePersist(true)
      }

      // Listen for prompt action (continue/abort) delegated from web clients
      unsubscribeAction = subscribeHostNativeEvents((event) => {
        if (event?.kind === 'session:resume-prompt-action' && event.data) {
          try {
            const parsed = JSON.parse(event.data) as { action?: 'continue' | 'abort' }
            if (parsed?.action === 'continue') {
              void doResume()
            } else if (parsed?.action === 'abort') {
              void doAbort()
            }
          } catch {
            // Ignore parse error
          }
        }
      })

      // Open the prompt with 30s countdown
      useResumePromptStore.getState().openPrompt({
        totalCount,
        countdown: 30,
        unfinishedSessionIds,
        unfinishedSubAgentIds,
        onContinue: doResume,
        onAbort: doAbort,
      })

      if (typeof bridge?.SessionBroadcastResumePromptState === 'function') {
        void bridge.SessionBroadcastResumePromptState({
          isOpen: true,
          totalCount,
          countdown: 30,
          unfinishedSessionIds,
          unfinishedSubAgentIds,
        })
      }

      // Start the 30-second ticker
      if (activeTimer) {
        clearInterval(activeTimer)
      }
      activeTimer = setInterval(() => {
        const currentCountdown = useResumePromptStore.getState().countdown
        if (currentCountdown <= 1) {
          if (activeTimer) {
            clearInterval(activeTimer)
            activeTimer = null
          }
          void doResume()
        } else {
          useResumePromptStore.getState().decrementCountdown()
          const nextCountdown = useResumePromptStore.getState().countdown
          if (typeof bridge?.SessionBroadcastResumePromptState === 'function') {
            void bridge.SessionBroadcastResumePromptState({
              isOpen: true,
              totalCount,
              countdown: nextCountdown,
              unfinishedSessionIds,
              unfinishedSubAgentIds,
            })
          }
        }
      }, 1000)
    })()

    return () => {
      if (unsubscribeAction) {
        unsubscribeAction()
      }
    }
  }, [isReady])
}
