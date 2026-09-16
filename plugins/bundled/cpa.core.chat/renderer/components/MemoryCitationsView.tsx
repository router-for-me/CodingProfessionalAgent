import { memo, useState } from 'react'
import type { MemoryCitation } from '@cpa/plugin-api'
import {
    Brain,
    ChevronDown,
    ChevronRight,
    FileText,
    cn,
    useTranslation,
} from '@cpa/plugin-ui'

export interface MemoryCitationsViewProps {
    citations?: MemoryCitation
    defaultOpen?: boolean
    className?: string
}

/**
 * Collapsible UI component for displaying structured memory file citations.
 */
export const MemoryCitationsView = memo(function MemoryCitationsView({
    citations,
    defaultOpen = false,
    className,
}: MemoryCitationsViewProps) {
    const { t } = useTranslation()
    const [isOpen, setIsOpen] = useState(defaultOpen)

    if (!citations || !citations.entries || citations.entries.length === 0) {
        return null
    }

    const { entries, rolloutIds } = citations

    return (
        <div
            data-testid="memory-citations-view"
            className={cn(
                'my-2 flex flex-col rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 text-[12px]',
                className,
            )}
        >
            <button
                type="button"
                data-testid="memory-citations-toggle"
                onClick={() => setIsOpen((prev) => !prev)}
                className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors',
                    'hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-blue)]/40',
                    isOpen ? 'rounded-t-[var(--radius-card)]' : 'rounded-[var(--radius-card)]',
                )}
                aria-expanded={isOpen}
            >
                <div className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <Brain className="size-3.5 shrink-0 text-[var(--accent-blue)]" />
                    <span className="font-medium text-[var(--text-primary)]">
                        {t('message.memoryCitations', { count: entries.length })}
                    </span>
                </div>
                {isOpen ? (
                    <ChevronDown className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-[var(--text-muted)]" />
                )}
            </button>

            {isOpen && (
                <div
                    data-testid="memory-citations-list"
                    className="flex flex-col gap-2 border-t border-[var(--border-subtle)] px-3 py-2 text-[11px]"
                >
                    <div className="flex flex-col gap-1.5">
                        {entries.map((entry, idx) => (
                            <div
                                key={`${entry.file}-${entry.lineRange ?? idx}`}
                                className="flex flex-col rounded px-1.5 py-1 transition-colors hover:bg-[var(--bg-app)]/50"
                            >
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <FileText className="size-3 shrink-0 text-[var(--text-muted)]" />
                                    <span className="font-mono font-medium text-[var(--text-primary)] [overflow-wrap:anywhere]">
                                        {entry.file}
                                    </span>
                                    {entry.lineRange && (
                                        <span className="rounded border border-[var(--border-subtle)] bg-[var(--bg-app)] px-1 py-0.5 text-[10px] text-[var(--text-muted)]">
                                            {t('message.memoryCitationLine', { range: entry.lineRange })}
                                        </span>
                                    )}
                                </div>
                                {entry.note && (
                                    <div className="mt-0.5 pl-4 text-[var(--text-secondary)] italic">
                                        {entry.note}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>

                    {rolloutIds && rolloutIds.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-1 border-t border-[var(--border-subtle)]/60 pt-1.5 text-[10px] text-[var(--text-muted)]">
                            <span className="font-medium">{t('message.memoryCitationRollout')}:</span>
                            {rolloutIds.map((id) => (
                                <code
                                    key={id}
                                    className="rounded bg-[var(--bg-app)] px-1 py-0.5 font-mono text-[9px] text-[var(--text-secondary)]"
                                >
                                    {id}
                                </code>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
})
