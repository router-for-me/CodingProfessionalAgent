import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
    type CapabilityInvocationContext,
    type PluginCriticality,
    type PluginManifest,
    type PluginSourceSpec,
    type PluginSummary,
    type ResolvedPluginGraphDTO,
    type ResolvedPluginPackage,
    type RpcInvocationContext,
    PluginConflictError,
    PluginDependencyError,
    PluginError,
    resolvePackageCriticality,
} from '@cpa/plugin-api'
import {
    PluginCatalog,
    type PreparedPluginGeneration,
    type ResolvedPluginGraph,
} from '@cpa/plugin-kernel'
import {
    loadGlobalPluginConfig,
    loadProjectPluginConfig,
    prepareDurableConfig,
    finalizeDurableConfig,
    rollbackDurableConfig,
    recoverFromJournal,
    type PluginGraphJournal,
    type PluginSourceConfig,
    type PluginSourceConfigEntry,
} from '../config/pluginSourceConfig.js'
import {
    createPluginCatalog,
    type CreatePluginCatalogOptions,
} from '../catalog/createPluginCatalog.js'
import {
    computePluginGraphRevision,
    createResolvedPluginGraphDTO,
} from '../catalog/graphRevision.js'
import {
    discoverBundledPluginPackages,
} from '../catalog/bootstrapPluginGraph.js'
import { PluginResourceService } from '../resources/PluginResourceService.js'
import { ManagedNpmInstaller } from '../packages/ManagedNpmInstaller.js'
import type { MainPluginActivationCoordinator } from '../runtime/MainPluginActivationCoordinator.js'
import { getAppConfigDirName } from '../../utils/version.js'

export interface PluginGraphManagementOptions {
    homeDir: string
    projectPath?: string
    bundledDir?: string
    bundledPackages?: readonly ResolvedPluginPackage[]
    cpaVersion?: string
    resourceService?: PluginResourceService
    coordinator: MainPluginActivationCoordinator
    npmInstaller?: ManagedNpmInstaller
    configDirName?: string
    isDev?: boolean
}

export interface PrepareActionOptions {
    expectedRevision?: string
    scope?: 'project' | 'global'
}

export interface PreparedCandidateResult {
    candidateRevision: string
    generation: number
    graph: ResolvedPluginGraphDTO
    grantTickets?: Record<string, { renderer?: string; agent?: string }> | null
}

export interface PluginManagementListResult {
    plugins: readonly PluginSummary[]
    activeRevision: string
    generation: number
}

interface PendingCandidateTransaction {
    transactionId: string
    candidateRevision: string
    generation: number
    graphDTO: ResolvedPluginGraphDTO
    rawGraph: ResolvedPluginGraph
    catalog: PluginCatalog
    globalConfig: PluginSourceConfig
    projectConfig?: PluginSourceConfig
    grantTickets?: Record<string, { renderer?: string; agent?: string }> | null
    type: 'enable' | 'disable' | 'reload' | 'install' | 'uninstall'
    targetId?: string
    scope?: 'project' | 'global'
    createdAt: number
    journal?: PluginGraphJournal | null
    runtimeCommitted?: boolean
}

const TRANSACTION_TIMEOUT_MS = 60_000

/**
 * Universal Main Process Plugin Graph Management Service.
 * Coordinates multi-tier discovery, dependency graph candidate preparation,
 * two-phase cross-runtime transactions, configuration persistence, and atomic rollbacks.
 */
export class PluginGraphManagementService {
    readonly homeDir: string
    readonly projectPath?: string
    readonly bundledDir?: string
    private readonly bundledPackages?: readonly ResolvedPluginPackage[]
    readonly cpaVersion: string
    readonly resourceService: PluginResourceService
    readonly coordinator: MainPluginActivationCoordinator
    readonly npmInstaller: ManagedNpmInstaller

    private activeGlobalConfig?: PluginSourceConfig
    private activeProjectConfig?: PluginSourceConfig
    private pendingTransaction: PendingCandidateTransaction | null = null
    private readonly changeListeners = new Set<() => void>()

