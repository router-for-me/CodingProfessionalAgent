import type { PluginEntryKind, PluginManifest } from './manifest.js'

export type PluginSourceSpec = `path:${string}` | `npm:${string}`
export type PluginSourceKind =
    | 'global-config'
    | 'global-directory'
    | 'bundled'
    | 'npm'

export interface PluginSourceDescriptor {
    kind: PluginSourceKind
    spec: string
}

export interface ResolvedPluginPackage {
    manifest: PluginManifest
    source: PluginSourceDescriptor
    sourceRoot: string
    entries: Partial<Record<PluginEntryKind, string>>
    isCore?: boolean
    integrity?: string
}
