import {
    type CapabilityHandle,
    type HostServices,
    type PluginEntryDefinition,
    type PluginEntryKind,
    type PluginManifest,
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
} from '@cpa/plugin-kernel'
import { actionRegistry } from '@/application/actions/actionRegistry'
import { viewRegistry } from '@/application/views/viewRegistry'
import { RendererPluginModuleLoader } from './RendererPluginModuleLoader'
import {
    RendererCapabilityClient,
    type CapabilityTransport,
    type CapabilitySubscribeTransport,
} from './RendererCapabilityClient'
import { rendererRegistry, RendererRegistry } from './rendererRegistry'
import { bindRuntimeHost } from './safePluginSurface'
import { rendererEventBus } from './eventBus'
import { getHostTransport } from '@/application/services/hostTransport'
import {
    bundledRendererEntryLoaders,
    bundledRendererPackages,
    type BundledEntryLoader,
} from '../generated/bundledPluginLoaders'

export function getDefaultBundledPackages(): readonly ResolvedPluginPackage[] {
    return bundledRendererPackages
}

export interface RendererPluginRuntimeHostOptions {
    catalog?: PluginCatalog
    runtime?: PluginRuntime
    moduleLoader?: PluginModuleLoader
    capabilityClient?: RendererCapabilityClient
    contributionRegistry?: ContributionRegistry
    registry?: RendererRegistry
    eventBus?: PluginEventBus
    cpaVersion?: string
    bundledPackages?: readonly ResolvedPluginPackage[]
    enabledPluginIds?: Iterable<string>
    defaultDefinitions?: Record<string, PluginEntryDefinition>
    entryLoaders?: Record<string, BundledEntryLoader>
    peerHost?: PeerPluginRuntimeHost
}

export interface PeerPluginRuntimeHost {
    getPluginSummaries(): readonly PluginSummary[]
    getPluginSummary?(pluginId: string): PluginSummary
    isPluginActive(pluginId: string): boolean
    subscribe?(listener: () => void): () => void
}

/**
 * Enriches the low-level PluginContext with convenient registration helper methods.
 */
