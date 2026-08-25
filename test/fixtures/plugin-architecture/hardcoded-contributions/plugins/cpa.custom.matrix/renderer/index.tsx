import { definePluginEntry } from '@cpa/plugin-sdk'

export default definePluginEntry({
    runtime: 'renderer',
    activate(context) {
        context.contributions.registerView({ id: 'custom-matrix-view', component: () => null })
    },
})
