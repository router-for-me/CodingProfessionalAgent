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
    requestId?: string
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
    followUpMode?: 'steer' | 'queue'
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
    isOpen: boolean
    totalCount: number
    countdown: number
    unfinishedSessionIds: string[]
    unfinishedSubAgentIds: string[]
}

export interface NativeOperation {
    readonly operationId: string
    readonly events: AsyncIterable<NativeEvent>
}

export interface ProcessOperation extends NativeOperation {
    readonly fullOutputPath: string
}

export interface SaveFileInput {
    defaultPath?: string
    title?: string
    content: string
    filters?: Array<{ name: string; extensions: string[] }>
}

export interface SaveFileResult {
    saved: boolean
    filePath?: string
}

export interface NativeBridge {
    runtimeInfo(): Promise<RuntimeInfo>
    readFile(path: string): Promise<Uint8Array>
    writeFile(path: string, data: Uint8Array): Promise<void>
    mkdirAll(path: string): Promise<void>
    removeFile(path: string): Promise<void>
    removeDir?(path: string): Promise<void>
    stat(path: string): Promise<NativeStat>
    readDir(path: string): Promise<readonly NativeDirEntry[]>
    realPath(path: string): Promise<string>
    lookPath(name: string): Promise<string | null>
    openWebSocket(input: WebSocketOpenInput): Promise<NativeOperation>
    sendWebSocket(operationId: string, payload: string): Promise<void>
    startProcess(input: ProcessStartInput): Promise<ProcessOperation>
    cancel(operationId: string): Promise<void>
    SessionBroadcastRunStatus(
        sessionId: string,
        status: 'running' | 'thinking' | 'tool' | 'idle',
        runId: string,
        clientId: string,
    ): Promise<void>
    SessionBroadcastStreamEvent(
        sessionId: string,
        runId: string,
        event: unknown,
    ): Promise<void>
    SessionAbortRun(sessionId: string, reason?: string): Promise<void>
    SessionGetActiveRuns(): Promise<ActiveRunInfo[]>
    SessionDelegateRun(req: SessionDelegateRunRequest): Promise<string>
    saveFile?(options: SaveFileInput): Promise<SaveFileResult>
    startProfiling?(options?: { durationMs?: number; target?: string }): Promise<{ ok: boolean; session?: any; error?: string }>
    stopProfiling?(): Promise<{ ok: boolean; report?: any; rawProfile?: any; error?: string }>
    getProfilingReport?(): Promise<{ ok: boolean; report?: any; error?: string }>
}

/** Low-level Electron bridge surface used by the adapter. */
export interface NativeBridgeBindings {
    RuntimeInfo(): Promise<RuntimeInfo>
    ReadFile(path: string): Promise<{ dataBase64: string }>
    ReadFileIfExists?(path: string): Promise<{ dataBase64: string } | null>
    FileExists?(path: string): Promise<boolean>
    WriteFile(path: string, dataBase64: string): Promise<void>
    MkdirAll(path: string): Promise<void>
    RemoveFile(path: string): Promise<void>
    RemoveDir?(path: string): Promise<void>
    Stat(path: string): Promise<NativeStat>
    ReadDir(path: string): Promise<readonly NativeDirEntry[] | null>
    RealPath(path: string): Promise<string>
    LookPath(name: string): Promise<string>
    OpenWebSocket(req: {
        operationId: string
        url: string
        headers: Record<string, string> | null
        connectTimeoutMs: number
    }): Promise<void>
    SendWebSocket(operationId: string, payload: string): Promise<void>
    StartProcess(req: {
        operationId: string
        executable: string
        args: string[] | null
        cwd: string
        env: Record<string, string> | null
        stdin?: string
    }): Promise<{ fullOutputPath: string }>
    CancelOperation(operationId: string): Promise<void>
    SessionBroadcastRunStatus(
        sessionId: string,
        status: 'running' | 'thinking' | 'tool' | 'idle',
        runId: string,
        clientId: string,
    ): Promise<void>
    SessionBroadcastStreamEvent(
        sessionId: string,
        runId: string,
        event: unknown,
    ): Promise<void>
    SessionAbortRun(sessionId: string, reason?: string): Promise<void>
    SessionGetActiveRuns(): Promise<ActiveRunInfo[]>
    SessionDelegateRun(req: SessionDelegateRunRequest): Promise<string>
    SaveFile?(options: SaveFileInput): Promise<SaveFileResult>
    saveFile?(options: SaveFileInput): Promise<SaveFileResult>
    startProfiling?(options?: { durationMs?: number; target?: string }): Promise<{ ok: boolean; session?: any; error?: string }>
    stopProfiling?(): Promise<{ ok: boolean; report?: any; rawProfile?: any; error?: string }>
    getProfilingReport?(): Promise<{ ok: boolean; report?: any; error?: string }>
}

/** Injectable event source so unit tests do not need the real Electron runtime. */
export interface NativeEventSource {
    on(handler: (event: NativeEvent) => void): () => void
}

export const NATIVE_EVENT_CHANNEL = 'cpa:native'

export const TERMINAL_EVENT_KINDS = new Set<string>(['done', 'error', 'cancelled'])

export function isTerminalEventKind(kind: string): boolean {
    return TERMINAL_EVENT_KINDS.has(kind)
}
