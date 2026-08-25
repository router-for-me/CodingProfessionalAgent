import type { PluginEventBus as IPluginEventBus } from '@cpa/plugin-api'
import { safeInvoke } from '../safety/safeInvoke.js'

export type PluginEventListener<T = unknown> = (payload: T) => void | Promise<void>

interface ListenerEntry {
    readonly eventName: string
    readonly listener: PluginEventListener<any>
    readonly ownerToken?: symbol
}

/**
 * Universal Event Bus for plugin communication with error boundaries,
 * scoped owner token lifecycle cleanup, and safe asynchronous dispatch.
 */
export class PluginEventBus implements IPluginEventBus {
    private readonly listeners = new Map<string, Set<ListenerEntry>>()
    private readonly ownerListeners = new Map<symbol, Set<ListenerEntry>>()

    /**
     * Subscribe to an event, optionally associating the listener with an owner token.
     * Returns an unsubscribe function.
     */
    on<T>(
        eventName: string,
        listener: (payload: T) => void | Promise<void>,
        ownerToken?: symbol,
    ): () => void {
        const entry: ListenerEntry = {
            eventName,
            listener: listener as PluginEventListener<any>,
            ownerToken,
        }

        let eventSet = this.listeners.get(eventName)
        if (!eventSet) {
            eventSet = new Set()
            this.listeners.set(eventName, eventSet)
        }
        eventSet.add(entry)

        if (ownerToken) {
            let ownerSet = this.ownerListeners.get(ownerToken)
            if (!ownerSet) {
                ownerSet = new Set()
                this.ownerListeners.set(ownerToken, ownerSet)
            }
            ownerSet.add(entry)
        }

        let disposed = false
        return () => {
            if (disposed) return
            disposed = true
            this._removeEntry(entry)
        }
    }

    /**
     * Emit an event to all subscribers, running each listener within a safe error boundary.
     */
    async emit<T = unknown>(eventName: string, payload?: T): Promise<void> {
        const eventSet = this.listeners.get(eventName)
        if (!eventSet || eventSet.size === 0) {
            return
        }

        const entries = Array.from(eventSet)
        await Promise.all(
            entries.map((entry) =>
                safeInvoke(() => entry.listener(payload), {
                    actionName: `event:${eventName}`,
                }),
            ),
        )
    }

    /**
     * Revoke all listeners associated with a specific owner token.
     */
    revokeOwner(ownerToken: symbol): void {
        const ownerSet = this.ownerListeners.get(ownerToken)
        if (!ownerSet || ownerSet.size === 0) {
            this.ownerListeners.delete(ownerToken)
            return
        }

        for (const entry of Array.from(ownerSet)) {
            this._removeEntry(entry)
        }
        this.ownerListeners.delete(ownerToken)
    }

    /**
     * Create a scoped event bus that automatically attaches the given owner token to all listeners.
     */
    createScoped(ownerToken: symbol): IPluginEventBus {
        return {
            emit: <T = unknown>(eventName: string, payload?: T) => this.emit(eventName, payload),
            on: <T>(eventName: string, listener: (payload: T) => void | Promise<void>) =>
                this.on(eventName, listener, ownerToken),
        }
    }

    /**
     * Create an isolated staged event bus for two-phase activation staging.
     */
    createStaged(ownerToken: symbol): StagedPluginEventBus {
        return new StagedPluginEventBus(this, ownerToken)
    }

    /**
     * Return the count of active listeners for a specific event or overall.
     */
    listenerCount(eventName?: string): number {
        if (eventName) {
            return this.listeners.get(eventName)?.size ?? 0
        }
        let total = 0
        for (const set of this.listeners.values()) {
            total += set.size
        }
        return total
    }

    private _removeEntry(entry: ListenerEntry): void {
        const eventSet = this.listeners.get(entry.eventName)
        if (eventSet) {
            eventSet.delete(entry)
            if (eventSet.size === 0) {
                this.listeners.delete(entry.eventName)
            }
        }

        if (entry.ownerToken) {
            const ownerSet = this.ownerListeners.get(entry.ownerToken)
            if (ownerSet) {
                ownerSet.delete(entry)
                if (ownerSet.size === 0) {
                    this.ownerListeners.delete(entry.ownerToken)
                }
            }
        }
    }
}

