import type {
    AgentTool,
    ContributionRegistration,
    PluginCapabilityClient,
    PluginManifest,
    ToolExecutionContext,
    ToolFactoryContribution,
} from '@cpa/plugin-api'
import { matchesCapability, PluginCapabilityError } from '@cpa/plugin-api'

/** Run-local model invocation is not an IPC method, but still requires a scoped grant. */
const MODEL_INVOCATION_CAPABILITY = 'models.invoke'

export function scopeToolModelInvocation<T>(
    registration: ContributionRegistration<T>,
    manifest: PluginManifest,
    client: PluginCapabilityClient,
): T {
    if (registration.kind !== 'tool-factory' || !registration.value || typeof registration.value !== 'object') return registration.value
    const declared = (manifest.capabilities ?? []).some((pattern) => matchesCapability(pattern, MODEL_INVOCATION_CAPABILITY))
    const allowed = () => declared && client.has(MODEL_INVOCATION_CAPABILITY)
    const scopeContext = (context: ToolExecutionContext): ToolExecutionContext => {
        const { modelInvoker, ...rest } = context
        if (!modelInvoker || !allowed()) return rest
        return {
            ...rest,
            modelInvoker: Object.freeze({
                invoke: (...args: Parameters<typeof modelInvoker.invoke>) => {
                    if (!allowed()) throw new PluginCapabilityError('Isolated model invocation requires models.invoke', { pluginId: manifest.id })
                    return modelInvoker.invoke(...args)
                },
            }),
        }
    }
    const wrapTool = (tool: AgentTool | null | undefined): AgentTool | null | undefined => {
        if (!tool) return tool
        return {
            ...tool,
            execute: (id, args, context) => tool.execute(id, args, scopeContext(context)),
        }
    }
    const factory = registration.value as unknown as ToolFactoryContribution
    if (typeof factory.create === 'function') {
        return {
            ...factory,
            create: (context: Parameters<ToolFactoryContribution['create']>[0]) => {
                // Legacy adapters can pass execution context into create(). Scope
                // that path as well, rather than relying on its TypeScript shape.
                const result = factory.create(scopeContext(context) as typeof context)
                return result instanceof Promise ? result.then(wrapTool) : wrapTool(result)
            },
        } as T
    }
    // Legacy callable contributions share the same registry kind. Do not leave
    // an unscoped path merely because a factory was not used.
    const legacy = registration.value as unknown as { execute?: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown> }
    if (typeof legacy.execute === 'function') {
        return {
            ...legacy,
            execute: (args: Record<string, unknown>, context: ToolExecutionContext) => legacy.execute!(args, scopeContext(context)),
        } as T
    }
    return registration.value
}
