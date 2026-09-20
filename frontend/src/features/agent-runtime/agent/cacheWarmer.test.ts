import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
    CacheWarmer,
    getCacheWarmingDelayMs,
    type CacheWarmRequest,
} from './cacheWarmer.js'
import type { ProtocolStreamInput } from '@cpa/plugin-api'

function createFakeStreamInput(modelId = 'gpt-5.3-codex'): ProtocolStreamInput {
    return {
        model: { id: modelId } as any,
        systemPrompt: 'You are an agent.',
        entries: [],
        tools: [],
        seed: {} as any,
    }
}

describe('CacheWarmer', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    describe('getCacheWarmingDelayMs', () => {
        it('returns undefined for TTL <= 10,000ms', () => {
            expect(getCacheWarmingDelayMs(5000)).toBeUndefined()
            expect(getCacheWarmingDelayMs(10000)).toBeUndefined()
        })

        it('calculates delay at 90% while preserving at least 10s margin', () => {
            // 300,000ms (300s):
            // 300,000 * 0.9 = 270,000; 300,000 - 10,000 = 290,000; min is 270,000
            expect(getCacheWarmingDelayMs(300_000)).toBe(270_000)

            // 60,000ms (60s):
            // 60,000 * 0.9 = 54,000; 60,000 - 10,000 = 50,000; min is 50,000
            expect(getCacheWarmingDelayMs(60_000)).toBe(50_000)
        })
    })

    describe('lifecycle & scheduling', () => {
        it('stays inactive when warmingMode is off', () => {
            const streamFn = vi.fn()
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'off',
            })

            expect(warmer.status.state).toBe('inactive')

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => true)

            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('cache warming disabled')
            expect(streamFn).not.toHaveBeenCalled()
        })

        it('schedules warming in streaming mode and calls streamFn with maxOutputTokens: 1', async () => {
            const streamEvents = [{ type: 'done' }]
            const streamFn = vi.fn().mockImplementation(async function* () {
                for (const ev of streamEvents) {
                    yield ev
                }
            })

            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'streaming',
                now: () => 1000,
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => true)

            expect(warmer.status.state).toBe('scheduled')
            expect(warmer.status.nextWarmAt).toBe(1000 + 270_000)

            // Advance timer by 270,000ms
            await vi.advanceTimersByTimeAsync(270_000)

            expect(streamFn).toHaveBeenCalledTimes(1)
            expect(streamFn).toHaveBeenCalledWith(
                request.streamInput,
                expect.objectContaining({
                    maxOutputTokens: 1,
                    connectionMode: 'isolated',
                    promptCacheKey: 'session-1',
                }),
            )
        })

        it('stops warming when onAgentSettled is called in streaming mode', () => {
            const streamFn = vi.fn()
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'streaming',
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => true)
            expect(warmer.status.state).toBe('scheduled')

            warmer.onAgentSettled()

            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('agent run settled')
        })

        it('continues warming when onAgentSettled is called in idle mode until maxWarmingTime', async () => {
            const streamFn = vi.fn().mockImplementation(async function* () {
                yield { type: 'done' }
            })

            let currentTime = 0
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'idle',
                getMaxWarmingTimeMs: () => 600_000, // 10 minutes max
                now: () => currentTime,
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000, // 270s delay
            }

            warmer.start(request, () => true)
            expect(warmer.status.phase).toBe('streaming')

            warmer.onAgentSettled()
            expect(warmer.status.state).toBe('scheduled')
            expect(warmer.status.phase).toBe('idle')

            // First refresh after 270s
            currentTime += 270_000
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(1)
            expect(warmer.status.state).toBe('scheduled')

            // Second refresh after another 270s (total 540s < 600s max)
            currentTime += 270_000
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(2)

            // Third refresh attempt would be at 810s > 600s, should stop
            currentTime += 270_000
            await vi.advanceTimersByTimeAsync(270_000)
            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('max warming duration reached')
        })

        it('stops warming if conversation context changes', async () => {
            const streamFn = vi.fn().mockImplementation(async function* () {
                yield { type: 'done' }
            })

            let isCurrent = true
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'idle',
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => isCurrent)
            expect(warmer.status.state).toBe('scheduled')

            // Invalidate context
            isCurrent = false

            await vi.advanceTimersByTimeAsync(270_000)

            expect(streamFn).not.toHaveBeenCalled()
            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('conversation context changed')
        })

        it('cancel() cleans up active timer and resets state to inactive', () => {
            const streamFn = vi.fn()
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'idle',
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => true)
            expect(warmer.status.state).toBe('scheduled')

            warmer.cancel()

            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('cancelled')
        })

        it('catches stream errors silently without crashing (best-effort)', async () => {
            const streamFn = vi.fn().mockImplementation(async function* () {
                throw new Error('Network error during warming')
            })

            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'streaming',
            })

            const request: CacheWarmRequest = {
                sessionId: 'session-1',
                streamInput: createFakeStreamInput(),
                ttlMs: 300_000,
            }

            warmer.start(request, () => true)

            // Should not throw unhandled rejection
            await vi.advanceTimersByTimeAsync(270_000)

            expect(streamFn).toHaveBeenCalledTimes(1)
            // Still reschedules next refresh after transient failure
            expect(warmer.status.state).toBe('scheduled')
        })

        it('aborts hanging warm stream requests when request exceeds timeout', async () => {
            let receivedSignal: AbortSignal | undefined
            const streamFn = vi.fn().mockImplementation(async function* (_input, opts) {
                receivedSignal = opts.signal
                // Simulating a stream that never emits or yields
                await new Promise(() => {})
            })

            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'streaming',
            })

            warmer.start(
                {
                    sessionId: 'sess-hang',
                    streamInput: createFakeStreamInput(),
                    ttlMs: 300_000,
                },
                () => true,
            )

            // Advance to the refresh moment
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(1)
            expect(receivedSignal?.aborted).toBe(false)

            // Advance by timeout limit (60s)
            await vi.advanceTimersByTimeAsync(60_000)
            expect(receivedSignal?.aborted).toBe(true)
        })

        it('invokes onStopped callback when warming is stopped or cancelled', () => {
            const onStopped = vi.fn()
            const warmer = new CacheWarmer({
                streamFn: vi.fn(),
                getMode: () => 'streaming',
                onStopped,
            })

            warmer.start(
                {
                    sessionId: 'sess-stop',
                    streamInput: createFakeStreamInput(),
                    ttlMs: 300_000,
                },
                () => true,
            )

            expect(onStopped).not.toHaveBeenCalled()

            warmer.onAgentSettled() // in streaming mode, this stops warming
            expect(onStopped).toHaveBeenCalledTimes(1)

            warmer.cancel()
            expect(onStopped).toHaveBeenCalledTimes(2)
        })

        it('starts idle phase deadline at onAgentSettled rather than initial request start', async () => {
            const streamFn = vi.fn().mockImplementation(async function* () {
                yield { type: 'done' }
            })

            let currentTime = 0
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'idle',
                getMaxWarmingTimeMs: () => 300_000, // 5 min idle max
                now: () => currentTime,
            })

            // Agent runs for 10 minutes (600,000ms) with multiple streaming refreshes
            warmer.start(
                {
                    sessionId: 'sess-long',
                    streamInput: createFakeStreamInput(),
                    ttlMs: 300_000, // 270s delay
                },
                () => true,
            )

            currentTime += 600_000
            await vi.advanceTimersByTimeAsync(600_000)

            // Agent settles now (at t=600s)
            warmer.onAgentSettled()
            expect(warmer.status.state).toBe('scheduled')
            expect(warmer.status.phase).toBe('idle')

            // Advance by 270s: first idle refresh executes (total 3 refreshes).
            // Since next scheduled warm (at 540s into idle) would exceed 300s max idle time,
            // it transitions to inactive with 'max warming duration reached'.
            currentTime += 270_000
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(3) // 2 during streaming, 1 during idle
            expect(warmer.status.state).toBe('inactive')
            expect(warmer.status.reason).toBe('max warming duration reached')
        })

        it('tracks replaced in-flight requests and waits for both to completely drain before marking isDrained and calling onStopped', async () => {
            let resolveStream1!: () => void
            const stream1Promise = new Promise<void>((res) => {
                resolveStream1 = res
            })

            let resolveStream2!: () => void
            const stream2Promise = new Promise<void>((res) => {
                resolveStream2 = res
            })

            const streamFn = vi.fn()
                .mockImplementationOnce(async function* () {
                    await stream1Promise
                    yield { type: 'done' }
                })
                .mockImplementationOnce(async function* () {
                    await stream2Promise
                    yield { type: 'done' }
                })

            const onStopped = vi.fn()
            const warmer = new CacheWarmer({
                streamFn,
                getMode: () => 'streaming',
                onStopped,
            })

            // 1. Start Request 1
            warmer.start(
                {
                    sessionId: 'sess-drain',
                    streamInput: createFakeStreamInput('model-1'),
                    ttlMs: 300_000,
                },
                () => true,
            )

            // Trigger stream 1 refresh
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(1)

            // 2. While Request 1 is still in-flight, Request 2 replaces it with start()
            warmer.start(
                {
                    sessionId: 'sess-drain',
                    streamInput: createFakeStreamInput('model-2'),
                    ttlMs: 300_000,
                },
                () => true,
            )

            // Trigger stream 2 refresh
            await vi.advanceTimersByTimeAsync(270_000)
            expect(streamFn).toHaveBeenCalledTimes(2)

            // Now BOTH stream 1 and stream 2 are in-flight!
            // Call cancel()
            const cancelPromise = warmer.cancel()
            expect(warmer.status.state).toBe('inactive')
            expect(warmer.isDrained).toBe(false)
            expect(onStopped).not.toHaveBeenCalled()

            // Resolve Request 1: still waiting for Request 2
            resolveStream1()
            await Promise.resolve()
            expect(warmer.isDrained).toBe(false)
            expect(onStopped).not.toHaveBeenCalled()

            // Resolve Request 2: now all in-flight requests have drained!
            resolveStream2()
            await cancelPromise

            expect(warmer.isDrained).toBe(true)
            expect(onStopped).toHaveBeenCalledTimes(1)
        })
    })
})
