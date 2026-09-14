/**
 * spawn_agent / send_message / stop_agent tools for the parent agent.
 */

import {
    AgentRuntimeServiceToken,
    SubAgentServiceToken,
    type AgentTool,
    type ModelCatalogEntry,
    type ToolExecutionContext,
    type ToolResult,
} from '@cpa/plugin-api'

export interface SubAgentExecutionCoordinator {
    spawn(
        prompt: string,
        options?: {
            name?: string
            toolCallId?: string
            parentSessionId?: string
            modelId?: string
            reasoningEffort?: string
            role?: string
            roleId?: string
            roleName?: string
            rolePrompt?: string
            signal?: AbortSignal
            onUpdate?: (partial: {
                content: { type: 'text'; text: string }[]
                details?: unknown
                isError?: boolean
            }) => void
        },
    ): Promise<ToolResult>
    sendMessage(
        agentId: string,
        message: string,
        signal?: AbortSignal,
    ): Promise<ToolResult>
    stop?(agentId: string): Promise<ToolResult> | ToolResult
    stopAgent?(agentId: string): Promise<ToolResult> | ToolResult
}

export type SpawnAgentArgs = {
    prompt: string
    name: string
    model?: string
    role?: string
    reasoning_effort?: string
    thinking?: string
} & Record<string, unknown>

export type SendMessageArgs = {
    agent_id: string
    message: string
} & Record<string, unknown>

export type StopAgentArgs = {
    agent_id: string
} & Record<string, unknown>

function requireString(input: unknown, field: string, retryHint?: string): string {
    const hint = retryHint ? ` ${retryHint}` : ''
    if (!input || typeof input !== 'object') {
        throw new Error(`${field} is required.${hint}`)
    }
    const value = (input as Record<string, unknown>)[field]
    if (value === undefined || value === null) {
        throw new Error(`${field} is required and must be a non-empty string.${hint}`)
    }
    if (typeof value !== 'string') {
        throw new Error(`${field} must be a string.${hint}`)
    }
    const trimmed = value.trim()
    if (!trimmed) {
        throw new Error(`${field} must be a non-empty string.${hint}`)
    }
    return trimmed
}

function formatModelChoices(models: readonly ModelCatalogEntry[]): string {
    return models.map((entry) => `${entry.id} (${entry.label})`).join(', ')
}

function resolveCoordinator(
    host?: SubAgentExecutionCoordinator,
    context?: ToolExecutionContext,
): SubAgentExecutionCoordinator | undefined {
    if (host) return host
    if (!context) return undefined
    const ctx = context as Record<string, unknown>
    if (ctx.subAgents && typeof (ctx.subAgents as any).spawn === 'function') {
        return ctx.subAgents as SubAgentExecutionCoordinator
    }
    const services = ctx.services as Record<string, unknown> | undefined
    if (services?.subAgents && typeof (services.subAgents as any).spawn === 'function') {
        return services.subAgents as SubAgentExecutionCoordinator
    }
    if (typeof ctx.getService === 'function') {
        const fromService =
            (ctx.getService as any)(AgentRuntimeServiceToken) ??
            (ctx.getService as any)(SubAgentServiceToken)
        if (fromService && typeof fromService.spawn === 'function') {
            return fromService as SubAgentExecutionCoordinator
        }
    }
    return undefined
}

