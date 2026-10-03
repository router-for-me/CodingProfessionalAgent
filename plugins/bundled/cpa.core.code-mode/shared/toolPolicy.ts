// Orchestration stays outside cells regardless of user configuration or exposure metadata.
export function isMandatoryDirectTool(name: string): boolean {
    return ['exec', 'wait', 'spawn_agent', 'send_message', 'send_input', 'stop_agent'].includes(name)
}

export const DIRECT_TOOL_GUIDANCE = 'Subagent tools (spawn_agent, send_message/send_input, stop_agent) are direct-only: always call them at the top level, never inside exec, even in code-only mode. Other direct-only tools must also stay outside exec. Use wait only to observe exec cells, not to poll subagents.'
