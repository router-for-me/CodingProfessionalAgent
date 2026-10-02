import {
  useHostServices,
  useSubAgents,
  useToolOverlays,
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
  return agentIdentifier(part.args) ?? 'Agent'
}

function hasNonEmptyPrompt(args: Record<string, unknown> | undefined): boolean {
  const prompt = args?.prompt
  return typeof prompt === 'string' && prompt.trim().length > 0
}

function isSendMessageName(name: string): boolean {
  return name === 'send_message' || name === 'send_input'
}

function agentIdentifier(args: Record<string, unknown> | undefined): string | undefined {
  const raw = args?.agent_id ?? args?.agentId ?? args?.target
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function isInFlightSpawnStatus(status: unknown): boolean {
  return status === 'running' || status === 'queued' || status === 'awaiting_approval'
}

function isTerminalToolStatus(status: unknown): boolean {
  return (
    status === 'done' ||
    status === 'rejected' ||
    status === 'error' ||
    status === 'aborted'
  )
}

function isToolRunning(status: unknown): boolean {
  return (
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_approval'
  )
}

function resolveToolStatus(
  canonicalStatus: any,
  overlayStatus: any,
): any {
  if (!overlayStatus) return canonicalStatus
  if (isTerminalToolStatus(canonicalStatus) && isToolRunning(overlayStatus)) {
    return canonicalStatus
  }
  return overlayStatus
}

function findToolOverlay(
  toolOverlays: Readonly<Record<string, any>> | undefined,
  id: string,
): any {
  if (!toolOverlays || !id) return undefined
  const normalized = normalizeToolCallId(id)
  return (
    toolOverlays[id] ??
    toolOverlays[normalized] ??
    toolOverlays[`call_${normalized}`] ??
    Object.values(toolOverlays).find(
      (o: any) => normalizeToolCallId(o?.toolCallId || '') === normalized,
    )
  )
}

/** Failed / incomplete spawn_agent calls never created a sub-agent and must not render badges. */
function shouldShowSpawnPill(
  part: SpawnToolPart,
  record: { id: string } | undefined,
  resolvedStatus?: unknown,
): boolean {
  if (isSendMessageName(part.name)) return false
  if (record) return true
  const effectiveStatus = resolvedStatus ?? part.status
  if (!isInFlightSpawnStatus(effectiveStatus)) return false
  return hasNonEmptyPrompt(part.args)
}

function sameAgent(record: { id: string; sessionId?: string; name: string }, identifier: string): boolean {
  const target = identifier.toLowerCase()
  return (
    record.id === identifier ||
    record.sessionId === identifier ||
    record.name.toLowerCase() === target
  )
}

function followUpTargetsAgent(
  record: { id: string; sessionId?: string; name: string } | undefined,
  overlays: Readonly<Record<string, any>> | undefined,
): boolean {
  if (!record || !overlays) return false
  for (const overlay of Object.values(overlays)) {
    const nested = overlay?.details?.nestedTools
    if (!Array.isArray(nested)) continue
    for (const item of nested) {
      if (!item || typeof item !== 'object') continue
      if (!isSendMessageName(String(item.name ?? item.toolName ?? ''))) continue
      if (!isToolRunning(item.status)) continue
      const identifier = agentIdentifier(item.args ?? item.arguments)
      if (identifier && sameAgent(record, identifier)) return true
    }
  }
  return false
}

function dedupeSubagentPills<T extends { part: SpawnToolPart; record?: { id: string }; isRunning: boolean; isQueued: boolean }>(
  pills: readonly T[],
): T[] {
  const order: string[] = []
  const byKey = new Map<string, T>()
  for (const pill of pills) {
    const key = pill.record?.id ?? `part:${pill.part.id}`
    const previous = byKey.get(key)
    if (!previous) {
      order.push(key)
      byKey.set(key, pill)
      continue
    }
    byKey.set(key, {
      ...previous,
      isRunning: previous.isRunning || pill.isRunning,
      isQueued: previous.isQueued || pill.isQueued,
    })
  }
  return order.map((key) => byKey.get(key)!)
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
  streaming?: boolean
  toolOverlays?: Readonly<Record<string, any>>
  className?: string
}) {
  const {
    className,
    message,
    streaming = false,
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
  const sessionOverlays = useToolOverlays(parentSessionId)
  const effectiveOverlays = props.toolOverlays ?? sessionOverlays

  const pills = parts.flatMap((part) => {
    const normalized = normalizeToolCallId(part.id)
    const overlay = findToolOverlay(effectiveOverlays, part.id)
    const resolvedStatus = resolveToolStatus(part.status, overlay?.status)

    const record =
      agents.find(
        (agent) =>
          agent.parentSessionId === parentSessionId &&
          agent.parentToolCallId &&
          normalizeToolCallId(agent.parentToolCallId) === normalized,
      ) ??
      agents.find(
        (agent) =>
          agent.parentSessionId === parentSessionId &&
          typeof part.args?.name === 'string' &&
          agent.name === part.args.name.trim() &&
          (!agent.parentToolCallId ||
            normalizeToolCallId(agent.parentToolCallId) === normalized),
      )

    if (!shouldShowSpawnPill(part, record, resolvedStatus)) return []

    const isRecordTerminal =
      record?.status === 'completed' ||
      record?.status === 'error' ||
      record?.status === 'aborted'
    const isToolTerminal = isTerminalToolStatus(resolvedStatus)
    const isTerminal =
      isRecordTerminal || (isToolTerminal && record?.status !== 'running')

    const isQueued = record?.status === 'queued'

    const isRunning =
      followUpTargetsAgent(record, effectiveOverlays) ||
      (!isTerminal &&
        (record?.status === 'running' ||
          isQueued ||
          isToolRunning(resolvedStatus) ||
          Boolean(streaming)))

    return [{
      part,
      record,
      name: record?.name ?? fallbackName(part),
      isRunning,
      isQueued,
    }]
  })

  const visiblePills = dedupeSubagentPills(pills)
  if (visiblePills.length === 0) return null

  return (
    <div
      className={cn('my-2 flex flex-wrap items-center gap-2 first:mt-0', className)}
      data-testid="subagent-pills"
    >
      {visiblePills.map((pill) => (
        <button
          key={pill.part.id}
          type="button"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)]',
            'bg-[var(--bg-elevated)] px-2.5 py-1 text-[12px]',
            pill.isRunning
              ? 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
              : 'text-[var(--text-primary)] hover:bg-[var(--bg-sidebar-hover)]',
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
            key={pill.name}
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
