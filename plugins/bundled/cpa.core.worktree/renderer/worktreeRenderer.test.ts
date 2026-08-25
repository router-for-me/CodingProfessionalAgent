import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ActionContribution, SettingsSectionContribution } from '@cpa/plugin-api'
import { worktreeRendererEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.worktree renderer entry', () => {
    it('activates and registers worktrees settings section and action', async () => {
        const harness = createPluginTestHarness(worktreeRendererEntry, {
            manifest,
        })

        await harness.activate()

        const sections = harness.getRegistered<SettingsSectionContribution>('settings')
        expect(sections).toHaveLength(1)
        expect(sections[0]?.id).toBe('worktrees')
        expect(sections[0]?.value.groupId).toBe('code')

        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions).toHaveLength(1)
        expect(actions[0]?.id).toBe('toggle-local-worktree')

        await harness.deactivate()
        expect(harness.registrations).toHaveLength(0)
    })
})
