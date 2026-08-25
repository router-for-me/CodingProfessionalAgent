export interface TerminalContextResolverInput {
    sessionId?: string | null
    sessions?: readonly { id: string; projectId?: string | null }[]
    projects?: readonly { id: string; name: string; path: string }[]
    pendingProjectId?: string | null
    fallbackTitle: string
}

export function resolveTerminalContext(input: TerminalContextResolverInput): { title: string; cwd: string } {
    const session = input.sessionId && input.sessions
        ? input.sessions.find((item) => item.id === input.sessionId)
        : undefined
    const projectId = session?.projectId ?? input.pendingProjectId
    const project = projectId && input.projects
        ? input.projects.find((item) => item.id === projectId)
        : undefined
    const cwd = project?.path ?? ''
    return {
        title: project?.name || input.fallbackTitle,
        cwd,
    }
}
