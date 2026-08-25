export interface AskOption {
    title: string
    description?: string
}

export interface AskRequest {
    id: string
    toolCallId: string
    sessionId: string
    question: string
    options: AskOption[]
    allowCustom: boolean
    customPrompt?: string
    allowSkip: boolean
    createdAt: number
}

export type AskDecision =
    | { type: 'selected'; option: AskOption; index: number }
    | { type: 'custom'; text: string }
    | { type: 'skipped' }
    | { type: 'cancelled' }
    | { type: 'aborted' }

export interface AskState {
    requestsBySession: Record<string, AskRequest | undefined>
    setRequest: (sessionId: string, request: AskRequest | null) => void
    getRequest: (sessionId: string) => AskRequest | undefined
    submitAnswer: (sessionId: string, toolCallId: string, decision: AskDecision) => void
    cancel: (sessionId: string, toolCallId?: string) => void
    clearSession: (sessionId: string) => void
    clearAll: () => void
}
