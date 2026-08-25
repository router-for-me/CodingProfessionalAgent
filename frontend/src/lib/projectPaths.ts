import type { Project } from '@/types/models'

/** Return a project's source folders in stable order without empty duplicates. */
export function getProjectPaths(
  project: Pick<Project, 'path' | 'paths'>,
): string[] {
  const values = project.paths?.length
    ? project.paths
    : project.path
      ? [project.path]
      : []
  const paths: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    if (typeof value !== 'string') continue
    const path = value.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }

  if (typeof project.path === 'string' && project.path) {
    const legacyPath = project.path.trim()
    if (legacyPath && !seen.has(legacyPath)) {
      paths.unshift(legacyPath)
    }
  }

  return paths
}

/** Keep the legacy primary path in sync with the canonical source-folder list. */
export function createProjectPathsPatch(paths: readonly string[]): {
  path: string | undefined
  paths: string[]
} {
  const normalized = getProjectPaths({ paths: [...paths] })
  return {
    path: normalized[0],
    paths: normalized,
  }
}
