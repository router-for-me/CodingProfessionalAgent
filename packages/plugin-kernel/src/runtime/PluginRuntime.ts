import type {
    CapabilityId,
    ContributionRegistration,
    PluginCapabilityClient,
    PluginContext,
    PluginEntryDefinition,
    PluginEntryKind,
    PluginIdentity,
    PluginManifest,
    PluginStatus,
    PluginSummary,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import {
    PluginActivationError,
    PluginCapabilityError,
    PluginConflictError,
    matchesCapability,
    resolvePackageCriticality,
} from '@cpa/plugin-api'
import { PluginCatalog } from '../catalog/PluginCatalog.js'
import type { ResolvedPluginGraph } from '../dependencies/DependencyResolver.js'
import {
    ContributionRegistry,
    isSingleValueContributionKind,
    type StagedTransactionEntry,
} from '../registry/ContributionRegistry.js'
import { ManifestContributionPolicy } from '../registry/ManifestContributionPolicy.js'
import { PluginEventBus, type StagedPluginEventBus } from '../events/PluginEventBus.js'
import { GenerationLeaseManager, type PluginGenerationLease } from './GenerationLease.js'
import { safeInvoke } from '../safety/safeInvoke.js'

export interface PluginModuleLoader<T = any> {
    load(
        pluginPackage: ResolvedPluginPackage,
        runtime: PluginEntryKind,
    ): Promise<T | undefined>
}

export interface PreparedRuntimeGeneration {
    readonly runtime: PluginRuntime
    readonly generation: number
    readonly preparedPluginIds: readonly string[]
    commit(): Promise<void>
    rollback(): Promise<void>
}

export interface PluginRuntimeMetric {
    pluginId: string
    activationCount: number
    callCount: number
    totalDurationMs: number
    maxDurationMs: number
    errorCount: number
    timeoutCount: number
    activeLeases: number
}

class DefaultModuleLoader implements PluginModuleLoader {
    async load(): Promise<PluginEntryDefinition | undefined> {
        return undefined
    }
}

/**
 * Default capability client that enforces declared capabilities but denies
 * execution when no host capability transport is configured.
 */
export class DenyByDefaultCapabilityClient implements PluginCapabilityClient {
    constructor(
        private readonly manifest: PluginManifest,
        private readonly runtime: PluginEntryKind,
    ) {}

    has(capability: CapabilityId): boolean {
        const capabilities = this.manifest.capabilities ?? []
        return capabilities.some((pattern) => matchesCapability(pattern, capability))
    }

    async invoke<TResult = unknown>(method: string, _args?: unknown[]): Promise<TResult> {
        throw new PluginCapabilityError(
            `Capability invocation denied for plugin "${this.manifest.id}" on runtime "${this.runtime}": method "${method}" has no capability transport configured`,
            { pluginId: this.manifest.id },
        )
    }

    subscribe<T = unknown>(_eventName: string, _listener: (payload: T) => void): () => void {
        return () => {}
    }
}

function isPluginEntryDefinition(def: unknown): def is PluginEntryDefinition {
    return (
        typeof def === 'object' &&
        def !== null &&
        'runtime' in def &&
        typeof (def as any).runtime === 'string' &&
        typeof (def as any).activate === 'function'
    )
}

class AsyncMutex {
    private queue: Promise<void> = Promise.resolve()

    async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void
        const nextLock = new Promise<void>((resolve) => {
            release = resolve
        })

        const previousLock = this.queue
        this.queue = this.queue.then(
            () => nextLock,
            () => nextLock,
        )

        await previousLock
        try {
            return await fn()
        } finally {
            release!()
        }
    }
}

interface ActivePluginState {
    readonly manifest: PluginManifest
    readonly definition?: PluginEntryDefinition
    readonly context: PluginContext
    readonly ownerToken: symbol
    readonly disposers: Array<() => void>
    readonly generation: number
    status: PluginStatus
    error?: string
}

interface StatusOverride {
    status: PluginStatus
    error?: string
}

export interface PluginRuntimeOptions {
    catalog: PluginCatalog
    registry?: ContributionRegistry
    eventBus?: PluginEventBus
    loader?: PluginModuleLoader
    entryKind?: PluginEntryKind
    activateTimeoutMs?: number
    deactivateTimeoutMs?: number
    capabilityClientFactory?: (
        manifest: PluginManifest,
        runtime: PluginEntryKind,
        generation: number,
    ) => PluginCapabilityClient
    serviceResolver?: <T>(serviceId: string) => T | undefined
}

/**
 * Universal Plugin Runtime managing deterministic plugin lifecycles,
 * generation lease boundaries, scoped transactions, and reverse topological teardown.
 */
