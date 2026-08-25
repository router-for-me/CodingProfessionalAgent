import { memo, useState, type KeyboardEvent } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ReactMarkdown,
  type Components,
  cn,
  remarkGfm,
  useTranslation,
} from '@cpa/plugin-ui'

export interface ThinkingBlockProps {
  thinking?: string
  /** When true, default expanded until the user toggles. */
  streaming?: boolean
  /** Force initial open when not streaming (tests / explicit expand). */
  defaultOpen?: boolean
  className?: string
  part?: any
  value?: any
}

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-2 last:mb-0 leading-relaxed text-[var(--text-secondary)]">
      {children}
    </p>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 text-base font-semibold text-[var(--text-secondary)]">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 text-sm font-semibold text-[var(--text-secondary)]">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 text-sm font-semibold text-[var(--text-secondary)]">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0 text-[var(--text-secondary)]">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0 text-[var(--text-secondary)]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ className, children }) => {
    const isBlock = Boolean(className)
    if (isBlock) {
      return (
        <code
          className={cn('font-mono', className)}
          style={{ fontSize: 'var(--code-font-size, 12px)' }}
        >
          {children}
        </code>
      )
    }
    return (
      <code className="rounded bg-[var(--bg-sidebar-hover)] px-1 py-0.5 font-mono text-[0.9em]">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md bg-[#0b0b0b] p-2 last:mb-0"
      style={{ fontSize: 'var(--code-font-size, 12px)' }}
    >
      {children}
    </pre>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>
  ),
}

/**
 * Collapsible assistant thinking block.
 * Streaming defaults to expanded; done defaults to collapsed.
 * User toggle choice is preserved across re-renders.
 */
export const ThinkingBlock = memo(function ThinkingBlock(props: ThinkingBlockProps) {
  const {
    streaming = false,
    defaultOpen,
    className,
  } = props
  const thinking = props.thinking ?? props.part?.thinking ?? props.value?.thinking ?? ''
  const { t } = useTranslation()
  // null = follow default (streaming/defaultOpen); boolean = user override
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  if (!thinking.trim()) {
    return null
  }

  const defaultExpanded = defaultOpen ?? streaming
  const open = userOpen ?? defaultExpanded

  const toggle = () => {
    setUserOpen(!open)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  }

  return (
    <div
      className={cn(
        'my-2 rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
        'bg-[var(--bg-card)]/60',
        className,
      )}
      data-testid="thinking-block"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={t('thinking.toggle')}
        onClick={toggle}
        onKeyDown={onKeyDown}
        data-testid="thinking-toggle"
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
          'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        <span className="font-medium">{t('thinking.label')}</span>
        {streaming ? (
          <span
            className="ml-auto inline-block size-1.5 animate-pulse rounded-full bg-[var(--accent-blue)]"
            data-testid="thinking-pulse"
          />
        ) : null}
      </button>

      {open ? (
        <div
          data-testid="thinking-content"
          className="border-t border-[var(--border-subtle)] px-3 py-2.5 text-xs"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {thinking}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  )
})