function enrichPluginContext(baseContext: any, onDisposer?: (disposer: () => void) => void): any {
    const rawRegister = baseContext.register.bind(baseContext)
    baseContext.register = (reg: any) => {
        let unregisterHost: (() => void) | undefined
        if (reg.kind === 'action' && reg.value) {
            unregisterHost = actionRegistry.register(reg.value)
        } else if (reg.kind === 'view' && reg.value) {
            unregisterHost = viewRegistry.registerView(reg.value)
        } else if (reg.kind === 'navigation' && reg.value) {
            unregisterHost = viewRegistry.registerNavigationItem(reg.value)
        }
        const unregisterBase = rawRegister(reg)
        const disposer = () => {
            unregisterHost?.()
            unregisterBase?.()
        }
        onDisposer?.(disposer)
        return disposer
    }

    if (!baseContext.registerSlotComponent) {
        baseContext.registerSlotComponent = (slotName: string, contribution: any) =>
            baseContext.register({
                kind: 'slot',
                id: contribution.id,
                target: slotName,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerFloating) {
        baseContext.registerFloating = (contribution: any) =>
            baseContext.register({
                kind: 'floating',
                id: contribution.id,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerComponentWrapper) {
        baseContext.registerComponentWrapper = (contribution: any) =>
            baseContext.register({
                kind: 'component-wrapper',
                id: contribution.id,
                target: contribution.targetComponent,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerPanel) {
        baseContext.registerPanel = (contribution: any) =>
            baseContext.register({
                kind: 'panel',
                id: contribution.id,
                value: contribution,
            })
    }
    if (!baseContext.registerPanelTab) {
        baseContext.registerPanelTab = (contribution: any) =>
            baseContext.register({
                kind: 'panel',
                id: contribution.id,
                value: contribution,
            })
    }
    if (!baseContext.registerView) {
        baseContext.registerView = (contribution: any) =>
            baseContext.register({
                kind: 'view',
                id: contribution.id,
                value: contribution,
            })
    }
    if (!baseContext.registerNavigationItem) {
        baseContext.registerNavigationItem = (contribution: any) =>
            baseContext.register({
                kind: 'navigation',
                id: contribution.id,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerAction) {
        baseContext.registerAction = (contribution: any) =>
            baseContext.register({
                kind: 'action',
                id: contribution.id,
                value: contribution,
            })
    }
    if (!baseContext.registerCommand) {
        baseContext.registerCommand = (contribution: any) =>
            baseContext.register({
                kind: 'action',
                id: contribution.id,
                value: contribution,
            })
    }
    if (!baseContext.registerSettingsGroup) {
        baseContext.registerSettingsGroup = (contribution: any) =>
            baseContext.register({
                kind: 'settings-group',
                id: contribution.id,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerSettingsSection) {
        baseContext.registerSettingsSection = (contribution: any) =>
            baseContext.register({
                kind: 'settings',
                id: contribution.id,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerComposerControl) {
        baseContext.registerComposerControl = (contribution: any) =>
            baseContext.register({
                kind: 'composer',
                id: contribution.id,
                value: contribution,
                priority: contribution.order,
            })
    }
    if (!baseContext.registerAttachmentProvider) {
        baseContext.registerAttachmentProvider = (provider: any) =>
            baseContext.register({
                kind: 'composer',
                id: provider.id,
                value: provider,
                priority: provider.order,
            })
    }
    if (!baseContext.registerSubmitPreprocessor) {
        baseContext.registerSubmitPreprocessor = (preprocessor: any) =>
            baseContext.register({
                kind: 'composer',
                id: preprocessor.id,
                value: preprocessor,
                priority: preprocessor.order,
            })
    }
    if (!baseContext.registerChatRenderer) {
        baseContext.registerChatRenderer = (contribution: any) =>
            baseContext.register({
                kind: 'chat-renderer',
                id: contribution.id,
                value: contribution,
                priority: contribution.priority,
            })
    }
    if (!baseContext.registerMessageRenderer) {
        baseContext.registerMessageRenderer = baseContext.registerChatRenderer
    }
    if (!baseContext.registerProtocolProvider) {
        baseContext.registerProtocolProvider = (provider: any) =>
            baseContext.register({
                kind: 'protocol',
                id: provider.id,
                value: provider,
            })
    }
    if (!baseContext.registerProtocolMiddleware) {
        baseContext.registerProtocolMiddleware = (middleware: any) =>
            baseContext.register({
                kind: 'protocol-middleware',
                id: middleware.id,
                value: middleware,
                priority: middleware.order,
            })
    }
    if (!baseContext.registerModelCatalogProvider) {
        baseContext.registerModelCatalogProvider = (provider: any) =>
            baseContext.register({
                kind: 'model-catalog',
                id: provider.id,
                value: provider,
            })
    }
    if (!baseContext.registerAgentTool) {
        baseContext.registerAgentTool = (tool: any) =>
            baseContext.register({
                kind: 'tool-factory',
                id: tool.name ?? tool.id,
                value: tool,
            })
    }
    if (!baseContext.registerToolFactory) {
        baseContext.registerToolFactory = (factory: any) =>
            baseContext.register({
                kind: 'tool-factory',
                id: factory.id ?? factory.name,
                value: factory,
            })
    }
    if (!baseContext.registerHook) {
        baseContext.registerHook = (hook: any) =>
            baseContext.register({
                kind: 'hook',
                id: hook.id,
                value: hook,
                priority: hook.order,
            })
    }
    if (!baseContext.registerSystemPrompt) {
        baseContext.registerSystemPrompt = (prompt: any) =>
            baseContext.register({
                kind: 'resource-provider',
                id: prompt.id,
                value: prompt,
                priority: prompt.order,
            })
    }
    if (!baseContext.registerResourceProvider) {
        baseContext.registerResourceProvider = (provider: any) =>
            baseContext.register({
                kind: 'resource-provider',
                id: provider.id,
                value: provider,
            })
    }
    return baseContext
}

class CompositeRendererModuleLoader implements PluginModuleLoader {
    private readonly loaders: Record<string, BundledEntryLoader>
    private readonly definitions: Record<string, PluginEntryDefinition>
    private readonly fallbackLoader: PluginModuleLoader
    private readonly contextDisposers = new WeakMap<any, Array<() => void>>()

    constructor(
        loaders: Record<string, BundledEntryLoader>,
        definitions: Record<string, PluginEntryDefinition>,
        fallbackLoader: PluginModuleLoader
    ) {
        this.loaders = loaders
        this.definitions = definitions
        this.fallbackLoader = fallbackLoader
    }

    setDefinition(id: string, def: PluginEntryDefinition): void {
        this.definitions[id] = def
    }

    cleanupContext(context: any): void {
        const disposers = this.contextDisposers.get(context)
        if (disposers) {
            for (const disposer of disposers) {
                try {
                    disposer()
                } catch {
                    // Ignore individual disposer errors
                }
            }
            this.contextDisposers.delete(context)
        }
    }

    async load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind
    ): Promise<PluginEntryDefinition | undefined> {
        const id = pluginPackage.manifest.id
        const inMemoryDef = this.definitions[id]
        if (inMemoryDef) {
            return this.wrapDefinition(inMemoryDef)
        }

        const loader = this.loaders[id]
        if (loader) {
            const loaded = await loader()
            if (loaded) {
                return this.wrapDefinition(loaded)
            }
        }

        if (pluginPackage.source?.kind !== 'bundled') {
            const fallbackLoaded = await this.fallbackLoader.load(pluginPackage, runtime)
            if (fallbackLoaded) {
                return this.wrapDefinition(fallbackLoaded)
            }
        }
        return undefined
    }

    private wrapDefinition(def: PluginEntryDefinition): PluginEntryDefinition {
        return {
            ...def,
            activate: async (context) => {
                const track = (d: () => void) => {
                    let list = this.contextDisposers.get(context)
                    if (!list) {
                        list = []
                        this.contextDisposers.set(context, list)
                    }
                    list.push(d)
                }
                const enriched = enrichPluginContext(context, track)
                await def.activate(enriched)
            },
            deactivate: async (context) => {
                if (typeof def.deactivate === 'function') {
                    await def.deactivate(context)
                }
                this.cleanupContext(context)
            },
        }
    }
}

/**
 * RendererPluginRuntimeHost manages the lifecycle, dynamic re-registration,
 * generation lease tracking, and contribution registry for the React UI.
 */
export class RendererPluginRuntimeHost {
    readonly catalog: PluginCatalog
    readonly runtime: PluginRuntime
    readonly moduleLoader: PluginModuleLoader
    readonly contributionRegistry: ContributionRegistry
    readonly registry: RendererRegistry
    readonly eventBus: PluginEventBus

    private readonly pluginHandles = new Map<string, Map<number, CapabilityHandle>>()
    private customTransport?: CapabilityTransport
    private customSubscribe?: CapabilitySubscribeTransport
    private readonly listeners = new Set<() => void>()
    private readonly pluginErrors = new Map<string, string>()
    private cachedSummaries: PluginSummary[] | null = null
    private readonly loaders: Record<string, BundledEntryLoader>
    private readonly staticDefinitions: Record<string, PluginEntryDefinition>
    private peerHost?: PeerPluginRuntimeHost
    private peerUnsubscribe?: () => void

    constructor(options: RendererPluginRuntimeHostOptions = {}) {
        this.registry = options.registry ?? rendererRegistry
        this.contributionRegistry = options.contributionRegistry ?? this.registry.kernelRegistry
        this.eventBus = options.eventBus ?? rendererEventBus

        this.loaders = {
            ...bundledRendererEntryLoaders,
            ...(options.entryLoaders ?? {}),
        }

        this.staticDefinitions = {
            ...(options.defaultDefinitions ?? {}),
        }

        const fallback = options.moduleLoader ?? new RendererPluginModuleLoader()
        this.moduleLoader = new CompositeRendererModuleLoader(this.loaders, this.staticDefinitions, fallback)

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
                entryKind: 'renderer',
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

        bindRuntimeHost(this)

        const defaultServices = getDefaultHostServices()
        if (defaultServices) {
            defaultServices.pluginManagement = {
                getPluginSummaries: () => this.getPluginSummaries(),
                subscribe: (listener) => this.subscribe(listener),
                activatePlugin: (id) => this.activatePlugin(id),
                deactivatePlugin: (id) => this.deactivatePlugin(id),
                reloadPlugin: (id) => this.reloadPlugin(id),
                isPluginActive: (id) => this.isPluginActive(id),
            }
        }

        if (options.peerHost) {
            this.setPeerHost(options.peerHost)
        }
    }

    setPeerHost(peer?: PeerPluginRuntimeHost): void {
        if (this.peerUnsubscribe) {
            this.peerUnsubscribe()
            this.peerUnsubscribe = undefined
        }
        this.peerHost = peer
        if (peer && typeof peer.subscribe === 'function') {
            this.peerUnsubscribe = peer.subscribe(() => {
                this.cachedSummaries = null
                this.notify()
            })
        }
        this.cachedSummaries = null
        this.notify()
    }

    setHostServices(_services: HostServices): void {
        // Kept for interface compatibility
    }

    setTransport(
        transport?: CapabilityTransport,
        subscribeTransport?: CapabilitySubscribeTransport
    ): void {
        this.customTransport = transport
        this.customSubscribe = subscribeTransport
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

    /**
     * Overrides the capability transport function (useful in test harnesses).
     */
    setCapabilityTransport(transport: CapabilityTransport | undefined, subscribeTransport?: CapabilitySubscribeTransport): void {
        this.customTransport = transport
        if (subscribeTransport !== undefined) {
            this.customSubscribe = subscribeTransport
        }
    }

    /**
     * Clear granted capability handles.
     */
    clearHandles(generation?: number): void {
        if (generation !== undefined) {
            for (const byGen of this.pluginHandles.values()) {
                byGen.delete(generation)
            }
        } else {
            this.pluginHandles.clear()
        }
    }

    /**
     * Overrides the capability subscribe function (useful in test harnesses).
     */
    setCapabilitySubscribe(subscribe: CapabilitySubscribeTransport | undefined): void {
        this.customSubscribe = subscribe
    }

    notify(): void {
        this.cachedSummaries = null
        for (const listener of Array.from(this.listeners)) {
            try {
                listener()
            } catch (err) {
                console.error('[RendererPluginRuntimeHost] Listener failed:', err)
            }
        }
    }

    /**
     * Subscribe to runtime status and error changes.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /**
     * Record an execution or rendering error on a specific plugin summary.
     */
    recordPluginError(pluginId: string, error: Error | string): void {
        const errorMsg = error instanceof Error ? error.message : String(error)
        this.pluginErrors.set(pluginId, errorMsg)
        this.notify()
    }

    /**
     * Register a plugin entry and manifest dynamically into the runtime host and catalog.
     */
    async registerPlugin(
        manifest: PluginManifest,
        entry: PluginEntryDefinition,
        pkgOptions?: Partial<ResolvedPluginPackage>
    ): Promise<void> {
        const id = manifest.id
        if (this.isPluginActive(id)) {
            await this.deactivatePlugin(id)
        }

        const isCore =
            manifest.criticality === 'platform' ||
            manifest.criticality === 'required' ||
            pkgOptions?.source?.kind === 'bundled'

        const pkg: ResolvedPluginPackage = {
            manifest,
            entries: { renderer: './index.ts', ...(pkgOptions?.entries ?? {}) },
            sourceRoot: pkgOptions?.sourceRoot ?? `plugins/${isCore ? 'bundled' : 'external'}/${id}`,
            source: pkgOptions?.source ?? {
                kind: isCore ? 'bundled' : 'project-config',
                spec: `${id}@${manifest.version}`,
            },
            ...pkgOptions,
        }
        this.staticDefinitions[id] = entry
        this.catalog.addPackage(pkg)
        this.catalog.enablePlugin(id)
        this.notify()
    }

    /**
     * Get current generation number.
     */
    getGeneration(): number {
        return this.runtime.getGeneration()
    }

    /**
     * Prepare a plugin generation on the renderer runtime without committing yet.
     */
    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        targetGeneration?: number,
    ) {
        const prepared = await this.runtime.prepareGeneration(graphInput, targetGeneration)
        return {
            runtime: prepared.runtime,
            generation: prepared.generation,
            preparedPluginIds: prepared.preparedPluginIds,
            commit: async () => {
                if (graphInput && Array.isArray(graphInput)) {
                    for (const pkg of graphInput) {
                        this.catalog.addPackage(pkg)
                        this.catalog.enablePlugin(pkg.manifest.id)
                    }
                }
                await prepared.commit()
                this.cachedSummaries = null
                this.notify()
            },
            rollback: async () => {
                await prepared.rollback()
            },
        }
    }

    /**
     * Activate all enabled plugins in topological dependency order.
     */
    async activateAll(): Promise<void> {
        this.pluginErrors.clear()
        try {
            await this.runtime.activateAll()
        } finally {
            this.notify()
        }
    }

    /**
     * Activate a single plugin by ID.
     */
    async activatePlugin(pluginId: string): Promise<void> {
        try {
            await this.runtime.activatePlugin(pluginId)
            this.pluginErrors.delete(pluginId)
        } catch (err) {
            this.recordPluginError(pluginId, err instanceof Error ? err : String(err))
            throw err
        } finally {
            this.notify()
        }
    }

    /**
     * Deactivate a single plugin by ID and cascade to its dependents.
     */
    async deactivatePlugin(pluginId: string): Promise<void> {
        try {
            await this.runtime.deactivatePlugin(pluginId)
        } finally {
            this.notify()
        }
    }

    /**
     * Acquire a generation lease preventing deactivation while active.
     */
    acquireGeneration(pluginIds?: readonly string[]): PluginGenerationLease {
        return this.runtime.acquireGeneration(pluginIds)
    }

    /**
     * Get all plugin summaries with current active/error/inactive statuses.
     */
    getPluginSummaries(): readonly PluginSummary[] {
        if (!this.cachedSummaries) {
            const rawSummaries = this.runtime.getPluginSummaries()
            this.cachedSummaries = rawSummaries.map((s) => {
                const pkg = this.catalog.getPackage(s.manifest.id)
                const isCore = pkg
                    ? (pkg.source?.kind === 'bundled')
                    : (s.isCore ?? (s.manifest.criticality === 'required' || s.manifest.criticality === 'platform'))

                const entries = s.manifest.entries
                const hasRendererEntry = Boolean(entries && entries.renderer)
                const hasAgentEntry = Boolean(entries && entries.agent)

                let peerError: string | undefined
                let peerSummary: PluginSummary | undefined
                if (this.peerHost && hasAgentEntry) {
                    try {
                        peerSummary = this.peerHost.getPluginSummary?.(s.manifest.id)
                        if (peerSummary?.status === 'error' || peerSummary?.error) {
                            peerError = peerSummary.error || 'Peer runtime encountered an error'
                        }
                    } catch {
                        // Peer may not have this plugin
                    }
                }

                const error = this.pluginErrors.get(s.manifest.id) || s.error || peerError
                let status = error ? 'error' : s.status

                if (status !== 'error' && this.peerHost) {
                    if (!hasRendererEntry && hasAgentEntry) {
                        if (this.peerHost.isPluginActive(s.manifest.id) || peerSummary?.status === 'active') {
                            status = 'active'
                        } else if (peerSummary) {
                            status = peerSummary.status
                        }
                    }
                }

                return {
                    ...s,
                    status,
                    error,
                    isCore,
                }
            })
        }
        return this.cachedSummaries
    }

    /**
     * Get a single plugin summary by ID.
     */
    getPluginSummary(pluginId: string): PluginSummary {
        const raw = this.runtime.getPluginSummary(pluginId)
        const pkg = this.catalog.getPackage(pluginId)
        const isCore = pkg
            ? (pkg.source?.kind === 'bundled')
            : (raw.isCore ?? (raw.manifest.criticality === 'required' || raw.manifest.criticality === 'platform'))

        const entries = raw.manifest.entries
        const hasRendererEntry = Boolean(entries && entries.renderer)
        const hasAgentEntry = Boolean(entries && entries.agent)

        let peerError: string | undefined
        let peerSummary: PluginSummary | undefined
        if (this.peerHost && hasAgentEntry) {
            try {
                peerSummary = this.peerHost.getPluginSummary?.(pluginId)
                if (peerSummary?.status === 'error' || peerSummary?.error) {
                    peerError = peerSummary.error || 'Peer runtime encountered an error'
                }
            } catch {
                // Peer may not have this plugin
            }
        }

        const error = this.pluginErrors.get(pluginId) || raw.error || peerError
        let status = error ? 'error' : raw.status

        if (status !== 'error' && this.peerHost) {
            if (!hasRendererEntry && hasAgentEntry) {
                if (this.peerHost.isPluginActive(pluginId) || peerSummary?.status === 'active') {
                    status = 'active'
                } else if (peerSummary) {
                    status = peerSummary.status
                }
            }
        }

        return {
            ...raw,
            status,
            error,
            isCore,
        }
    }

    /**
     * Check if a plugin is currently active.
     */
    isPluginActive(pluginId: string): boolean {
        if (this.runtime.isPluginActive(pluginId)) {
            return true
        }
        if (this.peerHost) {
            const pkg = this.catalog.getPackage(pluginId)
            const entries = pkg?.manifest.entries
            const hasRendererEntry = Boolean(entries && entries.renderer)
            const hasAgentEntry = Boolean(entries && entries.agent)
            if (!hasRendererEntry && hasAgentEntry) {
                return this.peerHost.isPluginActive(pluginId)
            }
        }
        return false
    }

    /**
     * Get runtime metrics for profiling.
     */
    getPluginMetrics(): PluginRuntimeMetric[] {
        return this.runtime.getPluginMetrics()
    }

    /**
     * Get active plugin IDs.
     */
    getActivePluginIds(): readonly string[] {
        return this.runtime.getActivePluginIds()
    }

    /**
     * Reload a plugin by deactivating and reactivating it.
     */
    async reloadPlugin(pluginId: string): Promise<void> {
        if (this.isPluginActive(pluginId)) {
            await this.deactivatePlugin(pluginId)
        }
        await this.activatePlugin(pluginId)
    }

    /**
     * Reset the runtime state and clear contributions.
     */
    async reset(): Promise<void> {
        for (const id of this.getActivePluginIds()) {
            try {
                await this.runtime.deactivatePlugin(id)
            } catch {
                // Ignore deactivation errors during reset
            }
        }
        this.pluginErrors.clear()
        this.pluginHandles.clear()
        this.notify()
    }
}

export const rendererPluginRuntime = new RendererPluginRuntimeHost()

export function createRendererRuntimeHost(
    options?: RendererPluginRuntimeHostOptions
): RendererPluginRuntimeHost {
    return new RendererPluginRuntimeHost(options)
}
