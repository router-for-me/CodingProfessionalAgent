import type {
    PluginEntryDefinition,
    PluginEntryKind,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import type { PluginModuleLoader } from '@cpa/plugin-kernel'
import {
    bundledAgentEntryLoaders,
    type BundledEntryLoader,
} from '../generated/bundledPluginLoaders'
import { RendererPluginModuleLoader } from './RendererPluginModuleLoader'

/**
 * Module loader for Agent runtime plugin entries.
 * Resolves entries declared under manifest "agent" entrypoint.
 */
export class AgentPluginModuleLoader implements PluginModuleLoader {
    private readonly loaders: Record<string, BundledEntryLoader>
    private readonly definitions: Record<string, PluginEntryDefinition>
    private readonly fallbackLoader?: PluginModuleLoader

    constructor(
        loaders: Record<string, BundledEntryLoader> = bundledAgentEntryLoaders,
        definitions: Record<string, PluginEntryDefinition> = {},
        fallbackLoader?: PluginModuleLoader,
    ) {
        this.loaders = { ...loaders }
        this.definitions = { ...definitions }
        this.fallbackLoader = fallbackLoader ?? new RendererPluginModuleLoader()
    }

    setDefinition(id: string, def: PluginEntryDefinition): void {
        this.definitions[id] = def
    }

    async load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): Promise<PluginEntryDefinition | undefined> {
        if (runtime !== 'agent') {
            return undefined
        }

        const id = pluginPackage.manifest.id
        const inMemoryDef = this.definitions[id]
        if (inMemoryDef) {
            return inMemoryDef
        }

        const loader = this.loaders[id]
        if (loader) {
            const loaded = await loader()
            if (loaded) {
                return loaded
            }
        }

        if (pluginPackage.source?.kind !== 'bundled' && this.fallbackLoader) {
            const loaded = await this.fallbackLoader.load(pluginPackage, runtime)
            if (loaded) {
                return loaded
            }
        }

        return undefined
    }
}
