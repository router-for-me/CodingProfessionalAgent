import { definePluginEntry } from '@cpa/plugin-sdk'
import type { PluginContext, RpcDescriptor, ScheduledTaskItem, ServiceDescriptor } from '@cpa/plugin-api'
import { SchedulerCoordinationService } from './schedulerCoordinationService.js'

export { SchedulerCoordinationService }

export const schedulerMainEntry = definePluginEntry({
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

        const coordinationService = new SchedulerCoordinationService(emitEvent, {
            async loadTasks() {
                const client = context.capabilityClient
                if (!client?.invoke) return []
                const loaded = await client.invoke('kvstore:get', ['schedule'])
                return Array.isArray(loaded) ? (loaded as ScheduledTaskItem[]) : []
            },
            async saveTasks(tasks) {
                const client = context.capabilityClient
                if (!client?.invoke) return
                await client.invoke('kvstore:set', ['schedule', tasks])
            },
        })

        // 1. Register Scheduler Coordination Service
        context.register<ServiceDescriptor<SchedulerCoordinationService>>({
            kind: 'service',
            id: 'schedulerCoordinationService',
            value: {
                id: 'schedulerCoordinationService',
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
                method: 'schedule:list',
                aliases: ['ScheduleList'],
                ipcChannel: 'schedule:list',
                capability: 'schedule.read',
                invoke: async () => coordinationService.list(),
            },
            {
                method: 'schedule:save',
                aliases: ['ScheduleSave'],
                ipcChannel: 'schedule:save',
                capability: 'schedule.write',
                invoke: async (rpcCtx, args) => coordinationService.save(args[0] as ScheduledTaskItem[], rpcCtx),
            },
            {
                method: 'schedule:trigger',
                aliases: ['ScheduleTrigger'],
                ipcChannel: 'schedule:trigger',
                capability: 'schedule.manage',
                invoke: async (rpcCtx, args) => coordinationService.trigger(args[0] as string, rpcCtx),
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

export const entry = schedulerMainEntry
export default schedulerMainEntry
