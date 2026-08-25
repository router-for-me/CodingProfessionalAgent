/**
 * Neutral text and line truncation utilities.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 // 50 KB
export const DEFAULT_MAX_OUTPUT_LINES = 2000

export function truncateText(text: string, maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES): string {
    if (typeof text !== 'string') return ''
    const encoder = new TextEncoder()
    const bytes = encoder.encode(text)
    if (bytes.length <= maxBytes) {
        return text
    }

    const decoder = new TextDecoder('utf-8', { fatal: false })
    const truncatedBytes = bytes.subarray(0, maxBytes)
    return `${decoder.decode(truncatedBytes)}\n\n[Output truncated: exceeded ${maxBytes} bytes limit]`
}

export function truncateLines(text: string, maxLines: number = DEFAULT_MAX_OUTPUT_LINES): string {
    if (typeof text !== 'string') return ''
    const lines = text.split('\n')
    if (lines.length <= maxLines) {
        return text
    }

    const keptLines = lines.slice(0, maxLines)
    return `${keptLines.join('\n')}\n\n[Output truncated: exceeded ${maxLines} lines limit]`
}
