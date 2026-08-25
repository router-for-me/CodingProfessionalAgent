import type {
    ContributionKind,
    PluginIdentity,
} from '@cpa/plugin-api'
import { PluginConflictError } from '@cpa/plugin-api'
import type { ContributionRegistry } from './ContributionRegistry.js'

/**
 * Known single-value contribution kinds where duplicate registrations are rejected.
 */
export const SINGLE_VALUE_CONTRIBUTION_KINDS: ReadonlySet<ContributionKind> = new Set<ContributionKind>([
    'service',
    'rpc',
    'action',
    'view',
    'panel',
    'tool-factory',
    'protocol',
    'model-catalog',
    'background-job',
    'storage',
])

export function isSingleValueContributionKind(kind: ContributionKind): boolean {
    return SINGLE_VALUE_CONTRIBUTION_KINDS.has(kind)
}

export interface StagedContribution<T = unknown> {
    readonly kind: ContributionKind
    readonly id: string
    readonly target?: string
    readonly value: T
    readonly priority?: number
    readonly owner: PluginIdentity
    readonly ownerToken: symbol
}

/**
 * Transactional staging area for plugin contribution registrations.
 * Staged contributions are isolated until commit() is invoked.
 */
export class ActivationTransaction {
    private readonly staged: StagedContribution<unknown>[] = []
    private readonly stagedKeys = new Set<string>()
    private finalized = false

    constructor(
        private readonly registry: ContributionRegistry,
        readonly owner: PluginIdentity,
        readonly ownerToken: symbol,
        private readonly options?: { isolated?: boolean },
    ) {}

    /**
     * Stage a contribution registration within this activation transaction.
     */
    register<T>(
        kind: ContributionKind,
        id: string,
        value: T,
        options?: { target?: string; priority?: number },
    ): this {
        if (this.finalized) {
            throw new Error(`ActivationTransaction for plugin "${this.owner.id}" has already been finalized`)
        }

        const stagedKey = `${kind}:${id}`
        if (this.stagedKeys.has(stagedKey)) {
            throw new PluginConflictError(
                `Contribution conflict: ${kind}/${id} is owned by ${this.owner.id}`,
                { pluginId: this.owner.id },
            )
        }

        if (!this.options?.isolated && isSingleValueContributionKind(kind)) {
            const existing = this.registry.getRegistration(kind, id)
            if (existing) {
                throw new PluginConflictError(
                    `Contribution conflict: ${kind}/${id} is owned by ${existing.owner.id}`,
                    { pluginId: this.owner.id },
                )
            }
        }

        this.stagedKeys.add(stagedKey)
        this.staged.push({
            kind,
            id,
            target: options?.target,
            value,
            priority: options?.priority,
            owner: this.owner,
            ownerToken: this.ownerToken,
        })

        return this
    }

    /**
     * Get a snapshot of all staged contributions in this transaction.
     */
    getStagedContributions(): ReadonlyArray<StagedContribution<unknown>> {
        return Object.freeze([...this.staged])
    }

    /**
     * Look up a staged contribution value within this activation transaction.
     */
    getStaged<T = unknown>(kind: ContributionKind, id: string): T | undefined {
        for (const item of this.staged) {
            if (item.kind === kind && item.id === id) {
                return item.value as T
            }
        }
        return undefined
    }

    /**
     * Atomically commit all staged contributions to the registry.
     * Returns an array of owner-safe disposer functions.
     */
    commit(): Array<() => void> {
        if (this.finalized) {
            throw new Error(`ActivationTransaction for plugin "${this.owner.id}" has already been finalized`)
        }
        this.finalized = true

        return this.registry._applyTransaction(this.staged, this.ownerToken)
    }

    /**
     * Discard all staged registrations without notifying consumers.
     */
    rollback(): void {
        if (this.finalized) {
            return
        }
        this.finalized = true
        this.staged.length = 0
        this.stagedKeys.clear()
    }
}
