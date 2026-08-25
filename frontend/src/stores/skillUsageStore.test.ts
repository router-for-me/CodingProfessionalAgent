import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillUsageStore } from './skillUsageStore'

describe('skillUsageStore', () => {
    beforeEach(() => {
        useSkillUsageStore.getState().reset()
        vi.restoreAllMocks()
    })

    it('records and increments usage counts case-insensitively', () => {
        useSkillUsageStore.getState().recordUsage('gh-issue')
        expect(useSkillUsageStore.getState().usageCounts['gh-issue']).toBe(1)

        useSkillUsageStore.getState().recordUsage('GH-ISSUE', 4)
        expect(useSkillUsageStore.getState().usageCounts['gh-issue']).toBe(5)

        useSkillUsageStore.getState().recordUsage('fix-issue', 10)
        expect(useSkillUsageStore.getState().usageCounts['fix-issue']).toBe(10)
    })

    it('ignores empty skill names', () => {
        useSkillUsageStore.getState().recordUsage('')
        useSkillUsageStore.getState().recordUsage('   ')
        expect(useSkillUsageStore.getState().usageCounts).toEqual({})
    })

    it('sets usage counts directly', () => {
        useSkillUsageStore.getState().setUsageCounts({
            'gh-issue': 100,
            'fix-issue': 95,
        })
        expect(useSkillUsageStore.getState().usageCounts).toEqual({
            'gh-issue': 100,
            'fix-issue': 95,
        })
    })

    it('resets usage counts', () => {
        useSkillUsageStore.getState().setUsageCounts({
            'gh-issue': 100,
        })
        expect(useSkillUsageStore.getState().usageCounts).toEqual({
            'gh-issue': 100,
        })
        useSkillUsageStore.getState().reset()
        expect(useSkillUsageStore.getState().usageCounts).toEqual({})
    })
})
