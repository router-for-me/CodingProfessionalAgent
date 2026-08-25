import { describe, expect, it } from 'vitest'
import { RendererPluginRuntimeHost } from '../../../../frontend/src/plugins/platform/RendererPluginRuntimeHost.js'
import { RendererRegistry } from '../../../../frontend/src/plugins/platform/rendererRegistry.js'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { subagentRendererEntry } from './index.js'
import subagentManifest from '../manifest.json'
import chatManifest from '../../cpa.core.chat/manifest.json'
import { chatRendererEntry } from '../../cpa.core.chat/renderer/index.js'
import sessionManagerManifest from '../../cpa.core.session-manager/manifest.json'
import { sessionManagerRendererEntry } from '../../cpa.core.session-manager/renderer/index.js'

describe('cpa.core.subagent runtime integration', () => {
    it('activates cpa.core.subagent through RendererPluginRuntimeHost without legacy adapters', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const host = new RendererPluginRuntimeHost({
            registry,
            eventBus,
            defaultDefinitions: {
                'cpa.core.session-manager': sessionManagerRendererEntry,
                'cpa.core.chat': chatRendererEntry,
                'cpa.core.subagent': subagentRendererEntry,
            },
            bundledPackages: [
                {
                    manifest: sessionManagerManifest as any,
                    entries: sessionManagerManifest.entries,
                    sourceRoot: 'plugins/bundled/cpa.core.session-manager',
                    source: { kind: 'bundled', spec: 'bundled:cpa.core.session-manager' },
                },
                {
                    manifest: chatManifest as any,
                    entries: chatManifest.entries,
                    sourceRoot: 'plugins/bundled/cpa.core.chat',
                    source: { kind: 'bundled', spec: 'bundled:cpa.core.chat' },
                },
                {
                    manifest: subagentManifest as any,
                    entries: subagentManifest.entries,
                    sourceRoot: 'plugins/bundled/cpa.core.subagent',
                    source: { kind: 'bundled', spec: 'bundled:cpa.core.subagent' },
                },
            ],
            enabledPluginIds: ['cpa.core.session-manager', 'cpa.core.chat', 'cpa.core.subagent'],
        })

        await host.activatePlugin('cpa.core.session-manager')
        await host.activatePlugin('cpa.core.chat')
        await host.activatePlugin('cpa.core.subagent')

        expect(host.isPluginActive('cpa.core.subagent')).toBe(true)

        const panels = registry.getPanels()
        expect(panels.some((p: any) => p.id === 'subagent')).toBe(true)

        const chatRenderers = registry.getChatRenderers()
        expect(chatRenderers.some((r: any) => r.id === 'subagent-pills')).toBe(true)

        const subagentPillsSlot = registry.getSlotContributions('chat.message.subagents')
        expect(subagentPillsSlot.some((slot: any) => slot.id === 'subagent-pills-slot')).toBe(true)

        const pinnedSubagentsSlot = registry.getSlotContributions('pinned.summary.subagents')
        expect(pinnedSubagentsSlot.some((slot: any) => slot.id === 'pinned-summary-subagents')).toBe(true)

        const settingsSections = registry.getSettingsSections()
        expect(settingsSections.some((s: any) => s.id === 'subagents')).toBe(true)
    })
})
