import { describe, expect, it } from 'vitest'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { RendererPluginRuntimeHost } from '@/plugins/platform/RendererPluginRuntimeHost'
import { RendererRegistry } from '@/plugins/platform/rendererRegistry'
import { sessionManagerRendererEntry, SidebarNavTop, SidebarSessionList } from './index'
import manifest from '../manifest.json' with { type: 'json' }

describe('sessionManagerPlugin', () => {
    it('has the correct manifest metadata', () => {
        expect(manifest).toMatchObject({
            id: 'cpa.core.session-manager',
            name: 'Session & Project Manager',
            version: '1.0.0',
            apiVersion: '1.0.0',
        })
    })

    it('registers sidebar slots and controls when activated in PluginManager', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const manager = new RendererPluginRuntimeHost({
            registry,
            eventBus,
            defaultDefinitions: {
                'cpa.core.session-manager': sessionManagerRendererEntry,
            },
        })

        await manager.activatePlugin('cpa.core.session-manager')

        const navTopContributions = registry.getSlotContributions('layout.sidebar.nav.top')
        expect(navTopContributions).toHaveLength(1)
        expect(navTopContributions[0]).toMatchObject({
            id: 'sidebar-nav-top',
            pluginId: 'cpa.core.session-manager',
            order: 10,
            component: SidebarNavTop,
        })

        const contentContributions = registry.getSlotContributions('layout.sidebar.content')
        expect(contentContributions).toHaveLength(1)
        expect(contentContributions[0]).toMatchObject({
            id: 'sidebar-session-list',
            pluginId: 'cpa.core.session-manager',
            order: 10,
            component: SidebarSessionList,
        })
    })

    it('unregisters sidebar slots when deactivated', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const manager = new RendererPluginRuntimeHost({
            registry,
            eventBus,
            defaultDefinitions: {
                'cpa.core.session-manager': sessionManagerRendererEntry,
            },
        })

        await manager.activatePlugin('cpa.core.session-manager')

        expect(registry.getSlotContributions('layout.sidebar.nav.top')).toHaveLength(1)
        expect(registry.getSlotContributions('layout.sidebar.content')).toHaveLength(1)

        await manager.deactivatePlugin('cpa.core.session-manager')

        expect(registry.getSlotContributions('layout.sidebar.nav.top')).toHaveLength(0)
        expect(registry.getSlotContributions('layout.sidebar.content')).toHaveLength(0)
    })
})
