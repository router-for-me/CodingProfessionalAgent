import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    type CapabilityId,
    type PluginEntryDefinition,
    type PluginIdentity,
    type PluginSummary,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginPackage,
    matchesCapability,
} from '@cpa/plugin-api'
import {
    PluginCatalog,
    PluginRuntime,
    ContributionRegistry,
    PluginEventBus,
    type PluginGenerationLease,
    type PluginRuntimeMetric,
} from '@cpa/plugin-kernel'
import { MainPluginModuleLoader, type BundledEntryLoader } from '../loading/MainPluginModuleLoader.js'
import { MainCapabilityBroker } from '../capabilities/MainCapabilityBroker.js'
import { bundledMainEntryLoaders } from '../generated/bundledPluginLoaders.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../../../../')

export interface MainPluginRuntimeHostOptions {
    catalog?: PluginCatalog
    runtime?: PluginRuntime
    moduleLoader?: MainPluginModuleLoader
    capabilityBroker?: MainCapabilityBroker
    contributionRegistry?: ContributionRegistry
    eventBus?: PluginEventBus
    cpaVersion?: string
    bundledPackages?: readonly ResolvedPluginPackage[]
    enabledPluginIds?: Iterable<string>
    defaultDefinitions?: Record<string, PluginEntryDefinition>
    entryLoaders?: Record<string, BundledEntryLoader>
    graphDTO?: ResolvedPluginGraphDTO
}

/**
 * Returns default bundled plugin package definitions.
 */
export function getDefaultBundledPackages(): readonly ResolvedPluginPackage[] {
    const bundledDir = path.join(repoRoot, 'plugins', 'bundled')
    if (!fs.existsSync(bundledDir)) {
        return Object.freeze([])
    }

    const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
    const pkgs: ResolvedPluginPackage[] = []

    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifestPath = path.join(bundledDir, entry.name, 'manifest.json')
        if (!fs.existsSync(manifestPath)) continue

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
            if (manifest.entries?.main) {
                pkgs.push({
                    manifest,
                    entries: {
                        main: path.join(bundledDir, entry.name, manifest.entries.main),
                    },
                    sourceRoot: path.join(bundledDir, entry.name),
                    source: {
                        kind: 'bundled',
                        spec: `bundled:${manifest.id}`,
                    },
                })
            }
        } catch {
            // Ignore invalid manifest
        }
    }

    pkgs.sort((a, b) => {
        const pA = a.manifest.activationPriority ?? 1000
        const pB = b.manifest.activationPriority ?? 1000
        if (pA !== pB) return pA - pB
        return a.manifest.id.localeCompare(b.manifest.id)
    })

    return Object.freeze(pkgs)
}

/**
 * MainPluginRuntimeHost orchestrates the lifecycle of Main process plugins,
 * generation lease tracking, and unified module loading.
 */
export class MainPluginRuntimeHost {
    readonly catalog: PluginCatalog
    readonly runtime: PluginRuntime
    readonly moduleLoader: MainPluginModuleLoader
    readonly capabilityBroker: MainCapabilityBroker
    readonly contributionRegistry: ContributionRegistry
    readonly eventBus: PluginEventBus
    private graphDTO?: ResolvedPluginGraphDTO

