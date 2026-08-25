import type {
    ContributionKind,
    OwnedContribution,
    PluginIdentity,
} from '@cpa/plugin-api'
import { PluginConflictError } from '@cpa/plugin-api'
import {
    ActivationTransaction,
    SINGLE_VALUE_CONTRIBUTION_KINDS,
    isSingleValueContributionKind,
    type StagedContribution,
} from './ActivationTransaction.js'

export { SINGLE_VALUE_CONTRIBUTION_KINDS, isSingleValueContributionKind }

function compareContributions(
    a: OwnedContribution<unknown>,
    b: OwnedContribution<unknown>,
): number {
    const priorityA = a.priority ?? 1000
    const priorityB = b.priority ?? 1000
    if (priorityA !== priorityB) {
        return priorityA - priorityB
    }
    const idDiff = a.owner.id.localeCompare(b.owner.id)
    if (idDiff !== 0) {
        return idDiff
    }
    return a.registrationSequence - b.registrationSequence
}

interface OwnerContributionEntry {
    readonly kind: ContributionKind
    readonly key: string
    readonly isSingle: boolean
}

export interface StagedTransactionEntry {
    readonly staged: ReadonlyArray<StagedContribution<unknown>>
    readonly ownerToken: symbol
}

/**
 * Universal Contribution Registry managing transactional registrations,
 * ownership validation, safe disposers, and observable subscriptions.
 */
export class ContributionRegistry {
    private readonly singleContributions = new Map<ContributionKind, Map<string, OwnedContribution<unknown>>>()
    private readonly multiContributions = new Map<ContributionKind, Map<string, OwnedContribution<unknown>>>()
    private readonly ownerContributions = new Map<symbol, Set<OwnerContributionEntry>>()
    private readonly subscribers = new Map<ContributionKind, Set<() => void>>()
    private sequenceCounter = 0

    /**
     * Start an isolated activation transaction for a plugin identity.
     */
    beginActivation(
        owner: PluginIdentity,
        options?: { isolated?: boolean },
    ): ActivationTransaction {
        const ownerToken = Symbol(`plugin:${owner.id}`)
        return new ActivationTransaction(this, owner, ownerToken, options)
    }

    /**
     * Look up a single contribution's value by kind and id.
     */
    get<T>(kind: ContributionKind, id: string): T | undefined {
        const registration = this.getRegistration(kind, id)
        return registration ? (registration.value as T) : undefined
    }

    /**
     * List all contributions of a given kind, optionally filtered by target,
     * sorted by priority -> pluginId -> registrationSequence.
     */
    list<T>(kind: ContributionKind, target?: string): ReadonlyArray<OwnedContribution<T>> {
        const map = isSingleValueContributionKind(kind)
            ? this.singleContributions.get(kind)
            : this.multiContributions.get(kind)

        if (!map || map.size === 0) {
            return Object.freeze([])
        }

        let items = Array.from(map.values()) as OwnedContribution<T>[]
        if (target !== undefined) {
            items = items.filter((item) => item.target === target)
        }

        items.sort(compareContributions)
        return Object.freeze(items)
    }

    /**
     * Subscribe to changes for a specific contribution kind.
     * Returns an unsubscribe function.
     */
    subscribe(kind: ContributionKind, listener: () => void): () => void {
        let set = this.subscribers.get(kind)
        if (!set) {
            set = new Set()
            this.subscribers.set(kind, set)
        }
        set.add(listener)

        return () => {
            set.delete(listener)
            if (set.size === 0) {
                this.subscribers.delete(kind)
            }
        }
    }

    /**
     * Revoke all contributions owned by a specific owner token.
     */
    revokeOwner(ownerToken: symbol): void {
        const entries = this.ownerContributions.get(ownerToken)
        if (!entries || entries.size === 0) {
            this.ownerContributions.delete(ownerToken)
            return
        }

        const affectedKinds = new Set<ContributionKind>()

        for (const entry of entries) {
            const map = entry.isSingle
                ? this.singleContributions.get(entry.kind)
                : this.multiContributions.get(entry.kind)

            if (map) {
                const current = map.get(entry.key)
                if (current && current.ownerToken === ownerToken) {
                    map.delete(entry.key)
                    affectedKinds.add(entry.kind)
                }
            }
        }

        this.ownerContributions.delete(ownerToken)

        for (const kind of affectedKinds) {
            this._notify(kind)
        }
    }

    /**
     * Clear all contributions and registered owners.
     */
    clear(): void {
        const affectedKinds = new Set<ContributionKind>([
            ...this.singleContributions.keys(),
            ...this.multiContributions.keys(),
        ])
        this.singleContributions.clear()
        this.multiContributions.clear()
        this.ownerContributions.clear()
        for (const kind of affectedKinds) {
            this._notify(kind)
        }
    }

    /**
     * Internal lookup for an existing registration.
     */
    getRegistration(kind: ContributionKind, id: string): OwnedContribution<unknown> | undefined {
        if (isSingleValueContributionKind(kind)) {
            return this.singleContributions.get(kind)?.get(id)
        }

        const multiMap = this.multiContributions.get(kind)
        if (!multiMap) {
            return undefined
        }

        for (const item of multiMap.values()) {
            if (item.id === id) {
                return item
            }
        }

        return undefined
    }

