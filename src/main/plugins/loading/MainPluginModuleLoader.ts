import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginEntryDefinition, PluginEntryKind, ResolvedPluginPackage } from '@cpa/plugin-api'
import { ExternalMainPluginHost } from './ExternalMainPluginHost.js'

export type BundledEntryLoader = () => Promise<PluginEntryDefinition>

export interface PluginModuleLoader {
    load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): Promise<PluginEntryDefinition | undefined>
}

/**
 * Main process plugin module loader.
 * Loads bundled plugins directly in-process and delegates external plugins
 * to the isolated ExternalMainPluginHost worker.
 */
export class MainPluginModuleLoader implements PluginModuleLoader {
    private readonly externalHost: ExternalMainPluginHost
    private readonly bundledDefinitions = new Map<string, PluginEntryDefinition>()
    private readonly bundledLoaders = new Map<string, BundledEntryLoader>()

    constructor(
        externalHost?: ExternalMainPluginHost,
        bundledDefinitions?: Record<string, PluginEntryDefinition> | Map<string, PluginEntryDefinition>,
        bundledLoaders?: Record<string, BundledEntryLoader> | Map<string, BundledEntryLoader>,
    ) {
        this.externalHost = externalHost ?? new ExternalMainPluginHost()
        if (bundledDefinitions) {
            const entries =
                bundledDefinitions instanceof Map
                    ? bundledDefinitions.entries()
                    : Object.entries(bundledDefinitions)
            for (const [id, def] of entries) {
                this.bundledDefinitions.set(id, def)
            }
        }
        if (bundledLoaders) {
            const entries =
                bundledLoaders instanceof Map
                    ? bundledLoaders.entries()
                    : Object.entries(bundledLoaders)
            for (const [id, loader] of entries) {
                this.bundledLoaders.set(id, loader)
            }
        }
    }

    async load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): Promise<PluginEntryDefinition | undefined> {
        if (runtime !== 'main') {
            return undefined
        }

        const cached = this.bundledDefinitions.get(pluginPackage.manifest.id)
        if (cached) {
            return cached
        }

        const loader = this.bundledLoaders.get(pluginPackage.manifest.id)
        if (loader) {
            const loaded = await loader()
            if (loaded) {
                return loaded
            }
        }

        const rawEntryPath = pluginPackage.entries.main
        if (!rawEntryPath) {
            return undefined
        }

        const entryPath =
            pluginPackage.sourceRoot && !path.isAbsolute(rawEntryPath)
                ? path.resolve(pluginPackage.sourceRoot, rawEntryPath)
                : path.resolve(rawEntryPath)

        // Bundled platform plugins execute in-process
        if (pluginPackage.source.kind === 'bundled') {
            const entryUrl = pathToFileURL(entryPath).href
            const mod = await import(entryUrl)
            const definition: PluginEntryDefinition =
                mod.default ?? mod.definition ?? mod.entry ?? mod
            return definition
        }

        // Global and npm external plugins execute in isolated host
        return this.externalHost.load(pluginPackage)
    }
}
