import type { WebRouteContribution } from '@cpa/plugin-api'

/**
 * WebRouteRegistry manages the deterministic ordering, lookup, registration,
 * and dispatching of structured Web HTTP routes.
 */
export class WebRouteRegistry {
    private readonly routes = new Map<string, WebRouteContribution>()

    /**
     * Register a Web route contribution. Returns an unregister disposer function.
     */
    register(route: WebRouteContribution): () => void {
        if (!route || typeof route.id !== 'string' || !route.id.trim()) {
            throw new Error('Invalid route contribution: id is required')
        }
        if (typeof route.handle !== 'function') {
            throw new Error(`Invalid route contribution for "${route.id}": handle must be a function`)
        }

        this.routes.set(route.id, route)

        return () => {
            if (this.routes.get(route.id) === route) {
                this.routes.delete(route.id)
            }
        }
    }

    /**
     * Unregister a route by ID.
     */
    unregister(id: string): void {
        this.routes.delete(id)
    }

    /**
     * Get a route by ID.
     */
    get(id: string): WebRouteContribution | undefined {
        return this.routes.get(id)
    }

    /**
     * Check if a route ID is registered.
     */
    has(id: string): boolean {
        return this.routes.has(id)
    }

    /**
     * List all registered routes sorted deterministically by order ascending, then by ID.
     */
    list(): readonly WebRouteContribution[] {
        const routeList = Array.from(this.routes.values())
        routeList.sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order
            }
            return a.id.localeCompare(b.id)
        })
        return Object.freeze(routeList)
    }

    /**
     * Find the first matching route for the given HTTP method and request pathname.
     */
    match(method: string, pathname: string): WebRouteContribution | undefined {
        const sorted = this.list()
        for (const route of sorted) {
            if (this.matchesRoute(route, method, pathname)) {
                return route
            }
        }
        return undefined
    }

    private matchesRoute(
        route: WebRouteContribution,
        method: string,
        pathname: string,
    ): boolean {
        // Method matching
        if (route.method !== '*' && route.method.toUpperCase() !== method.toUpperCase()) {
            return false
        }

        // Static fallback routes should not match dynamic /api/ or /debug/ subtrees
        if (
            route.id === 'static' &&
            (pathname === '/api' ||
                pathname === '/debug' ||
                pathname.startsWith('/api/') ||
                pathname.startsWith('/debug/'))
        ) {
            return false
        }

        // Comma-separated path patterns support
        const pathPatterns = route.path
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)

        for (const pattern of pathPatterns) {
            if (pattern === '*' || pattern === '/*') {
                return true
            }
            if (pattern === pathname) {
                return true
            }
            if (pattern.endsWith('/*')) {
                const prefix = pattern.slice(0, -2)
                if (pathname === prefix || pathname.startsWith(prefix + '/')) {
                    return true
                }
            } else if (pattern.endsWith('*')) {
                const prefix = pattern.slice(0, -1)
                if (pathname.startsWith(prefix)) {
                    return true
                }
            }
        }

        return false
    }
}
