import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
    DuplicatePluginSourceError,
    type PluginSourceKind,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import { loadPluginPackageFromDirectory } from './loadPluginPackage.js'

export interface DirectoryPluginSourceOptions {
    directory: string
    kind: 'global-directory'
}

export class DirectoryPluginSource {
    private readonly directory: string
    private readonly kind: 'global-directory'

    constructor(options: DirectoryPluginSourceOptions) {
        this.directory = options.directory
        this.kind = options.kind
    }

    /**
     * Discover all valid plugin packages located directly in subdirectories of the target directory.
     * Enforces unique plugin IDs across this source directory tier.
     */
    async discover(): Promise<ResolvedPluginPackage[]> {
        try {
            const stat = await fs.stat(this.directory)
            if (!stat.isDirectory()) {
                return []
            }
        } catch {
            return []
        }

        const entries = await fs.readdir(this.directory, { withFileTypes: true })
        const results: ResolvedPluginPackage[] = []
        const seenIds = new Set<string>()

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue
            }

            const pluginDir = path.join(this.directory, entry.name)
            try {
                const pkg = await loadPluginPackageFromDirectory({
                    directory: pluginDir,
                    sourceKind: this.kind,
                    sourceSpec: `path:${pluginDir}`,
                })

                const id = pkg.manifest.id
                if (seenIds.has(id)) {
                    throw new DuplicatePluginSourceError(
                        `Duplicate plugin ID '${id}' found in ${this.kind} source tier ('${this.directory}')`,
                        { pluginId: id },
                    )
                }

                seenIds.add(id)
                results.push(pkg)
            } catch (err: any) {
                if (err instanceof DuplicatePluginSourceError) {
                    throw err
                }
                // If the folder is simply not a plugin (no manifest), silently skip
                // But if it has a broken manifest or security violation, rethrow
                if (err?.code === 'PLUGIN_VALIDATION_ERROR' || err?.code === 'PLUGIN_MANIFEST_ERROR') {
                    // Check if manifest or package.json actually exists
                    const hasManifest = await fs
                        .access(path.join(pluginDir, 'manifest.json'))
                        .then(() => true)
                        .catch(() => false)
                    const hasPkg = await fs
                        .access(path.join(pluginDir, 'package.json'))
                        .then(() => true)
                        .catch(() => false)
                    if (hasManifest || hasPkg) {
                        throw err
                    }
                }
            }
        }

        return results
    }
}
