import type {
    AssistantEntry,
    IsolatedModelInvocationRecord,
    IsolatedModelInvoker,
    IsolatedModelRequest,
    ProtocolSession,
    ProtocolStreamInput,
    ProtocolStreamOptions,
    Usage,
    UserEntry,
} from '@cpa/plugin-api'

export interface IsolatedProtocolSession {
    session: ProtocolSession
    dispose?(): Promise<void> | void
}

export interface ToolModelInvokerOwner {
    forToolCall(parentToolCallId: string): IsolatedModelInvoker
    takeRecords(parentToolCallId: string): readonly IsolatedModelInvocationRecord[]
    close(): Promise<void>
}

export interface RunScopedModelInvokerOptions {
    runSignal: AbortSignal
    sessionId: string
    createSession(input: {
        invocationId: string
        model: IsolatedModelRequest['model']
    }): Promise<IsolatedProtocolSession> | IsolatedProtocolSession
    generateId?: () => string
    now?: () => number
    maxConcurrent?: number
    maxCalls?: number
    /** Immutable catalog captured for this run. Requests use its canonical entry. */
    allowedModels: readonly IsolatedModelRequest['model'][]
    maxQueryChars?: number
    maxInstructionsChars?: number
    maxResponseChars?: number
    sanitizeError?: (error: unknown) => Error
}

type Waiter = {
    signal: AbortSignal
    resolve: () => void
    reject: (error: Error) => void
    onAbort: () => void
}

function abortError(message = 'Isolated model invocation aborted'): Error {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
}

