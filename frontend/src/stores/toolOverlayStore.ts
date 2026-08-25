/**
 * Ephemeral live tool UI overlays (status/partial/details/images).
 * Not part of the canonical ConversationEntry source of truth and never persisted.
 * Keyed by sessionId + normalized toolCallId; runId gates late-run updates.
 *
 * Instances are per-runtime/store (factory + optional inject). The default export
 * singleton remains for messageStore/ChatView compatibility.
 */

import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { normalizeToolCallId } from '@/features/agent-runtime/session/migration'
import type { DisplayToolStatus } from '@/features/agent-runtime/session/types'

export interface ToolOverlayImage {
  data: string
  mimeType: string
}

export interface ToolOverlayDetails {
  diff?: string
  patch?: string
}

export interface ToolLiveOverlay {
  sessionId: string
  runId: string
  /** Normalized tool call id (first segment before `|`). */
  toolCallId: string
  status: DisplayToolStatus
  partialOutput?: string
  details?: ToolOverlayDetails
  /**
   * Explicit list (may be empty). Empty means "no live images" and must not
   * mask canonical projected images in the UI.
   */
  resultImages?: ToolOverlayImage[]
  updatedAt: number
}

type SessionOverlayMap = Record<string, ToolLiveOverlay>

/**
 * Patch field semantics:
 * - key absent (`undefined`): no change
 * - `null`: explicit clear
 * - value: set / replace
 */
export type OverlayFieldPatch<T> = T | null | undefined

export interface ToolOverlayPatch {
  status?: DisplayToolStatus
  partialOutput?: OverlayFieldPatch<string>
  details?: OverlayFieldPatch<ToolOverlayDetails>
  resultImages?: OverlayFieldPatch<readonly ToolOverlayImage[]>
}

export interface ToolOverlayState {
  bySession: Record<string, SessionOverlayMap>
  upsert: (overlay: ToolLiveOverlay) => void
  patch: (
    sessionId: string,
    toolCallId: string,
    runId: string,
    patch: ToolOverlayPatch,
  ) => void
  /** Always-replace terminal write (absent optional fields become clears). */
  replaceTerminal: (
    sessionId: string,
    toolCallId: string,
    runId: string,
    fields: {
      status: DisplayToolStatus
      partialOutput?: string
      details?: ToolOverlayDetails
      resultImages?: readonly ToolOverlayImage[]
    },
  ) => void
  clearSession: (sessionId: string) => void
  clearSessions: (sessionIds: readonly string[]) => void
  clearAll: () => void
  getSessionOverlays: (sessionId: string) => SessionOverlayMap
  getOverlay: (
    sessionId: string,
    toolCallId: string,
  ) => ToolLiveOverlay | undefined
}

export type ToolOverlayStore = UseBoundStore<StoreApi<ToolOverlayState>>

const EMPTY_SESSION: SessionOverlayMap = Object.freeze({})

function emptyBySession(): Record<string, SessionOverlayMap> {
  return Object.create(null) as Record<string, SessionOverlayMap>
}

function emptySessionMap(): SessionOverlayMap {
  return Object.create(null) as SessionOverlayMap
}

function isTerminalToolStatus(status: DisplayToolStatus | undefined): boolean {
  return (
    status === 'done' ||
    status === 'rejected' ||
    status === 'error' ||
    status === 'aborted'
  )
}

/** Cycle-safe shallow details clone; only keeps string diff/patch fields. */
export function cloneOverlayDetails(
  value: unknown,
): ToolOverlayDetails | undefined {
  if (!value || typeof value !== 'object') return undefined
  try {
    const record = value as Record<string, unknown>
    const out: ToolOverlayDetails = {}
    if (typeof record.diff === 'string') out.diff = record.diff
    if (typeof record.patch === 'string') out.patch = record.patch
    return out.diff !== undefined || out.patch !== undefined ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * Defensive image clone.
 * - `undefined` input → `undefined` (absent)
 * - empty array input → `[]` (explicit empty, caller may use for clear)
 */
export function cloneOverlayImages(
  images: readonly ToolOverlayImage[] | undefined,
): ToolOverlayImage[] | undefined {
  if (images === undefined) return undefined
  const out: ToolOverlayImage[] = []
  for (const image of images) {
    if (!image || typeof image !== 'object') continue
    if (typeof image.data !== 'string' || typeof image.mimeType !== 'string') {
      continue
    }
    out.push({ data: image.data, mimeType: image.mimeType })
  }
  return out
}

function cloneSessionMapInto(
  target: SessionOverlayMap,
  source: SessionOverlayMap,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value
  }
}

function cloneBySessionInto(
  target: Record<string, SessionOverlayMap>,
  source: Record<string, SessionOverlayMap>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = value
  }
}

function buildToolOverlayStore(): ToolOverlayState {
  // Placeholder; real set/get closed over by create() below.
  return {} as ToolOverlayState
}

