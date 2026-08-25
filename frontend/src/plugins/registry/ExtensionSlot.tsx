import React from 'react'
import type { RendererRegistry } from '../platform/rendererRegistry'
import { rendererRegistry } from '../platform/rendererRegistry'
import { safePluginVisible } from '../platform/safePluginSurface'
import { SlotErrorBoundary } from './SlotErrorBoundary'
import { useSlotContributions } from './useSlotContributions'

export interface ExtensionSlotProps<T = Record<string, unknown>> {
    name: string
    props?: T
    renderWrapper?: (items: React.ReactNode[]) => React.ReactNode
    fallback?: React.ReactNode
    className?: string
    registry?: RendererRegistry
}

/**
 * Universal slot component that dynamically renders registered plugin contributions with error boundaries.
 */
export function ExtensionSlot<T = Record<string, unknown>>({
    name,
    props,
    renderWrapper,
    fallback,
    className,
    registry = rendererRegistry,
}: ExtensionSlotProps<T>): React.ReactNode {
    const contributions = useSlotContributions<T>(name, registry)

    const visibleContributions = contributions.filter((item) => {
        return safePluginVisible(
            item.visible,
            (props ?? {}) as Record<string, unknown>,
            item.pluginId,
            true
        )
    })

    if (visibleContributions.length === 0) {
        return fallback ?? null
    }

    const renderedItems = visibleContributions.map((item) => {
        const Component = item.component
        const key = `${item.pluginId}:${item.id}`
        return (
            <SlotErrorBoundary key={key} id={item.id} pluginId={item.pluginId}>
                <Component {...((props ?? {}) as React.JSX.IntrinsicAttributes & T)} />
            </SlotErrorBoundary>
        )
    })

    if (renderWrapper) {
        return renderWrapper(renderedItems)
    }

    if (className) {
        return <div className={className}>{renderedItems}</div>
    }

    return <>{renderedItems}</>
}
