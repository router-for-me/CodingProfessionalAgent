import {
    DuplicatePluginSourceError,
    type PluginSourceKind,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import type { PluginSourceConfigEntry } from '../config/pluginSourceConfig.js'
import { loadPluginPackageFromDirectory } from './loadPluginPackage.js'
import { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'

export interface NpmPluginSourceOptions {
    installer: ManagedNpmInstaller
    entries?: PluginSourceConfigEntry[]
    specs?: string[]
    kind?: PluginSourceKind
}

export class NpmPluginSource {
    private readonly installer: ManagedNpmInstaller
    private readonly entries: PluginSourceConfigEntry[]
    private readonly kind: PluginSourceKind

    constructor(options: NpmPluginSourceOptions) {
        this.installer = options.installer
        this.kind = options.kind ?? 'npm'
        if (options.entries) {
            this.entries = options.entries
        } else if (options.specs) {
            this.entries = options.specs.map((spec) => ({ source: spec }))
        } else {
            this.entries = []
        }
    }

    /**
     * Discover, install, and load all npm plugin packages declared in configuration.
     * Enforces unique plugin IDs across this source tier.
     */
    async discover(): Promise<ResolvedPluginPackage[]> {
        const results: ResolvedPluginPackage[] = []
        const seenIds = new Set<string>()

        for (const entry of this.entries) {
            if (entry.enabled === false) {
                continue
            }

            const spec = typeof entry.source === 'string' ? entry.source.trim() : ''
            if (!spec || !spec.startsWith('npm:')) {
                continue
            }

            const installed = await this.installer.install(spec as `npm:${string}`)

            const pkg = await loadPluginPackageFromDirectory({
                directory: installed.packageRoot,
                sourceKind: this.kind,
                sourceSpec: spec,
                overrideCapabilities: entry.capabilities,
            })

            // Attach recorded subresource integrity
            pkg.integrity = installed.integrity

            const id = pkg.manifest.id
            if (seenIds.has(id)) {
                throw new DuplicatePluginSourceError(
                    `Duplicate plugin ID '${id}' found in ${this.kind} plugin source tier`,
                    { pluginId: id },
                )
            }

            seenIds.add(id)
            results.push(pkg)
        }

        return results
    }
}
