import { create } from 'zustand'
import type { ComposerImage, SkillReference, Speed } from '@cpa/plugin-api'
import { createId } from '@/lib/id'
import { isMobileBrowser } from '@/lib/platform'
import { useSessionStore } from '@/stores/sessionStore'
import type { ComposerAttachment } from '@cpa/plugin-api'
import type { SessionRightSidebarState } from '@/types/models'

export const DEFAULT_SIDEBAR_WIDTH = 272
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 480
export const DEFAULT_RIGHT_SIDEBAR_WIDTH = 280
export const DEFAULT_RIGHT_SIDEBAR_CONVERSATION_WIDTH = 420
export const MIN_RIGHT_SIDEBAR_WIDTH = 240
export const MAX_RIGHT_SIDEBAR_WIDTH = 640
export const AUTO_MAXIMIZE_THRESHOLD = 100
export const AUTO_MAXIMIZE_EDGE_THRESHOLD = 100
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 220
export const MIN_BOTTOM_PANEL_HEIGHT = 120
export const MAX_BOTTOM_PANEL_HEIGHT = 560

const NEW_CHAT_COMPOSER_DRAFT_KEY = 'new-chat'

export function getComposerDraftKey(sessionId?: string | null): string {
  if (!sessionId || sessionId === NEW_CHAT_COMPOSER_DRAFT_KEY) {
    return NEW_CHAT_COMPOSER_DRAFT_KEY
  }
  return sessionId.startsWith('session:') ? sessionId : `session:${sessionId}`
}

function clampWidth(
  width: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(width)) return fallback
  return Math.round(Math.min(max, Math.max(min, width)))
}

export function clampSidebarWidth(width: number): number {
  return clampWidth(
    width,
    MIN_SIDEBAR_WIDTH,
    MAX_SIDEBAR_WIDTH,
    DEFAULT_SIDEBAR_WIDTH,
  )
}

export function clampRightSidebarWidth(width: number): number {
  return clampWidth(
    width,
    MIN_RIGHT_SIDEBAR_WIDTH,
    MAX_RIGHT_SIDEBAR_WIDTH,
    DEFAULT_RIGHT_SIDEBAR_WIDTH,
  )
}

export function clampBottomPanelHeight(height: number): number {
    return clampWidth(
        height,
        MIN_BOTTOM_PANEL_HEIGHT,
        MAX_BOTTOM_PANEL_HEIGHT,
        DEFAULT_BOTTOM_PANEL_HEIGHT,
    )
}

function syncCurrentSession(patch: Partial<SessionRightSidebarState>): void {
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (currentSessionId) {
        useSessionStore.getState().setSessionRightSidebar(currentSessionId, patch)
    }
}

export function flushDebouncedWidthSync(): void {
    // Pure no-op retained for backwards compatibility
}

function syncWidth(width: number): void {
    syncCurrentSession({ width })
}

export interface ToastItem {
  id: string
  message: string
  action?: { label: string; run: () => void }
}

export interface PendingSessionContext {
  projectId: string | null
  branch: string | null
  workLocation?: 'local' | 'worktree'
  environmentId?: string | null
  speed?: Speed
}

export interface OpenRightPanelTabOptions {
  activate?: boolean
  params?: Record<string, unknown>
}

