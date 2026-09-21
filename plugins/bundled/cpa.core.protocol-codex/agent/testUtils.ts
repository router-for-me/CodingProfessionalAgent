/**
 * Typed NativeBridge contract used by the standalone agent runtime.
 * Wire events stay string/base64; file APIs expose Uint8Array.
 */

export type NativeEventEncoding = 'utf8' | 'base64'

export type NativeEventKind =
    | 'websocket-open'
    | 'websocket-text'
    | 'websocket-binary'
    | 'process-stdout'
    | 'process-stderr'
    | 'done'
    | 'error'
    | 'cancelled'
    | 'projects:updated'
    | 'session:meta-updated'
    | 'session:deleted'
    | 'session:entries-updated'
    | 'session:run-status'
    | 'session:stream-event'
    | 'session:subagent-state'
    | 'session:abort-run'
    | 'session:delegate-run'
    | 'session:resume-prompt-state'
    | 'session:resume-prompt-action'
    | (string & {})

export interface NativeEvent {
    operationId: string
    sequence: number
    kind: NativeEventKind
    data?: string
    encoding?: NativeEventEncoding
    exitCode?: number
    closeCode?: number
    reason?: string
    error?: string
}

export interface RuntimeInfo {
    platform: string
    userConfigDir: string
    tempDir: string
    homeDir: string
    isDebug?: boolean
}

export interface NativeStat {
    name: string
    size: number
    mode: number
    isDir: boolean
}

export interface NativeDirEntry {
    name: string
    isDir: boolean
}

export interface WebSocketOpenInput {
    operationId: string
    url: string
    headers?: Readonly<Record<string, string>>
    connectTimeoutMs: number
    signal?: AbortSignal
}

export interface ProcessStartInput {
    operationId: string
    executable: string
    args?: readonly string[]
    cwd?: string
    env?: Readonly<Record<string, string>>
    stdin?: string
    signal?: AbortSignal
}

export interface SessionDelegateRunRequest {
    sessionId?: string | null
    text: string
    images?: Array<{ data: string; mimeType: string; name?: string }>
    projectId?: string | null
    branch?: string | null
    modelId?: string
    reasoningEffort?: string
    speed?: 'standard' | 'fast' | 'max'
    editMessageId?: string
    userEntryId?: string
    userEntryCreatedAt?: number
}

export interface ActiveRunInfo {
    sessionId: string
    runId: string
    clientId: string
    status: 'running' | 'thinking' | 'tool' | 'idle' | 'error'
    error?: string
    updatedAt: number
}

export interface ResumePromptSyncState {
    prompt: string
    source: 'main' | 'external'
    updatedAt: number
}

export interface NativeOperation {
    operationId: string
    events: AsyncIterable<NativeEvent>
}

export interface ProcessOperation extends NativeOperation {
    fullOutputPath: string
}

export function isTerminalEventKind(kind: string | undefined): boolean {
    return (
        kind === 'done' ||
        kind === 'error' ||
        kind === 'cancelled' ||
        kind === 'closed'
    )
}

export interface FakeCallRecord {
    method: string
    args: unknown[]
}

export interface FakeWebSocketFrame {
    kind: string
    data?: string
    encoding?: 'utf8' | 'base64'
    closeCode?: number
    reason?: string
    error?: string
}

export interface FakeWebSocketScript {
    frames: FakeWebSocketFrame[]
    /** When true, only the first frame is emitted; remaining frames wait for flush/cancel. */
    hold?: boolean
}

export interface FakeProcessScript {
    chunks?: readonly string[]
    stderrChunks?: readonly string[]
    exitCode?: number
    fullOutputPath?: string
    /** When true, do not auto-emit the terminal event until cancel/flush. */
    hold?: boolean
    error?: string
}

type Waiter = {
    resolve: (result: IteratorResult<NativeEvent>) => void
    reject: (error: unknown) => void
}

type HeldPayload =
    | { kind: 'websocket'; frames: FakeWebSocketFrame[] }
    | { kind: 'process'; exitCode: number }

/** Browser-safe base64 encode without Node Buffer (mirrors production adapter). */
function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, offset + chunkSize)
        binary += String.fromCharCode(...slice)
    }
    return btoa(binary)
}

