import type { AssistantStreamEvent } from '@/features/agent-runtime/agent/types'
import type { ProtocolMiddleware, ProtocolStreamInput, ProtocolStreamOptions } from '@cpa/plugin-api'

export class ProtocolMiddlewarePipeline {
    private sortedMiddlewares: readonly ProtocolMiddleware[]

    constructor(middlewares: readonly ProtocolMiddleware[] = []) {
        this.sortedMiddlewares = [...middlewares].sort(
            (a, b) => (a.order ?? 100) - (b.order ?? 100)
        )
    }

    public async executeRequest(
        input: ProtocolStreamInput,
        options?: ProtocolStreamOptions
    ): Promise<ProtocolStreamInput> {
        let current = input
        for (const mw of this.sortedMiddlewares) {
            if (mw.onRequest) {
                try {
                    const result = await mw.onRequest(current, options)
                    if (result !== undefined) {
                        current = result
                    }
                } catch (err) {
                    console.error(
                        `[ProtocolMiddlewarePipeline] Error in onRequest for middleware "${mw.id}":`,
                        err
                    )
                }
            }
        }
        return current
    }

    public executeStream(
        source: AsyncIterable<AssistantStreamEvent>,
        context: { sessionId: string; model: string }
    ): AsyncIterable<AssistantStreamEvent> {
        if (this.sortedMiddlewares.length === 0) {
            return source
        }
        return this.wrapStream(source, context)
    }

    private async *wrapStream(
        source: AsyncIterable<AssistantStreamEvent>,
        context: { sessionId: string; model: string }
    ): AsyncGenerator<AssistantStreamEvent, unknown, unknown> {
        const start = Date.now()
        let streamError: Error | undefined
        let completed = false
        let lastDoneMessage: unknown = undefined

        const emitComplete = (error?: Error): void => {
            if (completed) return
            completed = true
            const elapsedMs = Date.now() - start
            for (const mw of this.sortedMiddlewares) {
                if (mw.onStreamComplete) {
                    try {
                        mw.onStreamComplete({ elapsedMs, error })
                    } catch (err) {
                        console.error(
                            `[ProtocolMiddlewarePipeline] Error in onStreamComplete for middleware "${mw.id}":`,
                            err
                        )
                    }
                }
            }
        }

        const iterator: AsyncIterator<AssistantStreamEvent> =
            source[Symbol.asyncIterator]()

        try {
            while (true) {
                const next = await iterator.next()
                if (next.done) {
                    return lastDoneMessage !== undefined
                        ? lastDoneMessage
                        : next.value
                }

                let event: AssistantStreamEvent | null | void = next.value
                for (const mw of this.sortedMiddlewares) {
                    if (mw.onStreamEvent && event) {
                        try {
                            const result = mw.onStreamEvent(event, context)
                            if (result === null) {
                                event = null
                                break
                            } else if (result !== undefined) {
                                event = result
                            }
                        } catch (err) {
                            console.error(
                                `[ProtocolMiddlewarePipeline] Error in onStreamEvent for middleware "${mw.id}":`,
                                err
                            )
                        }
                    }
                }
                if (event) {
                    if (event.type === 'done') {
                        lastDoneMessage = event.message
                    }
                    yield event
                }
            }
        } catch (err) {
            streamError = err instanceof Error ? err : new Error(String(err))
            throw err
        } finally {
            if (typeof iterator.return === 'function') {
                try {
                    void Promise.resolve(iterator.return()).catch(() => {})
                } catch {
                    // Ignore return errors
                }
            }
            emitComplete(streamError)
        }
    }
}
