import type { ComposerRunStatus } from '@cpa/plugin-api'

/**
 * Checks whether the current/latest conversation turn has completed cleanly.
 * When the turn has finished (e.g. runStatus === 'done' or the latest assistant
 * message has status === 'done' with no pending/running tool calls), the composer
 * should display the default disabled send button (ArrowUp) rather than a resume button.
 */
export function isTurnCompleted(
    messages?: readonly any[],
    runStatus?: ComposerRunStatus,
    isStreaming = false,
): boolean {
    if (isStreaming) {
        return false
    }
    if (runStatus === 'done') {
        return true
    }
    if (!messages || messages.length === 0) {
        return false
    }

    // Traverse backwards to find the latest conversational message
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m && m.kind === 'message') {
            if (m.role === 'user') {
                return false
            }
            if (m.role === 'assistant') {
                // If streaming, aborted, error, or interrupted, it is not cleanly completed
                if (
                    m.status === 'streaming' ||
                    m.status === 'aborted' ||
                    m.status === 'error' ||
                    Boolean(m.interrupted)
                ) {
                    return false
                }

                // Check for any pending or running tool calls in message parts
                if (Array.isArray(m.parts) && m.parts.length > 0) {
                    const hasUnfinishedTool = m.parts.some(
                        (p: any) =>
                            p &&
                            p.type === 'tool_call' &&
                            (p.status === 'pending' || p.status === 'running'),
                    )
                    if (hasUnfinishedTool) {
                        return false
                    }
                }

                return m.status === 'done'
            }
            break
        }
    }

    return false
}
