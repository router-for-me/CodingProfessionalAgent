import { ModelCatalogServiceToken, type SettingsSectionContribution } from '@cpa/plugin-api'
import { definePluginEntry } from '@cpa/plugin-sdk'
import { Globe } from '@cpa/plugin-ui'
import { SearchSettings } from './SearchSettings.js'

export const entry = definePluginEntry({
    runtime: 'renderer',
    activate(context) {
        context.register<SettingsSectionContribution>({
            kind: 'settings', id: 'web-search',
            value: {
                id: 'web-search', groupId: 'integrations', order: 35,
                labelKey: 'webSearch.title', icon: Globe,
                keywords: ['web', 'search', '搜索', '联网'],
                component: () => <SearchSettings client={context.capabilityClient} catalog={context.getService(ModelCatalogServiceToken)} />,
            },
        })
    },
})
export default entry
