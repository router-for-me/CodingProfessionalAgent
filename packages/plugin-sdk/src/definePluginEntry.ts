import type { PluginEntryDefinition, PluginEntryKind } from '@cpa/plugin-api'

const VALID_ENTRY_KINDS: ReadonlySet<PluginEntryKind> = new Set<PluginEntryKind>([
    'main',
    'renderer',
    'agent',
])

export function definePluginEntry(definition: PluginEntryDefinition): PluginEntryDefinition {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new Error('Plugin entry definition must be an object')
    }
    if (!VALID_ENTRY_KINDS.has(definition.runtime)) {
        throw new Error(`Invalid plugin entry runtime: "${definition.runtime}". Valid runtimes are: main, renderer, agent`)
    }
    if (typeof definition.activate !== 'function') {
        throw new Error('Plugin entry definition must provide an activate function')
    }
    if (definition.deactivate !== undefined && typeof definition.deactivate !== 'function') {
        throw new Error('Plugin entry deactivate must be a function if provided')
    }
    return definition
}