    /**
     * Atomically swap in a new generation of staged plugin contributions and revoke old owner tokens.
     * Guaranteed atomic: validates all single-value constraints before mutating state.
     */
    applyGeneration(
        entries: ReadonlyArray<StagedTransactionEntry>,
        oldOwnerTokens: ReadonlyArray<symbol> = [],
    ): Map<symbol, Array<() => void>> {
        const oldOwnerSet = new Set(oldOwnerTokens)

        // 1. Pre-validation: check single-value uniqueness within the new generation and against surviving owners
        const newSingleKeys = new Map<string, string>() // `${kind}:${id}` -> owner.id
        for (const entry of entries) {
            for (const item of entry.staged) {
                if (isSingleValueContributionKind(item.kind)) {
                    const key = `${item.kind}:${item.id}`
                    const existingStagedOwner = newSingleKeys.get(key)
                    if (existingStagedOwner) {
                        throw new PluginConflictError(
                            `Contribution conflict: ${item.kind}/${item.id} is registered multiple times in the same generation (owned by ${existingStagedOwner} and ${item.owner.id})`,
                            { pluginId: item.owner.id },
                        )
                    }
                    newSingleKeys.set(key, item.owner.id)

                    // Check against existing registered contributions that are NOT being replaced by oldOwnerTokens
                    const existing = this.singleContributions.get(item.kind)?.get(item.id)
                    if (
                        existing &&
                        !oldOwnerSet.has(existing.ownerToken) &&
                        existing.ownerToken !== item.ownerToken
                    ) {
                        throw new PluginConflictError(
                            `Contribution conflict: ${item.kind}/${item.id} is owned by ${existing.owner.id}`,
                            { pluginId: item.owner.id },
                        )
                    }
                }
            }
        }

        // 2. Atomic state mutation: remove old owners
        const affectedKinds = new Set<ContributionKind>()

        for (const oldToken of oldOwnerTokens) {
            const oldEntries = this.ownerContributions.get(oldToken)
            if (oldEntries) {
                for (const entry of oldEntries) {
                    const map = entry.isSingle
                        ? this.singleContributions.get(entry.kind)
                        : this.multiContributions.get(entry.kind)
                    if (map) {
                        const current = map.get(entry.key)
                        if (current && current.ownerToken === oldToken) {
                            map.delete(entry.key)
                            affectedKinds.add(entry.kind)
                        }
                    }
                }
                this.ownerContributions.delete(oldToken)
            }
        }

        // 3. Install new staged contributions
        const disposersByToken = new Map<symbol, Array<() => void>>()

        for (const entry of entries) {
            const disposers: Array<() => void> = []
            disposersByToken.set(entry.ownerToken, disposers)

            for (const item of entry.staged) {
                const sequence = ++this.sequenceCounter
                const owned: OwnedContribution<unknown> = {
                    kind: item.kind,
                    id: item.id,
                    target: item.target,
                    value: item.value,
                    priority: item.priority,
                    owner: item.owner,
                    ownerToken: item.ownerToken,
                    registrationSequence: sequence,
                }

                const isSingle = isSingleValueContributionKind(item.kind)
                const key = isSingle ? item.id : `${item.owner.id}:${item.id}`

                if (isSingle) {
                    let map = this.singleContributions.get(item.kind)
                    if (!map) {
                        map = new Map()
                        this.singleContributions.set(item.kind, map)
                    }
                    map.set(key, owned)
                } else {
                    let map = this.multiContributions.get(item.kind)
                    if (!map) {
                        map = new Map()
                        this.multiContributions.set(item.kind, map)
                    }
                    map.set(key, owned)
                }

                let ownerSet = this.ownerContributions.get(entry.ownerToken)
                if (!ownerSet) {
                    ownerSet = new Set()
                    this.ownerContributions.set(entry.ownerToken, ownerSet)
                }
                const ownerEntry: OwnerContributionEntry = { kind: item.kind, key, isSingle }
                ownerSet.add(ownerEntry)

                affectedKinds.add(item.kind)

                const kind = item.kind
                const ownerToken = entry.ownerToken
                let disposed = false
                disposers.push(() => {
                    if (disposed) return
                    disposed = true
                    this._removeContribution(kind, key, ownerToken, isSingle, ownerEntry)
                })
            }
        }

        // 4. Notify affected kinds once per atomic batch
        for (const kind of affectedKinds) {
            this._notify(kind)
        }

        return disposersByToken
    }

    /**
     * Internal method to atomically apply an activation transaction.
     */
    _applyTransaction(
        staged: readonly StagedContribution<unknown>[],
        ownerToken: symbol,
    ): Array<() => void> {
        if (staged.length === 0) {
            return []
        }
        const result = this.applyGeneration([{ staged, ownerToken }], [])
        return result.get(ownerToken) ?? []
    }

    private _removeContribution(
        kind: ContributionKind,
        key: string,
        ownerToken: symbol,
        isSingle: boolean,
        ownerEntry?: OwnerContributionEntry,
    ): void {
        const map = isSingle
            ? this.singleContributions.get(kind)
            : this.multiContributions.get(kind)

        if (!map) {
            return
        }

        const current = map.get(key)
        if (!current || current.ownerToken !== ownerToken) {
            return
        }

        map.delete(key)
        if (map.size === 0) {
            if (isSingle) {
                this.singleContributions.delete(kind)
            } else {
                this.multiContributions.delete(kind)
            }
        }

        const ownerSet = this.ownerContributions.get(ownerToken)
        if (ownerSet) {
            if (ownerEntry) {
                ownerSet.delete(ownerEntry)
            } else {
                for (const entry of Array.from(ownerSet)) {
                    if (entry.kind === kind && entry.key === key) {
                        ownerSet.delete(entry)
                    }
                }
            }
            if (ownerSet.size === 0) {
                this.ownerContributions.delete(ownerToken)
            }
        }

        this._notify(kind)
    }

    private _notify(kind: ContributionKind): void {
        const set = this.subscribers.get(kind)
        if (!set || set.size === 0) {
            return
        }
        for (const listener of Array.from(set)) {
            try {
                listener()
            } catch (err) {
                console.error(`Error in ContributionRegistry subscriber for ${kind}:`, err)
            }
        }
    }
}
