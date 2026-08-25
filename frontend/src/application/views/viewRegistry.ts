import type {
    NavigationContribution,
    ViewContribution,
    ViewLayout,
} from '@cpa/plugin-api'

export type {
    NavigationContribution,
    ViewContribution,
    ViewLayout,
}

export const DEFAULT_VIEW_LAYOUT: ViewLayout = Object.freeze({
    showComposer: false,
    rightPanelMode: 'default',
    reserveWindowToolbar: true,
})

export interface RouteMatchResult {
    matches: boolean
    params: Record<string, string>
}

/**
 * Normalizes a pathname or route pattern by removing trailing slashes.
 */
function normalizePath(p: string): string {
    const trimmed = p.trim()
    if (!trimmed || trimmed === '/') return '/'
    return trimmed.replace(/\/+$/, '') || '/'
}

/**
 * Matches a route pattern against a pathname, extracting parameterized segments (:param, $param)
 * and wildcard splats (*, $).
 */
export function matchRoutePattern(pattern: string, pathname: string): RouteMatchResult {
    const normPattern = normalizePath(pattern)
    const normPathname = normalizePath(pathname)

    if (normPattern === normPathname) {
        return { matches: true, params: {} }
    }

    const patternSegments = normPattern === '/' ? [] : normPattern.slice(1).split('/')
    const pathnameSegments = normPathname === '/' ? [] : normPathname.slice(1).split('/')

    const params: Record<string, string> = {}

    // Check for trailing wildcard splat (* or $)
    const hasWildcard =
        patternSegments.length > 0 &&
        (patternSegments[patternSegments.length - 1] === '*' ||
            patternSegments[patternSegments.length - 1] === '$')

    if (!hasWildcard && patternSegments.length !== pathnameSegments.length) {
        return { matches: false, params: {} }
    }

    if (hasWildcard && pathnameSegments.length < patternSegments.length - 1) {
        return { matches: false, params: {} }
    }

    const checkLength = hasWildcard ? patternSegments.length - 1 : patternSegments.length

    for (let i = 0; i < checkLength; i++) {
        const pSeg = patternSegments[i]
        const pathSeg = pathnameSegments[i]

        if (pSeg.startsWith('$') || pSeg.startsWith(':')) {
            const paramName = pSeg.slice(1)
            params[paramName] = decodeURIComponent(pathSeg)
        } else if (pSeg !== pathSeg) {
            return { matches: false, params: {} }
        }
    }

    if (hasWildcard) {
        const splatValue = pathnameSegments.slice(checkLength).map(decodeURIComponent).join('/')
        params.splat = splatValue
        params['*'] = splatValue
        params['$'] = splatValue
    }

    return { matches: true, params }
}

/**
 * Universal ViewRegistry storing and coordinating ViewContribution and NavigationContribution
 * definitions across routing, top sidebar navigation, AppShell layout, and WindowToolbar.
 */
export class ViewRegistry {
    private views = new Map<string, ViewContribution>()
    private navigationItems = new Map<string, NavigationContribution>()
    private listeners = new Set<() => void>()

    private cachedViewsList: readonly ViewContribution[] | null = null
    private cachedNavList: readonly NavigationContribution[] | null = null

    private invalidateCache(): void {
        this.cachedViewsList = null
        this.cachedNavList = null
    }

    /**
     * Registers a view contribution. Returns a cleanup disposer function.
     */
    registerView(view: ViewContribution): () => void {
        this.views.set(view.id, Object.freeze({ ...view }))
        this.invalidateCache()
        this.notify()

        return () => {
            if (this.views.get(view.id)?.id === view.id) {
                this.views.delete(view.id)
                this.invalidateCache()
                this.notify()
            }
        }
    }

    /**
     * Unregisters a view by ID.
     */
    unregisterView(viewId: string): void {
        if (this.views.has(viewId)) {
            this.views.delete(viewId)
            this.invalidateCache()
            this.notify()
        }
    }

    /**
     * Retrieves a registered view contribution by ID.
     */
    getView(viewId: string): ViewContribution | undefined {
        return this.views.get(viewId)
    }

    /**
     * Lists all registered view contributions.
     */
    listViews(): readonly ViewContribution[] {
        if (!this.cachedViewsList) {
            this.cachedViewsList = Object.freeze(Array.from(this.views.values()))
        }
        return this.cachedViewsList
    }

    /**
     * Registers a navigation item contribution. Returns a cleanup disposer function.
     */
    registerNavigationItem(item: NavigationContribution): () => void {
        this.navigationItems.set(item.id, Object.freeze({ ...item }))
        this.invalidateCache()
        this.notify()

        return () => {
            if (this.navigationItems.get(item.id)?.id === item.id) {
                this.navigationItems.delete(item.id)
                this.invalidateCache()
                this.notify()
            }
        }
    }

    /**
     * Unregisters a navigation item by ID.
     */
    unregisterNavigationItem(itemId: string): void {
        if (this.navigationItems.has(itemId)) {
            this.navigationItems.delete(itemId)
            this.invalidateCache()
            this.notify()
        }
    }

    /**
     * Retrieves a registered navigation item contribution by ID.
     */
    getNavigationItem(itemId: string): NavigationContribution | undefined {
        return this.navigationItems.get(itemId)
    }

    /**
     * Lists all registered navigation items sorted by order ascending.
     */
    listNavigationItems(): readonly NavigationContribution[] {
        if (!this.cachedNavList) {
            const items = Array.from(this.navigationItems.values()).map((item) => {
                const view = this.views.get(item.viewId)
                return {
                    ...item,
                    path: item.path ?? view?.path ?? `/${item.viewId}`,
                }
            })
            items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
            this.cachedNavList = Object.freeze(items)
        }
        return this.cachedNavList
    }

    /**
     * Finds a registered view and parsed parameters matching the provided pathname.
     */
    matchViewAndParams(pathname: string): { view: ViewContribution; params: Record<string, string> } | undefined {
        // Try exact match first
        const normPath = normalizePath(pathname)
        for (const view of this.views.values()) {
            if (normalizePath(view.path) === normPath) {
                return { view, params: {} }
            }
        }

        // Try pattern match
        for (const view of this.views.values()) {
            const match = matchRoutePattern(view.path, pathname)
            if (match.matches) {
                return { view, params: match.params }
            }
        }

        return undefined
    }

    /**
     * Finds a registered view matching the provided path or parameterized pathname.
     */
    matchView(pathname: string): ViewContribution | undefined {
        return this.matchViewAndParams(pathname)?.view
    }

    /**
     * Retrieves layout metadata for a pathname, falling back to default layout if unmapped.
     */
    getLayoutForPath(pathname: string): ViewLayout {
        const view = this.matchView(pathname)
        return view ? view.layout : DEFAULT_VIEW_LAYOUT
    }

    /**
     * Subscribes a listener to registry changes.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /**
     * Clears all registered views and navigation items.
     */
    clear(): void {
        this.views.clear()
        this.navigationItems.clear()
        this.invalidateCache()
        this.notify()
    }

    private notify(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener()
            } catch (err) {
                console.error('[ViewRegistry] Listener error:', err)
            }
        }
    }
}

/**
 * Authoritative singleton ViewRegistry instance initialized empty.
 */
export const viewRegistry = new ViewRegistry()
