import React, { Component, type ReactNode } from 'react'

export interface ChatRendererErrorBoundaryProps {
    id: string
    pluginId?: string
    fallback?: ReactNode | ((error: Error) => ReactNode)
    children: ReactNode
}

export interface ChatRendererErrorBoundaryState {
    hasError: boolean
    error: Error | null
}

export class ChatRendererErrorBoundary extends Component<
    ChatRendererErrorBoundaryProps,
    ChatRendererErrorBoundaryState
> {
    constructor(props: ChatRendererErrorBoundaryProps) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error): ChatRendererErrorBoundaryState {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(
            `[ChatRenderer] Error rendering chat contribution "${this.props.id}" (plugin: ${this.props.pluginId ?? 'unknown'}):`,
            error,
            info,
        )
    }

    render() {
        if (this.state.hasError) {
            if (typeof this.props.fallback === 'function') {
                return this.props.fallback(this.state.error!)
            }
            return this.props.fallback ?? null
        }
        return this.props.children
    }
}
