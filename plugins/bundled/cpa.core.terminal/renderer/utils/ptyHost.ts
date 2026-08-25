import type { PluginCapabilityClient } from '@cpa/plugin-api'

export interface NativePtyEvent {
    kind: string
    operationId: string
    data?: string
    encoding?: string
    error?: string
    exitCode?: number
    signal?: string
    [key: string]: unknown
}

export interface NativeEventSource {
    on(listener: (event: NativePtyEvent) => void): () => void
}

export interface PtyBindings {
    StartPty(req: {
        operationId: string
        cwd: string
        cols: number
        rows: number
        shell?: string
    }): Promise<void>
    WritePty(operationId: string, dataBase64: string): Promise<void>
    ResizePty(operationId: string, cols: number, rows: number): Promise<void>
    ClosePty?(operationId: string): Promise<void>
    CancelOperation(operationId: string): Promise<void>
}

export interface StartPtyInput {
    operationId: string
    cwd: string
    cols: number
    rows: number
    shell?: string
    onData: (bytes: Uint8Array) => void
    onExit: (event: NativePtyEvent) => void
}

export interface PtySessionHandle {
    write(text: string): Promise<void>
    resize(cols: number, rows: number): Promise<void>
    dispose(): Promise<void>
}

export function isTerminalEventKind(kind: string): boolean {
    return (
        kind === 'done' ||
        kind === 'error' ||
        kind === 'cancelled' ||
        kind === 'pty-exit' ||
        kind === 'pty-error' ||
        kind === 'completed' ||
        kind === 'failed'
    )
}

export function bytesToBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('base64')
    }
    let binary = ''
    const len = bytes.byteLength
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
    if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(base64, 'base64'))
    }
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

export function createDefaultPtyBindings(capabilityClient?: PluginCapabilityClient | null): PtyBindings {
    if (capabilityClient) {
        return {
            StartPty: async (req) => {
                await capabilityClient.invoke('native:startPty', [req])
            },
            WritePty: async (operationId, dataBase64) => {
                await capabilityClient.invoke('native:writePty', [operationId, dataBase64])
            },
            ResizePty: async (operationId, cols, rows) => {
                await capabilityClient.invoke('native:resizePty', [operationId, cols, rows])
            },
            ClosePty: async (operationId) => {
                await capabilityClient.invoke('native:closePty', [operationId])
            },
            CancelOperation: async (operationId) => {
                await capabilityClient.invoke('native:cancelOperation', [operationId])
            },
        }
    }

    return {
        StartPty: async () => {
            throw new Error('PTY capability is unavailable')
        },
        WritePty: async () => {
            throw new Error('PTY capability is unavailable')
        },
        ResizePty: async () => {
            throw new Error('PTY capability is unavailable')
        },
        ClosePty: async () => {},
        CancelOperation: async () => {
            throw new Error('PTY capability is unavailable')
        },
    }
}

export function createDefaultPtyEventSource(capabilityClient?: PluginCapabilityClient | null): NativeEventSource {
    if (capabilityClient?.subscribe) {
        return {
            on: (listener) => capabilityClient.subscribe('native-event', (event: any) => listener(event)),
        }
    }

    return { on: () => () => undefined }
}

export async function startPtySession(
    input: StartPtyInput,
    bindings: PtyBindings = createDefaultPtyBindings(),
    events: NativeEventSource = createDefaultPtyEventSource(),
): Promise<PtySessionHandle> {
    let finished = false
    const unsubscribe = events.on((event) => {
        if (event.operationId !== input.operationId || finished) return
        if (event.kind === 'pty-stdout' && event.data) {
            input.onData(
                event.encoding === 'base64'
                    ? base64ToBytes(event.data)
                    : new TextEncoder().encode(event.data),
            )
        }
        if (isTerminalEventKind(event.kind)) {
            finished = true
            input.onExit(event)
        }
    })

    try {
        await bindings.StartPty({
            operationId: input.operationId,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            shell: input.shell,
        })
    } catch (error) {
        unsubscribe()
        throw error
    }

    return {
        write: async (text) => {
            if (finished || text.length === 0) return
            await bindings.WritePty(
                input.operationId,
                bytesToBase64(new TextEncoder().encode(text)),
            )
        },
        resize: async (cols, rows) => {
            if (finished) return
            await bindings.ResizePty(input.operationId, cols, rows)
        },
        dispose: async () => {
            if (finished) {
                unsubscribe()
                return
            }
            finished = true
            unsubscribe()
            try {
                if (bindings.ClosePty) {
                    await bindings.ClosePty(input.operationId)
                } else {
                    await bindings.CancelOperation(input.operationId)
                }
            } catch {
                // Ignore cleanup errors during shutdown
            }
        },
    }
}
