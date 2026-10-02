import { newQuickJSWASMModule, type QuickJSContext, type QuickJSRuntime, type QuickJSHandle, type QuickJSDeferredPromise } from 'quickjs-emscripten'
import variant from '@jitl/quickjs-ng-wasmfile-release-sync'
import { randomUUID } from 'node:crypto'
import type { ToolResult, ToolResultContentBlock } from '@cpa/plugin-api'
import type { CellObservation, CellStatus, ObserveCell, StartCell, ToolRequest } from '../shared/messages.js'

const SINGLE_STORE_LIMIT = 256 * 1024
const SESSION_STORE_LIMIT = 4 * 1024 * 1024
const OUTPUT_LIMIT = 4 * 1024 * 1024
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const terminal = (status: CellStatus) => !['running', 'yielded'].includes(status)

interface Cell {
    id: string
    sessionId: string
    guest?: { runtime: QuickJSRuntime; context: QuickJSContext }
    status: CellStatus
    error?: string
    output: ToolResultContentBlock[]
    outputBytes: number
    cursor: number
    deadline: number
    sliceMs: number
    root?: QuickJSHandle
    deferred: Set<QuickJSDeferredPromise>
    timers: Map<number, { timer: ReturnType<typeof setTimeout>; callback: QuickJSHandle }>
    sequence: number
    pump?: ReturnType<typeof setTimeout>
    released: boolean
    exitRequested: boolean
    yieldRequested: boolean
    observers: Set<() => void>
}

// This module is imported only by the dedicated utility entry and Node tests.
export class CellExecutor {
    private cells = new Map<string, Cell>()
    private stores = new Map<string, Map<string, string>>()
    private starting = new Set<{ id: string; sessionId: string; cancelled: boolean }>()
    private pending = new Map<string, { cell: Cell; promise: QuickJSDeferredPromise }>()

    constructor(
        private dispatch: (request: ToolRequest) => void,
        private notify: (cellId: string, observation: CellObservation) => void = () => {},
        private completed: (cellId: string) => void = () => {},
        private memoryLimit = 128 * 1024 * 1024,
    ) {}

    async start(input: StartCell): Promise<CellObservation> {
        const startup = { id: input.cellId ?? randomUUID(), sessionId: input.sessionId, cancelled: false }
        this.starting.add(startup)
        let module: Awaited<ReturnType<typeof newQuickJSWASMModule>>
        try {
            // The variant package's NodeNext declarations wrap its ESM default export.
            module = await newQuickJSWASMModule(variant as unknown as Parameters<typeof newQuickJSWASMModule>[0])
        } finally {
            this.starting.delete(startup)
        }
        const runtime = module.newRuntime()
        if (startup.cancelled) {
            runtime.dispose()
            this.completed(startup.id)
            return { cellId: startup.id, status: 'terminated', content: [], error: 'Cell terminated during initialization' }
        }
        runtime.setMemoryLimit(this.memoryLimit)
        runtime.setMaxStackSize(1024 * 1024)
        runtime.setModuleLoader(() => { throw new Error('import is not supported') })
        const cell: Cell = {
            id: startup.id, sessionId: input.sessionId, guest: { runtime, context: runtime.newContext() },
            status: 'running', output: [], outputBytes: 0, cursor: 0,
            deadline: Date.now() + Math.max(1, input.yieldTimeMs), sliceMs: Math.max(1, input.yieldTimeMs),
            deferred: new Set(), timers: new Map(), sequence: 0, released: false,
            exitRequested: false, yieldRequested: false, observers: new Set(),
        }
        this.cells.set(cell.id, cell)
        runtime.setInterruptHandler(() => cell.exitRequested || Date.now() >= cell.deadline)
        try {
            this.install(cell, input)
            const result = cell.guest!.context.evalCode(`(async () => {\n${input.source}\n})()`, 'cell.js')
            if (result.error) {
                const error = result.error.consume(cell.guest!.context.dump)
                this.fail(cell, error)
            } else {
                cell.root = result.value
                if (cell.exitRequested) {
                    this.finish(cell, 'completed')
                    return this.observe({ sessionId: input.sessionId, cellId: cell.id, yieldTimeMs: input.yieldTimeMs, maxOutputTokens: input.maxOutputTokens })
                }
                const state = cell.guest!.context.getPromiseState(result.value)
                if (state.type === 'fulfilled') {
                    state.value.dispose()
                    this.finish(cell, 'completed')
                    return this.observe({ sessionId: input.sessionId, cellId: cell.id, yieldTimeMs: input.yieldTimeMs, maxOutputTokens: input.maxOutputTokens })
                }
                if (state.type === 'rejected') {
                    this.fail(cell, state.error.consume(cell.guest!.context.dump))
                    return this.observe({ sessionId: input.sessionId, cellId: cell.id, yieldTimeMs: input.yieldTimeMs, maxOutputTokens: input.maxOutputTokens })
                }
                const resolved = cell.guest!.context.resolvePromise(result.value)
                void resolved.then((value) => {
                    if (cell.released) {
                        if (value.error?.alive) value.error.dispose()
                        if (!value.error && value.value.alive) value.value.dispose()
                        return
                    }
                    if (value.error) this.fail(cell, value.error.consume(cell.guest!.context.dump))
                    else {
                        value.value.dispose()
                        this.finish(cell, 'completed')
                    }
                }).catch((error) => { if (!cell.released) this.fail(cell, error) })
                this.schedule(cell)
            }
        } catch (error) {
            this.fail(cell, error)
        }
        return this.observe({ sessionId: input.sessionId, cellId: cell.id, yieldTimeMs: input.yieldTimeMs, maxOutputTokens: input.maxOutputTokens })
    }

