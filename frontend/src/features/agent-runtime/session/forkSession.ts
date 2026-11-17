import { createId } from '@/lib/id'
import { useMessageStore } from '@/stores/messageStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { schedulePersist } from '@/application/services/persistenceService'
import { getHostBridge } from '@/application/services/hostTransport'
import i18n from '@/i18n'
import type { ConversationEntry } from './types'

const pendingForkPromptCopies = new Map<string, Promise<void>>()
const failedForkPromptCopies = new Map<string, Error>()
const forkedSourceSessions = new Map<string, string>()
const forkPromptEpochBySession = new Map<string, number>()

function getForkPromptEpoch(sessionId: string): number {
    return forkPromptEpochBySession.get(sessionId) ?? 0
}

function isForkPromptCopyCancelled(sessionId: string, startEpoch: number): boolean {
    if (getForkPromptEpoch(sessionId) !== startEpoch) {
        return true
    }
    return !useSessionStore
        .getState()
        .sessions.some((session) => session.id === sessionId)
}

async function performForkPromptCopy(
    newSessionId: string,
    sourceSessionId: string,
    startEpoch: number,
): Promise<void> {
    if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
        return
    }
    const bridge = getHostBridge()
    if (
        typeof bridge?.SessionGetSystemPrompt !== 'function' ||
        typeof bridge?.SessionSetSystemPrompt !== 'function'
    ) {
        return
    }
    const forkedSession = useSessionStore
        .getState()
        .sessions.find((session) => session.id === newSessionId)
    if (forkedSession && typeof bridge.SessionSetMeta === 'function') {
        await bridge.SessionSetMeta(forkedSession)
    }
    if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
        return
    }
    await waitForForkedSessionPrompt(sourceSessionId)
    if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
        return
    }
    const sourcePrompt = await bridge.SessionGetSystemPrompt(sourceSessionId)
    if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
        return
    }
    if (typeof sourcePrompt === 'string' && sourcePrompt.length > 0) {
        const saved = await bridge.SessionSetSystemPrompt(newSessionId, sourcePrompt)
        if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
            return
        }
        if (saved === false) {
            throw new Error('Failed to persist forked session system prompt')
        }
    } else {
        // Resolve persisted inheritance even when the source has no enhanced prompt.
        await bridge.SessionGetSystemPrompt(newSessionId)
    }
}

function startForkPromptCopy(
    newSessionId: string,
    sourceSessionId: string,
    notifyOnFailure: boolean,
): Promise<void> {
    const existing = pendingForkPromptCopies.get(newSessionId)
    if (existing) {
        return existing
    }
    const startEpoch = forkPromptEpochBySession.get(newSessionId) ?? 0
    let copyPromise!: Promise<void>
    copyPromise = (async () => {
        try {
            await performForkPromptCopy(newSessionId, sourceSessionId, startEpoch)
            if (!isForkPromptCopyCancelled(newSessionId, startEpoch)) {
                failedForkPromptCopies.delete(newSessionId)
            }
        } catch (error) {
            if (isForkPromptCopyCancelled(newSessionId, startEpoch)) {
                return
            }
            const err =
                error instanceof Error
                    ? error
                    : new Error(String(error ?? 'Failed to copy forked system prompt'))
            failedForkPromptCopies.set(newSessionId, err)
            if (notifyOnFailure) {
                useUiStore.getState().pushToast(
                    i18n.t('agent.preflight.system_prompt_enhancement_failed', {
                        defaultValue: err.message,
                    }),
                )
            }
            throw err
        } finally {
            if (pendingForkPromptCopies.get(newSessionId) === copyPromise) {
                pendingForkPromptCopies.delete(newSessionId)
            }
        }
    })()
    pendingForkPromptCopies.set(newSessionId, copyPromise)
    // Prevent unhandled rejection when no caller immediately awaits waitForForkedSessionPrompt
    copyPromise.catch(() => {})
    return copyPromise
}

/**
 * Await any in-flight per-session enhanced system prompt copy initiated by `forkSession`.
 * If a prior copy failed transiently, verifies whether another client already persisted
 * the prompt or retries the copy from the source session before failing closed.
 */
export async function waitForForkedSessionPrompt(sessionId: string): Promise<void> {
    if (!sessionId) return
    const startEpoch = getForkPromptEpoch(sessionId)
    const pending = pendingForkPromptCopies.get(sessionId)
    if (pending) {
        await pending
    }
    if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
        return
    }
    const priorError = failedForkPromptCopies.get(sessionId)
    if (!priorError) {
        return
    }

    const bridge = getHostBridge()
    if (typeof bridge?.SessionGetSystemPrompt === 'function') {
        try {
            const existing = await bridge.SessionGetSystemPrompt(sessionId)
            if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
                return
            }
            if (typeof existing === 'string' && existing.length > 0) {
                failedForkPromptCopies.delete(sessionId)
                return
            }
        } catch {
            if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
                return
            }
            // Fall through to retry from source session or fail closed.
        }
    }
    if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
        return
    }

    const sourceSessionId =
        forkedSourceSessions.get(sessionId) ??
        useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.pendingSystemPromptFrom
    if (sourceSessionId) {
        try {
            await startForkPromptCopy(sessionId, sourceSessionId, false)
        } catch (retryError) {
            if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
                return
            }
            throw retryError
        }
        return
    }
    if (isForkPromptCopyCancelled(sessionId, startEpoch)) {
        return
    }

    throw priorError
}

export function clearForkedSessionPromptState(sessionId: string): void {
    if (!sessionId) return
    forkPromptEpochBySession.set(
        sessionId,
        (forkPromptEpochBySession.get(sessionId) ?? 0) + 1,
    )
    pendingForkPromptCopies.delete(sessionId)
    failedForkPromptCopies.delete(sessionId)
    forkedSourceSessions.delete(sessionId)
}

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
        pendingSystemPromptFrom: sessionId,
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

    // Copy persisted per-session enhanced system prompt if present and track barrier
    forkedSourceSessions.set(newSessionId, sessionId)
    const bridge = getHostBridge()
    if (typeof bridge?.SessionGetSystemPrompt === 'function' && typeof bridge?.SessionSetSystemPrompt === 'function') {
        startForkPromptCopy(newSessionId, sessionId, true)
    }

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