export interface StagedListenerEntry {
    readonly eventName: string
    readonly listener: PluginEventListener<any>
    readonly ownerToken: symbol
    disposed: boolean
    liveUnsubscribe?: () => void
}

export interface StagedEmitEntry {
    readonly eventName: string
    readonly payload: unknown
}

/**
 * Isolated staged event bus for two-phase plugin activation staging.
 * Buffers subscriptions and emits until commit time, preventing side-effects
 * or live event leaks during prepareGeneration().
 */
export class StagedPluginEventBus implements IPluginEventBus {
    private readonly stagedListeners: StagedListenerEntry[] = []
    private readonly stagedEmits: StagedEmitEntry[] = []
    private finalized = false
    private committed = false

    constructor(
        private readonly parentBus: PluginEventBus,
        readonly ownerToken: symbol,
    ) {}

    /**
     * Subscribe to an event in staging. The listener is NOT attached to the live
     * parent bus until commitListeners() is invoked.
     */
    on<T>(
        eventName: string,
        listener: (payload: T) => void | Promise<void>,
    ): () => void {
        if (this.finalized && !this.committed) {
            return () => {}
        }

        if (this.committed) {
            return this.parentBus.on(eventName, listener, this.ownerToken)
        }

        const entry: StagedListenerEntry = {
            eventName,
            listener: listener as PluginEventListener<any>,
            ownerToken: this.ownerToken,
            disposed: false,
        }

        this.stagedListeners.push(entry)

        return () => {
            if (entry.disposed) return
            entry.disposed = true

            if (entry.liveUnsubscribe) {
                entry.liveUnsubscribe()
                entry.liveUnsubscribe = undefined
            } else {
                const idx = this.stagedListeners.indexOf(entry)
                if (idx !== -1) {
                    this.stagedListeners.splice(idx, 1)
                }
            }
        }
    }

    /**
     * Emit an event in staging. The event is queued and NOT emitted to live
     * listeners until flushEmits() is invoked after commit.
     */
    async emit<T = unknown>(eventName: string, payload?: T): Promise<void> {
        if (this.finalized && !this.committed) {
            return
        }

        if (this.committed) {
            await this.parentBus.emit(eventName, payload)
            return
        }

        this.stagedEmits.push({ eventName, payload })
    }

    /**
     * Commit all non-disposed staged listeners to the live parent event bus.
     * Returns an array of live disposer functions.
     */
    commitListeners(): Array<() => void> {
        if (this.finalized) {
            return []
        }
        const disposers: Array<() => void> = []

        for (const entry of this.stagedListeners) {
            if (!entry.disposed) {
                const unsub = this.parentBus.on(
                    entry.eventName,
                    entry.listener,
                    entry.ownerToken,
                )
                entry.liveUnsubscribe = unsub
                disposers.push(unsub)
            }
        }

        return disposers
    }

    /**
     * Flush all queued emits to the live parent event bus in deterministic FIFO order.
     */
    async flushEmits(): Promise<void> {
        if (this.finalized) {
            return
        }
        this.finalized = true
        this.committed = true

        const emitsToFlush = [...this.stagedEmits]
        this.stagedEmits.length = 0

        for (const item of emitsToFlush) {
            await safeInvoke(
                () => this.parentBus.emit(item.eventName, item.payload),
                { actionName: `flush-staged-emit:${item.eventName}` },
            )
        }
    }

    /**
     * Commit listeners and flush queued emits in sequence.
     */
    async commit(): Promise<Array<() => void>> {
        const disposers = this.commitListeners()
        await this.flushEmits()
        return disposers
    }

    /**
     * Roll back and discard all staged listeners and queued emits.
     */
    rollback(): void {
        if (this.finalized) {
            return
        }
        this.finalized = true
        this.committed = false
        this.stagedListeners.length = 0
        this.stagedEmits.length = 0
    }

    /**
     * Check if the staging area has been committed or rolled back.
     */
    isFinalized(): boolean {
        return this.finalized
    }
}
