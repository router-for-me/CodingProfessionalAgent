import { type ReactNode } from 'react'
import { cn } from './cn.js'

export function SettingsRow({
    id,
    title,
    description,
    control,
    last = false,
}: {
    id?: string
    title: string
    description?: ReactNode
    control: ReactNode
    last?: boolean
}) {
    return (
        <div
            id={id}
            data-setting-id={id}
            className={cn(
                'flex items-start gap-4 px-3.5 py-3 transition-colors duration-300',
                !last && 'border-b border-[var(--border-subtle)]',
            )}
        >
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-primary)] font-[inherit]">
                    {title}
                </div>
                {description ? (
                    <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-muted)] font-[inherit]">
                        {description}
                    </div>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center pt-0.5">{control}</div>
        </div>
    )
}

export function SettingsCard({ children }: { children: ReactNode }) {
    return (
        <div className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)]">
            {children}
        </div>
    )
}

export function SettingsSection({
    id,
    title,
    children,
}: {
    id?: string
    title: string
    children: ReactNode
}) {
    return (
        <section id={id} data-setting-id={id} className="space-y-2">
            <h3 className="px-0.5 text-[12px] font-medium text-[var(--text-secondary)] font-[inherit]">
                {title}
            </h3>
            {children}
        </section>
    )
}
