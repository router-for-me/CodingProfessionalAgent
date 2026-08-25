import { create } from 'zustand'
import type { ActiveRunInfo } from '@/types/models'
import { useSessionStore } from './sessionStore'

export type SessionRunState = ActiveRunInfo

export interface SessionRunStoreState {
    activeRuns: Record<string, SessionRunState>
    setRun: (sessionId: string, state: SessionRunState) => void
    clearRun: (sessionId: string) => void
    hydrate: (runs: SessionRunState[]) => void
}

function isViewingSession(sessionId: string, currentSessionId: string | null): boolean {
    return currentSessionId === sessionId
}

export const useSessionRunStore = create<SessionRunStoreState>((set, get) => ({
    activeRuns: {},
    setRun: (sessionId, runState) => {
        const previousRun = get().activeRuns[sessionId]
        const currentSessionId = useSessionStore.getState().currentSessionId
        const isViewing = isViewingSession(sessionId, currentSessionId)

        if (runState.status === 'idle') {
            if (!isViewing && previousRun && previousRun.status !== 'idle') {
                if (previousRun.status === 'error' || runState.error) {
                    useSessionStore.getState().markUnread(sessionId, 'error')
                } else {
                    useSessionStore.getState().markUnread(sessionId, true)
                }
            }
            set((state) => {
                const next = { ...state.activeRuns }
                delete next[sessionId]
                return { activeRuns: next }
            })
        } else if (runState.status === 'error') {
            if (!isViewing) {
                useSessionStore.getState().markUnread(sessionId, 'error')
            }
            set((state) => ({
                activeRuns: {
                    ...state.activeRuns,
                    [sessionId]: runState,
                },
            }))
        } else {
            set((state) => ({
                activeRuns: {
                    ...state.activeRuns,
                    [sessionId]: runState,
                },
            }))
        }
    },
    clearRun: (sessionId) => {
        set((state) => {
            const next = { ...state.activeRuns }
            delete next[sessionId]
            return { activeRuns: next }
        })
    },
    hydrate: (runs) => {
        set((state) => {
            const map: Record<string, SessionRunState> = { ...state.activeRuns }
            for (const run of runs) {
                if (run && run.sessionId && run.status !== 'idle') {
                    const existing = map[run.sessionId]
                    if (!existing || (run.updatedAt && run.updatedAt >= (existing.updatedAt || 0))) {
                        map[run.sessionId] = run
                    }
                }
            }
            // Remove any activeRuns not present in the remote active runs list unless updated recently (within 2s)
            const remoteIds = new Set(runs.map((r) => r?.sessionId).filter(Boolean))
            for (const id of Object.keys(map)) {
                if (!remoteIds.has(id)) {
                    const existing = map[id]
                    if (!existing || Date.now() - (existing.updatedAt || 0) > 2000) {
                        delete map[id]
                    }
                }
            }
            return { activeRuns: map }
        })
    },
}))
