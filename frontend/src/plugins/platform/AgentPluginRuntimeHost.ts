import {
    type CapabilityHandle,
    type HostServices,
    type PluginEntryDefinition,
    type PluginSummary,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginPackage,
    HOST_SERVICE_TOKENS,
    PluginCapabilityError,
} from '@cpa/plugin-api'
import { getDefaultHostServices } from '@cpa/plugin-ui'
import {
    PluginCatalog,
    PluginRuntime,
    ContributionRegistry,
    PluginEventBus,
    type PluginGenerationLease,
    type PluginModuleLoader,
    type PluginRuntimeMetric,
    type PreparedRuntimeGeneration,
} from '@cpa/plugin-kernel'
import { AgentPluginModuleLoader } from './AgentPluginModuleLoader'
import { RendererRegistry } from './rendererRegistry'
import {
    RendererCapabilityClient,
    type CapabilityTransport,
    type CapabilitySubscribeTransport,
} from './RendererCapabilityClient'
import {
    bundledAgentEntryLoaders,
    bundledAgentPackages,
    type BundledEntryLoader,
} from '../generated/bundledPluginLoaders'
import { getHostTransport } from '@/application/services/hostTransport'

export function getDefaultBundledPackages(): readonly ResolvedPluginPackage[] {
    return bundledAgentPackages
}

export interface AgentPluginRuntimeHostOptions {
    catalog?: PluginCatalog
    runtime?: PluginRuntime
    moduleLoader?: PluginModuleLoader
    registry?: RendererRegistry
    contributionRegistry?: ContributionRegistry
    eventBus?: PluginEventBus
    cpaVersion?: string
    bundledPackages?: readonly ResolvedPluginPackage[]
    enabledPluginIds?: Iterable<string>
    defaultDefinitions?: Record<string, PluginEntryDefinition>
    entryLoaders?: Record<string, BundledEntryLoader>
}

/**
 * AgentPluginRuntimeHost manages the lifecycle, generation lease boundaries,
 * and independent contribution registry for all plugins executing in the Agent runtime.
 */
export class AgentPluginRuntimeHost {
    readonly catalog: PluginCatalog
    readonly runtime: PluginRuntime
    readonly moduleLoader: PluginModuleLoader
    readonly registry: RendererRegistry
    readonly contributionRegistry: ContributionRegistry
    readonly eventBus: PluginEventBus

    private readonly pluginHandles = new Map<string, Map<number, CapabilityHandle>>()
    private readonly listeners = new Set<() => void>()
    private customTransport?: CapabilityTransport
    private customSubscribe?: CapabilitySubscribeTransport

    constructor(options: AgentPluginRuntimeHostOptions = {}) {
        this.registry =
            options.registry ??
            new RendererRegistry(
                options.contributionRegistry ?? new ContributionRegistry(),
            )
        this.contributionRegistry = this.registry.kernelRegistry
        this.eventBus = options.eventBus ?? new PluginEventBus()

        const loaders = {
            ...bundledAgentEntryLoaders,
            ...(options.entryLoaders ?? {}),
        }

        this.moduleLoader =
            options.moduleLoader ??
            new AgentPluginModuleLoader(loaders, options.defaultDefinitions)

        const defaultPackages = getDefaultBundledPackages()
        const packages =
            options.bundledPackages !== undefined
                ? options.bundledPackages
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

        this.runtime =
            options.runtime ??
            new PluginRuntime({
                catalog: this.catalog,
                registry: this.contributionRegistry,
                eventBus: this.eventBus,
                loader: this.moduleLoader,
                entryKind: 'agent',
                capabilityClientFactory: (manifest, entryKind, generation) => {
                    const handle = this.getPluginHandle(manifest.id, generation)
                    if (!handle) {
                        return {
                            getHandle: () => '' as CapabilityHandle,
                            has: () => false,
                            invoke: async () => {
                                throw new PluginCapabilityError(
                                    `No capability handle granted for plugin "${manifest.id}" in runtime "${entryKind}"`,
                                    { pluginId: manifest.id },
                                )
                            },
                            subscribe: () => {
                                throw new PluginCapabilityError(
                                    `No capability handle granted for plugin "${manifest.id}" in runtime "${entryKind}"`,
                                    { pluginId: manifest.id },
                                )
                            },
                        }
                    }

                    return new RendererCapabilityClient({
                        handle,
                        manifest,
                        transport: (h, method, args) => {
                            if (this.customTransport) {
                                return this.customTransport(h, method, args)
                            }
                            const hostTrans = getHostTransport()
                            if (hostTrans?.invoke) {
                                return hostTrans.invoke(h, method, args)
                            }
                            return Promise.resolve(undefined)
                        },
                        subscribe: (h, eventName, listener) => {
                            if (this.customSubscribe) {
                                return this.customSubscribe(h, eventName, listener)
                            }
                            const hostTrans = getHostTransport()
                            if (hostTrans?.subscribe) {
                                return hostTrans.subscribe(h, eventName, listener)
                            }
                            return () => {}
                        },
                    })
                },
                serviceResolver: (serviceId) => {
                    const defaultServices = getDefaultHostServices()
                    if (defaultServices) {
                        const match = Object.entries(HOST_SERVICE_TOKENS).find(
                            ([, t]) => t.id === serviceId,
                        )
                        if (match) {
                            const key = match[0] as keyof HostServices
                            return (defaultServices as any)[key]
                        }
                        return (defaultServices as any)[serviceId]
                    }
                    return undefined
                },
            })
    }

