import type {
    AgentToolContribution,
    HostServices,
    PluginCapabilityClient,
    Project,
    SessionItem,
} from '@cpa/plugin-api'

export const SESSION_SEARCH_TOOL_NAME = 'session_search'
export const SESSION_CREATE_TOOL_NAME = 'session_create'
export const CREATE_SESSION_TOOL_NAME = SESSION_CREATE_TOOL_NAME

export interface SessionSearchArgs {
    query?: string
    title?: string
    timeRange?: 'today' | 'yesterday' | 'this_week' | 'past_7_days' | 'past_30_days' | 'all'
    createdAfter?: string | number
    createdBefore?: string | number
    updatedAfter?: string | number
    updatedBefore?: string | number
    projectId?: string
    scheduleId?: string
    limit?: number
    includeMessages?: boolean
    sessionId?: string
}

export interface CreateSessionArgs {
    title: string
    prompt?: string
    projectId?: string
    branch?: string
    workLocation?: 'local' | 'worktree'
    autoRun?: boolean
}

export interface SessionToolOptions {
    services?: HostServices
    capabilityClient?: PluginCapabilityClient
}

/**
 * Parses timestamp from string (ISO date or relative) or number (epoch ms).
 */
export function parseTimestamp(input: string | number | undefined): number | undefined {
    if (input === undefined || input === null) return undefined
    if (typeof input === 'number') return isNaN(input) ? undefined : input

    const num = Number(input)
    if (!isNaN(num) && num > 0) return num

    const parsed = Date.parse(input)
    return isNaN(parsed) ? undefined : parsed
}

/**
 * Resolves predefined timeRange into { startMs, endMs }.
 */
export function resolveTimeRange(range?: string): { startMs?: number; endMs?: number } {
    if (!range || range === 'all') return {}

    const now = new Date()
    const nowMs = now.getTime()

    if (range === 'today') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
        return { startMs: start.getTime(), endMs: nowMs }
    }

    if (range === 'yesterday') {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0)
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
        return { startMs: start.getTime(), endMs: end.getTime() }
    }

    if (range === 'this_week') {
        const day = now.getDay()
        const diff = now.getDate() - day + (day === 0 ? -6 : 1)
        const start = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0)
        return { startMs: start.getTime(), endMs: nowMs }
    }

    if (range === 'past_7_days') {
        return { startMs: nowMs - 7 * 86_400_000, endMs: nowMs }
    }

    if (range === 'past_30_days') {
        return { startMs: nowMs - 30 * 86_400_000, endMs: nowMs }
    }

    return {}
}

/**
 * Helper to extract text from a message entry.
 */
function extractTextFromEntry(entry: any): string {
    if (!entry) return ''
    if (typeof entry.text === 'string') return entry.text
    if (typeof entry.content === 'string') return entry.content
    if (Array.isArray(entry.content)) {
        return entry.content
            .map((b: any) => (typeof b === 'string' ? b : b?.text || b?.thinking || ''))
            .join(' ')
    }
    return ''
}

/**
 * Helper to format date in ISO and readable local format.
 */
function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    })
}

/**
 * Helper to resolve the scheduleId associated with the execution context.
 */
export function resolveSessionScheduleId(
    context: unknown,
    options?: SessionToolOptions,
): string | undefined {
    if (context && typeof context === 'object') {
        const ctx = context as Record<string, unknown>
        if (typeof ctx.scheduleId === 'string' && ctx.scheduleId.trim().length > 0) {
            return ctx.scheduleId.trim()
        }
        if (typeof ctx.sessionId === 'string' && ctx.sessionId.trim().length > 0) {
            const sid = ctx.sessionId.trim()
            const services = (ctx.services as HostServices | undefined) ?? options?.services
            if (services?.sessions?.getSnapshot) {
                const session = services.sessions.getSnapshot().find((s) => s.id === sid)
                if (session?.scheduleId) {
                    return session.scheduleId
                }
            }
        }
    }
    return undefined
}

