import type {
    ActiveRunInfo,
    NativeBridge,
    NativeBridgeBindings,
    NativeDirEntry,
    NativeEvent,
    NativeEventSource,
    NativeOperation,
    NativeStat,
    ProcessOperation,
    ProcessStartInput,
    RuntimeInfo,
    SaveFileInput,
    SaveFileResult,
    SessionDelegateRunRequest,
    WebSocketOpenInput,
} from './types'
import { isTerminalEventKind } from './types'
import type { ElectronBridgeApi } from '../../../../../src/shared/types.js'
import { getHostBridge, subscribeHostNativeEvents } from '@/application/services/hostTransport'

/**
 * Convert binary data to standard base64 without relying on Node Buffer.
 * Chunks String.fromCharCode to stay under call-stack / argument limits.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, offset + chunkSize)
        binary += String.fromCharCode(...slice)
    }
    return btoa(binary)
}

/** Decode standard base64 into raw bytes without Node Buffer. */
export function base64ToBytes(dataBase64: string): Uint8Array {
    const binary = atob(dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes
}

/**
 * Map lookPath "not found" failures to null.
 * Matches wrapped messages such as:
 *   look path "x": executable file not found in $PATH
 *   look path "x": executable file not found in %PATH%
 *   look path "x": executable file not found in $path
 */
export function isExecutableNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /executable file not found/i.test(message)
}

type Waiter = {
    resolve: (result: IteratorResult<NativeEvent>) => void
    reject: (error: unknown) => void
}

class OperationQueue {
    private readonly buffer: NativeEvent[] = []
    private readonly waiters: Waiter[] = []
    private nextSequence = 1
    private terminal = false
    private closed = false
    private iteratorTaken = false
    private failure: unknown | undefined
    private terminalDelivered = false

    constructor(
        readonly operationId: string,
        private readonly onRelease: () => void,
    ) {}

    /** True when terminal, failed, or closed — abort must never arm/cancel. */
    get isSettled(): boolean {
        return this.closed || this.terminal || this.failure !== undefined
    }

    /** Accept only the next expected sequence; ignore duplicates, gaps, and late events. */
    push(event: NativeEvent): boolean {
        if (this.closed || this.terminal || this.failure !== undefined) {
            return false
        }
        if (event.sequence !== this.nextSequence) {
            return false
        }
        this.nextSequence += 1
        if (isTerminalEventKind(event.kind)) {
            this.terminal = true
        }

        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            waiter.resolve({ value: event, done: false })
            // Terminal wakes one waiter with the event; remaining waiters resolve done (FIFO).
            if (isTerminalEventKind(event.kind)) {
                this.resolveWaitersDone()
            }
            return true
        }
        this.buffer.push(event)
        return true
    }

    close(): void {
        if (this.closed) {
            return
        }
        this.closed = true
        this.buffer.length = 0
        this.resolveWaitersDone()
        this.onRelease()
    }

    /**
     * Fail the queue while preserving any already-buffered events.
     * Consumers drain the FIFO buffer first; later next() calls reject.
     * Late failure must not overwrite an accepted terminal.
     */
    fail(error: unknown): void {
        if (this.closed || this.failure !== undefined || this.terminal) {
            return
        }
        this.failure = error
        if (this.buffer.length > 0) {
            // Keep buffered events; future next() drains then rejects.
            return
        }
        // No buffered events: reject every pending waiter and release.
        this.closed = true
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            waiter.reject(error)
        }
        this.onRelease()
    }

    private resolveWaitersDone(): void {
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            if (this.failure !== undefined) {
                waiter.reject(this.failure)
            } else {
                waiter.resolve({ value: undefined as unknown as NativeEvent, done: true })
            }
        }
    }

    createIterator(): AsyncIterator<NativeEvent> {
        if (this.iteratorTaken) {
            throw new Error(`operation ${this.operationId} already has a single consumer`)
        }
        this.iteratorTaken = true

        const self = this
        let finished = false

        const finish = (): IteratorResult<NativeEvent> => {
            finished = true
            if (!self.closed) {
                self.close()
            }
            if (self.failure !== undefined) {
                throw self.failure
            }
            return { value: undefined as unknown as NativeEvent, done: true }
        }

        const deliver = (event: NativeEvent): IteratorResult<NativeEvent> => {
            if (isTerminalEventKind(event.kind)) {
                self.terminalDelivered = true
            }
            return { value: event, done: false }
        }

        return {
            async next(): Promise<IteratorResult<NativeEvent>> {
                if (finished) {
                    if (self.failure !== undefined) {
                        throw self.failure
                    }
                    return { value: undefined as unknown as NativeEvent, done: true }
                }
                // Drain FIFO buffer before surfacing failure or terminal completion.
                if (self.buffer.length > 0) {
                    return deliver(self.buffer.shift()!)
                }
                if (self.failure !== undefined) {
                    return finish()
                }
                if (self.closed) {
                    return finish()
                }
                if (self.terminalDelivered) {
                    return finish()
                }
                if (self.terminal) {
                    return finish()
                }

                const next = await new Promise<IteratorResult<NativeEvent>>((resolve, reject) => {
                    self.waiters.push({ resolve, reject })
                })
                if (finished || self.closed) {
                    if (self.failure !== undefined) {
                        throw self.failure
                    }
                    finished = true
                    return { value: undefined as unknown as NativeEvent, done: true }
                }
                if (next.done || next.value === undefined) {
                    return finish()
                }
                return deliver(next.value)
            },

            async return(): Promise<IteratorResult<NativeEvent>> {
                if (finished && self.closed) {
                    return { value: undefined as unknown as NativeEvent, done: true }
                }
                finished = true
                // Resolve pending waiters and release immediately (do not wait on them).
                if (!self.closed) {
                    self.close()
                }
                return { value: undefined as unknown as NativeEvent, done: true }
            },

            async throw(error?: unknown): Promise<IteratorResult<NativeEvent>> {
                finished = true
                if (!self.closed) {
                    self.close()
                }
                throw error
            },
        }
    }
}

