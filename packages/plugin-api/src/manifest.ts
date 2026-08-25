import type { CapabilityId } from './capabilities.js'
import type { PluginContributionDeclarations } from './contributions.js'

export type PluginEntryKind = 'main' | 'renderer' | 'agent'
export type PluginCriticality = 'platform' | 'required' | 'optional'
export type PluginStatus =
    | 'discovered'
    | 'validated'
    | 'resolved'
    | 'registered'
    | 'activating'
    | 'active'
    | 'deactivating'
    | 'inactive'
    | 'blocked'
    | 'incompatible'
    | 'error'

export interface PluginIdentity {
    id: string
    version: string
}

export interface PluginEngines {
    cpa: string
    [engine: string]: string | undefined
}

export interface PluginAuthor {
    name: string
    email?: string
    url?: string
}

export interface PluginManifest {
    id: string
    name: string
    version: string
    apiVersion: string
    engines: PluginEngines
    entries: Partial<Record<PluginEntryKind, string>>
    dependencies: Record<string, string>
    optionalDependencies?: Record<string, string>
    capabilities: CapabilityId[]
    activationEvents?: string[]
    activationPriority?: number
    criticality?: PluginCriticality
    contributes: PluginContributionDeclarations
    configurationSchema?: Record<string, unknown>
    description?: string
    author?: string | PluginAuthor
    homepage?: string
    license?: string
}

export interface PluginSummary {
    manifest: PluginManifest
    status: PluginStatus
    generation: number
    error?: string
    isCore?: boolean
    source?: { kind: string; spec: string }
    sourceKind?: string
}

/**
 * Resolves the effective criticality for a package or manifest.
 * Manifest criticality takes precedence when explicit.
 * Core or bundled packages default to 'required'; external packages default to 'optional'.
 */
export function resolvePackageCriticality(
    pkg: { manifest: PluginManifest; source?: { kind?: string }; isCore?: boolean } | PluginManifest,
): PluginCriticality {
    if ('manifest' in pkg && pkg.manifest) {
        if (pkg.manifest.criticality) {
            return pkg.manifest.criticality
        }
        const isCore =
            pkg.isCore === true ||
            pkg.source?.kind === 'bundled'
        return isCore ? 'required' : 'optional'
    }
    const manifest = pkg as PluginManifest
    if (manifest.criticality) {
        return manifest.criticality
    }
    return 'optional'
}
