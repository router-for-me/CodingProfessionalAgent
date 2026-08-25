import React, { type ComponentType } from 'react'
import { SlotErrorBoundary } from '../registry/SlotErrorBoundary'
import {
    bindRuntimeHost,
    reportSurfaceError,
    type PluginErrorSink,
} from './pluginErrorReporter'

export {
    bindRuntimeHost,
    reportSurfaceError,
    type PluginErrorSink,
}

/**
 * Safely evaluates a plugin's `visible` callback. If the callback throws an error,
 * the exception is caught, logged, written back to the runtime summary, and returns `false`.
 */
export function safePluginVisible(
    visibleFn?: (context: Record<string, unknown>) => boolean,
    context: Record<string, unknown> = {},
    pluginId?: string,
    fallback = true
): boolean {
    if (typeof visibleFn !== 'function') {
        return fallback
    }

    try {
        return Boolean(visibleFn(context))
    } catch (err) {
        console.error(
            `[safePluginSurface] visible() callback failed for plugin "${pluginId ?? 'unknown'}":`,
            err
        )
        reportSurfaceError(pluginId, err)
        return false
    }
}

/**
 * Safely evaluates a plugin panel's `isEnabled` callback. If the callback throws an error,
 * the exception is caught, logged, written back to the runtime summary, and returns `false`.
 */
export function safePluginEnabled(
    enabledFn?: (context: any) => boolean,
    context: any = {},
    pluginId?: string,
    fallback = true
): boolean {
    if (typeof enabledFn !== 'function') {
        return fallback
    }

    try {
        return Boolean(enabledFn(context))
    } catch (err) {
        console.error(
            `[safePluginSurface] isEnabled() callback failed for plugin "${pluginId ?? 'unknown'}":`,
            err
        )
        reportSurfaceError(pluginId, err)
        return false
    }
}

/**
 * Safely evaluates a plugin panel's `getDynamicTitle` callback. If the callback throws an error,
 * the exception is caught, logged, written back to the runtime summary, and returns `null`.
 */
export function safePluginDynamicTitle(
    titleFn?: (params: Record<string, unknown>, context: Record<string, unknown>) => string | null,
    params: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
    pluginId?: string
): string | null {
    if (typeof titleFn !== 'function') {
        return null
    }

    try {
        return titleFn(params, context)
    } catch (err) {
        console.error(
            `[safePluginSurface] getDynamicTitle() failed for plugin "${pluginId ?? 'unknown'}":`,
            err
        )
        reportSurfaceError(pluginId, err)
        return null
    }
}

/**
 * Safely evaluates a plugin panel's `getDynamicIcon` callback. If the callback throws an error,
 * the exception is caught, logged, written back to the runtime summary, and returns `null`.
 */
export function safePluginDynamicIcon(
    iconFn?: (params: Record<string, unknown>, context: Record<string, unknown>) => ComponentType<any> | null,
    params: Record<string, unknown> = {},
    context: Record<string, unknown> = {},
    pluginId?: string
): ComponentType<any> | null {
    if (typeof iconFn !== 'function') {
        return null
    }

    try {
        return iconFn(params, context)
    } catch (err) {
        console.error(
            `[safePluginSurface] getDynamicIcon() failed for plugin "${pluginId ?? 'unknown'}":`,
            err
        )
        reportSurfaceError(pluginId, err)
        return null
    }
}

export interface SafePluginSurfaceProps {
    id: string
    pluginId?: string
    fallback?: React.ReactNode
    children: React.ReactNode
}

/**
 * React boundary component that wraps plugin contribution renders and reports errors back to runtime.
 */
export function SafePluginSurface({
    id,
    pluginId,
    fallback,
    children,
}: SafePluginSurfaceProps): React.ReactNode {
    return (
        <SlotErrorBoundary
            id={id}
            pluginId={pluginId}
            fallback={fallback}
        >
            {children}
        </SlotErrorBoundary>
    )
}
