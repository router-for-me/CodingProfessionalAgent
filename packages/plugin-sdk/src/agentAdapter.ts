/**
 * Neutral capability-to-tool and capability-to-native adapters.
 * Binds scoped PluginCapabilityClient to tools, process streaming, and filesystem operations.
 */

import type {
    AgentTool,
    AgentToolContribution,
    PluginCapabilityClient,
    ToolExecutionContext,
    ToolResult,
} from '@cpa/plugin-api'

export interface NativeStat {
    isDir: boolean
    isFile?: boolean
    sizeBytes?: number
    size?: number
    name?: string
    mode?: number
    mtimeMs?: number
    mtime?: number
    isSymlink?: boolean
    target?: string
}

export interface NativeDirEntry {
    name: string
    isDir: boolean
    isFile?: boolean
    isSymlink?: boolean
    sizeBytes?: number
    mtimeMs?: number
}

export interface NativeEvent {
    operationId?: string
    sequence?: number
    kind?: string
    data?: string
    encoding?: string
    exitCode?: number
    closeCode?: number
    reason?: string
    error?: string
}

export interface ProcessStartInput {
    operationId: string
    executable: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    stdin?: string
    signal?: AbortSignal
}

export interface NativeOperation {
    readonly operationId: string
    readonly events: AsyncIterable<NativeEvent | any>
}

export interface ProcessOperation extends NativeOperation {
    readonly fullOutputPath?: string
}

export interface NativeBridge {
    stat(path: string): Promise<NativeStat>
    readFile(path: string): Promise<Uint8Array>
    readFileIfExists?(path: string): Promise<Uint8Array | null>
    writeFile?(path: string, data: Uint8Array): Promise<void>
    mkdirAll?(path: string): Promise<void>
    readDir(path: string): Promise<readonly NativeDirEntry[]>
    removeFile?(path: string): Promise<void>
    removeDir?(path: string, options?: { recursive?: boolean }): Promise<void>
    lookPath?(name: string): Promise<string | null>
    realPath?(path: string): Promise<string>
    runtimeInfo?(): Promise<{ platform?: string; homeDir?: string; userConfigDir?: string; tempDir?: string } | any>
    startProcess?(input: ProcessStartInput): Promise<ProcessOperation>
    cancel?(operationId: string): Promise<void>
}

export function bytesToBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64')
    }
    const chunkSize = 0x8000
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const slice = bytes.subarray(offset, offset + chunkSize)
        binary += String.fromCharCode(...slice)
    }
    return btoa(binary)
}

