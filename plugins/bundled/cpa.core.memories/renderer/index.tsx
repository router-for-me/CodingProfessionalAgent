import { createElement, type ComponentType } from 'react'
import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext } from '@cpa/plugin-api'
import { MemorySettingsSection } from './components/MemorySettingsSection.js'

export { MemorySettingsSection }

export const memoriesRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.registerComponentWrapper?.({
            id: 'cpa.memories.personalization-wrapper',
            pluginId: context.manifest?.id ?? 'cpa.core.memories',
            targetComponent: 'PersonalizationSection',
            order: 20,
            wrapper: (BaseComponent: ComponentType<Record<string, unknown>>) => {
                return function WrappedPersonalization(props: Record<string, unknown>) {
                    return createElement(
                        BaseComponent,
                        props,
                        createElement(MemorySettingsSection),
                    )
                }
            },
        })
    },
})

export const entry = memoriesRendererEntry
export default memoriesRendererEntry
