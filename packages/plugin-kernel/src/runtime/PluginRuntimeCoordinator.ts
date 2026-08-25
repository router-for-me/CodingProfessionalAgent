import type {
    ResolvedPluginGraphDTO,
    ResolvedPluginPackage,
} from '@cpa/plugin-api'
import type { PluginCatalog } from '../catalog/PluginCatalog.js'
import type { ResolvedPluginGraph } from '../dependencies/DependencyResolver.js'
import type { PluginRuntime, PreparedRuntimeGeneration } from './PluginRuntime.js'

export interface PreparedPluginGeneration {
    readonly revision: string
    readonly generation: number
    commit(): Promise<void>
    rollback(): Promise<void>
}

export interface PluginRuntimeCoordinatorOptions {
    runtimes: Record<string, PluginRuntime> | readonly PluginRuntime[]
}

/**
 * Universal Plugin Runtime Coordinator that manages two-phase staging,
 * unified generation advancement, and atomic cross-runtime commits or rollbacks.
 */
export class PluginRuntimeCoordinator {
    readonly runtimes: ReadonlyMap<string, PluginRuntime>
    private lastRevision = ''

    constructor(
        options:
            | PluginRuntimeCoordinatorOptions
            | Record<string, PluginRuntime>
            | readonly PluginRuntime[],
    ) {
        const map = new Map<string, PluginRuntime>()

        if (Array.isArray(options)) {
            for (let i = 0; i < options.length; i++) {
                const rt = options[i]
                map.set(rt.entryKind || `runtime_${i}`, rt)
            }
        } else if ('runtimes' in options && options.runtimes) {
            const rts = options.runtimes
            if (Array.isArray(rts)) {
                for (let i = 0; i < rts.length; i++) {
                    const rt = rts[i]
                    map.set(rt.entryKind || `runtime_${i}`, rt)
                }
            } else {
                for (const [key, rt] of Object.entries(rts)) {
                    map.set(key, rt)
                }
            }
        } else {
            for (const [key, rt] of Object.entries(options as Record<string, PluginRuntime>)) {
                map.set(key, rt)
            }
        }

        this.runtimes = map
    }

    /**
     * Get the current highest generation across all registered runtimes.
     */
    getGeneration(): number {
        if (this.runtimes.size === 0) {
            return 0
        }
        return Math.max(
            0,
            ...Array.from(this.runtimes.values()).map((runtime) => runtime.getGeneration()),
        )
    }

    /**
     * Get the last prepared or committed graph revision.
     */
    getRevision(): string {
        return this.lastRevision
    }

    /**
     * Stage all plugin contributions across all runtimes without exposing them to active registries.
     * If any required or platform plugin entry fails on any runtime, all runtimes rollback immediately.
     */
    async prepareGeneration(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: { generation?: number; revision?: string },
    ): Promise<PreparedPluginGeneration> {
        const targetGeneration = options?.generation ?? this.getGeneration() + 1
        const revision = options?.revision ?? this._extractRevision(graphInput)

        const preparedRuntimes: PreparedRuntimeGeneration[] = []

        try {
            for (const [_, runtime] of this.runtimes) {
                const prepared = await runtime.prepareGeneration(graphInput, targetGeneration)
                preparedRuntimes.push(prepared)
            }
        } catch (error) {
            for (const prepared of preparedRuntimes) {
                try {
                    await prepared.rollback()
                } catch {
                    // Ignore secondary rollback errors
                }
            }
            throw error
        }

        let finalized = false

        return {
            revision,
            generation: targetGeneration,
            commit: async () => {
                if (finalized) return
                finalized = true
                for (const prepared of preparedRuntimes) {
                    await prepared.commit()
                }
                this.lastRevision = revision
            },
            rollback: async () => {
                if (finalized) return
                finalized = true
                for (const prepared of preparedRuntimes) {
                    await prepared.rollback()
                }
            },
        }
    }

    /**
     * Atomically prepare and commit the plugin generation across all runtimes.
     */
    async activate(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
        options?: { generation?: number },
    ): Promise<PreparedPluginGeneration> {
        const prepared = await this.prepareGeneration(graphInput, options)
        await prepared.commit()
        return prepared
    }

    private _extractRevision(
        graphInput?:
            | ResolvedPluginGraphDTO
            | ResolvedPluginGraph
            | readonly ResolvedPluginPackage[]
            | PluginCatalog,
    ): string {
        if (graphInput && typeof graphInput === 'object' && 'revision' in graphInput) {
            const rev = (graphInput as any).revision
            if (typeof rev === 'string' && rev.trim().length > 0) {
                return rev.trim()
            }
        }
        return `rev-${Date.now()}`
    }
}
