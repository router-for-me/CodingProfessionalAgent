import type {
    AgentTool,
    HostServices,
    PluginCapabilityClient,
    SessionService,
    ToolExecutionContext,
    ToolResult,
} from '@cpa/plugin-api'

export const SET_SESSION_TITLE_TOOL_NAME = 'title'
export const TITLE_TOOL_NAME = 'title'

export type SetSessionTitleArgs = {
    title: string
} & Record<string, unknown>

export const SET_SESSION_TITLE_DESCRIPTION =
    'Set the session title. Call on first turn before other actions.'

const setSessionTitleParameters: Record<string, unknown> = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description: 'Session title (2-6 words).',
        },
    },
    required: ['title'],
    additionalProperties: false,
}

export function validateSetSessionTitleArgs(input: unknown): SetSessionTitleArgs {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new Error('title arguments must be an object')
    }
    const source = input as Record<string, unknown>
    for (const key of Object.keys(source)) {
        if (key !== 'title') {
            throw new Error(`unknown argument: ${key}`)
        }
    }

    const title = source.title
    if (typeof title !== 'string' || title.trim().length === 0) {
        throw new Error('title must be a non-empty string')
    }

    return { title: title.trim() }
}

export type SetSessionTitleRenameFn =
    | ((sessionId: string, title: string) => void)
    | ((title: string) => void)

export interface SetSessionTitleToolOptions {
    onRename?: SetSessionTitleRenameFn
    services?: HostServices | { sessions?: SessionService }
    capabilityClient?: PluginCapabilityClient
}

export function createSetSessionTitleTool(
    optionsOrRename?: SetSessionTitleRenameFn | SetSessionTitleToolOptions,
): AgentTool<SetSessionTitleArgs> {
    const options: SetSessionTitleToolOptions =
        typeof optionsOrRename === 'function'
            ? { onRename: optionsOrRename }
            : (optionsOrRename ?? {})

    return {
        name: SET_SESSION_TITLE_TOOL_NAME,
        label: SET_SESSION_TITLE_TOOL_NAME,
        description: SET_SESSION_TITLE_DESCRIPTION,
        parameters: setSessionTitleParameters,
        validate(input: unknown): SetSessionTitleArgs {
            return validateSetSessionTitleArgs(input)
        },
        async execute(
            _toolCallId: string,
            args: SetSessionTitleArgs,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            const trimmedTitle = args.title.trim()
            const sessionId = context.sessionId
            const effectiveOnRename = options.onRename ?? (context as any)?.onRename
            const effectiveServices = context.services ?? options.services
            const effectiveCapClient = options.capabilityClient ?? (context as any)?.capabilityClient

            if (sessionId) {
                if (typeof effectiveOnRename === 'function') {
                    if (effectiveOnRename.length === 1) {
                        (effectiveOnRename as (title: string) => void)(trimmedTitle)
                    } else {
                        (effectiveOnRename as (sid: string, title: string) => void)(sessionId, trimmedTitle)
                    }
                } else if ((effectiveServices as any)?.sessions?.renameSession) {
                    await (effectiveServices as any).sessions.renameSession(sessionId, trimmedTitle)
                } else if ((effectiveServices as any)?.sessions?.update) {
                    await (effectiveServices as any).sessions.update(sessionId, { title: trimmedTitle })
                } else if (effectiveCapClient && typeof effectiveCapClient.invoke === 'function') {
                    await effectiveCapClient.invoke('session:setMeta', [{ id: sessionId, title: trimmedTitle }])
                }
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Session title successfully set to "${trimmedTitle}".`,
                    },
                ],
                details: { title: trimmedTitle },
                isError: false,
            }
        },
    }
}
