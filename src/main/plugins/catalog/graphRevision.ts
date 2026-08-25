import { createHash } from 'node:crypto'
import {
    resolvePackageCriticality,
    type PluginCriticality,
    type PluginEntryKind,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginNodeDTO,
    type ResolvedPluginPackage,
} from '@cpa/plugin-api'
import type { ResolvedPluginGraph } from '@cpa/plugin-kernel'

/**
 * Recursively canonicalizes an object or array by sorting keys lexicographically
 * and stripping undefined values for deterministic JSON serialization.
 */
export function canonicalizeGraphPayload(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value
    }
    if (Array.isArray(value)) {
        return value.map(canonicalizeGraphPayload)
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([_, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalizeGraphPayload(v)])
    return Object.fromEntries(entries)
}

/**
 * Extracts the canonical, environment-independent descriptor of a resolved plugin package.
 * Private host paths (like sourceRoot) and runtime functions are excluded.
 */
export function toCanonicalPluginDescriptor(pkg: ResolvedPluginPackage): Record<string, unknown> {
    const manifest = pkg.manifest
    const entries: Partial<Record<PluginEntryKind, string>> = {}
    const declaredEntries = manifest.entries ?? pkg.entries ?? {}
    for (const [k, v] of Object.entries(declaredEntries)) {
        if (typeof v === 'string') {
            entries[k as PluginEntryKind] = v
        }
    }

    return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        apiVersion: manifest.apiVersion ?? '1.0.0',
        engines: manifest.engines ?? { cpa: '^1.0.0' },
        entries,
        dependencies: manifest.dependencies ?? {},
        optionalDependencies: manifest.optionalDependencies ?? {},
        capabilities: manifest.capabilities ?? [],
        activationEvents: manifest.activationEvents ?? [],
        activationPriority: manifest.activationPriority ?? 1000,
        criticality: resolvePackageCriticality(pkg),
        contributes: manifest.contributes ?? {},
        configurationSchema: manifest.configurationSchema ?? {},
        description: manifest.description ?? '',
        source: {
            kind: pkg.source.kind,
            spec: pkg.source.spec,
        },
        integrity: pkg.integrity ?? '',
    }
}

/**
 * Computes a stable SHA-256 hash revision from a resolved list of plugin packages and their activation order.
 * Invariant to package discovery order and independent of createdAt timestamp.
 */
export function computePluginGraphRevision(
    plugins: readonly ResolvedPluginPackage[],
    activationOrder?: readonly string[],
): string {
    const packageMap = new Map<string, ResolvedPluginPackage>()
    for (const pkg of plugins) {
        packageMap.set(pkg.manifest.id, pkg)
    }

    const order = activationOrder ?? plugins.map((p) => p.manifest.id)
    const canonicalPlugins = order.map((id) => {
        const pkg = packageMap.get(id)
        return pkg ? toCanonicalPluginDescriptor(pkg) : { id }
    })

    const payload = {
        activationOrder: order,
        plugins: canonicalPlugins,
    }

    const canonicalJson = JSON.stringify(canonicalizeGraphPayload(payload))
    return createHash('sha256').update(canonicalJson).digest('hex')
}

/**
 * Converts a ResolvedPluginPackage into an immutable, serializable ResolvedPluginNodeDTO.
 */
export function toResolvedPluginNodeDTO(pkg: ResolvedPluginPackage): ResolvedPluginNodeDTO {
    const manifest = pkg.manifest
    const entries: Partial<Record<PluginEntryKind, string>> = {}
    const declaredEntries = manifest.entries ?? pkg.entries ?? {}
    for (const [k, v] of Object.entries(declaredEntries)) {
        if (typeof v === 'string') {
            entries[k as PluginEntryKind] = v
        }
    }

    return Object.freeze({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        manifest: Object.freeze({ ...manifest }),
        source: Object.freeze({ ...pkg.source }),
        sourceKind: pkg.source.kind,
        entries: Object.freeze(entries),
        criticality: resolvePackageCriticality(pkg),
        dependencies: Object.freeze({ ...(manifest.dependencies ?? {}) }),
        optionalDependencies: manifest.optionalDependencies
            ? Object.freeze({ ...manifest.optionalDependencies })
            : undefined,
        integrity: pkg.integrity,
    })
}

/**
 * Creates an immutable, serializable ResolvedPluginGraphDTO from a resolved dependency graph.
 */
export function createResolvedPluginGraphDTO(
    graph: ResolvedPluginGraph | { activationOrder: readonly ResolvedPluginPackage[]; blocked?: readonly unknown[] },
    options?: { createdAt?: number },
): ResolvedPluginGraphDTO {
    const activationOrder = Object.freeze(graph.activationOrder.map((p) => p.manifest.id))
    const plugins = Object.freeze(graph.activationOrder.map(toResolvedPluginNodeDTO))
    const revision = computePluginGraphRevision(graph.activationOrder, activationOrder)
    const createdAt = options?.createdAt ?? Date.now()

    return Object.freeze({
        revision,
        createdAt,
        plugins,
        activationOrder,
    })
}
