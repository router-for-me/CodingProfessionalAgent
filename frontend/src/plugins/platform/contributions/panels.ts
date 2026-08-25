import { useCallback, useSyncExternalStore } from 'react'
import type {
    PanelCloseContext,
    PanelContext,
    PanelContribution,
    PanelOpenContext,
} from '@cpa/plugin-api'
import { getHostServices } from '@/application/services/createHostServices'
import { rendererRegistry, RendererRegistry } from '../rendererRegistry'

export type {
    PanelCloseContext,
    PanelContext,
    PanelContribution,
    PanelOpenContext,
}

/**
 * Creates standard PanelContext containing HostServices and active session ID.
 */
export function createPanelContext(activeSessionId?: string): PanelContext {
    return {
        services: getHostServices(),
        activeSessionId,
    }
}

/**
 * Creates standard PanelOpenContext for panel lifecycle activation.
 */
export function createPanelOpenContext(
    instanceId: string,
    activeSessionId?: string,
    params?: Record<string, unknown>
): PanelOpenContext {
    return {
        ...createPanelContext(activeSessionId),
        instanceId,
        params,
    }
}

/**
 * Creates standard PanelCloseContext for panel lifecycle teardown.
 */
export function createPanelCloseContext(
    instanceId: string,
    activeSessionId?: string,
    params?: Record<string, unknown>
): PanelCloseContext {
    return {
        ...createPanelContext(activeSessionId),
        instanceId,
        params,
    }
}

/**
 * Returns all registered panels sorted by order ascending from RendererRegistry.
 */
export function selectPanels(
    registry: RendererRegistry = rendererRegistry
): readonly PanelContribution[] {
    return registry.getPanels()
}

/**
 * Finds a specific panel by ID in the RendererRegistry.
 */
export function selectPanel(
    panelId: string,
    registry: RendererRegistry = rendererRegistry
): PanelContribution | undefined {
    return registry.getPanel(panelId)
}

/**
 * React hook subscribing to all registered panels.
 */
export function usePanels(
    registry: RendererRegistry = rendererRegistry
): readonly PanelContribution[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('panel', listener),
        [registry]
    )

    const getSnapshot = useCallback(
        () => registry.getPanels(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * React hook subscribing to a single registered panel.
 */
export function usePanel(
    panelId: string,
    registry: RendererRegistry = rendererRegistry
): PanelContribution | undefined {
    const panels = usePanels(registry)
    return panels.find((panel) => panel.id === panelId)
}
