import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext } from '@cpa/plugin-api'
import { FileChangesToolCard } from './components/FileChangesToolCard.js'

export { FileChangesToolCard }

export const fileChangesRendererEntry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.registerChatRenderer?.({
            id: 'file-changes-tool-card',
            priority: 50,
            matches: (part: any) =>
                part?.type === 'tool_call' &&
                (part?.name === 'file_changes' ||
                    part?.name === 'track_file_changes' ||
                    part?.name === 'fileChanges'),
            component: FileChangesToolCard,
        })
    },
})

export const entry = fileChangesRendererEntry
export default fileChangesRendererEntry