export class PluginRuntime {
    readonly catalog: PluginCatalog
    readonly registry: ContributionRegistry
    readonly eventBus: PluginEventBus
    readonly loader: PluginModuleLoader
    readonly entryKind: PluginEntryKind
    readonly capabilityClientFactory?: (
        manifest: PluginManifest,
        runtime: PluginEntryKind,
        generation: number,
    ) => PluginCapabilityClient
    readonly leaseManager = new GenerationLeaseManager()
    readonly serviceResolver?: <T>(serviceId: string) => T | undefined

    private readonly activateTimeoutMs?: number
    private readonly deactivateTimeoutMs?: number
    private readonly mutex = new AsyncMutex()
    private readonly activePlugins = new Map<string, ActivePluginState>()
    private readonly statusOverrides = new Map<string, StatusOverride>()
    private committedGraphDTO: ResolvedPluginGraphDTO | null = null
    private readonly metrics = new Map<
        string,
        {
            activationCount: number
            callCount: number
            totalDurationMs: number
            maxDurationMs: number
            errorCount: number
            timeoutCount: number
        }
    >()
    private generation = 0

    constructor(options: PluginRuntimeOptions) {
        this.catalog = options.catalog
        this.registry = options.registry ?? new ContributionRegistry()
        this.eventBus = options.eventBus ?? new PluginEventBus()
        this.loader = options.loader ?? new DefaultModuleLoader()
        this.entryKind = options.entryKind ?? 'main'
        this.activateTimeoutMs = options.activateTimeoutMs
        this.deactivateTimeoutMs = options.deactivateTimeoutMs
        this.capabilityClientFactory = options.capabilityClientFactory
        this.serviceResolver = options.serviceResolver
    }

    /**
     * Get the current runtime generation number.
     */
    getGeneration(): number {
        return this.generation
    }

    /**
     * Check if a plugin is currently active.
     */
    isPluginActive(pluginId: string): boolean {
        return this.activePlugins.get(pluginId)?.status === 'active'
    }

    /**
     * Get all active plugin IDs.
     */
    getActivePluginIds(): readonly string[] {
        const ids: string[] = []
        for (const [id, state] of this.activePlugins) {
            if (state.status === 'active') {
                ids.push(id)
            }
        }
        return Object.freeze(ids)
    }

    /**
     * Acquire a generation lease protecting a set of plugins from teardown
     * until the lease is released.
     */
    acquireGeneration(pluginIds?: readonly string[]): PluginGenerationLease {
        const targetIds = pluginIds ?? this.getActivePluginIds()
        return this.leaseManager.acquire(this.generation, targetIds)
    }

