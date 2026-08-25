import {
    PluginCard,
    PluginCardBody,
    PluginCardHeader,
    PluginCardTitle,
} from '@cpa/plugin-ui'
import { MANAGE_TODO_LIST_TOOL_NAME } from '../../agent/todoTool.js'

export interface TodoToolCardProps {
    part?: {
        name?: string
        toolName?: string
        result?: unknown
        args?: unknown
    }
}

export function TodoToolCard({ part }: TodoToolCardProps) {
    const title = part?.name ?? part?.toolName ?? MANAGE_TODO_LIST_TOOL_NAME
    return (
        <PluginCard>
            <PluginCardHeader>
                <PluginCardTitle>{title}</PluginCardTitle>
            </PluginCardHeader>
            {part?.result ? (
                <PluginCardBody>
                    {typeof part.result === 'string'
                        ? part.result
                        : JSON.stringify(part.result, null, 2)}
                </PluginCardBody>
            ) : null}
        </PluginCard>
    )
}
