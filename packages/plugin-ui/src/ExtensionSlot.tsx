import React, { useCallback, useSyncExternalStore, Component, type ReactNode } from 'react'
import { useRendererContributions } from './HostServicesContext.js'

export interface SlotContributionItem<T = Record<string, unknown>> {
    id: string
    pluginId?: string
    slotName?: string
    order?: number
    component: React.ComponentType<T>
    visible?: boolean | ((props: T) => boolean)
}

export interface ExtensionSlotProps<T = Record<string, unknown>> {
    name: string
    props?: T
    renderWrapper?: (items: ReactNode[]) => ReactNode
    fallback?: ReactNode
    className?: string
    registry?: any
}

class SlotErrorBoundary extends Component<
    { id: string; pluginId?: string; children: ReactNode },
    { hasError: boolean; error: Error | null }
> {
    constructor(props: { id: string; pluginId?: string; children: ReactNode }) {
        super(props)
        this.state = { hasError: false, error: null }
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error }
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error(
            `[ExtensionSlot] Error rendering slot item "${this.props.id}" (plugin: ${this.props.pluginId ?? 'unknown'}):`,
            error,
            info,
        )
    }

    render() {
        if (this.state.hasError) {
            return null
        }
        return this.props.children
    }
}

const EMPTY_SLOT_ITEMS: readonly SlotContributionItem<any>[] = Object.freeze([])
const slotItemsCache = new Map<string, readonly SlotContributionItem<any>[]>()

function areSlotItemsEqual(
    a: readonly SlotContributionItem<any>[],
    b: readonly SlotContributionItem<any>[],
): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (
            a[i]?.id !== b[i]?.id ||
            a[i]?.pluginId !== b[i]?.pluginId ||
            a[i]?.order !== b[i]?.order
        ) {
            return false
        }
    }
    return true
}

export function ExtensionSlot<T = Record<string, unknown>>({
    name,
    props,
    renderWrapper,
    fallback,
    className,
    registry: propRegistry,
}: ExtensionSlotProps<T>): ReactNode {
    const serviceRegistry = useRendererContributions()
    const registry = propRegistry ?? serviceRegistry

    const getItems = useCallback((): readonly SlotContributionItem<T>[] => {
        if (!registry?.getSlotContributions) {
            return EMPTY_SLOT_ITEMS
        }
        const raw = (registry.getSlotContributions(name) as SlotContributionItem<T>[]) ?? EMPTY_SLOT_ITEMS
        if (!raw || raw.length === 0) {
            return EMPTY_SLOT_ITEMS
        }
        const cached = slotItemsCache.get(name)
        if (cached && areSlotItemsEqual(cached, raw)) {
            return cached as readonly SlotContributionItem<T>[]
        }
        const frozen = Object.freeze([...raw])
        slotItemsCache.set(name, frozen)
        return frozen
    }, [registry, name])

    const subscribe = useCallback(
        (listener: () => void) => {
            if (registry?.subscribeSlot) {
                return registry.subscribeSlot(name, listener)
            }
            if (registry?.subscribe) {
                return registry.subscribe(`slot:${name}`, listener)
            }
            return () => {}
        },
        [registry, name],
    )

    const contributions = useSyncExternalStore(subscribe, getItems, () => EMPTY_SLOT_ITEMS)

    const visibleItems = contributions.filter((item) => {
        if (typeof item.visible === 'function') {
            try {
                return item.visible((props ?? {}) as T)
            } catch {
                return false
            }
        }
        if (typeof item.visible === 'boolean') {
            return item.visible
        }
        return true
    })

    if (visibleItems.length === 0) {
        return fallback ?? null
    }

    const renderedItems = visibleItems.map((item, index) => {
        const Component = item.component
        const key = `${item.pluginId ?? 'plugin'}:${item.id ?? index}`
        return (
            <SlotErrorBoundary key={key} id={item.id} pluginId={item.pluginId}>
                <Component {...((props ?? {}) as any)} />
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
