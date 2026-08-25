import {
    createHashHistory,
    createRootRoute,
    createRoute,
    createRouter,
} from '@tanstack/react-router'
import { AppShell } from '@/components/layout/AppShell'
import { PluginViewHost } from '@/application/views/PluginViewHost'
import { setHostRouter } from '@/application/services/createHostServices'

export const rootRoute = createRootRoute({
    component: AppShell,
})

export const catchAllRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: () => <PluginViewHost />,
})

export const routeTree = rootRoute.addChildren([
    catchAllRoute,
])

export const router = createRouter({
    routeTree,
    // Keep application routes independent of the document URL in every environment.
    history: createHashHistory(),
    defaultPreload: 'intent',
})

setHostRouter(router as any)

if (typeof window !== 'undefined') {
    ;(window as any).__cpa_navigate = (to: any) => {
        const opts = typeof to === 'string' ? { to } : to
        return router.navigate(opts)
    }
}

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}
