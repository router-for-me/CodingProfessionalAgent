/**
 * Shared truncation utilities for tool outputs (browser-safe, no Buffer).
 *
 * Truncation is based on two independent limits — whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines for head truncation.
 * Tail truncation may return a UTF-8-safe partial last line only when that
 * single trailing line alone exceeds the byte limit.
 */

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export type TruncatedBy = 'lines' | 'bytes' | null

export interface TruncateOptions {
    maxLines?: number
    maxBytes?: number
}

export interface TruncateResult {
    content: string
    truncated: boolean
    truncatedBy: TruncatedBy
    totalLines: number
    totalBytes: number
    outputLines: number
    outputBytes: number
    lastLinePartial: boolean
    firstLineExceedsLimit: boolean
    maxLines: number
    maxBytes: number
}

const textEncoder = new TextEncoder()

function resolveTruncateLimits(options: TruncateOptions): { maxLines: number; maxBytes: number } {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new Error('maxLines must be a positive integer')
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new Error('maxBytes must be a positive integer')
    }
    return { maxLines, maxBytes }
}

/** UTF-8 byte length of a string (TextEncoder, no Buffer). */
export function utf8ByteLength(value: string): number {
    return textEncoder.encode(value).byteLength
}

/**
 * Split content into lines for counting.
 * Empty string → no lines. Trailing newline does not create an extra empty line.
 */
export function splitLinesForCounting(content: string): string[] {
    if (content.length === 0) {
        return []
    }
    const lines = content.split('\n')
    if (content.endsWith('\n')) {
        lines.pop()
    }
    return lines
}

/** Format bytes as a human-readable size. */
export function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Never returns partial lines. If the first line exceeds the byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncateOptions = {}): TruncateResult {
    const { maxLines, maxBytes } = resolveTruncateLimits(options)
    const totalBytes = utf8ByteLength(content)
    const lines = splitLinesForCounting(content)
    const totalLines = lines.length

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines,
            totalBytes,
            outputLines: totalLines,
            outputBytes: totalBytes,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
        }
    }

    const firstLine = lines[0] ?? ''
    const firstLineBytes = utf8ByteLength(firstLine)
    if (firstLineBytes > maxBytes) {
        return {
            content: '',
            truncated: true,
            truncatedBy: 'bytes',
            totalLines,
            totalBytes,
            outputLines: 0,
            outputBytes: 0,
            lastLinePartial: false,
            firstLineExceedsLimit: true,
            maxLines,
            maxBytes,
        }
    }

    const outputLinesArr: string[] = []
    let outputBytesCount = 0
    let truncatedBy: TruncatedBy = 'lines'

    for (let i = 0; i < lines.length && i < maxLines; i += 1) {
        const line = lines[i]!
        const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0)
        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = 'bytes'
            break
        }
        outputLinesArr.push(line)
        outputBytesCount += lineBytes
    }

    if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
        truncatedBy = 'lines'
    }

    const outputContent = outputLinesArr.join('\n')
    return {
        content: outputContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: outputLinesArr.length,
        outputBytes: utf8ByteLength(outputContent),
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines,
        maxBytes,
    }
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * May return a UTF-8-safe partial of the final original line when that single
 * line alone exceeds the byte limit.
 */
export function truncateTail(content: string, options: TruncateOptions = {}): TruncateResult {
    const { maxLines, maxBytes } = resolveTruncateLimits(options)
    const totalBytes = utf8ByteLength(content)
    const lines = splitLinesForCounting(content)
    const totalLines = lines.length

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines,
            totalBytes,
            outputLines: totalLines,
            outputBytes: totalBytes,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
        }
    }

    const outputLinesArr: string[] = []
    let outputBytesCount = 0
    let truncatedBy: TruncatedBy = 'lines'
    let lastLinePartial = false

    for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i -= 1) {
        const line = lines[i]!
        const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0)
        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = 'bytes'
            if (outputLinesArr.length === 0) {
                const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
                outputLinesArr.unshift(truncatedLine)
                outputBytesCount = utf8ByteLength(truncatedLine)
                lastLinePartial = true
            }
            break
        }
        outputLinesArr.unshift(line)
        outputBytesCount += lineBytes
    }

    // Partial last-line output is always a byte-limit outcome, even if one line fills maxLines.
    if (
        !lastLinePartial &&
        outputLinesArr.length >= maxLines &&
        outputBytesCount <= maxBytes
    ) {
        truncatedBy = 'lines'
    }

    const outputContent = outputLinesArr.join('\n')
    return {
        content: outputContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: outputLinesArr.length,
        outputBytes: utf8ByteLength(outputContent),
        lastLinePartial,
        firstLineExceedsLimit: false,
        maxLines,
        maxBytes,
    }
}

/**
 * Keep the trailing end of a string within maxBytes without splitting a UTF-8 codepoint.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
    const bytes = textEncoder.encode(str)
    if (bytes.byteLength <= maxBytes) {
        return str
    }
    let start = bytes.byteLength - maxBytes
    // Skip continuation bytes (10xxxxxx) so we start on a codepoint boundary.
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
        start += 1
    }
    return new TextDecoder('utf-8').decode(bytes.subarray(start))
}
