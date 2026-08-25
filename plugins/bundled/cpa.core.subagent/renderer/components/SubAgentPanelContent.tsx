import React from 'react'
import {
  useTranslation,
  useHostServices,
  useSubAgents,
  useSubAgentFocusedId,
} from '@cpa/plugin-ui'
import { SubAgentConversation } from './SubAgentConversation.js'
import { SubAgentList } from './SubAgentList.js'

export interface SubAgentPanelContentProps {
    sessionId?: string
}

/**
 * Subagent list or conversation view rendered inside the right panel slot.
 */
export function SubAgentPanelContent({
    sessionId = '',
}: SubAgentPanelContentProps): React.ReactNode {
    const { t } = useTranslation()
    const services = useHostServices()
    const agents = useSubAgents(sessionId)
    const focusedId = useSubAgentFocusedId(sessionId)

    const focused = focusedId
        ? agents.find((agent) => agent.id === focusedId)
        : undefined

    if (focused) {
        return (
            <SubAgentConversation
                sessionId={sessionId}
                agent={focused}
                onBack={() => services?.subAgents?.focusTab?.(sessionId, null)}
            />
        )
    }

    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
            <p className="mb-2 px-2 text-[12px] font-medium text-[var(--text-secondary)]">
                {t('subagent.title')}
            </p>
            <SubAgentList
                agents={agents}
                onSelect={(agentId) => services?.subAgents?.openTab?.(sessionId, agentId)}
            />
        </div>
    )
}
