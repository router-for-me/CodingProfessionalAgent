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

export interface FakeProcessScript {
    chunks?: readonly string[]
    stderrChunks?: readonly string[]
    exitCode?: number
    fullOutputPath?: string
    error?: string
}

class FakeOperationStream {
    private readonly buffer: NativeEvent[] = []
    private readonly waiters: Array<{
        resolve: (result: IteratorResult<NativeEvent>) => void
        reject: (error: unknown) => void
    }> = []
    private terminal = false
    private closed = false

    constructor(
        readonly operationId: string,
        private readonly onRelease: () => void,
    ) {}

    push(event: NativeEvent): void {
        if (this.closed || this.terminal) return
        if (isTerminalEventKind(event.kind)) {
            this.terminal = true
        }
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift()!
            waiter.resolve({ value: event, done: false })
            return
        }
        this.buffer.push(event)
    }

    close(): void {
        this.closed = true
        this.buffer.length = 0
        while (this.waiters.length > 0) {
            this.waiters.shift()!.resolve({ value: undefined as unknown as NativeEvent, done: true })
        }
        this.onRelease()
    }

    createIterator(): AsyncIterator<NativeEvent> {
        const self = this
        return {
            async next(): Promise<IteratorResult<NativeEvent>> {
                if (self.buffer.length > 0) {
                    return { value: self.buffer.shift()!, done: false }
                }
                if (self.closed || self.terminal) {
                    return { value: undefined as unknown as NativeEvent, done: true }
                }
                return new Promise<IteratorResult<NativeEvent>>((resolve, reject) => {
                    self.waiters.push({ resolve, reject })
                })
            },
            async return(): Promise<IteratorResult<NativeEvent>> {
                self.close()
                return { value: undefined as unknown as NativeEvent, done: true }
            },
            async throw(err?: unknown): Promise<IteratorResult<NativeEvent>> {
                self.close()
                throw err
            },
        }
    }
}

export class FakeNativeBridge implements NativeBridge {
    readonly calls: FakeCallRecord[] = []
    private readonly files = new Map<string, Uint8Array>()
    private readonly dirs = new Set<string>()
    private readonly processScripts: FakeProcessScript[] = []
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

    setRuntimeInfo(info: Partial<typeof this.info>): void {
        this.info = { ...this.info, ...info }
    }

    setFile(path: string, data: string | Uint8Array): void {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
        this.files.set(this.normalize(path), bytes)
    }

    queueProcess(script: FakeProcessScript): void {
        this.processScripts.push(script)
    }

    async stat(path: string): Promise<NativeStat> {
        this.calls.push({ method: 'stat', args: [path] })
        const norm = this.normalize(path)
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
        const hit = this.files.get(this.normalize(path))
        if (!hit) throw new Error(`readFile ${path}: not found`)
        return hit
    }

    async readFileIfExists(path: string): Promise<Uint8Array | null> {
        this.calls.push({ method: 'readFileIfExists', args: [path] })
        return this.files.get(this.normalize(path)) ?? null
    }

    async writeFile(path: string, data: Uint8Array): Promise<void> {
        this.calls.push({ method: 'writeFile', args: [path, data] })
        this.files.set(this.normalize(path), data)
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
        return entries
    }

    async removeFile(path: string): Promise<void> {
        this.calls.push({ method: 'removeFile', args: [path] })
        this.files.delete(this.normalize(path))
    }

    async removeDir(path: string): Promise<void> {
        this.calls.push({ method: 'removeDir', args: [path] })
        this.dirs.delete(this.normalize(path))
    }

    async lookPath(name: string): Promise<string | null> {
        this.calls.push({ method: 'lookPath', args: [name] })
        return null
    }

    async realPath(path: string): Promise<string> {
        this.calls.push({ method: 'realPath', args: [path] })
        return path
    }

    async runtimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }> {
        this.calls.push({ method: 'runtimeInfo', args: [] })
        return { ...this.info }
    }

    async startProcess(input: ProcessStartInput): Promise<ProcessOperation> {
        this.calls.push({ method: 'startProcess', args: [input] })
        const stream = new FakeOperationStream(input.operationId, () => {})
        const script = this.processScripts.shift() ?? {
            chunks: ['command output\n'],
            exitCode: 0,
        }

        setTimeout(() => {
            if (script.error) {
                stream.push({ kind: 'error', error: script.error })
            } else {
                if (script.chunks) {
                    for (const chunk of script.chunks) {
                        stream.push({ kind: 'process-stdout', encoding: 'utf8', data: chunk })
                    }
                }
                if (script.stderrChunks) {
                    for (const chunk of script.stderrChunks) {
                        stream.push({ kind: 'process-stderr', encoding: 'utf8', data: chunk })
                    }
                }
                stream.push({ kind: 'done', exitCode: script.exitCode ?? 0 })
            }
        }, 1)

        return {
            operationId: input.operationId,
            fullOutputPath: script.fullOutputPath ?? `/tmp/${input.operationId}.log`,
            events: {
                [Symbol.asyncIterator]() {
                    return stream.createIterator()
                },
            },
        }
    }
}