export function ensureHostCapabilityFacade(): ElectronBridgeApi {
    return getHostBridge()
}

export function createElectronEventSource(): NativeEventSource {
    return {
        on(handler) {
            return subscribeHostNativeEvents((event) => {
                handler(normalizeNativeEvent(event))
            })
        },
    }
}

export function createDefaultBindings(): NativeBridgeBindings {
    return {
        RuntimeInfo: () => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.RuntimeInfo) {
                return bridge.RuntimeInfo()
            }
            throw new Error('Host bridge RuntimeInfo is unavailable')
        },
        ReadFile: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.ReadFile) {
                return bridge.ReadFile(path)
            }
            throw new Error('Host bridge ReadFile is unavailable')
        },
        ReadFileIfExists: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.ReadFileIfExists) {
                return bridge.ReadFileIfExists(path)
            }
            return undefined as unknown as Promise<{ dataBase64: string } | null>
        },
        FileExists: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.FileExists) {
                return bridge.FileExists(path)
            }
            return undefined as unknown as Promise<boolean>
        },
        WriteFile: (path, dataBase64) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.WriteFile) {
                return bridge.WriteFile(path, dataBase64)
            }
            throw new Error('Host bridge WriteFile is unavailable')
        },
        MkdirAll: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.MkdirAll) {
                return bridge.MkdirAll(path)
            }
            throw new Error('Host bridge MkdirAll is unavailable')
        },
        RemoveFile: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.RemoveFile) {
                return bridge.RemoveFile(path)
            }
            throw new Error('Host bridge RemoveFile is unavailable')
        },
        RemoveDir: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.RemoveDir) {
                return bridge.RemoveDir(path)
            }
            throw new Error('Host bridge RemoveDir is unavailable')
        },
        Stat: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.Stat) {
                return bridge.Stat(path)
            }
            throw new Error('Host bridge Stat is unavailable')
        },
        ReadDir: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.ReadDir) {
                return bridge.ReadDir(path)
            }
            throw new Error('Host bridge ReadDir is unavailable')
        },
        RealPath: (path) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.RealPath) {
                return bridge.RealPath(path)
            }
            throw new Error('Host bridge RealPath is unavailable')
        },
        LookPath: (name) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.LookPath) {
                return bridge.LookPath(name)
            }
            throw new Error('Host bridge LookPath is unavailable')
        },
        OpenWebSocket: (req) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.OpenWebSocket) {
                return bridge.OpenWebSocket(req)
            }
            throw new Error('Host bridge OpenWebSocket is unavailable')
        },
        SendWebSocket: (operationId, payload) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SendWebSocket) {
                return bridge.SendWebSocket(operationId, payload)
            }
            throw new Error('Host bridge SendWebSocket is unavailable')
        },
        StartProcess: (req) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.StartProcess) {
                return bridge.StartProcess(req)
            }
            throw new Error('Host bridge StartProcess is unavailable')
        },
        CancelOperation: (operationId) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.CancelOperation) {
                return bridge.CancelOperation(operationId)
            }
            throw new Error('Host bridge CancelOperation is unavailable')
        },
        SessionBroadcastRunStatus: (sessionId, status, runId, clientId) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SessionBroadcastRunStatus) {
                return bridge.SessionBroadcastRunStatus(sessionId, status, runId, clientId)
            }
            throw new Error('Host bridge SessionBroadcastRunStatus is unavailable')
        },
        SessionBroadcastStreamEvent: (sessionId, runId, event) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SessionBroadcastStreamEvent) {
                return bridge.SessionBroadcastStreamEvent(sessionId, runId, event)
            }
            throw new Error('Host bridge SessionBroadcastStreamEvent is unavailable')
        },
        SessionAbortRun: (sessionId, reason) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SessionAbortRun) {
                return bridge.SessionAbortRun(sessionId, reason)
            }
            throw new Error('Host bridge SessionAbortRun is unavailable')
        },
        SessionGetActiveRuns: () => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SessionGetActiveRuns) {
                return bridge.SessionGetActiveRuns()
            }
            throw new Error('Host bridge SessionGetActiveRuns is unavailable')
        },
        SessionDelegateRun: (req) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SessionDelegateRun) {
                return bridge.SessionDelegateRun(req)
            }
            throw new Error('Host bridge SessionDelegateRun is unavailable')
        },
        SaveFile: (options) => {
            const bridge = ensureHostCapabilityFacade()
            if (bridge?.SaveFile) {
                return bridge.SaveFile(options)
            }
            if ((bridge as any)?.saveFile) {
                return (bridge as any).saveFile(options)
            }
            return Promise.resolve({ saved: false })
        },
        saveFile: (options) => {
            const bridge = ensureHostCapabilityFacade()
            if ((bridge as any)?.saveFile) {
                return (bridge as any).saveFile(options)
            }
            if (bridge?.SaveFile) {
                return bridge.SaveFile(options)
            }
            return Promise.resolve({ saved: false })
        },
        startProfiling: (options) => {
            const bridge = ensureHostCapabilityFacade()
            if (typeof bridge?.startProfiling === 'function') {
                return bridge.startProfiling(options)
            }
            return Promise.resolve({ ok: false, error: 'startProfiling unavailable' })
        },
        stopProfiling: () => {
            const bridge = ensureHostCapabilityFacade()
            if (typeof bridge?.stopProfiling === 'function') {
                return bridge.stopProfiling()
            }
            return Promise.resolve({ ok: false, error: 'stopProfiling unavailable' })
        },
        getProfilingReport: () => {
            const bridge = ensureHostCapabilityFacade()
            if (typeof bridge?.getProfilingReport === 'function') {
                return bridge.getProfilingReport()
            }
            return Promise.resolve({ ok: false, error: 'getProfilingReport unavailable' })
        },
    }
}

