import { createId } from '@/lib/id'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { schedulePersist } from '@/application/services/persistenceService'
import type { ConversationEntry } from './types'

export interface ForkSessionOptions {
    sessionId: string
    messageId?: string
    navigate?: (opts: {
        to: string
        params?: Record<string, string>
    }) => Promise<void> | void
    workLocation?: 'local' | 'worktree'
    worktreePath?: string
    environmentId?: string | null
    branch?: string | null
}

/**
 * Creates a new forked session containing conversation entries up to the specified message/turn.
 * If messageId is not provided, forks the entire conversation.
 */
export function forkSession({
    sessionId,
    messageId,
    navigate,
    workLocation,
    worktreePath,
    environmentId,
    branch,
}: ForkSessionOptions): string | null {
    const sessionStore = useSessionStore.getState()
    const messageStore = useMessageStore.getState()
    const uiStore = useUiStore.getState()

    const sourceSession = sessionStore.sessions.find((s) => s.id === sessionId)
    if (!sourceSession || sourceSession.archivedAt !== undefined) {
        return null
    }

    const allEntries = messageStore.getEntries(sessionId)
    let entriesToFork: ConversationEntry[] = []

    if (messageId) {
        const targetIndex = allEntries.findIndex((entry) => entry.id === messageId)
        if (targetIndex >= 0) {
            // Find all contiguous toolResult entries following the assistant message if any
            let endIndex = targetIndex + 1
            while (
                endIndex < allEntries.length &&
                allEntries[endIndex]?.kind === 'toolResult'
            ) {
                endIndex += 1
            }
            entriesToFork = allEntries.slice(0, endIndex)
        } else {
            // If messageId is a merged turn ID or not directly matched, check if any entry has parts with this ID
            const matchingIndex = allEntries.findIndex((entry) => {
                if (entry.kind === 'assistant' && Array.isArray(entry.content)) {
                    return entry.content.some(
                        (block) => (block as { id?: string }).id === messageId,
                    )
                }
                return false
            })
            if (matchingIndex >= 0) {
                let endIndex = matchingIndex + 1
                while (
                    endIndex < allEntries.length &&
                    allEntries[endIndex]?.kind === 'toolResult'
                ) {
                    endIndex += 1
                }
                entriesToFork = allEntries.slice(0, endIndex)
            } else {
                entriesToFork = allEntries.slice()
            }
        }
    } else {
        entriesToFork = allEntries.slice()
    }

    const newSessionId = createId()
    const baseTitle = sourceSession.title || 'Chat'
    const newTitle = baseTitle.endsWith(' (Fork)')
        ? `${baseTitle}`
        : `${baseTitle} (Fork)`

    // Deep clone entries and assign new entry IDs & new sessionId
    const clonedEntries: ConversationEntry[] = entriesToFork.map((entry) => {
        const cloned = JSON.parse(JSON.stringify(entry)) as ConversationEntry
        cloned.id = createId()
        cloned.sessionId = newSessionId
        if (cloned.kind === 'assistant' && cloned.status === 'streaming') {
            cloned.status = 'done'
        }
        return cloned
    })

    const isNewWorktree = (workLocation ?? sourceSession.workLocation) === 'worktree'

    // Create session in sessionStore
    sessionStore.createSession({
        id: newSessionId,
        title: newTitle,
        projectId: sourceSession.projectId,
        branch: branch !== undefined ? (branch ?? undefined) : sourceSession.branch,
        baseBranch: sourceSession.baseBranch,
        firstPromptAt: sourceSession.firstPromptAt,
        workLocation: workLocation ?? sourceSession.workLocation,
        worktreePath: worktreePath !== undefined
            ? worktreePath
            : (isNewWorktree ? undefined : sourceSession.worktreePath),
        environmentId: environmentId !== undefined
            ? environmentId
            : sourceSession.environmentId,
        worktreeSetup: isNewWorktree ? undefined : sourceSession.worktreeSetup,
        modelId: sourceSession.modelId,
        reasoningEffort: sourceSession.reasoningEffort,
        speed: sourceSession.speed,
    })

    // Set entries in messageStore
    messageStore.replaceSessionEntries(newSessionId, clonedEntries)

    // Schedule background persistence
    schedulePersist(true)

    // Switch UI state
    sessionStore.setCurrentSession(newSessionId)
    uiStore.restoreForSession(sourceSession.rightSidebar ?? null)

    if (uiStore.settingsOpen) {
        uiStore.setSettingsOpen(false)
    }

    if (navigate) {
        void navigate({
            to: '/chat/$sessionId',
            params: { sessionId: newSessionId },
        })
    }

    return newSessionId
}
