import type {
    AgentTarget,
    AgentTool,
    HostServices,
    ToolExecutionContext,
    ToolFactoryContribution,
    ToolFactoryContext,
    ToolResult,
    ToolResultContentBlock,
    ToolRiskLevel,
} from '@cpa/plugin-api'

export type {
    AgentTarget,
    AgentTool,
    HostServices,
    ToolExecutionContext,
    ToolFactoryContribution,
    ToolFactoryContext,
    ToolResult,
    ToolResultContentBlock,
    ToolRiskLevel,
}

export interface NativeStat {
    isDir: boolean
    isFile: boolean
    sizeBytes: number
    mode?: number
    mtimeMs?: number
    isSymlink?: boolean
    target?: string
}

export interface NativeDirEntry {
    name: string
    isDir: boolean
    isFile: boolean
    isSymlink?: boolean
    sizeBytes?: number
    mtimeMs?: number
}

export interface NativeEvent {
    type?: string
    kind?: string
    operationId?: string
    sequence?: number
    data?: string
    encoding?: string
    exitCode?: number
    error?: string
    [key: string]: unknown
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
    readonly events: AsyncIterable<NativeEvent>
}

export interface ProcessOperation extends NativeOperation {
    readonly fullOutputPath: string
}

export interface NativeBridge {
    stat(path: string): Promise<NativeStat>
    readFile(path: string): Promise<Uint8Array>
    readFileIfExists?(path: string): Promise<Uint8Array | null>
    writeFile(path: string, data: Uint8Array): Promise<void>
    mkdirAll(path: string): Promise<void>
    readDir(path: string): Promise<readonly NativeDirEntry[]>
    removeFile(path: string): Promise<void>
    removeDir?(path: string, options?: { recursive?: boolean }): Promise<void>
    lookPath(name: string): Promise<string | null>
    realPath(path: string): Promise<string>
    runtimeInfo(): Promise<{ platform: string; homeDir: string; userConfigDir: string; tempDir: string }>
    startProcess(input: ProcessStartInput): Promise<ProcessOperation>
    cancel?(operationId: string): Promise<void>
}
