import type { AgentTool, AppSettings, SettingsService } from '@cpa/plugin-api'
import { codeModeConfiguration } from '../shared/configuration'
import { WAIT_PARAMETERS } from './protocol'
import type { CellClient } from './client'

export function createWaitTool(client: CellClient, settings: SettingsService, initial: Partial<AppSettings>): AgentTool {
    return {
        name: 'wait', label: 'Wait for Code Cell', description: 'Observe only new output from a cell_id returned by exec, or terminate that cell. Missing cells fail explicitly.',
        parameters: { ...WAIT_PARAMETERS }, exposure: 'direct', needsNestedDispatcher: true,
        validate(input) {
            if (!input || typeof input !== 'object') throw new Error('wait requires an object')
            const args = input as Record<string, unknown>
            if (typeof args.cell_id !== 'string' || !args.cell_id) throw new Error('cell_id required')
            if (Object.keys(args).some((key) => !['cell_id', 'yield_time_ms', 'max_tokens', 'terminate'].includes(key))) throw new Error('Unknown wait field')
            for (const key of ['yield_time_ms', 'max_tokens']) if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 0)) throw new Error(`${key} must be a nonnegative safe integer`)
            if (args.terminate !== undefined && typeof args.terminate !== 'boolean') throw new Error('terminate must be boolean')
            return args
        },
        async execute(_id, args, context) {
            if (!context.sessionId) throw new Error('Session identity required')
            const config = codeModeConfiguration(settings.getSnapshot?.() ?? initial)
            if (config.toolMode === 'direct') { await client.cancel(context.sessionId); throw new Error('Code Mode is disabled') }
            return client.observe('observe', { sessionId: context.sessionId, cellId: args.cell_id as string, yieldTimeMs: args.yield_time_ms as number ?? config.defaultWaitYieldMs, maxOutputTokens: args.max_tokens as number ?? config.maxOutputTokens, terminate: args.terminate as boolean | undefined }, context)
        },
    }
}
