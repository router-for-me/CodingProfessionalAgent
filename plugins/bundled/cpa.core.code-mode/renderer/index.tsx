import { definePluginEntry } from '@cpa/plugin-sdk'
import type { ChatRendererContribution, PluginContext, SettingsSectionContribution } from '@cpa/plugin-api'
import { CodeModeSettings } from './settings'
import { ExecToolCard } from './ExecToolCard'

export const entry = definePluginEntry({
    runtime: 'renderer',
    activate(context: PluginContext) {
        context.register<SettingsSectionContribution>({ kind: 'settings', id: 'code-mode', value: {
            id: 'code-mode', groupId: 'code', order: 50, labelKey: 'codeMode.title', component: CodeModeSettings,
            keywords: ['JavaScript', 'tools', 'cells', 'code mode'],
        } })
        context.register<ChatRendererContribution<any>>({ kind: 'chat-renderer', id: 'code-cell-card', priority: 300, value: {
            id: 'code-cell-card', priority: 300, target: 'part', pluginId: context.manifest.id,
            matches: (part) => part?.type === 'tool_call' && (part?.name === 'exec' || part?.name === 'wait'),
            component: ExecToolCard,
        } })
    },
})

export default entry
