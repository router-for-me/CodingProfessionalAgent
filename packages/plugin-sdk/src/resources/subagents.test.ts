import { describe, expect, it } from 'vitest'
import { formatSubagentRolesForPrompt } from './subagents.js'

describe('formatSubagentRolesForPrompt', () => {
    it('returns empty string when no roles are provided or list is empty', () => {
        expect(formatSubagentRolesForPrompt()).toBe('')
        expect(formatSubagentRolesForPrompt([])).toBe('')
    })

    it('formats single role into XML with required priority preamble', () => {
        const result = formatSubagentRolesForPrompt([
            {
                id: 'role-1',
                name: '代码审查员',
                description: '负责代码审查与缺陷定位',
                modelId: 'claude-sonnet-5',
                reasoningEffort: 'high',
            },
        ])

        expect(result).toContain('<available_roles>')
        expect(result).toContain(
            'When encountering scenarios matching any of these defined roles when dispatching a sub-agent, prioritize using the user-defined subagent role rather than deciding the model, reasoning effort, or prompt on your own.'
        )
        expect(result).toContain('<id>role-1</id>')
        expect(result).toContain('<name>代码审查员</name>')
        expect(result).toContain('<description>负责代码审查与缺陷定位</description>')
        expect(result).toContain('<model>claude-sonnet-5</model>')
        expect(result).toContain('<reasoning_effort>high</reasoning_effort>')
        expect(result).toContain('</available_roles>')
    })

    it('escapes XML special characters in role fields', () => {
        const result = formatSubagentRolesForPrompt([
            {
                id: 'role-2',
                name: 'Bug Hunter & Fixer <v1>',
                description: 'Review "diffs" & \'patches\'',
                modelId: 'gpt-5.5',
                reasoningEffort: 'medium',
            },
        ])

        expect(result).toContain('<name>Bug Hunter &amp; Fixer &lt;v1&gt;</name>')
        expect(result).toContain('<description>Review &quot;diffs&quot; &amp; &apos;patches&apos;</description>')
    })
})
