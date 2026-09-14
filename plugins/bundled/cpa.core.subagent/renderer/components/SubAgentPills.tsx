import {
  useHostServices,
  useSubAgents,
  useTranslation,
  cn,
} from '@cpa/plugin-ui'
import { normalizeToolCallId } from '@cpa/plugin-api'
import { SubAgentAvatar } from './SubAgentAvatar.js'

export interface SpawnToolPart {
  id: string
  name: string
  args: Record<string, unknown>
  status: any
}

function fallbackName(part: SpawnToolPart): string {
  const name = part.args?.name
  if (typeof name === 'string' && name.trim()) {
    return name.trim()
  }
  const prompt = part.args?.prompt
  if (typeof prompt === 'string' && prompt.trim()) {
    return prompt.trim().slice(0, 18)
  }
  return 'Agent'
}

function hasNonEmptyPrompt(args: Record<string, unknown> | undefined): boolean {
  const prompt = args?.prompt
  return typeof prompt === 'string' && prompt.trim().length > 0
}

function isInFlightSpawnStatus(status: unknown): boolean {
  return status === 'running' || status === 'queued' || status === 'awaiting_approval'
}

/** Failed / incomplete spawn_agent calls never created a sub-agent and must not render badges. */
function shouldShowSpawnPill(
  part: SpawnToolPart,
  record: { id: string } | undefined,
): boolean {
  if (record) return true
  return isInFlightSpawnStatus(part.status) && hasNonEmptyPrompt(part.args)
}

export function SubAgentPills(props: {
  parts?: readonly SpawnToolPart[]
  parentSessionId?: string
  /** Alias used by chat.message.subagents ExtensionSlot props. */
  sessionId?: string
  /** Single-part fallback when rendered via PluginPartHost / chat-renderer. */
  part?: SpawnToolPart
  value?: SpawnToolPart
  message?: { sessionId?: string }
  className?: string
}) {
  const {
    className,
    message,
  } = props
  const singlePart = props.part ?? props.value
  const parts = props.parts ?? (singlePart ? [singlePart] : [])
  const parentSessionId =
    props.parentSessionId ??
    props.sessionId ??
    message?.sessionId ??
    ''

  const services = useHostServices()
  const { t } = useTranslation()
  const agents = useSubAgents(parentSessionId)

  const pills = parts.flatMap((part) => {
    const normalized = normalizeToolCallId(part.id)
    const record = agents.find(
      (agent) =>
        agent.parentSessionId === parentSessionId &&
        agent.parentToolCallId &&
        normalizeToolCallId(agent.parentToolCallId) === normalized,
    )
    if (!shouldShowSpawnPill(part, record)) return []
    const isQueued = record?.status === 'queued'
    const isRunning =
      record?.status === 'running' ||
      isQueued ||
      part.status === 'running'
    return [{
      part,
      record,
      name: record?.name ?? fallbackName(part),
      isRunning,
      isQueued,
    }]
  })

  if (pills.length === 0) return null

  return (
    <div
      className={cn('my-2 flex flex-wrap items-center gap-2 first:mt-0', className)}
      data-testid="subagent-pills"
    >
      {pills.map((pill) => (
        <button
          key={pill.part.id}
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)]',
            'bg-[var(--bg-elevated)] px-2.5 py-1 text-[12px] text-[var(--text-primary)]',
            'hover:bg-[var(--bg-sidebar-hover)]',
          )}
          onClick={() => {
            if (!pill.record) return
            services?.subAgents?.openTab?.(parentSessionId, pill.record.id)
            services?.ui?.openRightPanelTab?.('subagent', { activate: true })
            services?.ui?.setRightSidebarCollapsed?.(false)
          }}
        >
          <SubAgentAvatar
            icon={pill.record?.icon ?? 'sparkle'}
            color={pill.record?.color ?? '#9b7dff'}
            size={16}
          />
          <span
            className={cn(
              'max-w-[140px] truncate',
              pill.isRunning && 'animate-text-shimmer',
            )}
          >
            {pill.name}
          </span>
          {pill.isQueued ? (
            <span className="shrink-0 text-[11px] font-normal text-[var(--text-muted)]">
              ({t('subagent.status.queued', 'Queued')})
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