function normalizeNativeEvent(raw: unknown): NativeEvent {
    if (!raw || typeof raw !== 'object') {
        return {
            operationId: '',
            sequence: -1,
            kind: 'error',
            error: 'invalid native event',
        }
    }
    const value = raw as Record<string, unknown>
    const event: NativeEvent = {
        operationId: String(value.operationId ?? ''),
        sequence: Number(value.sequence ?? -1),
        kind: String(value.kind ?? ''),
    }
    if (typeof value.data === 'string') {
        event.data = value.data
    }
    if (value.encoding === 'utf8' || value.encoding === 'base64') {
        event.encoding = value.encoding
    }
    if (typeof value.exitCode === 'number') {
        event.exitCode = value.exitCode
    }
    if (typeof value.closeCode === 'number') {
        event.closeCode = value.closeCode
    }
    if (typeof value.reason === 'string') {
        event.reason = value.reason
    }
    if (typeof value.error === 'string') {
        event.error = value.error
    }
    return event
}

export class ElectronNativeBridge implements NativeBridge {
    /** Queues may retain terminal buffers for consumers after ops leave the live set. */
    private readonly queues = new Map<string, OperationQueue>()
    /**
     * Known live (non-terminal) operations. Terminal acceptance removes from this set
     * immediately while the queue buffer remains for the consumer to drain.
     */
    private readonly liveOps = new Set<string>()
    private readonly abortCleanups = new Map<string, () => void>()
    /** Per-op cancel latch so manager close + bridge dispose never double CancelOperation. */
    private readonly cancelledOps = new Set<string>()
    private readonly unsubscribe: () => void
    private disposed = false

