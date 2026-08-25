import type { ComponentType, CSSProperties } from 'react'
import { Bug, RefreshCw, Telescope, Wrench, cn, useTranslation } from '@cpa/plugin-ui'
import type { QuickActionKind } from '../utils/templates.js'

export interface QuickActionCardsProps {
    onSelect: (kind: QuickActionKind) => void
    className?: string
}

interface CardDef {
    kind: QuickActionKind
    labelKey: string
    icon: ComponentType<{ className?: string; style?: CSSProperties }>
    accentVar: string
}

const CARDS: CardDef[] = [
    {
        kind: 'explore',
        labelKey: 'home.card.explore',
        icon: Telescope,
        accentVar: 'var(--accent-blue)',
    },
    {
        kind: 'build',
        labelKey: 'home.card.build',
        icon: Wrench,
        accentVar: 'var(--accent-purple)',
    },
    {
        kind: 'review',
        labelKey: 'home.card.review',
        icon: RefreshCw,
        accentVar: 'var(--accent-green)',
    },
    {
        kind: 'fix',
        labelKey: 'home.card.fix',
        icon: Bug,
        accentVar: 'var(--accent-orange)',
    },
]

/**
 * Four quick-start cards for the home empty state.
 * Accent colors use design-token CSS variables.
 */
export function QuickActionCards({
    onSelect,
    className,
}: QuickActionCardsProps) {
    const { t } = useTranslation()

    return (
        <div
            className={cn('grid w-full grid-cols-2 gap-3 sm:grid-cols-4', className)}
            role="list"
        >
            {CARDS.map((card) => {
                const Icon = card.icon
                return (
                    <button
                        key={card.kind}
                        type="button"
                        role="listitem"
                        onClick={() => onSelect(card.kind)}
                        className={cn(
                            'flex min-h-[112px] flex-col items-start gap-3.5 rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
                            'bg-[var(--bg-card)] px-4 py-4 text-left transition-colors',
                            'hover:border-[var(--border-subtle)] hover:bg-[var(--bg-sidebar-hover)] focus-visible:outline-none',
                            'focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40 cursor-pointer',
                        )}
                    >
                        <Icon
                            className="size-4 shrink-0"
                            style={{ color: card.accentVar }}
                            aria-hidden
                        />
                        <span className="text-[13px] leading-snug text-[var(--text-primary)]">
                            {t(card.labelKey)}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
