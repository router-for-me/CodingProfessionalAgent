import type { Project, Session } from '@/types/models'
import type { ConversationEntry } from '@/features/agent-runtime/session/types'

export function getSessionFirstPromptTime(
    session: Session,
    entries?: readonly ConversationEntry[],
): number {
    if (entries && entries.length > 0) {
        const firstUserEntry = entries.find((e) => e.kind === 'user')
        if (firstUserEntry && typeof firstUserEntry.createdAt === 'number' && firstUserEntry.createdAt > 0) {
            return firstUserEntry.createdAt
        }
    }
    if (typeof session.firstPromptAt === 'number' && session.firstPromptAt > 0) {
        return session.firstPromptAt
    }
    return session.createdAt ?? 0
}

export function sortByFirstPromptDesc(
    items: Session[],
    entriesBySession?: Record<string, ConversationEntry[]>,
): Session[] {
    return [...items].sort((a, b) => {
        const timeA = getSessionFirstPromptTime(a, entriesBySession?.[a.id])
        const timeB = getSessionFirstPromptTime(b, entriesBySession?.[b.id])
        if (timeB !== timeA) {
            return timeB - timeA
        }
        return (b.createdAt ?? 0) - (a.createdAt ?? 0)
    })
}

/**
 * Returns a flattened ordered list of all active/visible sessions as rendered in the sidebar.
 * Crosses project boundaries: pinned sessions -> sorted projects -> orphan projects -> uncategorized.
 */
export function getOrderedSessions(
    sessions: Session[],
    projects: Project[],
    entriesBySession?: Record<string, ConversationEntry[]>,
): Session[] {
    const activeSessions = sessions.filter(
        (session) => session.archivedAt === undefined,
    )

    const pinnedSessions = sortByFirstPromptDesc(
        activeSessions.filter((session) => session.pinned),
        entriesBySession,
    )

    const unpinnedSessions = activeSessions.filter((session) => !session.pinned)

    const sortedProjects = [...projects].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.updatedAt - a.updatedAt
    })

    const sessionsByProject = new Map<string, Session[]>()
    for (const session of unpinnedSessions) {
        if (!session.projectId) continue
        const list = sessionsByProject.get(session.projectId) ?? []
        list.push(session)
        sessionsByProject.set(session.projectId, list)
    }
    for (const [key, list] of sessionsByProject) {
        sessionsByProject.set(key, sortByFirstPromptDesc(list, entriesBySession))
    }

    const uncategorizedSessions = sortByFirstPromptDesc(
        unpinnedSessions.filter((session) => !session.projectId),
        entriesBySession,
    )

    const orphanProjectIds: string[] = []
    const known = new Set(projects.map((project) => project.id))
    for (const projectId of sessionsByProject.keys()) {
        if (!known.has(projectId)) orphanProjectIds.push(projectId)
    }

    const ordered: Session[] = [...pinnedSessions]
    for (const project of sortedProjects) {
        const list = sessionsByProject.get(project.id) ?? []
        ordered.push(...list)
    }
    for (const orphanId of orphanProjectIds) {
        const list = sessionsByProject.get(orphanId) ?? []
        ordered.push(...list)
    }
    ordered.push(...uncategorizedSessions)

    return ordered
}