    /**
     * Prepare a plugin generation across all packages in the graph.
     * Staged contributions are isolated and NOT exposed to the active registry until commit().
     */
    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        targetGeneration?: number,
    ): Promise<PreparedRuntimeGeneration> {
        return this.mutex.runExclusive(async () => {
            const nextGeneration = targetGeneration ?? this.generation + 1
            const packages = this._extractPackages(graphInput)

            interface StagedEntry {
                pkg: ResolvedPluginPackage
                definition?: PluginEntryDefinition
                context: PluginContext
                ownerToken: symbol
                transaction: any
                stagedEventBus: StagedPluginEventBus
                startTime: number
                isError?: boolean
                isTimeout?: boolean
            }

            const stagedEntries: StagedEntry[] = []
            const stagedSingleValues = new Map<string, string>()

            const isPackageEnabled = (id: string): boolean => {
                if (!graphInput) {
                    return this.catalog.isEnabled(id)
                }
                if (graphInput instanceof PluginCatalog) {
                    return graphInput.isEnabled(id)
                }
                return true
            }

            for (const pkg of packages) {
                const pluginId = pkg.manifest.id
                if (!isPackageEnabled(pluginId)) {
                    continue
                }

                const criticality = resolvePackageCriticality(pkg)
                const isCritical = criticality === 'platform' || criticality === 'required'

                const startTime = Date.now()
                let isError = false
                let isTimeout = false

                const identity: PluginIdentity = {
                    id: pkg.manifest.id,
                    version: pkg.manifest.version,
                }

                const transaction = this.registry.beginActivation(identity, { isolated: true })
                const ownerToken = transaction.ownerToken
                const stagedEventBus = this.eventBus.createStaged(ownerToken)

                let policy: ManifestContributionPolicy | undefined

                const capabilityClient: PluginCapabilityClient = this.capabilityClientFactory
                    ? this.capabilityClientFactory(pkg.manifest, this.entryKind, nextGeneration)
                    : new DenyByDefaultCapabilityClient(pkg.manifest, this.entryKind)

                const context: PluginContext = {
                    manifest: pkg.manifest,
                    generation: nextGeneration,
                    capabilities: new Set(pkg.manifest.capabilities ?? []),
                    capabilityClient,
                    events: stagedEventBus,
                    register: <T>(reg: ContributionRegistration<T>) => {
                        if (policy) {
                            policy.assertDeclared(reg.kind, reg.id)
                        }
                        if (isSingleValueContributionKind(reg.kind)) {
                            const singleKey = `${reg.kind}:${reg.id}`
                            const existingOwner = stagedSingleValues.get(singleKey)
                            if (existingOwner && existingOwner !== pkg.manifest.id) {
                                throw new PluginConflictError(
                                    `Contribution conflict: ${reg.kind}/${reg.id} is registered multiple times in the same generation (owned by ${existingOwner} and ${pkg.manifest.id})`,
                                    { pluginId: pkg.manifest.id },
                                )
                            }
                            stagedSingleValues.set(singleKey, pkg.manifest.id)
                        }
                        transaction.register(reg.kind, reg.id, reg.value, {
                            target: reg.target,
                            priority: reg.priority,
                        })
                        return () => {
                            // Staged disposers returned upon commit
                        }
                    },
                    getService: <T>(serviceOrToken: any): T => {
                        const serviceId = typeof serviceOrToken === 'string' ? serviceOrToken : (serviceOrToken?.id ?? String(serviceOrToken))
                        const committedService = this.registry.get<T>('service', serviceId)
                        if (committedService !== undefined) {
                            return committedService
                        }
                        const inCurrent = transaction.getStaged<T>('service', serviceId)
                        if (inCurrent !== undefined) {
                            return inCurrent
                        }
                        for (const staged of stagedEntries) {
                            const inStaged = staged.transaction.getStaged('service', serviceId)
                            if (inStaged !== undefined) {
                                return inStaged as T
                            }
                        }
                        const resolved = this.serviceResolver?.(serviceId)
                        if (resolved !== undefined) {
                            return resolved as T
                        }
                        throw new Error(`Service "${serviceId}" not found`)
                    },
                }

                try {
                    const loadResult = await safeInvoke(
                        () => this.loader.load(pkg, this.entryKind),
                        {
                            timeoutMs: this.activateTimeoutMs,
                            pluginId,
                            actionName: 'load',
                        },
                    )

                    if (!loadResult.ok) {
                        isError = true
                        if (
                            (loadResult.error as any)?.code === 'PLUGIN_TIMEOUT' ||
                            loadResult.error.message.includes('Timeout')
                        ) {
                            isTimeout = true
                        }
                        transaction.rollback()
                        stagedEventBus.rollback()
                        this.eventBus.revokeOwner(ownerToken)
                        this.statusOverrides.set(pluginId, {
                            status: 'error',
                            error: loadResult.error.message,
                        })
                        if (isCritical) {
                            // Rollback previously staged entries in this run
                            for (const staged of stagedEntries) {
                                staged.transaction.rollback()
                                staged.stagedEventBus.rollback()
                                this.eventBus.revokeOwner(staged.ownerToken)
                            }
                            throw new PluginActivationError(
                                `Failed to load plugin "${pluginId}": ${loadResult.error.message}`,
                                { pluginId, cause: loadResult.error },
                            )
                        }
                        continue
                    }

                    const definition = loadResult.value

                    if (definition && isPluginEntryDefinition(definition)) {
                        if (definition.runtime !== this.entryKind) {
                            isError = true
                            transaction.rollback()
                            stagedEventBus.rollback()
                            this.eventBus.revokeOwner(ownerToken)
                            const errorMsg = `Plugin "${pluginId}" entry runtime "${definition.runtime}" does not match host entryKind "${this.entryKind}"`
                            this.statusOverrides.set(pluginId, {
                                status: 'error',
                                error: errorMsg,
                            })
                            if (isCritical) {
                                for (const staged of stagedEntries) {
                                    staged.transaction.rollback()
                                    staged.stagedEventBus.rollback()
                                    this.eventBus.revokeOwner(staged.ownerToken)
                                }
                                throw new PluginActivationError(errorMsg, { pluginId })
                            }
                            continue
                        }
                        policy = new ManifestContributionPolicy(pkg.manifest)
                    }

                    if (definition && typeof definition.activate === 'function') {
                        const activateResult = await safeInvoke(
                            () => definition.activate(context),
                            {
                                timeoutMs: this.activateTimeoutMs,
                                pluginId,
                                actionName: 'activate',
                            },
                        )

                        if (!activateResult.ok) {
                            isError = true
                            if (
                                (activateResult.error as any)?.code === 'PLUGIN_TIMEOUT' ||
                                activateResult.error.message.includes('Timeout')
                            ) {
                                isTimeout = true
                            }
                            transaction.rollback()
                            stagedEventBus.rollback()
                            this.eventBus.revokeOwner(ownerToken)
                            this.statusOverrides.set(pluginId, {
                                status: 'error',
                                error: activateResult.error.message,
                            })
                            if (isCritical) {
                                for (const staged of stagedEntries) {
                                    staged.transaction.rollback()
                                    staged.stagedEventBus.rollback()
                                    this.eventBus.revokeOwner(staged.ownerToken)
                                }
                                throw new PluginActivationError(
                                    `Failed to activate plugin "${pluginId}": ${activateResult.error.message}`,
                                    { pluginId, cause: activateResult.error },
                                )
                            }
                            continue
                        }
                    }

                    if (!definition && pkg.entries && Object.keys(pkg.entries).length > 0 && !pkg.entries[this.entryKind]) {
                        transaction.rollback()
                        stagedEventBus.rollback()
                        this.eventBus.revokeOwner(ownerToken)
                        continue
                    }

                    stagedEntries.push({
                        pkg,
                        definition,
                        context,
                        ownerToken,
                        transaction,
                        stagedEventBus,
                        startTime,
                        isError,
                        isTimeout,
                    })
                } catch (err) {
                    if (isCritical) {
                        for (const staged of stagedEntries) {
                            staged.transaction.rollback()
                            staged.stagedEventBus.rollback()
                            this.eventBus.revokeOwner(staged.ownerToken)
                        }
                        throw err
                    }
                }
            }

            let finalized = false

            return {
                runtime: this,
                generation: nextGeneration,
                preparedPluginIds: Object.freeze(stagedEntries.map((e) => e.pkg.manifest.id)),
                commit: async () => {
                    if (finalized) return
                    finalized = true

                    await this.mutex.runExclusive(async () => {
                        // 1. Collect old active states and owner tokens for replacement and teardown
                        const oldActiveStates = Array.from(this.activePlugins.values())
                        const oldOwnerTokens = oldActiveStates.map((s) => s.ownerToken)

                        // 2. Prepare entries for atomic batch swap in ContributionRegistry
                        const batchEntries: StagedTransactionEntry[] = stagedEntries.map((entry) => ({
                            staged: entry.transaction.getStagedContributions(),
                            ownerToken: entry.ownerToken,
                        }))

                        // 3. Atomically apply generation to registry and remove old owners
                        const disposersByToken = this.registry.applyGeneration(batchEntries, oldOwnerTokens)

                        // 4. Commit staged event listeners for the new generation
                        for (const entry of stagedEntries) {
                            const eventDisposers = entry.stagedEventBus.commitListeners()
                            const currentDisposers = disposersByToken.get(entry.ownerToken) ?? []
                            disposersByToken.set(entry.ownerToken, [...currentDisposers, ...eventDisposers])
                        }

                        // 5. Mark all staging transactions as finalized
                        for (const entry of stagedEntries) {
                            entry.transaction.rollback()
                        }

                        // 5. Update active plugins
                        this.activePlugins.clear()
                        if (
                            graphInput &&
                            typeof graphInput === 'object' &&
                            'plugins' in graphInput &&
                            Array.isArray((graphInput as any).plugins)
                        ) {
                            this.committedGraphDTO = graphInput as ResolvedPluginGraphDTO
                        } else if (graphInput instanceof PluginCatalog || !graphInput) {
                            this.committedGraphDTO = null
                        }
                        for (const entry of stagedEntries) {
                            this.statusOverrides.delete(entry.pkg.manifest.id)
                            this.activePlugins.set(entry.pkg.manifest.id, {
                                manifest: entry.pkg.manifest,
                                definition: entry.definition,
                                context: entry.context,
                                ownerToken: entry.ownerToken,
                                disposers: disposersByToken.get(entry.ownerToken) ?? [],
                                generation: nextGeneration,
                                status: 'active',
                            })

                            const elapsed = Math.max(0, Date.now() - entry.startTime)
                            this.recordMetric(entry.pkg.manifest.id, elapsed, {
                                isActivation: true,
                                isError: entry.isError,
                                isTimeout: entry.isTimeout,
                            })
                        }
                        this.generation = nextGeneration

                        // 6. Safe lifecycle teardown of previous generation
                        for (const oldState of oldActiveStates) {
                            if (oldState.definition && typeof oldState.definition.deactivate === 'function') {
                                await safeInvoke(
                                    () => oldState.definition!.deactivate!(oldState.context),
                                    {
                                        timeoutMs: this.deactivateTimeoutMs,
                                        pluginId: oldState.manifest.id,
                                        actionName: 'deactivate',
                                    },
                                )
                            }
                            for (const disposer of oldState.disposers) {
                                try {
                                    disposer()
                                } catch {
                                    // Ignore individual disposer errors
                                }
                            }
                            this.eventBus.revokeOwner(oldState.ownerToken)
                            this.registry.revokeOwner(oldState.ownerToken)

                            if (!this.activePlugins.has(oldState.manifest.id)) {
                                await this.leaseManager.waitForRelease(oldState.manifest.id)
                                oldState.status = 'inactive'
                            }
                        }

                        // 8. Flush queued emits from the new generation after old generation listeners are revoked
                        for (const entry of stagedEntries) {
                            await entry.stagedEventBus.flushEmits()
                        }
                    })
                },
                rollback: async () => {
                    if (finalized) return
                    finalized = true
                    await this.mutex.runExclusive(async () => {
                        for (const entry of stagedEntries) {
                            if (entry.definition && typeof entry.definition.deactivate === 'function') {
                                await safeInvoke(
                                    () => entry.definition!.deactivate!(entry.context),
                                    {
                                        timeoutMs: this.deactivateTimeoutMs,
                                        pluginId: entry.pkg.manifest.id,
                                        actionName: 'deactivate',
                                    },
                                )
                            }
                            entry.transaction.rollback()
                            entry.stagedEventBus.rollback()
                            this.eventBus.revokeOwner(entry.ownerToken)
                        }
                    })
                },
            }
        })
    }

    private _extractPackages(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
    ): readonly ResolvedPluginPackage[] {
        if (!graphInput) {
            return this.catalog.resolveGraph().activationOrder
        }
        if (graphInput instanceof PluginCatalog) {
            return graphInput.resolveGraph().activationOrder
        }
        if (Array.isArray(graphInput)) {
            return graphInput
        }
        if ('activationOrder' in graphInput && Array.isArray(graphInput.activationOrder)) {
            if (graphInput.activationOrder.length === 0) {
                return []
            }
            const first = graphInput.activationOrder[0]
            if (typeof first === 'object' && first !== null && 'manifest' in first) {
                return graphInput.activationOrder as readonly ResolvedPluginPackage[]
            }
            const orderIds = graphInput.activationOrder as readonly string[]
            const nodeMap = new Map<string, any>()
            if ('plugins' in graphInput && Array.isArray((graphInput as any).plugins)) {
                for (const node of (graphInput as any).plugins) {
                    nodeMap.set(node.id, node)
                }
            }
            const packages: ResolvedPluginPackage[] = []
            for (const id of orderIds) {
                const pkgFromCatalog = this.catalog.getPackage(id)
                if (pkgFromCatalog) {
                    packages.push(pkgFromCatalog)
                } else {
                    const node = nodeMap.get(id)
                    if (node) {
                        packages.push({
                            manifest: node.manifest,
                            source: node.source,
                            sourceRoot: (node as any).sourceRoot ?? `/plugins/${node.id}`,
                            entries: node.entries ?? {},
                        })
                    }
                }
            }
            return packages
        }
        return this.catalog.resolveGraph().activationOrder
    }

    /**
     * Activate all enabled plugins according to the dependency resolution graph.
     */
    async activateAll(): Promise<void> {
        const prepared = await this.prepareGeneration(this.catalog)
        await prepared.commit()
    }

    /**
     * Activate a single plugin and its dependencies.
     */
    async activatePlugin(pluginId: string): Promise<void> {
        return this.mutex.runExclusive(async () => {
            const pkg = this.catalog.getPackage(pluginId)
            if (!pkg) {
                throw new PluginActivationError(`Plugin "${pluginId}" not found in catalog`, {
                    pluginId,
                })
            }
            await this._internalActivatePlugin(pkg)
        })
    }

    /**
     * Deactivate a plugin and any active plugins that depend on it in reverse topological order.
     */
    async deactivatePlugin(pluginId: string): Promise<void> {
        const state = this.activePlugins.get(pluginId)
        if (state) {
            state.status = 'deactivating'
        }

        const drainPromises = await this.mutex.runExclusive(async () => {
            const reverseOrder = this._getActiveDependentsInReverseOrder(pluginId)
            const promises: Promise<void>[] = []
            for (const id of reverseOrder) {
                const result = await this._internalDeactivateSingle(id)
                if (result) {
                    promises.push(result.drain)
                }
            }
            return promises
        })

        await Promise.all(drainPromises)
    }

    /**
     * Get summary status for a specific plugin.
     */
    getPluginSummary(pluginId: string): PluginSummary {
        const activeState = this.activePlugins.get(pluginId)
        if (activeState) {
            return {
                manifest: activeState.manifest,
                status: activeState.status,
                generation: activeState.generation,
                error: activeState.error,
            }
        }

        const override = this.statusOverrides.get(pluginId)
        const pkg = this.catalog.getPackage(pluginId)
        if (pkg && override) {
            return {
                manifest: pkg.manifest,
                status: override.status,
                generation: this.generation,
                error: override.error,
            }
        }

        const catalogSummary = this.catalog.getPluginSummary(pluginId)
        if (catalogSummary) {
            const status: PluginStatus =
                catalogSummary.status === 'resolved' ? 'inactive' : catalogSummary.status
            return {
                ...catalogSummary,
                status,
                generation: this.generation,
            }
        }

        if (this.committedGraphDTO && Array.isArray(this.committedGraphDTO.plugins)) {
            const node = this.committedGraphDTO.plugins.find((p) => p.id === pluginId)
            if (node) {
                const isCore =
                    node.sourceKind === 'bundled' ||
                    Boolean((node.manifest as any).isCore) ||
                    node.criticality === 'platform' ||
                    node.criticality === 'required'
                return {
                    manifest: node.manifest,
                    status: override?.status ?? 'inactive',
                    generation: this.generation,
                    error: override?.error,
                    isCore,
                    source: node.source,
                    sourceKind: node.sourceKind,
                }
            }
        }

        throw new Error(`Plugin "${pluginId}" not found in catalog`)
    }

    /**
     * Get summaries for all registered plugins in the catalog.
     */
    /**
     * Record a metric event for a plugin.
     */
    recordMetric(
        pluginId: string,
        durationMs: number,
        options?: { isError?: boolean; isTimeout?: boolean; isActivation?: boolean },
    ): void {
        let m = this.metrics.get(pluginId)
        if (!m) {
            m = {
                activationCount: 0,
                callCount: 0,
                totalDurationMs: 0,
                maxDurationMs: 0,
                errorCount: 0,
                timeoutCount: 0,
            }
            this.metrics.set(pluginId, m)
        }
        if (options?.isActivation) {
            m.activationCount += 1
        } else {
            m.callCount += 1
        }
        m.totalDurationMs += durationMs
        m.maxDurationMs = Math.max(m.maxDurationMs, durationMs)
        if (options?.isError) {
            m.errorCount += 1
        }
        if (options?.isTimeout) {
            m.timeoutCount += 1
        }
    }

    /**
     * Get execution and lifecycle metrics for all known plugins.
     */
    getPluginMetrics(): PluginRuntimeMetric[] {
        const ids = new Set<string>()
        for (const pkg of this.catalog.getPackages()) {
            ids.add(pkg.manifest.id)
        }
        for (const id of this.metrics.keys()) {
            ids.add(id)
        }

        const results: PluginRuntimeMetric[] = []
        for (const id of ids) {
            const m = this.metrics.get(id) ?? {
                activationCount: 0,
                callCount: 0,
                totalDurationMs: 0,
                maxDurationMs: 0,
                errorCount: 0,
                timeoutCount: 0,
            }
            const activeLeases = this.leaseManager.getLeaseCount(id)
            results.push({
                pluginId: id,
                activationCount: m.activationCount,
                callCount: m.callCount,
                totalDurationMs: m.totalDurationMs,
                maxDurationMs: m.maxDurationMs,
                errorCount: m.errorCount,
                timeoutCount: m.timeoutCount,
                activeLeases,
            })
        }
        return results
    }

    getPluginSummaries(): readonly PluginSummary[] {
        const summariesMap = new Map<string, PluginSummary>()
        for (const pkg of this.catalog.getPackages()) {
            summariesMap.set(pkg.manifest.id, this.getPluginSummary(pkg.manifest.id))
        }
        if (this.committedGraphDTO && Array.isArray(this.committedGraphDTO.plugins)) {
            for (const node of this.committedGraphDTO.plugins) {
                if (!summariesMap.has(node.id)) {
                    summariesMap.set(node.id, this.getPluginSummary(node.id))
                }
            }
        }
        for (const [id] of this.activePlugins) {
            if (!summariesMap.has(id)) {
                summariesMap.set(id, this.getPluginSummary(id))
            }
        }
        return Object.freeze(Array.from(summariesMap.values()))
    }

    private async _internalActivatePlugin(pkg: ResolvedPluginPackage): Promise<void> {
        const pluginId = pkg.manifest.id
        if (this.isPluginActive(pluginId)) {
            return
        }

        if (!this.catalog.isEnabled(pluginId)) {
            throw new PluginActivationError(`Plugin "${pluginId}" is disabled`, { pluginId })
        }

        // Activate required dependencies first
        const requiredDeps = pkg.manifest.dependencies ?? {}
        for (const depId of Object.keys(requiredDeps)) {
            if (!this.isPluginActive(depId)) {
                const depPkg = this.catalog.getPackage(depId)
                if (!depPkg) {
                    throw new PluginActivationError(
                        `Cannot activate plugin "${pluginId}": missing dependency "${depId}"`,
                        { pluginId },
                    )
                }
                await this._internalActivatePlugin(depPkg)
            }
        }

        this.statusOverrides.set(pluginId, { status: 'activating' })

        const startTime = Date.now()
        let isError = false
        let isTimeout = false

        const identity: PluginIdentity = {
            id: pkg.manifest.id,
            version: pkg.manifest.version,
        }

        const transaction = this.registry.beginActivation(identity)
        const ownerToken = transaction.ownerToken
        const stagedEventBus = this.eventBus.createStaged(ownerToken)

        const nextGeneration = this.generation + 1
        let policy: ManifestContributionPolicy | undefined

        const capabilityClient: PluginCapabilityClient = this.capabilityClientFactory
            ? this.capabilityClientFactory(pkg.manifest, this.entryKind, nextGeneration)
            : new DenyByDefaultCapabilityClient(pkg.manifest, this.entryKind)

        const context: PluginContext = {
            manifest: pkg.manifest,
            generation: nextGeneration,
            capabilities: new Set(pkg.manifest.capabilities ?? []),
            capabilityClient,
            events: stagedEventBus,
            register: <T>(reg: ContributionRegistration<T>) => {
                if (policy) {
                    policy.assertDeclared(reg.kind, reg.id)
                }
                transaction.register(reg.kind, reg.id, reg.value, {
                    target: reg.target,
                    priority: reg.priority,
                })
                return () => {
                    // Staged disposers returned upon commit
                }
            },
            getService: <T>(serviceOrToken: any): T => {
                const serviceId = typeof serviceOrToken === 'string' ? serviceOrToken : (serviceOrToken?.id ?? String(serviceOrToken))
                const service = this.registry.get<T>('service', serviceId)
                if (service !== undefined) {
                    return service
                }
                const resolved = this.serviceResolver?.(serviceId)
                if (resolved !== undefined) {
                    return resolved as T
                }
                throw new Error(`Service "${serviceId}" not found`)
            },
        }

        try {
            const loadResult = await safeInvoke(
                () => this.loader.load(pkg, this.entryKind),
                {
                    timeoutMs: this.activateTimeoutMs,
                    pluginId,
                    actionName: 'load',
                },
            )

            if (!loadResult.ok) {
                isError = true
                if ((loadResult.error as any)?.code === 'PLUGIN_TIMEOUT' || loadResult.error.message.includes('Timeout')) {
                    isTimeout = true
                }
                transaction.rollback()
                stagedEventBus.rollback()
                this.eventBus.revokeOwner(ownerToken)
                this.statusOverrides.set(pluginId, {
                    status: 'error',
                    error: loadResult.error.message,
                })
                throw new PluginActivationError(
                    `Failed to load plugin "${pluginId}": ${loadResult.error.message}`,
                    { pluginId, cause: loadResult.error },
                )
            }

            const definition = loadResult.value

            if (definition && isPluginEntryDefinition(definition)) {
                if (definition.runtime !== this.entryKind) {
                    isError = true
                    transaction.rollback()
                    stagedEventBus.rollback()
                    this.eventBus.revokeOwner(ownerToken)
                    const errorMsg = `Plugin "${pluginId}" entry runtime "${definition.runtime}" does not match host entryKind "${this.entryKind}"`
                    this.statusOverrides.set(pluginId, {
                        status: 'error',
                        error: errorMsg,
                    })
                    throw new PluginActivationError(errorMsg, { pluginId })
                }
                policy = new ManifestContributionPolicy(pkg.manifest)
            }

            if (definition && typeof definition.activate === 'function') {
                const activateResult = await safeInvoke(
                    () => definition.activate(context),
                    {
                        timeoutMs: this.activateTimeoutMs,
                        pluginId,
                        actionName: 'activate',
                    },
                )

                if (!activateResult.ok) {
                    isError = true
                    if ((activateResult.error as any)?.code === 'PLUGIN_TIMEOUT' || activateResult.error.message.includes('Timeout')) {
                        isTimeout = true
                    }
                    transaction.rollback()
                    stagedEventBus.rollback()
                    this.eventBus.revokeOwner(ownerToken)
                    this.statusOverrides.set(pluginId, {
                        status: 'error',
                        error: activateResult.error.message,
                    })
                    throw new PluginActivationError(
                        `Failed to activate plugin "${pluginId}": ${activateResult.error.message}`,
                        { pluginId, cause: activateResult.error },
                    )
                }
            }

            let disposers: Array<() => void>
            try {
                const registryDisposers = transaction.commit()
                const eventDisposers = stagedEventBus.commitListeners()
                disposers = [...registryDisposers, ...eventDisposers]
            } catch (commitErr) {
                isError = true
                transaction.rollback()
                stagedEventBus.rollback()
                this.eventBus.revokeOwner(ownerToken)
                const errorMsg = commitErr instanceof Error ? commitErr.message : String(commitErr)
                this.statusOverrides.set(pluginId, {
                    status: 'error',
                    error: errorMsg,
                })
                throw new PluginActivationError(
                    `Failed to commit contributions for plugin "${pluginId}": ${errorMsg}`,
                    { pluginId, cause: commitErr },
                )
            }

            this.generation = nextGeneration
            this.statusOverrides.delete(pluginId)
            this.activePlugins.set(pluginId, {
                manifest: pkg.manifest,
                definition,
                context,
                ownerToken,
                disposers,
                generation: this.generation,
                status: 'active',
            })

            await stagedEventBus.flushEmits()
        } finally {
            const elapsed = Math.max(0, Date.now() - startTime)
            this.recordMetric(pluginId, elapsed, {
                isActivation: true,
                isError,
                isTimeout,
            })
        }
    }

    private async _internalDeactivateSingle(
        pluginId: string,
    ): Promise<{ drain: Promise<void> } | undefined> {
        const activeState = this.activePlugins.get(pluginId)
        if (!activeState) {
            return undefined
        }

        activeState.status = 'deactivating'

        const startTime = Date.now()
        let isError = false
        let isTimeout = false

        if (activeState.definition && typeof activeState.definition.deactivate === 'function') {
            const deactResult = await safeInvoke(
                () => activeState.definition!.deactivate!(activeState.context),
                {
                    timeoutMs: this.deactivateTimeoutMs,
                    pluginId,
                    actionName: 'deactivate',
                },
            )

            if (!deactResult.ok) {
                activeState.error = deactResult.error.message
                isError = true
                if ((deactResult.error as any)?.code === 'PLUGIN_TIMEOUT' || deactResult.error.message.includes('Timeout')) {
                    isTimeout = true
                }
            }
        }

        const elapsed = Math.max(0, Date.now() - startTime)
        if (elapsed > 0 || isError) {
            this.recordMetric(pluginId, elapsed, {
                isError,
                isTimeout,
            })
        }

        // Revoke contributions and event listeners immediately
        for (const disposer of activeState.disposers) {
            try {
                disposer()
            } catch {
                // Ignore individual disposer errors
            }
        }
        this.registry.revokeOwner(activeState.ownerToken)
        this.eventBus.revokeOwner(activeState.ownerToken)

        // Return a drain promise that finalizes deactivation once leases hit 0
        const drain = this.leaseManager.waitForRelease(pluginId).then(() => {
            activeState.status = 'inactive'
            this.activePlugins.delete(pluginId)
            this.statusOverrides.delete(pluginId)
            this.generation += 1
        })

        return { drain }
    }

    private _getActiveDependentsInReverseOrder(targetPluginId: string): string[] {
        const activeIds = Array.from(this.activePlugins.keys())
        const activeSet = new Set(activeIds)

        const deps = new Map<string, Set<string>>()
        for (const id of activeIds) {
            deps.set(id, new Set())
            const pkg = this.catalog.getPackage(id)
            if (!pkg) continue

            const required = pkg.manifest.dependencies ?? {}
            const optional = pkg.manifest.optionalDependencies ?? {}

            for (const depId of Object.keys(required)) {
                if (activeSet.has(depId)) {
                    deps.get(id)!.add(depId)
                }
            }
            for (const depId of Object.keys(optional)) {
                if (activeSet.has(depId)) {
                    deps.get(id)!.add(depId)
                }
            }
        }

        function reachesTarget(start: string, visited = new Set<string>()): boolean {
            if (start === targetPluginId) return true
            visited.add(start)
            const nextSet = deps.get(start)
            if (!nextSet) return false
            for (const next of nextSet) {
                if (!visited.has(next)) {
                    if (reachesTarget(next, visited)) return true
                }
            }
            return false
        }

        const affected = new Set<string>()
        for (const id of activeIds) {
            if (reachesTarget(id)) {
                affected.add(id)
            }
        }

        const inDegree = new Map<string, number>()
        const dependents = new Map<string, Set<string>>()

        for (const id of affected) {
            dependents.set(id, new Set())
            let deg = 0
            const idDeps = deps.get(id) ?? new Set()
            for (const depId of idDeps) {
                if (affected.has(depId)) {
                    deg++
                }
            }
            inDegree.set(id, deg)
        }

        for (const id of affected) {
            const idDeps = deps.get(id) ?? new Set()
            for (const depId of idDeps) {
                if (affected.has(depId)) {
                    dependents.get(depId)!.add(id)
                }
            }
        }

        const queue: string[] = []
        for (const id of affected) {
            if (inDegree.get(id) === 0) {
                queue.push(id)
            }
        }

        const forwardOrder: string[] = []
        while (queue.length > 0) {
            queue.sort()
            const current = queue.shift()!
            forwardOrder.push(current)

            for (const depId of dependents.get(current) ?? []) {
                const newDeg = inDegree.get(depId)! - 1
                inDegree.set(depId, newDeg)
                if (newDeg === 0) {
                    queue.push(depId)
                }
            }
        }

        return forwardOrder.reverse()
    }
}
