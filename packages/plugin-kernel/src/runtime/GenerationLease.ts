export interface PluginGenerationLease {
    readonly generation: number
    readonly pluginIds: readonly string[]
    readonly released?: boolean
    release(): void
}

/**
 * Manages generation leases across active plugins to ensure safe, deterministic
 * execution boundaries during runtime updates and deactivations.
 */
export class GenerationLeaseManager {
    private readonly leaseCounts = new Map<string, number>()
    private readonly releaseWaiters = new Map<string, Set<() => void>>()
    private readonly activeLeases = new Set<PluginGenerationLease>()

    /**
     * Acquire a lease on a set of plugins for the specified runtime generation.
     */
    acquire(generation: number, pluginIds: readonly string[]): PluginGenerationLease {
        const uniqueIds = Array.from(new Set(pluginIds))

        for (const id of uniqueIds) {
            const current = this.leaseCounts.get(id) ?? 0
            this.leaseCounts.set(id, current + 1)
        }

        let released = false
        const lease: PluginGenerationLease = {
            generation,
            pluginIds: Object.freeze([...uniqueIds]),
            get released() {
                return released
            },
            release: () => {
                if (released) {
                    return
                }
                released = true
                this.activeLeases.delete(lease)

                for (const id of uniqueIds) {
                    const current = this.leaseCounts.get(id) ?? 0
                    const next = current - 1
                    if (next <= 0) {
                        this.leaseCounts.delete(id)
                        const waiters = this.releaseWaiters.get(id)
                        if (waiters) {
                            this.releaseWaiters.delete(id)
                            for (const resolve of waiters) {
                                resolve()
                            }
                        }
                    } else {
                        this.leaseCounts.set(id, next)
                    }
                }
            },
        }

        this.activeLeases.add(lease)
        return lease
    }

    /**
     * Get the active lease count for a specific plugin ID.
     */
    getLeaseCount(pluginId: string): number {
        return this.leaseCounts.get(pluginId) ?? 0
    }

    /**
     * Check if a specific plugin is currently leased.
     */
    isLeased(pluginId: string): boolean {
        return this.getLeaseCount(pluginId) > 0
    }

    /**
     * Wait until all active leases on the specified plugin are released.
     */
    waitForRelease(pluginId: string): Promise<void> {
        if (this.getLeaseCount(pluginId) === 0) {
            return Promise.resolve()
        }

        return new Promise<void>((resolve) => {
            let waiters = this.releaseWaiters.get(pluginId)
            if (!waiters) {
                waiters = new Set()
                this.releaseWaiters.set(pluginId, waiters)
            }
            waiters.add(resolve)
        })
    }

    /**
     * Get all currently active leases.
     */
    getActiveLeases(): readonly PluginGenerationLease[] {
        return Object.freeze(Array.from(this.activeLeases))
    }
}
