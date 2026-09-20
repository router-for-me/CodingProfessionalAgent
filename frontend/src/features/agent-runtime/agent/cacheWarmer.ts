import type { CacheWarmingMode, ProtocolStreamInput } from '@cpa/plugin-api'

/** Maximum streaming warming safety window while an agent run remains active (1 hour). */
const MAX_STREAMING_WARMING_AGE_MS = 60 * 60_000

/** Maximum single refresh request timeout (60 seconds). */
const MAX_REFRESH_TIMEOUT_MS = 60_000

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
    if (ttlMs <= 10_000) return undefined
    return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)))
}

export interface CacheWarmRequest {
    sessionId: string
    streamInput: ProtocolStreamInput
    ttlMs: number
}

export interface CacheWarmingStatus {
    state: 'inactive' | 'scheduled' | 'refreshing'
    reason?: string
    nextWarmAt?: number
    phase?: 'streaming' | 'idle'
}

export interface CacheWarmerStreamOptions {
    signal: AbortSignal
    maxOutputTokens: number
    connectionMode?: 'isolated'
    promptCacheKey?: string
}

export interface CacheWarmerOptions {
    streamFn: (
        input: ProtocolStreamInput,
        options: CacheWarmerStreamOptions,
    ) => AsyncIterable<any>
    getMode: () => CacheWarmingMode
    getMaxWarmingTimeMs?: () => number
    now?: () => number
    onStopped?: () => void
}

interface ActiveRun {
    sessionId: string
    streamInput: ProtocolStreamInput
    ttlMs: number
    delayMs: number
    startedAt: number
    idleStartedAt?: number
    phase: 'streaming' | 'idle'
    nextWarmAt: number
    timer?: any
    controller: AbortController
    isCurrent: () => boolean
}

export class CacheWarmer {
    private run?: ActiveRun
    private inactive: CacheWarmingStatus
    private readonly streamFn: CacheWarmerOptions['streamFn']
    private readonly getMode: () => CacheWarmingMode
    private readonly getMaxWarmingTimeMs: () => number
    private readonly now: () => number
    private readonly onStopped?: () => void
    private readonly inFlightRefreshes = new Set<Promise<void>>()

    constructor(options: CacheWarmerOptions) {
        this.streamFn = options.streamFn
        this.getMode = options.getMode
        this.getMaxWarmingTimeMs = options.getMaxWarmingTimeMs ?? (() => 3600_000)
        this.now = options.now ?? Date.now
        this.onStopped = options.onStopped
        this.inactive = { state: 'inactive', reason: 'waiting for request' }
    }

    get status(): CacheWarmingStatus {
        const mode = this.getMode()
        if (mode === 'off') {
            return { state: 'inactive', reason: 'cache warming disabled' }
        }
        const run = this.run
        if (!run) {
            return this.inactive
        }
        if (!run.isCurrent()) {
            return { state: 'inactive', reason: 'conversation context changed' }
        }
        const refreshing = run.timer === undefined
        return {
            state: refreshing ? 'refreshing' : 'scheduled',
            nextWarmAt: run.nextWarmAt,
            phase: run.phase,
        }
    }

    start(request: CacheWarmRequest, isCurrent: () => boolean): void {
        this.clearRun()
        const mode = this.getMode()
        if (mode === 'off') {
            this.stop('cache warming disabled')
            return
        }

        const delayMs = getCacheWarmingDelayMs(request.ttlMs)
        if (delayMs === undefined) {
            this.stop('cache lifetime unavailable or too short')
            return
        }

        const run: ActiveRun = {
            sessionId: request.sessionId,
            streamInput: request.streamInput,
            ttlMs: request.ttlMs,
            delayMs,
            startedAt: this.now(),
            phase: 'streaming',
            nextWarmAt: 0,
            controller: new AbortController(),
            isCurrent,
        }
        this.run = run
        this.schedule(run)
    }

    onAgentSettled(): void {
        const run = this.run
        if (!run) return

        const mode = this.getMode()
        if (mode === 'streaming') {
            this.stop('agent run settled')
            return
        }
        if (mode === 'off') {
            this.stop('cache warming disabled')
            return
        }

        run.phase = 'idle'
        run.idleStartedAt = this.now()
        const maxIdleTimeMs = this.getMaxWarmingTimeMs()
        const deadline = run.idleStartedAt + maxIdleTimeMs
        if (run.nextWarmAt > deadline || this.now() >= deadline) {
            this.stop('max warming duration reached')
        }
    }

