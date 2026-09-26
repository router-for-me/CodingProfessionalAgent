/**
 * Codex Responses protocol shapes used by request builders and stream parsers.
 */

export type CodexInputTextPart = {
    type: 'input_text'
    text: string
}

export type CodexInputImagePart = {
    type: 'input_image'
    detail: 'auto'
    image_url: string
}

export type CodexUserContentPart = CodexInputTextPart | CodexInputImagePart

export type CodexOutputTextPart = {
    type: 'output_text'
    text: string
    annotations: unknown[]
}

export type CodexUserMessageItem = {
    role: 'user'
    content: CodexUserContentPart[]
}

export type CodexDeveloperMessageItem = {
    type?: 'message'
    role: 'developer'
    content: CodexUserContentPart[]
}

export type CodexAssistantMessageItem = {
    type: 'message'
    role: 'assistant'
    content: CodexOutputTextPart[]
    status: 'completed'
    id: string
    phase?: 'commentary' | 'final_answer'
}

export type CodexFunctionCallItem = {
    type: 'function_call'
    /** Responses item id (fc_...), optional when unavailable. */
    id?: string
    call_id: string
    name: string
    arguments: string
}

export type CodexFunctionCallOutputItem = {
    type: 'function_call_output'
    call_id: string
    output: string | CodexUserContentPart[]
}

export type CodexReasoningSummaryPart = {
    type: 'summary_text'
    text: string
}

export type CodexReasoningContentPart = {
    type: 'reasoning_text'
    text: string
}

export type CodexReasoningStatus = 'in_progress' | 'completed' | 'incomplete'

/**
 * Restored Responses reasoning item. Keep this shape narrow so callers cannot
 * push arbitrary Record payloads onto the wire.
 */
export type CodexReasoningItem = {
    type: 'reasoning'
    id: string
    summary: CodexReasoningSummaryPart[]
    encrypted_content?: string | null
    status?: CodexReasoningStatus
    content?: CodexReasoningContentPart[]
}

/**
 * Mid-conversation configuration update item for dynamic reasoning effort adjustment.
 */
export type CodexConfigurationUpdateItem = {
    type: 'configuration_update'
    reasoning: {
        effort: string
    }
}

export type CodexInputItem =
    | CodexUserMessageItem
    | CodexAssistantMessageItem
    | CodexDeveloperMessageItem
    | CodexFunctionCallItem
    | CodexFunctionCallOutputItem
    | CodexReasoningItem
    | CodexConfigurationUpdateItem

export type CodexFunctionTool = {
    type: 'function'
    name: string
    description: string
    parameters: Record<string, unknown>
    strict: null
}

export type CodexNativeTool = {
    type: 'web_search'
}

export type CodexTool = CodexFunctionTool | CodexNativeTool

export type CodexReasoningConfig = {
    effort: string
    summary: 'auto' | string
}

export type CodexResponseCreate = {
    type: 'response.create'
    model: string
    store: false
    stream: true
    instructions: string
    input: CodexInputItem[]
    text: { verbosity: string }
    include: string[]
    prompt_cache_key: string
    tool_choice?: 'auto' | 'required' | 'none'
    parallel_tool_calls?: boolean
    tools?: CodexTool[]
    reasoning?: CodexReasoningConfig
    service_tier?: 'priority'
    previous_response_id?: string
    /**
     * Optional output budget. Summary-only compaction requests may set this;
     * normal agent turns must omit it.
     */
    max_output_tokens?: number
}

/** Tool schema surface needed by request construction. */
export type CodexToolDefinition = {
    name: string
    description: string
    parameters: Record<string, unknown>
}

export type NativeEventEncoding = 'utf8' | 'base64'

export interface NativeEvent {
    operationId: string
    sequence: number
    kind: string
    data?: string
    encoding?: NativeEventEncoding
    exitCode?: number
    closeCode?: number
    reason?: string
    error?: string
}

export interface NativeOperation {
    operationId: string
    events: AsyncIterable<NativeEvent>
    cancel?: (reason?: string) => Promise<void>
}

export interface WebSocketOpenInput {
    operationId: string
    url: string
    headers?: Readonly<Record<string, string>>
    connectTimeoutMs: number
    signal?: AbortSignal
}

export interface NativeBridge {
    openWebSocket?: (input: WebSocketOpenInput) => Promise<NativeOperation>
    sendWebSocket?: (operationId: string, payload: string) => Promise<void>
    closeWebSocket?: (operationId: string, code?: number, reason?: string) => Promise<void>
    cancel?: (operationId: string, reason?: string) => Promise<void>
    cancelOperation?: (operationId: string, reason?: string) => Promise<void>
}