export function createSessionSearchTool(options?: SessionToolOptions): AgentToolContribution {
    return {
        name: SESSION_SEARCH_TOOL_NAME,
        description:
            'Search and retrieve past conversation sessions and message histories with multi-criteria filtering (time range, keyword/content query, session name/title, project, schedule). Enables the agent to inspect, summarize, and synthesize historical work across sessions.',
        targetAgent: 'all',
        requiresScheduledSession: true,
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description:
                        'Keyword or query text to search across session titles, user prompts, assistant replies, and thoughts.',
                },
                title: {
                    type: 'string',
                    description: 'Filter sessions where the title contains this substring.',
                },
                timeRange: {
                    type: 'string',
                    enum: ['today', 'yesterday', 'this_week', 'past_7_days', 'past_30_days', 'all'],
                    description:
                        'Predefined time range for session creation/activity: "today", "yesterday", "this_week", "past_7_days", "past_30_days", "all".',
                },
                createdAfter: {
                    type: 'string',
                    description:
                        'Filter sessions created on or after this date/time (ISO string e.g. "2025-05-01T00:00:00Z" or epoch ms).',
                },
                createdBefore: {
                    type: 'string',
                    description:
                        'Filter sessions created on or before this date/time (ISO string or epoch ms).',
                },
                updatedAfter: {
                    type: 'string',
                    description:
                        'Filter sessions updated on or after this date/time (ISO string or epoch ms).',
                },
                updatedBefore: {
                    type: 'string',
                    description:
                        'Filter sessions updated on or before this date/time (ISO string or epoch ms).',
                },
                projectId: {
                    type: 'string',
                    description: 'Filter sessions belonging to a specific project ID.',
                },
                scheduleId: {
                    type: 'string',
                    description: 'Filter sessions triggered by a specific scheduled task ID.',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of sessions to return (default 10, max 50).',
                },
                includeMessages: {
                    type: 'boolean',
                    description:
                        'Whether to include recent message content and conversation turns for in-depth analysis (default false).',
                },
                sessionId: {
                    type: 'string',
                    description:
                        'Directly retrieve the full conversation history of a specific session by ID.',
                },
            },
        },
        execute: async (args: Record<string, unknown>, context: unknown) => {
            const callingScheduleId = resolveSessionScheduleId(context, options)
            if (!callingScheduleId) {
                return 'Error: session_search is only available in sessions created by scheduled tasks.'
            }

            const params = args as SessionSearchArgs
            const limit = Math.min(Math.max(params.limit ?? 10, 1), 50)
            const ctxServices = ((context as any)?.services as HostServices | undefined) ?? options?.services
            const capClient = ((context as any)?.capabilityClient as PluginCapabilityClient | undefined) ?? options?.capabilityClient

            let projects: readonly Project[] = []
            if (ctxServices?.projects?.getSnapshot) {
                projects = ctxServices.projects.getSnapshot()
            } else if (ctxServices?.projects?.list) {
                projects = await ctxServices.projects.list()
            } else if (capClient && typeof capClient.invoke === 'function') {
                try {
                    const loaded = (await capClient.invoke('projects:list')) as Project[]
                    if (Array.isArray(loaded)) projects = loaded
                } catch {
                    // Ignore
                }
            }
            const projectMap = new Map(projects.map((p) => [p.id, p.name]))

            // 1. Direct single session lookup by sessionId
            if (params.sessionId) {
                const sid = params.sessionId.trim()
                let session: SessionItem | undefined
                let entries: any[] = []

                if (ctxServices?.sessions?.get) {
                    const loaded = (await ctxServices.sessions.get(sid)) as any
                    if (loaded) {
                        session = loaded.title ? loaded : undefined
                        if (Array.isArray(loaded.entries)) {
                            entries = loaded.entries
                        }
                    }
                }

                if (!session && ctxServices?.sessions?.getSnapshot) {
                    session = ctxServices.sessions.getSnapshot().find((s) => s.id === sid)
                }

                if (!session && capClient && typeof capClient.invoke === 'function') {
                    try {
                        const loaded = (await capClient.invoke('session:get', [sid])) as any
                        if (loaded) {
                            session = loaded.title ? loaded : undefined
                            if (Array.isArray(loaded.entries)) {
                                entries = loaded.entries
                            }
                        }
                    } catch {
                        // Ignore
                    }
                }

                if (!session && entries.length === 0) {
                    return `Session "${sid}" was not found.`
                }

                const title = session?.title || 'Untitled Session'
                const projName = session?.projectId ? projectMap.get(session.projectId) || session.projectId : 'None'
                const createdAtStr = session?.createdAt ? formatDate(session.createdAt) : 'Unknown'
                const updatedAtStr = session?.updatedAt ? formatDate(session.updatedAt) : 'Unknown'
                const scheduleIdStr = session?.scheduleId || 'None'
                const parentIdStr = session?.parentSessionId || 'None'

                const turnsSummary = entries.map((entry, idx) => {
                    const role = entry.kind || entry.type || entry.role || 'message'
                    const text = extractTextFromEntry(entry)
                    const time = entry.createdAt ? formatDate(entry.createdAt) : ''
                    return `[Turn ${idx + 1}] (${role}${time ? ` @ ${time}` : ''}):\n${text}`
                })

                return `# Session: ${title} (${sid})
- Project: ${projName}
- Schedule ID: ${scheduleIdStr}
- Parent Session ID: ${parentIdStr}
- Created At: ${createdAtStr}
- Updated At: ${updatedAtStr}
- Total Entries: ${entries.length}

## Conversation Entries:
${turnsSummary.length > 0 ? turnsSummary.join('\n\n') : 'No messages in this session.'}`
            }

            // 2. Multi-condition search across sessions
            let allSessions: SessionItem[] = []
            if (ctxServices?.sessions?.getSnapshot) {
                allSessions = [...ctxServices.sessions.getSnapshot()]
            } else if (ctxServices?.sessions?.list) {
                allSessions = [...(await ctxServices.sessions.list())]
            } else if (capClient && typeof capClient.invoke === 'function') {
                try {
                    const loaded = (await capClient.invoke('session:listSessions')) as SessionItem[]
                    if (Array.isArray(loaded)) {
                        allSessions = loaded
                    }
                } catch {
                    // Ignore
                }
            }

            const { startMs: rangeStart, endMs: rangeEnd } = resolveTimeRange(params.timeRange)
            const createdAfterMs = parseTimestamp(params.createdAfter) ?? rangeStart
            const createdBeforeMs = parseTimestamp(params.createdBefore) ?? rangeEnd
            const updatedAfterMs = parseTimestamp(params.updatedAfter) ?? rangeStart
            const updatedBeforeMs = parseTimestamp(params.updatedBefore) ?? rangeEnd

            const queryLower = params.query?.trim().toLowerCase()
            const titleLower = params.title?.trim().toLowerCase()

            const matchedSessions: Array<{
                session: SessionItem
                matchedSnippet?: string
            }> = []

            for (const session of allSessions) {
                if (params.projectId && session.projectId !== params.projectId) {
                    continue
                }
                if (params.scheduleId && session.scheduleId !== params.scheduleId) {
                    continue
                }
                if (titleLower && !session.title.toLowerCase().includes(titleLower)) {
                    continue
                }
                if (createdAfterMs !== undefined && session.createdAt < createdAfterMs) {
                    continue
                }
                if (createdBeforeMs !== undefined && session.createdAt > createdBeforeMs) {
                    continue
                }
                if (updatedAfterMs !== undefined && session.updatedAt < updatedAfterMs) {
                    continue
                }
                if (updatedBeforeMs !== undefined && session.updatedAt > updatedBeforeMs) {
                    continue
                }

                let snippet: string | undefined
                if (queryLower) {
                    const titleMatch = session.title.toLowerCase().includes(queryLower)
                    if (!titleMatch) {
                        continue
                    }
                    snippet = `Title matched: "${session.title}"`
                }

                matchedSessions.push({ session, matchedSnippet: snippet })
            }

            matchedSessions.sort((a, b) => b.session.updatedAt - a.session.updatedAt)
            const paginated = matchedSessions.slice(0, limit)

            if (paginated.length === 0) {
                return 'No sessions matched the specified search criteria.'
            }

            const header = `Found ${matchedSessions.length} sessions (showing top ${paginated.length}):\n`
            const itemsText = await Promise.all(
                paginated.map(async ({ session, matchedSnippet }, idx) => {
                    const projName = session.projectId ? projectMap.get(session.projectId) || session.projectId : 'None'
                    const createdAtStr = formatDate(session.createdAt)
                    const updatedAtStr = formatDate(session.updatedAt)

                    let snippetText = ''
                    if (matchedSnippet) {
                        snippetText = `\n  - Match: ${matchedSnippet}`
                    }

                    let messagesSummary = ''
                    if (params.includeMessages) {
                        let entries: any[] = []
                        if (ctxServices?.sessions?.get) {
                            try {
                                const loaded = (await ctxServices.sessions.get(session.id)) as any
                                if (loaded && Array.isArray(loaded.entries)) {
                                    entries = loaded.entries
                                }
                            } catch {
                                // Ignore
                            }
                        } else if (capClient && typeof capClient.invoke === 'function') {
                            try {
                                const loaded = (await capClient.invoke('session:get', [session.id])) as any
                                if (loaded && Array.isArray(loaded.entries)) {
                                    entries = loaded.entries
                                }
                            } catch {
                                // Ignore
                            }
                        }
                        const recentEntries = entries.slice(-4)
                        if (recentEntries.length > 0) {
                            messagesSummary =
                                '\n  - Recent turns:\n' +
                                recentEntries
                                    .map((e) => {
                                        const role = e.kind || e.type || e.role || 'turn'
                                        const text = extractTextFromEntry(e)
                                        const shortText = text.length > 120 ? text.slice(0, 120) + '...' : text
                                        return `    * [${role}]: ${shortText}`
                                    })
                                    .join('\n')
                        }
                    }

                    return `${idx + 1}. [${session.id}] "${session.title}"
  - Project: ${projName} | Schedule ID: ${session.scheduleId || 'None'}
  - Created: ${createdAtStr} | Updated: ${updatedAtStr}${snippetText}${messagesSummary}`
                }),
            )

            return header + itemsText.join('\n\n')
        },
    }
}

