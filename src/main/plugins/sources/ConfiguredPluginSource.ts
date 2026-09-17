import * as path from 'node:path'
import {
    DuplicatePluginSourceError,
    type PluginSourceKind,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import type { PluginSourceConfigEntry } from '../config/pluginSourceConfig.js'
import type { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'
import { loadPluginPackageFromDirectory } from './loadPluginPackage.js'

export interface ConfiguredPluginSourceOptions {
    entries: PluginSourceConfigEntry[]
    baseDir: string
    kind: 'global-config'
    installer?: ManagedNpmInstaller
}

export class ConfiguredPluginSource {
    private readonly entries: PluginSourceConfigEntry[]
    private readonly baseDir: string
    private readonly kind: 'global-config'
    private readonly installer?: ManagedNpmInstaller

    constructor(options: ConfiguredPluginSourceOptions) {
        this.entries = options.entries ?? []
        this.baseDir = options.baseDir
        this.kind = options.kind
        this.installer = options.installer
    }

    /**
     * Discover and load all plugin packages declared in the configuration.
     * Relative paths are resolved against baseDir (the directory containing the config file).
     * Enforces unique plugin IDs within this configured source tier.
     */
    async discover(): Promise<ResolvedPluginPackage[]> {
        const results: ResolvedPluginPackage[] = []
        const seenIds = new Set<string>()

        for (const entry of this.entries) {
            if (entry.enabled === false) {
                continue
            }

            const spec = entry.source
            if (!spec || typeof spec !== 'string') {
                continue
            }

            let targetDir: string
            let installedIntegrity: string | undefined
            const isExplicitPath =
                spec.startsWith('path:') ||
                spec.startsWith('.') ||
                spec.startsWith('/') ||
                spec.startsWith('~') ||
                path.isAbsolute(spec)

            if (spec.startsWith('path:')) {
                const rawPath = spec.slice(5)
                targetDir = path.isAbsolute(rawPath)
                    ? path.resolve(rawPath)
                    : path.resolve(this.baseDir, rawPath)
            } else if (
                spec.startsWith('npm:') ||
                (!isExplicitPath && this.installer && (spec.startsWith('@') || spec.includes('@')))
            ) {
                if (!this.installer) {
                    continue
                }
                const installed = await this.installer.install(spec as `npm:${string}`)
                targetDir = installed.packageRoot
                installedIntegrity = installed.integrity
            } else {
                targetDir = path.isAbsolute(spec)
                    ? path.resolve(spec)
                    : path.resolve(this.baseDir, spec)
            }

            const pkg = await loadPluginPackageFromDirectory({
                directory: targetDir,
                sourceKind: this.kind,
                sourceSpec: spec,
                overrideCapabilities: entry.capabilities,
            })

            if (installedIntegrity) {
                pkg.integrity = installedIntegrity
            }

            const id = pkg.manifest.id
            if (seenIds.has(id)) {
                throw new DuplicatePluginSourceError(
                    `Duplicate plugin ID '${id}' found in ${this.kind} source tier`,
                    { pluginId: id },
                )
            }

            seenIds.add(id)
            results.push(pkg)
        }

        return results
    }
}