    constructor(options: PluginGraphManagementOptions) {
        this.homeDir = options.homeDir
        this.projectPath = options.projectPath
        this.bundledDir = options.bundledDir
        this.bundledPackages = options.bundledPackages
        this.cpaVersion = options.cpaVersion ?? '1.0.0'
        this.resourceService = options.resourceService ?? new PluginResourceService()
        this.coordinator = options.coordinator
        const configDirName = options.configDirName || getAppConfigDirName(options.isDev)
        this.npmInstaller =
            options.npmInstaller ??
            new ManagedNpmInstaller({
                pluginsDir: path.join(
                    path.resolve(this.homeDir),
                    configDirName,
                    'plugins',
                ),
            })
    }

    /**
     * Get current active revision.
     */
    getActiveRevision(): string {
        return this.coordinator.getRevision()
    }

    /**
     * Get current active generation number.
     */
    getGeneration(): number {
        return this.coordinator.getGeneration()
    }

    /**
     * Subscribe to plugin graph change events.
     */
    subscribe(listener: () => void): () => void {
        this.changeListeners.add(listener)
        return () => {
            this.changeListeners.delete(listener)
        }
    }

    private emitChange(): void {
        for (const listener of Array.from(this.changeListeners)) {
            try {
                listener()
            } catch {
                // Ignore listener error
            }
        }
    }

    private async ensureActiveConfigs(): Promise<{
        globalConfig: PluginSourceConfig
        projectConfig?: PluginSourceConfig
    }> {
        if (!this.activeGlobalConfig) {
            this.activeGlobalConfig = await loadGlobalPluginConfig(this.homeDir)
        }
        if (this.projectPath && !this.activeProjectConfig) {
            this.activeProjectConfig = await loadProjectPluginConfig(this.projectPath)
        }
        return {
            globalConfig: this.activeGlobalConfig,
            projectConfig: this.activeProjectConfig,
        }
    }

    /**
     * List all plugins across all tiers with their status, source, and metadata.
     */
    async list(): Promise<PluginManagementListResult> {
        const { globalConfig, projectConfig } = await this.ensureActiveConfigs()
        const bundledPackages =
            this.bundledPackages ?? (await discoverBundledPluginPackages(this.bundledDir))

        const discoveredPackages = await createPluginCatalog({
            projectPath: this.projectPath,
            homeDir: this.homeDir,
            bundledPackages,
            globalConfig,
            projectConfig,
            npmInstaller: this.npmInstaller,
        })

        const disabledSet = new Set<string>()
        if (globalConfig.disabled) {
            for (const id of globalConfig.disabled) disabledSet.add(id)
        }
        if (projectConfig?.disabled) {
            for (const id of projectConfig.disabled) disabledSet.add(id)
        }

        const enabledPluginIds = discoveredPackages
            .map((p) => p.manifest.id)
            .filter((id) => !disabledSet.has(id))

        const catalog = new PluginCatalog({
            cpaVersion: this.cpaVersion,
            packages: discoveredPackages,
            enabledPluginIds,
        })

        const graph = catalog.resolveGraph()
        const inActivationOrder = new Set(graph.activationOrder.map((p) => p.manifest.id))

        const summaries: PluginSummary[] = []
        for (const pkg of discoveredPackages) {
            const summary = catalog.getPluginSummary(pkg.manifest.id)
            if (summary) {
                let status = summary.status
                let mainSummary: PluginSummary | undefined
                try {
                    mainSummary = this.coordinator.host.runtime.getPluginSummary(pkg.manifest.id)
                } catch {
                    // Plugin may not be registered in Main runtime
                }

                if (mainSummary?.status === 'error') {
                    status = 'error'
                } else if (inActivationOrder.has(pkg.manifest.id)) {
                    status = 'active'
                } else if (status === 'resolved') {
                    status = 'inactive'
                }

                summaries.push({
                    ...summary,
                    status,
                    error: mainSummary?.error || summary.error,
                })
            }
        }

        return {
            plugins: Object.freeze(summaries),
            activeRevision: this.getActiveRevision(),
            generation: this.getGeneration(),
        }
    }

