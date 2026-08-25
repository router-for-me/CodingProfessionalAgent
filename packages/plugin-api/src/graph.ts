import type { PluginCriticality, PluginEntryKind, PluginManifest } from './manifest.js'
import type { PluginSourceDescriptor, PluginSourceKind } from './sources.js'

/**
 * Immutable serializable Data Transfer Object representing a resolved plugin node.
 * Contains no host service instances, loader functions, or private absolute paths.
 */
export interface ResolvedPluginNodeDTO {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly manifest: PluginManifest
    readonly source: PluginSourceDescriptor
    readonly sourceKind: PluginSourceKind
    readonly entries: Readonly<Partial<Record<PluginEntryKind, string>>>
    readonly criticality: PluginCriticality
    readonly dependencies: Readonly<Record<string, string>>
    readonly optionalDependencies?: Readonly<Record<string, string>>
    readonly integrity?: string
}

/**
 * Information about a plugin blocked from activation during dependency graph resolution.
 */
export interface BlockedPluginDTO {
    readonly pluginId: string
    readonly reason: 'disabled' | 'missing-dependency' | 'incompatible-version' | 'dependency-cycle'
    readonly dependencyId?: string
}

/**
 * Immutable serializable Data Transfer Object representing the resolved plugin graph.
 * Features a deterministic SHA-256 revision representing all canonical graph metadata.
 */
export interface ResolvedPluginGraphDTO {
    readonly revision: string
    readonly createdAt: number
    readonly plugins: readonly ResolvedPluginNodeDTO[]
    readonly activationOrder: readonly string[]
}
