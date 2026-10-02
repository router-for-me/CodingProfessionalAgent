import type { ToolResult, ToolResultContentBlock } from '@cpa/plugin-api'

export interface CellTool {
    name: string
    identifier: string
    description: string
}
export interface StartCell {
    cellId?: string
    sessionId: string
    source: string
    tools: CellTool[]
    yieldTimeMs: number
    maxOutputTokens: number
}
export interface ObserveCell {
    sessionId: string
    cellId: string
    yieldTimeMs: number
    maxOutputTokens: number
    terminate?: boolean
}
export type CellStatus = 'running' | 'yielded' | 'completed' | 'failed' | 'terminated' | 'missing'
export interface CellObservation {
    cellId: string
    status: CellStatus
    content: ToolResultContentBlock[]
    error?: string
}
export interface ToolRequest {
    cellId: string
    invocationId: string
    toolName: string
    input: unknown
}
export type ExecutorCommand =
    | { type: 'start'; requestId: string; input: StartCell }
    | { type: 'observe'; requestId: string; input: ObserveCell }
    | { type: 'tool-result'; invocationId: string; result: ToolResult }
    | { type: 'cancel'; sessionId: string; cellId?: string; cancelId?: string }
export type ExecutorEvent =
    | { type: 'cancelled'; cancelId: string }
    | { type: 'observation'; requestId: string; observation: CellObservation }
    | { type: 'tool-request'; request: ToolRequest }
    | { type: 'notify'; cellId: string; observation: CellObservation }
    | { type: 'completed'; cellId: string }
export const CELL_RPC = 'code-cell:command'
export const CELL_EVENT = 'code-cell:event'
export const CELL_CAPABILITY = 'code-cell.execute'

export function observationResult(observation: CellObservation): ToolResult {
    const running = observation.status === 'running' || observation.status === 'yielded'
    const label = running
        ? `Cell ${observation.cellId} yielded; use wait with cell_id to continue.`
        : `Cell ${observation.cellId} ${observation.status}${observation.error ? `: ${observation.error}` : '.'}`
    return {
        content: [...observation.content, { type: 'text', text: label }],
        details: { cellId: observation.cellId, status: observation.status },
        displayMetadata: { cellId: observation.cellId, status: observation.status },
        isError: ['failed', 'terminated', 'missing'].includes(observation.status),
    }
}
