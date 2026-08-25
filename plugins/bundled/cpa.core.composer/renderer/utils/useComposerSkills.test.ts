import { afterEach, describe, expect, it } from 'vitest'
import { publishComposerSkills } from './useComposerSkills.js'

describe('publishComposerSkills', () => {
    afterEach(() => {
        delete (globalThis as any).__cpaComposerSkills
    })

    it('publishes skills to the cross-plugin global bridge', () => {
        const skills = [
            {
                name: 'gh-issue',
                description: 'Triage GitHub issues',
                filePath: '/skills/gh-issue/SKILL.md',
            },
        ]

        publishComposerSkills(skills)

        expect((globalThis as any).__cpaComposerSkills).toEqual(skills)
    })

    it('can clear previously published skills', () => {
        publishComposerSkills([{ name: 'gh-issue' }])
        publishComposerSkills([])

        expect((globalThis as any).__cpaComposerSkills).toEqual([])
    })
})
