import type {
    NativeBridge,
    NativeDirEntry,
    NativeEvent,
    NativeStat,
    ProcessOperation,
    ProcessStartInput,
} from './types.js'

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

export interface FakeProcessScript {
    chunks?: readonly string[]
    stderrChunks?: readonly string[]
    exitCode?: number
    fullOutputPath?: string
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

function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
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
            kind: partial.kind,
            data: partial.data,
            encoding: partial.encoding,
            exitCode: partial.exitCode,
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

export class FakeNativeBridge implements NativeBridge {
    readonly calls: FakeCallRecord[] = []

    private readonly files = new Map<string, Uint8Array>()
    private readonly dirs = new Set<string>()
    private readonly lookPaths = new Map<string, string | null>()
    private readonly symlinks = new Map<string, string>()
    private readonly live = new Map<string, FakeOperationStream>()
    private readonly held = new Map<string, HeldPayload>()
    private readonly processScripts: FakeProcessScript[] = []
    private readonly abortCleanups = new Map<string, () => void>()
    private info = {
        platform: 'darwin',
        userConfigDir: '/tmp/cpa-config',
        tempDir: '/tmp',
        homeDir: '/home/test',
    }

    constructor() {
        this.dirs.add('/')
    }

    private normalize(p: string): string {
        return p.replace(/\\/g, '/')
    }

    private ensureParentDirs(filePath: string): void {
        const parts = this.normalize(filePath).split('/').filter(Boolean)
        let current = filePath.startsWith('/') ? '' : ''
        for (let i = 0; i < parts.length - 1; i++) {
            current += '/' + parts[i]
            this.dirs.add(current)
        }
    }

    setRuntimeInfo(info: Partial<typeof this.info>): void {
        this.info = { ...this.info, ...info }
    }

    setFile(path: string, data: string | Uint8Array): void {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.files.set(this.normalize(path), bytes)
        this.ensureParentDirs(path)
    }

    setLookPath(name: string, resolved: string | null): void {
        this.lookPaths.set(name, resolved)
    }

    setSymlink(linkPath: string, targetPath: string): void {
        this.symlinks.set(this.normalize(linkPath), this.normalize(targetPath))
    }

    queueProcess(script: FakeProcessScript): void {
        this.processScripts.push(script)
    }

    flush(operationId: string): void {
        const stream = this.live.get(operationId)
        const held = this.held.get(operationId)
        this.held.delete(operationId)
        if (!stream || stream.isTerminal || !held) {
            return
        }
        stream.push({
            kind: 'done',
            exitCode: held.exitCode,
        })
    }

    emit(operationId: string, partial: Omit<NativeEvent, 'operationId' | 'sequence'>): void {
        const stream = this.live.get(operationId)
        if (!stream) {
            return
        }
        stream.push(partial)
    }

    fail(operationId: string, error: unknown): void {
        const stream = this.live.get(operationId)
        if (!stream) {
            return
        }
        stream.fail(error)
    }

    closeOperation(operationId: string): void {
        const stream = this.live.get(operationId)
        if (stream) {
            stream.close()
        }
    }

