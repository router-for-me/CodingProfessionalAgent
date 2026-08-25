import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, RpcDescriptor, ServiceDescriptor } from '@cpa/plugin-api'
import { KVStoreService, type KVStoreServiceOptions } from './kvStoreService.js'

export { KVStoreService, type KVStoreServiceOptions }

export const settingsMainEntry = definePluginEntry({
    runtime: 'main',
    activate(context: PluginContext) {
        const emitEvent = (event: any, rpcCtx?: any) => {
            if (typeof rpcCtx?.emitEvent === 'function') {
                rpcCtx.emitEvent(event)
            } else if (typeof rpcCtx?.emitNativeEvent === 'function') {
                rpcCtx.emitNativeEvent(event)
            } else if (typeof (context as any)?.emitEvent === 'function') {
                (context as any).emitEvent(event)
            }
            void context.events?.emit?.(event.kind, event)
        }

        const options = (context as any).options as (string | KVStoreServiceOptions) | undefined
        const kvStoreService = new KVStoreService(options)

        // 1. Register KVStore Service
        context.register<ServiceDescriptor<KVStoreService>>({
            kind: 'service',
            id: 'kvStoreService',
            value: {
                id: 'kvStoreService',
                dependencies: [],
                create: () => kvStoreService,
                dispose: (service) => {
                    service.dispose()
                },
            },
        })

        // 2. Register RPC Descriptors
        const rpcList: RpcDescriptor[] = [
            {
                method: 'kvstore:get',
                aliases: ['KVStoreGet'],
                ipcChannel: 'kvstore:get',
                capability: 'storage.kv',
                invoke: async (_ctx, args) => kvStoreService.get(args[0] as string),
            },
            {
                method: 'kvstore:set',
                aliases: ['KVStoreSet'],
                ipcChannel: 'kvstore:set',
                capability: 'storage.kv',
                invoke: async (rpcCtx, args) => {
                    const key = args[0] as string
                    const value = args[1]
                    const result = await kvStoreService.set(key, value)
                    if (key === 'projects') {
                        emitEvent(
                            {
                                operationId: `projects-${Date.now()}`,
                                sequence: Date.now(),
                                kind: 'projects:updated',
                                data: JSON.stringify(value),
                            },
                            rpcCtx,
                        )
                    }
                    return result
                },
            },
            {
                method: 'kvstore:save',
                aliases: ['KVStoreSave'],
                ipcChannel: 'kvstore:save',
                capability: 'storage.kv',
                invoke: async () => kvStoreService.save(),
            },
        ]

        for (const descriptor of rpcList) {
            context.register<RpcDescriptor>({
                kind: 'rpc',
                id: descriptor.method,
                value: descriptor,
            })
        }
    },
})

export const entry = settingsMainEntry
export default settingsMainEntry
