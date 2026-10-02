import { randomUUID } from 'node:crypto'
import type { ToolResult, UtilityExecutorHandle } from '@cpa/plugin-api'
import type { CellObservation, ExecutorEvent, ObserveCell, StartCell } from '../shared/messages.js'

export type CellStreamEvent = { requestId: string; event: ExecutorEvent | { type: 'replaced'; terminated?: boolean } }
interface Route { requestId: string; sessionId: string; owner: string; active: boolean; touched: number }

// Supervises the dedicated executor; never imports QuickJS or executes guest code.
export class CellSessionHost {
    private child?: UtilityExecutorHandle
    private boot?: Promise<void>
    private disposed = false
    private starting = new Set<{ cellId: string; sessionId: string; cancelled: boolean }>()
    private routes = new Map<string, Route>()
    private cancellationTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private pending = new Map<string, { resolve: (value: CellObservation) => void; reject: (error: Error) => void }>()
    private invocations = new Map<string, { cellId: string; requestId: string; owner: string }>()
    private sweep = setInterval(() => {
        for (const [cellId, route] of this.routes) {
            if (route.active && Date.now() - route.touched > 30_000) this.cancel(route.sessionId, cellId)
        }
    }, 10_000)

    constructor(private emit: (payload: CellStreamEvent) => void, private fork: () => Promise<UtilityExecutorHandle>) { this.sweep.unref() }

    async prepare(): Promise<void> {
        if (this.disposed) throw new Error('Code cell host disposed')
        if (this.boot) return this.boot
        this.boot = (async () => {
            const child = await this.fork()
            if (this.disposed) { child.kill(); throw new Error('Code cell host disposed') }
            return new Promise<void>((resolve, reject) => {
            this.child = child
            let ready = false
            const timeout = setTimeout(() => { child.kill(); reject(new Error('Code cell executor startup timed out')) }, 10_000)
            child.onStderr((data) => console.error(data))
            child.onMessage( (event: ExecutorEvent | { type: 'ready' }) => {
                if (this.disposed || this.child !== child) return
                if (event.type === 'ready') { ready = true; clearTimeout(timeout); resolve(); return }
                this.receive(event)
            })
            child.onExit((code) => {
                clearTimeout(timeout)
                if (!ready) reject(new Error(`Code cell executor exited during startup (${code})`))
                if (this.child !== child) return
                this.child = undefined
                this.boot = undefined
                for (const pending of this.pending.values()) pending.reject(new Error(`Code cell executor exited (${code}); old cells are missing`))
                this.pending.clear()
                for (const route of this.routes.values()) this.emit({ requestId: route.requestId, event: { type: 'replaced', terminated: true } })
                this.routes.clear()
                this.invocations.clear()
                for (const timer of this.cancellationTimers.values()) clearTimeout(timer)
                this.cancellationTimers.clear()
            })
            })
        })()
        try { await this.boot } catch (error) { this.boot = undefined; throw error }
    }

    async start(requestId: string, input: StartCell, owner: string): Promise<CellObservation> {
        const startup = { cellId: randomUUID(), sessionId: input.sessionId, cancelled: false }
        this.starting.add(startup)
        try {
            await this.prepare()
        } catch (error) {
            if (!startup.cancelled) throw error
        } finally {
            this.starting.delete(startup)
        }
        if (startup.cancelled) return { cellId: startup.cellId, status: 'terminated', content: [], error: 'Cell cancelled before executor startup completed' }
        this.attach(startup.cellId, requestId, startup.sessionId, owner)
        return this.request(requestId, { type: 'start', requestId, input: { ...input, cellId: startup.cellId } })
    }

    async observe(requestId: string, input: ObserveCell, owner: string): Promise<CellObservation> {
        if (!this.child || !this.routes.has(input.cellId)) return { cellId: input.cellId, status: 'missing', content: [], error: 'Cell missing after executor exit or session close' }
        const route = this.routes.get(input.cellId)!
        if (route.sessionId !== input.sessionId) throw new Error('Cell session mismatch')
        if (this.pending.has(route.requestId)) throw new Error('Cell already has an active observation')
        this.attach(input.cellId, requestId, input.sessionId, owner)
        return this.request(requestId, { type: 'observe', requestId, input })
    }

