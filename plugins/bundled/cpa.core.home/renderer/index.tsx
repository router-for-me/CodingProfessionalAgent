import { definePluginEntry } from '@cpa/plugin-sdk'
import type { NavigationContribution, PluginContext, ViewContribution } from '@cpa/plugin-api'
import { SquarePen } from '@cpa/plugin-ui'
import { HomeEmpty } from './components/HomeEmpty.js'

export { HomeEmpty }

export const homeRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        // 1. Register Home View
        context.register<ViewContribution>({
            kind: 'view',
            id: 'home',
            value: {
                id: 'home',
                path: '/',
                component: HomeEmpty,
                layout: {
                    showComposer: true,
                    rightPanelMode: 'default',
                    reserveWindowToolbar: true,
                },
            },
        })

        // 2. Register Navigation Item
        context.register<NavigationContribution>({
            kind: 'navigation',
            id: 'home',
            value: {
                id: 'home',
                viewId: 'home',
                order: 10,
                labelKey: 'nav.newChat',
                icon: SquarePen,
            },
        })
    },
})

export const entry = homeRendererEntry
export default homeRendererEntry
