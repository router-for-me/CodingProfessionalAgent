import { FileText, SquareTerminal } from 'lucide-react'
import { cn } from './cn.js'

export interface FileTypeIconProps {
    name: string
    className?: string
}

/**
 * File icon component providing neutral syntax/file-type indicators.
 */
export function FileTypeIcon({ name, className }: FileTypeIconProps) {
    const lower = (name || '').toLowerCase()

    if (
        lower === 'dockerfile' ||
        lower.startsWith('docker-compose') ||
        lower === '.dockerignore'
    ) {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#38bdf8]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M13 3h2v2h-2zm-3 0h2v2h-2zm-3 3h2v2H7zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zm-9 3h2v2H4zm3 0h2v2H7zm3 0h2v2h-2zm3 0h2v2h-2zm3 0h2v2h-2zm-15 4c.2 4.5 4.1 8 9 8 5.6 0 10.3-4.5 11-10.1-.8-.4-2-.5-3-.3-.4-1.2-1.3-2.1-2.5-2.6L16 11H2c0 .7 0 1.3.1 2z" />
            </svg>
        )
    }

    if (lower === '.gitignore' || lower === '.gitmodules') {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#f97316]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M19 13.5a2.5 2.5 0 0 0-2.3 1.5H12a2.5 2.5 0 0 0-2-1V9.3a2.5 2.5 0 1 0-2 0v5.4a2.5 2.5 0 1 0 2 0v-2.2a2.5 2.5 0 0 0 1-.5h5.7a2.5 2.5 0 1 0 2.3 1.5z" />
            </svg>
        )
    }

    if (lower === 'claude.md') {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#ea580c]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M12 2l2.4 6.6L21 11l-5.6 4.4L17 22l-5-4-5 4 1.6-6.6L3 11l6.6-2.4z" />
            </svg>
        )
    }

    if (lower === 'gemini.md') {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#38bdf8]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M12 2C12 7.5 7.5 12 2 12c5.5 0 10 4.5 10 10 0-5.5 4.5-10 10-10-5.5 0-10-4.5-10-10z" />
            </svg>
        )
    }

    if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#22c55e]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M20.5 3h-17A1.5 1.5 0 0 0 2 4.5v15A1.5 1.5 0 0 0 3.5 21h17a1.5 1.5 0 0 0 1.5-1.5v-15A1.5 1.5 0 0 0 20.5 3zM6.5 16V8.5L9 11.5 11.5 8.5V16h-1.5v-4L9 13.5 7.9 12v4H6.5zm11 0l-3-4h2V8h2v4h2l-3 4z" />
            </svg>
        )
    }

    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        return (
            <svg
                viewBox="0 0 24 24"
                className={cn('size-3.5 shrink-0 text-[#f87171]', className)}
                fill="currentColor"
                aria-hidden
            >
                <path d="M4 3h16v18H4z" opacity="0.2" />
                <path d="M7 6l3 5v5h2v-5l3-5h-2.3L11 8.8 9.3 6H7z" fill="#f87171" />
            </svg>
        )
    }

    if (lower.endsWith('.go') || lower === 'go.mod' || lower === 'go.sum') {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#00add8]',
                    className,
                )}
            >
                GO
            </span>
        )
    }

    if (lower.endsWith('.rs')) {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#dea584]',
                    className,
                )}
            >
                RS
            </span>
        )
    }

    if (lower.endsWith('.py') || lower.endsWith('.pyw')) {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#38bdf8]',
                    className,
                )}
            >
                PY
            </span>
        )
    }

    if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) {
        return <SquareTerminal className={cn('size-3.5 shrink-0 text-[#34d399]', className)} />
    }

    if (lower.endsWith('.ps1')) {
        return <SquareTerminal className={cn('size-3.5 shrink-0 text-[#60a5fa]', className)} />
    }

    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#60a5fa]',
                    className,
                )}
            >
                TS
            </span>
        )
    }

    if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#facc15]',
                    className,
                )}
            >
                JS
            </span>
        )
    }

    if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
        return (
            <span
                className={cn(
                    'inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[9px] font-bold text-[#fbbf24]',
                    className,
                )}
            >
                &#123;&#125;
            </span>
        )
    }

    if (lower.startsWith('.env') || lower.endsWith('.conf') || lower.endsWith('.ini')) {
        return <FileText className={cn('size-3.5 shrink-0 text-[#a1a1aa]', className)} />
    }

    return <FileText className={cn('size-3.5 shrink-0 text-[#9ca3af]', className)} />
}
