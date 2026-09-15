import type {
    CapabilityInvocationContext,
    PluginManifest,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
    RpcInvocationContext,
} from '@cpa/plugin-api'
import {
    PluginRuntimeCoordinator,
    type PreparedPluginGeneration,
    type PluginCatalog,
} from '@cpa/plugin-kernel'
import type { MainPluginRuntimeHost } from './MainPluginRuntimeHost.js'

export interface MainPluginActivationCoordinatorOptions {
    host: MainPluginRuntimeHost
    graph?: ResolvedPluginGraphDTO
}

export interface PreparedPluginStateDTO {
    phase: 'prepared' | 'active'
    revision: string
    generation: number
    graph?: ResolvedPluginGraphDTO | null
    grantTickets?: Record<string, { renderer?: string; agent?: string }> | null
}

/**
 * Derives a stable document/frame identity key from invocation context.
 */
export function getContextDocumentKey(
    context: CapabilityInvocationContext | RpcInvocationContext,
): string {
    if (context.documentId && typeof context.documentId === 'string' && context.documentId.trim()) {
        return context.documentId.trim()
    }
    const clientId = (context as RpcInvocationContext).clientId
    if (context.transport === 'web' && typeof clientId === 'string' && clientId.trim()) {
        return `web:${clientId.trim()}`
    }
    const senderId = context.senderId ?? 0
    if (context.processId !== undefined && context.routingId !== undefined) {
        return `${senderId}:${context.processId}:${context.routingId}`
    }
    if (context.routingId !== undefined) {
        return `${senderId}:${context.routingId}`
    }
    if (context.frameUrl) {
        return `${senderId}:${context.frameUrl}`
    }
    return `${senderId}`
}

/**
 * Coordinates main process plugin staging and atomic commits during application startup.
 */
export class MainPluginActivationCoordinator {
    readonly host: MainPluginRuntimeHost
    readonly coordinator: PluginRuntimeCoordinator
    private graphDTO?: ResolvedPluginGraphDTO
    private pendingGeneration: PreparedPluginGeneration | null = null
    // generation -> Set of document keys that have already been issued grant tickets
    private readonly issuedDocumentsByGen = new Map<number, Set<string>>()
    private readonly commitListeners = new Set<() => void>()
    private lastStageError: Error | null = null
    private ensurePreparedInFlight: Promise<void> | null = null

    constructor(options: MainPluginActivationCoordinatorOptions) {
        this.host = options.host
        this.graphDTO = options.graph
        this.coordinator = new PluginRuntimeCoordinator({
            runtimes: {
                main: this.host.runtime,
            },
        })
    }

    /**
     * Get the current resolved plugin graph DTO if set.
     */
    getGraphDTO(): ResolvedPluginGraphDTO | undefined {
        return this.graphDTO
    }

    /**
     * Set or update the authoritative resolved plugin graph DTO.
     */
    setGraphDTO(graph: ResolvedPluginGraphDTO): void {
        this.graphDTO = graph
    }

    /**
     * Get current generation number of the main runtime.
     */
    getGeneration(): number {
        return this.coordinator.getGeneration()
    }

    /**
     * Get current active graph revision.
     */
    getRevision(): string {
        return this.coordinator.getRevision() || (this.graphDTO?.revision ?? '')
    }

    /**
     * Get currently pending prepared generation if any.
     */
    getPendingGeneration(): PreparedPluginGeneration | null {
        return this.pendingGeneration
    }