export function createSpawnAgentTool(
    host?: SubAgentExecutionCoordinator,
    models: readonly ModelCatalogEntry[] = [],
): AgentTool<SpawnAgentArgs> {
    const choices = formatModelChoices(models)
    const modelProperty: Record<string, unknown> = {
        type: 'string',
        description: choices
            ? `Model id (with optional :reasoning_effort suffix, e.g. "grok-4.6:xhigh") the sub-agent must use when talking to the upstream. One of: ${choices}`
            : 'Model id (with optional :reasoning_effort suffix, e.g. "grok-4.6:xhigh") the sub-agent must use when talking to the upstream',
    }
    if (models.length > 0) {
        modelProperty.enum = models.map((entry) => entry.id)
    }
    return {
        name: 'spawn_agent',
        label: 'spawn_agent',
        description:
            'Dispatch a sub-agent to work on an independent task. Choose a short, human-readable name randomly and pass it in name. If a pre-configured role is specified via role, model is optional and defaults to the role\'s configured model. If no role is specified, always pass model as a catalog model id. Waits until the sub-agent finishes and returns its last message, prefixed with the agent id. Use that id with send_message or stop_agent. Do not spawn a sub-agent for work you can finish with a single tool call.',
        targetAgent: 'main',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description:
                        'Required. Full task instructions for the sub-agent. Never omit this field.',
                },
                name: {
                    type: 'string',
                    description: 'A short, human-readable name chosen randomly for this sub-agent',
                },
                role: {
                    type: 'string',
                    description:
                        'Optional subagent role name or id from available roles. If specified, the subagent adopts this role configuration and prompt instructions.',
                },
                model: modelProperty,
                reasoning_effort: {
                    type: 'string',
                    description:
                        'Optional thinking / reasoning effort for the sub-agent (e.g. "xhigh", "high", "medium", "low")',
                },
                thinking: {
                    type: 'string',
                    description: 'Alias for reasoning_effort',
                },
            },
            required: ['prompt', 'name'],
            additionalProperties: false,
        },
        validate(input: unknown): SpawnAgentArgs {
            const prompt = requireString(
                input,
                'prompt',
                'Retry spawn_agent once with the complete task instructions in prompt; do not omit prompt.',
            )
            const name = requireString(input, 'name')
            const raw = input as Record<string, unknown>
            const role =
                typeof raw.role === 'string'
                    ? raw.role.trim() || undefined
                    : undefined
            const rawModel =
                typeof raw.model === 'string'
                    ? raw.model.trim() || undefined
                    : undefined
            if (!rawModel && !role) {
                throw new Error('model is required when role is not specified')
            }
            const reasoning_effort =
                typeof raw.reasoning_effort === 'string'
                    ? raw.reasoning_effort.trim() || undefined
                    : undefined
            const thinking =
                typeof raw.thinking === 'string'
                    ? raw.thinking.trim() || undefined
                    : undefined
            return { prompt, name, model: rawModel, role, reasoning_effort, thinking }
        },
        async execute(
            toolCallId: string,
            args: SpawnAgentArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            const coordinator = resolveCoordinator(host, context)
            if (!coordinator) {
                return {
                    content: [{ type: 'text', text: 'SubAgent runtime coordinator is not available' }],
                    isError: true,
                }
            }
            return coordinator.spawn(args.prompt, {
                name: args.name,
                role: args.role,
                toolCallId,
                parentSessionId: context.sessionId ?? undefined,
                modelId: args.model,
                reasoningEffort: args.reasoning_effort ?? args.thinking,
                signal: context.signal,
                onUpdate: context.onUpdate,
            })
        },
    }
}

export function createSendMessageTool(
    host?: SubAgentExecutionCoordinator,
): AgentTool<SendMessageArgs> {
    return {
        name: 'send_message',
        label: 'send_message',
        description:
            'Send a follow-up message to an existing sub-agent. If the sub-agent is still running, the message is queued. If it is idle, this starts a new turn and waits for the last message.',
        targetAgent: 'main',
        parameters: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Id returned when the sub-agent was spawned',
                },
                message: {
                    type: 'string',
                    description:
                        'Required. Follow-up instructions for the sub-agent. Never omit this field.',
                },
            },
            required: ['agent_id', 'message'],
            additionalProperties: false,
        },
        validate(input: unknown): SendMessageArgs {
            return {
                agent_id: requireString(input, 'agent_id'),
                message: requireString(
                    input,
                    'message',
                    'Retry send_message with the follow-up text in message; do not omit message.',
                ),
            }
        },
        async execute(
            _toolCallId: string,
            args: SendMessageArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            const coordinator = resolveCoordinator(host, context)
            if (!coordinator) {
                return {
                    content: [{ type: 'text', text: 'SubAgent runtime coordinator is not available' }],
                    isError: true,
                }
            }
            return coordinator.sendMessage(args.agent_id, args.message, context.signal)
        },
    }
}

export function createStopAgentTool(
    host?: SubAgentExecutionCoordinator,
): AgentTool<StopAgentArgs> {
    return {
        name: 'stop_agent',
        label: 'stop_agent',
        description: 'Stop a running sub-agent by id.',
        targetAgent: 'main',
        parameters: {
            type: 'object',
            properties: {
                agent_id: {
                    type: 'string',
                    description: 'Id of the sub-agent to stop',
                },
            },
            required: ['agent_id'],
            additionalProperties: false,
        },
        validate(input: unknown): StopAgentArgs {
            return { agent_id: requireString(input, 'agent_id') }
        },
        async execute(
            _toolCallId: string,
            args: StopAgentArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            const coordinator = resolveCoordinator(host, context)
            if (!coordinator) {
                return {
                    content: [{ type: 'text', text: 'SubAgent runtime coordinator is not available' }],
                    isError: true,
                }
            }
            return typeof coordinator.stopAgent === 'function'
                ? coordinator.stopAgent(args.agent_id)
                : coordinator.stop
                  ? coordinator.stop(args.agent_id)
                  : { content: [{ type: 'text', text: `Stopped ${args.agent_id}` }] }
        },
    }
}

export const createSendInputTool = createSendMessageTool

export function createSubAgentTools(
    host?: SubAgentExecutionCoordinator,
    models: readonly ModelCatalogEntry[] = [],
): AgentTool[] {
    return [
        createSpawnAgentTool(host, models),
        createSendMessageTool(host),
        createStopAgentTool(host),
    ]
}
