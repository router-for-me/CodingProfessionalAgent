import { create } from 'zustand'
import { createId } from '@/lib/id'
import { deriveSessionTitle } from '@/lib/title'
import { useProjectStore } from './projectStore'
import { DEFAULT_SETTINGS, type Session, type SessionRightSidebarState, type SessionUnreadState, type WorktreeSessionSetup } from '@/types/models'

type RemoteSessionDeleteListener = (sessionId: string) => void
const remoteSessionDeleteListeners = new Set<RemoteSessionDeleteListener>()

export function onRemoteSessionDelete(
  listener: RemoteSessionDeleteListener,
): () => void {
  remoteSessionDeleteListeners.add(listener)
  return () => {
    remoteSessionDeleteListeners.delete(listener)
  }
}

interface CreateSessionInput {
  id?: string
  title?: string
  projectId?: string
  scheduleId?: string
  parentSessionId?: string
  branch?: string
  baseBranch?: string
  pinned?: boolean
  firstPromptAt?: number
  workLocation?: 'local' | 'worktree'
  worktreePath?: string
  environmentId?: string | null
  worktreeSetup?: WorktreeSessionSetup
  pinnedSummaryVisible?: boolean
  modelId?: string
  reasoningEffort?: string
  speed?: Session['speed']
}

interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  manuallyMarkedUnreadSessionIds: string[]
  createSession: (input?: CreateSessionInput) => string
  renameSession: (id: string, title: string) => void
  setSessionProject: (id: string, projectId: string | undefined) => void
  setSessionScheduleId: (id: string, scheduleId: string | undefined) => void
  setSessionParentId: (id: string, parentSessionId: string | undefined) => void
  setSessionBranch: (id: string, branch: string | undefined) => void
  setSessionBaseBranch: (id: string, baseBranch: string | undefined) => void
  setSessionWorktree: (
    id: string,
    workLocation: 'local' | 'worktree',
    worktreePath?: string,
    environmentId?: string | null,
  ) => void
  setSessionWorktreeSetup: (
    id: string,
    worktreeSetup: WorktreeSessionSetup | undefined,
    options?: {
      touchUpdatedAt?: boolean
      updateProject?: boolean
    },
  ) => void
  setSessionFirstPromptAt: (id: string, firstPromptAt: number) => void
  setSessionRuntimeSettings: (
    id: string,
    settings: Pick<Session, 'modelId' | 'reasoningEffort' | 'speed'>,
  ) => void
  setSessionRightSidebar: (
    id: string,
    sidebar: Partial<SessionRightSidebarState> | SessionRightSidebarState,
  ) => void
  setSessionPinnedSummaryVisible: (id: string, visible: boolean) => void
  archiveSession: (id: string) => void
  unarchiveSession: (id: string) => void
  removeSession: (id: string) => void
  removeArchivedSessions: () => void
  togglePin: (id: string) => void
  markUnread: (id: string, unreadState?: SessionUnreadState) => void
  markUnreadManually: (id: string) => void
  markRead: (id: string) => void
  setCurrentSession: (id: string | null) => void
  upsertRemoteSession: (session: Session) => void
  removeRemoteSession: (sessionId: string) => void
  hydrate: (data: {
    sessions?: Session[]
    currentSessionId?: string | null
  }) => void
}

function isViewingSession(sessionId: string, currentSessionId: string | null): boolean {
  return currentSessionId === sessionId
}

function pickNewestSessionId(sessions: Session[]): string | null {
  let newest: Session | null = null
  for (const session of sessions) {
    if (session.archivedAt !== undefined) continue
    if (!newest || session.updatedAt > newest.updatedAt) {
      newest = session
    }
  }
  return newest?.id ?? null
}