    async observe(input: ObserveCell): Promise<CellObservation> {
        const cell = this.cells.get(input.cellId)
        if (!cell || cell.sessionId !== input.sessionId) return { cellId: input.cellId, status: 'missing', content: [], error: 'Cell missing' }
        if (input.terminate && !terminal(cell.status)) this.finish(cell, 'terminated', 'Cell terminated by request')
        if (cell.yieldRequested) cell.yieldRequested = false
        else if (!terminal(cell.status)) {
            cell.sliceMs = Math.max(1, input.yieldTimeMs)
            cell.deadline = Date.now() + cell.sliceMs
            await new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer)
                    cell.observers.delete(done)
                    resolve()
                }
                const timer = setTimeout(done, Math.min(input.yieldTimeMs, 2_147_483_647))
                cell.observers.add(done)
            })
        }
        return this.take(cell, input.maxOutputTokens, true)
    }

    deliver(invocationId: string, result: ToolResult): void {
        const entry = this.pending.get(invocationId)
        if (!entry) return
        this.pending.delete(invocationId)
        const { cell, promise } = entry
        if (cell.released) return
        try {
            if (result.isError) {
                const message = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n') || 'Nested tool failed'
                cell.guest!.context.newError(message).consume(promise.reject)
            } else {
                this.jsonHandle(cell, result).consume(promise.resolve)
            }
        } catch (error) {
            cell.guest!.context.newError(String(error)).consume(promise.reject)
        }
    }

    cancel(sessionId: string, cellId?: string): void {
        for (const startup of this.starting) if (startup.sessionId === sessionId && (!cellId || startup.id === cellId)) startup.cancelled = true
        for (const cell of this.cells.values()) {
            if (cell.sessionId === sessionId && (!cellId || cell.id === cellId)) {
                if (!terminal(cell.status)) this.finish(cell, 'terminated', 'Cell terminated by cancellation')
                if (!cellId) this.cells.delete(cell.id)
            }
        }
        if (!cellId) this.stores.delete(sessionId)
    }

    dispose(): void {
        for (const sessionId of new Set([...this.cells.values(), ...this.starting].map((cell) => cell.sessionId))) this.cancel(sessionId)
        this.stores.clear()
    }

    private jsonHandle(cell: Cell, value: unknown): QuickJSHandle {
        const json = JSON.stringify(value)
        if (json === undefined) return cell.guest!.context.undefined.dup()
        return cell.guest!.context.unwrapResult(cell.guest!.context.evalCode(`JSON.parse(${JSON.stringify(json)})`))
    }

    private bridge(cell: Cell, name: string, run: (...args: QuickJSHandle[]) => QuickJSHandle | void): void {
        cell.guest!.context.newFunction(name, (...args) => {
            if (cell.exitRequested) return { error: cell.guest!.context.newError('Cell exited') }
            try { return run(...args) }
            catch (error) { return { error: cell.guest!.context.newError(error instanceof Error ? error.message : String(error)) } }
        }).consume((handle) => cell.guest!.context.setProp(cell.guest!.context.global, name, handle))
    }

    private install(cell: Cell, input: StartCell): void {
        const context = cell.guest!.context
        const read = (handle: QuickJSHandle) => JSON.parse(context.getString(handle)) as unknown
        this.bridge(cell, '__output', (handle, notifyHandle) => {
            const block = read(handle) as ToolResultContentBlock
            const size = bytes(JSON.stringify(block))
            if (cell.outputBytes + size > OUTPUT_LIMIT) throw new Error('Cell output limit exceeded')
            cell.output.push(block)
            cell.outputBytes += size
            if (context.getNumber(notifyHandle) === 1) this.notify(cell.id, this.take(cell, 10_000, false))
        })
        this.bridge(cell, '__store', (keyHandle, valueHandle) => {
            const key = context.getString(keyHandle)
            const json = context.getString(valueHandle)
            JSON.parse(json)
            if (bytes(json) > SINGLE_STORE_LIMIT) throw new Error('store value exceeds 256KB')
            const store = this.stores.get(cell.sessionId) ?? new Map<string, string>()
            let total = bytes(key) + bytes(json)
            for (const [oldKey, oldValue] of store) if (oldKey !== key) total += bytes(oldKey) + bytes(oldValue)
            if (total > SESSION_STORE_LIMIT) throw new Error('session store exceeds 4MB')
            store.set(key, json)
            this.stores.set(cell.sessionId, store)
        })
        this.bridge(cell, '__load', (key) => {
            const value = this.stores.get(cell.sessionId)?.get(context.getString(key))
            return value === undefined ? context.undefined : context.newString(value)
        })
        this.bridge(cell, '__call', (nameHandle, valueHandle) => {
            const identifier = context.getString(nameHandle)
            const spec = input.tools.find((tool) => tool.identifier === identifier)
            if (!spec) throw new Error(`Unknown nested tool: ${identifier}`)
            if ([...this.pending.values()].filter((entry) => entry.cell === cell).length >= 32) throw new Error('Cell exceeds 32 outstanding tool calls')
            const promise = context.newPromise()
            cell.deferred.add(promise)
            void promise.settled.then(() => {
                if (cell.released) return
                cell.deferred.delete(promise)
                if (promise.alive) promise.dispose()
                this.schedule(cell)
            })
            const invocationId = randomUUID()
            this.pending.set(invocationId, { cell, promise })
            // The argument handle is only valid inside this callback.
            const pendingInput = read(valueHandle)
            // Preserve only cloned JSON, never borrowed guest handles.
            const request = { cellId: cell.id, invocationId, toolName: spec.name, input: pendingInput }
            queueMicrotask(() => {
                if (cell.released || cell.exitRequested) return
                try { this.dispatch(request) }
                catch (error) { this.deliver(invocationId, { content: [{ type: 'text', text: String(error) }], isError: true }) }
            })
            return promise.handle
        })
        this.bridge(cell, '__yield', () => {
            if (cell.observers.size === 0) cell.yieldRequested = true
            for (const done of [...cell.observers]) done()
        })
        this.bridge(cell, '__exit', () => {
            cell.exitRequested = true
            throw new Error('Cell exited')
        })
        this.bridge(cell, 'setTimeout', (callback, delay) => {
            const id = ++cell.sequence
            const duplicated = callback.dup()
            const timer = setTimeout(() => {
                cell.timers.delete(id)
                if (!cell.released) {
                    cell.deadline = Date.now() + cell.sliceMs
                    const result = context.callFunction(duplicated, context.undefined)
                    const error = result.error ? result.error.consume(context.dump) : undefined
                    if (!result.error) result.value.dispose()
                    if (duplicated.alive) duplicated.dispose()
                    if (error) this.fail(cell, error)
                    else this.schedule(cell)
                } else if (duplicated.alive) duplicated.dispose()
            }, Math.max(0, Math.min(context.getNumber(delay), 2_147_483_647)))
            cell.timers.set(id, { timer, callback: duplicated })
            return context.newNumber(id)
        })
        this.bridge(cell, 'clearTimeout', (idHandle) => {
            const id = context.getNumber(idHandle)
            const timer = cell.timers.get(id)
            if (timer) { clearTimeout(timer.timer); timer.callback.dispose(); cell.timers.delete(id) }
        })
        context.unwrapResult(context.evalCode(`(() => {
            for (const key of ['process','require','fs','fetch','XMLHttpRequest','WebSocket','console','Atomics','SharedArrayBuffer','WebAssembly']) delete globalThis[key];
            const call = __call, output = __output, save = __store, get = __load, surrender = __yield, stop = __exit;
            globalThis.tools = new Proxy(Object.freeze(Object.assign(Object.create(null), Object.fromEntries(${JSON.stringify(input.tools.map((tool) => tool.identifier))}.map(name => [name, arg => call(name, JSON.stringify(arg))])))), { get(target, key) { return target[key] ?? (() => Promise.reject(new Error('Unknown nested tool: ' + String(key)))); } });
            globalThis.ALL_TOOLS = ${JSON.stringify(input.tools.map((tool) => ({ name: tool.identifier, description: tool.description })))};
            globalThis.text = value => output(JSON.stringify({type:'text', text: typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))}), 0);
            globalThis.image = value => { if (!value || typeof value.data !== 'string' || typeof value.mimeType !== 'string') throw new Error('image requires data and mimeType'); output(JSON.stringify({type:'image', data:value.data, mimeType:value.mimeType}), 0); };
            globalThis.notify = value => output(JSON.stringify({type:'text', text: typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))}), 1);
            globalThis.store = (key,value) => save(String(key), JSON.stringify(value));
            globalThis.load = key => { const value = get(String(key)); return value === undefined ? undefined : JSON.parse(value); };
            globalThis.yield_control = async () => { surrender(); await new Promise(resolve => setTimeout(resolve, 0)); };
            globalThis.exit = () => stop();
            for (const key of ['__call','__output','__store','__load','__yield','__exit']) delete globalThis[key];
        })()`)).dispose()
    }

    private schedule(cell: Cell): void {
        if (cell.released || cell.pump) return
        if (cell.exitRequested) { this.finish(cell, 'completed'); return }
        cell.pump = setTimeout(() => {
            cell.pump = undefined
            if (cell.released) return
            cell.deadline = Date.now() + cell.sliceMs
            try {
                const jobs = cell.guest!.runtime.executePendingJobs()
                if (jobs.error) this.fail(cell, jobs.error.consume(cell.guest!.context.dump))
            } catch (error) { this.fail(cell, error) }
        }, 0)
    }

    private fail(cell: Cell, error: unknown): void {
        if (cell.exitRequested) this.finish(cell, 'completed')
        else if (Date.now() >= cell.deadline) this.finish(cell, 'terminated', 'Synchronous execution exceeded the yield deadline; it cannot be resumed')
        else this.finish(cell, 'failed', error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error))
    }

    private finish(cell: Cell, status: CellStatus, error?: string): void {
        if (cell.released) return
        cell.status = status
        cell.error = error
        for (const done of [...cell.observers]) done()
        cell.released = true
        clearTimeout(cell.pump)
        for (const timer of cell.timers.values()) { clearTimeout(timer.timer); if (timer.callback.alive) timer.callback.dispose() }
        cell.timers.clear()
        for (const [id, entry] of this.pending) if (entry.cell === cell) this.pending.delete(id)
        for (const promise of cell.deferred) if (promise.alive) promise.dispose()
        cell.deferred.clear()
        if (cell.root?.alive) cell.root.dispose()
        cell.root = undefined
        const guest = cell.guest!
        cell.guest = undefined
        try { guest.context.dispose() } catch (error) { console.warn('Guest context cleanup failed', String(error)) }
        try { guest.runtime.dispose() } catch (error) { console.warn('Guest runtime cleanup failed', String(error)) }
        this.completed(cell.id)
    }

    private take(cell: Cell, tokens: number, consume: boolean): CellObservation {
        let remaining = Math.min(tokens * 4, OUTPUT_LIMIT)
        const content: ToolResultContentBlock[] = []
        for (const block of cell.output.slice(cell.cursor)) {
            if (block.type === 'text') {
                if (remaining <= 0) continue
                content.push({ type: 'text', text: block.text.slice(0, remaining) })
                remaining -= block.text.length
            } else if (remaining > 0) { content.push(block); remaining -= 1024 }
        }
        const size = cell.output.slice(cell.cursor).reduce((total, block) => total + (block.type === 'text' ? block.text.length : 1024), 0)
        if (size > tokens * 4) content.push({ type: 'text', text: '[Output truncated: approximate token budget]' })
        if (consume) { cell.output = []; cell.outputBytes = 0; cell.cursor = 0 }
        return { cellId: cell.id, status: terminal(cell.status) ? cell.status : 'yielded', content, ...(cell.error ? { error: cell.error } : {}) }
    }
}
