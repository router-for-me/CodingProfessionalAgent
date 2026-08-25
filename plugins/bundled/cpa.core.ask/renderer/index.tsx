import { definePluginEntry } from '@cpa/plugin-sdk'
import type { FloatingContribution, PluginContext } from '@cpa/plugin-api'
import { getDefaultHostServices } from '@cpa/plugin-ui'
import { AskOverlay } from './AskOverlay.js'
import { useAskStore } from '../shared/askStore.js'

export { AskOverlay }

export const askRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.register<FloatingContribution>({
            kind: 'floating',
            id: 'ask-overlay',
            value: {
                id: 'ask-overlay',
                pluginId: 'cpa.core.ask',
                anchor: '[data-element="composer-container"]',
                placement: 'cover-bottom',
                offset: { y: 0 },
                visible: (ctx: any) => {
                    const hostServices = (context as any).services ?? getDefaultHostServices()
                    const sid =
                        ctx && typeof ctx === 'object' && 'sessionId' in ctx
                            ? String((ctx as { sessionId: unknown }).sessionId || '')
                            : hostServices?.sessions?.getCurrentSessionId?.() || ''
                    if (!sid) return false
                    return Boolean(useAskStore.getState().requestsBySession[sid])
                },
                component: AskOverlay,
            },
        })
    },
    deactivate() {
        useAskStore.getState().clearAll()
    },
})

export const entry = askRendererEntry
export default askRendererEntry
