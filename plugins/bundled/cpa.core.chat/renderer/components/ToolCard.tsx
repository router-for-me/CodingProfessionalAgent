import { memo, useMemo, useState } from 'react'
import { Terminal, cn, useTranslation } from '@cpa/plugin-ui'
import type {
  ToolCardDetails,
  ToolCardImage,
  ToolCardPart,
  ToolCardStatus,
} from '../types.js'
import { toolDisplayName } from '../utils/toolActivity.js'

export type { ToolCardDetails, ToolCardImage, ToolCardPart, ToolCardStatus }

export interface ToolCardProps {
  part?: ToolCardPart
  value?: ToolCardPart
  /** Live status from Task18 events; overrides projection status. */
  statusOverride?: ToolCardStatus
  /** Streaming bash/tool partial output (tail). */
  partialOutput?: string
  details?: ToolCardDetails
  resultImages?: readonly ToolCardImage[]
  onApprove?: (toolId: string) => void
  onReject?: (toolId: string) => void
  onApproveTool?: (toolId: string) => void
  onRejectTool?: (toolId: string) => void
  toolOverlays?: Readonly<Record<string, any>>
  className?: string
  /** Collapse long args/result beyond this char count. */
  collapseThreshold?: number
  [key: string]: any
}

const STATUS_KEY: Record<ToolCardStatus, string> = {
  queued: 'tool.queued',
  running: 'tool.running',
  awaiting_approval: 'tool.awaitingApproval',
  done: 'tool.done',
  error: 'tool.error',
  rejected: 'tool.rejected',
  aborted: 'tool.aborted',
}

const DEFAULT_COLLAPSE = 240

function normalizeToolCallId(id?: string): string {
  if (!id) return ''
  return id.split('|', 1)[0] ?? id
}

function findOverlay(toolOverlays?: Readonly<Record<string, any>>, id?: string): any {
  if (!toolOverlays || !id) return undefined
  const normalized = normalizeToolCallId(id)
  return (
    toolOverlays[id] ??
    toolOverlays[normalized] ??
    toolOverlays[`call_${normalized}`] ??
    Object.values(toolOverlays).find((o: any) => normalizeToolCallId(o.toolCallId || '') === normalized)
  )
}

function mergeResultImages(
  canonical?: readonly ToolCardImage[],
  overlay?: readonly ToolCardImage[],
): readonly ToolCardImage[] | undefined {
  if (overlay && overlay.length > 0) return overlay
  if (canonical && canonical.length > 0) return canonical
  return undefined
}

/**
 * Card for a tool_call display part: status, args, result, optional live overlays.
 * Never renders tool results as a separate chat bubble (caller responsibility).
 */
