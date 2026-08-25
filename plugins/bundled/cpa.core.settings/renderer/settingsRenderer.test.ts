import { describe, expect, it, vi } from 'vitest'
import { createPluginTestHarness } from '@cpa/plugin-sdk'
import type { ActionContribution, SettingsGroupContribution, SettingsSectionContribution } from '@cpa/plugin-api'
import {
    GeneralSection,
    AppearanceSection,
    PersonalizationSection,
    ShortcutsSection,
    ConnectionsSection,
    PluginsSection,
    GitSection,
    EnvironmentsSection,
    settingsRendererEntry,
} from './index.js'
import manifest from '../manifest.json' with { type: 'json' }

describe('settingsRendererEntry', () => {
    it('declares valid core metadata in manifest', () => {
        expect(manifest.id).toBe('cpa.core.settings')
        expect(manifest.name).toBe('Settings')
        expect(manifest.entries?.renderer).toBe('./renderer/index.tsx')
        expect(manifest.contributes?.['settings-group']).toEqual(['personal', 'integrations', 'code'])
    })

    it('registers settings groups, sections, and actions on activation, and cleans up on deactivation', async () => {
        const mockUiService = {
            openSettings: vi.fn(),
            pushToast: vi.fn(),
        }

        const harness = createPluginTestHarness(settingsRendererEntry, {
            manifest,
            services: {
                ui: mockUiService,
            },
        })

        await harness.activate()

        // 1. Settings Groups (no unauthorized 'archived' group)
        const groups = harness.getRegistered<SettingsGroupContribution>('settings-group')
        expect(groups.map((g) => g.id)).toEqual(['personal', 'integrations', 'code'])
        expect(groups.find((g) => g.id === 'personal')?.value.order).toBe(10)
        expect(groups.find((g) => g.id === 'integrations')?.value.order).toBe(20)
        expect(groups.find((g) => g.id === 'code')?.value.order).toBe(30)

        // 2. Settings Sections
        const sections = harness.getRegistered<SettingsSectionContribution>('settings')
        expect(sections.map((s) => s.id)).toEqual([
            'general',
            'appearance',
            'personalization',
            'shortcuts',
            'connections',
            'plugins',
            'git',
            'environments',
        ])

        const sectionMap = new Map(sections.map((s) => [s.id, s.value]))
        expect(sectionMap.get('general')).toMatchObject({
            id: 'general',
            groupId: 'personal',
            order: 10,
            labelKey: 'settings.nav.general',
            component: GeneralSection,
        })
        expect(sectionMap.get('appearance')).toMatchObject({
            id: 'appearance',
            groupId: 'personal',
            order: 20,
            labelKey: 'settings.nav.appearance',
            component: AppearanceSection,
        })
        expect(sectionMap.get('personalization')).toMatchObject({
            id: 'personalization',
            groupId: 'personal',
            order: 30,
            labelKey: 'settings.nav.personalization',
            component: PersonalizationSection,
        })
        expect(sectionMap.get('shortcuts')).toMatchObject({
            id: 'shortcuts',
            groupId: 'personal',
            order: 40,
            labelKey: 'settings.nav.shortcuts',
            component: ShortcutsSection,
        })
        expect(sectionMap.get('connections')).toMatchObject({
            id: 'connections',
            groupId: 'integrations',
            order: 10,
            labelKey: 'settings.nav.connections',
            component: ConnectionsSection,
        })
        expect(sectionMap.get('plugins')).toMatchObject({
            id: 'plugins',
            groupId: 'integrations',
            order: 20,
            labelKey: 'settings.nav.plugins',
            component: PluginsSection,
        })
        expect(sectionMap.get('git')).toMatchObject({
            id: 'git',
            groupId: 'code',
            order: 30,
            labelKey: 'settings.nav.git',
            component: GitSection,
        })
        expect(sectionMap.get('environments')).toMatchObject({
            id: 'environments',
            groupId: 'code',
            order: 40,
            labelKey: 'settings.nav.environments',
            component: EnvironmentsSection,
        })

        // 3. Actions and Placements
        const actions = harness.getRegistered<ActionContribution>('action')
        expect(actions.map((a) => a.id)).toEqual(['settings', 'user.logout', 'keyboard-shortcuts'])

        const actionMap = new Map(actions.map((a) => [a.id, a.value]))

        const settingsAction = actionMap.get('settings')
        expect(settingsAction).toMatchObject({
            id: 'settings',
            title: 'settings.title',
            defaultShortcuts: ['Meta+,'],
            placements: [{ surface: 'menu.user', order: 40 }],
        })
        settingsAction?.handler({ services: { ui: mockUiService } } as any)
        expect(mockUiService.openSettings).toHaveBeenCalledWith()

        const logoutAction = actionMap.get('user.logout')
        expect(logoutAction).toMatchObject({
            id: 'user.logout',
            title: 'user.logout',
            placements: [{ surface: 'menu.user', order: 50 }],
        })
        logoutAction?.handler({ services: { ui: mockUiService } } as any)
        expect(mockUiService.pushToast).toHaveBeenCalledWith('user.logout.mock')

        const kbAction = actionMap.get('keyboard-shortcuts')
        expect(kbAction).toMatchObject({
            id: 'keyboard-shortcuts',
            title: 'shortcuts.item.keyboardShortcuts.title',
        })
        kbAction?.handler({ services: { ui: mockUiService } } as any)
        expect(mockUiService.openSettings).toHaveBeenCalledWith('shortcuts')

        // 4. Clean deactivation
        await harness.deactivate()
        expect(harness.getRegistered('settings-group')).toHaveLength(0)
        expect(harness.getRegistered('settings')).toHaveLength(0)
        expect(harness.getRegistered('action')).toHaveLength(0)
    })
})
