import { computeLineDiffStats, normalizeToLF } from '@cpa/plugin-sdk'

export interface FileChangeDetail {
    path: string
    additions: number
    deletions: number
    modifiedAt?: number
}

export interface SessionFileChanges {
    files: Record<string, FileChangeDetail>
    totalAdditions: number
    totalDeletions: number
    totalFilesChanged: number
}

export const EMPTY_SESSION_CHANGES: SessionFileChanges = {
    files: {},
    totalAdditions: 0,
    totalDeletions: 0,
    totalFilesChanged: 0,
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
    if (!raw) return null
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw)
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        } catch {
            return null
        }
    }
    if (typeof raw === 'object') {
        return raw as Record<string, unknown>
    }
    return null
}

/**
 * Extracts session file-change stats from conversation entries without importing host stores.
 */
export function extractFileChangesFromEntries(
    entries: readonly Record<string, unknown>[] | undefined | null
): SessionFileChanges | null {
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
        return null
    }

    const errorToolCallIds = new Set<string>()
    for (const entry of entries) {
        if (!entry || entry.kind !== 'toolResult') continue
        const toolCallId = String(entry.toolCallId || '')
        if (entry.isError === true && toolCallId) {
            errorToolCallIds.add(toolCallId)
        }
    }

    const files: Record<string, FileChangeDetail> = {}

    for (const entry of entries) {
        if (!entry || entry.status === 'streaming') continue

        const content = (entry.content ?? entry.parts) as unknown[] | undefined
        if (!Array.isArray(content)) continue

        for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const record = block as Record<string, unknown>
            const blockType = record.type
            if (blockType !== 'toolCall' && blockType !== 'tool_call') continue

            const name = String(record.name ?? record.toolName ?? '')
            if (name !== 'edit' && name !== 'write') continue

            const callId = String(record.id ?? '')
            if (callId && errorToolCallIds.has(callId)) continue

            const args = parseArgs(record.arguments ?? record.args)
            if (!args) continue

            const targetPath = typeof args.path === 'string' ? args.path.trim() : ''
            if (!targetPath) continue

            const details =
                record.details && typeof record.details === 'object'
                    ? (record.details as Record<string, unknown>)
                    : null

            let additions = 0
            let deletions = 0

            if (details && (details.additions != null || details.deletions != null)) {
                additions = Number(details.additions ?? 0) || 0
                deletions = Number(details.deletions ?? 0) || 0
            } else if (name === 'edit' && Array.isArray(args.edits)) {
                for (const editItem of args.edits) {
                    if (!editItem || typeof editItem !== 'object') continue
                    const editRecord = editItem as Record<string, unknown>
                    const oldText = typeof editRecord.oldText === 'string' ? editRecord.oldText : ''
                    const newText = typeof editRecord.newText === 'string' ? editRecord.newText : ''
                    const stats = computeLineDiffStats(normalizeToLF(oldText), normalizeToLF(newText))
                    additions += stats.additions
                    deletions += stats.deletions
                }
            } else if (name === 'write' && typeof args.content === 'string') {
                const contentText = args.content
                additions = contentText.length > 0 ? normalizeToLF(contentText).split('\n').length : 0
                deletions = 0
            } else if (record.result != null) {
                // Fallback: treat a successful mutation as at least one addition.
                additions = 1
            }

            const existing = files[targetPath]
            files[targetPath] = {
                path: targetPath,
                additions: (existing?.additions ?? 0) + additions,
                deletions: (existing?.deletions ?? 0) + deletions,
                modifiedAt: Number(entry.createdAt) || Date.now(),
            }
        }
    }

    const fileKeys = Object.keys(files)
    if (fileKeys.length === 0) {
        return null
    }

    let totalAdditions = 0
    let totalDeletions = 0
    for (const key of fileKeys) {
        const file = files[key]
        if (!file) continue
        totalAdditions += file.additions
        totalDeletions += file.deletions
    }

    return {
        files,
        totalAdditions,
        totalDeletions,
        totalFilesChanged: fileKeys.length,
    }
}