export const ToolCard = memo(function ToolCard(props: ToolCardProps) {
  const part = (props.part ?? props.value ?? {}) as ToolCardPart
  const overlay = findOverlay(props.toolOverlays, part.id)
  const onApprove = props.onApprove ?? props.onApproveTool ?? (() => {})
  const onReject = props.onReject ?? props.onRejectTool ?? (() => {})
  const status = (props.statusOverride ?? overlay?.status ?? part.status ?? 'running') as ToolCardStatus
  const partialOutput = props.partialOutput ?? overlay?.partialOutput
  const details = props.details ?? overlay?.details ?? (part as any)?.details
  const resultImages = mergeResultImages(props.resultImages ?? (part as any)?.resultImages, overlay?.resultImages)
  const className = props.className
  const collapseThreshold = props.collapseThreshold ?? DEFAULT_COLLAPSE

  const { t } = useTranslation()
  const awaiting = status === 'awaiting_approval'
  const [argsExpanded, setArgsExpanded] = useState(false)
  const [resultExpanded, setResultExpanded] = useState(false)

  const argsText = useMemo(() => safeJson(part.args), [part.args])
  const resultText = part.result ?? ''
  const diffText = details?.diff ?? details?.patch ?? ''
  // Only render image/* mime types as data URLs; never invent previews for others.
  const visibleResultImages = useMemo(
    () =>
      (resultImages ?? []).filter((image) =>
        isRenderImageMime(image.mimeType),
      ),
    [resultImages],
  )
  const needsArgsCollapse = argsText.length > collapseThreshold
  const needsResultCollapse = resultText.length > collapseThreshold

  const shownArgs =
    needsArgsCollapse && !argsExpanded
      ? `${argsText.slice(0, collapseThreshold)}…`
      : argsText
  const shownResult =
    needsResultCollapse && !resultExpanded
      ? `${resultText.slice(0, collapseThreshold)}…`
      : resultText

  return (
    <div
      className={cn(
        'rounded-[var(--radius-card)] border border-[var(--border-subtle)]',
        'bg-[var(--bg-card)] px-3 py-2.5',
        className,
      )}
      data-tool-status={status}
      data-testid="tool-status"
    >
      <div className="flex items-center gap-2">
        <Terminal
          className="size-3.5 shrink-0 text-[var(--accent-blue)]"
          aria-hidden
        />
        <span className="truncate text-[13px] text-[var(--text-primary)]">
          {toolDisplayName(part.name ?? '', t)}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px]',
            statusTone(status),
          )}
        >
          {t(STATUS_KEY[status] ?? 'tool.running')}
        </span>
      </div>

      <pre
        data-testid="tool-args"
        className={cn(
          'mt-2 max-h-40 overflow-auto rounded-md border border-[var(--border-subtle)]',
          'bg-[var(--bg-elevated)] p-2 font-mono text-[11px] leading-relaxed',
          'text-[var(--text-secondary)] whitespace-pre-wrap break-all',
        )}
      >
        {shownArgs}
      </pre>
      {needsArgsCollapse ? (
        <button
          type="button"
          className="mt-1 text-[11px] text-[var(--accent-blue)] hover:underline"
          onClick={() => setArgsExpanded((value) => !value)}
        >
          {argsExpanded ? t('tool.collapse') : t('tool.expand')}
        </button>
      ) : null}

      {partialOutput ? (
        <pre
          data-testid="tool-partial-output"
          className={cn(
            'mt-2 max-h-40 overflow-auto rounded-md border border-[var(--border-subtle)]',
            'bg-[#0b0b0b] p-2 font-mono leading-relaxed',
            'text-[var(--text-primary)] whitespace-pre-wrap break-all',
          )}
          style={{ fontSize: 'var(--code-font-size, 12px)' }}
        >
          {partialOutput}
        </pre>
      ) : null}

      {diffText ? (
        <pre
          data-testid="tool-diff"
          className={cn(
            'mt-2 max-h-56 overflow-auto rounded-md border border-[var(--border-subtle)]',
            'bg-[#0b0b0b] p-2 font-mono leading-relaxed',
            'text-[var(--text-primary)] whitespace-pre',
          )}
          style={{ fontSize: 'var(--code-font-size, 12px)' }}
        >
          {diffText}
        </pre>
      ) : null}

      {visibleResultImages.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="tool-result-images">
          {visibleResultImages.map((image, index) => (
            <img
              key={`${part.id}-img-${index}`}
              src={toDataUrl(image.mimeType, image.data)}
              alt={image.alt ?? part.name}
              className="max-h-40 max-w-full rounded-md border border-[var(--border-subtle)] object-contain"
            />
          ))}
        </div>
      ) : null}

      {resultText ? (
        <>
          <pre
            data-testid="tool-result"
            className={cn(
              'mt-2 max-h-48 overflow-auto rounded-md border border-[var(--border-subtle)]',
              'bg-[#0b0b0b] p-2 font-mono leading-relaxed',
              'text-[var(--text-primary)] whitespace-pre-wrap break-all',
              part.isError || status === 'error'
                ? 'text-[var(--accent-orange)]'
                : null,
            )}
            style={{ fontSize: 'var(--code-font-size, 12px)' }}
          >
            {shownResult}
          </pre>
          {needsResultCollapse ? (
            <button
              type="button"
              className="mt-1 text-[11px] text-[var(--accent-blue)] hover:underline"
              onClick={() => setResultExpanded((value) => !value)}
            >
              {resultExpanded ? t('tool.collapse') : t('tool.expand')}
            </button>
          ) : null}
        </>
      ) : null}

      {awaiting ? (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onApprove(part.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium',
              'bg-[var(--accent-green)]/15 text-[var(--accent-green)]',
              'hover:bg-[var(--accent-green)]/25',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
            )}
          >
            {t('tool.approve')}
          </button>
          <button
            type="button"
            onClick={() => onReject(part.id)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium',
              'bg-[var(--bg-sidebar-hover)] text-[var(--text-secondary)]',
              'hover:text-[var(--text-primary)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
            )}
          >
            {t('tool.reject')}
          </button>
        </div>
      ) : null}
    </div>
  )
})

function statusTone(status: ToolCardStatus): string {
  switch (status) {
    case 'queued':
      return 'bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]'
    case 'running':
      return 'bg-[var(--accent-blue)]/15 text-[var(--accent-blue)]'
    case 'awaiting_approval':
      return 'bg-[var(--accent-orange)]/15 text-[var(--accent-orange)]'
    case 'done':
      return 'bg-[var(--accent-green)]/15 text-[var(--accent-green)]'
    case 'error':
      return 'bg-[var(--accent-orange)]/15 text-[var(--accent-orange)]'
    case 'rejected':
      return 'bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]'
    case 'aborted':
      return 'bg-[var(--bg-sidebar-hover)] text-[var(--text-muted)]'
    default:
      return 'text-[var(--text-muted)]'
  }
}

/** Cycle- and BigInt-safe JSON stringify for tool args display. */
export function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === 'bigint') {
          return current.toString()
        }
        if (typeof current === 'object' && current !== null) {
          if (seen.has(current as object)) {
            return '[Circular]'
          }
          seen.add(current as object)
        }
        return current
      },
      2,
    )
  } catch {
    return String(value)
  }
}

function isRenderImageMime(mimeType: string): boolean {
  return /^image\/(png|jpeg|webp|gif|svg\+xml)$/i.test(mimeType)
}

function toDataUrl(mimeType: string, data: string): string {
  if (data.startsWith('data:')) return data
  return `data:${mimeType};base64,${data}`
}