    private validateExpectedRevision(expectedRevision?: string): void {
        if (expectedRevision && expectedRevision.trim().length > 0) {
            const activeRev = this.getActiveRevision()
            if (activeRev && expectedRevision !== activeRev) {
                throw new PluginConflictError(
                    `Plugin graph revision conflict: active revision '${activeRev}' does not match expected '${expectedRevision}'`,
                )
            }
        }
    }

    private checkAndCleanExpiredTransaction(): void {
        if (this.pendingTransaction) {
            if (Date.now() - this.pendingTransaction.createdAt > TRANSACTION_TIMEOUT_MS) {
                const expiredTx = this.pendingTransaction
                this.pendingTransaction = null
                this.coordinator
                    .rollbackPrepared(expiredTx.candidateRevision, expiredTx.generation)
                    .catch(() => {})
                if (expiredTx.journal) {
                    rollbackDurableConfig(expiredTx.journal, this.homeDir).catch(() => {})
                }
            }
        }
    }

    /**
     * Internal candidate preparation pipeline.
     */
    private async prepareCandidate(
        type: 'enable' | 'disable' | 'reload' | 'install' | 'uninstall',
        targetIdOrSpec: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        this.checkAndCleanExpiredTransaction()
        this.validateExpectedRevision(options.expectedRevision)

        const { globalConfig: curGlobal, projectConfig: curProj } =
            await this.ensureActiveConfigs()

        // Clone configs for candidate transaction
        const candidateGlobal: PluginSourceConfig = {
            version: curGlobal.version ?? 1,
            sources: [...curGlobal.sources],
            disabled: curGlobal.disabled ? [...curGlobal.disabled] : [],
        }

        const candidateProject: PluginSourceConfig | undefined = curProj
            ? {
                  version: curProj.version ?? 1,
                  sources: [...curProj.sources],
                  disabled: curProj.disabled ? [...curProj.disabled] : [],
              }
            : undefined

        const scope = options.scope ?? (this.projectPath && candidateProject ? 'project' : 'global')

        if (type === 'enable') {
            const pluginId = targetIdOrSpec
            // Remove from disabled lists
            candidateGlobal.disabled = (candidateGlobal.disabled ?? []).filter((id) => id !== pluginId)
            if (candidateProject) {
                candidateProject.disabled = (candidateProject.disabled ?? []).filter(
                    (id) => id !== pluginId,
                )
            }
            // If in sources with enabled: false, set to true
            for (const s of candidateGlobal.sources) {
                if (typeof s.source === 'string' && s.source.includes(pluginId)) {
                    s.enabled = true
                }
            }
            if (candidateProject) {
                for (const s of candidateProject.sources) {
                    if (typeof s.source === 'string' && s.source.includes(pluginId)) {
                        s.enabled = true
                    }
                }
            }
        } else if (type === 'disable') {
            const pluginId = targetIdOrSpec
            if (scope === 'project' && candidateProject) {
                if (!candidateProject.disabled?.includes(pluginId)) {
                    candidateProject.disabled = [...(candidateProject.disabled ?? []), pluginId]
                }
            } else {
                if (!candidateGlobal.disabled?.includes(pluginId)) {
                    candidateGlobal.disabled = [...(candidateGlobal.disabled ?? []), pluginId]
                }
            }
        } else if (type === 'install') {
            const spec = targetIdOrSpec
            // Install managed package
            const installed = await this.npmInstaller.install(spec, { strictExact: true })
            const canonicalSpec: PluginSourceSpec = spec.startsWith('npm:')
                ? (spec as PluginSourceSpec)
                : `npm:${installed.name}@${installed.version}`

            const entry: PluginSourceConfigEntry = {
                source: canonicalSpec,
                enabled: true,
            }

            // Ensure newly installed plugin is not in disabled list
            try {
                const manifestPath = path.join(installed.packageRoot, 'manifest.json')
                const manifestContent = await fs.readFile(manifestPath, 'utf-8')
                const parsedManifest = JSON.parse(manifestContent)
                const pluginId = parsedManifest.id ?? installed.name
                candidateGlobal.disabled = (candidateGlobal.disabled ?? []).filter(
                    (id) => id !== pluginId && id !== installed.name,
                )
                if (candidateProject) {
                    candidateProject.disabled = (candidateProject.disabled ?? []).filter(
                        (id) => id !== pluginId && id !== installed.name,
                    )
                }
            } catch {
                // Best effort manifest inspection
            }

            if (scope === 'project' && candidateProject) {
                const existingIdx = candidateProject.sources.findIndex(
                    (s) => s.source === canonicalSpec || s.source === spec,
                )
                if (existingIdx !== -1) {
                    candidateProject.sources[existingIdx] = entry
                } else {
                    candidateProject.sources.push(entry)
                }
            } else {
                const existingIdx = candidateGlobal.sources.findIndex(
                    (s) => s.source === canonicalSpec || s.source === spec,
                )
                if (existingIdx !== -1) {
                    candidateGlobal.sources[existingIdx] = entry
                } else {
                    candidateGlobal.sources.push(entry)
                }
            }
        } else if (type === 'uninstall') {
            const pluginId = targetIdOrSpec
            // Remove from disabled lists
            candidateGlobal.disabled = (candidateGlobal.disabled ?? []).filter((id) => id !== pluginId)
            if (candidateProject) {
                candidateProject.disabled = (candidateProject.disabled ?? []).filter(
                    (id) => id !== pluginId,
                )
            }

            // Remove from configured sources
            candidateGlobal.sources = candidateGlobal.sources.filter((s) => {
                return !(typeof s.source === 'string' && (s.source === pluginId || s.source.includes(pluginId)))
            })
            if (candidateProject) {
                candidateProject.sources = candidateProject.sources.filter((s) => {
                    return !(typeof s.source === 'string' && (s.source === pluginId || s.source.includes(pluginId)))
                })
            }
        }

        // Discover candidate packages across tiers
        const bundledPackages =
            this.bundledPackages ?? (await discoverBundledPluginPackages(this.bundledDir))

        const candidatePackages = await createPluginCatalog({
            projectPath: this.projectPath,
            homeDir: this.homeDir,
            bundledPackages,
            globalConfig: candidateGlobal,
            projectConfig: candidateProject,
            npmInstaller: this.npmInstaller,
        })

        const candidateDisabledSet = new Set<string>()
        if (candidateGlobal.disabled) {
            for (const id of candidateGlobal.disabled) candidateDisabledSet.add(id)
        }
        if (candidateProject?.disabled) {
            for (const id of candidateProject.disabled) candidateDisabledSet.add(id)
        }

        const candidateEnabledIds = candidatePackages
            .map((p) => p.manifest.id)
            .filter((id) => !candidateDisabledSet.has(id))

        const candidateCatalog = new PluginCatalog({
            cpaVersion: this.cpaVersion,
            packages: candidatePackages,
            enabledPluginIds: candidateEnabledIds,
        })

        const candidateRawGraph = candidateCatalog.resolveGraph()

        // Criticality check
        for (const blocked of candidateRawGraph.blocked) {
            const pkg = candidateCatalog.getPackage(blocked.pluginId)
            const criticality: PluginCriticality = pkg
                ? resolvePackageCriticality(pkg)
                : 'optional'
            if (criticality === 'platform' || criticality === 'required') {
                const reasonDetail = blocked.dependencyId ? ` (${blocked.dependencyId})` : ''
                throw new PluginDependencyError(
                    `Critical plugin '${blocked.pluginId}' (${criticality}) failed to resolve: ${blocked.reason}${reasonDetail}`,
                    { pluginId: blocked.pluginId },
                )
            }
        }

        const candidateRevision = computePluginGraphRevision(
            candidateRawGraph.activationOrder,
            candidateRawGraph.activationOrder.map((p) => p.manifest.id),
        )

        const candidateGraphDTO = createResolvedPluginGraphDTO(candidateRawGraph)
        const nextGeneration = (this.coordinator.getGeneration() || 0) + 1
        const transactionId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

        // Stage candidate packages in resource service so renderer/agent can load modules during staging
        for (const pkg of candidatePackages) {
            this.resourceService.registerPackage(pkg)
        }

        // Stage candidate generation in coordinator
        this.coordinator.setGraphDTO(candidateGraphDTO)
        await this.coordinator.prepareGeneration(candidateCatalog, {
            generation: nextGeneration,
            revision: candidateRevision,
        })

        const preparedState = this.coordinator.getPreparedState(context)

        this.pendingTransaction = {
            transactionId,
            candidateRevision,
            generation: nextGeneration,
            graphDTO: candidateGraphDTO,
            rawGraph: candidateRawGraph,
            catalog: candidateCatalog,
            globalConfig: candidateGlobal,
            projectConfig: candidateProject,
            grantTickets: preparedState?.grantTickets ?? null,
            type,
            targetId: targetIdOrSpec,
            scope,
            createdAt: Date.now(),
            journal: null,
            runtimeCommitted: false,
        }

        return {
            candidateRevision,
            generation: nextGeneration,
            graph: candidateGraphDTO,
            grantTickets: preparedState?.grantTickets ?? null,
        }
    }

