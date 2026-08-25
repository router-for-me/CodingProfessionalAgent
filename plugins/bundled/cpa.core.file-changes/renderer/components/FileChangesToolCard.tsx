import { useMemo } from 'react'
import {
    cn,
    FileTypeIcon,
    PluginCard,
    PluginCardBody,
    PluginCardHeader,
    PluginCardTitle,
    useHostServices,
    useTranslation,
} from '@cpa/plugin-ui'

export interface FileChangeItem {
    path: string
    additions?: number
    deletions?: number
    status?: 'modified' | 'added' | 'deleted' | string
}

export interface FileChangesToolCardProps {
    part?: any
    value?: any
}

function parseFileChangesResult(result: unknown): {
    summary?: string
    files: FileChangeItem[]
    totalAdditions: number
    totalDeletions: number
} {
    if (!result) {
        return { files: [], totalAdditions: 0, totalDeletions: 0 }
    }

    if (typeof result === 'object' && result !== null) {
        const resObj = result as Record<string, any>
        const files: FileChangeItem[] = []
        let totalAdditions = Number(resObj.totalAdditions ?? resObj.additions ?? 0)
        let totalDeletions = Number(resObj.totalDeletions ?? resObj.deletions ?? 0)

        if (Array.isArray(resObj.files)) {
            for (const f of resObj.files) {
                if (typeof f === 'string') {
                    files.push({ path: f })
                } else if (typeof f === 'object' && f !== null) {
                    const item: FileChangeItem = {
                        path: f.path || f.filePath || f.filename || 'unknown',
                        additions: f.additions,
                        deletions: f.deletions,
                        status: f.status,
                    }
                    files.push(item)
                    if (!resObj.totalAdditions && item.additions) totalAdditions += item.additions
                    if (!resObj.totalDeletions && item.deletions) totalDeletions += item.deletions
                }
            }
        }

        return {
            summary: typeof resObj.summary === 'string' ? resObj.summary : undefined,
            files,
            totalAdditions,
            totalDeletions,
        }
    }

    if (typeof result === 'string') {
        try {
            const parsed = JSON.parse(result)
            return parseFileChangesResult(parsed)
        } catch {
            return {
                summary: result,
                files: [],
                totalAdditions: 0,
                totalDeletions: 0,
            }
        }
    }

    return { files: [], totalAdditions: 0, totalDeletions: 0 }
}

export function FileChangesToolCard({ part, value }: FileChangesToolCardProps) {
    const data = part ?? value
    const { t } = useTranslation()
    const services = useHostServices()

    const parsed = useMemo(() => parseFileChangesResult(data?.result ?? data?.output), [data])
    const title = data?.name ?? data?.toolName ?? 'file_changes'

    const handleOpenFile = (filePath: string) => {
        if (services?.notifications?.show) {
            services.notifications.show({ message: filePath, type: 'info' })
        }
    }

    return (
        <PluginCard className="w-full">
            <PluginCardHeader className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <PluginCardTitle>
                        {t('fileChanges.changes', { defaultValue: title })}
                    </PluginCardTitle>
                    {parsed.files.length > 0 ? (
                        <span className="text-[11px] text-[var(--text-muted)]">
                            {t('fileChanges.filesChanged', {
                                count: parsed.files.length,
                                defaultValue: `${parsed.files.length} files changed`,
                            })}
                        </span>
                    ) : null}
                </div>

                {(parsed.totalAdditions > 0 || parsed.totalDeletions > 0) && (
                    <div className="flex items-center gap-1.5 font-mono text-[11px]">
                        {parsed.totalAdditions > 0 ? (
                            <span className="text-emerald-500 font-medium">
                                +{parsed.totalAdditions}
                            </span>
                        ) : null}
                        {parsed.totalDeletions > 0 ? (
                            <span className="text-rose-500 font-medium">
                                -{parsed.totalDeletions}
                            </span>
                        ) : null}
                    </div>
                )}
            </PluginCardHeader>

            <PluginCardBody>
                {parsed.files.length > 0 ? (
                    <div className="flex flex-col gap-1">
                        {parsed.files.map((file, idx) => (
                            <div
                                key={idx}
                                onClick={() => handleOpenFile(file.path)}
                                className={cn(
                                    'flex items-center justify-between rounded px-2 py-1 text-[12px]',
                                    'hover:bg-[var(--bg-sidebar-hover)] cursor-pointer transition-colors group',
                                )}
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <FileTypeIcon name={file.path} className="size-3.5 shrink-0" />
                                    <span className="truncate text-[var(--text-primary)] font-mono">
                                        {file.path}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
                                    {file.additions ? (
                                        <span className="text-emerald-500">+{file.additions}</span>
                                    ) : null}
                                    {file.deletions ? (
                                        <span className="text-rose-500">-{file.deletions}</span>
                                    ) : null}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : parsed.summary ? (
                    <div className="text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap font-mono">
                        {parsed.summary}
                    </div>
                ) : (
                    <div className="text-[12px] text-[var(--text-muted)] italic">
                        {t('fileChanges.noChanges', { defaultValue: 'No file changes recorded' })}
                    </div>
                )}
            </PluginCardBody>
        </PluginCard>
    )
}
