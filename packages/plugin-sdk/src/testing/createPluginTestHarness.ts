import type {
    CapabilityId,
    ContributionKind,
    ContributionRegistration,
    PluginContext,
    PluginEntryDefinition,
    PluginEventBus,
    PluginManifest,
} from '@cpa/plugin-api'

export interface PluginTestHarnessOptions {
    manifest?: Partial<PluginManifest>
    capabilities?: Iterable<CapabilityId>
    services?: Record<string, unknown>
    generation?: number
}

export interface PluginTestHarness {
    readonly context: PluginContext
    readonly plugin: PluginEntryDefinition
    readonly registrations: ContributionRegistration<unknown>[]
    readonly services: Map<string, unknown>
    readonly events: PluginEventBus
    activate(): Promise<void>
    deactivate(): Promise<void>
    getRegistered<T = unknown>(kind?: ContributionKind, id?: string): ContributionRegistration<T>[]
    getService<T>(serviceId: string): T
    registerService<T>(serviceId: string, service: T): void
}

export function createPluginTestHarness(
    plugin: PluginEntryDefinition,
    options: PluginTestHarnessOptions = {},
): PluginTestHarness {
    const registrations: ContributionRegistration<unknown>[] = []
    const services = new Map<string, unknown>(Object.entries(options.services ?? {}))
    const eventListeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>()

    const events: PluginEventBus = {
        async emit<T>(eventName: string, payload: T): Promise<void> {
            const listeners = eventListeners.get(eventName)
            if (listeners) {
                for (const listener of Array.from(listeners)) {
                    await listener(payload)
                }
            }
        },
        on<T>(eventName: string, listener: (payload: T) => void | Promise<void>): () => void {
            let set = eventListeners.get(eventName)
            if (!set) {
                set = new Set()
                eventListeners.set(eventName, set)
            }
            const castListener = listener as (payload: unknown) => void | Promise<void>
            set.add(castListener)
            return () => {
                set?.delete(castListener)
                if (set?.size === 0) {
                    eventListeners.delete(eventName)
                }
            }
        },
    }

    const manifest: PluginManifest = {
        id: 'test.plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        apiVersion: '1.0.0',
        engines: { cpa: '^1.0.0' },
        entries: { [plugin.runtime]: './index.ts' },
        dependencies: {},
        capabilities: [],
        contributes: {},
        ...(options.manifest ?? {}),
    }

    const capabilities = new Set<CapabilityId>(options.capabilities ?? manifest.capabilities ?? [])

    const context: PluginContext = {
        manifest,
        generation: options.generation ?? 1,
        capabilities,
        events,
        register<T>(registration: ContributionRegistration<T>): () => void {
            const reg = registration as ContributionRegistration<unknown>
            registrations.push(reg)
            return () => {
                const index = registrations.indexOf(reg)
                if (index >= 0) {
                    registrations.splice(index, 1)
                }
            }
        },
        getService<T>(serviceOrToken: any): T {
            const serviceId = typeof serviceOrToken === 'string' ? serviceOrToken : (serviceOrToken?.id ?? String(serviceOrToken))
            if (!services.has(serviceId)) {
                throw new Error(`Service "${serviceId}" not found in plugin test harness context`)
            }
            return services.get(serviceId) as T
        },
    }

    return {
        context,
        plugin,
        registrations,
        services,
        events,
        async activate(): Promise<void> {
            await plugin.activate(context)
        },
        async deactivate(): Promise<void> {
            if (typeof plugin.deactivate === 'function') {
                await plugin.deactivate(context)
            }
            registrations.length = 0
        },
        getRegistered<T = unknown>(kind?: ContributionKind, id?: string): ContributionRegistration<T>[] {
            return registrations.filter((r) => {
                if (kind && r.kind !== kind) return false
                if (id && r.id !== id) return false
                return true
            }) as ContributionRegistration<T>[]
        },
        getService<T>(serviceId: string): T {
            return context.getService<T>(serviceId)
        },
        registerService<T>(serviceId: string, service: T): void {
            services.set(serviceId, service)
        },
    }
}