    /**
     * Prepare enabling a plugin.
     */
    async prepareEnable(
        pluginId: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        return this.prepareCandidate('enable', pluginId, options, context)
    }

    /**
     * Prepare disabling a plugin.
     */
    async prepareDisable(
        pluginId: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        return this.prepareCandidate('disable', pluginId, options, context)
    }

    /**
     * Prepare reloading a plugin.
     */
    async prepareReload(
        pluginId: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        return this.prepareCandidate('reload', pluginId, options, context)
    }

    /**
     * Prepare installing a managed npm plugin.
     */
    async prepareInstall(
        spec: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        return this.prepareCandidate('install', spec, options, context)
    }

    /**
     * Prepare uninstalling a plugin.
     */
    async prepareUninstall(
        pluginId: string,
        options: PrepareActionOptions = {},
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): Promise<PreparedCandidateResult> {
        return this.prepareCandidate('uninstall', pluginId, options, context)
    }

    /**
     * Durably prepare candidate configuration on disk before committing any runtimes.
     * Writes temporary files, fsyncs file handles, and creates an atomic transaction journal.
     * If disk prepare fails, transaction is aborted and runtime is never touched.
     */
    async prepareDurableConfig(candidateRevision?: string): Promise<PluginGraphJournal> {
        if (!this.pendingTransaction) {
            throw new PluginError(
                `No pending candidate transaction to prepare disk config for revision '${candidateRevision ?? 'unknown'}'`,
            )
        }

        if (
            candidateRevision &&
            this.pendingTransaction.candidateRevision !== candidateRevision
        ) {
            throw new PluginConflictError(
                `Candidate revision mismatch: pending '${this.pendingTransaction.candidateRevision}', prepare requested '${candidateRevision}'`,
            )
        }

        if (this.pendingTransaction.journal) {
            return this.pendingTransaction.journal
        }

        const tx = this.pendingTransaction
        try {
            const journal = await prepareDurableConfig({
                homeDir: this.homeDir,
                projectPath: this.projectPath,
                globalConfig: tx.globalConfig,
                projectConfig: tx.projectConfig,
                candidateRevision: tx.candidateRevision,
                generation: tx.generation,
                transactionId: tx.transactionId,
            })
            tx.journal = journal
            return journal
        } catch (err) {
            await this.rollbackTransaction(tx.candidateRevision)
            throw err
        }
    }

