import { create } from 'zustand'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'
import { computeLineDiffStats, normalizeToLF } from '@cpa/plugin-sdk'

export interface FileChangeDetail {
    path: string
    additions: number
    deletions: number
    modifiedAt: number
}

export interface SessionFileChanges {
    files: Record<string, FileChangeDetail>
    totalAdditions: number
    totalDeletions: number
    totalFilesChanged: number
}

export interface FileChangeState {
    changesBySession: Record<string, SessionFileChanges>
    recordChange: (
        sessionId: string,
        change: { path: string; additions: number; deletions: number }
    ) => void
    setSessionChanges: (sessionId: string, changes: SessionFileChanges) => void
    getChanges: (sessionId: string) => SessionFileChanges
    clearSessionChanges: (sessionId: string) => void
    clearAll: () => void
}

export const EMPTY_SESSION_CHANGES: SessionFileChanges = {
    files: {},
    totalAdditions: 0,
    totalDeletions: 0,
    totalFilesChanged: 0,
}

const entriesResultCache = new WeakMap<
    readonly (ConversationEntry | Record<string, unknown>)[],
    SessionFileChanges | null
>()

function areSessionChangesEqual(
    a: SessionFileChanges | undefined,
    b: SessionFileChanges | null
): boolean {
    if (!a && !b) return true
    if (!a || !b) return false
    if (
        a.totalAdditions !== b.totalAdditions ||
        a.totalDeletions !== b.totalDeletions ||
        a.totalFilesChanged !== b.totalFilesChanged
    ) {
        return false
    }
    const aKeys = Object.keys(a.files)
    const bKeys = Object.keys(b.files)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
        const aFile = a.files[key]
        const bFile = b.files[key]
        if (!bFile) return false
        if (aFile.additions !== bFile.additions || aFile.deletions !== bFile.deletions) {
            return false
        }
    }
    return true
}

/**
 * Extracts file change statistics from a session's conversation entries.
 */
export function extractFileChangesFromEntries(
    entries: readonly (ConversationEntry | Record<string, unknown>)[] | undefined | null
): SessionFileChanges | null {
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return null
    }

    // Fast-path: return cached result if entries array reference hasn't changed
    const cached = entriesResultCache.get(entries)
    if (cached !== undefined) {
        return cached
    }

    // Map toolCallId -> error boolean from toolResult entries
    const errorToolCallIds = new Set<string>()
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as Record<string, unknown> | undefined
        if (!entry) continue
        if (entry.kind === 'toolResult') {
            const toolCallId = String(entry.toolCallId || '')
            if (entry.isError === true && toolCallId) {
                errorToolCallIds.add(toolCallId)
            }
        }
    }

    const files: Record<string, FileChangeDetail> = {}

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as Record<string, unknown> | undefined
        if (!entry) continue

        // Skip incomplete streaming entries
        if (entry.status === 'streaming') {
            continue
        }

        const content = (entry.content ?? entry.parts) as unknown[] | undefined
        if (!Array.isArray(content)) continue

        for (let j = 0; j < content.length; j++) {
            const block = content[j] as Record<string, unknown> | undefined
            if (!block) continue

            const blockType = block.type
            const name = block.name ?? block.toolName
            const callId = String(block.id ?? '')

            if (callId && errorToolCallIds.has(callId)) {
                continue
            }

            if (blockType === 'toolCall' || blockType === 'tool_call') {
                let rawArgs = block.arguments ?? block.args
                if (typeof rawArgs === 'string') {
                    try {
                        rawArgs = JSON.parse(rawArgs)
                    } catch {
                        rawArgs = null
                    }
                }

                if (!rawArgs || typeof rawArgs !== 'object') continue
                const argsObj = rawArgs as Record<string, unknown>
                const targetPath = typeof argsObj.path === 'string' ? argsObj.path.trim() : ''
                if (!targetPath) continue

                if (name === 'edit' && Array.isArray(argsObj.edits)) {
                    let totalCallAdditions = 0
                    let totalCallDeletions = 0
                    for (const editItem of argsObj.edits) {
                        if (editItem && typeof editItem === 'object') {
                            const oldText = typeof editItem.oldText === 'string' ? editItem.oldText : ''
                            const newText = typeof editItem.newText === 'string' ? editItem.newText : ''
                            const stats = computeLineDiffStats(normalizeToLF(oldText), normalizeToLF(newText))
                            totalCallAdditions += stats.additions
                            totalCallDeletions += stats.deletions
                        }
                    }

                    const existing = files[targetPath]
                    files[targetPath] = {
                        path: targetPath,
                        additions: (existing?.additions ?? 0) + totalCallAdditions,
                        deletions: (existing?.deletions ?? 0) + totalCallDeletions,
                        modifiedAt: Number(entry.createdAt) || Date.now(),
                    }
                } else if (name === 'write' && typeof argsObj.content === 'string') {
                    const lines = normalizeToLF(argsObj.content).split('\n')
                    const writeAdditions = argsObj.content.length > 0 ? lines.length : 0
                    const writeDeletions = 0

                    const existing = files[targetPath]
                    files[targetPath] = {
                        path: targetPath,
                        additions: (existing?.additions ?? 0) + writeAdditions,
                        deletions: (existing?.deletions ?? 0) + writeDeletions,
                        modifiedAt: Number(entry.createdAt) || Date.now(),
                    }
                }
            }
        }
    }

    const fileKeys = Object.keys(files)
    if (fileKeys.length === 0) {
        entriesResultCache.set(entries, null)
        return null
    }

    let totalAdditions = 0
    let totalDeletions = 0
    for (const key of fileKeys) {
        const file = files[key]
        if (file) {
            totalAdditions += file.additions
            totalDeletions += file.deletions
        }
    }

    const result: SessionFileChanges = {
        files,
        totalAdditions,
        totalDeletions,
        totalFilesChanged: fileKeys.length,
    }
    entriesResultCache.set(entries, result)
    return result
}

