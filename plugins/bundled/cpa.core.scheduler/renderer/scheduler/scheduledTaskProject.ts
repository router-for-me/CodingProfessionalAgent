import type { Project } from '@cpa/plugin-api'

export interface ScheduledTaskProjectReference {
    projectId?: string | null
    projectName?: string
    projectPath?: string
}

export function getProjectPaths(project: Pick<Project, 'path' | 'paths'> | null | undefined): string[] {
    if (!project) return []
    if (project.paths && Array.isArray(project.paths) && project.paths.length > 0) {
        return project.paths
    }
    if (project.path) {
        return [project.path]
    }
    return []
}

export function getPrimaryProjectPath(
    project: Pick<Project, 'path' | 'paths'> | null | undefined,
): string | undefined {
    return project ? getProjectPaths(project)[0] : undefined
}

export function findScheduledTaskProject(
    reference: ScheduledTaskProjectReference,
    projects: readonly Project[],
): Project | undefined {
    if (reference.projectId) {
        const projectById = projects.find((project) => project.id === reference.projectId)
        if (projectById) return projectById
    }

    const projectPath = reference.projectPath?.trim()
    if (!projectPath) return undefined

    return projects.find((project) => getProjectPaths(project).includes(projectPath))
}