    deliver(requestId: string, owner: string, invocationId: string, result: ToolResult): void {
        const invocation = this.invocations.get(invocationId)
        if (!invocation || invocation.requestId !== requestId || invocation.owner !== owner || !this.routes.get(invocation.cellId)?.active) return
        this.invocations.delete(invocationId)
        this.child?.postMessage({ type: 'tool-result', invocationId, result })
    }

    heartbeat(requestId: string, owner: string): void {
        for (const route of this.routes.values()) if (route.requestId === requestId && route.owner === owner) route.touched = Date.now()
    }

    detach(requestId: string, owner: string): void {
        for (const [cellId, route] of this.routes) if (route.requestId === requestId && route.owner === owner) this.cancel(route.sessionId, cellId)
    }

    cancel(sessionId: string, cellId?: string): void {
        for (const startup of this.starting) if (startup.sessionId === sessionId && (!cellId || startup.cellId === cellId)) startup.cancelled = true
        if (this.child) {
            const child = this.child
            const cancelId = randomUUID()
            child.postMessage({ type: 'cancel', sessionId, cellId, cancelId })
            // A blocked synchronous guest cannot receive cancellation; kill its executor.
            this.cancellationTimers.set(cancelId, setTimeout(() => { if (this.child === child) child.kill() }, 1000))
        }
        for (const [id, invocation] of this.invocations) {
            const route = this.routes.get(invocation.cellId)
            if (route?.sessionId === sessionId && (!cellId || invocation.cellId === cellId)) {
                this.emit({ requestId: invocation.requestId, event: { type: 'replaced', terminated: true } })
                this.invocations.delete(id)
            }
        }
        for (const [id, route] of this.routes) if (route.sessionId === sessionId && (!cellId || id === cellId)) {
            this.emit({ requestId: route.requestId, event: { type: 'replaced', terminated: true } })
            if (!cellId) this.routes.delete(id)
            else route.active = false
        }
    }

    cancelAll(): void {
        for (const sessionId of new Set([...this.routes.values(), ...this.starting].map((route) => route.sessionId))) this.cancel(sessionId)
    }

    dispose(): void {
        this.disposed = true
        for (const startup of this.starting) startup.cancelled = true
        clearInterval(this.sweep)
        for (const timer of this.cancellationTimers.values()) clearTimeout(timer)
        this.cancellationTimers.clear()
        this.child?.kill()
        this.child = undefined
        this.boot = undefined
        for (const pending of this.pending.values()) pending.reject(new Error('Code cell host disposed'))
        this.pending.clear()
        this.routes.clear()
        this.invocations.clear()
    }

    private attach(cellId: string, requestId: string, sessionId: string, owner: string): void {
        const previous = this.routes.get(cellId)
        if (previous) this.emit({ requestId: previous.requestId, event: { type: 'replaced' } })
        this.routes.set(cellId, { requestId, sessionId, owner, active: previous?.active ?? true, touched: Date.now() })
    }

    private request(requestId: string, command: unknown): Promise<CellObservation> {
        if (this.pending.has(requestId)) throw new Error('Duplicate observation id')
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject })
            this.child!.postMessage(command)
        })
    }

    private receive(event: ExecutorEvent): void {
        if (event.type === 'cancelled') {
            clearTimeout(this.cancellationTimers.get(event.cancelId))
            this.cancellationTimers.delete(event.cancelId)
            return
        }
        if (event.type === 'observation') {
            const pending = this.pending.get(event.requestId)
            this.pending.delete(event.requestId)
            pending?.resolve(event.observation)
            return
        }
        const cellId = event.type === 'tool-request' ? event.request.cellId : event.cellId
        const route = this.routes.get(cellId)
        if (!route) return
        if (event.type === 'tool-request') this.invocations.set(event.request.invocationId, { cellId, requestId: route.requestId, owner: route.owner })
        if (event.type === 'completed') route.active = false
        this.emit({ requestId: route.requestId, event })
    }
}
