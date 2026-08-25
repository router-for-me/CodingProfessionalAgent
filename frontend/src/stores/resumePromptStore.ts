import { create } from 'zustand'
import { useUiStore } from './uiStore'

export interface ResumePromptState {
  isOpen: boolean
  totalCount: number
  countdown: number
  unfinishedSessionIds: string[]
  unfinishedSubAgentIds: string[]
  onContinueAction: (() => Promise<void> | void) | null
  onAbortAction: (() => Promise<void> | void) | null
  openPrompt: (payload: {
    totalCount: number
    countdown?: number
    unfinishedSessionIds: string[]
    unfinishedSubAgentIds: string[]
    onContinue?: () => Promise<void> | void
    onAbort?: () => Promise<void> | void
  }) => void
  syncState: (payload: {
    isOpen?: boolean
    totalCount?: number
    countdown?: number
    unfinishedSessionIds?: string[]
    unfinishedSubAgentIds?: string[]
  }) => void
  decrementCountdown: () => void
  closePrompt: () => void
}

export const useResumePromptStore = create<ResumePromptState>((set) => ({
  isOpen: false,
  totalCount: 0,
  countdown: 30,
  unfinishedSessionIds: [],
  unfinishedSubAgentIds: [],
  onContinueAction: null,
  onAbortAction: null,
  openPrompt: ({
    totalCount,
    countdown = 30,
    unfinishedSessionIds,
    unfinishedSubAgentIds,
    onContinue,
    onAbort,
  }) => {
    if (useUiStore.getState().sidebarCollapsed) {
      useUiStore.getState().setSidebarCollapsed(false)
    }
    set({
      isOpen: true,
      totalCount,
      countdown,
      unfinishedSessionIds,
      unfinishedSubAgentIds,
      onContinueAction: onContinue ?? null,
      onAbortAction: onAbort ?? null,
    })
  },
  syncState: (payload) => {
    const isOpen = payload.isOpen ?? false
    if (isOpen && useUiStore.getState().sidebarCollapsed) {
      useUiStore.getState().setSidebarCollapsed(false)
    }
    set((state) => ({
      isOpen,
      totalCount: payload.totalCount !== undefined ? payload.totalCount : state.totalCount,
      countdown: payload.countdown !== undefined ? payload.countdown : state.countdown,
      unfinishedSessionIds: payload.unfinishedSessionIds !== undefined ? payload.unfinishedSessionIds : state.unfinishedSessionIds,
      unfinishedSubAgentIds: payload.unfinishedSubAgentIds !== undefined ? payload.unfinishedSubAgentIds : state.unfinishedSubAgentIds,
      ...(isOpen ? {} : { onContinueAction: null, onAbortAction: null }),
    }))
  },
  decrementCountdown: () =>
    set((state) => ({
      countdown: Math.max(0, state.countdown - 1),
    })),
  closePrompt: () =>
    set({
      isOpen: false,
      onContinueAction: null,
      onAbortAction: null,
    }),
}))
