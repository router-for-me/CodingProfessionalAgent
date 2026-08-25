import React, { Component, type ReactNode } from 'react'

export interface PluginSurfaceErrorInfo {
    pluginId: string
    contributionId?: string
    error: Error
    componentStack?: string | null
}

export interface PluginSurfaceProps {
    pluginId: string
    contributionId?: string
    fallback?: ReactNode | ((error: Error, info: PluginSurfaceErrorInfo) => ReactNode)
    onError?: (errorInfo: PluginSurfaceErrorInfo) => void
    children?: ReactNode
    className?: string
}

interface PluginSurfaceState {
    hasError: boolean
    error: Error | null
}

/**
 * Neutral React error boundary component for safely hosting plugin UI contributions.
 * Reports pluginId, contributionId, and error details when a child component fails.
 */
export class PluginSurface extends Component<PluginSurfaceProps, PluginSurfaceState> {
    constructor(props: PluginSurfaceProps) {
        super(props)
        this.state = {
            hasError: false,
            error: null,
        }
    }

    static getDerivedStateFromError(error: Error): PluginSurfaceState {
        return {
            hasError: true,
            error,
        }
    }

    override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        const { pluginId, contributionId, onError } = this.props
        onError?.({
            pluginId,
            contributionId,
            error,
            componentStack: errorInfo.componentStack,
        })
    }

    override render(): ReactNode {
        const { hasError, error } = this.state
        const { children, fallback, pluginId, contributionId, className } = this.props

        if (!hasError || !error) {
            return children
        }

        const errorInfo: PluginSurfaceErrorInfo = {
            pluginId,
            contributionId,
            error,
        }

        if (typeof fallback === 'function') {
            return fallback(error, errorInfo)
        }

        if (fallback !== undefined) {
            return fallback
        }

        return (
            <div
                role="alert"
                className={
                    className ??
                    'flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-3 text-xs text-[var(--text-secondary)]'
                }
            >
                <div className="font-medium text-[var(--text-primary)]">
                    Plugin Surface Error ({pluginId}{contributionId ? ` - ${contributionId}` : ''})
                </div>
                <div className="font-mono text-[var(--text-muted)] truncate">
                    {error.message || 'An unexpected error occurred while rendering this plugin view.'}
                </div>
            </div>
        )
    }
}
