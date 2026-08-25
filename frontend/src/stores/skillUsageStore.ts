import { create } from 'zustand'

export interface SkillUsageStoreState {
    usageCounts: Record<string, number>
    setUsageCounts: (counts: Record<string, number>) => void
    recordUsage: (skillName: string, delta?: number) => void
    reset: () => void
}

/**
 * Pure Zustand store tracking skill invocation frequencies across sessions.
 * Backed by authoritative SQLite metrics synced via SkillUsageService.
 */
export const useSkillUsageStore = create<SkillUsageStoreState>((set, get) => ({
    usageCounts: {},

    setUsageCounts: (counts) => {
        set({ usageCounts: { ...counts } })
    },

    recordUsage: (skillName: string, delta = 1) => {
        const raw = String(skillName ?? '').trim().toLowerCase()
        if (!raw) return
        const current = get().usageCounts[raw] ?? 0
        const next = Math.max(0, current + delta)
        set((state) => ({
            usageCounts: {
                ...state.usageCounts,
                [raw]: next,
            },
        }))
    },

    reset: () => {
        set({ usageCounts: {} })
    },
}))