    async stat(path: string): Promise<NativeStat> {
        this.calls.push({ method: 'stat', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.stat(this.symlinks.get(norm)!)
        }
        if (this.files.has(norm)) {
            const bytes = this.files.get(norm)!
            return { isDir: false, isFile: true, sizeBytes: bytes.byteLength }
        }
        if (this.dirs.has(norm)) {
            return { isDir: true, isFile: false, sizeBytes: 0 }
        }
        throw new Error(`stat ${path}: not found`)
    }

    async readFile(path: string): Promise<Uint8Array> {
        this.calls.push({ method: 'readFile', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.readFile(this.symlinks.get(norm)!)
        }
        const hit = this.files.get(norm)
        if (!hit) {
            throw new Error(`readFile ${path}: not found`)
        }
        return hit
    }

    async readFileIfExists(path: string): Promise<Uint8Array | null> {
        this.calls.push({ method: 'readFileIfExists', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.readFileIfExists(this.symlinks.get(norm)!)
        }
        return this.files.get(norm) ?? null
    }

    async writeFile(path: string, data: Uint8Array): Promise<void> {
        this.calls.push({ method: 'writeFile', args: [path, data] })
        const norm = this.normalize(path)
        this.files.set(norm, data)
        this.ensureParentDirs(path)
    }

    async mkdirAll(path: string): Promise<void> {
        this.calls.push({ method: 'mkdirAll', args: [path] })
        this.dirs.add(this.normalize(path))
    }

    async readDir(path: string): Promise<readonly NativeDirEntry[]> {
        this.calls.push({ method: 'readDir', args: [path] })
        const norm = this.normalize(path)
        const entries: NativeDirEntry[] = []
        const prefix = norm.endsWith('/') ? norm : `${norm}/`
        for (const [filePath, bytes] of this.files.entries()) {
            if (filePath.startsWith(prefix)) {
                const rest = filePath.slice(prefix.length)
                if (!rest.includes('/')) {
                    entries.push({ name: rest, isDir: false, isFile: true, sizeBytes: bytes.byteLength })
                }
            }
        }
        for (const dirPath of this.dirs) {
            if (dirPath !== norm && dirPath.startsWith(prefix)) {
                const rest = dirPath.slice(prefix.length)
                if (!rest.includes('/')) {
                    entries.push({ name: rest, isDir: true, isFile: false })
                }
            }
        }
        return entries
    }

    async removeFile(path: string): Promise<void> {
        this.calls.push({ method: 'removeFile', args: [path] })
        const norm = this.normalize(path)
        if (!this.files.has(norm) && !this.symlinks.has(norm)) {
            throw new Error(`removeFile ${path}: not found`)
        }
        this.files.delete(norm)
        this.symlinks.delete(norm)
    }

    async removeDir(path: string): Promise<void> {
        this.calls.push({ method: 'removeDir', args: [path] })
        const norm = this.normalize(path)
        this.dirs.delete(norm)
    }

    async lookPath(name: string): Promise<string | null> {
        this.calls.push({ method: 'lookPath', args: [name] })
        if (this.lookPaths.has(name)) {
            return this.lookPaths.get(name)!
        }
        return null
    }

    async realPath(path: string): Promise<string> {
        this.calls.push({ method: 'realPath', args: [path] })
        const norm = this.normalize(path)
        if (this.symlinks.has(norm)) {
            return this.symlinks.get(norm)!
        }
        return path
    }

    async runtimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }> {
        this.calls.push({ method: 'runtimeInfo', args: [] })
        return { ...this.info }
    }

    async startProcess(input: ProcessStartInput): Promise<ProcessOperation> {
        this.calls.push({ method: 'startProcess', args: [input] })
        const operationId = input.operationId
        const stream = new FakeOperationStream(
            operationId,
            () => {
                this.live.delete(operationId)
                this.held.delete(operationId)
            },
            () => {
                this.held.delete(operationId)
            },
        )
        this.live.set(operationId, stream)

        const script = this.processScripts.shift() ?? {
            chunks: ['command output\n'],
            exitCode: 0,
        }
        const fullOutputPath = script.fullOutputPath ?? `/tmp/${operationId}.log`

        if (input.signal) {
            const onAbort = () => {
                void this.cancel(operationId)
            }
            input.signal.addEventListener('abort', onAbort)
            this.abortCleanups.set(operationId, () => {
                input.signal?.removeEventListener('abort', onAbort)
            })
            if (input.signal.aborted) {
                onAbort()
            }
        }

        if (script.error) {
            stream.push({ kind: 'error', error: script.error })
        } else {
            if (script.chunks) {
                for (const chunk of script.chunks) {
                    stream.push({ kind: 'process-stdout', encoding: 'base64', data: textToBase64(chunk) })
                }
            }
            if (script.stderrChunks) {
                for (const chunk of script.stderrChunks) {
                    stream.push({ kind: 'process-stderr', encoding: 'base64', data: textToBase64(chunk) })
                }
            }
            if (script.hold) {
                this.held.set(operationId, { kind: 'process', exitCode: script.exitCode ?? 0 })
            } else {
                stream.push({ kind: 'done', exitCode: script.exitCode ?? 0 })
            }
        }

        return {
            operationId,
            fullOutputPath,
            events: {
                [Symbol.asyncIterator]() {
                    return stream.createIterator()
                },
            },
        }
    }

    async cancel(operationId: string): Promise<void> {
        this.calls.push({ method: 'cancel', args: [operationId] })
        const cleanup = this.abortCleanups.get(operationId)
        if (cleanup) {
            cleanup()
            this.abortCleanups.delete(operationId)
        }
        const stream = this.live.get(operationId)
        if (!stream || stream.isTerminal) {
            return
        }
        this.held.delete(operationId)
        stream.push({ kind: 'cancelled', error: undefined })
    }
}
