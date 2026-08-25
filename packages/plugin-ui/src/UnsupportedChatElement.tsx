import React from 'react'
import { cn } from './cn.js'

export interface UnsupportedChatElementProps {
    value?: any
    type?: 'message' | 'part' | string
    className?: string
}

export function UnsupportedChatElement({
    value,
    type = 'part',
    className,
}: UnsupportedChatElementProps) {
    const kind =
        value?.role ??
        value?.kind ??
        value?.type ??
        value?.name ??
        'unknown'

    return (
        <div
            data-testid={`unsupported-${type}`}
            className={cn(
                'my-1 rounded border border-dashed border-[var(--border-subtle)] bg-[var(--bg-card)]/40 px-3 py-2 text-xs text-[var(--text-muted)] select-none',
                className,
            )}
        >
            Unsupported {type}: {String(kind)}
        </div>
    )
}
