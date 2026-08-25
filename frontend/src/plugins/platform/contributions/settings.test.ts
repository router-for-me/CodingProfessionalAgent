import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { RendererRegistry } from '../rendererRegistry'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { RendererPluginRuntimeHost } from '../RendererPluginRuntimeHost'
import {
    selectSettingsNavigation,
    filterSettingsNavigation,
    searchSettingsSections,
    selectSettingsSections,
} from './settings'

describe('Settings Contributions & Navigation Selector', () => {
    const existingSettingsNavigationSnapshot = [
        ['personal', ['general', 'appearance', 'personalization', 'shortcuts', 'usage']],
        ['integrations', ['connections', 'plugins']],
        ['code', ['hooks', 'models', 'git', 'environments', 'worktrees']],
        ['archived', ['archived']],
    ]

    it('keeps the existing settings group and section order', async () => {
        const registry = new RendererRegistry()
        const eventBus = new PluginEventBus()
        const manager = new RendererPluginRuntimeHost({ registry, eventBus })

        await manager.activatePlugin('cpa.core.session-manager')
        await manager.activatePlugin('cpa.core.settings')
        await manager.activatePlugin('cpa.core.worktree')
        await manager.activatePlugin('cpa.core.usage-stats')
        await manager.activatePlugin('cpa.core.hooks')
        await manager.activatePlugin('cpa.core.protocol-codex')
        await manager.activatePlugin('cpa.core.memories')

        const nav = selectSettingsNavigation(registry)
        expect(
            nav.map((group) => [
                group.id,
                group.sections.map((section) => section.id),
            ])
        ).toEqual(existingSettingsNavigationSnapshot)
    })

    it('places dynamic sections without groupId into fallback extensions group', () => {
        const registry = new RendererRegistry()
        registry.registerSettingsGroup({
            id: 'personal',
            order: 10,
            labelKey: 'settings.nav.group.personal',
        })
        registry.registerSettingsSection({
            id: 'general',
            groupId: 'personal',
            order: 10,
            labelKey: 'settings.nav.general',
            component: () => null,
        })
        registry.registerSettingsSection({
            id: 'custom-ext',
            order: 50,
            labelKey: 'Custom Extension',
            component: () => null,
        })

        const nav = selectSettingsNavigation(registry)
        expect(nav).toHaveLength(2)
        expect(nav[0]?.id).toBe('personal')
        expect(nav[0]?.sections.map((s) => s.id)).toEqual(['general'])
        expect(nav[1]?.id).toBe('extensions')
        expect(nav[1]?.labelKey).toBe('settings.nav.group.extensions')
        expect(nav[1]?.sections.map((s) => s.id)).toEqual(['custom-ext'])
    })

    it('filters settings navigation by label, id, and keywords', () => {
        const registry = new RendererRegistry()
        registry.registerSettingsGroup({
            id: 'personal',
            order: 10,
            labelKey: 'settings.nav.group.personal',
        })
        registry.registerSettingsGroup({
            id: 'code',
            order: 20,
            labelKey: 'settings.nav.group.code',
        })
        registry.registerSettingsSection({
            id: 'general',
            groupId: 'personal',
            order: 10,
            labelKey: 'settings.nav.general',
            keywords: ['language', 'theme'],
            component: () => null,
        })
        registry.registerSettingsSection({
            id: 'hooks',
            groupId: 'code',
            order: 10,
            labelKey: 'settings.nav.hooks',
            keywords: ['lifecycle', 'scripts'],
            component: () => null,
        })

        const nav = selectSettingsNavigation(registry)
        const t = (key: string) => {
            if (key === 'settings.nav.general') return 'General'
            if (key === 'settings.nav.hooks') return 'Hooks'
            return key
        }

        // Search by translated label
        const matchLabel = filterSettingsNavigation(nav, 'General', t)
        expect(matchLabel).toHaveLength(1)
        expect(matchLabel[0]?.id).toBe('personal')
        expect(matchLabel[0]?.sections.map((s) => s.id)).toEqual(['general'])

        // Search by keyword
        const matchKeyword = filterSettingsNavigation(nav, 'scripts', t)
        expect(matchKeyword).toHaveLength(1)
        expect(matchKeyword[0]?.id).toBe('code')
        expect(matchKeyword[0]?.sections.map((s) => s.id)).toEqual(['hooks'])

        // Search by id
        const matchId = filterSettingsNavigation(nav, 'general', t)
        expect(matchId).toHaveLength(1)
        expect(matchId[0]?.id).toBe('personal')

        // Empty result
        const noMatch = filterSettingsNavigation(nav, 'nonexistent', t)
        expect(noMatch).toHaveLength(0)
    })

    it('searches sub-items across languages and returns matched items', () => {
        const registry = new RendererRegistry()
        registry.registerSettingsGroup({
            id: 'personal',
            order: 10,
            labelKey: 'settings.nav.group.personal',
        })
        registry.registerSettingsSection({
            id: 'general',
            groupId: 'personal',
            order: 10,
            labelKey: 'settings.nav.general',
            component: () => null,
            items: [
                {
                    id: 'language',
                    labelKey: 'settings.language',
                    descriptionKey: 'settings.general.language.desc',
                    keywords: ['language', 'locale'],
                },
                {
                    id: 'terminalPosition',
                    labelKey: 'settings.general.terminalPosition',
                    descriptionKey: 'settings.general.terminalPosition.desc',
                    keywords: ['terminal'],
                },
            ],
        })

        const sections = selectSettingsSections(registry)

        // 1. Search in keyword: "locale"
        const resultsZh = searchSettingsSections(sections, 'locale', i18n.t, i18n)
        expect(resultsZh).toHaveLength(1)
        expect(resultsZh[0]?.section.id).toBe('general')
        expect(resultsZh[0]?.matchedItems.map((i) => i.id)).toEqual(['language'])

        // 2. Search in English: "Language" (multi-language matching)
        const resultsEn = searchSettingsSections(sections, 'Language', i18n.t, i18n)
        expect(resultsEn).toHaveLength(1)
        expect(resultsEn[0]?.section.id).toBe('general')
        expect(resultsEn[0]?.matchedItems.map((i) => i.id)).toEqual(['language'])

        // 3. Search by sub-item description across languages: "terminal"
        const resultsTerminal = searchSettingsSections(sections, 'terminal', i18n.t, i18n)
        expect(resultsTerminal).toHaveLength(1)
        expect(resultsTerminal[0]?.matchedItems.map((i) => i.id)).toEqual(['terminalPosition'])

        // 4. filterSettingsNavigation also keeps section matching via sub-items
        const nav = selectSettingsNavigation(registry)
        const filteredNav = filterSettingsNavigation(nav, 'locale', i18n.t, i18n)
        expect(filteredNav).toHaveLength(1)
        expect(filteredNav[0]?.sections.map((s) => s.id)).toEqual(['general'])
    })
})
