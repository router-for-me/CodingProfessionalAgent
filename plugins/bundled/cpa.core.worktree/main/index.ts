import { definePluginEntry } from '@cpa/plugin-sdk'
import type {
    DiscoveredWorktree,
    PluginContext,
    RpcDescriptor,
    ServiceDescriptor,
    WorktreeSetupInput,
} from '@cpa/plugin-api'
import { WorktreeCoordinationService } from './worktreeCoordinationService.js'

export { WorktreeCoordinationService }

export const worktreeMainEntry = definePluginEntry({
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

        const coordinationService = new WorktreeCoordinationService(emitEvent)

        // 1. Register Service Descriptor
        context.register<ServiceDescriptor<WorktreeCoordinationService>>({
            kind: 'service',
            id: 'worktreeCoordinationService',
            value: {
                id: 'worktreeCoordinationService',
                dependencies: [],
                create: () => coordinationService,
                dispose: (service) => {
                    service.dispose()
                },
            },
        })

        // 2. Register RPC Descriptors
        const rpcList: RpcDescriptor[] = [
            {
                method: 'worktree:setup',
                aliases: ['WorktreeSetup'],
                ipcChannel: 'worktree:setup',
                capability: 'projects.write',
                invoke: async (rpcCtx, args) => coordinationService.setup(args[0] as WorktreeSetupInput, rpcCtx),
            },
            {
                method: 'worktree:list',
                aliases: ['WorktreeList'],
                ipcChannel: 'worktree:list',
                capability: 'filesystem.read',
                invoke: async (_rpcCtx, args) => coordinationService.listWorktrees(args[0] as string | undefined),
            },
            {
                method: 'worktree:delete',
                aliases: ['WorktreeDelete'],
                ipcChannel: 'worktree:delete',
                capability: 'filesystem.write',
                invoke: async (_rpcCtx, args) => {
                    const wt = args[0] as DiscoveredWorktree | string
                    const wtPath = typeof wt === 'string' ? wt : wt.path
                    const mainRepoPath = typeof wt === 'object' ? wt.mainRepoPath : (args[1] as string | undefined)
                    return coordinationService.deleteWorktree(wtPath, mainRepoPath)
                },
            },
            {
                method: 'worktree:resolve-root',
                aliases: ['WorktreeResolveRoot'],
                ipcChannel: 'worktree:resolve-root',
                capability: 'filesystem.read',
                invoke: async (_rpcCtx, args) => coordinationService.resolveRootDir(args[0] as string | undefined),
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

export const entry = worktreeMainEntry
export default worktreeMainEntry
