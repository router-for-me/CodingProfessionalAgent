import { isMandatoryDirectTool } from '../shared/toolPolicy'
import type { AgentTool, AppSettings, SettingsService, ToolSetPreparation } from '@cpa/plugin-api'
import { codeModeConfiguration } from '../shared/configuration'
import { execParametersForLocale } from './protocol'
import { parseExecSource } from './pragma'
import { renderExecDescription, renderExecPromptDescription } from './describe'
import { selectNestedTools } from './names'
import type { CellClient } from './client'

interface ToolSetView {
    config: ReturnType<typeof codeModeConfiguration>
    direct: AgentTool[]
    specifications: ReturnType<typeof selectNestedTools>['tools']
    parameters: Record<string, unknown>
    description: string
    promptDescription: string
    nestedToolNames: string[]
    preparation: ToolSetPreparation
}

function buildToolSetView(
    tools: readonly AgentTool[],
    snapshot: Partial<AppSettings>,
    execToolName: string,
    warn?: (...args: unknown[]) => void,
): ToolSetView {
    const config = codeModeConfiguration(snapshot)
    const ordinary = tools.filter((item) => !item.needsNestedDispatcher)
    const direct = ordinary.filter(
        (item) => isMandatoryDirectTool(item.name) || item.exposure !== 'code-nested',
    )
    if (config.toolMode === 'direct') {
        return {
            config,
            direct,
            specifications: selectNestedTools([]).tools,
            parameters: execParametersForLocale(snapshot.locale),
            description: renderExecDescription('code', [], { locale: snapshot.locale }),
            promptDescription: renderExecPromptDescription('code', [], { locale: snapshot.locale }),
            nestedToolNames: [],
            preparation: {
                tools: direct,
                nestedTools: [],
            },
        }
    }
    const specifications = selectNestedTools(ordinary, { ...config, ...(warn ? { warn } : {}) }).tools
    const names = new Set(specifications.map((item) => item.name))
    const nestedToolNames = [...names]
    const parameters = execParametersForLocale(snapshot.locale)
    const descriptionOptions = {
        defaults: { yieldTimeMs: config.defaultExecYieldMs, maxOutputTokens: config.maxOutputTokens },
        locale: snapshot.locale,
    }
    const description = renderExecDescription(config.toolMode, specifications, descriptionOptions)
    const promptDescription = renderExecPromptDescription(config.toolMode, specifications, descriptionOptions)
    const topLevelTools = tools
        .filter(
            (item) =>
                item.needsNestedDispatcher ||
                isMandatoryDirectTool(item.name) ||
                (item.exposure !== 'code-nested' &&
                    (config.toolMode === 'code' ||
                        item.exposure === 'direct' ||
                        config.directOnlyToolNames.includes(item.name))),
        )
        .map((item) =>
            item.needsNestedDispatcher
                ? {
                    ...item,
                    nestedToolNames: [...nestedToolNames],
                    ...(item.name === execToolName
                        ? {
                            parameters,
                            description,
                            promptDescription,
                        }
                        : {}),
                }
                : item,
        )
    return {
        config,
        direct,
        specifications,
        parameters,
        description,
        promptDescription,
        nestedToolNames,
        preparation: {
            policyId: config.toolMode,
            tools: topLevelTools,
            nestedTools: ordinary.filter((item) => names.has(item.name)),
        },
    }
}

export function createExecTool(client: CellClient, settings: SettingsService, initial: Partial<AppSettings>): AgentTool {
    let config = codeModeConfiguration(initial)
    let specifications = selectNestedTools([]).tools
    // Sub-agent runs share this tool object and must not replace the parent's nested list.
    const specificationsBySession = new Map<string, typeof specifications>()
    const initialMode = config.toolMode === 'direct' ? 'code' : config.toolMode
    const tool: AgentTool = {
        name: 'exec',
        label: 'Execute Code',
        description: renderExecDescription(initialMode, [], { locale: initial.locale }),
        promptDescription: renderExecPromptDescription(initialMode, [], { locale: initial.locale }),
        parameters: execParametersForLocale(initial.locale),
        exposure: 'direct',
        needsNestedDispatcher: true,
        toolPolicyId: 'code-only',
        async previewToolSet(tools) {
            const snapshot = settings.getSnapshot?.() ?? await settings.get()
            return buildToolSetView(tools, snapshot, tool.name).preparation
        },
        async prepareToolSet(tools, context) {
            const snapshot = settings.getSnapshot?.() ?? await settings.get()
            const view = buildToolSetView(tools, snapshot, tool.name, console.warn)
            config = view.config
            context.signal.addEventListener('abort', () => { void client.cancel(context.sessionId).catch(() => {}) }, { once: true })
            if (config.toolMode === 'direct') {
                await client.cancel(context.sessionId)
                return view.preparation
            }
            try { await client.prepare() }
            catch (error) {
                if (config.toolMode === 'code' && config.disableWhenUnavailable) {
                    return { tools: view.direct, nestedTools: [], systemMessage: `Code Mode executor unavailable; using direct tools: ${String(error)}` }
                }
                throw new Error(`Code Mode executor unavailable (fail closed): ${String(error)}`)
            }
            specifications = view.specifications
            if (context.sessionId) specificationsBySession.set(context.sessionId, specifications)
            if (!Object.isFrozen(tool)) {
                tool.nestedToolNames = [...view.nestedToolNames]
                tool.parameters = view.parameters
                tool.description = view.description
                tool.promptDescription = view.promptDescription
            }
            return view.preparation
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
            const active = specificationsBySession.get(context.sessionId) ?? specifications
            const tools = active.map(({ name, identifier, description }) => ({ name, identifier, description }))
            return client.observe('start', { sessionId: context.sessionId, source: parsed.source, tools, yieldTimeMs: parsed.yieldTimeMs, maxOutputTokens: parsed.maxOutputTokens }, context)
        },
    }
    return tool
}
