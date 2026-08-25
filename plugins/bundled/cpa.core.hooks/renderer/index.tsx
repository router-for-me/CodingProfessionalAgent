import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, SettingsSectionContribution } from '@cpa/plugin-api'
import { Anchor } from '@cpa/plugin-ui'
import { HooksSection } from './components/HooksSection.js'

export { HooksSection }

export const hooksRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.register<SettingsSectionContribution>({
            kind: 'settings',
            id: 'hooks',
            value: {
                id: 'hooks',
                groupId: 'code',
                order: 10,
                labelKey: 'settings.nav.hooks',
                icon: Anchor,
                component: HooksSection,
                keywords: ['hooks', 'lifecycle', 'events', 'scripts', 'command'],
                items: [
                    {
                        id: 'hooksConfig',
                        labelKey: 'settings.hooks.title',
                        descriptionKey: 'settings.hooks.subtitle',
                        keywords: ['hooks', 'lifecycle'],
                    },
                    {
                        id: 'userConfig',
                        labelKey: 'settings.hooks.userConfig',
                        keywords: ['user config'],
                    },
                    {
                        id: 'projectConfig',
                        labelKey: 'settings.hooks.projectConfig',
                        keywords: ['project config'],
                    },
                    {
                        id: 'addHook',
                        labelKey: 'settings.hooks.addHook',
                        keywords: ['add hook'],
                    },
                ],
            },
        })
    },
})

export const entry = hooksRendererEntry
export default hooksRendererEntry