interface UiState {
  collapsedGroups: Record<string, boolean>
  sidebarCollapsed: boolean
  sidebarWidth: number
  rightSidebarCollapsed: boolean
  rightSidebarMaximized: boolean
  rightSidebarWidth: number | null
  rightPanelOpenTabs: string[]
  rightPanelActiveTab: string | null
  rightPanelTabParams: Record<string, Record<string, unknown>>
  pinnedSummaryVisible: boolean
  bottomPanelVisible: boolean
  bottomPanelHeight: number
  settingsOpen: boolean
  settingsSection?: string
  settingsParams?: Record<string, unknown>
  searchOpen: boolean
  composerDraft: string
  composerDrafts: Record<string, string>
  composerDraftReferences: Record<string, SkillReference[]>
  composerDraftAttachments: Record<string, ComposerAttachment[]>
  composerRestoredAttachments: Record<string, readonly ComposerImage[]>
  deletedSessionDraftKeys: Record<string, true>
  setComposerDraftAttachments: (
    key: string,
    attachments:
      | readonly ComposerAttachment[]
      | ((prev: readonly ComposerAttachment[]) => readonly ComposerAttachment[]),
  ) => void
  clearComposerDraftAttachments: (key: string) => void
  setComposerRestoredAttachments: (sessionId: string, images: readonly ComposerImage[]) => void
  consumeComposerRestoredAttachments: (key: string) => readonly ComposerImage[]
  clearSessionComposerDraft: (sessionId: string) => void
  pendingSessionContext: PendingSessionContext
  toasts: ToastItem[]
  toggleGroup: (key: string) => void
  toggleSidebarCollapsed: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarWidth: (width: number) => void
  toggleRightSidebarCollapsed: () => void
  toggleRightSidebarMaximized: () => void
  setRightSidebarMaximized: (maximized: boolean) => void
  setRightSidebarWidth: (width: number) => void
  setRightSidebarCollapsed: (collapsed: boolean) => void
  openRightPanelTab: (tabId: string, options?: OpenRightPanelTabOptions) => void
  closeRightPanelTab: (tabId: string) => void
  setActiveRightPanelTab: (tabId: string | null) => void
    setRightPanelTabParams: (
        tabId: string,
        params: Record<string, unknown>,
    ) => void
    restoreForSession: (sidebarState?: SessionRightSidebarState | null) => void
    togglePinnedSummaryVisible: () => void
  setPinnedSummaryVisible: (visible: boolean, options?: { syncSession?: boolean }) => void
  toggleBottomPanelVisible: () => void
  setBottomPanelVisible: (visible: boolean) => void
  setBottomPanelHeight: (height: number) => void
  setSettingsOpen: (open: boolean, section?: string, params?: Record<string, unknown>) => void
  setSearchOpen: (open: boolean) => void
  toggleSearchOpen: () => void
  setComposerDraft: (draft: string) => void
  setComposerDraftForSession: (
    sessionId: string | null,
    draft: string,
    references?: readonly SkillReference[],
    options?: { preserveLegacyDraft?: boolean },
  ) => void
  setPendingSessionContext: (context: PendingSessionContext) => void
  pushToast: (message: string, action?: ToastItem['action']) => string
  dismissToast: (id: string) => void
  hydrate: (data: {
    collapsedGroups?: Record<string, boolean>
    sidebarCollapsed?: boolean
    sidebarWidth?: number
    rightSidebarCollapsed?: boolean
    rightSidebarMaximized?: boolean
    rightSidebarWidth?: number | null
    rightPanelOpenTabs?: string[]
    rightPanelActiveTab?: string | null
    rightPanelTabParams?: Record<string, Record<string, unknown>>
    pinnedSummaryVisible?: boolean
    bottomPanelVisible?: boolean
    bottomPanelHeight?: number
  }) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  collapsedGroups: {},
  sidebarCollapsed: isMobileBrowser() ? true : false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  rightSidebarCollapsed: true,
  rightSidebarMaximized: false,
  rightSidebarWidth: null,
  rightPanelOpenTabs: [],
  rightPanelActiveTab: null,
  rightPanelTabParams: {},
  pinnedSummaryVisible: isMobileBrowser() ? false : true,
  bottomPanelVisible: false,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  settingsOpen: false,
  settingsSection: undefined,
  settingsParams: undefined,
  searchOpen: false,
  composerDraft: '',
  composerDrafts: {},
  composerDraftReferences: {},
  composerDraftAttachments: {},
  composerRestoredAttachments: {},
  deletedSessionDraftKeys: {},
  pendingSessionContext: { projectId: null, branch: null },
  toasts: [],

  toggleGroup: (key) =>
    set((state) => ({
      collapsedGroups: {
        ...state.collapsedGroups,
        [key]: !state.collapsedGroups[key],
      },
    })),

