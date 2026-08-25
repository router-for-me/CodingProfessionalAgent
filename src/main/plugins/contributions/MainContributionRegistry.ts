import type {
    CapabilityId,
    RpcDescriptor,
    RpcInvocationContext,
    ServiceCreateContext,
    ServiceDescriptor,
    WebRouteContribution,
} from '@cpa/plugin-api'
import type { ContributionRegistry } from '@cpa/plugin-kernel'
import type { MainCapabilityBroker } from '../capabilities/MainCapabilityBroker.js'
import { WebRouteRegistry } from '../../services/web/routeRegistry.js'

export type {
    RpcDescriptor,
    RpcInvocationContext,
    ServiceCreateContext,
    ServiceDescriptor,
    WebRouteContribution,
}

export interface MainContributionRegistryOptions {
    contributionRegistry?: ContributionRegistry
    capabilityBroker?: MainCapabilityBroker
    capabilities?: ReadonlySet<CapabilityId>
}

/**
 * MainContributionRegistry manages the unified lifecycle of Main services,
 * RPC descriptors (with IPC bindings and aliases), and reverse topological disposal.
 */
export class MainContributionRegistry {
    private readonly serviceDescriptors = new Map<string, ServiceDescriptor<any>>()
    private readonly serviceInstances = new Map<string, any>()
    private readonly createdOrder: string[] = []
    private readonly rpcDescriptors = new Map<string, RpcDescriptor>()
    private readonly rpcLookup = new Map<string, RpcDescriptor>()
    private readonly routeRegistry = new WebRouteRegistry()
    private readonly contributionRegistry?: ContributionRegistry
    readonly capabilityBroker?: MainCapabilityBroker
    private readonly capabilities: ReadonlySet<CapabilityId>
    private disposed = false

    constructor(options?: MainContributionRegistryOptions) {
        this.contributionRegistry = options?.contributionRegistry
        this.capabilityBroker = options?.capabilityBroker
        this.capabilities = options?.capabilities ?? new Set<CapabilityId>()

        if (this.contributionRegistry) {
            this.contributionRegistry.subscribe('service', () => {
                // Invalidate cached plugin-contributed service instances on generation changes
                for (const serviceId of Array.from(this.serviceInstances.keys())) {
                    if (!this.serviceDescriptors.has(serviceId)) {
                        this.serviceInstances.delete(serviceId)
                        const idx = this.createdOrder.indexOf(serviceId)
                        if (idx !== -1) {
                            this.createdOrder.splice(idx, 1)
                        }
                    }
                }
            })
        }
    }

    /**
     * Register an RPC method descriptor with optional aliases and IPC channel binding.
     * Returns an unregister disposer function.
     */
    registerRpc(descriptor: RpcDescriptor): () => void {
        if (!descriptor || typeof descriptor.method !== 'string' || !descriptor.method.trim()) {
            throw new Error('Invalid RPC descriptor: method is required')
        }
        if (typeof descriptor.invoke !== 'function') {
            throw new Error(`Invalid RPC descriptor for "${descriptor.method}": invoke must be a function`)
        }

        this.rpcDescriptors.set(descriptor.method, descriptor)
        this.rpcLookup.set(descriptor.method, descriptor)

        if (descriptor.aliases) {
            for (const alias of descriptor.aliases) {
                if (alias && typeof alias === 'string') {
                    this.rpcLookup.set(alias, descriptor)
                }
            }
        }

        if (descriptor.ipcChannel && typeof descriptor.ipcChannel === 'string') {
            this.rpcLookup.set(descriptor.ipcChannel, descriptor)
        }

        return () => {
            if (this.rpcDescriptors.get(descriptor.method) === descriptor) {
                this.rpcDescriptors.delete(descriptor.method)
            }
            if (this.rpcLookup.get(descriptor.method) === descriptor) {
                this.rpcLookup.delete(descriptor.method)
            }
            if (descriptor.aliases) {
                for (const alias of descriptor.aliases) {
                    if (this.rpcLookup.get(alias) === descriptor) {
                        this.rpcLookup.delete(alias)
                    }
                }
            }
            if (descriptor.ipcChannel && this.rpcLookup.get(descriptor.ipcChannel) === descriptor) {
                this.rpcLookup.delete(descriptor.ipcChannel)
            }
        }
    }

    /**
     * Get all registered RPC descriptors.
     */
    getRpcDescriptors(): readonly RpcDescriptor[] {
        const combined = new Map<string, RpcDescriptor>()
        for (const desc of this.rpcDescriptors.values()) {
            combined.set(desc.method, desc)
        }
        if (this.contributionRegistry) {
            const kernelRpcs = this.contributionRegistry.list<RpcDescriptor>('rpc')
            for (const item of kernelRpcs) {
                if (item.value) {
                    combined.set(item.value.method || item.id, item.value)
                }
            }
        }
        return Object.freeze(Array.from(combined.values()))
    }

