import { describe, expect, it } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { NavigationContribution, ViewContribution } from '@cpa/plugin-api'
import { homeRendererEntry } from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('cpa.core.home renderer entry', () => {
    it('activates and registers home view and navigation item', async () => {
        const harness = createPluginTestHarness(homeRendererEntry, {
            manifest,
        })

        await harness.activate()

        const views = harness.getRegistered<ViewContribution>('view')
        expect(views).toHaveLength(1)
        expect(views[0]?.id).toBe('home')
        expect(views[0]?.value.path).toBe('/')
        expect(views[0]?.value.layout.showComposer).toBe(true)
        expect(views[0]?.value.layout.reserveWindowToolbar).toBe(true)

        const navs = harness.getRegistered<NavigationContribution>('navigation')
        expect(navs).toHaveLength(1)
        expect(navs[0]?.id).toBe('home')
        expect(navs[0]?.value.viewId).toBe('home')
        expect(navs[0]?.value.order).toBe(10)
    })
})