class FakeOperationStream {
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
        private readonly onTerminal: () => void,
    ) {}

    get isTerminal(): boolean {
        return this.terminal || this.closed
    }

    /** True when terminal, failed, or closed — abort must never arm/cancel. */
    get isSettled(): boolean {
        return this.closed || this.terminal || this.failure !== undefined
    }

    get sequence(): number {
        return this.nextSequence
    }

    push(partial: Omit<NativeEvent, 'operationId' | 'sequence'> & { sequence?: number }): boolean {
        if (this.closed || this.terminal || this.failure !== undefined) {
            return false
        }
        const sequence = partial.sequence ?? this.nextSequence
        if (sequence !== this.nextSequence) {
            return false
        }
        const event: NativeEvent = {
            operationId: this.operationId,
            sequence,
            kind: partial.kind as NativeEventKind,
            data: partial.data,
            encoding: partial.encoding,
            exitCode: partial.exitCode,
            closeCode: partial.closeCode,
            reason: partial.reason,
            error: partial.error,
        }
        this.nextSequence += 1
        if (isTerminalEventKind(event.kind)) {
            this.terminal = true
            this.onTerminal()
        }
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            waiter.resolve({ value: event, done: false })
            // Terminal wakes one waiter; remaining concurrent waiters resolve done.
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
     * Fail while preserving buffered events. Drain first, then reject.
     * Late failure must not overwrite an accepted terminal.
     */
    fail(error: unknown): void {
        if (this.closed || this.failure !== undefined || this.terminal) {
            return
        }
        this.failure = error
        if (this.buffer.length > 0) {
            return
        }
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
                if (self.failure !== undefined || self.closed) {
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

/**
 * Deterministic NativeBridge double for tool/runtime tests.
 * All events are synchronous / queued — no real timers.
 */
export class FakeNativeBridge {
    readonly calls: FakeCallRecord[] = []

    private readonly files = new Map<string, Uint8Array>()
    private readonly dirs = new Set<string>()
    private readonly lookPaths = new Map<string, string | null>()
    private readonly live = new Map<string, FakeOperationStream>()
    private readonly held = new Map<string, HeldPayload>()
    private readonly processScripts: FakeProcessScript[] = []
    private readonly webSocketScripts: FakeWebSocketScript[] = []
    /** Frames emitted on each successive sendWebSocket for any live op (FIFO). */
    private readonly sendResponses: FakeWebSocketFrame[][] = []
    /** Optional request-driven responder; wins over FIFO queue when set. */
    private sendHandler:
        | ((operationId: string, payload: string) => readonly FakeWebSocketFrame[] | null | undefined)
        | null = null
    private readonly abortCleanups = new Map<string, () => void>()
    private info: RuntimeInfo = {
        platform: 'darwin',
        userConfigDir: '/tmp/cpa-config',
        tempDir: '/tmp',
        homeDir: '/home/test',
    }

    setRuntimeInfo(info: Partial<RuntimeInfo>): void {
        this.info = { ...this.info, ...info }
    }

    /** Register or overwrite a virtual file. */
    setFile(path: string, data: string | Uint8Array): void {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.files.set(this.normalize(path), bytes)
        this.ensureParentDirs(path)
    }

    setLookPath(name: string, resolved: string | null): void {
        this.lookPaths.set(name, resolved)
    }

    queueProcess(script: FakeProcessScript): void {
        this.processScripts.push(script)
    }

    queueWebSocket(script: FakeWebSocketScript): void {
        this.webSocketScripts.push(script)
    }

    /**
     * Queue frames that will be emitted when the next sendWebSocket succeeds.
     * Enables request-driven multi-turn protocol tests on a held-open socket.
     */
    queueWebSocketSendResponse(frames: readonly FakeWebSocketFrame[]): void {
        this.sendResponses.push(frames.map((frame) => ({ ...frame })))
    }

    /**
     * Install a request-driven send responder (clears FIFO queue usage until cleared).
     * Return frames to emit, or null/undefined to leave the stream idle.
     */
    setWebSocketSendHandler(
        handler:
            | ((operationId: string, payload: string) => readonly FakeWebSocketFrame[] | null | undefined)
            | null,
    ): void {
        this.sendHandler = handler
    }

    /**
     * Deliver remaining held frames / process terminal for an operation.
     * No-op when already terminal or nothing is held (including after cancel).
     */
    flush(operationId: string): void {
        const stream = this.live.get(operationId)
        const held = this.held.get(operationId)
        this.held.delete(operationId)
        if (!stream || stream.isTerminal || !held) {
            return
        }
        if (held.kind === 'websocket') {
            for (const frame of held.frames) {
                stream.push(frame)
            }
            return
        }
        stream.push({
            kind: 'done',
            exitCode: held.exitCode,
        })
    }

    /** Push a raw event onto a live operation (advanced test control). */
    emit(operationId: string, partial: Omit<NativeEvent, 'operationId' | 'sequence'>): void {
        const stream = this.live.get(operationId)
        if (!stream) {
            return
        }
        stream.push(partial)
    }

    /** Fail a live stream (advanced test control; mirrors production cancel-reject path). */
    fail(operationId: string, error: unknown): void {
        const stream = this.live.get(operationId)
        if (!stream) {
            return
        }
        stream.fail(error)
        this.clearAbort(operationId)
    }

    /**
     * Close a live stream without a terminal event (simulates dropped connection / EOF).
     * Advanced test control only.
     */
    closeOperation(operationId: string): void {
        const stream = this.live.get(operationId)
        this.held.delete(operationId)
        if (!stream) {
            return
        }
        stream.close()
        this.clearAbort(operationId)
    }

    async runtimeInfo(): Promise<RuntimeInfo> {
        this.record('runtimeInfo')
        return { ...this.info }
    }

    async readFile(path: string): Promise<Uint8Array> {
        this.record('readFile', path)
        const data = this.files.get(this.normalize(path))
        if (!data) {
            throw new Error(`read file ${path}: not found`)
        }
        return new Uint8Array(data)
    }

    async writeFile(path: string, data: Uint8Array): Promise<void> {
        this.record('writeFile', path, data)
        this.files.set(this.normalize(path), new Uint8Array(data))
        this.ensureParentDirs(path)
    }

    async mkdirAll(path: string): Promise<void> {
        this.record('mkdirAll', path)
        this.dirs.add(this.normalize(path))
        this.ensureParentDirs(path)
    }

    async removeFile(path: string): Promise<void> {
        this.record('removeFile', path)
        const key = this.normalize(path)
        if (!this.files.has(key)) {
            throw new Error(`remove file ${path}: not found`)
        }
        this.files.delete(key)
    }

    async removeDir(path: string): Promise<void> {
        this.record('removeDir', path)
        const norm = this.normalize(path)
        this.dirs.delete(norm)
        for (const fileKey of [...this.files.keys()]) {
            if (fileKey === norm || fileKey.startsWith(norm + '/')) {
                this.files.delete(fileKey)
            }
        }
        for (const dirKey of [...this.dirs]) {
            if (dirKey.startsWith(norm + '/')) {
                this.dirs.delete(dirKey)
            }
        }
    }

    async stat(path: string): Promise<NativeStat> {
        this.record('stat', path)
        const key = this.normalize(path)
        const file = this.files.get(key)
        if (file) {
            return {
                name: baseName(key),
                size: file.byteLength,
                mode: 0o644,
                isDir: false,
            }
        }
        if (this.dirs.has(key) || this.hasDescendant(key)) {
            return {
                name: baseName(key),
                size: 0,
                mode: 0o755,
                isDir: true,
            }
        }
        throw new Error(`stat ${path}: not found`)
    }

    async readDir(path: string): Promise<readonly NativeDirEntry[]> {
        this.record('readDir', path)
        const key = this.normalize(path)
        const prefix = key.endsWith('/') ? key : `${key}/`
        const names = new Map<string, boolean>()

        for (const dir of this.dirs) {
            if (dir.startsWith(prefix)) {
                const rest = dir.slice(prefix.length)
                const name = rest.split('/')[0]
                if (name) {
                    names.set(name, true)
                }
            }
        }
        for (const filePath of this.files.keys()) {
            if (filePath.startsWith(prefix)) {
                const rest = filePath.slice(prefix.length)
                const name = rest.split('/')[0]
                if (name) {
                    names.set(name, names.get(name) === true || rest.includes('/'))
                    if (!rest.includes('/')) {
                        names.set(name, false)
                    }
                }
            }
        }

        return [...names.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, isDir]) => ({ name, isDir }))
    }

    async realPath(path: string): Promise<string> {
        this.record('realPath', path)
        return this.normalize(path)
    }

    async lookPath(name: string): Promise<string | null> {
        this.record('lookPath', name)
        if (this.lookPaths.has(name)) {
            return this.lookPaths.get(name) ?? null
        }
        return null
    }

    async openWebSocket(input: WebSocketOpenInput): Promise<NativeOperation> {
        this.record('openWebSocket', input)
        const stream = this.createStream(input.operationId)

        const script = this.webSocketScripts.shift() ?? {
            frames: [{ kind: 'websocket-open' }, { kind: 'done', closeCode: 1000 }],
        }

        if (script.hold) {
            const first = script.frames[0]
            if (first) {
                stream.push(first)
            }
            const remaining = script.frames.slice(1)
            if (remaining.length > 0) {
                this.held.set(input.operationId, { kind: 'websocket', frames: remaining })
            }
        } else {
            for (const frame of script.frames) {
                stream.push(frame)
            }
        }

        // Arm abort only after the fake operation is registered (mirrors production).
        try {
            await this.activateAbort(input.operationId, input.signal)
        } catch {
            // Cancel rejection already failed the stream; still return the operation handle.
        }
        return this.toOperation(stream)
    }

    async sendWebSocket(operationId: string, payload: string): Promise<void> {
        this.record('sendWebSocket', operationId, payload)
        const stream = this.live.get(operationId)
        if (!stream || stream.isTerminal) {
            throw new Error(`send websocket ${operationId}: not open`)
        }
        let frames: readonly FakeWebSocketFrame[] | null | undefined
        if (this.sendHandler) {
            frames = this.sendHandler(operationId, payload)
        } else {
            frames = this.sendResponses.shift()
        }
        if (!frames) {
            return
        }
        for (const frame of frames) {
            stream.push(frame)
        }
    }

    async startProcess(input: ProcessStartInput): Promise<ProcessOperation> {
        this.record('startProcess', input)
        const stream = this.createStream(input.operationId)

        const script = this.processScripts.shift() ?? {
            chunks: [],
            exitCode: 0,
            fullOutputPath: `/tmp/cpa-process-${input.operationId}.log`,
        }
        const fullOutputPath = script.fullOutputPath ?? `/tmp/cpa-process-${input.operationId}.log`

        if (script.error) {
            stream.push({ kind: 'error', error: script.error })
            try {
                await this.activateAbort(input.operationId, input.signal)
            } catch {
                // Cancel rejection already failed the stream; still return the operation handle.
            }
            return { ...this.toOperation(stream), fullOutputPath }
        }

        for (const chunk of script.chunks ?? []) {
            stream.push({
                kind: 'process-stdout',
                data: textToBase64(chunk),
                encoding: 'base64',
            })
        }
        for (const chunk of script.stderrChunks ?? []) {
            stream.push({
                kind: 'process-stderr',
                data: textToBase64(chunk),
                encoding: 'base64',
            })
        }

        if (!script.hold) {
            stream.push({
                kind: 'done',
                exitCode: script.exitCode ?? 0,
            })
        } else {
            this.held.set(input.operationId, {
                kind: 'process',
                exitCode: script.exitCode ?? 0,
            })
        }

        try {
            await this.activateAbort(input.operationId, input.signal)
        } catch {
            // Cancel rejection already failed the stream; still return the operation handle.
        }
        return {
            ...this.toOperation(stream),
            fullOutputPath,
        }
    }

    async cancel(operationId: string): Promise<void> {
        this.record('cancel', operationId)
        this.held.delete(operationId)
        const stream = this.live.get(operationId)
        if (!stream || stream.isTerminal) {
            return
        }
        stream.push({ kind: 'cancelled' })
    }

    async SessionBroadcastRunStatus(
        sessionId: string,
        status: 'running' | 'thinking' | 'tool' | 'idle',
        runId: string,
        clientId: string,
    ): Promise<void> {
        this.record('SessionBroadcastRunStatus', sessionId, status, runId, clientId)
    }

    async SessionBroadcastStreamEvent(sessionId: string, runId: string, event: unknown): Promise<void> {
        this.record('SessionBroadcastStreamEvent', sessionId, runId, event)
    }

    async SessionAbortRun(sessionId: string, reason?: string): Promise<void> {
        this.record('SessionAbortRun', sessionId, reason)
    }

    async SessionGetActiveRuns(): Promise<ActiveRunInfo[]> {
        this.record('SessionGetActiveRuns')
        return []
    }

    async SessionDelegateRun(req: SessionDelegateRunRequest): Promise<string> {
        this.record('SessionDelegateRun', req)
        return (req?.sessionId as string) || ''
    }

    async saveFile(options: {
        defaultPath?: string
        title?: string
        content: string
        filters?: Array<{ name: string; extensions: string[] }>
    }): Promise<{ saved: boolean; filePath?: string }> {
        this.record('saveFile', options)
        const filePath = options.defaultPath || '/tmp/saved-file.md'
        this.setFile(filePath, options.content ?? '')
        return { saved: true, filePath }
    }

    async startProfiling(options?: { durationMs?: number; target?: string }): Promise<{ ok: boolean; session?: any; error?: string }> {
        this.record('startProfiling', options)
        return { ok: true, session: { target: options?.target || 'all', durationMs: options?.durationMs || 60000 } }
    }

    async stopProfiling(): Promise<{ ok: boolean; report?: any; rawProfile?: any; error?: string }> {
        this.record('stopProfiling')
        return {
            ok: true,
            report: {
                summary: { durationMs: 1000, target: 'all' },
                hotspots: [],
                bottlenecks: [],
                pluginMetrics: [],
                aiSuggestions: [],
            },
        }
    }

    async getProfilingReport(): Promise<{ ok: boolean; report?: any; error?: string }> {
        this.record('getProfilingReport')
        return {
            ok: true,
            report: {
                summary: { durationMs: 1000, target: 'all' },
                hotspots: [],
                bottlenecks: [],
                pluginMetrics: [],
                aiSuggestions: [],
            },
        }
    }

    private createStream(operationId: string): FakeOperationStream {
        const existing = this.live.get(operationId)
        if (existing) {
            existing.close()
        }
        this.held.delete(operationId)
        const stream = new FakeOperationStream(
            operationId,
            () => {
                this.live.delete(operationId)
                this.held.delete(operationId)
                this.clearAbort(operationId)
            },
            () => {
                // Match production: drop abort listener as soon as a terminal is accepted.
                this.clearAbort(operationId)
                this.held.delete(operationId)
            },
        )
        this.live.set(operationId, stream)
        return stream
    }

    private toOperation(stream: FakeOperationStream): NativeOperation {
        return {
            operationId: stream.operationId,
            events: {
                [Symbol.asyncIterator]: () => stream.createIterator(),
            },
        }
    }

    private async activateAbort(operationId: string, signal?: AbortSignal): Promise<void> {
        this.clearAbort(operationId)
        if (!signal) {
            return
        }

        // Released, terminal, or already failed: never arm / cancel.
        const stream = this.live.get(operationId)
        if (!stream || stream.isSettled) {
            return
        }

        let cancelled = false
        const cancelOnce = async (): Promise<void> => {
            if (cancelled) {
                return
            }
            cancelled = true
            const live = this.live.get(operationId)
            if (!live || live.isSettled) {
                return
            }
            await this.cancel(operationId)
        }

        if (signal.aborted) {
            await cancelOnce()
            return
        }

        if (stream.isSettled) {
            return
        }

        const onAbort = () => {
            signal.removeEventListener('abort', onAbort)
            this.abortCleanups.delete(operationId)
            void cancelOnce().catch(() => {
                // cancel is deterministic in the fake; swallow to avoid unhandled rejection.
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

    private record(method: string, ...args: unknown[]): void {
        this.calls.push({ method, args })
    }

    private normalize(path: string): string {
        if (!path) {
            return '/'
        }
        const parts = path.replace(/\\/g, '/').split('/')
        const out: string[] = []
        for (const part of parts) {
            if (!part || part === '.') {
                continue
            }
            if (part === '..') {
                out.pop()
                continue
            }
            out.push(part)
        }
        return `/${out.join('/')}`
    }

    private ensureParentDirs(path: string): void {
        const key = this.normalize(path)
        const parts = key.split('/').filter(Boolean)
        let current = ''
        for (let index = 0; index < parts.length - 1; index += 1) {
            current += `/${parts[index]}`
            this.dirs.add(current)
        }
    }

    private hasDescendant(dir: string): boolean {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`
        for (const filePath of this.files.keys()) {
            if (filePath.startsWith(prefix)) {
                return true
            }
        }
        for (const child of this.dirs) {
            if (child.startsWith(prefix) || child === dir) {
                return true
            }
        }
        return false
    }
}

function baseName(path: string): string {
    const parts = path.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? path
}