/**
 * Synchronizes the in-memory FileChangeStore for a session from its conversation entries.
 */
export function syncFileChangesFromEntries(
    sessionId: string,
    entries: readonly (ConversationEntry | Record<string, unknown>)[] | undefined | null
): void {
    if (!sessionId) return
    if (!entries || entries.length === 0) {
        if (useFileChangeStore.getState().changesBySession[sessionId]) {
            useFileChangeStore.getState().clearSessionChanges(sessionId)
        }
        return
    }
    const extracted = extractFileChangesFromEntries(entries)
    const current = useFileChangeStore.getState().changesBySession[sessionId]
    if (extracted !== null) {
        if (!areSessionChangesEqual(current, extracted)) {
            useFileChangeStore.getState().setSessionChanges(sessionId, extracted)
        }
    } else {
        if (current) {
            useFileChangeStore.getState().clearSessionChanges(sessionId)
        }
    }
}

export const useFileChangeStore = create<FileChangeState>((set, get) => ({
    changesBySession: {},

    recordChange: (
        sessionId: string,
        change: { path: string; additions: number; deletions: number }
    ) => {
        if (!sessionId || !change.path) return

        const currentSession = get().changesBySession[sessionId] ?? {
            files: {},
            totalAdditions: 0,
            totalDeletions: 0,
            totalFilesChanged: 0,
        }

        const existingFile = currentSession.files[change.path]
        const updatedFile: FileChangeDetail = {
            path: change.path,
            additions: (existingFile?.additions ?? 0) + change.additions,
            deletions: (existingFile?.deletions ?? 0) + change.deletions,
            modifiedAt: Date.now(),
        }

        const nextFiles = {
            ...currentSession.files,
            [change.path]: updatedFile,
        }

        let totalAdditions = 0
        let totalDeletions = 0
        for (const file of Object.values(nextFiles)) {
            totalAdditions += file.additions
            totalDeletions += file.deletions
        }

        set((state) => ({
            changesBySession: {
                ...state.changesBySession,
                [sessionId]: {
                    files: nextFiles,
                    totalAdditions,
                    totalDeletions,
                    totalFilesChanged: Object.keys(nextFiles).length,
                },
            },
        }))
    },

    setSessionChanges: (sessionId: string, changes: SessionFileChanges) => {
        if (!sessionId) return
        set((state) => ({
            changesBySession: {
                ...state.changesBySession,
                [sessionId]: changes,
            },
        }))
    },

    getChanges: (sessionId: string) => {
        if (!sessionId) return EMPTY_SESSION_CHANGES
        return get().changesBySession[sessionId] ?? EMPTY_SESSION_CHANGES
    },

    clearSessionChanges: (sessionId: string) => {
        if (!sessionId) return
        set((state) => {
            if (!(sessionId in state.changesBySession)) return state
            const next = { ...state.changesBySession }
            delete next[sessionId]
            return { changesBySession: next }
        })
    },

    clearAll: () => {
        set({ changesBySession: {} })
    },
}))
