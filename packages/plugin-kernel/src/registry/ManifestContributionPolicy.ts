import type {
    ContributionKind,
    PluginManifest,
} from '@cpa/plugin-api'
import { PluginManifestError } from '@cpa/plugin-api'

/**
 * Validates that contribution registrations during plugin activation
 * match declarations in the plugin's manifest.
 */
export class ManifestContributionPolicy {
    constructor(private readonly manifest: PluginManifest) {}

    /**
     * Check whether a contribution kind and ID is declared in the manifest.
     */
    isDeclared(kind: ContributionKind, id: string): boolean {
        const list = this.manifest.contributes?.[kind]
        if (!list || !Array.isArray(list)) {
            return false
        }
        return list.includes(id)
    }

    /**
     * Assert that a contribution kind and ID is declared in the manifest.
     * Throws PluginManifestError if undeclared.
     */
    assertDeclared(kind: ContributionKind, id: string): void {
        if (!this.isDeclared(kind, id)) {
            throw new PluginManifestError(`Undeclared contribution ${kind}/${id}`, {
                pluginId: this.manifest.id,
            })
        }
    }
}
