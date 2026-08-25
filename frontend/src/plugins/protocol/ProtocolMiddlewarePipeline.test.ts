import { describe, it, expect, vi } from 'vitest'
import { ProtocolMiddlewarePipeline } from './ProtocolMiddlewarePipeline'
import type { ProtocolMiddleware, ProtocolStreamInput, ProtocolStreamOptions } from '@cpa/plugin-api'
import type { AssistantStreamEvent } from '@/features/agent-runtime/agent/types'
import type { ModelCatalogEntry } from '@/features/models/types'
import type { AssistantEntry } from '@/features/agent-runtime/session/types'

function createMockInput(overrides: Partial<ProtocolStreamInput> = {}): ProtocolStreamInput {
    return {
        model: {
            id: 'test-model',
            label: 'Test Model',
            supportsFast: false,
            reasoningLevels: [],
            input: ['text'],
            contextWindow: 8192,
            maxTokens: 4096,
        } as ModelCatalogEntry,
        systemPrompt: 'initial system prompt',
        entries: [],
        seed: {
            id: 'assistant-1',
            role: 'assistant',
            status: 'streaming',
            content: [],
        } as unknown as AssistantEntry,
        ...overrides,
    }
}

function createTextDeltaEvent(delta: string, contentIndex = 0): AssistantStreamEvent {
    return {
        type: 'text-delta',
        contentIndex,
        delta,
        partial: {} as AssistantEntry,
    }
}

function createThinkingDeltaEvent(delta: string, contentIndex = 0): AssistantStreamEvent {
    return {
        type: 'thinking-delta',
        contentIndex,
        delta,
        partial: {} as AssistantEntry,
    }
}

