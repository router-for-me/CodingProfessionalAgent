import { useCallback, useSyncExternalStore } from 'react'
import type {
    ActionContribution,
    ActionContext,
    ActionExecutionContext,
    ActionPlacement,
} from '@cpa/plugin-api'
import { actionRegistry, ActionRegistry } from '@/application/actions/actionRegistry'
import { getDefaultHostServices, getHashRoutePathname } from '@cpa/plugin-ui'

/**
 * Creates a standard ActionContext based on current location and host services.
 */
export function createActionContext(pathname = getHashRoutePathname()): ActionContext {
    const services = getDefaultHostServices()
    if (!services) {
        throw new Error('HostServices have not been initialized.')
    }
    return {
        services,
        pathname,
    }
}

/**
 * Creates an ActionExecutionContext for action invocation.
 */
export function createActionExecutionContext(
    source: ActionExecutionContext['source'],
    pathname = getHashRoutePathname()
): ActionExecutionContext {
    return {
        ...createActionContext(pathname),
        source,
    }
}

/**
 * React hook that subscribes to actions matching a specific placement surface.
 */
export function useActionsForSurface(
    surface: ActionPlacement['surface'],
    context?: ActionContext,
    registry: ActionRegistry = actionRegistry
): readonly ActionContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.listForSurface(surface, context),
        [registry, surface, context]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook that subscribes to all registered actions.
 */
export function useAllActions(
    registry: ActionRegistry = actionRegistry
): readonly ActionContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.list(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Executes a registered action with the global action registry.
 */
export async function executeAction(
    actionId: string,
    context?: Partial<ActionExecutionContext>,
    registry: ActionRegistry = actionRegistry
): Promise<void> {
    const fullContext: ActionExecutionContext = {
        ...createActionExecutionContext(context?.source ?? 'api', context?.pathname),
        ...context,
    }
    await registry.execute(actionId, fullContext)
}

export { actionRegistry, ActionRegistry }
