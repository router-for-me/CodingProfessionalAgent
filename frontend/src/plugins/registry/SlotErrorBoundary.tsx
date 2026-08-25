import React from 'react'
import { reportSurfaceError } from '../platform/pluginErrorReporter'

export interface SlotErrorBoundaryProps {
    id?: string
    pluginId?: string
    contributionId?: string
    children?: React.ReactNode
    fallback?: React.ReactNode | ((error: Error, contributionId: string) => React.ReactNode)
}

interface SlotErrorBoundaryState {
    hasError: boolean
    error: Error | null
}

/**
 * Error boundary that isolates individual plugin slot contributions to prevent UI crashes.
 */
export class SlotErrorBoundary extends React.Component<
    SlotErrorBoundaryProps,
    SlotErrorBoundaryState
> {
    constructor(props: SlotErrorBoundaryProps) {
        super(props)
        this.state = {
            hasError: false,
            error: null,
        }
    }

    static getDerivedStateFromError(error: Error): SlotErrorBoundaryState {
        return {
            hasError: true,
            error,
        }
    }

    private getContributionId(): string {
        return this.props.id ?? this.props.contributionId ?? 'unknown'
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
        const id = this.getContributionId()
        const pluginInfo = this.props.pluginId ? ` (plugin: ${this.props.pluginId})` : ''
        console.error(
            `[SlotErrorBoundary] Error caught in contribution "${id}"${pluginInfo}:`,
            error,
            errorInfo
        )
        if (this.props.pluginId) {
            reportSurfaceError(this.props.pluginId, error)
        }
    }

    render(): React.ReactNode {
        const id = this.getContributionId()
        if (this.state.hasError) {
            if (typeof this.props.fallback === 'function') {
                return this.props.fallback(
                    this.state.error ?? new Error('Unknown error in slot contribution'),
                    id
                )
            }
            if (this.props.fallback !== undefined) {
                return this.props.fallback
            }
            return (
                <div
                    data-testid={`slot-error-${id}`}
                    className="flex items-center justify-between gap-2 p-1.5 text-xs text-red-500 bg-red-50/5 border border-red-500/20 rounded"
                >
                    <span>Plugin error ({id})</span>
                    <button
                        type="button"
                        onClick={() => this.setState({ hasError: false, error: null })}
                        className="px-1.5 py-0.5 text-[11px] font-medium text-red-400 hover:text-red-300 rounded bg-red-500/10 hover:bg-red-500/20 transition-colors"
                    >
                        Retry
                    </button>
                </div>
            )
        }

        return this.props.children ?? null
    }
}