export function base64ToBytes(dataBase64: string): Uint8Array {
    if (typeof Buffer !== 'undefined') {
        const buf = Buffer.from(dataBase64, 'base64')
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    }
    const binary = atob(dataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

/**
 * Creates a NativeBridge facade backed entirely by a scoped PluginCapabilityClient.
 */
export function createCapabilityNativeAdapter(capabilities: PluginCapabilityClient): NativeBridge {
    return {
        stat: async (path: string): Promise<NativeStat> => {
            const raw = await capabilities.invoke<any>('native:stat', [path])
            return {
                isDir: Boolean(raw?.isDir),
                isFile: Boolean(raw?.isFile),
                sizeBytes: typeof raw?.sizeBytes === 'number' ? raw.sizeBytes : 0,
                mode: raw?.mode,
                mtimeMs: raw?.mtimeMs,
                isSymlink: raw?.isSymlink,
                target: raw?.target,
            }
        },

        readFile: async (path: string): Promise<Uint8Array> => {
            const raw = await capabilities.invoke<any>('native:readFile', [path])
            if (raw instanceof Uint8Array) {
                return raw
            }
            if (raw && typeof raw === 'object' && typeof raw.dataBase64 === 'string') {
                return base64ToBytes(raw.dataBase64)
            }
            if (typeof raw === 'string') {
                return new TextEncoder().encode(raw)
            }
            return new Uint8Array(0)
        },

        readFileIfExists: async (path: string): Promise<Uint8Array | null> => {
            const raw = await capabilities.invoke<any>('native:readFileIfExists', [path])
            if (raw === null || raw === undefined) {
                return null
            }
            if (raw instanceof Uint8Array) {
                return raw
            }
            if (raw && typeof raw === 'object' && typeof raw.dataBase64 === 'string') {
                return base64ToBytes(raw.dataBase64)
            }
            if (typeof raw === 'string') {
                return new TextEncoder().encode(raw)
            }
            return null
        },

        writeFile: async (path: string, data: Uint8Array): Promise<void> => {
            const base64 = bytesToBase64(data)
            await capabilities.invoke('native:writeFile', [path, base64])
        },

        mkdirAll: async (path: string): Promise<void> => {
            await capabilities.invoke('native:mkdirAll', [path])
        },

        readDir: async (path: string): Promise<readonly NativeDirEntry[]> => {
            const raw = await capabilities.invoke<any[]>('native:readDir', [path])
            if (!Array.isArray(raw)) {
                return []
            }
            return raw.map((item) => ({
                name: item.name ?? '',
                isDir: Boolean(item.isDir),
                isFile: Boolean(item.isFile),
                isSymlink: item.isSymlink,
                sizeBytes: item.sizeBytes,
                mtimeMs: item.mtimeMs,
            }))
        },

        removeFile: async (path: string): Promise<void> => {
            await capabilities.invoke('native:removeFile', [path])
        },

        removeDir: async (path: string, options?: { recursive?: boolean }): Promise<void> => {
            await capabilities.invoke('native:removeDir', [path, options])
        },

        lookPath: async (name: string): Promise<string | null> => {
            return capabilities.invoke<string | null>('native:lookPath', [name])
        },

        realPath: async (path: string): Promise<string> => {
            return capabilities.invoke<string>('native:realPath', [path])
        },

        runtimeInfo: async () => {
            const raw = await capabilities.invoke<any>('native:runtimeInfo', [])
            return {
                platform: raw?.platform ?? 'darwin',
                homeDir: raw?.homeDir ?? '',
                userConfigDir: raw?.userConfigDir ?? '',
                tempDir: raw?.tempDir ?? '',
            }
        },

        startProcess: async (input: ProcessStartInput): Promise<ProcessOperation> => {
            const operationId =
                input.operationId ||
                `proc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

            // Prefer blocking run-to-completion. Capability event subscriptions are
            // unreliable for short-lived hook commands (async subscribe + missing
            // process:event fan-out), which previously left tools stuck in "queued".
            const synthesizeEvents = (events: NativeEvent[]): AsyncIterable<NativeEvent> => ({
                [Symbol.asyncIterator]() {
                    let index = 0
                    return {
                        async next(): Promise<IteratorResult<NativeEvent>> {
                            if (index < events.length) {
                                return { value: events[index++]!, done: false }
                            }
                            return { value: undefined as any, done: true }
                        },
                        async return() {
                            index = events.length
                            return { value: undefined as any, done: true }
                        },
                    }
                },
            })

            if (input.signal?.aborted) {
                return {
                    operationId,
                    fullOutputPath: '',
                    events: synthesizeEvents([
                        {
                            operationId,
                            sequence: 1,
                            kind: 'cancelled',
                            exitCode: 130,
                        },
                    ]),
                }
            }

            let aborted = false
            const onAbort = (): void => {
                aborted = true
                void capabilities.invoke('native:cancelOperation', [operationId]).catch(() => {})
            }
            if (input.signal) {
                input.signal.addEventListener('abort', onAbort, { once: true })
            }

            let raw: any
            try {
                raw = await capabilities.invoke<any>('native:runProcess', [
                    {
                        operationId,
                        executable: input.executable,
                        args: input.args ?? null,
                        cwd: input.cwd ?? '',
                        env: input.env ?? null,
                        stdin: input.stdin,
                    },
                ])
            } finally {
                input.signal?.removeEventListener('abort', onAbort)
            }

            const fullOutputPath = raw?.fullOutputPath ?? ''
            const synthesized: NativeEvent[] = []
            let sequence = 1

            if (raw?.stdoutBase64) {
                synthesized.push({
                    operationId,
                    sequence: sequence++,
                    kind: 'process-stdout',
                    data: String(raw.stdoutBase64),
                    encoding: 'base64',
                })
            }
            if (raw?.stderrBase64) {
                synthesized.push({
                    operationId,
                    sequence: sequence++,
                    kind: 'process-stderr',
                    data: String(raw.stderrBase64),
                    encoding: 'base64',
                })
            }

            if (aborted || raw?.cancelled) {
                synthesized.push({
                    operationId,
                    sequence: sequence++,
                    kind: 'cancelled',
                    exitCode: typeof raw?.exitCode === 'number' ? raw.exitCode : 130,
                })
            } else if (raw?.error) {
                synthesized.push({
                    operationId,
                    sequence: sequence++,
                    kind: 'error',
                    error: String(raw.error),
                })
            } else {
                synthesized.push({
                    operationId,
                    sequence: sequence++,
                    kind: 'done',
                    exitCode: typeof raw?.exitCode === 'number' ? raw.exitCode : 0,
                })
            }

            return {
                operationId,
                fullOutputPath,
                events: synthesizeEvents(synthesized),
            }
        },

        cancel: async (operationId: string): Promise<void> => {
            await capabilities.invoke('native:cancelOperation', [operationId])
        },
    }
}

/**
 * Adapts an AgentToolContribution into the runtime AgentTool interface.
 * Forwards onUpdate, re-throws AbortError on cancellation, and preserves standard errors.
 */
export function adaptPluginToolToAgentTool(contrib: AgentToolContribution): AgentTool {
    return {
        name: contrib.name,
        label: contrib.name,
        description: contrib.description,
        parameters: contrib.parameters ?? {
            type: 'object',
            properties: {},
        },
        ...(contrib.targetAgent ? { targetAgent: contrib.targetAgent } : {}),
        ...(contrib.requiresScheduledSession !== undefined
            ? { requiresScheduledSession: contrib.requiresScheduledSession }
            : {}),
        validate(input: unknown): Record<string, unknown> {
            if (input && typeof input === 'object' && !Array.isArray(input)) {
                return input as Record<string, unknown>
            }
            return {}
        },
        async execute(
            _toolCallId: string,
            args: Record<string, unknown>,
            context: ToolExecutionContext,
        ): Promise<ToolResult> {
            if (context?.signal?.aborted) {
                const abortErr = new Error('Tool execution was aborted')
                abortErr.name = 'AbortError'
                throw abortErr
            }

            try {
                const raw = await contrib.execute(args, {
                    ...context,
                    onUpdate: (partial: any) => {
                        if (typeof context?.onUpdate === 'function') {
                            context.onUpdate(partial)
                        }
                    },
                })

                if (context?.signal?.aborted) {
                    const abortErr = new Error('Tool execution was aborted')
                    abortErr.name = 'AbortError'
                    throw abortErr
                }

                if (raw && typeof raw === 'object' && Array.isArray((raw as any).content)) {
                    return raw as ToolResult
                }

                const text =
                    typeof raw === 'string'
                        ? raw
                        : raw === undefined
                          ? ''
                          : JSON.stringify(raw, null, 2)
                return {
                    content: [{ type: 'text', text }],
                    details: raw,
                    isError: false,
                }
            } catch (err: any) {
                // If the error was caused by abort, re-throw directly
                if (
                    err?.name === 'AbortError' ||
                    context?.signal?.aborted ||
                    /abort/i.test(err?.message || '')
                ) {
                    if (err instanceof Error) throw err
                    const abortErr = new Error(String(err))
                    abortErr.name = 'AbortError'
                    throw abortErr
                }

                const message = err instanceof Error ? err.message : String(err)
                return {
                    content: [
                        { type: 'text', text: `Tool execution error: ${message}` },
                    ],
                    details: err,
                    isError: true,
                }
            }
        },
    }
}
