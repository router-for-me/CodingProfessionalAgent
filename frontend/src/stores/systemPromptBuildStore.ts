import { create } from 'zustand'

interface SystemPromptBuild {
    runId: string
    active: boolean
}

interface SystemPromptBuildState {
    bySession: ReadonlyMap<string, SystemPromptBuild>
    setBuilding(sessionId: string, runId: string, building: boolean): void
    clearSession(sessionId: string): void
}

export const useSystemPromptBuildStore = create<SystemPromptBuildState>((set) => ({
    bySession: new Map(),
    setBuilding: (sessionId, runId, building) => set((state) => {
        const current = state.bySession.get(sessionId)
        if (current?.runId === runId && current.active === building) return state
        if (!building && current?.runId !== runId) return state
        // Preserve completion for this run to ignore a delayed echo from the main process.
        const bySession = new Map(state.bySession)
        bySession.set(sessionId, { runId, active: building })
        return { bySession }
    }),
    clearSession: (sessionId) => set((state) => {
        if (!state.bySession.has(sessionId)) return state
        const bySession = new Map(state.bySession)
        bySession.delete(sessionId)
        return { bySession }
    }),
}))
