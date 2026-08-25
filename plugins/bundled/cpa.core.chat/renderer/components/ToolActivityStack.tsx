import { memo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePenLine,
  FilePlus,
  FileText,
  HelpCircle,
  Wrench,
  cn,
  useTranslation,
} from '@cpa/plugin-ui'
import type { DisplayMessagePart, ToolLiveOverlay } from '../types.js'
import { ToolCard, type ToolCardDetails, type ToolCardImage } from './ToolCard.js'
import {
  isToolRunning,
  normalizeToolCallId,
  summarizeToolActivity,
  type TFunction,
  type ToolActivityKind,
  type ToolActivityPart,
} from '../utils/toolActivity.js'

type ToolCallPart = Extract<DisplayMessagePart, { type: 'tool_call' }>

export interface ToolActivityStackProps {
  parts: readonly ToolCallPart[]
  onApproveTool: (toolId: string) => void
  onRejectTool: (toolId: string) => void
  toolOverlays?: Readonly<Record<string, ToolLiveOverlay>>
  /** Whether the parent assistant turn is actively streaming / using tools. */
  streaming?: boolean
  className?: string
}

/**
 * Fold consecutive tool calls into one summary line.
 * Click the line to expand a tree of historical summaries; click a leaf
 * for the original ToolCard details.
 */