    /**
     * Get summary state of the currently pending prepared or committed active generation.
     * Issues grant tickets once per document per generation bound to trusted context.
     */
    getPreparedState(
        context?: RpcInvocationContext | CapabilityInvocationContext,
    ): PreparedPluginStateDTO | null {
        let phase: 'prepared' | 'active'
        let revision: string
        let generation: number
        let graphInput: ResolvedPluginGraphDTO | readonly ResolvedPluginPackage[] | PluginCatalog | undefined

        if (this.pendingGeneration) {
            phase = 'prepared'
            revision = this.pendingGeneration.revision
            generation = this.pendingGeneration.generation
            graphInput = this.graphDTO ?? this.host.catalog
        } else {
            const currentGen = this.getGeneration()
            if (currentGen <= 0) {
                return null
            }
            phase = 'active'
            revision = this.getRevision()
            generation = currentGen
            graphInput = this.graphDTO ?? this.host.catalog
        }

        const graph = this.graphDTO ?? null

        if (!context) {
            return {
                phase,
                revision,
                generation,
                graph,
                grantTickets: null,
            }
        }

        const docKey = getContextDocumentKey(context)
        let docSet = this.issuedDocumentsByGen.get(generation)
        if (!docSet) {
            docSet = new Set<string>()
            this.issuedDocumentsByGen.set(generation, docSet)
        }

        if (docSet.has(docKey)) {
            return {
                phase,
                revision,
                generation,
                graph,
                grantTickets: null,
            }
        }

        docSet.add(docKey)

        const manifests = this.extractManifests(graphInput)
        const grantTickets: Record<string, { renderer?: string; agent?: string }> = {}

        for (const manifest of manifests) {
            const tickets: { renderer?: string; agent?: string } = {}
            const rpcContext = context as RpcInvocationContext
            const ticketBase = {
                pluginId: manifest.id,
                generation,
                capabilities: manifest.capabilities ?? [],
                senderId: context.senderId,
                frameUrl: context.frameUrl,
                processId: context.processId,
                routingId: context.routingId,
                documentId: context.documentId ?? docKey,
                transport: context.transport ?? 'electron',
                clientId: rpcContext.clientId,
            } as const
            if (manifest.entries?.renderer) {
                tickets.renderer = this.host.capabilityBroker.createGrantTicket({
                    ...ticketBase,
                    runtime: 'renderer',
                })
            }
            if (manifest.entries?.agent) {
                tickets.agent = this.host.capabilityBroker.createGrantTicket({
                    ...ticketBase,
                    runtime: 'agent',
                })
            }
            if (tickets.renderer || tickets.agent) {
                grantTickets[manifest.id] = tickets
            }
        }

        return {
            phase,
            revision,
            generation,
            graph,
            grantTickets: Object.keys(grantTickets).length > 0 ? grantTickets : null,
        }
    }

    /**
     * Clear document issuance record for a generation or across all generations.
     */
    clearGenerationIssuance(generation: number): void {
        this.issuedDocumentsByGen.delete(generation)
    }

    /**
     * Clear document issuance for a specific document key across all generations.
     */
    clearDocumentIssuance(documentKey: string): void {
        for (const docSet of this.issuedDocumentsByGen.values()) {
            docSet.delete(documentKey)
        }
    }

    /**
     * Clear document issuance for a sender ID across all generations.
     */
    clearSenderIssuance(senderId: number): void {
        const prefix = `${senderId}:`
        const exact = `${senderId}`
        for (const docSet of this.issuedDocumentsByGen.values()) {
            for (const key of Array.from(docSet)) {
                if (key === exact || key.startsWith(prefix)) {
                    docSet.delete(key)
                }
            }
        }
    }

    /**
     * Stage all main plugin entries for the graph without committing, holding a pending generation lease.
     */
    async stage(
        graphInput?:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: { generation?: number; revision?: string },
    ): Promise<PreparedPluginGeneration> {
        if (this.pendingGeneration) {
            try {
                this.clearGenerationIssuance(this.pendingGeneration.generation)
                await this.pendingGeneration.rollback()
                this.host.capabilityBroker.revokeTicketsForGeneration(this.pendingGeneration.generation)
            } catch (err) {
                console.warn('Warning: Error rolling back previous pending generation during new stage:', err)
            } finally {
                this.pendingGeneration = null
            }
        }

        const input = graphInput ?? this.graphDTO ?? this.host.catalog
        if (input && typeof input === 'object' && 'revision' in input && typeof (input as any).revision === 'string') {
            this.graphDTO = input as ResolvedPluginGraphDTO
        }

        try {
            const prepared = await this.coordinator.prepareGeneration(input, options)
            this.pendingGeneration = prepared
            this.lastStageError = null
            return prepared
        } catch (err) {
            this.lastStageError = err instanceof Error ? err : new Error(String(err))
            throw this.lastStageError
        }
    }

    /**
     * Ensure a prepared generation exists for the initial handshake.
     * Retries staging when startup stage() was skipped or failed and nothing is active yet.
     */
    async ensurePrepared(): Promise<void> {
        if (this.pendingGeneration || this.getGeneration() > 0) {
            return
        }
        if (this.ensurePreparedInFlight) {
            await this.ensurePreparedInFlight
            return
        }
        this.ensurePreparedInFlight = this.stage().then(() => undefined)
        try {
            await this.ensurePreparedInFlight
        } finally {
            this.ensurePreparedInFlight = null
        }
    }

