import type { AgentTool, AppSettings, SettingsService } from '@cpa/plugin-api'
import { codeModeConfiguration } from '../shared/configuration'
import { execParametersForLocale } from './protocol'
import { parseExecSource } from './pragma'
import { renderExecDescription } from './describe'
import { selectNestedTools } from './names'
import type { CellClient } from './client'

export function createExecTool(client: CellClient, settings: SettingsService, initial: Partial<AppSettings>): AgentTool {
    let config = codeModeConfiguration(initial)
    let specifications = selectNestedTools([]).tools
    const tool: AgentTool = {
        name: 'exec', label: 'Execute Code', description: renderExecDescription('code', [], { locale: initial.locale }),
        parameters: execParametersForLocale(initial.locale), exposure: 'direct', needsNestedDispatcher: true, toolPolicyId: 'code-only',
        async prepareToolSet(tools, context) {
            const snapshot = settings.getSnapshot?.() ?? await settings.get()
            config = codeModeConfiguration(snapshot)
            const ordinary = tools.filter((item) => !item.needsNestedDispatcher)
            const direct = ordinary.filter((item) => item.exposure !== 'code-nested')
            context.signal.addEventListener('abort', () => { void client.cancel(context.sessionId).catch(() => {}) }, { once: true })
            if (config.toolMode === 'direct') {
                await client.cancel(context.sessionId)
                return { tools: direct, nestedTools: [] }
            }
            try { await client.prepare() }
            catch (error) {
                if (config.toolMode === 'code' && config.disableWhenUnavailable) {
                    return { tools: direct, nestedTools: [], systemMessage: `Code Mode executor unavailable; using direct tools: ${String(error)}` }
                }
                throw new Error(`Code Mode executor unavailable (fail closed): ${String(error)}`)
            }
            specifications = selectNestedTools(ordinary, { ...config, warn: console.warn }).tools
            const names = new Set(specifications.map((item) => item.name))
            tool.nestedToolNames = [...names]
            tool.parameters = execParametersForLocale(snapshot.locale)
            tool.description = renderExecDescription(config.toolMode, specifications, { defaults: { yieldTimeMs: config.defaultExecYieldMs, maxOutputTokens: config.maxOutputTokens }, locale: snapshot.locale })
            return {
                policyId: config.toolMode,
                tools: tools.filter((item) => item.needsNestedDispatcher || item.exposure !== 'code-nested' && (config.toolMode === 'code' || item.exposure === 'direct' || config.directOnlyToolNames.includes(item.name))).map((item) => item.needsNestedDispatcher ? { ...item, nestedToolNames: [...names], description: item.name === tool.name ? tool.description : item.description } : item),
                nestedTools: ordinary.filter((item) => names.has(item.name)),
            }
        },
        validate(input) {
            if (!input || typeof input !== 'object') throw new Error('exec requires source and description')
            const args = input as Record<string, unknown>
            const description = typeof args.description === 'string' ? args.description.trim() : ''
            if (typeof args.source !== 'string' || !description || description.length > 200 || Object.keys(args).some((key) => key !== 'source' && key !== 'description')) {
                throw new Error('exec requires only source and a 1-200 character description')
            }
            parseExecSource(args.source)
            return { source: args.source, description }
        },
        async execute(_id, args, context) {
            if (!context.sessionId) throw new Error('Session identity required')
            config = codeModeConfiguration(settings.getSnapshot?.() ?? await settings.get())
            if (config.toolMode === 'direct') { await client.cancel(context.sessionId); throw new Error('Code Mode is disabled') }
            const parsed = parseExecSource(args.source as string, { yieldTimeMs: config.defaultExecYieldMs, maxOutputTokens: config.maxOutputTokens })
            // Electron structured clone rejects functions on AgentTool. Send data only.
            const tools = specifications.map(({ name, identifier, description }) => ({ name, identifier, description }))
            return client.observe('start', { sessionId: context.sessionId, source: parsed.source, tools, yieldTimeMs: parsed.yieldTimeMs, maxOutputTokens: parsed.maxOutputTokens }, context)
        },
    }
    return tool
}
