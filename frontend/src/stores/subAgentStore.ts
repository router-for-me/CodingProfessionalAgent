import { create } from 'zustand'
import type {
  SubAgentRecord,
  SubAgentStatus,
} from '@cpa/plugin-api'

interface SubAgentState {
  agents: SubAgentRecord[]
  openTabIdsByParent: Record<string, string[]>
  focusedIdByParent: Record<string, string | null>
  replaceAll: (agents: readonly SubAgentRecord[]) => void
  mergeHostAgents: (hostAgents: readonly SubAgentRecord[]) => void
  mergeAgentsForParent: (
    parentSessionId: string,
    parentAgents: readonly SubAgentRecord[],
  ) => void
  setAgentsForParent: (
    parentSessionId: string,
    parentAgents: readonly SubAgentRecord[],
  ) => void
  removeAgentsForParent: (parentSessionId: string) => void
  openTab: (parentSessionId: string, agentId: string) => void
  closeTab: (parentSessionId: string, agentId: string) => void
  focusTab: (parentSessionId: string, agentId: string | null) => void
  hydrate: (data: {
    agents?: SubAgentRecord[]
    openTabIdsByParent?: Record<string, string[]>
    focusedIdByParent?: Record<string, string | null>
  }) => void
}

function persistableStatus(status: SubAgentStatus): SubAgentStatus {
  if (status === 'running' || status === 'queued') return 'aborted'
  return status
}

export function agentsForParent(
  agents: readonly SubAgentRecord[],
  parentSessionId: string,
): SubAgentRecord[] {
  return agents.filter((agent) => agent.parentSessionId === parentSessionId)
}

function sameAgentList(
  left: readonly SubAgentRecord[],
  right: readonly SubAgentRecord[],
): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (!a || !b) return false
    if (
      a.id !== b.id ||
      a.status !== b.status ||
      a.lastMessage !== b.lastMessage ||
      a.updatedAt !== b.updatedAt ||
      a.name !== b.name ||
      a.parentSessionId !== b.parentSessionId ||
      a.modelId !== b.modelId ||
      a.reasoningEffort !== b.reasoningEffort ||
      a.completedAt !== b.completedAt ||
      a.pausedMs !== b.pausedMs
    ) {
      return false
    }
  }
  return true
}

export const useSubAgentStore = create<SubAgentState>((set, get) => ({
  agents: [],
  openTabIdsByParent: {},
  focusedIdByParent: {},

  replaceAll: (agents) => {
    const current = get().agents
    if (sameAgentList(current, agents)) return
    set({ agents: agents.map((agent) => ({ ...agent })) })
  },

  mergeHostAgents: (hostAgents) => {
    const current = get().agents
    const hostById = new Map(hostAgents.map((a) => [a.id, a]))
    const merged: SubAgentRecord[] = []
    const seenIds = new Set<string>()

    for (const agent of current) {
      seenIds.add(agent.id)
      const updated = hostById.get(agent.id)
      if (updated) {
        merged.push({ ...updated })
      } else {
        merged.push({ ...agent })
      }
    }

    for (const agent of hostAgents) {
      if (!seenIds.has(agent.id)) {
        merged.push({ ...agent })
        seenIds.add(agent.id)
      }
    }

    if (sameAgentList(current, merged)) return
    set({ agents: merged })
  },

  mergeAgentsForParent: (parentSessionId, parentAgents) => {
    const current = get().agents
    const currentMap = new Map(current.map((a) => [a.id, a]))
    const normalized = parentAgents.map((agent) => ({
      ...agent,
      parentSessionId,
    }))
    for (const agent of normalized) {
      const existing = currentMap.get(agent.id)
      if (!existing) {
        currentMap.set(agent.id, agent)
      } else if (existing.status !== 'running' && existing.status !== 'queued') {
        currentMap.set(agent.id, {
          ...existing,
          ...agent,
        })
      }
    }
    const merged = Array.from(currentMap.values())
    if (sameAgentList(current, merged)) return
    set({ agents: merged })
  },

  setAgentsForParent: (parentSessionId, parentAgents) => {
    const current = get().agents
    const otherAgents = current.filter(
      (agent) => agent.parentSessionId !== parentSessionId,
    )
    const currentParentAgents = current.filter(
      (agent) => agent.parentSessionId === parentSessionId,
    )
    const currentParentMap = new Map(
      currentParentAgents.map((agent) => [agent.id, agent]),
    )
    const seenIds = new Set<string>()
    const normalizedParentAgents = parentAgents.map((agent) => {
      seenIds.add(agent.id)
      const existing = currentParentMap.get(agent.id)
      if (
        existing &&
        (existing.status === 'running' || existing.status === 'queued')
      ) {
        return {
          ...agent,
          ...existing,
          parentSessionId,
        }
      }
      return {
        ...agent,
        parentSessionId,
      }
    })
    for (const existing of currentParentAgents) {
      if (
        !seenIds.has(existing.id) &&
        (existing.status === 'running' || existing.status === 'queued')
      ) {
        normalizedParentAgents.push(existing)
      }
    }
    const merged = [...otherAgents, ...normalizedParentAgents]
    if (sameAgentList(current, merged)) return
    set({ agents: merged })
  },

  removeAgentsForParent: (parentSessionId) => {
    const state = get()
    const remaining = state.agents.filter(
      (agent) => agent.parentSessionId !== parentSessionId,
    )
    const nextOpenTabs = { ...state.openTabIdsByParent }
    delete nextOpenTabs[parentSessionId]
    const nextFocused = { ...state.focusedIdByParent }
    delete nextFocused[parentSessionId]
    set({
      agents: remaining,
      openTabIdsByParent: nextOpenTabs,
      focusedIdByParent: nextFocused,
    })
  },

  openTab: (parentSessionId, agentId) => {
    const state = get()
    const current = state.openTabIdsByParent[parentSessionId] ?? []
    const nextTabs = current.includes(agentId) ? current : [...current, agentId]
    set({
      openTabIdsByParent: {
        ...state.openTabIdsByParent,
        [parentSessionId]: nextTabs,
      },
      focusedIdByParent: {
        ...state.focusedIdByParent,
        [parentSessionId]: agentId,
      },
    })
  },

  closeTab: (parentSessionId, agentId) => {
    const state = get()
    const current = state.openTabIdsByParent[parentSessionId] ?? []
    const nextTabs = current.filter((id) => id !== agentId)
    const focused = state.focusedIdByParent[parentSessionId]
    set({
      openTabIdsByParent: {
        ...state.openTabIdsByParent,
        [parentSessionId]: nextTabs,
      },
      focusedIdByParent: {
        ...state.focusedIdByParent,
        [parentSessionId]:
          focused === agentId ? (nextTabs[nextTabs.length - 1] ?? null) : focused,
      },
    })
  },

  focusTab: (parentSessionId, agentId) =>
    set((state) => ({
      focusedIdByParent: {
        ...state.focusedIdByParent,
        [parentSessionId]: agentId,
      },
    })),

  hydrate: (data) =>
    set({
      agents: (data.agents ?? []).map((agent) => ({
        ...agent,
        status: persistableStatus(agent.status),
      })),
      openTabIdsByParent: data.openTabIdsByParent ?? {},
      focusedIdByParent: data.focusedIdByParent ?? {},
    }),
}))
