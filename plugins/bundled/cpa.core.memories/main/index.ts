import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, RpcDescriptor, ServiceDescriptor } from '@cpa/plugin-api'
import { MemoriesDatabaseService } from './memoriesDatabaseService.js'
import type { AddMemoryRequest, ReadMemoriesRequest, SearchMemoriesRequest } from '../shared/types.js'

export const memoriesMainEntry = definePluginEntry({
    runtime: 'main',
    activate(context: PluginContext) {
        const databaseService = new MemoriesDatabaseService()

        context.register<ServiceDescriptor<MemoriesDatabaseService>>({
            kind: 'service',
            id: 'memoriesDatabaseService',
            value: {
                id: 'memoriesDatabaseService',
                dependencies: [],
                create: () => databaseService,
                dispose: (service) => service.close(),
            },
        })

        const rpcList: RpcDescriptor[] = [
            {
                method: 'memories:search',
                ipcChannel: 'memories:search',
                capability: 'memories.read',
                invoke: async (_rpcCtx, args) => databaseService.search(args[0] as SearchMemoriesRequest),
            },
            {
                method: 'memories:read',
                ipcChannel: 'memories:read',
                capability: 'memories.read',
                invoke: async (_rpcCtx, args) => databaseService.read(args[0] as ReadMemoriesRequest),
            },
            {
                method: 'memories:add',
                ipcChannel: 'memories:add',
                capability: 'memories.write',
                invoke: async (_rpcCtx, args) => databaseService.add(args[0] as AddMemoryRequest),
            },
            {
                method: 'memories:clear',
                ipcChannel: 'memories:clear',
                capability: 'memories.write',
                invoke: async () => databaseService.clear(),
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

export const entry = memoriesMainEntry
export default memoriesMainEntry