    constructor(
        private readonly bindings: NativeBridgeBindings = createDefaultBindings(),
        eventSource: NativeEventSource = createElectronEventSource(),
    ) {
        this.unsubscribe = eventSource.on((event) => {
            this.route(event)
        })
    }

    /**
     * Tear down the bridge: cancel live operations once, then unsubscribe.
     * Terminal ops are NOT cancelled and their queue buffers stay readable so
     * consumers can still drain the accepted terminal event.
     * Ops already cancelled by the connection manager are skipped via the cancel latch.
     */
    async dispose(): Promise<void> {
        if (this.disposed) {
            return
        }
        this.disposed = true

        // Cancel only currently known live ops — never terminal ones.
        const liveIds = [...this.liveOps].filter((id) => !this.cancelledOps.has(id))
        this.liveOps.clear()
        await Promise.all(
            liveIds.map((id) =>
                this.cancel(id).catch(() => {
                    // best-effort — failures must not become unhandled rejections
                }),
            ),
        )

        for (const cleanup of this.abortCleanups.values()) {
            cleanup()
        }
        this.abortCleanups.clear()

        this.unsubscribe()

        // Close only non-terminal queues. Terminal queues keep their buffer so the
        // consumer iterator can still drain the terminal event after dispose.
        for (const [id, queue] of [...this.queues.entries()]) {
            if (!queue.isSettled) {
                queue.close()
            } else {
                // Leave terminal queue in map until consumer return/finish releases it.
                void id
            }
        }
    }

    observe(operationId: string, signal?: AbortSignal): NativeOperation {
        const queue = this.ensureQueue(operationId)
        // observe cannot await; catch cancel failures so they stay on the queue, never unhandled.
        void this.activateAbort(operationId, signal).catch(() => {
            // Error already applied via failOperation when CancelOperation rejects.
        })
        return this.toOperation(queue)
    }

    async runtimeInfo(): Promise<RuntimeInfo> {
        return this.bindings.RuntimeInfo()
    }

    async readFile(path: string): Promise<Uint8Array> {
        if (typeof this.bindings.ReadFileIfExists === 'function') {
            const file = await this.bindings.ReadFileIfExists(path)
            if (!file) {
                const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
                ;(err as unknown as { code?: string }).code = 'ENOENT'
                throw err
            }
            return base64ToBytes(file.dataBase64)
        }
        const file = await this.bindings.ReadFile(path)
        return base64ToBytes(file.dataBase64)
    }

    async writeFile(path: string, data: Uint8Array): Promise<void> {
        await this.bindings.WriteFile(path, bytesToBase64(data))
    }

    async mkdirAll(path: string): Promise<void> {
        await this.bindings.MkdirAll(path)
    }

    async removeFile(path: string): Promise<void> {
        await this.bindings.RemoveFile(path)
    }

    async removeDir(path: string): Promise<void> {
        if (this.bindings.RemoveDir) {
            await this.bindings.RemoveDir(path)
        } else {
            await this.bindings.RemoveFile(path)
        }
    }

    async stat(path: string): Promise<NativeStat> {
        return this.bindings.Stat(path)
    }

    async readDir(path: string): Promise<readonly NativeDirEntry[]> {
        const entries = await this.bindings.ReadDir(path)
        return entries ?? []
    }

    async realPath(path: string): Promise<string> {
        return this.bindings.RealPath(path)
    }

    async lookPath(name: string): Promise<string | null> {
        try {
            const resolved = await this.bindings.LookPath(name)
            return resolved || null
        } catch (error) {
            if (isExecutableNotFoundError(error)) {
                return null
            }
            throw error
        }
    }