    /**
     * Register a Web route contribution.
     * Returns an unregister disposer function.
     */
    registerRoute(route: WebRouteContribution): () => void {
        return this.routeRegistry.register(route)
    }

    /**
     * Get all registered route contributions in deterministic order.
     */
    getRoutes(): readonly WebRouteContribution[] {
        if (!this.contributionRegistry) {
            return this.routeRegistry.list()
        }
        const kernelRoutes = this.contributionRegistry.list<WebRouteContribution>('route')
        if (kernelRoutes.length === 0) {
            return this.routeRegistry.list()
        }
        const combined = new Map<string, WebRouteContribution>()
        for (const r of this.routeRegistry.list()) {
            combined.set(r.id, r)
        }
        for (const item of kernelRoutes) {
            if (item.value) {
                combined.set(item.id, item.value)
            }
        }
        const list = Array.from(combined.values())
        list.sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order
            }
            return a.id.localeCompare(b.id)
        })
        return Object.freeze(list)
    }

    /**
     * Get the route registry instance.
     */
    getRouteRegistry(): WebRouteRegistry {
        return this.routeRegistry
    }

    /**
     * Register a service descriptor with explicit dependencies.
     * Returns an unregister disposer function.
     */
    registerService<T>(descriptor: ServiceDescriptor<T>): () => void {
        if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
            throw new Error('Invalid service descriptor: id is required')
        }
        if (typeof descriptor.create !== 'function') {
            throw new Error(`Invalid service descriptor for "${descriptor.id}": create must be a function`)
        }

        this.serviceDescriptors.set(descriptor.id, descriptor)

        return () => {
            if (this.serviceDescriptors.get(descriptor.id) === descriptor) {
                this.serviceDescriptors.delete(descriptor.id)
            }
        }
    }

    /**
     * Get all registered service descriptors.
     */
    getServiceDescriptors(): readonly ServiceDescriptor[] {
        return Object.freeze(Array.from(this.serviceDescriptors.values()))
    }

    /**
     * Check if a service is registered and created, or available in contribution registry.
     */
    hasService(serviceId: string): boolean {
        if (this.serviceInstances.has(serviceId)) {
            return true
        }
        if (this.contributionRegistry?.get('service', serviceId) !== undefined) {
            return true
        }
        return false
    }

    /**
     * Retrieve an instantiated service by ID.
     */
    getService<T>(serviceId: string): T {
        if (this.serviceInstances.has(serviceId)) {
            return this.serviceInstances.get(serviceId) as T
        }
        const fromContrib = this.contributionRegistry?.get<any>('service', serviceId)
        if (fromContrib !== undefined) {
            if (fromContrib && typeof fromContrib.create === 'function') {
                const context: ServiceCreateContext = {
                    get: <S>(id: string): S => this.getService<S>(id),
                    capabilities: this.capabilities,
                    getCapability: <S>(id: CapabilityId): S => this.getCapability<S>(id),
                }
                const instance = fromContrib.create(context)
                this.serviceInstances.set(serviceId, instance)
                this.createdOrder.push(serviceId)
                return instance as T
            }
            return fromContrib as T
        }
        throw new Error(`Service "${serviceId}" not found`)
    }

    /**
     * Get capability provider if capability broker is attached.
     */
    getCapability<T>(capabilityId: CapabilityId): T {
        if (!this.capabilityBroker) {
            throw new Error(`Capability broker not configured; cannot resolve capability "${capabilityId}"`)
        }
        return (this.capabilityBroker as any).getCapability?.(capabilityId) as T
    }

    /**
     * Topologically resolve dependencies and instantiate all registered services in order.
     */
    async createServices(): Promise<void> {
        this.disposed = false

        const graph = this.resolveServiceTopologicalOrder()
        const context: ServiceCreateContext = {
            get: <T>(serviceId: string): T => this.getService<T>(serviceId),
            capabilities: this.capabilities,
            getCapability: <T>(capabilityId: CapabilityId): T => this.getCapability<T>(capabilityId),
        }

        for (const serviceId of graph) {
            if (this.serviceInstances.has(serviceId)) {
                continue
            }
            const descriptor = this.serviceDescriptors.get(serviceId)
            if (!descriptor) {
                continue
            }

            const instance = await descriptor.create(context)
            this.serviceInstances.set(serviceId, instance)
            this.createdOrder.push(serviceId)
        }
    }

    /**
     * Synchronously instantiate registered services if all factory create methods are synchronous.
     */
    createServicesSync(): void {
        this.disposed = false

        const graph = this.resolveServiceTopologicalOrder()
        const context: ServiceCreateContext = {
            get: <T>(serviceId: string): T => this.getService<T>(serviceId),
            capabilities: this.capabilities,
            getCapability: <T>(capabilityId: CapabilityId): T => this.getCapability<T>(capabilityId),
        }

        for (const serviceId of graph) {
            if (this.serviceInstances.has(serviceId)) {
                continue
            }
            const descriptor = this.serviceDescriptors.get(serviceId)
            if (!descriptor) {
                continue
            }

            const instance = descriptor.create(context)
            if (instance instanceof Promise) {
                throw new Error(
                    `Service "${serviceId}" returned a Promise in synchronous creation mode; use createServices() instead`,
                )
            }
            this.serviceInstances.set(serviceId, instance)
            this.createdOrder.push(serviceId)
        }
    }

    /**
     * Dispatch an RPC method call through registered RPC descriptors.
     */
    async dispatchRpc(
        method: string,
        args: unknown[] = [],
        context?: RpcInvocationContext,
    ): Promise<unknown> {
        let descriptor = this.rpcLookup.get(method)
        if (!descriptor && this.contributionRegistry) {
            const kernelRpcs = this.contributionRegistry.list<RpcDescriptor>('rpc')
            for (const item of kernelRpcs) {
                const desc = item.value
                if (desc) {
                    if (desc.method === method || desc.ipcChannel === method || desc.aliases?.includes(method)) {
                        descriptor = desc
                        break
                    }
                }
            }
        }
        if (!descriptor) {
            throw new Error(`Unknown RPC method "${method}"`)
        }

        const invocationContext: RpcInvocationContext = {
            pluginId: context?.pluginId ?? 'desktop-main',
            senderId: context?.senderId ?? 0,
            frameUrl: context?.frameUrl ?? '',
            transport: context?.transport ?? 'electron',
            clientId: context?.clientId ?? 'desktop-main',
            ...context,
        }

        return await descriptor.invoke(invocationContext, args)
    }

    /**
     * Dispose all created services in reverse dependency order.
     * This operation is idempotent: subsequent calls do nothing.
     */
    async disposeAll(): Promise<void> {
        if (this.disposed) {
            return
        }
        this.disposed = true

        const reverseOrder = [...this.createdOrder].reverse()
        this.createdOrder.length = 0

        for (const serviceId of reverseOrder) {
            const instance = this.serviceInstances.get(serviceId)
            const descriptor = this.serviceDescriptors.get(serviceId)

            if (descriptor && typeof descriptor.dispose === 'function' && instance !== undefined) {
                try {
                    await descriptor.dispose(instance)
                } catch (err) {
                    console.error(`Error disposing service "${serviceId}":`, err)
                }
            }

            this.serviceInstances.delete(serviceId)
        }
    }

    private resolveServiceTopologicalOrder(): string[] {
        const nodeIds = Array.from(this.serviceDescriptors.keys())
        const inDegree = new Map<string, number>()
        const dependents = new Map<string, Set<string>>()

        for (const id of nodeIds) {
            inDegree.set(id, 0)
            dependents.set(id, new Set())
        }

        for (const [id, descriptor] of this.serviceDescriptors) {
            for (const depId of descriptor.dependencies) {
                if (!this.serviceDescriptors.has(depId)) {
                    if (this.serviceInstances.has(depId) || this.contributionRegistry?.get('service', depId) !== undefined) {
                        continue
                    }
                    throw new Error(`Missing dependency "${depId}" required by service "${id}"`)
                }
                dependents.get(depId)!.add(id)
                inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
            }
        }

        const queue: string[] = []
        for (const id of nodeIds) {
            if (inDegree.get(id) === 0) {
                queue.push(id)
            }
        }

        const resolvedOrder: string[] = []
        while (queue.length > 0) {
            queue.sort()
            const current = queue.shift()!
            resolvedOrder.push(current)

            for (const dependentId of dependents.get(current) ?? []) {
                const updated = inDegree.get(dependentId)! - 1
                inDegree.set(dependentId, updated)
                if (updated === 0) {
                    queue.push(dependentId)
                }
            }
        }

        if (resolvedOrder.length < nodeIds.length) {
            const cycleNodes = nodeIds.filter((id) => !resolvedOrder.includes(id))
            throw new Error(`Circular service dependency detected involving: ${cycleNodes.join(', ')}`)
        }

        return resolvedOrder
    }
}