/** Create an isolated overlay store instance (vanilla Zustand). */
export function createToolOverlayStore(): ToolOverlayStore {
  return create<ToolOverlayState>((set, get) => ({
    bySession: emptyBySession(),

    upsert: (overlay) => {
      const sessionId = overlay.sessionId
      const toolCallId = normalizeToolCallId(overlay.toolCallId)
      const next: ToolLiveOverlay = {
        sessionId,
        runId: overlay.runId,
        toolCallId,
        status: overlay.status,
        partialOutput:
          typeof overlay.partialOutput === 'string'
            ? overlay.partialOutput
            : undefined,
        details: cloneOverlayDetails(overlay.details),
        resultImages:
          overlay.resultImages !== undefined
            ? cloneOverlayImages(overlay.resultImages)
            : undefined,
        updatedAt: overlay.updatedAt || Date.now(),
      }
      set((state) => {
        const prevSession = state.bySession[sessionId] ?? emptySessionMap()
        const sessionMap = emptySessionMap()
        cloneSessionMapInto(sessionMap, prevSession)
        sessionMap[toolCallId] = next
        const bySession = emptyBySession()
        cloneBySessionInto(bySession, state.bySession)
        bySession[sessionId] = sessionMap
        return { bySession }
      })
    },

    patch: (sessionId, toolCallId, runId, patchValue) => {
      const normalized = normalizeToolCallId(toolCallId)
      const existing = get().bySession[sessionId]?.[normalized]
      // Late-run guard: never revive/overwrite another run's overlay.
      if (existing && existing.runId !== runId) return
      // Terminal status is monotonic within a run. In particular, a delayed
      // streamed tool-update must not revive a completed command as running.
      if (
        existing &&
        isTerminalToolStatus(existing.status) &&
        !isTerminalToolStatus(patchValue.status)
      ) {
        return
      }
      const base: ToolLiveOverlay = existing ?? {
        sessionId,
        runId,
        toolCallId: normalized,
        status: 'running',
        updatedAt: Date.now(),
      }
      if (base.runId !== runId && existing) return

      const next: ToolLiveOverlay = {
        ...base,
        runId,
        status: patchValue.status ?? base.status,
        updatedAt: Date.now(),
      }

      // partialOutput: absent=nochange, null=clear, string=set
      if (patchValue.partialOutput === null) {
        next.partialOutput = undefined
      } else if (typeof patchValue.partialOutput === 'string') {
        next.partialOutput = patchValue.partialOutput
      }

      // details: absent=nochange, null=clear, object=set
      if (patchValue.details === null) {
        next.details = undefined
      } else if (patchValue.details !== undefined) {
        next.details = cloneOverlayDetails(patchValue.details)
      }

      // resultImages: absent=nochange, null or []=explicit empty, nonempty=set
      if (patchValue.resultImages === null) {
        next.resultImages = []
      } else if (patchValue.resultImages !== undefined) {
        next.resultImages = cloneOverlayImages(patchValue.resultImages) ?? []
      }

      get().upsert(next)
    },

    replaceTerminal: (sessionId, toolCallId, runId, fields) => {
      // Terminal always replaces optional live fields (explicit clear vs set).
      get().patch(sessionId, toolCallId, runId, {
        status: fields.status,
        partialOutput:
          typeof fields.partialOutput === 'string'
            ? fields.partialOutput
            : null,
        details: fields.details ?? null,
        resultImages:
          fields.resultImages !== undefined ? fields.resultImages : [],
      })
    },

    clearSession: (sessionId) => {
      set((state) => {
        if (!state.bySession[sessionId]) return state
        const bySession = emptyBySession()
        for (const [key, value] of Object.entries(state.bySession)) {
          if (key === sessionId) continue
          bySession[key] = value
        }
        return { bySession }
      })
    },

    clearSessions: (sessionIds) => {
      if (sessionIds.length === 0) return
      const drop = new Set(sessionIds)
      set((state) => {
        let changed = false
        const bySession = emptyBySession()
        for (const [key, value] of Object.entries(state.bySession)) {
          if (drop.has(key)) {
            changed = true
            continue
          }
          bySession[key] = value
        }
        return changed ? { bySession } : state
      })
    },

    clearAll: () => set({ bySession: emptyBySession() }),

    getSessionOverlays: (sessionId) => {
      const map = get().bySession[sessionId]
      if (!map) return EMPTY_SESSION
      // Defensive shallow copy of the session map.
      const copy = emptySessionMap()
      for (const [key, value] of Object.entries(map)) {
        copy[key] = {
          ...value,
          details: cloneOverlayDetails(value.details),
          resultImages:
            value.resultImages !== undefined
              ? cloneOverlayImages(value.resultImages)
              : undefined,
        }
      }
      return copy
    },

    getOverlay: (sessionId, toolCallId) => {
      const normalized = normalizeToolCallId(toolCallId)
      const value = get().bySession[sessionId]?.[normalized]
      if (!value) return undefined
      return {
        ...value,
        details: cloneOverlayDetails(value.details),
        resultImages:
          value.resultImages !== undefined
            ? cloneOverlayImages(value.resultImages)
            : undefined,
      }
    },
  }))
}

// Silence unused helper placeholder if tree-shaken away.
void buildToolOverlayStore

/** Default singleton for messageStore / ChatView compatibility. */
export const useToolOverlayStore: ToolOverlayStore = createToolOverlayStore()

/** Test helper — wipe the default singleton. */
export function __resetToolOverlayStoreForTests(): void {
  useToolOverlayStore.getState().clearAll()
}
