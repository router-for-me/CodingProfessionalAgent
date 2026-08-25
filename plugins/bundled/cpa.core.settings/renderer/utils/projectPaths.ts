import type { Project } from '@cpa/plugin-api'

/**
 * Returns all non-empty folder paths associated with a project.
 */
export function getProjectPaths(project: Project | null | undefined): string[] {
    if (!project) return []

    const candidates = [
        ...(Array.isArray(project.paths) ? project.paths : []),
        ...(project.path ? [project.path] : []),
    ]

    const unique: string[] = []
    const seen = new Set<string>()

    for (const raw of candidates) {
        if (typeof raw !== 'string') continue
        const trimmed = raw.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        unique.push(trimmed)
    }

    return unique
}
