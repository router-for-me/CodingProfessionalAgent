import type { AgentTool, ToolExecutionContext, ToolResult } from '@cpa/plugin-api'
import { defaultAskController, useAskStore } from '../shared/askStore.js'
import type { AskOption, AskRequest } from '../shared/types.js'

export const ASK_TOOL_NAME = 'ask'

export const ASK_TOOL_DESCRIPTION = `Ask the user a question with structured multiple-choice options or collect freeform text input. Use when you need clarification, confirmation, choices, or input from the user to proceed.`

export const ASK_TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        question: {
            type: 'string',
            description: 'The question or prompt to ask the user.',
        },
        options: {
            type: 'array',
            description:
                'Optional list of choices for the user to select from. Each option should have a title and optional description.',
            items: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Concise title or label for this option.',
                    },
                    description: {
                        type: 'string',
                        description: 'Optional detailed explanation for this option.',
                    },
                },
                required: ['title'],
            },
        },
        allowCustom: {
            type: 'boolean',
            description:
                'Whether to allow the user to input a custom text response (default: true).',
        },
        customPrompt: {
            type: 'string',
            description:
                'Optional placeholder or prompt text for the custom input option (e.g. "No, and tell CPA what to do differently").',
        },
        allowSkip: {
            type: 'boolean',
            description:
                'Whether to allow the user to skip answering the question (default: true).',
        },
    },
    required: ['question'],
}

export function parseAskOptions(rawOptions: unknown): AskOption[] {
    if (!Array.isArray(rawOptions)) {
        return []
    }
    const options: AskOption[] = []
    for (const item of rawOptions) {
        if (!item) continue
        if (typeof item === 'string') {
            const title = item.trim()
            if (title) {
                options.push({ title })
            }
        } else if (typeof item === 'object') {
            const record = item as Record<string, unknown>
            const title =
                typeof record.title === 'string'
                    ? record.title.trim()
                    : typeof record.label === 'string'
                      ? record.label.trim()
                      : typeof record.text === 'string'
                        ? record.text.trim()
                        : typeof record.value === 'string'
                          ? record.value.trim()
                          : ''
            if (title) {
                const description =
                    typeof record.description === 'string'
                        ? record.description.trim()
                        : typeof record.desc === 'string'
                          ? record.desc.trim()
                          : undefined
                options.push({
                    title,
                    description: description || undefined,
                })
            }
        }
    }
    return options
}

function resolveSessionId(context: unknown): string {
    if (context && typeof context === 'object') {
        const ctx = context as Record<string, unknown>
        if (typeof ctx.sessionId === 'string' && ctx.sessionId.length > 0) {
            return ctx.sessionId
        }
    }
    return 'default'
}

export function createAskTool(): AgentTool {
    return {
        name: ASK_TOOL_NAME,
        label: ASK_TOOL_NAME,
        description: ASK_TOOL_DESCRIPTION,
        parameters: ASK_TOOL_PARAMETERS,
        targetAgent: 'main',
        validate(input: unknown): Record<string, unknown> {
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                return input as Record<string, unknown>
            }
            return {}
        },
        async execute(
            toolCallId: string,
            args: Record<string, unknown>,
            toolContext: ToolExecutionContext
        ): Promise<ToolResult> {
            const rawQuestion =
                typeof args.question === 'string'
                    ? args.question.trim()
                    : typeof args.prompt === 'string'
                      ? args.prompt.trim()
                      : typeof args.query === 'string'
                        ? args.query.trim()
                        : typeof args.text === 'string'
                          ? args.text.trim()
                          : ''

            if (!rawQuestion) {
                throw new Error(
                    'Missing required parameter "question" for ask tool.'
                )
            }

            const options = parseAskOptions(args.options)
            const allowCustom = args.allowCustom !== false
            const customPrompt =
                typeof args.customPrompt === 'string'
                    ? args.customPrompt.trim()
                    : undefined
            const allowSkip = args.allowSkip !== false

            const sessionId = resolveSessionId(toolContext)
            const effectiveCallId =
                toolCallId ||
                (toolContext &&
                typeof toolContext === 'object' &&
                'toolCallId' in toolContext &&
                typeof (toolContext as { toolCallId: unknown }).toolCallId === 'string'
                    ? (toolContext as { toolCallId: string }).toolCallId
                    : `ask_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`)

            const request: AskRequest = {
                id: `ask_req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                toolCallId: effectiveCallId,
                sessionId,
                question: rawQuestion,
                options,
                allowCustom,
                customPrompt,
                allowSkip,
                createdAt: Date.now(),
            }

            // Register active request in store so UI renders overlay
            useAskStore.getState().setRequest(sessionId, request)

            const signal = toolContext?.signal

            try {
                const decision = await defaultAskController.waitForAnswer(
                    sessionId,
                    effectiveCallId,
                    signal
                )

                // Clear request in store
                useAskStore.getState().setRequest(sessionId, null)

                switch (decision.type) {
                    case 'selected': {
                        const opt = decision.option
                        const resultText = `User selected: ${opt.title}${opt.description ? ` (${opt.description})` : ''}`
                        return {
                            content: [{ type: 'text', text: resultText }],
                            details: resultText,
                            isError: false,
                        }
                    }
                    case 'custom': {
                        const resultText = `User response: ${decision.text}`
                        return {
                            content: [{ type: 'text', text: resultText }],
                            details: resultText,
                            isError: false,
                        }
                    }
                    case 'skipped': {
                        const resultText = 'User skipped this question.'
                        return {
                            content: [{ type: 'text', text: resultText }],
                            details: resultText,
                            isError: false,
                        }
                    }
                    case 'cancelled': {
                        const resultText = 'User dismissed or cancelled this question.'
                        return {
                            content: [{ type: 'text', text: resultText }],
                            details: resultText,
                            isError: false,
                        }
                    }
                    case 'aborted': {
                        throw new Error('Tool execution aborted')
                    }
                }
            } finally {
                useAskStore.getState().setRequest(sessionId, null)
            }
        },
    }
}
