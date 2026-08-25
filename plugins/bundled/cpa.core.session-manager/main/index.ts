import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, RpcDescriptor, ServiceDescriptor } from '@cpa/plugin-api'
import { SessionService, type SessionServiceOptions } from './sessionService.js'
import { SessionRunRegistry } from './sessionRunRegistry.js'
import type {
    QueryMetricsOptions,
    ResumePromptSyncState,
    SessionDelegateRunRequest,
    SessionItem,
} from '../../../../src/shared/types.js'

export const sessionManagerMainEntry = definePluginEntry({
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

        const options = (context as any).options as SessionServiceOptions | undefined
        const sessionService = new SessionService(options)
        const sessionRunRegistry = new SessionRunRegistry(emitEvent)

        // 1. Register Services
        context.register<ServiceDescriptor<SessionService>>({
            kind: 'service',
            id: 'sessionService',
            value: {
                id: 'sessionService',
                dependencies: [],
                create: () => sessionService,
                dispose: (service) => {
                    service.close()
                },
            },
        })

        context.register<ServiceDescriptor<SessionRunRegistry>>({
            kind: 'service',
            id: 'sessionRunRegistry',
            value: {
                id: 'sessionRunRegistry',
                dependencies: [],
                create: () => sessionRunRegistry,
                dispose: (service) => {
                    service.cleanupClientRuns('desktop-main')
                },
            },
        })

        // 2. Register RPC Descriptors
        const rpcList: RpcDescriptor[] = [
            {
                method: 'session:get',
                aliases: ['SessionGet'],
                ipcChannel: 'session:get',
                capability: 'sessions.read',
                invoke: async (_ctx, args) => sessionService.get(args[0] as string),
            },
            {
                method: 'session:set',
                aliases: ['SessionSet'],
                ipcChannel: 'session:set',
                capability: 'sessions.write',
                invoke: async (rpcCtx, args) => {
                    const sessionId = args[0] as string
                    const data = args[1]
                    const result = await sessionService.set(sessionId, data)
                    emitEvent(
                        {
                            operationId: `entries-${sessionId}`,
                            sequence: Date.now(),
                            kind: 'session:entries-updated',
                            data: JSON.stringify({ sessionId }),
                        },
                        rpcCtx,
                    )
                    return result
                },
            },
            {
                method: 'session:delete',
                aliases: ['SessionDelete'],
                ipcChannel: 'session:delete',
                capability: 'sessions.write',
                invoke: async (rpcCtx, args) => {
                    const sessionId = args[0] as string
                    const result = await sessionService.delete(sessionId)
                    emitEvent(
                        {
                            operationId: `delete-${sessionId}`,
                            sequence: Date.now(),
                            kind: 'session:deleted',
                            data: JSON.stringify({ sessionId }),
                        },
                        rpcCtx,
                    )
                    return result
                },
            },
            {
                method: 'session:list',
                aliases: ['SessionList'],
                ipcChannel: 'session:list',
                capability: 'sessions.read',
                invoke: async () => sessionService.list(),
            },
            {
                method: 'session:listSessions',
                aliases: ['SessionListSessions'],
                ipcChannel: 'session:listSessions',
                capability: 'sessions.read',
                invoke: async () => sessionService.listSessions(),
            },
            {
                method: 'session:listSessionsByScheduleId',
                aliases: ['SessionListSessionsByScheduleId'],
                ipcChannel: 'session:listSessionsByScheduleId',
                capability: 'sessions.read',
                invoke: async (_rpcCtx, args) =>
                    sessionService.listSessionsByScheduleId(args[0] as string),
            },
            {
                method: 'session:setMeta',
                aliases: ['SessionSetMeta'],
                ipcChannel: 'session:setMeta',
                capability: 'sessions.write',
                invoke: async (rpcCtx, args) => {
                    const session = args[0] as Partial<SessionItem> & { id: string }
                    const result = await sessionService.setMeta(session)
                    const fullList = await sessionService.listSessions()
                    const fullItem = fullList.find((s) => s.id === session.id) ?? session
                    emitEvent(
                        {
                            operationId: `meta-${session.id}`,
                            sequence: Date.now(),
                            kind: 'session:meta-updated',
                            data: JSON.stringify(fullItem),
                        },
                        rpcCtx,
                    )
                    return result
                },
            },
            {
                method: 'session:broadcastRunStatus',
                aliases: ['SessionBroadcastRunStatus'],
                ipcChannel: 'session:broadcastRunStatus',
                capability: 'sessions.manage',
                invoke: async (rpcCtx, args) => {
                    return sessionRunRegistry.registerOrUpdate({
                        sessionId: args[0] as string,
                        status: args[1] as 'running' | 'thinking' | 'tool' | 'idle',
                        runId: args[2] as string,
                        clientId: rpcCtx.clientId || (args[3] as string) || 'desktop-main',
                    })
                },
            },
            {
                method: 'session:broadcastStreamEvent',
                aliases: ['SessionBroadcastStreamEvent'],
                ipcChannel: 'session:broadcastStreamEvent',
                capability: 'sessions.manage',
                invoke: async (rpcCtx, args) => {
                    emitEvent(
                        {
                            operationId: `stream-${args[0] as string}`,
                            sequence: Date.now(),
                            kind: 'session:stream-event',
                            sourceClientId: rpcCtx.clientId,
                            data: JSON.stringify({
                                sessionId: args[0],
                                runId: args[1],
                                event: args[2],
                            }),
                        },
                        rpcCtx,
                    )
                },
            },
            {
                method: 'session:broadcastSubAgentState',
                aliases: ['SessionBroadcastSubAgentState'],
                ipcChannel: 'session:broadcastSubAgentState',
                capability: 'sessions.manage',
                invoke: async (rpcCtx, args) => {
                    emitEvent(
                        {
                            operationId: `subagent-state-${args[0] as string}`,
                            sequence: Date.now(),
                            kind: 'session:subagent-state',
                            sourceClientId: rpcCtx.clientId,
                            data: JSON.stringify({
                                parentSessionId: args[0],
                                agents: args[1],
                            }),
                        },
                        rpcCtx,
                    )
                },
            },
            {
                method: 'session:updateSubAgent',
                aliases: ['SessionUpdateSubAgent'],
                ipcChannel: 'session:updateSubAgent',
                capability: 'sessions.write',
                invoke: async (_rpcCtx, args) =>
                    sessionService.updateSubAgent(
                        args[0] as Parameters<SessionService['updateSubAgent']>[0],
                    ),
            },
            {
                method: 'session:abortRun',
                aliases: ['SessionAbortRun'],
                ipcChannel: 'session:abortRun',
                capability: 'sessions.manage',
                invoke: async (rpcCtx, args) => {
                    emitEvent(
                        {
                            operationId: `abort-${args[0] as string}`,
                            sequence: Date.now(),
                            kind: 'session:abort-run',
                            data: JSON.stringify({
                                sessionId: args[0],
                                reason: args[1],
                            }),
                        },
                        rpcCtx,
                    )
                },
            },
            {
                method: 'session:getActiveRuns',
                aliases: ['SessionGetActiveRuns'],
                ipcChannel: 'session:getActiveRuns',
                capability: 'sessions.read',
                invoke: async () => sessionRunRegistry.getActiveRuns(),
            },
            {
                method: 'session:getResumePromptState',
                aliases: ['SessionGetResumePromptState'],
                ipcChannel: 'session:getResumePromptState',
                capability: 'sessions.read',
                invoke: async () => sessionRunRegistry.getResumePromptState(),
            },
            {
                method: 'session:broadcastResumePromptState',
                aliases: ['SessionBroadcastResumePromptState'],
                ipcChannel: 'session:broadcastResumePromptState',
                capability: 'sessions.manage',
                invoke: async (_rpcCtx, args) =>
                    sessionRunRegistry.broadcastResumePromptState(
                        args[0] as ResumePromptSyncState,
                    ),
            },
            {
                method: 'session:resumePromptAction',
                aliases: ['SessionResumePromptAction'],
                ipcChannel: 'session:resumePromptAction',
                capability: 'sessions.manage',
                invoke: async (_rpcCtx, args) =>
                    sessionRunRegistry.dispatchResumePromptAction(
                        args[0] as 'continue' | 'abort',
                    ),
            },
            {
                method: 'session:delegateRun',
                aliases: ['SessionDelegateRun'],
                ipcChannel: 'session:delegateRun',
                capability: 'sessions.manage',
                invoke: async (rpcCtx, args) => {
                    const req = args[0] as SessionDelegateRunRequest
                    emitEvent(
                        {
                            operationId: `delegate-${Date.now()}`,
                            sequence: Date.now(),
                            kind: 'session:delegate-run',
                            data: JSON.stringify(req),
                        },
                        rpcCtx,
                    )
                    return (req?.sessionId as string) || ''
                },
            },
            {
                method: 'session:queryMetrics',
                aliases: ['SessionQueryMetrics'],
                ipcChannel: 'session:queryMetrics',
                capability: 'sessions.read',
                invoke: async (_rpcCtx, args) =>
                    sessionService.queryMetrics(args[0] as QueryMetricsOptions),
            },
            {
                method: 'session:search',
                aliases: ['SessionSearch'],
                ipcChannel: 'session:search',
                capability: 'sessions.read',
                invoke: async (_rpcCtx, args) =>
                    sessionService.search(
                        args[0] as string,
                        args[1] as number | undefined,
                    ),
            },
        ]

        for (const rpc of rpcList) {
            context.register<RpcDescriptor>({
                kind: 'rpc',
                id: rpc.method,
                value: rpc,
            })
        }
    },
})

export const entry = sessionManagerMainEntry
export default sessionManagerMainEntry
