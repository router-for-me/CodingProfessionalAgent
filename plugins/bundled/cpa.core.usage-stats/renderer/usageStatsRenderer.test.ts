import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ActionContribution, SettingsSectionContribution } from '@cpa/plugin-api'
import { usageStatsRendererEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.usage-stats renderer entry', () => {
    it('activates and registers usage settings section and action', async () => {
        const mockUiService = {
            pushToast: vi.fn(),
        }

        const harness = createPluginTestHarness(usageStatsRendererEntry, {
            manifest,
            services: {
                ui: mockUiService,
            },
        })

        await harness.activate()

        const sections = harness.getRegistered<SettingsSectionContribution>('settings')
        expect(sections).toHaveLength(1)
        expect(sections[0]?.id).toBe('usage')
        expect(sections[0]?.value.groupId).toBe('personal')

        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions).toHaveLength(1)
        expect(actions[0]?.id).toBe('user.remainingUsage')

        // Test action handler
        actions[0]?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.pushToast).toHaveBeenCalledWith('user.remainingUsage.mock')

        await harness.deactivate()
        expect(harness.registrations).toHaveLength(0)
    })
})
