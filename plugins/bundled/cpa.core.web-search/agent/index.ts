import { ModelCatalogServiceToken, type ToolFactoryContribution } from '@cpa/plugin-api'
import { definePluginEntry } from '@cpa/plugin-sdk'
import { parseSettings, SETTINGS_KEY } from '../shared/types.js'
import { createWebSearchTool, SEARCH_DESCRIPTION, SEARCH_PARAMETERS } from './webSearchTool.js'

export const entry = definePluginEntry({
    runtime: 'agent',
    activate(context) {
        const getSettings = async () => parseSettings(await context.capabilityClient?.invoke('kvstore:get', [SETTINGS_KEY]))
        context.register<ToolFactoryContribution>({
            kind: 'tool-factory', id: 'web_search',
            value: {
                id: 'web_search', name: 'web_search', label: 'Web Search',
                description: SEARCH_DESCRIPTION, parameters: SEARCH_PARAMETERS,
                targets: ['main', 'all'], order: 170,
                riskLevel: 'network', requiresApproval: true, approvalCategory: 'network',
                async create() {
                    if (!(await getSettings()).enabled) return null
                    const catalog = context.getService(ModelCatalogServiceToken)
                    return createWebSearchTool({
                        getSettings,
                        getModels: () => catalog.getModels(),
                        isCatalogReady: () => ['ready', 'success'].includes(catalog.getStatus?.() ?? 'idle'),
                    })
                },
            },
        })
    },
})
export default entry