  toggleSidebarCollapsed: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),

    toggleRightSidebarCollapsed: () => {
        const nextCollapsed = !get().rightSidebarCollapsed
        set({
            rightSidebarCollapsed: nextCollapsed,
            ...(nextCollapsed ? { rightSidebarMaximized: false } : {}),
        })
        syncCurrentSession({
            collapsed: nextCollapsed,
            ...(nextCollapsed ? { maximized: false } : {}),
        })
    },

    setRightSidebarCollapsed: (collapsed) => {
        set({
            rightSidebarCollapsed: collapsed,
            ...(collapsed ? { rightSidebarMaximized: false } : {}),
        })
        syncCurrentSession({
            collapsed,
            ...(collapsed ? { maximized: false } : {}),
        })
    },

    toggleRightSidebarMaximized: () => {
        const state = get()
        const nextMaximized = !state.rightSidebarMaximized
        const shouldUncollapse = nextMaximized && state.rightSidebarCollapsed
        set({
            rightSidebarMaximized: nextMaximized,
            ...(shouldUncollapse ? { rightSidebarCollapsed: false } : {}),
        })
        syncCurrentSession({
            maximized: nextMaximized,
            ...(shouldUncollapse ? { collapsed: false } : {}),
        })
    },

    setRightSidebarMaximized: (maximized) => {
        const state = get()
        const shouldUncollapse = maximized && state.rightSidebarCollapsed
        set({
            rightSidebarMaximized: maximized,
            ...(shouldUncollapse ? { rightSidebarCollapsed: false } : {}),
        })
        syncCurrentSession({
            maximized,
            ...(shouldUncollapse ? { collapsed: false } : {}),
        })
    },

    setRightSidebarWidth: (width) => {
        const clamped = clampRightSidebarWidth(width)
        set({ rightSidebarWidth: clamped })
        syncWidth(clamped)
    },

    openRightPanelTab: (tabId, options) => {
        const state = get()
        const openTabs = state.rightPanelOpenTabs.includes(tabId)
            ? [...state.rightPanelOpenTabs]
            : [...state.rightPanelOpenTabs, tabId]
        const shouldActivate = options?.activate !== false
        const tabParams = options?.params
            ? { ...state.rightPanelTabParams, [tabId]: options.params }
            : { ...state.rightPanelTabParams }
        const shouldUncollapse = shouldActivate && state.rightSidebarCollapsed

        set({
            rightPanelOpenTabs: openTabs,
            rightPanelTabParams: tabParams,
            ...(shouldActivate
                ? {
                    rightPanelActiveTab: tabId,
                    ...(shouldUncollapse
                        ? { rightSidebarCollapsed: false }
                        : {}),
                }
                : {}),
        })

        syncCurrentSession({
            openTabs: [...openTabs],
            tabParams: { ...tabParams },
            ...(shouldActivate ? { activeTab: tabId } : {}),
            ...(shouldUncollapse ? { collapsed: false } : {}),
        })
    },

    closeRightPanelTab: (tabId) => {
        const state = get()
        const nextOpenTabs = state.rightPanelOpenTabs.filter((id) => id !== tabId)
        const nextParams = { ...state.rightPanelTabParams }
        delete nextParams[tabId]

        let nextActiveTab = state.rightPanelActiveTab
        if (state.rightPanelActiveTab === tabId) {
            nextActiveTab =
                nextOpenTabs.length > 0
                    ? nextOpenTabs[nextOpenTabs.length - 1]
                    : null
        }

        set({
            rightPanelOpenTabs: nextOpenTabs,
            rightPanelTabParams: nextParams,
            rightPanelActiveTab: nextActiveTab,
        })

        syncCurrentSession({
            openTabs: [...nextOpenTabs],
            tabParams: { ...nextParams },
            activeTab: nextActiveTab,
        })
    },

    setActiveRightPanelTab: (tabId) => {
        set({ rightPanelActiveTab: tabId })
        syncCurrentSession({ activeTab: tabId })
    },

    setRightPanelTabParams: (tabId, params) => {
        const state = get()
        const nextTabParams = {
            ...state.rightPanelTabParams,
            [tabId]: params,
        }
        set({
            rightPanelTabParams: nextTabParams,
        })
        syncCurrentSession({ tabParams: { ...nextTabParams } })
    },

    restoreForSession: (sidebar) => {
        flushDebouncedWidthSync()
        set({
            rightSidebarCollapsed: sidebar?.collapsed ?? true,
            rightSidebarMaximized: sidebar?.maximized ?? false,
            rightSidebarWidth:
                typeof sidebar?.width === 'number'
                    ? clampRightSidebarWidth(sidebar.width)
                    : null,
            rightPanelOpenTabs: Array.isArray(sidebar?.openTabs)
                ? [...sidebar.openTabs]
                : [],
            rightPanelActiveTab: sidebar?.activeTab ?? null,
            rightPanelTabParams:
                sidebar?.tabParams && typeof sidebar.tabParams === 'object'
                    ? { ...sidebar.tabParams }
                    : {},
        })
    },

  togglePinnedSummaryVisible: () => {
    const next = !get().pinnedSummaryVisible
    set({ pinnedSummaryVisible: next })
    const currentSessionId = useSessionStore.getState().currentSessionId
    if (currentSessionId) {
      useSessionStore.getState().setSessionPinnedSummaryVisible(currentSessionId, next)
    }
  },

  setPinnedSummaryVisible: (visible, options) => {
    set({ pinnedSummaryVisible: visible })
    if (options?.syncSession !== false) {
      const currentSessionId = useSessionStore.getState().currentSessionId
      if (currentSessionId) {
        useSessionStore.getState().setSessionPinnedSummaryVisible(currentSessionId, visible)
      }
    }
  },

  toggleBottomPanelVisible: () =>
    set((state) => ({ bottomPanelVisible: !state.bottomPanelVisible })),

  setBottomPanelVisible: (visible) => set({ bottomPanelVisible: visible }),

  setBottomPanelHeight: (height) =>
    set({ bottomPanelHeight: clampBottomPanelHeight(height) }),

  setSettingsOpen: (open: boolean, section?: string, params?: Record<string, unknown>) =>
    set((state) => ({
      settingsOpen: open,
      settingsSection: open ? (section !== undefined ? section : state.settingsSection) : undefined,
      settingsParams: open ? params : undefined,
    })),

  setSearchOpen: (open: boolean) => set({ searchOpen: open }),

  toggleSearchOpen: () => set((state) => ({ searchOpen: !state.searchOpen })),

  setComposerDraftAttachments: (key, attachmentsOrUpdater) =>
    set((state) => {
      const prev = state.composerDraftAttachments[key] ?? []
      const next =
        typeof attachmentsOrUpdater === 'function'
          ? attachmentsOrUpdater(prev)
          : attachmentsOrUpdater
      const normalized = next.map((att) => ({ ...att }))
      if (normalized.length === 0) {
        if (!(key in state.composerDraftAttachments)) return state
        const remaining = { ...state.composerDraftAttachments }
        delete remaining[key]
        return { composerDraftAttachments: remaining }
      }
      return {
        composerDraftAttachments: {
          ...state.composerDraftAttachments,
          [key]: normalized,
        },
      }
    }),
  clearComposerDraftAttachments: (key) =>
    set((state) => {
      if (!(key in state.composerDraftAttachments)) return state
      const remaining = { ...state.composerDraftAttachments }
      delete remaining[key]
      return { composerDraftAttachments: remaining }
    }),
  setComposerRestoredAttachments: (sessionId, images) => set((state) => ({
    composerRestoredAttachments: { ...state.composerRestoredAttachments, [`session:${sessionId}`]: images },
  })),
  consumeComposerRestoredAttachments: (key) => {
    const images = get().composerRestoredAttachments[key] ?? []
    if (images.length > 0) set((state) => {
      const remaining = { ...state.composerRestoredAttachments }
      delete remaining[key]
      return { composerRestoredAttachments: remaining }
    })
    return images
  },
  clearSessionComposerDraft: (sessionId) => {
    if (!sessionId || sessionId === NEW_CHAT_COMPOSER_DRAFT_KEY) return
    const key = getComposerDraftKey(sessionId)
    set((state) => {
      const hasDraft = key in state.composerDrafts
      const hasRefs = key in state.composerDraftReferences
      const hasAttachments = key in state.composerDraftAttachments
      const hasRestored = key in state.composerRestoredAttachments
      const alreadyMarkedDeleted = state.deletedSessionDraftKeys[key] === true
      if (!hasDraft && !hasRefs && !hasAttachments && !hasRestored && alreadyMarkedDeleted) {
        return state
      }
      const nextDrafts = hasDraft ? { ...state.composerDrafts } : state.composerDrafts
      if (hasDraft) delete nextDrafts[key]
      const nextRefs = hasRefs ? { ...state.composerDraftReferences } : state.composerDraftReferences
      if (hasRefs) delete nextRefs[key]
      const nextAttachments = hasAttachments ? { ...state.composerDraftAttachments } : state.composerDraftAttachments
      if (hasAttachments) delete nextAttachments[key]
      const nextRestored = hasRestored ? { ...state.composerRestoredAttachments } : state.composerRestoredAttachments
      if (hasRestored) delete nextRestored[key]
      let nextDeleted = state.deletedSessionDraftKeys
      if (!alreadyMarkedDeleted) {
        nextDeleted = { ...state.deletedSessionDraftKeys, [key]: true }
        const keys = Object.keys(nextDeleted)
        if (keys.length > 1000) {
          delete nextDeleted[keys[0]!]
        }
      }
      return {
        ...(hasDraft ? { composerDrafts: nextDrafts } : {}),
        ...(hasRefs ? { composerDraftReferences: nextRefs } : {}),
        ...(hasAttachments ? { composerDraftAttachments: nextAttachments } : {}),
        ...(hasRestored ? { composerRestoredAttachments: nextRestored } : {}),
        ...(!alreadyMarkedDeleted ? { deletedSessionDraftKeys: nextDeleted } : {}),
      }
    })
  },
  setComposerDraft: (draft) => set({ composerDraft: draft }),

  setComposerDraftForSession: (sessionId, draft, references = [], options) =>
    set((state) => {
      const key = getComposerDraftKey(sessionId)
      const shouldUpdateLegacy =
        !options?.preserveLegacyDraft && key === NEW_CHAT_COMPOSER_DRAFT_KEY
      return {
        ...(shouldUpdateLegacy ? { composerDraft: draft } : {}),
        composerDrafts: {
          ...state.composerDrafts,
          [key]: draft,
        },
        composerDraftReferences: {
          ...state.composerDraftReferences,
          [key]: references.map((ref) => ({ ...ref })),
        },
      }
    }),

  setPendingSessionContext: (pendingSessionContext) =>
    set({ pendingSessionContext }),

  pushToast: (message, action) => {
    const id = createId()
    set((state) => ({
      toasts: [...state.toasts, { id, message, action }],
    }))
    return id
  },

  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),

  hydrate: (data) =>
    set((state) => ({
      collapsedGroups: data.collapsedGroups ?? state.collapsedGroups,
      sidebarCollapsed:
        typeof data.sidebarCollapsed === 'boolean'
          ? (isMobileBrowser() ? true : data.sidebarCollapsed)
          : (isMobileBrowser() ? true : state.sidebarCollapsed),
      sidebarWidth:
        typeof data.sidebarWidth === 'number'
          ? clampSidebarWidth(data.sidebarWidth)
          : state.sidebarWidth,
      rightSidebarCollapsed:
        typeof data.rightSidebarCollapsed === 'boolean'
          ? data.rightSidebarCollapsed
          : state.rightSidebarCollapsed,
      rightSidebarMaximized:
        typeof data.rightSidebarMaximized === 'boolean'
          ? data.rightSidebarMaximized
          : state.rightSidebarMaximized,
      rightSidebarWidth:
        data.rightSidebarWidth === null
          ? null
          : typeof data.rightSidebarWidth === 'number'
            ? clampRightSidebarWidth(data.rightSidebarWidth)
            : state.rightSidebarWidth,
      rightPanelOpenTabs: Array.isArray(data.rightPanelOpenTabs)
        ? data.rightPanelOpenTabs
        : state.rightPanelOpenTabs,
      rightPanelActiveTab:
        data.rightPanelActiveTab !== undefined
          ? data.rightPanelActiveTab
          : state.rightPanelActiveTab,
      rightPanelTabParams:
        data.rightPanelTabParams && typeof data.rightPanelTabParams === 'object'
          ? data.rightPanelTabParams
          : state.rightPanelTabParams,
      pinnedSummaryVisible:
        typeof data.pinnedSummaryVisible === 'boolean'
          ? (isMobileBrowser() ? false : data.pinnedSummaryVisible)
          : (isMobileBrowser() ? false : state.pinnedSummaryVisible),
      bottomPanelVisible:
        typeof data.bottomPanelVisible === 'boolean'
          ? data.bottomPanelVisible
          : state.bottomPanelVisible,
      bottomPanelHeight:
        typeof data.bottomPanelHeight === 'number'
          ? clampBottomPanelHeight(data.bottomPanelHeight)
          : state.bottomPanelHeight,
    })),
}))
