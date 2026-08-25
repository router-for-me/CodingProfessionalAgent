import { useMemo } from 'react'
import {
  Bot,
  X,
  useTranslation,
  useHostServices,
  useSubAgents,
  useSubAgentOpenTabIds,
  useSubAgentFocusedId,
  useUiState,
  cn,
} from '@cpa/plugin-ui'

export interface SubAgentTabHeadersProps {
    sessionId?: string | null
}

export function SubAgentTabHeaders({ sessionId }: SubAgentTabHeadersProps) {
    const { t } = useTranslation()
    const services = useHostServices()
    const agents = useSubAgents(sessionId ?? undefined)
    const openTabIds = useSubAgentOpenTabIds(sessionId ?? undefined)
    const focusedId = useSubAgentFocusedId(sessionId ?? undefined)
    const rightPanelActiveTab = useUiState((state: any) => state?.rightPanelActiveTab)

    const openAgents = useMemo(() => {
        return openTabIds
            .map((id) => agents.find((agent) => agent.id === id))
            .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
    }, [openTabIds, agents])

    if (agents.length === 0) {
        return null
    }

    if (openAgents.length > 0) {
        return (
            <>
                {openAgents.map((agent) => {
                    const active = rightPanelActiveTab === 'subagent' && agent.id === focusedId
                    return (
                        <button
                            key={agent.id}
                            type="button"
                            className={cn(
                                'inline-flex h-7 max-w-[160px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px]',
                                active
                                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)]'
                            )}
                            onClick={() => {
                                services?.ui?.openRightPanelTab?.('subagent', { activate: true })
                                if (sessionId) {
                                    services?.subAgents?.focusTab?.(sessionId, agent.id)
                                }
                            }}
                        >
                            <Bot size={13} className="shrink-0" />
                            <span className="truncate">{agent.name}</span>
                            <span
                                role="button"
                                tabIndex={0}
                                className="flex size-4 shrink-0 items-center justify-center rounded p-0.5 hover:bg-[var(--bg-sidebar-hover)]"
                                onClick={(event) => {
                                    event.stopPropagation()
                                    if (sessionId) {
                                        services?.subAgents?.closeTab?.(sessionId, agent.id)
                                    }
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        if (sessionId) {
                                            services?.subAgents?.closeTab?.(sessionId, agent.id)
                                        }
                                    }
                                }}
                                aria-label={t('subagent.closeTab', { name: agent.name })}
                            >
                                <X size={10} className="shrink-0" />
                            </span>
                        </button>
                    )
                })}
            </>
        )
    }

    return (
        <button
            type="button"
            className={cn(
                'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] whitespace-nowrap',
                rightPanelActiveTab === 'subagent'
                    ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-sidebar-hover)]'
            )}
            onClick={() => services?.ui?.openRightPanelTab?.('subagent', { activate: true })}
        >
            <Bot size={14} className="shrink-0" />
            <span className="shrink-0 whitespace-nowrap">{t('subagent.title')}</span>
        </button>
    )
}
