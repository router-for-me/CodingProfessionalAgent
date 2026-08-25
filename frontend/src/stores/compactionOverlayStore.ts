import { create } from 'zustand'

export interface CompactionOverlayState {
  bySession: Record<string, boolean>
  setCompacting: (sessionId: string, compacting: boolean) => void
  clearSession: (sessionId: string) => void
  clearSessions: (sessionIds: readonly string[]) => void
  clearAll: () => void
}

export const useCompactionOverlayStore = create<CompactionOverlayState>(
  (set) => ({
    bySession: {},

    setCompacting: (sessionId, compacting) =>
      set((state) => {
        if (!sessionId) return state
        const current = Boolean(state.bySession[sessionId])
        if (compacting) {
          if (current) return state
          return { bySession: { ...state.bySession, [sessionId]: true } }
        }
        if (!(sessionId in state.bySession)) return state
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      }),

    clearSession: (sessionId) =>
      set((state) => {
        if (!(sessionId in state.bySession)) return state
        const next = { ...state.bySession }
        delete next[sessionId]
        return { bySession: next }
      }),

    clearSessions: (sessionIds) =>
      set((state) => {
        if (sessionIds.length === 0) return state
        let changed = false
        const next = { ...state.bySession }
        for (const sessionId of sessionIds) {
          if (sessionId in next) {
            delete next[sessionId]
            changed = true
          }
        }
        return changed ? { bySession: next } : state
      }),

    clearAll: () => set({ bySession: {} }),
  }),
)

export function __resetCompactionOverlayStoreForTests(): void {
  useCompactionOverlayStore.setState({ bySession: {} })
}