    /**
     * Commit the staged Main runtime after durable config preparation.
     */
    async commitRuntime(candidateRevision: string, generation?: number): Promise<void> {
        if (!this.pendingTransaction) {
            throw new PluginError(
                `No pending candidate transaction to commit runtime for revision '${candidateRevision}'`,
            )
        }

        if (this.pendingTransaction.candidateRevision !== candidateRevision) {
            throw new PluginConflictError(
                `Candidate revision mismatch: pending '${this.pendingTransaction.candidateRevision}', commit requested '${candidateRevision}'`,
            )
        }

        const tx = this.pendingTransaction

        if (tx.runtimeCommitted) {
            // Already committed runtime (avoid double-committing Main)
            return
        }

        // Ensure durable disk prepare has completed first
        if (!tx.journal) {
            await this.prepareDurableConfig(candidateRevision)
        }

        try {
            await this.coordinator.commitPrepared(tx.candidateRevision, tx.generation)
            tx.runtimeCommitted = true
        } catch (err) {
            // Runtime commit failed: rollback staged state and restore previous configs
            await this.rollbackTransaction(candidateRevision)
            throw err
        }
    }

    /**
     * Finalize the transaction after all runtimes have committed:
     * marks journal 'committed', renames temp config files to target paths, and registers new resources.
     */
    async finalizeTransaction(candidateRevision: string): Promise<void> {
        if (!this.pendingTransaction) {
            return
        }

        if (this.pendingTransaction.candidateRevision !== candidateRevision) {
            throw new PluginConflictError(
                `Candidate revision mismatch: pending '${this.pendingTransaction.candidateRevision}', finalize requested '${candidateRevision}'`,
            )
        }

        const tx = this.pendingTransaction

        if (!tx.runtimeCommitted) {
            await this.commitRuntime(candidateRevision)
        }

        if (tx.journal) {
            try {
                await finalizeDurableConfig(tx.journal, this.homeDir)
            } catch (err) {
                // Config finalization failed: attempt recovery immediately
                try {
                    await recoverFromJournal(this.homeDir, this.projectPath)
                } catch {
                    // Fatal recovery failure
                }
                throw err
            }
        }

        // Register active packages in resource service
        this.resourceService.setPackages(tx.rawGraph.activationOrder, tx.candidateRevision)

        // Update active configs and clear pending transaction
        this.activeGlobalConfig = tx.globalConfig
        this.activeProjectConfig = tx.projectConfig
        this.pendingTransaction = null

        this.emitChange()
    }

