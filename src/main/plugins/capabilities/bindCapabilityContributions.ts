import type { CapabilityEventContribution, RpcDescriptor } from '@cpa/plugin-api'
import type { ContributionRegistry, PluginEventBus } from '@cpa/plugin-kernel'
import type { MainCapabilityBroker } from './MainCapabilityBroker.js'

// Committed contributions, not plugin identities, define the transport surface.
export function bindCapabilityContributions(registry: ContributionRegistry, events: PluginEventBus, broker: MainCapabilityBroker): () => void {
    let rpcDisposers: Array<() => void> = []
    let eventDisposers: Array<() => void> = []
    const bindRpcs = () => {
        for (const dispose of rpcDisposers.splice(0)) dispose()
        for (const item of registry.list<RpcDescriptor>('rpc')) {
            const descriptor = item.value
            if (descriptor.method !== item.id) throw new Error('RPC method must match its declared contribution id')
            for (const method of new Set([descriptor.method, ...descriptor.aliases ?? []])) {
                rpcDisposers.push(broker.register({
                    method, capability: descriptor.capability,
                    validate(args: unknown[]): asserts args is unknown[] {
                        if (!Array.isArray(args)) throw new Error('RPC arguments must be an array')
                    },
                    invoke: (context, ...args) => descriptor.invoke(context, args),
                }))
            }
        }
    }
    const bindEvents = () => {
        for (const dispose of eventDisposers.splice(0)) dispose()
        for (const item of registry.list<CapabilityEventContribution>('native-event')) {
            if (item.value.event !== item.id) throw new Error('Capability event must match its declared contribution id')
            eventDisposers.push(broker.registerEvent(item.value.event, item.value.capability))
            eventDisposers.push(events.on(item.value.event, (payload) => broker.emit(item.value.event, payload, item.owner.id)))
        }
    }
    const unsubscribeRpc = registry.subscribe('rpc', bindRpcs)
    const unsubscribeEvents = registry.subscribe('native-event', bindEvents)
    bindRpcs()
    bindEvents()
    return () => {
        unsubscribeRpc()
        unsubscribeEvents()
        for (const dispose of [...rpcDisposers, ...eventDisposers]) dispose()
    }
}