    async openWebSocket(input: WebSocketOpenInput): Promise<NativeOperation> {
        // Register the queue before the binding call so dial-time events cannot be lost.
        // Abort is armed only after the operation is registered successfully.
        const queue = this.ensureQueue(input.operationId)
        try {
            await this.bindings.OpenWebSocket({
                operationId: input.operationId,
                url: input.url,
                headers: input.headers ? { ...input.headers } : null,
                connectTimeoutMs: input.connectTimeoutMs,
            })
        } catch (error) {
            this.failOperation(input.operationId)
            throw error
        }
        try {
            await this.activateAbort(input.operationId, input.signal)
        } catch {
            // Cancel rejection already failed the queue; still return the operation handle.
        }
        return this.toOperation(queue)
    }

    async sendWebSocket(operationId: string, payload: string): Promise<void> {
        await this.bindings.SendWebSocket(operationId, payload)
    }

    async startProcess(input: ProcessStartInput): Promise<ProcessOperation> {
        // Register the queue before the binding call so early stdout cannot be lost.
        // Abort is armed only after the operation is registered successfully.
        const queue = this.ensureQueue(input.operationId)
        let fullOutputPath: string
        try {
            const result = await this.bindings.StartProcess({
                operationId: input.operationId,
                executable: input.executable,
                args: input.args ? [...input.args] : null,
                cwd: input.cwd ?? '',
                env: input.env ? { ...input.env } : null,
                stdin: input.stdin,
            })
            fullOutputPath = result.fullOutputPath
        } catch (error) {
            this.failOperation(input.operationId)
            throw error
        }
        try {
            await this.activateAbort(input.operationId, input.signal)
        } catch {
            // Cancel rejection already failed the queue; still return the operation handle.
        }
        return {
            ...this.toOperation(queue),
            fullOutputPath,
        }
    }

    async cancel(operationId: string): Promise<void> {
        // Exactly one CancelOperation per operation id for the lifetime of this bridge.
        if (this.cancelledOps.has(operationId)) {
            return
        }
        this.cancelledOps.add(operationId)
        await this.bindings.CancelOperation(operationId)
    }

    async SessionBroadcastRunStatus(
        sessionId: string,
        status: 'running' | 'thinking' | 'tool' | 'idle',
        runId: string,
        clientId: string,
    ): Promise<void> {
        return this.bindings.SessionBroadcastRunStatus(sessionId, status, runId, clientId)
    }

    async SessionBroadcastStreamEvent(sessionId: string, runId: string, event: unknown): Promise<void> {
        return this.bindings.SessionBroadcastStreamEvent(sessionId, runId, event)
    }

    async SessionAbortRun(sessionId: string, reason?: string): Promise<void> {
        return this.bindings.SessionAbortRun(sessionId, reason)
    }

    async SessionGetActiveRuns(): Promise<ActiveRunInfo[]> {
        return this.bindings.SessionGetActiveRuns()
    }

    async SessionDelegateRun(req: SessionDelegateRunRequest): Promise<string> {
        return this.bindings.SessionDelegateRun(req)
    }

    async saveFile(options: SaveFileInput): Promise<SaveFileResult> {
        if (typeof this.bindings.saveFile === 'function') {
            return this.bindings.saveFile(options)
        }
        if (typeof this.bindings.SaveFile === 'function') {
            return this.bindings.SaveFile(options)
        }
        const bridge = getHostBridge()
        if (typeof bridge?.saveFile === 'function') {
            return bridge.saveFile(options)
        }
        if (typeof bridge?.SaveFile === 'function') {
            return bridge.SaveFile(options)
        }
        return { saved: false }
    }

    async startProfiling(options?: { durationMs?: number; target?: string }): Promise<{ ok: boolean; session?: any; error?: string }> {
        if (typeof this.bindings.startProfiling === 'function') {
            return this.bindings.startProfiling(options)
        }
        const bridge = getHostBridge()
        if (typeof bridge?.startProfiling === 'function') {
            return bridge.startProfiling(options)
        }
        return { ok: false, error: 'startProfiling unavailable' }
    }

