import type { AgentTool, ToolExecutionContext, ToolResult } from '@cpa/plugin-api'
import {
    searchSkills,
    SKILL_SEARCH_DEFAULT_LIMIT,
    SKILL_SEARCH_TOOL_NAME,
} from '@cpa/plugin-sdk'

export { SKILL_SEARCH_TOOL_NAME }

export const SKILL_SEARCH_TOOL_DESCRIPTION =
    'Search available skills by name and description. Returns matching names, descriptions, and SKILL.md locations. Use the read tool to load a selected skill before following it.'

export const SKILL_SEARCH_TOOL_PARAMETERS: Record<string, unknown> = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: 'What the skill should help with. Matches names and descriptions.',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            description: `Maximum number of skills to return. Defaults to ${SKILL_SEARCH_DEFAULT_LIMIT}.`,
        },
    },
    required: ['query'],
}

function textResult(text: string, isError = false): ToolResult {
    return {
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
    }
}

export function createSkillSearchTool(): AgentTool {
    return {
        name: SKILL_SEARCH_TOOL_NAME,
        label: 'Skill search',
        description: SKILL_SEARCH_TOOL_DESCRIPTION,
        parameters: SKILL_SEARCH_TOOL_PARAMETERS,
        exposure: 'direct',
        validate(input: unknown): Record<string, unknown> {
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                return input as Record<string, unknown>
            }
            return {}
        },
        async execute(
            _toolCallId: string,
            args: Record<string, unknown>,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            const skills = context.skills
            if (!skills) {
                return textResult('skill catalog is unavailable', true)
            }
            if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit))) {
                return textResult('limit must be greater than zero', true)
            }
            try {
                const matches = searchSkills(
                    skills,
                    typeof args.query === 'string' ? args.query : '',
                    typeof args.limit === 'number' ? args.limit : SKILL_SEARCH_DEFAULT_LIMIT,
                )
                return textResult(JSON.stringify({ skills: matches }))
            } catch (error) {
                return textResult(error instanceof Error ? error.message : String(error), true)
            }
        },
    }
}
