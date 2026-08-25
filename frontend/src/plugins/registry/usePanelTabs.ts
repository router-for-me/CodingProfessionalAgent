import { useCallback, useSyncExternalStore } from 'react'
import type { PanelTabContribution } from '@cpa/plugin-api'
import { rendererRegistry, RendererRegistry } from '../platform/rendererRegistry'

/**
 * React hook that subscribes to panel tab contributions in RendererRegistry.
 */
export function usePanelTabs<P = Record<string, unknown>>(
    registry: RendererRegistry = rendererRegistry
): PanelTabContribution<P>[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('panelTabs', listener),
        [registry]
    )
    const getSnapshot = useCallback(
        () => registry.getPanelTabs<P>(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
