import {
    useMemo,
    useCallback,
    useSyncExternalStore,
    type ComponentType,
    createElement,
} from 'react'
import { useRendererContributions } from './HostServicesContext.js'

export interface ComponentWrapperItem<P extends object = Record<string, unknown>> {
    id: string
    pluginId: string
    targetComponent: string
    order?: number
    wrapper: (Base: ComponentType<P>) => ComponentType<P>
}

export interface CreateExtensibleComponentOptions<P extends object = Record<string, unknown>> {
    getWrappers?: (name: string) => ComponentWrapperItem<P>[]
    subscribe?: (name: string, callback: () => void) => () => void
}

const EMPTY_WRAPPERS: readonly ComponentWrapperItem<any>[] = Object.freeze([])
const wrappersCache = new Map<string, readonly ComponentWrapperItem<any>[]>()

function areWrappersEqual(
    a: readonly ComponentWrapperItem<any>[],
    b: readonly ComponentWrapperItem<any>[],
): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (
            a[i]?.id !== b[i]?.id ||
            a[i]?.pluginId !== b[i]?.pluginId ||
            a[i]?.targetComponent !== b[i]?.targetComponent ||
            a[i]?.order !== b[i]?.order
        ) {
            return false
        }
    }
    return true
}

/**
 * Higher-order component that composes dynamically registered component wrappers.
 */
export function createExtensibleComponent<P extends object = Record<string, unknown>>(
    componentName: string,
    BaseComponent: ComponentType<P>,
    options: CreateExtensibleComponentOptions<P> = {},
): ComponentType<P> {
    function ExtensibleComponent(props: P) {
        const contribService = useRendererContributions()

        const getWrappers = useCallback((): readonly ComponentWrapperItem<P>[] => {
            let raw: readonly ComponentWrapperItem<P>[] = EMPTY_WRAPPERS
            if (options.getWrappers) {
                raw = options.getWrappers(componentName) as ComponentWrapperItem<P>[]
            } else if (contribService?.getComponentWrappers) {
                raw = contribService.getComponentWrappers(componentName) as ComponentWrapperItem<P>[]
            }
            if (!raw || raw.length === 0) {
                return EMPTY_WRAPPERS
            }
            const cached = wrappersCache.get(componentName)
            if (cached && areWrappersEqual(cached, raw)) {
                return cached as readonly ComponentWrapperItem<P>[]
            }
            const frozen = Object.freeze([...raw])
            wrappersCache.set(componentName, frozen)
            return frozen
        }, [contribService, componentName])

        const subscribe = useCallback((listener: () => void) => {
            if (options.subscribe) return options.subscribe(componentName, listener)
            if (contribService?.subscribeComponentWrappers) {
                return contribService.subscribeComponentWrappers(componentName, listener)
            }
            return () => {}
        }, [contribService])

        const wrappers = useSyncExternalStore(subscribe, getWrappers, getWrappers)

        const EffectiveComponent = useMemo(() => {
            return wrappers.reduce<ComponentType<P>>((Acc, w) => {
                try {
                    return w.wrapper(Acc)
                } catch (err) {
                    console.error(
                        `[createExtensibleComponent] Wrapper "${w.id}" failed to compose:`,
                        err,
                    )
                    return Acc
                }
            }, BaseComponent)
        }, [wrappers, BaseComponent])

        return createElement(EffectiveComponent, props)
    }

    ExtensibleComponent.displayName = `Extensible(${componentName})`
    return ExtensibleComponent
}