    async stopProfiling(): Promise<{ ok: boolean; report?: any; rawProfile?: any; error?: string }> {
        if (typeof this.bindings.stopProfiling === 'function') {
            return this.bindings.stopProfiling()
        }
        const bridge = getHostBridge()
        if (typeof bridge?.stopProfiling === 'function') {
            return bridge.stopProfiling()
        }
        return { ok: false, error: 'stopProfiling unavailable' }
    }

    async getProfilingReport(): Promise<{ ok: boolean; report?: any; error?: string }> {
        if (typeof this.bindings.getProfilingReport === 'function') {
            return this.bindings.getProfilingReport()
        }
        const bridge = getHostBridge()
        if (typeof bridge?.getProfilingReport === 'function') {
            return bridge.getProfilingReport()
        }
        return { ok: false, error: 'getProfilingReport unavailable' }
    }

    private route(event: NativeEvent): void {
        if (!event.operationId) {
            return
        }
        // After unsubscribe dispose still may race one last event; only route known queues.
        const queue = this.queues.get(event.operationId)
        if (!queue) {
            return
        }
        const accepted = queue.push(event)
        if (accepted && isTerminalEventKind(event.kind)) {
            // Terminal accepted: leave live set immediately; keep queue for consumer drain.
            this.liveOps.delete(event.operationId)
            this.clearAbort(event.operationId)
        }
    }

    private ensureQueue(operationId: string): OperationQueue {
        const existing = this.queues.get(operationId)
        if (existing) {
            return existing
        }
        const queue = new OperationQueue(operationId, () => {
            this.queues.delete(operationId)
            this.liveOps.delete(operationId)
            this.clearAbort(operationId)
        })
        this.queues.set(operationId, queue)
        this.liveOps.add(operationId)
        return queue
    }

    private failOperation(operationId: string, error?: unknown): void {
        const queue = this.queues.get(operationId)
        if (queue) {
            if (error !== undefined) {
                queue.fail(error)
                // Drop abort listener; queue may remain until buffered events drain.
                this.liveOps.delete(operationId)
                this.clearAbort(operationId)
            } else {
                this.liveOps.delete(operationId)
                queue.close()
            }
        } else {
            this.queues.delete(operationId)
            this.liveOps.delete(operationId)
            this.clearAbort(operationId)
        }
    }

    private toOperation(queue: OperationQueue): NativeOperation {
        return {
            operationId: queue.operationId,
            events: {
                [Symbol.asyncIterator]: () => queue.createIterator(),
            },
        }
    }

    /**
     * Arm AbortSignal → CancelOperation only after the operation is live.
     * Never arm or cancel once the queue is terminal / failed / released.
     * Cancel rejections fail the queue (buffer retained) and never go unhandled.
     */
    private async activateAbort(operationId: string, signal?: AbortSignal): Promise<void> {
        this.clearAbort(operationId)
        if (!signal) {
            return
        }

        const queue = this.queues.get(operationId)
        // Released, terminal, or already failed: never arm / cancel.
        if (!queue || queue.isSettled) {
            return
        }

        let cancelled = false
        const cancelOnce = async (): Promise<void> => {
            if (cancelled) {
                return
            }
            cancelled = true
            // Re-check just before cancel: terminal may have arrived since arming.
            const live = this.queues.get(operationId)
            if (!live || live.isSettled) {
                return
            }
            try {
                // Route through cancel latch so manager close + signal abort share one call.
                await this.cancel(operationId)
            } catch (error) {
                this.failOperation(operationId, error)
                // Propagate so awaiters can observe; callers that cannot await must catch.
                throw error
            }
        }

        if (signal.aborted) {
            await cancelOnce()
            return
        }

        // Queue may have become terminal between the earlier check and now.
        if (queue.isSettled) {
            return
        }

        const onAbort = () => {
            signal.removeEventListener('abort', onAbort)
            this.abortCleanups.delete(operationId)
            // Surface cancel failures onto the queue; never leave an unhandled rejection.
            void cancelOnce().catch(() => {
                // Error already applied via failOperation.
            })
        }
        signal.addEventListener('abort', onAbort)
        this.abortCleanups.set(operationId, () => {
            signal.removeEventListener('abort', onAbort)
        })
    }

    private clearAbort(operationId: string): void {
        const cleanup = this.abortCleanups.get(operationId)
        if (!cleanup) {
            return
        }
        cleanup()
        this.abortCleanups.delete(operationId)
    }
}