export function createSessionCreateTool(options?: SessionToolOptions): AgentToolContribution {
    return {
        name: SESSION_CREATE_TOOL_NAME,
        description:
            'Create a new conversation session associated with a project or schedule. Optionally initialize with a prompt and trigger execution. Enables multi-session orchestration, sub-task isolation, and structured workflow pipelining.',
        targetAgent: 'all',
        requiresScheduledSession: true,
        parameters: {
            type: 'object',
            properties: {
                title: {
                    type: 'string',
                    description: 'Title or descriptive summary for the new conversation session.',
                },
                prompt: {
                    type: 'string',
                    description:
                        'Initial user prompt or instruction to populate into the newly created session.',
                },
                projectId: {
                    type: 'string',
                    description:
                        'Project ID to bind this session to. If omitted, uses the current session\'s project.',
                },
                branch: {
                    type: 'string',
                    description:
                        'Git branch name to bind this session to (optional, defaults to current branch or project default).',
                },
                workLocation: {
                    type: 'string',
                    enum: ['local', 'worktree'],
                    description: 'Execution workspace mode: "local" (default) or "worktree".',
                },
                autoRun: {
                    type: 'boolean',
                    description:
                        'Whether to automatically trigger agent execution immediately after creation (default false).',
                },
            },
            required: ['title'],
        },
        execute: async (args: Record<string, unknown>, context: unknown) => {
            const callingScheduleId = resolveSessionScheduleId(context, options)
            if (!callingScheduleId) {
                return 'Error: session_create is only available in sessions created by scheduled tasks.'
            }

            const params = args as unknown as CreateSessionArgs
            const title = (params.title || '').trim()
            if (!title) {
                return 'Error: session title cannot be empty.'
            }

            const ctx = (context || {}) as Record<string, unknown>
            const parentSessionId = typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined

            const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const now = Date.now()

            const sessionItem: SessionItem = {
                id: newSessionId,
                title,
                pinned: false,
                createdAt: now,
                updatedAt: now,
                scheduleId: callingScheduleId,
                parentSessionId,
                projectId: params.projectId,
                branch: params.branch,
                workLocation: params.workLocation,
            }

            const ctxServices = (ctx.services as HostServices | undefined) ?? options?.services
            const capClient = (ctx.capabilityClient as PluginCapabilityClient | undefined) ?? options?.capabilityClient

            if (ctxServices?.sessions?.update) {
                await ctxServices.sessions.update(newSessionId, sessionItem)
            } else if (capClient && typeof capClient.invoke === 'function') {
                await capClient.invoke('session:setMeta', [sessionItem])
            }

            return {
                ok: true,
                sessionId: newSessionId,
                title,
                projectId: params.projectId || null,
                scheduleId: callingScheduleId,
                parentSessionId: parentSessionId || null,
                message: `Session "${title}" (${newSessionId}) created successfully.`,
            }
        },
    }
}
