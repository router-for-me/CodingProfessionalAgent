import { describe, expect, it } from 'vitest'
import { createSkillSearchTool, SKILL_SEARCH_TOOL_NAME } from './skillSearchTool.js'

const compact = {
    name: 'compact',
    description: '压缩会话上下文',
    filePath: '/skills/compact/SKILL.md',
    disableModelInvocation: false,
}

describe('skill_search tool', () => {
    const tool = createSkillSearchTool()

    it('searches the catalog passed on the execution context', async () => {
        expect(tool.name).toBe(SKILL_SEARCH_TOOL_NAME)
        const result = await tool.execute('call-1', { query: '压缩' }, {
            skills: [
                compact,
                {
                    name: 'publish',
                    description: '发布 npm 包',
                    filePath: '/skills/publish/SKILL.md',
                    disableModelInvocation: false,
                },
            ],
        })
        expect(result.isError).toBeFalsy()
        expect(result.content).toEqual([
            {
                type: 'text',
                text: JSON.stringify({
                    skills: [
                        {
                            name: 'compact',
                            description: '压缩会话上下文',
                            location: '/skills/compact/SKILL.md',
                        },
                    ],
                }),
            },
        ])
    })

    it('reports an empty query and a missing catalog without throwing', async () => {
        const empty = await tool.execute('call-2', { query: ' ' }, { skills: [compact] })
        expect(empty.isError).toBe(true)
        expect(empty.content[0]).toMatchObject({ type: 'text', text: 'query must not be empty' })

        const missing = await tool.execute('call-3', { query: '压缩' }, {})
        expect(missing.isError).toBe(true)
        expect(missing.content[0]).toMatchObject({ type: 'text', text: 'skill catalog is unavailable' })
    })
})
