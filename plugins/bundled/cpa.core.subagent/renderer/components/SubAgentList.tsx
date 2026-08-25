import { useEffect } from 'react'
import { useTranslation, useHostServices, cn } from '@cpa/plugin-ui'
import type { SubAgentRecord } from '@cpa/plugin-api'
import { useElapsedMs, formatElapsed } from '../utils/elapsed.js'
import { SubAgentAvatar } from './SubAgentAvatar.js'
import { SubAgentMetaText } from './SubAgentMetaText.js'
import { ContextUsageRing } from './ContextUsageRingAdapter.js'

const STATUS_KEY: Record<SubAgentRecord['status'], string> = {
  queued: 'subagent.status.queued',
  running: 'subagent.status.running',
  completed: 'subagent.status.completed',
  error: 'subagent.status.error',
  aborted: 'subagent.status.aborted',
}

export function SubAgentList({
  agents,
  onSelect,
  className,
  limit,
}: {
  agents: readonly SubAgentRecord[]
  onSelect: (agentId: string) => void
  className?: string
  limit?: number
}) {
  const services = useHostServices()

  useEffect(() => {
    for (const agent of agents) {
      const key = agent.sessionId || agent.id
      if (key && services?.chatMessages?.ensureSessionLoaded) {
        void services.chatMessages.ensureSessionLoaded(key)
      }
    }
  }, [agents, services?.chatMessages])

  const visible = typeof limit === 'number' && limit > 0 ? agents.slice(0, limit) : agents

  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="subagent-list">
      {visible.map((agent) => (
        <button
          key={agent.id}
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
            'hover:bg-[var(--bg-sidebar-hover)]',
          )}
          onClick={() => onSelect(agent.id)}
        >
          <SubAgentAvatar icon={agent.icon} color={agent.color} size={20} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)]">
            {agent.name}
          </span>
          <ContextUsageRing agent={agent} size={14} />
          <SubAgentMetaText agent={agent} className="max-w-[42%] shrink" />
          <SubAgentStatusLabel agent={agent} />
        </button>
      ))}
    </div>
  )
}

function isSubAgentInProgress(status: SubAgentRecord['status']): boolean {
  return status === 'running' || status === 'queued'
}

function SubAgentStatusLabel({ agent }: { agent: SubAgentRecord }) {
  const { t, i18n } = useTranslation()
  const running = isSubAgentInProgress(agent.status)
  const elapsedMs = useElapsedMs(
    agent.createdAt,
    running ? undefined : (agent.completedAt ?? agent.updatedAt),
    running,
    agent.pausedMs,
  )
  const time = formatElapsed(elapsedMs, i18n.resolvedLanguage)
  return (
    <span
      className="shrink-0 text-[11px] text-[var(--text-muted)]"
      data-testid="subagent-status"
    >
      {t('subagent.statusWithTime', {
        status: t(STATUS_KEY[agent.status]),
        time,
      })}
    </span>
  )
}
