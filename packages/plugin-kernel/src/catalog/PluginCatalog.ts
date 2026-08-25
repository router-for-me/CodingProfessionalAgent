import type { PluginStatus, PluginSummary, ResolvedPluginPackage } from '@cpa/plugin-api'
import {
    resolvePluginGraph,
    type BlockedPlugin,
    type ResolvedPluginGraph,
} from '../dependencies/DependencyResolver.js'

export interface PluginCatalogOptions {
    cpaVersion: string
    packages?: readonly ResolvedPluginPackage[]
    enabledPluginIds?: Iterable<string>
}

/**
 * Universal Plugin Catalog managing discovered plugin packages, enabled states,
 * and dependency graph resolution.
 */
export class PluginCatalog {
    private cpaVersion: string
    private readonly packages = new Map<string, ResolvedPluginPackage>()
    private readonly enabledPluginIds = new Set<string>()
    private cachedGraph: ResolvedPluginGraph | null = null

    constructor(options: PluginCatalogOptions) {
        this.cpaVersion = options.cpaVersion
        if (options.packages) {
            for (const pkg of options.packages) {
                this.packages.set(pkg.manifest.id, pkg)
            }
        }
        if (options.enabledPluginIds) {
            for (const id of options.enabledPluginIds) {
                this.enabledPluginIds.add(id)
            }
        }
    }

    /**
     * Get the CPA host engine version.
     */
    getCpaVersion(): string {
        return this.cpaVersion
    }

    /**
     * Set the CPA host engine version and invalidate the cached graph.
     */
    setCpaVersion(version: string): void {
        if (this.cpaVersion !== version) {
            this.cpaVersion = version
            this.cachedGraph = null
        }
    }

    /**
     * Get all registered packages in the catalog.
     */
    getPackages(): readonly ResolvedPluginPackage[] {
        return Object.freeze(Array.from(this.packages.values()))
    }

    /**
     * Look up a package by plugin ID.
     */
    getPackage(pluginId: string): ResolvedPluginPackage | undefined {
        return this.packages.get(pluginId)
    }

    /**
     * Check if a package exists in the catalog.
     */
    hasPackage(pluginId: string): boolean {
        return this.packages.has(pluginId)
    }

    /**
     * Replace all packages in the catalog.
     */
    setPackages(packages: readonly ResolvedPluginPackage[]): void {
        this.packages.clear()
        for (const pkg of packages) {
            this.packages.set(pkg.manifest.id, pkg)
        }
        this.cachedGraph = null
    }

    /**
     * Add or update a package in the catalog.
     */
    addPackage(pkg: ResolvedPluginPackage): void {
        this.packages.set(pkg.manifest.id, pkg)
        this.cachedGraph = null
    }

    /**
     * Remove a package from the catalog by plugin ID.
     */
    removePackage(pluginId: string): boolean {
        const removed = this.packages.delete(pluginId)
        if (removed) {
            this.cachedGraph = null
        }
        return removed
    }

    /**
     * Get the set of enabled plugin IDs.
     */
    getEnabledPluginIds(): ReadonlySet<string> {
        return this.enabledPluginIds
    }

    /**
     * Check if a plugin is enabled.
     */
    isEnabled(pluginId: string): boolean {
        return this.enabledPluginIds.has(pluginId)
    }

    /**
     * Enable a plugin by ID.
     */
    enablePlugin(pluginId: string): void {
        if (!this.enabledPluginIds.has(pluginId)) {
            this.enabledPluginIds.add(pluginId)
            this.cachedGraph = null
        }
    }

    /**
     * Disable a plugin by ID.
     */
    disablePlugin(pluginId: string): void {
        if (this.enabledPluginIds.has(pluginId)) {
            this.enabledPluginIds.delete(pluginId)
            this.cachedGraph = null
        }
    }

    /**
     * Set the entire enabled plugin ID collection.
     */
    setEnabledPluginIds(pluginIds: Iterable<string>): void {
        this.enabledPluginIds.clear()
        for (const id of pluginIds) {
            this.enabledPluginIds.add(id)
        }
        this.cachedGraph = null
    }

    /**
     * Resolve the plugin dependency graph.
     */
    resolveGraph(): ResolvedPluginGraph {
        if (!this.cachedGraph) {
            this.cachedGraph = resolvePluginGraph({
                packages: Array.from(this.packages.values()),
                enabledPluginIds: this.enabledPluginIds,
                cpaVersion: this.cpaVersion,
            })
        }
        return this.cachedGraph
    }

    /**
     * Alias for resolveGraph().
     */
    getResolvedGraph(): ResolvedPluginGraph {
        return this.resolveGraph()
    }

    /**
     * Get the current status for a plugin ID.
     */
    getPluginStatus(pluginId: string): PluginStatus {
        const pkg = this.packages.get(pluginId)
        if (!pkg) {
            return 'inactive'
        }
        const graph = this.resolveGraph()
        const blocked = graph.blocked.find((b) => b.pluginId === pluginId)
        if (blocked) {
            if (blocked.reason === 'disabled') {
                return 'inactive'
            }
            if (blocked.reason === 'incompatible-version') {
                return 'incompatible'
            }
            return 'blocked'
        }
        const isResolved = graph.activationOrder.some((p) => p.manifest.id === pluginId)
        if (isResolved) {
            return 'resolved'
        }
        return 'inactive'
    }

    /**
     * Get summary information for a plugin.
     */
    getPluginSummary(pluginId: string): PluginSummary | undefined {
        const pkg = this.packages.get(pluginId)
        if (!pkg) {
            return undefined
        }
        const status = this.getPluginStatus(pluginId)
        const graph = this.resolveGraph()
        const blocked = graph.blocked.find((b) => b.pluginId === pluginId)

        let error: string | undefined
        if (blocked) {
            switch (blocked.reason) {
                case 'disabled':
                    error = 'Plugin is disabled'
                    break
                case 'incompatible-version':
                    error = blocked.dependencyId
                        ? `Incompatible dependency version: ${blocked.dependencyId}`
                        : `Incompatible CPA version required: ${pkg.manifest.engines?.cpa}`
                    break
                case 'missing-dependency':
                    error = `Missing dependency: ${blocked.dependencyId}`
                    break
                case 'dependency-cycle':
                    error = 'Plugin is part of a circular dependency'
                    break
            }
        }

        return {
            manifest: pkg.manifest,
            status,
            generation: 0,
            error,
            source: pkg.source,
            sourceKind: pkg.source?.kind,
        }
    }

    /**
     * Get summary information for all registered plugins.
     */
    getPluginSummaries(): readonly PluginSummary[] {
        const summaries: PluginSummary[] = []
        for (const id of this.packages.keys()) {
            const summary = this.getPluginSummary(id)
            if (summary) {
                summaries.push(summary)
            }
        }
        return Object.freeze(summaries)
    }
}
