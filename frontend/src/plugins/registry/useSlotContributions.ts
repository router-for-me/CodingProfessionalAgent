import { useCallback, useSyncExternalStore } from 'react'
import type { SlotContribution } from '@cpa/plugin-api'
import { rendererRegistry, RendererRegistry } from '../platform/rendererRegistry'

/**
 * React hook that subscribes to slot contributions in RendererRegistry.
 */
export function useSlotContributions<P = Record<string, unknown>>(
    slotName: string,
    registry: RendererRegistry = rendererRegistry
): SlotContribution<P>[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe(slotName, listener),
        [registry, slotName]
    )
    const getSnapshot = useCallback(
        () => registry.getSlotContributions<P>(slotName),
        [registry, slotName]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
