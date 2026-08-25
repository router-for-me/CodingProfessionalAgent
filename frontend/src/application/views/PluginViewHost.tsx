import React, { Component, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { getHashRoutePathname } from '@cpa/plugin-ui'
import { useViews, viewRegistry } from '@/plugins/platform/contributions/views'

export interface PluginViewHostProps {
    path?: string
    viewId?: string
    fallback?: ReactNode
}

interface ErrorBoundaryProps {
    fallback?: ReactNode
    children: ReactNode
}

interface ErrorBoundaryState {
    hasError: boolean
    error: Error | null
}

class ViewErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error }
    }

    override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('[PluginViewHost] Error rendering view component:', error, errorInfo)
    }

    override render() {
        if (this.state.hasError) {
            return (
                this.props.fallback ?? (
                    <div className="flex h-full w-full items-center justify-center p-6 text-sm text-[var(--text-muted)]">
                        Failed to render view.
                    </div>
                )
            )
        }
        return this.props.children
    }
}

function useCurrentRouterPath(): string {
    try {
        return useRouterState({
            select: (state) => state.location.pathname,
        })
    } catch {
        return getHashRoutePathname()
    }
}

/**
 * Universal dynamic view host that reactively subscribes to ViewRegistry
 * and mounts matching view contributions with parsed route parameters.
 */
export function PluginViewHost({ path, viewId, fallback }: PluginViewHostProps) {
    const currentRouterPath = useCurrentRouterPath()
    // Subscribe to view registry changes
    useViews()

    const effectivePath = path ?? currentRouterPath

    let matched: { view: any; params: Record<string, string> } | undefined

    if (viewId) {
        const view = viewRegistry.getView(viewId)
        if (view) {
            matched = { view, params: {} }
        }
    } else {
        matched = viewRegistry.matchViewAndParams(effectivePath)
    }

    if (!matched || !matched.view || !matched.view.component) {
        return fallback ? <>{fallback}</> : null
    }

    const Component = matched.view.component
    const params = matched.params

    return (
        <ViewErrorBoundary fallback={fallback}>
            <Component {...params} params={params} path={effectivePath} />
        </ViewErrorBoundary>
    )
}