    get isDrained(): boolean {
        return this.inFlightRefreshes.size === 0 && this.status.state === 'inactive'
    }

    async waitForDrained(): Promise<void> {
        while (this.inFlightRefreshes.size > 0) {
            await Promise.allSettled(Array.from(this.inFlightRefreshes))
        }
    }

    async cancel(): Promise<void> {
        this.stop('cancelled')
        await this.waitForDrained()
    }

    private clearRun(): void {
        const run = this.run
        if (!run) return
        this.run = undefined
        if (run.timer) {
            clearTimeout(run.timer)
        }
        run.controller.abort()
    }

    private stop(reason: string): void {
        const prevPhase = this.run?.phase
        this.clearRun()
        this.inactive = { state: 'inactive', reason, phase: prevPhase }
        const notifyStopped = () => {
            try {
                this.onStopped?.()
            } catch {
                // Guard callback failures
            }
        }
        if (this.inFlightRefreshes.size > 0) {
            void this.waitForDrained().then(notifyStopped)
        } else {
            notifyStopped()
        }
    }

    private schedule(run: ActiveRun): void {
        const nowTime = this.now()
        run.nextWarmAt = nowTime + run.delayMs

        if (run.phase === 'idle') {
            const idleBaseline = run.idleStartedAt ?? nowTime
            const maxIdleTimeMs = this.getMaxWarmingTimeMs()
            const idleDeadline = idleBaseline + maxIdleTimeMs
            if (run.nextWarmAt > idleDeadline || nowTime >= idleDeadline) {
                this.stop('max warming duration reached')
                return
            }
        } else {
            const streamingDeadline = run.startedAt + MAX_STREAMING_WARMING_AGE_MS
            if (run.nextWarmAt > streamingDeadline || nowTime >= streamingDeadline) {
                this.stop('streaming safety limit reached')
                return
            }
        }

        const waitMs = Math.max(0, run.nextWarmAt - nowTime)
        if (run.timer) {
            clearTimeout(run.timer)
        }
        run.timer = setTimeout(() => {
            void this.refresh(run)
        }, waitMs)

        if (typeof run.timer?.unref === 'function') {
            run.timer.unref()
        }
    }

    private async refresh(run: ActiveRun): Promise<void> {
        run.timer = undefined
        if (!this.validateRun(run)) {
            return
        }

        // Bounded in-flight timeout to prevent indefinite hangs
        const nowTime = this.now()
        const remainingIdleMs = run.phase === 'idle'
            ? Math.max(1000, (run.idleStartedAt ?? nowTime) + this.getMaxWarmingTimeMs() - nowTime)
            : MAX_REFRESH_TIMEOUT_MS
        const timeoutMs = Math.min(MAX_REFRESH_TIMEOUT_MS, remainingIdleMs)

        let refreshTimeout: ReturnType<typeof setTimeout> | undefined
        const refreshController = new AbortController()

        const onRunAbort = (): void => {
            refreshController.abort(run.controller.signal.reason)
        }
        run.controller.signal.addEventListener('abort', onRunAbort, { once: true })

        refreshTimeout = setTimeout(() => {
            refreshController.abort('warm request timed out')
        }, timeoutMs)
        if (typeof refreshTimeout?.unref === 'function') {
            refreshTimeout.unref()
        }

        const executeRefresh = async () => {
            try {
                const stream = this.streamFn(run.streamInput, {
                    signal: refreshController.signal,
                    maxOutputTokens: 1,
                    connectionMode: 'isolated',
                    promptCacheKey: run.sessionId,
                })
                for await (const _ of stream) {
                    // Best effort drain single-token warm response
                }
            } catch {
                // Cache warming is best-effort and must not throw or disrupt agent
            } finally {
                if (refreshTimeout !== undefined) {
                    clearTimeout(refreshTimeout)
                }
                run.controller.signal.removeEventListener('abort', onRunAbort)
            }
        }

        const promise = executeRefresh()
        this.inFlightRefreshes.add(promise)
        try {
            await promise
        } finally {
            this.inFlightRefreshes.delete(promise)
        }

        if (this.run === run && this.validateRun(run)) {
            this.schedule(run)
        }
    }

    private validateRun(run: ActiveRun): boolean {
        if (this.run !== run) {
            return false
        }
        const mode = this.getMode()
        if (mode === 'off') {
            this.stop('cache warming disabled')
            return false
        }
        if (mode === 'streaming' && run.phase === 'idle') {
            this.stop('agent run settled')
            return false
        }
        if (!run.isCurrent()) {
            this.stop('conversation context changed')
            return false
        }
        return true
    }
}
