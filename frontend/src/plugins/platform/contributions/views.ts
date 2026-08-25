import { useCallback, useSyncExternalStore } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { getHashRoutePathname } from '@cpa/plugin-ui'
import type {
    NavigationContribution,
    RightPanelMode,
    ViewContribution,
    ViewLayout,
} from '@cpa/plugin-api'
import {
    DEFAULT_VIEW_LAYOUT,
    viewRegistry,
    ViewRegistry,
} from '@/application/views/viewRegistry'

export type {
    NavigationContribution,
    RightPanelMode,
    ViewContribution,
    ViewLayout,
}

export {
    DEFAULT_VIEW_LAYOUT,
    viewRegistry,
    ViewRegistry,
}

/**
 * Safely extracts current router location pathname, with fallback for environments outside RouterProvider.
 */
function useCurrentPathname(): string {
    try {
        return useRouterState({
            select: (state) => state.location.pathname,
        })
    } catch {
        return getHashRoutePathname()
    }
}

/**
 * Returns all registered views from the ViewRegistry.
 */
export function selectViews(registry: ViewRegistry = viewRegistry): readonly ViewContribution[] {
    return registry.listViews()
}

/**
 * Returns all registered navigation items sorted by order from the ViewRegistry.
 */
export function selectNavigationNavigationItems(registry: ViewRegistry = viewRegistry): readonly NavigationContribution[] {
    return registry.listNavigationItems()
}

export { selectNavigationNavigationItems as selectNavigationItems }

/**
 * Matches and returns the ViewContribution corresponding to a given pathname.
 */
export function selectCurrentView(
    pathname: string,
    registry: ViewRegistry = viewRegistry
): ViewContribution | undefined {
    return registry.matchView(pathname)
}

/**
 * Retrieves the ViewLayout for a given pathname, falling back to DEFAULT_VIEW_LAYOUT.
 */
export function selectViewLayout(
    pathname: string,
    registry: ViewRegistry = viewRegistry
): ViewLayout {
    return registry.getLayoutForPath(pathname)
}

/**
 * React hook subscribing to all registered views.
 */
export function useViews(registry: ViewRegistry = viewRegistry): readonly ViewContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.listViews(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to all registered navigation items.
 */
export function useNavigationItems(registry: ViewRegistry = viewRegistry): readonly NavigationContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.listNavigationItems(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to the active ViewContribution matching current router location or given pathname.
 */
export function useCurrentView(
    overridePathname?: string,
    registry: ViewRegistry = viewRegistry
): ViewContribution | undefined {
    const routerPathname = useCurrentPathname()
    const pathname = overridePathname ?? routerPathname

    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.matchView(pathname),
        [registry, pathname]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to the active ViewLayout matching current router location or given pathname.
 */
export function useCurrentViewLayout(
    overridePathname?: string,
    registry: ViewRegistry = viewRegistry
): ViewLayout {
    const routerPathname = useCurrentPathname()
    const pathname = overridePathname ?? routerPathname

    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getLayoutForPath(pathname),
        [registry, pathname]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
