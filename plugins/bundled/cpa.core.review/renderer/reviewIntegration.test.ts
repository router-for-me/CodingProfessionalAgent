import { describe, expect, it } from 'vitest'
import { RendererPluginRuntimeHost } from '../../../../frontend/src/plugins/platform/RendererPluginRuntimeHost.js'
import { RendererRegistry } from '../../../../frontend/src/plugins/platform/rendererRegistry.js'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { reviewRendererEntry } from './index.js'
import reviewManifest from '../manifest.json'
import sessionManagerManifest from '../../cpa.core.session-manager/manifest.json'
import { sessionManagerRendererEntry } from '../../cpa.core.session-manager/renderer/index.js'

describe('cpa.core.review runtime integration', () => {
    it('activates cpa.core.review through RendererPluginRuntimeHost without legacy adapters', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const host = new RendererPluginRuntimeHost({
            registry,
            eventBus,
            defaultDefinitions: {
                'cpa.core.session-manager': sessionManagerRendererEntry,
                'cpa.core.review': reviewRendererEntry,
            },
            bundledPackages: [
                {
                    manifest: sessionManagerManifest as any,
                    entries: sessionManagerManifest.entries,
                    sourceRoot: 'plugins/bundled/cpa.core.session-manager',
                    source: { kind: 'bundled', spec: 'bundled:cpa.core.session-manager' },
                },
                {
                    manifest: reviewManifest as any,
                    entries: reviewManifest.entries,
                    sourceRoot: 'plugins/bundled/cpa.core.review',
                    source: { kind: 'bundled', spec: 'bundled:cpa.core.review' },
                },
            ],
            enabledPluginIds: ['cpa.core.session-manager', 'cpa.core.review'],
        })

        await host.activatePlugin('cpa.core.session-manager')
        await host.activatePlugin('cpa.core.review')

        expect(host.isPluginActive('cpa.core.review')).toBe(true)

        const panels = registry.getPanels()
        expect(panels.some((p: any) => p.id === 'review')).toBe(true)

        const chatRenderers = registry.getChatRenderers()
        expect(chatRenderers.some((r: any) => r.id === 'review-diff-tool-card')).toBe(true)
    })
})