function defaultId(): string {
    return typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `isolated_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function cloneUsage(usage: Usage): Usage {
    return {
        ...usage,
        cost: { ...usage.cost },
    }
}

function linkSignals(signals: readonly (AbortSignal | undefined)[]): {
    controller: AbortController
    unlink: () => void
} {
    const controller = new AbortController()
    const removers: Array<() => void> = []
    for (const signal of signals) {
        if (!signal) continue
        if (signal.aborted) {
            controller.abort()
            continue
        }
        const onAbort = (): void => controller.abort()
        signal.addEventListener('abort', onAbort, { once: true })
        removers.push(() => signal.removeEventListener('abort', onAbort))
    }
    return {
        controller,
        unlink: () => removers.splice(0).forEach((remove) => remove()),
    }
}

async function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    void promise.catch(() => undefined)
    if (signal.aborted) throw abortError()
    return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            signal.removeEventListener('abort', onAbort)
            reject(abortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            },
        )
    })
}

function validateRequest(
    request: IsolatedModelRequest,
    maxQueryChars: number,
    maxInstructionsChars: number,
): void {
    if (!request || typeof request !== 'object') {
        throw new TypeError('Isolated model request is required')
    }
    if (!request.model || typeof request.model.id !== 'string' || !request.model.id.trim()) {
        throw new TypeError('Isolated model request requires a catalog model')
    }
    if (typeof request.query !== 'string' || !request.query.trim()) {
        throw new TypeError('Isolated model query must be non-empty')
    }
    if (typeof request.instructions !== 'string' || !request.instructions.trim()) {
        throw new TypeError('Isolated model instructions must be non-empty')
    }
    if (request.query.length > maxQueryChars) {
        throw new RangeError(`Isolated model query exceeds ${maxQueryChars} characters`)
    }
    if (request.instructions.length > maxInstructionsChars) {
        throw new RangeError(`Isolated model instructions exceed ${maxInstructionsChars} characters`)
    }
    if (
        request.toolChoice !== undefined &&
        request.toolChoice !== 'auto' &&
        request.toolChoice !== 'required' &&
        request.toolChoice !== 'none'
    ) {
        throw new TypeError('Invalid isolated model toolChoice')
    }
    if (
        request.nativeTools?.some(
            (tool) => !tool || tool.type !== 'web_search',
        )
    ) {
        throw new TypeError('Unsupported isolated native tool')
    }
}

function assertBoundedValue(value: unknown, maxChars: number): void {
    let size = 0
    const seen = new Set<object>()
    const visit = (current: unknown): void => {
        if (typeof current === 'string') size += current.length
        else if (typeof current === 'number' || typeof current === 'boolean') size += 8
        else if (current && typeof current === 'object') {
            if (seen.has(current)) throw new TypeError('Isolated model response is cyclic')
            seen.add(current)
            for (const [key, child] of Object.entries(current)) {
                size += key.length
                if (size > maxChars) break
                visit(child)
            }
            seen.delete(current)
        }
        if (size > maxChars) {
            throw new RangeError(`Isolated model response exceeds ${maxChars} characters`)
        }
    }
    visit(value)
}

/**
 * Owns every isolated call made during one run. It is intentionally not a host
 * service/capability: tools receive only a parent-tool-call-bound facade.
 */
export class RunScopedModelInvoker implements ToolModelInvokerOwner {
    private readonly runSignal: AbortSignal
    private readonly sessionId: string
    private readonly createSession: RunScopedModelInvokerOptions['createSession']
    private readonly generateId: () => string
    private readonly now: () => number
    private readonly maxConcurrent: number
    private readonly maxCalls: number
    private readonly allowedModels: ReadonlyMap<string, IsolatedModelRequest['model']>
    private readonly maxQueryChars: number
    private readonly maxInstructionsChars: number
    private readonly maxResponseChars: number
    private readonly sanitizeError: (error: unknown) => Error
    private readonly activeControllers = new Set<AbortController>()
    private readonly activeResources = new Map<AbortController, IsolatedProtocolSession>()
    private readonly tasks = new Set<Promise<unknown>>()
    private readonly waiters: Waiter[] = []
    private readonly records = new Map<string, IsolatedModelInvocationRecord[]>()
    private running = 0
    private calls = 0
    private closed = false

    constructor(options: RunScopedModelInvokerOptions) {
        this.runSignal = options.runSignal
        this.sessionId = options.sessionId
        this.createSession = options.createSession
        this.generateId = options.generateId ?? defaultId
        this.now = options.now ?? (() => Date.now())
        this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2))
        this.maxCalls = Math.max(1, Math.floor(options.maxCalls ?? 8))
        this.allowedModels = new Map(options.allowedModels.map((model) => [model.id, model]))
        this.maxQueryChars = Math.max(1, Math.floor(options.maxQueryChars ?? 64_000))
        this.maxInstructionsChars = Math.max(1, Math.floor(options.maxInstructionsChars ?? 32_000))
        this.maxResponseChars = Math.max(1, Math.floor(options.maxResponseChars ?? 1_000_000))
        this.sanitizeError = options.sanitizeError ?? ((error) => {
            if (error instanceof Error) return error
            return new Error(String(error ?? 'Isolated model invocation failed'))
        })
    }

    forToolCall(parentToolCallId: string): IsolatedModelInvoker {
        const id = String(parentToolCallId ?? '').trim()
        if (!id) throw new TypeError('parentToolCallId is required')
        return Object.freeze({
            invoke: (request: IsolatedModelRequest, signal?: AbortSignal) =>
                this.track(this.invoke(id, request, signal)),
        })
    }

    takeRecords(parentToolCallId: string): readonly IsolatedModelInvocationRecord[] {
        const found = this.records.get(parentToolCallId) ?? []
        this.records.delete(parentToolCallId)
        return found.map((record) => ({
            ...record,
            usage: cloneUsage(record.usage),
        }))
    }

    async close(): Promise<void> {
        if (!this.closed) {
            this.closed = true
            for (const waiter of this.waiters.splice(0)) {
                waiter.signal.removeEventListener('abort', waiter.onAbort)
                waiter.reject(abortError('Agent run ended'))
            }
            for (const controller of this.activeControllers) {
                controller.abort()
                const resource = this.activeResources.get(controller)
                try {
                    const cancelling = resource?.session.cancel?.('agent run ended')
                    if (cancelling && typeof (cancelling as Promise<void>).then === 'function') {
                        void Promise.resolve(cancelling).catch(() => undefined)
                    }
                } catch {
                    // Best-effort immediate transport cancellation; invoke() owns disposal.
                }
            }
        }
        await Promise.allSettled([...this.tasks])
    }

    private track<T>(promise: Promise<T>): Promise<T> {
        this.tasks.add(promise)
        void promise.finally(() => this.tasks.delete(promise)).catch(() => undefined)
        return promise
    }

    private async acquire(signal: AbortSignal): Promise<void> {
        if (this.closed || this.runSignal.aborted || signal.aborted) throw abortError()
        if (this.calls >= this.maxCalls) {
            throw new Error(`Isolated model invocation call limit exceeded (${this.maxCalls})`)
        }
        this.calls += 1
        if (this.running < this.maxConcurrent) {
            this.running += 1
            return
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                signal,
                resolve: () => {
                    signal.removeEventListener('abort', waiter.onAbort)
                    this.running += 1
                    resolve()
                },
                reject,
                onAbort: () => {
                    const index = this.waiters.indexOf(waiter)
                    if (index >= 0) this.waiters.splice(index, 1)
                    reject(abortError())
                },
            }
            signal.addEventListener('abort', waiter.onAbort, { once: true })
            this.waiters.push(waiter)
        })
    }

    private release(): void {
        this.running = Math.max(0, this.running - 1)
        while (!this.closed && this.waiters.length > 0) {
            const next = this.waiters.shift()!
            if (next.signal.aborted) continue
            next.resolve()
            break
        }
    }

    private async invoke(
        parentToolCallId: string,
        request: IsolatedModelRequest,
        requestSignal?: AbortSignal,
    ): Promise<AssistantEntry> {
        validateRequest(request, this.maxQueryChars, this.maxInstructionsChars)
        const canonicalModel = this.allowedModels.get(request.model.id)
        if (!canonicalModel) throw new TypeError('Isolated model is not authorized for this run')
        const linked = linkSignals([this.runSignal, requestSignal])
        const { controller } = linked
        let acquired = false
        let resource: IsolatedProtocolSession | undefined
        let iterator: AsyncIterator<any, any, any> | undefined
        try {
            await this.acquire(controller.signal)
            acquired = true
            this.activeControllers.add(controller)
            const invocationId = this.generateId()
            const isolatedSessionId = `${this.sessionId}:isolated:${invocationId}`
            if (this.closed || controller.signal.aborted) throw abortError()
            resource = await this.createSession({ invocationId, model: canonicalModel })
            this.activeResources.set(controller, resource)
            if (this.closed || controller.signal.aborted) throw abortError()

            const user: UserEntry = {
                id: this.generateId(),
                sessionId: isolatedSessionId,
                createdAt: this.now(),
                kind: 'user',
                content: [{ type: 'text', text: request.query }],
            }
            const seed: AssistantEntry = {
                id: this.generateId(),
                sessionId: isolatedSessionId,
                createdAt: this.now(),
                kind: 'assistant',
                model: canonicalModel.id,
                content: [],
                stopReason: 'pending',
                status: 'streaming',
            }
            const input = {
                model: canonicalModel,
                systemPrompt: request.instructions,
                entries: [user],
                seed,
                nativeTools: request.nativeTools,
                toolChoice: request.toolChoice,
            } as ProtocolStreamInput
            const options = {
                signal: controller.signal,
                connectionMode: 'isolated',
            } as ProtocolStreamOptions

            iterator = resource.session.stream(input, options)[Symbol.asyncIterator]()
            let final: AssistantEntry | undefined
            let streamFailure: Error | undefined
            let streamedChars = 0
            const recordUsage = (message: AssistantEntry | undefined) => {
                if (!message?.usage) return
                const records = this.records.get(parentToolCallId) ?? []
                const record = { id: invocationId, model: canonicalModel.id, parentToolCallId, usage: cloneUsage(message.usage) }
                const index = records.findIndex((item) => item.id === invocationId)
                if (index >= 0) records[index] = record
                else records.push(record)
                this.records.set(parentToolCallId, records)
            }
            while (true) {
                if (controller.signal.aborted || this.closed) throw abortError()
                const step = await raceSignal(iterator.next(), controller.signal)
                if (controller.signal.aborted || this.closed) throw abortError()
                if (step.done) {
                    if (step.value && typeof step.value === 'object') {
                        final = step.value as AssistantEntry
                    }
                    break
                }
                if (typeof step.value.delta === 'string') {
                    streamedChars += step.value.delta.length
                    if (streamedChars > this.maxResponseChars) throw new RangeError('Isolated model streamed response limit exceeded')
                }
                if (step.value.type === 'done') {
                    final = step.value.message
                    recordUsage(final)
                }
                if (step.value.type === 'error') {
                    final = step.value.error
                    recordUsage(final)
                    streamFailure = new Error(
                        step.value.error.errorMessage ?? 'Isolated model invocation failed',
                    )
                    break
                }
            }
            if (controller.signal.aborted || this.closed) throw abortError()
            if (!final) throw new Error('Isolated model stream ended without a final response')

            recordUsage(final)
            if (streamFailure) throw streamFailure
            assertBoundedValue(final, this.maxResponseChars)
            return final
        } catch (error) {
            throw this.sanitizeError(error)
        } finally {
            linked.unlink()
            this.activeControllers.delete(controller)
            this.activeResources.delete(controller)
            try {
                await resource?.session.cancel?.('isolated invocation complete')
            } catch {
                // Continue mandatory cleanup.
            }
            try {
                await iterator?.return?.()
            } catch {
                // Cancellation may make iterator cleanup reject; dispose still follows.
            }
            try {
                await resource?.session.dispose?.()
            } catch {
                // Continue mandatory cleanup.
            }
            try {
                await resource?.dispose?.()
            } catch {
                // Cleanup errors must not expose transport/auth details to plugins.
            }
            if (acquired) this.release()
        }
    }
}
