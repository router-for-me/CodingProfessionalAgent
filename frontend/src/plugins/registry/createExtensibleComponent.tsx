import { useMemo, useCallback, useSyncExternalStore, type ComponentType } from 'react'
import { rendererRegistry, RendererRegistry } from '../platform/rendererRegistry'
import { reportSurfaceError } from '../platform/safePluginSurface'
import { SlotErrorBoundary } from './SlotErrorBoundary'

export interface ExtensibleComponentOptions {
    registry?: RendererRegistry
}

/**
 * Higher-order component factory that wraps a base component with dynamic extension wrappers.
 */
export function createExtensibleComponent<P extends object = Record<string, unknown>>(
    componentName: string,
    BaseComponent: ComponentType<P>,
    options: ExtensibleComponentOptions = {}
): ComponentType<P> {
    const registry = options.registry ?? rendererRegistry

    function ExtensibleComponent(props: P) {
        const subscribe = useCallback(
            (listener: () => void) =>
                registry.subscribe(`componentWrapper:${componentName}`, listener),
            [registry, componentName]
        )
        const getSnapshot = useCallback(
            () => registry.getComponentWrappers<P>(componentName),
            [registry, componentName]
        )
        const wrappers = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

        const EffectiveComponent = useMemo(() => {
            return wrappers.reduce<ComponentType<P>>((Acc, w) => {
                let Wrapped: ComponentType<P>
                try {
                    Wrapped = w.wrapper(Acc)
                } catch (err) {
                    console.error(
                        `[createExtensibleComponent] Wrapper "${w.id}" failed to compose:`,
                        err
                    )
                    reportSurfaceError(w.pluginId, err)
                    return Acc
                }

                function GuardedWrapped(props: P) {
                    return (
                        <SlotErrorBoundary
                            id={`wrapper-${w.id}`}
                            pluginId={w.pluginId}
                            fallback={<Acc {...props} />}
                        >
                            <Wrapped {...props} />
                        </SlotErrorBoundary>
                    )
                }

                GuardedWrapped.displayName = `Guarded(${componentName}:${w.id})`

                return GuardedWrapped
            }, BaseComponent)
        }, [wrappers, BaseComponent, componentName])

        return <EffectiveComponent {...props} />
    }

    ExtensibleComponent.displayName = `Extensible(${componentName})`

    return ExtensibleComponent
}
