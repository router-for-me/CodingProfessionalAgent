import {
    DuplicatePluginSourceError,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'

export class BundledPluginSource {
    private readonly bundledPackages: readonly ResolvedPluginPackage[]

    constructor(bundledPackages: readonly ResolvedPluginPackage[] = []) {
        this.bundledPackages = bundledPackages
    }

    /**
     * Discover and validate bundled plugin packages.
     * Enforces unique plugin IDs across the bundled tier.
     */
    async discover(): Promise<ResolvedPluginPackage[]> {
        const seenIds = new Set<string>()
        const results: ResolvedPluginPackage[] = []

        for (const pkg of this.bundledPackages) {
            const id = pkg.manifest.id
            if (seenIds.has(id)) {
                throw new DuplicatePluginSourceError(
                    `Duplicate plugin ID '${id}' found in bundled plugin source tier`,
                    { pluginId: id },
                )
            }
            seenIds.add(id)
            results.push({
                ...pkg,
                source: {
                    kind: 'bundled',
                    spec: pkg.source?.spec ?? `bundled:${id}`,
                },
            })
        }

        return results
    }
}
