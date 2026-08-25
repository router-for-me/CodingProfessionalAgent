import { useEffect, useMemo, useState } from 'react'
import {
    CustomSelect,
    cn,
    useHostService,
    useProjects,
    useSessions,
    useTranslation,
    Folder,
    ListFilter,
    Search,
    Trash2,
} from '@cpa/plugin-ui'
import { SessionServiceToken, type SessionItem } from '@cpa/plugin-api'

const ALL_PROJECTS = '__all__'
const UNCATEGORIZED = '__uncategorized__'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID_PREFIX_REGEX = /^id_\w+_\w+$/

function resolveProjectName(
    projectId: string | undefined,
    projectNames: Map<string, string>,
    fallbackUncategorized: string,
    fallbackUnknown: string,
): string {
    if (!projectId) return fallbackUncategorized
    const knownName = projectNames.get(projectId)
    if (knownName) return knownName
    if (UUID_REGEX.test(projectId) || ID_PREFIX_REGEX.test(projectId)) {
        return fallbackUnknown
    }
    return projectId
}

interface ArchivedGroup {
    id: string
    name: string
    sessions: SessionItem[]
}

/** Archived chat management: search, filter, restore, and permanent deletion. */
export function ArchivedChatsSection() {
    const { t, i18n } = useTranslation()
    const sessionService = useHostService(SessionServiceToken)
    const sessions = useSessions()
    const projects = useProjects()

    const [query, setQuery] = useState('')
    const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS)

    const archivedSessions = useMemo(
        () => sessions.filter((session) => session.archivedAt !== undefined),
        [sessions],
    )

    const projectNames = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    )

    const projectOptions = useMemo(() => {
        const options = new Map<string, string>()
        for (const session of archivedSessions) {
            const id = session.projectId ?? UNCATEGORIZED
            const name = resolveProjectName(
                session.projectId,
                projectNames,
                t('settings.archived.uncategorized'),
                t('project.unknownProject', 'Unknown project'),
            )
            options.set(id, name)
        }
        return [...options.entries()].sort((a, b) =>
            a[1].localeCompare(b[1], i18n.resolvedLanguage),
        )
    }, [archivedSessions, i18n.resolvedLanguage, projectNames, t])

    useEffect(() => {
        if (
            projectFilter !== ALL_PROJECTS &&
            !projectOptions.some(([id]: [string, string]) => id === projectFilter)
        ) {
            setProjectFilter(ALL_PROJECTS)
        }
    }, [projectFilter, projectOptions])

    const groups = useMemo(() => {
        const normalizedQuery = query.trim().toLocaleLowerCase(
            i18n.resolvedLanguage,
        )
        const grouped = new Map<string, ArchivedGroup>()

        for (const session of archivedSessions) {
            const groupId = session.projectId ?? UNCATEGORIZED
            const groupName = resolveProjectName(
                session.projectId,
                projectNames,
                t('settings.archived.uncategorized'),
                t('project.unknownProject', 'Unknown project'),
            )
            if (projectFilter !== ALL_PROJECTS && projectFilter !== groupId) continue
            if (
                normalizedQuery &&
                !session.title
                    .toLocaleLowerCase(i18n.resolvedLanguage)
                    .includes(normalizedQuery) &&
                !groupName
                    .toLocaleLowerCase(i18n.resolvedLanguage)
                    .includes(normalizedQuery)
            ) {
                continue
            }

            const group = grouped.get(groupId) ?? {
                id: groupId,
                name: groupName,
                sessions: [],
            }
            group.sessions.push(session)
            grouped.set(groupId, group)
        }

        return [...grouped.values()]
            .map((group) => ({
                ...group,
                sessions: [...group.sessions].sort(
                    (a, b) => b.updatedAt - a.updatedAt,
                ),
            }))
            .sort((a, b) =>
                a.name.localeCompare(b.name, i18n.resolvedLanguage),
            )
    }, [
        archivedSessions,
        i18n.resolvedLanguage,
        projectFilter,
        projectNames,
        query,
        t,
    ])

    const handleUnarchive = (sessionId: string) => {
        if (sessionService) {
            void sessionService.update(sessionId, { archivedAt: undefined })
        }
    }

    const handleDelete = (sessionId: string) => {
        if (sessionService?.delete) {
            void sessionService.delete(sessionId)
        }
    }

    const handleDeleteAll = () => {
        for (const session of archivedSessions) {
            if (sessionService?.delete) {
                void sessionService.delete(session.id)
            }
        }
    }

    return (
        <div className="mx-auto w-full max-w-[760px] px-8 pt-8 pb-12">
            <div className="flex items-center justify-between gap-4">
                <h1 className="text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">
                    {t('settings.nav.archivedChats')}
                </h1>
                <button
                    type="button"
                    disabled={archivedSessions.length === 0}
                    className="flex items-center gap-1.5 rounded-lg bg-red-500/15 px-3 py-1.5 text-[13px] font-medium text-red-400 transition-colors hover:bg-red-500/25 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={handleDeleteAll}
                >
                    <Trash2 className="size-3.5" aria-hidden />
                    {t('settings.archived.deleteAll')}
                </button>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(220px,1fr)_150px_180px]">
                <label className="relative block">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--text-muted)]"
                        aria-hidden
                    />
                    <input
                        type="search"
                        value={query}
                        placeholder={t('settings.archived.search')}
                        aria-label={t('settings.archived.search')}
                        className="h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] pl-9 pr-3 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/30"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>

                <SelectField
                    icon={ListFilter}
                    ariaLabel={t('settings.archived.chatFilter')}
                    value="all"
                    options={[
                        { value: 'all', label: t('settings.archived.allChats') },
                    ]}
                    onChange={() => undefined}
                />

                <SelectField
                    icon={Folder}
                    ariaLabel={t('settings.archived.projectFilter')}
                    value={projectFilter}
                    options={[
                        {
                            value: ALL_PROJECTS,
                            label: t('settings.archived.allProjects'),
                        },
                        ...projectOptions.map(([value, label]: [string, string]) => ({ value, label })),
                    ]}
                    onChange={setProjectFilter}
                />
            </div>

            <div className="mt-8 space-y-7">
                {groups.map((group: ArchivedGroup) => (
                    <section key={group.id} aria-label={group.name}>
                        <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                            <Folder className="size-3.5 text-[var(--text-secondary)]" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{group.name}</span>
                            <span className="font-normal text-[var(--text-muted)]">
                                {t('settings.archived.chatCount', {
                                    count: group.sessions.length,
                                })}
                            </span>
                        </div>

                        <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4">
                            {group.sessions.map((session: SessionItem, index: number) => (
                                <div
                                    key={session.id}
                                    className={cn(
                                        'flex min-h-[62px] items-center gap-4 py-2.5',
                                        index > 0 && 'border-t border-[var(--border-subtle)]',
                                    )}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                                            {session.title}
                                        </div>
                                        <div className="mt-1 text-[12px] text-[var(--text-muted)]">
                                            {formatSessionDate(
                                                session.updatedAt,
                                                i18n.resolvedLanguage,
                                            )}
                                        </div>
                                    </div>

                                    <button
                                        type="button"
                                        aria-label={t('settings.archived.deleteChat', {
                                            title: session.title,
                                        })}
                                        title={t('settings.archived.delete')}
                                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                                        onClick={() => handleDelete(session.id)}
                                    >
                                        <Trash2 className="size-3.5" aria-hidden />
                                    </button>
                                    <button
                                        type="button"
                                        className="shrink-0 rounded-lg bg-[var(--bg-sidebar-hover)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--border-subtle)]"
                                        onClick={() => handleUnarchive(session.id)}
                                    >
                                        {t('settings.archived.unarchive')}
                                    </button>
                                </div>
                            ))}
                        </div>
                    </section>
                ))}

                {groups.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--border-subtle)] px-6 py-14 text-center text-[13px] text-[var(--text-muted)]">
                        {archivedSessions.length === 0
                            ? t('settings.archived.empty')
                            : t('settings.archived.noResults')}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

function SelectField({
    icon,
    ariaLabel,
    value,
    options,
    onChange,
}: {
    icon: typeof Folder
    ariaLabel: string
    value: string
    options: Array<{ value: string; label: string }>
    onChange: (value: string) => void
}) {
    return (
        <CustomSelect
            icon={icon}
            ariaLabel={ariaLabel}
            value={value}
            options={options}
            onChange={onChange}
            fullWidth
            triggerClassName="h-9 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 text-[13px] font-medium text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/30"
        />
    )
}

function formatSessionDate(timestamp: number, locale?: string): string {
    return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(timestamp)
}

export default ArchivedChatsSection
