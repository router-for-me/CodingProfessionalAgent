import type {
    CapabilityHandle,
    CapabilityInvokeResponse,
    PluginSummary,
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import {
    PluginCatalog,
    PluginRuntimeCoordinator,
    type PreparedPluginGeneration,
    type ResolvedPluginGraph,
} from '@cpa/plugin-kernel'
import {
    RendererPluginRuntimeHost,
    rendererPluginRuntime,
} from './RendererPluginRuntimeHost'
import {
    AgentPluginRuntimeHost,
    agentPluginRuntime,
} from './AgentPluginRuntimeHost'
import { getHostTransport } from '../../application/services/hostTransport'

export interface MainGenerationPreparedState {
    phase?: 'prepared' | 'active'
    revision: string
    generation: number
    graph?: ResolvedPluginGraphDTO | null
    grantTickets?: Record<string, { renderer?: string; agent?: string }> | null
}

export interface MainGenerationParticipant {
    getPreparedState(): Promise<MainGenerationPreparedState | null>
    commit(revision: string, generation: number): Promise<void>
    rollback(revision?: string, generation?: number): Promise<void>
}

export interface PluginPlatformCoordinatorOptions {
    rendererHost?: RendererPluginRuntimeHost
    agentHost?: AgentPluginRuntimeHost
    coordinator?: PluginRuntimeCoordinator
    mainParticipant?: MainGenerationParticipant
    grantTicketTransport?: (ticket: string) => Promise<CapabilityInvokeResponse<string> | any>
}

export interface PreparePlatformGenerationOptions {
    generation?: number
    mainParticipant?: MainGenerationParticipant
}

/**
 * Universal Plugin Platform Coordinator managing cross-runtime staging,
 * unified generation advancement, and atomic commits across Main, Renderer, and Agent runtimes.
 */
export class PluginPlatformCoordinator {
    readonly rendererHost: RendererPluginRuntimeHost
    readonly agentHost: AgentPluginRuntimeHost
    readonly coordinator: PluginRuntimeCoordinator
    private mainParticipant?: MainGenerationParticipant
    private readonly grantTicketTransport?: (ticket: string) => Promise<CapabilityInvokeResponse<string> | any>

    private isCommitted = false
    private activeRevision = ''

    constructor(options: PluginPlatformCoordinatorOptions = {}) {
        this.rendererHost = options.rendererHost ?? rendererPluginRuntime
        this.agentHost = options.agentHost ?? agentPluginRuntime
        this.mainParticipant = options.mainParticipant
        this.grantTicketTransport = options.grantTicketTransport

        if (typeof (this.rendererHost as any).setPeerHost === 'function') {
            (this.rendererHost as any).setPeerHost(this.agentHost)
        }

        this.coordinator =
            options.coordinator ??
            new PluginRuntimeCoordinator({
                runtimes: {
                    renderer: this.rendererHost.runtime,
                    agent: this.agentHost.runtime,
                },
            })
    }

    /**
     * Get current shared generation number.
     */
    getGeneration(): number {
        return this.coordinator.getGeneration()
    }

    /**
     * Get current active graph revision.
     */
    getRevision(): string {
        return this.activeRevision || this.coordinator.getRevision()
    }

    /**
     * Set or update the Main generation participant.
     */
    setMainParticipant(participant: MainGenerationParticipant | undefined): void {
        this.mainParticipant = participant
    }

    /**
     * Get the active Main generation participant if configured.
     */
    getMainParticipant(): MainGenerationParticipant | undefined {
        return this.mainParticipant
    }

    /**
     * Check if the unified platform generation has committed.
     */
    isReady(): boolean {
        return this.isCommitted && this.getGeneration() > 0
    }

    /**
     * Prepare a plugin generation across Renderer and Agent runtimes, coordinated with Main process participant.
     * Staged contributions are isolated and not visible in active registries until commit().
     */
    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: PreparePlatformGenerationOptions,
    ): Promise<PreparedPluginGeneration> {
        const participant = options?.mainParticipant ?? this.mainParticipant
        let mainState: MainGenerationPreparedState | null = null

        if (participant) {
            mainState = await participant.getPreparedState()
        }

        const targetGeneration =
            options?.generation ??
            mainState?.generation ??
            this.coordinator.getGeneration() + 1

        const targetRevision = mainState?.revision ?? (this.coordinator.getRevision() || undefined)
        const resolvedGraphInput = graphInput ?? mainState?.graph ?? undefined

        if (this.isReady()) {
            const currentGen = this.getGeneration()
            const currentRev = this.getRevision()
            const isSameGen = currentGen === targetGeneration
            const isSameRev = !targetRevision || currentRev === targetRevision
            if (isSameGen && isSameRev) {
                return {
                    revision: currentRev,
                    generation: currentGen,
                    commit: async () => {},
                    rollback: async () => {},
                }
            }
        }

        // Redeem grant tickets issued by Main in prepared state before activating plugin entries
        if (mainState?.grantTickets) {
            const redeemTicket = async (ticket: string): Promise<CapabilityHandle | null> => {
                try {
                    if (this.grantTicketTransport) {
                        const res = await this.grantTicketTransport(ticket)
                        if (res && typeof res === 'object' && 'ok' in res) {
                            if (res.ok === true && 'value' in res) return res.value as CapabilityHandle
                            return null
                        }
                        if (typeof res === 'string') return res as CapabilityHandle
                    } else {
                        const hostTrans = getHostTransport()
                        if (hostTrans?.grantTicket) {
                            const res = await hostTrans.grantTicket(ticket)
                            if (res && typeof res === 'object' && 'ok' in res && (res as any).ok === true && 'value' in res) {
                                return (res as any).value as CapabilityHandle
                            }
                        }
                    }
                } catch (err) {
                    console.warn(`[PluginPlatformCoordinator] Failed to redeem grant ticket "${ticket}":`, err)
                }
                return null
            }

            for (const [pluginId, tickets] of Object.entries(mainState.grantTickets)) {
                if (tickets?.renderer) {
                    const handle = await redeemTicket(tickets.renderer)
                    if (handle) {
                        this.rendererHost.setPluginHandle(pluginId, handle, targetGeneration)
                    }
                }
                if (tickets?.agent) {
                    const handle = await redeemTicket(tickets.agent)
                    if (handle) {
                        this.agentHost.setPluginHandle(pluginId, handle, targetGeneration)
                    }
                }
            }
        }

        const isMainPending = Boolean(
            participant && (!mainState || mainState.phase !== 'active'),
        )

        let localPrepared: PreparedPluginGeneration
        try {
            localPrepared = await this.coordinator.prepareGeneration(resolvedGraphInput, {
                generation: targetGeneration,
            })
        } catch (prepareError) {
            this.rendererHost.clearHandles(targetGeneration)
            this.agentHost.clearHandles(targetGeneration)

            if (isMainPending && participant) {
                try {
                    await participant.rollback(targetRevision, targetGeneration)
                } catch (rollbackErr) {
                    console.error('Error rolling back main participant on local prepare failure:', rollbackErr)
                }
            }
            throw prepareError
        }

        let finalized = false
        const finalRevision = targetRevision || localPrepared.revision

        return {
            revision: finalRevision,
            generation: targetGeneration,
            commit: async () => {
                if (finalized) return
                finalized = true

                if (isMainPending && participant) {
                    try {
                        await participant.commit(finalRevision, targetGeneration)
                    } catch (mainCommitError) {
                        this.rendererHost.clearHandles(targetGeneration)
                        this.agentHost.clearHandles(targetGeneration)

                        try {
                            await localPrepared.rollback()
                        } catch (localRollbackErr) {
                            console.error(
                                'Error rolling back local prepared generation after main commit failure:',
                                localRollbackErr,
                            )
                        }
                        throw mainCommitError
                    }
                }

                await localPrepared.commit()
                this.isCommitted = true
                this.activeRevision = finalRevision
                this.rendererHost.notify()
                this.agentHost.notify()
            },
            rollback: async () => {
                if (finalized) return
                finalized = true

                this.rendererHost.clearHandles(targetGeneration)
                this.agentHost.clearHandles(targetGeneration)

                try {
                    if (isMainPending && participant) {
                        await participant.rollback(finalRevision, targetGeneration)
                    }
                } finally {
                    await localPrepared.rollback()
                    this.rendererHost.notify()
                    this.agentHost.notify()
                }
            },
        }
    }

    /**
     * Atomically prepare and commit the generation across Main, Renderer, and Agent runtimes.
     */
    async activate(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: PreparePlatformGenerationOptions,
    ): Promise<PreparedPluginGeneration> {
        const prepared = await this.prepareGeneration(graphInput, options)
        await prepared.commit()
        return prepared
    }

    /**
     * Get all plugin summaries across runtimes with unified active/error/inactive statuses.
     */
    getPluginSummaries(): readonly PluginSummary[] {
        return this.rendererHost.getPluginSummaries()
    }

    /**
     * Get a single plugin summary by ID across runtimes.
     */
    getPluginSummary(pluginId: string): PluginSummary {
        return this.rendererHost.getPluginSummary(pluginId)
    }

    /**
     * Check if a plugin is currently active in its declared runtime(s).
     */
    isPluginActive(pluginId: string): boolean {
        return this.rendererHost.isPluginActive(pluginId)
    }

    /**
     * Notify all runtime listeners that platform state or plugin summaries may have changed.
     */
    notify(): void {
        this.rendererHost.notify()
        this.agentHost.notify()
    }

    /**
     * Subscribe to plugin platform lifecycle and activation changes across runtimes.
     */
    subscribe(listener: () => void): () => void {
        const unsubRenderer = this.rendererHost.subscribe(listener)
        const unsubAgent = typeof this.agentHost.subscribe === 'function'
            ? this.agentHost.subscribe(listener)
            : () => {}
        return () => {
            unsubRenderer()
            unsubAgent()
        }
    }
}

export const pluginPlatformCoordinator = new PluginPlatformCoordinator({
    rendererHost: rendererPluginRuntime,
    agentHost: agentPluginRuntime,
})