function notifyRemoteSessionDelete(sessionId: string): void {
  for (const listener of remoteSessionDeleteListeners) {
    try {
      listener(sessionId)
    } catch {
      // Ignore subscriber errors
    }
  }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  manuallyMarkedUnreadSessionIds: [],

  createSession: (input) => {
    if (input?.id && get().sessions.some((s) => s.id === input.id)) {
      return input.id
    }
    const now = Date.now()
    const id = input?.id || createId()
    const title =
      input?.title ?? deriveSessionTitle('', DEFAULT_SETTINGS.locale)
    const session: Session = {
      id,
      projectId: input?.projectId,
      scheduleId: input?.scheduleId,
      parentSessionId: input?.parentSessionId,
      branch: input?.branch,
      baseBranch: input?.baseBranch,
      title,
      pinned: input?.pinned ?? false,
      firstPromptAt: input?.firstPromptAt,
      workLocation: input?.workLocation,
      worktreePath: input?.worktreePath,
      environmentId: input?.environmentId,
      worktreeSetup: input?.worktreeSetup,
      pinnedSummaryVisible: input?.pinnedSummaryVisible,
      modelId: input?.modelId,
      reasoningEffort: input?.reasoningEffort,
      speed: input?.speed,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
    }))
    if (input?.projectId && (input?.workLocation !== undefined || input?.environmentId !== undefined)) {
      useProjectStore.getState().updateProject(input.projectId, {
        ...(input.workLocation !== undefined ? { workLocation: input.workLocation } : {}),
        ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      })
    }
    return id
  },

  renameSession: (id, title) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, title, updatedAt }
          : session,
      ),
    }))
  },

  setSessionProject: (id, projectId) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, projectId, updatedAt }
          : session,
      ),
    }))
  },

  setSessionScheduleId: (id, scheduleId) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, scheduleId, updatedAt }
          : session,
      ),
    }))
  },

  setSessionParentId: (id, parentSessionId) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, parentSessionId, updatedAt }
          : session,
      ),
    }))
  },

  setSessionBranch: (id, branch) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, branch, updatedAt }
          : session,
      ),
    }))
  },

  setSessionBaseBranch: (id, baseBranch) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, baseBranch, updatedAt }
          : session,
      ),
    }))
  },

  setSessionWorktree: (id, workLocation, worktreePath, environmentId) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, workLocation, worktreePath, environmentId, updatedAt }
          : session,
      ),
    }))
    const session = get().sessions.find((s) => s.id === id)
    if (session?.projectId) {
      useProjectStore.getState().updateProject(session.projectId, {
        ...(workLocation !== undefined ? { workLocation } : {}),
        ...(environmentId !== undefined ? { environmentId } : {}),
      })
    }
  },

  setSessionWorktreeSetup: (id, worktreeSetup, options) => {
    const touchUpdatedAt = options?.touchUpdatedAt ?? true
    const shouldUpdateProject = options?.updateProject ?? true
    const now = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              worktreeSetup,
              ...(worktreeSetup?.worktreePath ? { worktreePath: worktreeSetup.worktreePath } : {}),
              ...(worktreeSetup?.baseBranch ? { baseBranch: worktreeSetup.baseBranch } : {}),
              ...(worktreeSetup?.environmentId !== undefined ? { environmentId: worktreeSetup.environmentId } : {}),
              workLocation: 'worktree',
              ...(touchUpdatedAt ? { updatedAt: now } : {}),
            }
          : session,
      ),
    }))
    if (shouldUpdateProject) {
      const session = get().sessions.find((s) => s.id === id)
      if (session?.projectId) {
        useProjectStore.getState().updateProject(session.projectId, {
          workLocation: 'worktree',
          ...(worktreeSetup?.environmentId !== undefined ? { environmentId: worktreeSetup.environmentId } : {}),
        })
      }
    }
  },

  setSessionFirstPromptAt: (id, firstPromptAt) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, firstPromptAt }
          : session,
      ),
    }))
  },

  setSessionRuntimeSettings: (id, settings) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, ...settings, updatedAt }
          : session,
      ),
    }))
  },

  setSessionRightSidebar: (id, sidebar) => {
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== id) return session
        const merged = {
          ...(session.rightSidebar ?? { collapsed: true }),
          ...sidebar,
        }
        return { ...session, rightSidebar: merged }
      }),
    }))
  },

  setSessionPinnedSummaryVisible: (id, visible) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, pinnedSummaryVisible: visible }
          : session,
      ),
    }))
  },

  archiveSession: (id) => {
    const { sessions, currentSessionId, manuallyMarkedUnreadSessionIds } = get()
    const target = sessions.find((session) => session.id === id)
    if (!target || target.archivedAt !== undefined) return

    const nextSessions = sessions.map((session) =>
      session.id === id ? { ...session, archivedAt: Date.now() } : session,
    )
    set({
      sessions: nextSessions,
      currentSessionId:
        currentSessionId === id
          ? pickNewestSessionId(nextSessions)
          : currentSessionId,
      manuallyMarkedUnreadSessionIds: manuallyMarkedUnreadSessionIds.filter(
        (sessionId) => sessionId !== id,
      ),
    })
  },

  unarchiveSession: (id) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id && session.archivedAt !== undefined
          ? { ...session, archivedAt: undefined }
          : session,
      ),
    }))
  },

  removeSession: (id) => {
    const { sessions, currentSessionId, manuallyMarkedUnreadSessionIds } = get()
    const nextSessions = sessions.filter((session) => session.id !== id)
    const nextCurrent =
      currentSessionId === id
        ? pickNewestSessionId(nextSessions)
        : currentSessionId
    set({
      sessions: nextSessions,
      currentSessionId: nextCurrent,
      manuallyMarkedUnreadSessionIds: manuallyMarkedUnreadSessionIds.filter(
        (sessionId) => sessionId !== id,
      ),
    })
  },

  removeArchivedSessions: () => {
    const { sessions, currentSessionId, manuallyMarkedUnreadSessionIds } = get()
    const nextSessions = sessions.filter(
      (session) => session.archivedAt === undefined,
    )
    const currentStillAvailable = nextSessions.some(
      (session) => session.id === currentSessionId,
    )
    const activeSessionIds = new Set(nextSessions.map((session) => session.id))
    set({
      sessions: nextSessions,
      currentSessionId: currentStillAvailable
        ? currentSessionId
        : pickNewestSessionId(nextSessions),
      manuallyMarkedUnreadSessionIds: manuallyMarkedUnreadSessionIds.filter(
        (sessionId) => activeSessionIds.has(sessionId),
      ),
    })
  },

  togglePin: (id) => {
    const updatedAt = Date.now()
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, pinned: !session.pinned, updatedAt }
          : session,
      ),
    }))
  },

  markUnread: (id, unreadState = true) => {
    const unread = unreadState === 'error' ? 'error' : true
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, unread } : session,
      ),
    }))
  },

  markUnreadManually: (id) => {
    if (!get().sessions.some((session) => session.id === id)) return
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, unread: true } : session,
      ),
      manuallyMarkedUnreadSessionIds: state.manuallyMarkedUnreadSessionIds.includes(id)
        ? state.manuallyMarkedUnreadSessionIds
        : [...state.manuallyMarkedUnreadSessionIds, id],
    }))
  },

  markRead: (id) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id && session.unread
          ? { ...session, unread: undefined }
          : session,
      ),
      manuallyMarkedUnreadSessionIds: state.manuallyMarkedUnreadSessionIds.filter(
        (sessionId) => sessionId !== id,
      ),
    }))
  },

  setCurrentSession: (id) => {
    const {
      currentSessionId: prevId,
      sessions,
      manuallyMarkedUnreadSessionIds,
    } = get()
    let updated = false
    let nextSessions = sessions
    let nextManuallyMarkedUnreadSessionIds = manuallyMarkedUnreadSessionIds

    if (id) {
      const target = nextSessions.find((session) => session.id === id)
      if (target?.unread) {
        nextSessions = nextSessions.map((session) =>
          session.id === id ? { ...session, unread: undefined } : session,
        )
        updated = true
      }
      if (manuallyMarkedUnreadSessionIds.includes(id)) {
        nextManuallyMarkedUnreadSessionIds = manuallyMarkedUnreadSessionIds.filter(
          (sessionId) => sessionId !== id,
        )
        updated = true
      }
    }
    if (
      prevId &&
      prevId !== id &&
      !manuallyMarkedUnreadSessionIds.includes(prevId)
    ) {
      const prev = nextSessions.find((session) => session.id === prevId)
      if (prev?.unread) {
        nextSessions = nextSessions.map((session) =>
          session.id === prevId ? { ...session, unread: undefined } : session,
        )
        updated = true
      }
    }

    if (updated) {
      set({
        currentSessionId: id,
        sessions: nextSessions,
        manuallyMarkedUnreadSessionIds: nextManuallyMarkedUnreadSessionIds,
      })
    } else {
      set({ currentSessionId: id })
    }
  },

  upsertRemoteSession: (session) => {
    const state = get()
    const isActivelyViewing = isViewingSession(session.id, state.currentSessionId)
    const isManuallyMarkedUnread = state.manuallyMarkedUnreadSessionIds.includes(
      session.id,
    )
    const localUnread = state.sessions.find(
      (candidate) => candidate.id === session.id,
    )?.unread
    // Keep explicitly marked sessions unread until the user enters them again.
    const effectiveSession: Session = isManuallyMarkedUnread
      ? {
          ...session,
          unread:
            session.unread === 'error' || localUnread === 'error'
              ? 'error'
              : true,
        }
      : isActivelyViewing && session.unread
        ? { ...session, unread: undefined }
        : session

    set((state) => {
      const index = state.sessions.findIndex((s) => s.id === effectiveSession.id)
      if (index >= 0) {
        const s = state.sessions[index]
        if (
          s.title === effectiveSession.title &&
          s.projectId === effectiveSession.projectId &&
          s.branch === effectiveSession.branch &&
          s.pinned === effectiveSession.pinned &&
          s.archivedAt === effectiveSession.archivedAt &&
          s.updatedAt === effectiveSession.updatedAt &&
          s.firstPromptAt === effectiveSession.firstPromptAt &&
          s.unread === effectiveSession.unread &&
          s.pinnedSummaryVisible === effectiveSession.pinnedSummaryVisible &&
          JSON.stringify(s.rightSidebar) === JSON.stringify(effectiveSession.rightSidebar)
        ) {
          return state
        }
        const next = [...state.sessions]
        next[index] = {
          ...next[index],
          ...effectiveSession,
          rightSidebar: effectiveSession.rightSidebar !== undefined ? effectiveSession.rightSidebar : next[index].rightSidebar,
          firstPromptAt: effectiveSession.firstPromptAt !== undefined ? effectiveSession.firstPromptAt : next[index].firstPromptAt,
          pinnedSummaryVisible: effectiveSession.pinnedSummaryVisible !== undefined ? effectiveSession.pinnedSummaryVisible : next[index].pinnedSummaryVisible,
        }
        return { sessions: next }
      }
      return { sessions: [effectiveSession, ...state.sessions] }
    })
  },

  removeRemoteSession: (sessionId) => {
    notifyRemoteSessionDelete(sessionId)
    const { sessions, currentSessionId, manuallyMarkedUnreadSessionIds } = get()
    const nextSessions = sessions.filter((session) => session.id !== sessionId)
    const nextCurrent =
      currentSessionId === sessionId
        ? pickNewestSessionId(nextSessions)
        : currentSessionId
    set({
      sessions: nextSessions,
      currentSessionId: nextCurrent,
      manuallyMarkedUnreadSessionIds: manuallyMarkedUnreadSessionIds.filter(
        (id) => id !== sessionId,
      ),
    })
  },

  hydrate: (data) =>
    set((state) => {
      const sessions = data.sessions ?? state.sessions
      const requestedCurrentSessionId =
        data.currentSessionId !== undefined
          ? data.currentSessionId
          : state.currentSessionId
      const currentSessionAvailable = sessions.some(
        (session) =>
          session.id === requestedCurrentSessionId &&
          session.archivedAt === undefined,
      )

      const unreadSessionIds = new Set(
        sessions.filter((session) => session.unread).map((session) => session.id),
      )

      return {
        sessions,
        currentSessionId:
          requestedCurrentSessionId === null || currentSessionAvailable
            ? requestedCurrentSessionId
            : pickNewestSessionId(sessions),
        manuallyMarkedUnreadSessionIds: state.manuallyMarkedUnreadSessionIds.filter(
          (sessionId) => unreadSessionIds.has(sessionId),
        ),
      }
    }),
}))