    constructor(options: MainPluginRuntimeHostOptions = {}) {
        this.graphDTO = options.graphDTO
        this.contributionRegistry = options.contributionRegistry ?? new ContributionRegistry()
        this.eventBus = options.eventBus ?? new PluginEventBus()
        this.capabilityBroker = options.capabilityBroker ?? new MainCapabilityBroker()
        const defaultDefinitions: Record<string, PluginEntryDefinition> = {
            ...(options.defaultDefinitions ?? {}),
        }
        const loaders = {
            ...bundledMainEntryLoaders,
            ...(options.entryLoaders ?? {}),
        }

        this.moduleLoader =
            options.moduleLoader ??
            new MainPluginModuleLoader(undefined, defaultDefinitions, loaders)

        const defaultPackages = getDefaultBundledPackages()
        const packages = options.bundledPackages
            ? [...defaultPackages, ...options.bundledPackages]
            : defaultPackages

        const enabledIds =
            options.enabledPluginIds ??
            packages.map((pkg) => pkg.manifest.id)

        this.catalog =
            options.catalog ??
            new PluginCatalog({
                cpaVersion: options.cpaVersion ?? '1.0.0',
                packages,
                enabledPluginIds: enabledIds,
            })

        const broker = this.capabilityBroker

        this.runtime =
            options.runtime ??
            new PluginRuntime({
                catalog: this.catalog,
                registry: this.contributionRegistry,
                eventBus: this.eventBus,
                loader: this.moduleLoader,
                entryKind: 'main',
                capabilityClientFactory: (manifest, _entryKind, generation) => {
                    const handle = broker.grant(
                        {
                            pluginId: manifest.id,
                            senderId: 0,
                            frameUrl: '',
                            transport: 'electron',
                            runtime: 'main',
                            generation,
                        },
                        manifest.capabilities ?? [],
                        generation,
                    )
                    return {
                        getHandle: () => handle,
                        has: (capability: CapabilityId) =>
                            (manifest.capabilities ?? []).some((pattern) =>
                                matchesCapability(pattern, capability),
                            ),
                        invoke: async <TResult = unknown>(method: string, args: unknown[] = []) => {
                            return (await broker.invoke(handle, method, args, {
                                pluginId: manifest.id,
                                senderId: 0,
                                frameUrl: '',
                                transport: 'electron',
                                runtime: 'main',
                            })) as TResult
                        },
                        subscribe: <T = unknown>(
                            eventName: string,
                            listener: (payload: T) => void,
                        ) => {
                            return broker.subscribe(
                                handle,
                                eventName,
                                listener as (payload: unknown) => void,
                                {
                                    pluginId: manifest.id,
                                    senderId: 0,
                                    frameUrl: '',
                                    transport: 'electron',
                                    runtime: 'main',
                                },
                            )
                        },
                    }
                },
            })
    }

    /**
     * Get the resolved plugin graph DTO if set.
     */
    getGraphDTO(): ResolvedPluginGraphDTO | undefined {
        return this.graphDTO
    }

    /**
     * Set the resolved plugin graph DTO.
     */
    setGraphDTO(graph: ResolvedPluginGraphDTO): void {
        this.graphDTO = graph
    }

    /**
     * Get current generation number.
     */
    getGeneration(): number {
        return this.runtime.getGeneration()
    }

    /**
     * Activate all enabled plugins in topological dependency order.
     */
    async activateAll(): Promise<void> {
        await this.runtime.activateAll()
    }

    /**
     * Activate a specific plugin by ID.
     */
    async activatePlugin(pluginId: string): Promise<void> {
        await this.runtime.activatePlugin(pluginId)
    }

    /**
     * Deactivate a specific plugin and its dependents in reverse topological order.
     */
    async deactivatePlugin(pluginId: string): Promise<void> {
        await this.runtime.deactivatePlugin(pluginId)
        this.capabilityBroker.revokePlugin(pluginId)
    }

    /**
     * Check if a plugin is currently active.
     */
    isPluginActive(pluginId: string): boolean {
        return this.runtime.isPluginActive(pluginId)
    }

    /**
     * Get all active plugin IDs.
     */
    getActivePluginIds(): readonly string[] {
        return this.runtime.getActivePluginIds()
    }

    /**
     * Acquire a generation lease protecting active plugins from teardown until released.
     */
    acquireGeneration(pluginIds?: readonly string[]): PluginGenerationLease {
        return this.runtime.acquireGeneration(pluginIds)
    }

    /**
     * Get summary status for all registered plugins.
     */
    getPluginSummaries(): readonly PluginSummary[] {
        return this.runtime.getPluginSummaries()
    }

    /**
     * Get execution and lifecycle metrics for all known plugins.
     */
    getPluginMetrics(): PluginRuntimeMetric[] {
        return this.runtime.getPluginMetrics()
    }

    /**
     * Record an execution metric event for a plugin.
     */
    recordMetric(
        pluginId: string,
        durationMs: number,
        options?: { isError?: boolean; isTimeout?: boolean; isActivation?: boolean },
    ): void {
        this.runtime.recordMetric(pluginId, durationMs, options)
    }

    /**
     * Dispose all active plugins, waiting for active generation leases to drain.
     */
    async dispose(): Promise<void> {
        const activeIds = this.runtime.getActivePluginIds()
        for (const id of activeIds) {
            try {
                await this.runtime.deactivatePlugin(id)
                this.capabilityBroker.revokePlugin(id)
            } catch (err) {
                console.error(`Error deactivating plugin "${id}" during host dispose:`, err)
            }
        }
    }
}
