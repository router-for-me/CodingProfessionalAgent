/**
 * Output parser for hook command/tool executions.
 * Normalizes wire outputs according to CPA hook schemas.
 */

import type {
    HookOutputEntry,
    StatelessHookOutput,
} from './types.js'

export interface ParsedHookExecution<T = Record<string, unknown>> {
    success: boolean
    exitCode: number
    data: T
    entries: HookOutputEntry[]
    rawStdout: string
    rawStderr: string
}

const DEFAULT_ADDITIONAL_CONTEXT_LIMIT = 2500

/**
 * Truncates additional context text if it exceeds the token/char limit.
 */
export function applyAdditionalContextLimit(
    contextText: string,
    limit?: number | null,
): { text: string; truncated: boolean } {
    const tokenLimit = limit === undefined || limit === null ? DEFAULT_ADDITIONAL_CONTEXT_LIMIT : limit
    if (tokenLimit <= 0) {
        return { text: contextText, truncated: false }
    }

    // Estimate 4 characters per token
    const maxChars = tokenLimit * 4
    if (contextText.length <= maxChars) {
        return { text: contextText, truncated: false }
    }

    const truncatedText =
        contextText.slice(0, maxChars) +
        `\n\n[Context truncated: exceeded limit of ${tokenLimit} tokens]`
    return { text: truncatedText, truncated: true }
}

/**
 * Parses stdout and stderr from a hook command execution into a typed output object.
 */
export function parseHookCommandOutput<T = StatelessHookOutput>(
    stdout: string,
    stderr: string,
    exitCode: number,
    additionalContextLimit?: number | null,
): ParsedHookExecution<T> {
    const entries: HookOutputEntry[] = []
    const trimmedStderr = stderr.trim()
    const trimmedStdout = stdout.trim()

    if (trimmedStderr) {
        entries.push({
            kind: exitCode === 0 ? 'warning' : 'error',
            text: trimmedStderr,
        })
    }

    let parsedJson: Record<string, unknown> | null = null
    if (trimmedStdout) {
        try {
            parsedJson = JSON.parse(trimmedStdout)
        } catch {
            // Not JSON format
        }
    }

    let data: T

    if (parsedJson && typeof parsedJson === 'object') {
        const normalized = { ...parsedJson } as Record<string, unknown>

        // If continue is not explicitly set, default to true on exitCode 0, false otherwise
        if (typeof normalized.continue !== 'boolean') {
            normalized.continue = exitCode === 0
        }

        // Check if hookSpecificOutput contains additionalContext
        const hookSpecific = normalized.hookSpecificOutput as Record<string, unknown> | undefined
        if (hookSpecific && typeof hookSpecific === 'object') {
            if (typeof hookSpecific.additionalContext === 'string' && hookSpecific.additionalContext) {
                const { text, truncated } = applyAdditionalContextLimit(
                    hookSpecific.additionalContext,
                    additionalContextLimit,
                )
                hookSpecific.additionalContext = text
                entries.push({
                    kind: 'context',
                    text: truncated ? `Context appended (truncated)` : `Context appended`,
                })
            }
        }

        if (typeof normalized.systemMessage === 'string' && normalized.systemMessage) {
            entries.push({
                kind: 'feedback',
                text: normalized.systemMessage,
            })
        }

        if (typeof normalized.stopReason === 'string' && normalized.stopReason) {
            entries.push({
                kind: 'stop',
                text: `Stop requested: ${normalized.stopReason}`,
            })
        }

        data = normalized as unknown as T
    } else {
        // Fallback when stdout is plain text or empty
        const shouldContinue = exitCode === 0
        const fallback: Record<string, unknown> = {
            continue: shouldContinue,
        }

        if (trimmedStdout && exitCode === 0) {
            // Treat non-empty stdout on success as additional context
            const { text } = applyAdditionalContextLimit(
                trimmedStdout,
                additionalContextLimit,
            )
            fallback.hookSpecificOutput = {
                additionalContext: text,
            }
            entries.push({
                kind: 'context',
                text: 'Context appended from output',
            })
        }

        data = fallback as unknown as T
    }

    return {
        success: exitCode === 0,
        exitCode,
        data,
        entries,
        rawStdout: stdout,
        rawStderr: stderr,
    }
}
