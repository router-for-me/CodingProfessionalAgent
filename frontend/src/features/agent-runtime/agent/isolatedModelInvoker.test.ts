import { describe, expect, it, vi } from 'vitest'
import type {
    AssistantEntry,
    ModelCatalogEntry,
    ProtocolSession,
    ProtocolStreamInput,
    ProtocolStreamOptions,
    Usage,
} from '@cpa/plugin-api'
import { RunScopedModelInvoker } from './isolatedModelInvoker'

const model: ModelCatalogEntry = {
    id: 'search-model',
    label: 'Search Model',
    supportsFast: false,
    reasoningLevels: [],
    input: ['text'],
    contextWindow: 32_000,
    maxTokens: 4_096,
}

const usage: Usage = {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 18,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
}

function completed(seed: AssistantEntry): AssistantEntry {
    return {
        ...seed,
        content: [{ type: 'text', text: 'result' }],
        usage,
        stopReason: 'stop',
        status: 'done',
    }
}

describe('RunScopedModelInvoker', () => {
    it('sends only the isolated query, records usage under the parent call, and cleans up', async () => {
        const seen: Array<{ input: ProtocolStreamInput; options?: ProtocolStreamOptions }> = []
        const cancel = vi.fn()
        const sessionDispose = vi.fn()
        const transportDispose = vi.fn()
        const session: ProtocolSession = {
            async *stream(input, options) {
                seen.push({ input, options })
                const message = completed(input.seed)
                yield { type: 'done', reason: 'stop', message }
            },
            cancel,
            dispose: sessionDispose,
        }
        const run = new AbortController()
        let sequence = 0
        const owner = new RunScopedModelInvoker({
            runSignal: run.signal,
            sessionId: 'parent-session',
            allowedModels: [model],
            generateId: () => `id-${++sequence}`,
            createSession: () => ({ session, dispose: transportDispose }),
        })

        const response = await owner.forToolCall('call_A').invoke({
            model,
            query: 'current facts',
            instructions: 'Use untrusted references.',
            nativeTools: [{ type: 'web_search' }],
            toolChoice: 'required',
        })

        expect(response.content).toEqual([{ type: 'text', text: 'result' }])
        expect(seen).toHaveLength(1)
        expect(seen[0]?.input.systemPrompt).toBe('Use untrusted references.')
        expect(seen[0]?.input.entries).toHaveLength(1)
        expect(seen[0]?.input.entries[0]).toMatchObject({
            kind: 'user',
            content: [{ type: 'text', text: 'current facts' }],
        })
        expect(seen[0]?.input.tools).toBeUndefined()
        expect((seen[0]?.input as any).nativeTools).toEqual([{ type: 'web_search' }])
        expect((seen[0]?.input as any).toolChoice).toBe('required')
        expect(seen[0]?.options?.connectionMode).toBe('isolated')
        expect(owner.takeRecords('call_A')).toEqual([
            expect.objectContaining({
                model: 'search-model',
                parentToolCallId: 'call_A',
                usage,
            }),
        ])
        expect(owner.takeRecords('call_A')).toEqual([])
        expect(cancel).toHaveBeenCalledOnce()
        expect(sessionDispose).toHaveBeenCalledOnce()
        expect(transportDispose).toHaveBeenCalledOnce()
        await owner.close()
    })

    it('binds parent cancellation, waits for late cleanup, and rejects use after the run', async () => {
        const run = new AbortController()
        let streamSignal: AbortSignal | undefined
        let releaseDispose!: () => void
        const disposeGate = new Promise<void>((resolve) => {
            releaseDispose = resolve
        })
        const transportDispose = vi.fn(() => disposeGate)
        const session: ProtocolSession = {
            async *stream(_input, options) {
                streamSignal = options?.signal
                await new Promise<void>((resolve) => {
                    options?.signal?.addEventListener('abort', () => resolve(), { once: true })
                })
                throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            },
            cancel: vi.fn(),
            dispose: vi.fn(),
        }
        const owner = new RunScopedModelInvoker({
            runSignal: run.signal,
            sessionId: 'parent-session',
            allowedModels: [model],
            createSession: () => ({ session, dispose: transportDispose }),
        })
        const invocation = owner.forToolCall('call_A').invoke({
            model,
            query: 'query',
            instructions: 'instructions',
        })
        await vi.waitFor(() => expect(streamSignal).toBeDefined())

        run.abort()
        const closing = owner.close()
        expect(streamSignal?.aborted).toBe(true)
        let closed = false
        void closing.then(() => { closed = true })
        await Promise.resolve()
        expect(closed).toBe(false)
        releaseDispose()
        await expect(invocation).rejects.toMatchObject({ name: 'AbortError' })
        await closing
        expect(transportDispose).toHaveBeenCalledOnce()

        await expect(owner.forToolCall('call_B').invoke({
            model,
            query: 'late',
            instructions: 'late',
        })).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('bounds concurrency and call budget, removes queued abort listeners', async () => {
        const run = new AbortController()
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
        let streams = 0
        const session: ProtocolSession = {
            async *stream(input) {
                streams += 1
                if (streams === 1) await firstGate
                yield { type: 'done', reason: 'stop', message: completed(input.seed) }
            },
            cancel: vi.fn(),
        }
        const owner = new RunScopedModelInvoker({
            runSignal: run.signal,
            sessionId: 'parent-session',
            allowedModels: [model],
            maxConcurrent: 1,
            maxCalls: 2,
            createSession: () => ({ session }),
        })
        const request = { model, query: 'q', instructions: 'i' }
        const first = owner.forToolCall('one').invoke(request)
        await vi.waitFor(() => expect(streams).toBe(1))

        const queuedController = new AbortController()
        const add = vi.spyOn(queuedController.signal, 'addEventListener')
        const remove = vi.spyOn(queuedController.signal, 'removeEventListener')
        const queued = owner.forToolCall('two').invoke(request, queuedController.signal)
        queuedController.abort()
        await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
        expect(add).toHaveBeenCalled()
        expect(remove).toHaveBeenCalled()
        await expect(owner.forToolCall('three').invoke(request)).rejects.toThrow('call limit')

        releaseFirst()
        await first
        await owner.close()
    })

    it('cancels transport and awaits iterator return cleanup before close resolves', async () => {
        const run = new AbortController()
        let releaseNext!: () => void
        const nextGate = new Promise<void>((resolve) => { releaseNext = resolve })
        let releaseReturn!: () => void
        const returnGate = new Promise<void>((resolve) => { releaseReturn = resolve })
        const iterator = {
            next: vi.fn(() => nextGate.then(() => ({ done: true, value: undefined }))),
            return: vi.fn(() => returnGate.then(() => ({ done: true, value: undefined }))),
        }
        const cancel = vi.fn(() => { releaseNext() })
        const session = {
            stream: () => ({ [Symbol.asyncIterator]: () => iterator }),
            cancel,
            dispose: vi.fn(),
        } as unknown as ProtocolSession
        const owner = new RunScopedModelInvoker({
            runSignal: run.signal,
            sessionId: 'parent-session',
            allowedModels: [model],
            createSession: () => ({ session }),
        })
        const invocation = owner.forToolCall('one').invoke({ model, query: 'q', instructions: 'i' })
        await vi.waitFor(() => expect(iterator.next).toHaveBeenCalled())
        run.abort()
        const closing = owner.close()
        await vi.waitFor(() => expect(iterator.return).toHaveBeenCalledOnce())
        let closed = false
        void closing.then(() => { closed = true })
        await Promise.resolve()
        expect(closed).toBe(false)
        releaseReturn()
        await expect(invocation).rejects.toMatchObject({ name: 'AbortError' })
        await closing
        expect(cancel).toHaveBeenCalled()
    })

    it('retains terminal usage once when cancellation interrupts iterator cleanup', async () => {
        const run = new AbortController()
        let reachedTail!: () => void
        const tail = new Promise<void>((resolve) => { reachedTail = resolve })
        const session: ProtocolSession = {
            async *stream(input, options) {
                yield { type: 'done', reason: 'stop', message: completed(input.seed) }
                reachedTail()
                await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
            },
        }
        const owner = new RunScopedModelInvoker({ runSignal: run.signal, sessionId: 'parent', allowedModels: [model], createSession: () => ({ session }) })
        const pending = owner.forToolCall('call_A').invoke({ model, query: 'query', instructions: 'instructions' })
        await tail
        run.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(owner.takeRecords('call_A')).toEqual([expect.objectContaining({ usage })])
        expect(owner.takeRecords('call_A')).toEqual([])
        await owner.close()
    })

    it('stops excessive streamed deltas without waiting for a terminal response', async () => {
        const cleaned = vi.fn()
        const session: ProtocolSession = {
            async *stream(input) {
                try {
                    yield { type: 'text-delta', delta: 'too much streamed text', contentIndex: 0, partial: input.seed }
                    throw new Error('Must stop before this step')
                } finally { cleaned() }
            },
        }
        const owner = new RunScopedModelInvoker({ runSignal: new AbortController().signal, sessionId: 'parent', allowedModels: [model], maxResponseChars: 10, createSession: () => ({ session }) })
        await expect(owner.forToolCall('call_A').invoke({ model, query: 'query', instructions: 'instructions' })).rejects.toThrow('streamed response limit')
        expect(cleaned).toHaveBeenCalledOnce()
        await owner.close()
    })

    it('uses canonical authorized models and rejects oversized input and response metadata', async () => {
        const canonical = Object.freeze({ ...model, label: 'Canonical' })
        let seenModel: ModelCatalogEntry | undefined
        const session: ProtocolSession = {
            async *stream(input) {
                seenModel = input.model
                yield { type: 'done', reason: 'stop', message: { ...completed(input.seed), metadata: 'x'.repeat(100) } as any }
            },
        }
        const owner = new RunScopedModelInvoker({
            runSignal: new AbortController().signal,
            sessionId: 'parent-session',
            allowedModels: [canonical],
            maxQueryChars: 4,
            maxResponseChars: 50,
            createSession: () => ({ session }),
        })
        const invoker = owner.forToolCall('one')
        await expect(invoker.invoke({ model: { ...model, id: 'other' }, query: 'q', instructions: 'i' }))
            .rejects.toThrow('not authorized')
        await expect(invoker.invoke({ model, query: '12345', instructions: 'i' }))
            .rejects.toThrow('query exceeds')
        await expect(invoker.invoke({ model: { ...model, label: 'Forged' }, query: 'q', instructions: 'i' }))
            .rejects.toThrow('response exceeds')
        expect(seenModel).toBe(canonical)
        await owner.close()
    })
})