describe('ProtocolMiddlewarePipeline', () => {
    describe('constructor & order sorting', () => {
        it('sorts middlewares by ascending order, defaulting undefined order to 100', async () => {
            const orderRecord: string[] = []

            const mwDefault: ProtocolMiddleware = {
                id: 'mw-default',
                onRequest: (input) => {
                    orderRecord.push('default')
                    return input
                },
            }
            const mwHighPriority: ProtocolMiddleware = {
                id: 'mw-high-priority',
                order: 10,
                onRequest: (input) => {
                    orderRecord.push('high')
                    return input
                },
            }
            const mwLowPriority: ProtocolMiddleware = {
                id: 'mw-low-priority',
                order: 200,
                onRequest: (input) => {
                    orderRecord.push('low')
                    return input
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([mwLowPriority, mwDefault, mwHighPriority])
            await pipeline.executeRequest(createMockInput())

            expect(orderRecord).toEqual(['high', 'default', 'low'])
        })
    })

    describe('executeRequest', () => {
        it('executes onRequest hooks in order and mutates input synchronously and asynchronously', async () => {
            const mw1: ProtocolMiddleware = {
                id: 'mw1',
                order: 10,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt} [mw1]`,
                }),
            }
            const mw2: ProtocolMiddleware = {
                id: 'mw2',
                order: 20,
                onRequest: async (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt} [mw2]`,
                }),
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw2, mw1])
            const initialInput = createMockInput({ systemPrompt: 'base' })
            const result = await pipeline.executeRequest(initialInput)

            expect(result.systemPrompt).toBe('base [mw1] [mw2]')
        })

        it('forwards options to onRequest hook', async () => {
            const receivedOptions: ProtocolStreamOptions[] = []
            const mw: ProtocolMiddleware = {
                id: 'mw-opt',
                onRequest: (input, options) => {
                    if (options) {
                        receivedOptions.push(options)
                    }
                    return input
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw])
            const options: ProtocolStreamOptions = { connectionMode: 'proxy', maxOutputTokens: 1000 }
            await pipeline.executeRequest(createMockInput(), options)

            expect(receivedOptions).toEqual([options])
        })

        it('isolates errors in onRequest and continues with subsequent middlewares', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

            const mwFailing: ProtocolMiddleware = {
                id: 'mw-failing',
                order: 10,
                onRequest: () => {
                    throw new Error('boom onRequest')
                },
            }
            const mwNext: ProtocolMiddleware = {
                id: 'mw-next',
                order: 20,
                onRequest: (input) => ({
                    ...input,
                    systemPrompt: `${input.systemPrompt} [mw-next]`,
                }),
            }

            const pipeline = new ProtocolMiddlewarePipeline([mwFailing, mwNext])
            const initialInput = createMockInput({ systemPrompt: 'base' })
            const result = await pipeline.executeRequest(initialInput)

            expect(result.systemPrompt).toBe('base [mw-next]')
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('[ProtocolMiddlewarePipeline] Error in onRequest for middleware "mw-failing":'),
                expect.any(Error)
            )

            consoleSpy.mockRestore()
        })

        it('returns input untouched when no middlewares are registered', async () => {
            const pipeline = new ProtocolMiddlewarePipeline()
            const initialInput = createMockInput({ systemPrompt: 'untouched' })
            const result = await pipeline.executeRequest(initialInput)

            expect(result).toBe(initialInput)
        })
    })

    describe('executeStream', () => {
        it('returns source directly without wrapping when middlewares is empty', () => {
            const pipeline = new ProtocolMiddlewarePipeline([])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('direct')
            }
            const sourceStream = source()
            const resultStream = pipeline.executeStream(sourceStream, { sessionId: 's1', model: 'm1' })
            expect(resultStream).toBe(sourceStream)
        })

        it('intercepts and modifies stream events in order', async () => {
            const mw1: ProtocolMiddleware = {
                id: 'mw1',
                order: 1,
                onStreamEvent: (event) => {
                    if (event.type === 'text-delta') {
                        return { ...event, delta: `${event.delta}!` }
                    }
                    return event
                },
            }
            const mw2: ProtocolMiddleware = {
                id: 'mw2',
                order: 2,
                onStreamEvent: (event) => {
                    if (event.type === 'text-delta') {
                        return { ...event, delta: event.delta.toUpperCase() }
                    }
                    return event
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw2, mw1])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('hello')
                yield createTextDeltaEvent('world')
            }

            const collected: AssistantStreamEvent[] = []
            for await (const ev of pipeline.executeStream(source(), { sessionId: 's1', model: 'm1' })) {
                collected.push(ev)
            }

            expect(collected).toEqual([
                createTextDeltaEvent('HELLO!'),
                createTextDeltaEvent('WORLD!'),
            ])
        })

        it('filters out events when onStreamEvent returns null and prevents downstream middlewares from seeing it', async () => {
            const downstreamSpy = vi.fn()

            const filterMw: ProtocolMiddleware = {
                id: 'filter-mw',
                order: 10,
                onStreamEvent: (event) => {
                    if (event.type === 'thinking-delta') {
                        return null
                    }
                    return event
                },
            }

            const downstreamMw: ProtocolMiddleware = {
                id: 'downstream-mw',
                order: 20,
                onStreamEvent: (event) => {
                    downstreamSpy(event)
                    return event
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([filterMw, downstreamMw])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createThinkingDeltaEvent('thinking...')
                yield createTextDeltaEvent('actual response')
            }

            const collected: AssistantStreamEvent[] = []
            for await (const ev of pipeline.executeStream(source(), { sessionId: 's1', model: 'm1' })) {
                collected.push(ev)
            }

            expect(collected).toEqual([
                createTextDeltaEvent('actual response'),
            ])
            expect(downstreamSpy).toHaveBeenCalledTimes(1)
            expect(downstreamSpy).toHaveBeenCalledWith(createTextDeltaEvent('actual response'))
        })

        it('passes context { sessionId, model } to onStreamEvent', async () => {
            const contextSpy = vi.fn()
            const mw: ProtocolMiddleware = {
                id: 'context-mw',
                onStreamEvent: (event, context) => {
                    contextSpy(context)
                    return event
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('hi')
            }

            for await (const _ev of pipeline.executeStream(source(), { sessionId: 'sess-123', model: 'gpt-4o' })) {
                // consume stream
            }

            expect(contextSpy).toHaveBeenCalledWith({ sessionId: 'sess-123', model: 'gpt-4o' })
        })

        it('isolates errors in onStreamEvent and yields event without breaking the stream', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

            const mwFailing: ProtocolMiddleware = {
                id: 'mw-failing',
                onStreamEvent: () => {
                    throw new Error('boom onStreamEvent')
                },
            }

            const pipeline = new ProtocolMiddlewarePipeline([mwFailing])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('hello')
            }

            const collected: AssistantStreamEvent[] = []
            for await (const ev of pipeline.executeStream(source(), { sessionId: 's1', model: 'm1' })) {
                collected.push(ev)
            }

            expect(collected).toEqual([
                createTextDeltaEvent('hello'),
            ])
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('[ProtocolMiddlewarePipeline] Error in onStreamEvent for middleware "mw-failing":'),
                expect.any(Error)
            )

            consoleSpy.mockRestore()
        })

        it('triggers onStreamComplete with elapsedMs on successful stream completion', async () => {
            const completeSpy = vi.fn()
            const mw: ProtocolMiddleware = {
                id: 'complete-mw',
                onStreamComplete: completeSpy,
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('content')
            }

            for await (const _ev of pipeline.executeStream(source(), { sessionId: 's1', model: 'm1' })) {
                // consume stream
            }

            expect(completeSpy).toHaveBeenCalledTimes(1)
            expect(completeSpy).toHaveBeenCalledWith({
                elapsedMs: expect.any(Number),
                error: undefined,
            })
            expect(completeSpy.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(0)
        })

        it('triggers onStreamComplete with error and rethrows when source throws', async () => {
            const completeSpy = vi.fn()
            const mw: ProtocolMiddleware = {
                id: 'complete-mw',
                onStreamComplete: completeSpy,
            }

            const pipeline = new ProtocolMiddlewarePipeline([mw])
            async function* errorSource(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('start')
                throw new Error('source stream failure')
            }

            const iterator = pipeline.executeStream(errorSource(), { sessionId: 's1', model: 'm1' })
            const collected: AssistantStreamEvent[] = []

            await expect(async () => {
                for await (const ev of iterator) {
                    collected.push(ev)
                }
            }).rejects.toThrow('source stream failure')

            expect(collected).toEqual([createTextDeltaEvent('start')])
            expect(completeSpy).toHaveBeenCalledTimes(1)
            expect(completeSpy).toHaveBeenCalledWith({
                elapsedMs: expect.any(Number),
                error: expect.objectContaining({ message: 'source stream failure' }),
            })
        })

        it('isolates errors in onStreamComplete so remaining middlewares are still invoked', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            const completeSpy2 = vi.fn()

            const mwFailingComplete: ProtocolMiddleware = {
                id: 'mw-fail-complete',
                order: 10,
                onStreamComplete: () => {
                    throw new Error('boom onStreamComplete')
                },
            }
            const mwSuccessComplete: ProtocolMiddleware = {
                id: 'mw-success-complete',
                order: 20,
                onStreamComplete: completeSpy2,
            }

            const pipeline = new ProtocolMiddlewarePipeline([mwFailingComplete, mwSuccessComplete])
            async function* source(): AsyncIterable<AssistantStreamEvent> {
                yield createTextDeltaEvent('done')
            }

            for await (const _ev of pipeline.executeStream(source(), { sessionId: 's1', model: 'm1' })) {
                // consume stream
            }

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('[ProtocolMiddlewarePipeline] Error in onStreamComplete for middleware "mw-fail-complete":'),
                expect.any(Error)
            )
            expect(completeSpy2).toHaveBeenCalledTimes(1)

            consoleSpy.mockRestore()
        })
    })
})