    /**
     * Stage all main plugin entries for the graph without committing (coordinator delegate).
     */
    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: { generation?: number; revision?: string },
    ): Promise<PreparedPluginGeneration> {
        return this.stage(graphInput, options)
    }

    /**
     * Atomically commit the currently pending prepared generation after verifying matching revision and generation.
     * Idempotently succeeds if already active with matching revision and generation.
     */
    async commitPrepared(revision: string, generation: number): Promise<void> {
        if (!this.pendingGeneration) {
            const currentGen = this.getGeneration()
            const currentRev = this.getRevision()
            if (
                currentGen > 0 &&
                currentGen === generation &&
                (!revision || currentRev === revision)
            ) {
                return
            }
            if (this.lastStageError) {
                throw new Error(
                    `No pending prepared plugin generation to commit (active: ${currentRev}@${currentGen}, requested: ${revision}@${generation}): ${this.lastStageError.message}`,
                    { cause: this.lastStageError },
                )
            }
            throw new Error(
                `No pending prepared plugin generation to commit (active: ${currentRev}@${currentGen}, requested: ${revision}@${generation})`,
            )
        }

        if (
            this.pendingGeneration.revision !== revision ||
            this.pendingGeneration.generation !== generation
        ) {
            throw new Error(
                `Mismatched generation/revision for commit: expected ${this.pendingGeneration.revision}@${this.pendingGeneration.generation}, got ${revision}@${generation}`,
            )
        }

        const prevGeneration = this.coordinator.getGeneration()
        const prepared = this.pendingGeneration
        this.pendingGeneration = null

        await prepared.commit()

        // Revoke previous generation handles, subscriptions, and issuance across all plugins
        if (prevGeneration > 0 && prevGeneration !== generation) {
            this.clearGenerationIssuance(prevGeneration)
            this.host.capabilityBroker.revokeGenerationAll(prevGeneration)
        }

        // Notify commit listeners
        for (const listener of Array.from(this.commitListeners)) {
            try {
                listener()
            } catch (err) {
                console.error('Error in coordinator commit listener:', err)
            }
        }
    }

    /**
     * Register a listener to be notified when a plugin generation commits.
     * Returns an unbind function.
     */
    onCommit(listener: () => void): () => void {
        this.commitListeners.add(listener)
        return () => {
            this.commitListeners.delete(listener)
        }
    }

    /**
     * Returns a promise that resolves when the current pending generation is committed
     * or resolves immediately if an active generation is already committed.
     */
    async whenCommitted(): Promise<void> {
        if (this.getGeneration() > 0 && !this.pendingGeneration) {
            return
        }
        return new Promise<void>((resolve) => {
            const unbind = this.onCommit(() => {
                unbind()
                resolve()
            })
        })
    }

    /**
     * Roll back the currently pending prepared generation after verifying matching revision and generation if provided.
     */
    async rollbackPrepared(revision?: string, generation?: number): Promise<void> {
        if (!this.pendingGeneration) {
            return
        }

        if (
            revision !== undefined &&
            generation !== undefined &&
            (this.pendingGeneration.revision !== revision ||
                this.pendingGeneration.generation !== generation)
        ) {
            throw new Error(
                `Mismatched generation/revision for rollback: expected ${this.pendingGeneration.revision}@${this.pendingGeneration.generation}, got ${revision}@${generation}`,
            )
        }

        const gen = this.pendingGeneration.generation
        const prepared = this.pendingGeneration
        this.pendingGeneration = null

        await prepared.rollback()
        this.clearGenerationIssuance(gen)
        this.host.capabilityBroker.revokeGenerationAll(gen)
    }

    /**
     * Stage and atomically commit main plugin generation.
     */
    async activate(
        graphInput?:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: { generation?: number },
    ): Promise<PreparedPluginGeneration> {
        const prepared = await this.stage(graphInput, options)
        await this.commitPrepared(prepared.revision, prepared.generation)
        return prepared
    }

    /**
     * Dispose all active plugins, rolling back any pending generation.
     */
    async dispose(): Promise<void> {
        this.issuedDocumentsByGen.clear()
        this.commitListeners.clear()
        if (this.pendingGeneration) {
            try {
                await this.pendingGeneration.rollback()
                this.host.capabilityBroker.revokeGenerationAll(this.pendingGeneration.generation)
            } catch (err) {
                console.error('Error rolling back pending generation during coordinator dispose:', err)
            } finally {
                this.pendingGeneration = null
            }
        }
        await this.host.dispose()
    }

    /**
     * Helper to extract manifests from various graph input shapes.
     */
    private extractManifests(
        input:
            | ResolvedPluginGraphDTO
            | readonly ResolvedPluginPackage[]
            | PluginCatalog
            | undefined,
    ): readonly PluginManifest[] {
        if (!input) {
            return typeof this.host.catalog?.getPackages === 'function'
                ? this.host.catalog.getPackages().map((p) => p.manifest)
                : []
        }
        if (Array.isArray(input)) {
            return input.map((item) => (item.manifest ? item.manifest : item))
        }
        if (typeof (input as any).getPackages === 'function') {
            return (input as PluginCatalog).getPackages().map((p) => p.manifest)
        }
        if (typeof input === 'object' && 'plugins' in input && Array.isArray((input as any).plugins)) {
            return (input as ResolvedPluginGraphDTO).plugins.map((p) => p.manifest)
        }
        return []
    }
}