    /**
     * Commit the pending candidate transaction atomically across runtime and disk persistence.
     * Order:
     * 1. Durably prepare config (temp files + fsync + journal prepared)
     * 2. Commit runtime coordinator
     * 3. Finalize transaction (journal committed + atomic rename + remove journal)
     */
    async commitTransaction(candidateRevision: string): Promise<void> {
        await this.prepareDurableConfig(candidateRevision)
        await this.commitRuntime(candidateRevision)
        await this.finalizeTransaction(candidateRevision)
    }

    /**
     * Roll back the pending candidate transaction and clean up staged resources and journal.
     */
    async rollbackTransaction(candidateRevision?: string): Promise<void> {
        if (!this.pendingTransaction) {
            return
        }

        if (
            candidateRevision &&
            this.pendingTransaction.candidateRevision !== candidateRevision
        ) {
            return
        }

        const tx = this.pendingTransaction
        this.pendingTransaction = null

        try {
            await this.coordinator.rollbackPrepared(tx.candidateRevision, tx.generation)
        } catch {
            // Ignore coordinator rollback error
        }

        if (tx.journal) {
            try {
                await rollbackDurableConfig(tx.journal, this.homeDir)
            } catch {
                // Ignore config rollback error
            }
        }

        // Restore active packages in resource service
        try {
            const activePackages = this.coordinator.host?.catalog?.getPackages() ?? []
            this.resourceService.setPackages(activePackages)
        } catch {
            // Ignore resource restore error on rollback
        }
    }
}
