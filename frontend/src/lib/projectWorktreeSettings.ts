import { useSessionStore } from '@/stores/sessionStore'
import { useProjectStore } from '@/stores/projectStore'
import type { Session, Project } from '@/types/models'

export interface ProjectWorktreeSettings {
    workLocation?: 'local' | 'worktree'
    environmentId?: string | null
}

/**
 * Returns the last-used worktree location ('local' | 'worktree') and environmentId for a project.
 * It inspects the project's most recent active/existing sessions first (sorted by updatedAt/createdAt/firstPromptAt);
 * if no sessions exist, it inspects the project entity properties, returning undefined if unset.
 */
export function getLastUsedProjectWorktreeSettings(
    projectId: string | null | undefined,
    options?: {
        sessions?: Session[]
        projects?: Project[]
    },
): ProjectWorktreeSettings {
    if (!projectId) {
        return {}
    }

    const sessions = options?.sessions ?? useSessionStore.getState().sessions
    const projects = options?.projects ?? useProjectStore.getState().projects

    const projectSessions = sessions.filter((s) => s.projectId === projectId)
    if (projectSessions.length > 0) {
        const unarchivedSessions = projectSessions.filter((s) => s.archivedAt === undefined)
        const candidates = unarchivedSessions.length > 0 ? unarchivedSessions : projectSessions
        // Sort sessions by most recent activity: latest updatedAt, createdAt, or firstPromptAt
        const sorted = [...candidates].sort((a, b) => {
            const timeA = Math.max(
                a.updatedAt ?? 0,
                a.createdAt ?? 0,
                a.firstPromptAt ?? 0,
            )
            const timeB = Math.max(
                b.updatedAt ?? 0,
                b.createdAt ?? 0,
                b.firstPromptAt ?? 0,
            )
            if (timeB !== timeA) return timeB - timeA
            return (b.createdAt ?? 0) - (a.createdAt ?? 0)
        })
        const latestSession = sorted[0]
        if (latestSession) {
            let loc: 'local' | 'worktree' | undefined = latestSession.workLocation
            if (!loc && latestSession.worktreeSetup && latestSession.worktreeSetup.status !== 'idle') {
                loc = 'worktree'
            }
            const envId =
                latestSession.environmentId !== undefined
                    ? latestSession.environmentId
                    : (latestSession.worktreeSetup?.environmentId ?? undefined)

            if (loc === undefined) {
                const project = projects.find((p) => p.id === projectId)
                if (project?.workLocation !== undefined) {
                    loc = project.workLocation
                }
            }

            return {
                ...(loc !== undefined ? { workLocation: loc } : {}),
                ...(envId !== undefined ? { environmentId: envId } : {}),
            }
        }
    }

    const project = projects.find((p) => p.id === projectId)
    if (project) {
        return {
            ...(project.workLocation !== undefined ? { workLocation: project.workLocation } : {}),
            ...(project.environmentId !== undefined ? { environmentId: project.environmentId } : {}),
        }
    }

    return {}
}

/**
 * Persists the last-used worktree settings onto the project record in projectStore.
 */
export function saveLastUsedProjectWorktreeSettings(
    projectId: string | null | undefined,
    settings: Partial<ProjectWorktreeSettings>,
): void {
    if (!projectId) return
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (project) {
        useProjectStore.getState().updateProject(projectId, {
            ...(settings.workLocation !== undefined ? { workLocation: settings.workLocation } : {}),
            ...(settings.environmentId !== undefined ? { environmentId: settings.environmentId } : {}),
        })
    }
}
