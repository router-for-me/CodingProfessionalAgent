import { definePluginEntry } from '@cpa/plugin-sdk'
import { SettingsServiceToken, type HookContribution, type PluginContext, type SettingsService, type ToolFactoryContext, type ToolFactoryContribution } from '@cpa/plugin-api'
import { CellClient } from './client'
import { createExecTool } from './execTool'
import { createWaitTool } from './waitTool'
import { codeModeConfiguration } from '../shared/configuration'

const generations = new Map<number, { client: CellClient; unsubscribeSettings?: () => void }>()

function resolveSettings(context: PluginContext, factoryContext: ToolFactoryContext): SettingsService {
    const fromFactory = factoryContext.services?.settings
    if (fromFactory) return fromFactory
    return context.getService(SettingsServiceToken)
}

export const entry = definePluginEntry({
    runtime: 'agent',
    activate(context: PluginContext) {
        const client = new CellClient(context.capabilityClient)
        const generation: { client: CellClient; unsubscribeSettings?: () => void } = { client }
        generations.set(context.generation, generation)
        for (const [name, create] of [['exec', createExecTool], ['wait', createWaitTool]] as const) {
            context.register<ToolFactoryContribution>({
                kind: 'tool-factory', id: name,
                value: {
                    id: name, name, order: 1000, targets: ['all'], riskLevel: 'read', requiresApproval: false,
                    async create(factoryContext) {
                        const settings = resolveSettings(context, factoryContext)
                        const snapshot = settings.getSnapshot?.() ?? await settings.get()
                        if (!generation.unsubscribeSettings && settings.subscribe) {
                            generation.unsubscribeSettings = settings.subscribe((next) => {
                                if (codeModeConfiguration(next).toolMode === 'direct') void client?.reset().catch(() => {})
                            })
                        }
                        if (codeModeConfiguration(snapshot).toolMode === 'direct') return null
                        return create(client!, settings, snapshot)
                    },
                },
            })
        }
        context.register<HookContribution>({
            kind: 'hook', id: 'code-cell-session-end',
            value: {
                id: 'code-cell-session-end', event: 'SessionEnd', order: 100, failureMode: 'open',
                async execute(input) { await client?.cancel(input.sessionId); return { continue: true } },
            },
        })
    },
    deactivate(context) {
        const generation = generations.get(context.generation)
        generation?.unsubscribeSettings?.()
        generation?.client.dispose()
        generations.delete(context.generation)
    },
})

export default entry
