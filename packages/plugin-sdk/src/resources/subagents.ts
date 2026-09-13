/**
 * CPA subagent roles prompt formatter and helpers.
 */

import type { SubagentRole } from '@cpa/plugin-api'

function escapeXml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

/**
 * Formats configured subagent roles into an XML block for injection into the main system prompt.
 * If no roles are provided, returns an empty string.
 */
export function formatSubagentRolesForPrompt(
    roles?: readonly SubagentRole[],
): string {
    if (!roles || roles.length === 0) {
        return ''
    }

    const lines = [
        '\n\nThe following subagent roles provide pre-configured specifications for delegating specialized tasks.',
        'When encountering scenarios matching any of these defined roles when dispatching a sub-agent, prioritize using the user-defined subagent role rather than deciding the model, reasoning effort, or prompt on your own.',
        '',
        '<available_roles>',
    ]

    for (const role of roles) {
        const id = (role.id || '').trim()
        const name = (role.name || '').trim()
        const description = (role.description || '').trim()
        const model = (role.modelId || '').trim()
        const reasoningEffort = (role.reasoningEffort || 'default').trim()

        lines.push('  <role>')
        if (id) {
            lines.push(`    <id>${escapeXml(id)}</id>`)
        }
        lines.push(`    <name>${escapeXml(name)}</name>`)
        if (description) {
            lines.push(`    <description>${escapeXml(description)}</description>`)
        }
        if (model) {
            lines.push(`    <model>${escapeXml(model)}</model>`)
        }
        if (reasoningEffort) {
            lines.push(`    <reasoning_effort>${escapeXml(reasoningEffort)}</reasoning_effort>`)
        }
        lines.push('  </role>')
    }

    lines.push('</available_roles>')
    return lines.join('\n')
}
