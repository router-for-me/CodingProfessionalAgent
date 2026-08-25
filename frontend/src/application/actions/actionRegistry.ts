import type {
    ActionContribution,
    ActionContext,
    ActionExecutionContext,
    ActionPlacement,
} from '@cpa/plugin-api'

/**
 * Universal ActionRegistry that stores, queries, and executes unified ActionContributions
 * across keyboard shortcuts, menus, slash commands, and programmatic APIs.
 */
export class ActionRegistry {
    private actions = new Map<string, ActionContribution>()
    private listeners = new Set<() => void>()

    // Snapshot reference caches for React useSyncExternalStore stability
    private cachedList: readonly ActionContribution[] | null = null
    private cachedSurfaces = new Map<string, readonly ActionContribution[]>()

    private invalidateCache(): void {
        this.cachedList = null
        this.cachedSurfaces.clear()
    }

    /**
     * Registers a new action contribution. Returns an unregister disposer function.
     */
    register(action: ActionContribution): () => void {
        this.actions.set(action.id, action)
        this.invalidateCache()
        this.notify()

        return () => {
            if (this.actions.get(action.id) === action) {
                this.actions.delete(action.id)
                this.invalidateCache()
                this.notify()
            }
        }
    }

    /**
     * Unregisters an action by ID.
     */
    unregister(actionId: string): void {
        if (this.actions.has(actionId)) {
            this.actions.delete(actionId)
            this.invalidateCache()
            this.notify()
        }
    }

    /**
     * Gets a registered action by ID.
     */
    get(actionId: string): ActionContribution | undefined {
        return this.actions.get(actionId)
    }

    /**
     * Lists all registered actions.
     */
    list(): readonly ActionContribution[] {
        if (!this.cachedList) {
            this.cachedList = Object.freeze(Array.from(this.actions.values()))
        }
        return this.cachedList
    }

    /**
     * Lists actions configured for a particular UI surface (e.g. 'menu.user', 'composer.slash', 'titlebar', 'sidebar'),
     * evaluated against visible predicate and sorted by placement order ascending.
     */
    listForSurface(
        surface: ActionPlacement['surface'],
        context?: ActionContext
    ): readonly ActionContribution[] {
        if (!context) {
            const cached = this.cachedSurfaces.get(surface)
            if (cached) return cached
        }

        const matches: Array<{ action: ActionContribution; order: number }> = []

        for (const action of this.actions.values()) {
            const placement = action.placements?.find((p) => p.surface === surface)
            if (!placement) continue

            if (context && typeof action.visible === 'function') {
                try {
                    const isVisible = action.visible(context)
                    if (!isVisible) continue
                } catch (err) {
                    console.error(`[ActionRegistry] Error evaluating visible predicate for action "${action.id}":`, err)
                    continue
                }
            }

            matches.push({
                action,
                order: placement.order ?? 100,
            })
        }

        matches.sort((a, b) => a.order - b.order)
        const result = Object.freeze(matches.map((m) => m.action))
        if (!context) {
            this.cachedSurfaces.set(surface, result)
        }
        return result
    }

    /**
     * Executes a registered action handler with fault isolation and enabled check.
     */
    async execute(actionId: string, context: ActionExecutionContext): Promise<void> {
        const action = this.actions.get(actionId)
        if (!action) {
            throw new Error(`Action "${actionId}" not found`)
        }

        if (typeof action.enabled === 'function') {
            try {
                const isEnabled = action.enabled(context)
                if (!isEnabled) {
                    return
                }
            } catch (err) {
                console.error(`[ActionRegistry] Error evaluating enabled predicate for action "${actionId}":`, err)
                return
            }
        }

        await action.handler(context)
    }

    /**
     * Subscribes to changes in registered actions.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /**
     * Clears all registered actions.
     */
    clear(): void {
        this.actions.clear()
        this.invalidateCache()
        this.notify()
    }

    private notify(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener()
            } catch (err) {
                console.error('[ActionRegistry] Listener failed:', err)
            }
        }
    }
}

/**
 * Authoritative global singleton action registry instance initialized empty.
 */
export const actionRegistry = new ActionRegistry()
