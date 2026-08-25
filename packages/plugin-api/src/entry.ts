import type { PluginEntryKind } from './manifest.js'
import type { PluginContext } from './lifecycle.js'

export interface PluginEntryDefinition {
    runtime: PluginEntryKind
    activate(context: PluginContext): void | Promise<void>
    deactivate?(context: PluginContext): void | Promise<void>
}
