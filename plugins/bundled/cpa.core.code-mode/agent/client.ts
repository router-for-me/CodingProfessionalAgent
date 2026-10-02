import type { PluginCapabilityClient, ToolExecutionContext, ToolResult } from '@cpa/plugin-api'
import { CELL_EVENT, CELL_RPC, observationResult, type CellObservation, type ExecutorEvent, type ObserveCell, type StartCell } from '../shared/messages'

export class CellClient {
    private active = new Set<() => void>()
    private sessions = new Set<string>()
    constructor(private capability?: PluginCapabilityClient) {}

    async prepare(): Promise<void> {
        if (!this.capability) throw new Error('Code Mode requires a backend executor capability')
        await this.capability.invoke(CELL_RPC, [{ type: 'prepare' }])
    }

    async cancel(sessionId: string): Promise<void> {
        this.sessions.delete(sessionId)
        await this.capability?.invoke(CELL_RPC, [{ type: 'cancel', sessionId }])
    }
    async reset(): Promise<void> {
        await Promise.all([...this.sessions].map((sessionId) => this.cancel(sessionId)))
    }
    dispose(): void {
        void this.reset().catch(() => {})
        for (const cleanup of [...this.active]) cleanup()
    }

    async observe(type: 'start' | 'observe', input: StartCell | ObserveCell, context: ToolExecutionContext): Promise<ToolResult> {
        const capability = this.capability
        if (!capability) throw new Error('Code Mode requires a backend executor capability')
        if (!context.dispatchNestedTool) throw new Error('Missing host-injected dispatchNestedTool')
        const cancellation = context.cancellationSignal ?? context.signal
        if (cancellation?.aborted) throw new Error('Cell execution aborted')
        const requestId = crypto.randomUUID()
        this.sessions.add(input.sessionId)
        let closed = false
        let replaced = false
        let pendingTools = 0
        const controller = new AbortController()
        const signal = cancellation ? AbortSignal.any([cancellation, controller.signal]) : controller.signal
        const invoke = (command: Record<string, unknown>) => capability.invoke(CELL_RPC, [{ ...command, requestId }])
        const cleanup = () => {
            if (closed) return
            closed = true
            clearInterval(heartbeat)
            unsubscribe()
            cancellation?.removeEventListener('abort', onAbort)
            this.active.delete(cleanup)
        }
        const onAbort = () => {
            controller.abort()
            void this.cancel(input.sessionId).catch(() => {})
            cleanup()
        }
        const unsubscribe = capability.subscribe<{ requestId: string; event: ExecutorEvent | { type: 'replaced'; terminated?: boolean } }>(CELL_EVENT, (payload) => {
            if (payload.requestId !== requestId || closed) return
            const event = payload.event
            if (event.type === 'replaced') {
                replaced = true
                clearInterval(heartbeat)
                if (event.terminated) { controller.abort(); cleanup() }
                else if (pendingTools === 0) cleanup()
                return
            }
            if (event.type === 'completed') { controller.abort(); cleanup(); return }
            if (event.type === 'notify') context.onUpdate?.(observationResult(event.observation))
            if (event.type === 'tool-request') {
                const request = event.request
                pendingTools += 1
                void context.dispatchNestedTool!(request, signal).then((result) => invoke({ type: 'deliver', invocationId: request.invocationId, result })).catch((error) => {
                    return invoke({ type: 'deliver', invocationId: request.invocationId, result: { content: [{ type: 'text', text: String(error) }], isError: true } })
                }).catch(() => {}).finally(() => {
                    pendingTools -= 1
                    if (replaced && pendingTools === 0) cleanup()
                })
            }
        })
        const heartbeat = setInterval(() => { void invoke({ type: 'heartbeat' }).catch(onAbort) }, 10_000)
        cancellation?.addEventListener('abort', onAbort, { once: true })
        this.active.add(cleanup)
        try {
            const observation = await invoke({ type, input }) as CellObservation
            if (!['running', 'yielded'].includes(observation.status)) { controller.abort(); cleanup() }
            return observationResult(observation)
        } catch (error) {
            controller.abort()
            void invoke({ type: 'detach' }).catch(() => {})
            cleanup()
            throw error
        }
    }
}