    setHostServices(_services: HostServices): void {
        // Kept for interface compatibility
    }

    setTransport(
        transport?: CapabilityTransport,
        subscribeTransport?: CapabilitySubscribeTransport,
    ): void {
        this.customTransport = transport
        this.customSubscribe = subscribeTransport
    }

    setCapabilityTransport(
        transport?: CapabilityTransport,
        subscribeTransport?: CapabilitySubscribeTransport,
    ): void {
        this.customTransport = transport
        if (subscribeTransport !== undefined) {
            this.customSubscribe = subscribeTransport
        }
    }

    clearHandles(generation?: number): void {
        if (generation !== undefined) {
            for (const byGen of this.pluginHandles.values()) {
                byGen.delete(generation)
            }
        } else {
            this.pluginHandles.clear()
        }
    }

    setPluginHandle(
        pluginId: string,
        arg1: number | CapabilityHandle,
        arg2?: number | CapabilityHandle
    ): void {
        let gen: number
        let h: CapabilityHandle
        if (typeof arg1 === 'number' && typeof arg2 === 'string') {
            gen = arg1
            h = arg2 as CapabilityHandle
        } else if (typeof arg1 === 'string' && typeof arg2 === 'number') {
            h = arg1 as CapabilityHandle
            gen = arg2
        } else if (typeof arg1 === 'string') {
            h = arg1 as CapabilityHandle
            gen = 1
        } else {
            gen = 1
            h = String(arg2 ?? arg1) as CapabilityHandle
        }
        let byGen = this.pluginHandles.get(pluginId)
        if (!byGen) {
            byGen = new Map()
            this.pluginHandles.set(pluginId, byGen)
        }
        byGen.set(gen, h)
        byGen.set(0, h)
    }

    getPluginHandle(
        pluginId: string,
        generation: number
    ): CapabilityHandle | undefined {
        const byGen = this.pluginHandles.get(pluginId)
        return byGen?.get(generation) ?? byGen?.get(1) ?? byGen?.get(0)
    }

    notify(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener()
            } catch (err) {
                console.error('[AgentPluginRuntimeHost] Listener failed:', err)
            }
        }
    }

    /**
     * Subscribe to agent runtime lifecycle and activation changes.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    async activateAll(): Promise<void> {
        try {
            await this.runtime.activateAll()
        } finally {
            this.notify()
        }
    }

    async activatePlugin(pluginId: string): Promise<void> {
        try {
            await this.runtime.activatePlugin(pluginId)
        } finally {
            this.notify()
        }
    }

    async deactivatePlugin(pluginId: string): Promise<void> {
        try {
            await this.runtime.deactivatePlugin(pluginId)
        } finally {
            this.notify()
        }
    }

    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        targetGeneration?: number,
    ): Promise<PreparedRuntimeGeneration> {
        return await this.runtime.prepareGeneration(graphInput, targetGeneration)
    }

    acquireGeneration(pluginIds?: readonly string[]): PluginGenerationLease {
        return this.runtime.acquireGeneration(pluginIds)
    }

    getGeneration(): number {
        return this.runtime.getGeneration()
    }

    getPluginSummaries(): readonly PluginSummary[] {
        return this.runtime.getPluginSummaries()
    }

    getPluginSummary(pluginId: string): PluginSummary {
        return this.runtime.getPluginSummary(pluginId)
    }

    isPluginActive(pluginId: string): boolean {
        return this.runtime.isPluginActive(pluginId)
    }

    getPluginMetrics(): PluginRuntimeMetric[] {
        return this.runtime.getPluginMetrics()
    }

    getActivePluginIds(): readonly string[] {
        return this.runtime.getActivePluginIds()
    }

    async reset(): Promise<void> {
        for (const id of this.getActivePluginIds()) {
            try {
                await this.runtime.deactivatePlugin(id)
            } catch {
                // Ignore deactivation errors during reset
            }
        }
        this.pluginHandles.clear()
        this.notify()
    }
}

export const agentPluginRuntime = new AgentPluginRuntimeHost()
export const agentRegistry = agentPluginRuntime.registry

export function createAgentRuntimeHost(
    options?: AgentPluginRuntimeHostOptions,
): AgentPluginRuntimeHost {
    return new AgentPluginRuntimeHost(options)
}
