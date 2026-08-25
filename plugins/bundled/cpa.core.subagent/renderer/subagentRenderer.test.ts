import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ChatRendererContribution,
    PanelContribution,
    SettingsSectionContribution,
    SlotContribution,
} from '@cpa/plugin-api'
import { subagentRendererEntry } from './index.js'

describe('subagentRendererEntry', () => {
    it('defines a valid renderer entry for cpa.core.subagent', () => {
        expect(subagentRendererEntry.runtime).toBe('renderer')
        expect(typeof subagentRendererEntry.activate).toBe('function')
    })

    it('registers slot, panel, actions, and chat renderer on activation', async () => {
        const mockUiService = {
            openRightPanelTab: vi.fn(),
            pushToast: vi.fn(),
        }

        const harness = createPluginTestHarness(subagentRendererEntry, {
            manifest: {
                id: 'cpa.core.subagent',
                name: 'Subagents',
                version: '1.0.0',
                apiVersion: '1.0.0',
                engines: { cpa: '>=1.0.0' },
                entries: {
                    renderer: './renderer/index.tsx',
                    agent: './agent/index.ts',
                },
                dependencies: { 'cpa.core.chat': '>=1.0.0' },
                capabilities: ['agent.subagents', 'sessions.read'],
                contributes: {
                    slot: ['subagent-content', 'subagent-pills-slot', 'pinned-summary-subagents'],
                    panel: ['subagent'],
                    settings: ['subagents'],
                    action: ['toggle-activity-view', 'show-pet'],
                    'chat-renderer': ['subagent-pills'],
                    'tool-factory': ['spawn_agent', 'send_message', 'stop_agent'],
                },
            },
            services: {
                ui: mockUiService,
                subAgents: {
                    getAgents: () => [],
                    getFocusedId: () => null,
                },
            } as any,
        })

        await harness.activate()

        const slots = harness.getRegistered<SlotContribution>('slot')
        expect(slots).toHaveLength(3)
        expect(slots.map((slot) => slot.id).sort()).toEqual([
            'pinned-summary-subagents',
            'subagent-content',
            'subagent-pills-slot',
        ])
        expect(slots.find((slot) => slot.id === 'subagent-content')?.target).toBe('layout.right_panel.content')
        expect(slots.find((slot) => slot.id === 'subagent-pills-slot')?.target).toBe('chat.message.subagents')
        expect(slots.find((slot) => slot.id === 'pinned-summary-subagents')?.target).toBe('pinned.summary.subagents')

        const panels = harness.getRegistered<PanelContribution>('panel')
        expect(panels).toHaveLength(1)
        expect(panels[0].id).toBe('subagent')
        expect(panels[0].value.title).toBe('Subagents')
        expect(panels[0].value.instancePolicy).toBe('multiple')

        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions).toHaveLength(2)
        expect(actions.map((a) => a.id).sort()).toEqual(['show-pet', 'toggle-activity-view'])

        // Test toggle activity view action
        const toggleAction = actions.find((a) => a.id === 'toggle-activity-view')
        toggleAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.openRightPanelTab).toHaveBeenCalledWith('subagent')

        // Test show pet action
        const petAction = actions.find((a) => a.id === 'show-pet')
        petAction?.value.handler?.({ services: { ui: mockUiService } } as any)
        expect(mockUiService.pushToast).toHaveBeenCalledWith('toast.comingSoon')

        const chatRenderers = harness.getRegistered<ChatRendererContribution>('chat-renderer')
        expect(chatRenderers).toHaveLength(1)
        expect(chatRenderers[0].id).toBe('subagent-pills')
        expect(chatRenderers[0].value.target).toBe('part')
        expect(chatRenderers[0].value.groupKey).toBe('subagent')
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'spawn_agent' })).toBe(true)
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'delegate_agent' })).toBe(true)
        expect(chatRenderers[0].value.matches?.({ type: 'tool_call', name: 'other' })).toBe(false)

        const settings = harness.getRegistered<SettingsSectionContribution>('settings')
        expect(settings).toHaveLength(1)
        expect(settings[0].id).toBe('subagents')
        expect(settings[0].value.groupId).toBe('code')
        expect(settings[0].value.order).toBe(25)
        expect(settings[0].value.labelKey).toBe('settings.nav.subagents')
    })
})
