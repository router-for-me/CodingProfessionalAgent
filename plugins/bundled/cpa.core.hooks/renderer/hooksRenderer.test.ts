import { describe, expect, it } from 'vitest'
import { hooksRendererEntry } from './index.js'
import type { PluginContext, SettingsSectionContribution } from '@cpa/plugin-api'

describe('cpa.core.hooks renderer entry', () => {
    it('activates and registers hooks settings section', async () => {
        const registered = new Map<string, SettingsSectionContribution>()
        const fakeContext: Partial<PluginContext> = {
            register: ((contrib: any) => {
                if (contrib.kind === 'settings') {
                    registered.set(contrib.id, contrib.value)
                }
            }) as any,
        }

        hooksRendererEntry.activate(fakeContext as PluginContext)

        expect(registered.has('hooks')).toBe(true)
        const hookSetting = registered.get('hooks')!
        expect(hookSetting.id).toBe('hooks')
        expect(hookSetting.groupId).toBe('code')
        expect(hookSetting.order).toBe(10)
        expect(hookSetting.labelKey).toBe('settings.nav.hooks')
        expect(hookSetting.component).toBeDefined()
        expect(hookSetting.keywords).toContain('hooks')
        expect(hookSetting.keywords).toContain('lifecycle')
    })
})
