import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    ActionContribution,
    ActionExecutionContext,
    PluginContext,
    SettingsSectionContribution,
    UiService,
} from '@cpa/plugin-api'
import { UiServiceToken } from '@cpa/plugin-api'
import { Gauge } from '@cpa/plugin-ui'
import { UsageStatsSection } from './components/UsageStatsSection.js'

export { UsageStatsSection }

export const usageStatsRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Usage Stats Settings Section
        context.register<SettingsSectionContribution>({
            kind: 'settings',
            id: 'usage',
            value: {
                id: 'usage',
                groupId: 'personal',
                order: 50,
                labelKey: 'settings.nav.usage',
                icon: Gauge,
                component: UsageStatsSection,
                keywords: ['usage', 'billing', 'tokens', 'cost', 'metrics', 'stats'],
                items: [
                    {
                        id: 'tokenActivity',
                        labelKey: 'settings.profile.tokenActivity',
                        keywords: ['token activity', 'tokens'],
                    },
                    {
                        id: 'activityInsights',
                        labelKey: 'settings.profile.activityInsights',
                        keywords: ['activity insights', 'speed', 'reasoning'],
                    },
                    {
                        id: 'skillUsage',
                        labelKey: 'settings.profile.skillUsage',
                        keywords: ['skill usage', 'skills'],
                    },
                    {
                        id: 'topModels',
                        labelKey: 'settings.profile.topModels',
                        keywords: ['top models', 'models'],
                    },
                ],
            },
        })

        // 2. Register Action
        context.register<ActionContribution>({
            kind: 'action',
            id: 'user.remainingUsage',
            value: {
                id: 'user.remainingUsage',
                title: 'user.remainingUsage',
                icon: Gauge,
                placements: [{ surface: 'menu.user', order: 10, hasSubmenu: true } as any],
                handler: (execCtx?: ActionExecutionContext) => {
                    const uiService = (execCtx?.services as any)?.ui ?? context.getService?.<UiService>(UiServiceToken)
                    uiService?.pushToast?.('user.remainingUsage.mock')
                    void context.events?.emit?.('user:remaining-usage', {})
                },
            },
        })
    },
})

export const entry = usageStatsRendererEntry
export default usageStatsRendererEntry