export const ToolActivityStack = memo(function ToolActivityStack({
  parts,
  onApproveTool,
  onRejectTool,
  toolOverlays,
  streaming = false,
  className,
}: ToolActivityStackProps) {
  const { t } = useTranslation()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  if (parts.length === 0) return null

  const latest = parts[parts.length - 1]
  if (!latest) return null
  const canExpandHistory = parts.length > 1
  const header = stackHeader(parts, toolOverlays, t)

  const isStackActive =
    streaming ||
    header.running ||
    parts.some((part) => {
      const overlay = toolOverlays?.[normalizeToolCallId(part.id)]
      const status = resolveToolStatus(part.status, overlay?.status)
      return isToolRunning(status)
    })

  const awaiting = parts.filter((part) => {
    const overlay = toolOverlays?.[normalizeToolCallId(part.id)]
    const status = resolveToolStatus(part.status, overlay?.status)
    return status === 'awaiting_approval'
  })

  const toggleDetail = (id: string) => {
    setDetailId((current) => (current === id ? null : id))
  }

  return (
    <div
      className={cn('group/tool my-2 first:mt-0', className)}
      data-testid="tool-activity"
    >
      {canExpandHistory ? (
        <button
          type="button"
          data-testid="tool-activity-expand"
          aria-expanded={historyOpen}
          aria-label={
            historyOpen ? t('turn.collapseHistory') : t('turn.expandHistory')
          }
          onClick={() => setHistoryOpen((open) => !open)}
          className={cn(
            'flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left',
            'text-[13px] text-[var(--text-muted)]',
            'hover:text-[var(--text-secondary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
          )}
        >
          {historyOpen ? (
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          )}
          <ActivityIcon kind={header.kind} />
          <span
            className={cn(
              'min-w-0 truncate',
              isStackActive && 'animate-text-shimmer',
            )}
            data-testid="tool-activity-latest"
          >
            {header.text}
          </span>
        </button>
      ) : (
        <button
          type="button"
          data-testid="tool-activity-summary"
          aria-expanded={detailId === latest.id}
          aria-label={
            detailId === latest.id
              ? t('turn.collapseDetails')
              : t('turn.expandDetails')
          }
          onClick={() => toggleDetail(latest.id)}
          className={cn(
            'flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left',
            'text-[13px] text-[var(--text-muted)]',
            'hover:text-[var(--text-secondary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
          )}
        >
          <ActivityIcon kind={header.kind} />
          <span
            className={cn(
              'min-w-0 truncate',
              isStackActive && 'animate-text-shimmer',
            )}
            data-testid="tool-activity-latest"
          >
            {header.text}
          </span>
        </button>
      )}

      {!canExpandHistory && detailId === latest.id ? (
        <ToolDetails
          part={latest}
          overlay={toolOverlays?.[normalizeToolCallId(latest.id)]}
          onApproveTool={onApproveTool}
          onRejectTool={onRejectTool}
        />
      ) : null}

      {historyOpen ? (
        <div
          className="ml-2 mt-1 border-l border-[var(--border-subtle)] pl-3"
          data-testid="tool-activity-history"
        >
          {parts.map((part, index) => {
            const overlay = toolOverlays?.[normalizeToolCallId(part.id)]
            const status = resolveToolStatus(part.status, overlay?.status)
            const summary = summarizeToolActivity(
              toActivityPart(part, status),
              t,
            )
            const open = detailId === part.id
            const isLastPart = index === parts.length - 1
            const shouldShimmer =
              (isLastPart && isStackActive) || summary.running
            return (
              <div key={part.id}>
                <button
                  type="button"
                  data-testid="tool-activity-summary"
                  onClick={() => toggleDetail(part.id)}
                  className={cn(
                    'flex w-fit max-w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left',
                    'text-[13px] text-[var(--text-muted)]',
                    'hover:text-[var(--text-secondary)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)]/40',
                  )}
                >
                  <ActivityIcon kind={summary.kind} />
                  <span
                    className={cn(
                      'min-w-0 truncate',
                      shouldShimmer && 'animate-text-shimmer',
                    )}
                  >
                    {summary.text}
                  </span>
                </button>
                {open ? (
                  <ToolDetails
                    part={part}
                    overlay={overlay}
                    onApproveTool={onApproveTool}
                    onRejectTool={onRejectTool}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {awaiting.map((part) => {
        if (detailId === part.id) return null
        const overlay = toolOverlays?.[normalizeToolCallId(part.id)]
        return (
          <ToolCard
            key={`approve-${part.id}`}
            part={{
              type: 'tool_call',
              id: part.id,
              name: part.name,
              args: part.args,
              status: part.status,
              result: part.result,
              isError: part.isError,
            }}
            statusOverride={resolveToolStatus(part.status, overlay?.status)}
            onApprove={onApproveTool}
            onReject={onRejectTool}
            className="mt-2"
          />
        )
      })}
    </div>
  )
})

function ToolDetails({
  part,
  overlay,
  onApproveTool,
  onRejectTool,
}: {
  part: ToolCallPart
  overlay?: ToolLiveOverlay
  onApproveTool: (toolId: string) => void
  onRejectTool: (toolId: string) => void
}) {
  return (
    <ToolCard
      part={{
        type: 'tool_call',
        id: part.id,
        name: part.name,
        args: part.args,
        status: part.status,
        result: part.result,
        isError: part.isError,
      }}
      statusOverride={resolveToolStatus(part.status, overlay?.status)}
      partialOutput={overlay?.partialOutput}
      details={overlay?.details as ToolCardDetails | undefined}
      resultImages={overlay?.resultImages as readonly ToolCardImage[] | undefined}
      onApprove={onApproveTool}
      onReject={onRejectTool}
      className="mt-1"
    />
  )
}

function stackHeader(
  parts: readonly ToolCallPart[],
  toolOverlays: Readonly<Record<string, ToolLiveOverlay>> | undefined,
  t: TFunction,
): { kind: ToolActivityKind; running: boolean; text: string } {
  const latest = parts[parts.length - 1]
  if (!latest) {
    return { kind: 'other', running: false, text: '' }
  }
  const overlay = toolOverlays?.[normalizeToolCallId(latest.id)]
  const status = resolveToolStatus(latest.status, overlay?.status)
  return summarizeToolActivity(toActivityPart(latest, status), t)
}

function toActivityPart(
  part: ToolCallPart,
  status: ToolCallPart['status'],
): ToolActivityPart {
  return {
    id: part.id,
    name: part.name,
    args: part.args,
    status,
  }
}

function resolveToolStatus(
  canonicalStatus: ToolCallPart['status'],
  overlayStatus: ToolLiveOverlay['status'] | undefined,
): ToolCallPart['status'] {
  if (!overlayStatus) return canonicalStatus
  if (isTerminalToolStatus(canonicalStatus) && isToolRunning(overlayStatus)) {
    return canonicalStatus
  }
  return overlayStatus
}

function isTerminalToolStatus(status: ToolCallPart['status']): boolean {
  return (
    status === 'done' ||
    status === 'rejected' ||
    status === 'error' ||
    status === 'aborted'
  )
}

function ActivityIcon({
  kind,
}: {
  kind: ToolActivityKind
}) {
  const className = 'size-3.5 shrink-0 text-[var(--text-muted)]'
  if (kind === 'command') {
    return <Wrench className={className} aria-hidden />
  }
  if (kind === 'edit') {
    return <FilePenLine className={className} aria-hidden />
  }
  if (kind === 'write') {
    return <FilePlus className={className} aria-hidden />
  }
  if (kind === 'ask') {
    return <HelpCircle className={className} aria-hidden />
  }
  return <FileText className={className} aria-hidden />
}
