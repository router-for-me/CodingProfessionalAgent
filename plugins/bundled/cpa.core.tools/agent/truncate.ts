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

export interface TruncateHeadAndTailOptions extends TruncateOptions {
    headLines?: number
    tailLines?: number
    headBytes?: number
    tailBytes?: number
    fullOutputPath?: string
}

export interface TruncateHeadAndTailResult extends TruncateResult {
    headLines: number
    tailLines: number
    omittedLines: number
    omittedBytes: number
    headContent: string
    tailContent: string
    fullOutputPath?: string
}

export interface FormatTruncatedOutputOptions {
    headContent: string
    tailContent: string
    omittedLines: number
    omittedBytes: number
    totalLines: number
    headLines: number
    tailLines: number
    fullOutputPath?: string
    truncatedBy?: TruncatedBy
    maxBytes?: number
    lastLinePartial?: boolean
    lastLineBytes?: number
    totalBytes?: number
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
 * Keep the leading start of a string within maxBytes without splitting a UTF-8 codepoint.
 */
export function truncateStringToBytesFromStart(str: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return ''
    }
    const bytes = textEncoder.encode(str)
    if (bytes.byteLength <= maxBytes) {
        return str
    }
    let end = maxBytes
    // If bytes[end] is a continuation byte (10xxxxxx), walk back to its leading byte.
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) {
        end -= 1
    }
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(0, end))
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
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(start))
}

export function resolveHeadAndTailLimits(options: TruncateHeadAndTailOptions): {
    maxLines: number
    maxBytes: number
    headLines: number
    tailLines: number
    headBytes: number
    tailBytes: number
} {
    const { maxLines, maxBytes } = resolveTruncateLimits(options)

    if (options.headLines !== undefined) {
        if (!Number.isSafeInteger(options.headLines) || options.headLines < 0) {
            throw new Error('headLines must be a non-negative integer')
        }
    }
    if (options.tailLines !== undefined) {
        if (!Number.isSafeInteger(options.tailLines) || options.tailLines < 0) {
            throw new Error('tailLines must be a non-negative integer')
        }
    }

    let headLines: number
    let tailLines: number

    if (options.headLines === undefined && options.tailLines === undefined) {
        if (maxLines === 1) {
            headLines = 1
            tailLines = 0
        } else {
            headLines = Math.floor(maxLines / 2)
            tailLines = maxLines - headLines
        }
    } else if (options.headLines === undefined) {
        tailLines = options.tailLines!
        headLines = Math.max(0, maxLines - tailLines)
    } else if (options.tailLines === undefined) {
        headLines = options.headLines
        tailLines = Math.max(0, maxLines - headLines)
    } else {
        headLines = options.headLines
        tailLines = options.tailLines
    }

    if (headLines + tailLines > maxLines) {
        throw new Error('headLines + tailLines must not exceed maxLines')
    }

    if (options.headBytes !== undefined) {
        if (!Number.isSafeInteger(options.headBytes) || options.headBytes < 0) {
            throw new Error('headBytes must be a non-negative integer')
        }
    }
    if (options.tailBytes !== undefined) {
        if (!Number.isSafeInteger(options.tailBytes) || options.tailBytes < 0) {
            throw new Error('tailBytes must be a non-negative integer')
        }
    }

    let headBytes: number
    let tailBytes: number

    if (options.headBytes === undefined && options.tailBytes === undefined) {
        if (maxBytes === 1) {
            headBytes = 1
            tailBytes = 0
        } else {
            headBytes = Math.floor(maxBytes / 2)
            tailBytes = maxBytes - headBytes
        }
    } else if (options.headBytes === undefined) {
        tailBytes = options.tailBytes!
        headBytes = Math.max(0, maxBytes - tailBytes)
    } else if (options.tailBytes === undefined) {
        headBytes = options.headBytes
        tailBytes = Math.max(0, maxBytes - headBytes)
    } else {
        headBytes = options.headBytes
        tailBytes = options.tailBytes
    }

    if (headBytes + tailBytes > maxBytes) {
        throw new Error('headBytes + tailBytes must not exceed maxBytes')
    }

    return { maxLines, maxBytes, headLines, tailLines, headBytes, tailBytes }
}

/**
 * Format truncated tool output preserving both head and tail sections,
 * with middle omission marker and informative footer.
 */
export function formatTruncatedOutput(options: FormatTruncatedOutputOptions): string {
    const {
        headContent,
        tailContent,
        omittedLines,
        omittedBytes,
        totalLines,
        headLines,
        tailLines,
        fullOutputPath,
        truncatedBy = 'lines',
        maxBytes = DEFAULT_MAX_BYTES,
        lastLinePartial = false,
        lastLineBytes,
    } = options

    const lineWord = omittedLines === 1 ? 'line' : 'lines'
    const fullPathNote = fullOutputPath ? `. Full output: ${fullOutputPath}` : ''
    let marker: string
    if (omittedLines > 0) {
        marker = `[... ${omittedLines} ${lineWord} truncated (${formatSize(omittedBytes)})${fullPathNote} ...]`
    } else {
        marker = `[... ${formatSize(omittedBytes)} truncated${fullPathNote} ...]`
    }

    let text: string
    if (headContent && tailContent) {
        text = `${headContent}\n\n${marker}\n\n${tailContent}`
    } else if (headContent) {
        text = `${headContent}\n\n${marker}`
    } else if (tailContent) {
        text = `${marker}\n\n${tailContent}`
    } else {
        text = marker
    }

    const startTailLine = Math.max(1, totalLines - tailLines + 1)
    const endTailLine = totalLines

    if (headLines > 0 && tailLines > 0) {
        if (totalLines === 1) {
            text += `\n\n[Showing head and tail of line 1 (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        } else if (headLines + tailLines < totalLines) {
            if (truncatedBy === 'lines') {
                text += `\n\n[Showing lines 1-${headLines} and ${startTailLine}-${endTailLine} of ${totalLines}. Full output: ${fullOutputPath}]`
            } else {
                text += `\n\n[Showing lines 1-${headLines} and ${startTailLine}-${endTailLine} of ${totalLines} (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
            }
        } else {
            text += `\n\n[Showing head and tail of ${totalLines} lines (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        }
    } else if (headLines === 0 && tailLines > 0 && lastLinePartial && lastLineBytes !== undefined && lastLineBytes > 0 && totalLines === 1) {
        const lastLineSize = formatSize(lastLineBytes)
        const tailBytesCount = utf8ByteLength(tailContent)
        text += `\n\n[Showing last ${formatSize(tailBytesCount)} of line 1 (line is ${lastLineSize}). Full output: ${fullOutputPath}]`
    } else if (headLines > 0 && tailLines === 0) {
        if (totalLines === 1) {
            text += `\n\n[Showing head of line 1 (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        } else if (truncatedBy === 'lines') {
            text += `\n\n[Showing lines 1-${headLines} of ${totalLines}. Full output: ${fullOutputPath}]`
        } else {
            text += `\n\n[Showing lines 1-${headLines} of ${totalLines} (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        }
    } else if (tailLines > 0 && headLines === 0) {
        if (totalLines === 1) {
            text += `\n\n[Showing tail of line 1 (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        } else if (truncatedBy === 'lines') {
            text += `\n\n[Showing lines ${startTailLine}-${endTailLine} of ${totalLines}. Full output: ${fullOutputPath}]`
        } else {
            text += `\n\n[Showing lines ${startTailLine}-${endTailLine} of ${totalLines} (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
        }
    } else if (truncatedBy === 'lines') {
        const startLine = Math.max(1, totalLines - tailLines + 1)
        text += `\n\n[Showing lines ${startLine}-${endTailLine} of ${totalLines}. Full output: ${fullOutputPath}]`
    } else {
        const startLine = Math.max(1, totalLines - tailLines + 1)
        text += `\n\n[Showing lines ${startLine}-${endTailLine} of ${totalLines} (${formatSize(maxBytes)} limit). Full output: ${fullOutputPath}]`
    }

    return text
}

/**
 * Truncate content by preserving both head and tail, omitting the middle.
 * Suitable for command-line output where both initial setup/commands and
 * final completion/error outputs are important to return to the model.
 */
export function truncateHeadAndTail(
    content: string,
    options: TruncateHeadAndTailOptions = {},
): TruncateHeadAndTailResult {
    const { maxLines, maxBytes, headLines, tailLines, headBytes, tailBytes } =
        resolveHeadAndTailLimits(options)

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
            headLines: totalLines,
            tailLines: 0,
            omittedLines: 0,
            omittedBytes: 0,
            headContent: content,
            tailContent: '',
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
            fullOutputPath: options.fullOutputPath,
        }
    }

    let truncatedBy: TruncatedBy = 'lines'
    if (totalBytes > maxBytes && totalLines <= maxLines) {
        truncatedBy = 'bytes'
    }

    // 1. Collect head lines
    const headLinesArr: string[] = []
    let headBytesCount = 0
    let firstLineExceedsLimit = false
    let lastHeadLinePartial = false

    for (let i = 0; i < lines.length && i < headLines; i += 1) {
        const line = lines[i]!
        const prefixNewline = i > 0 ? 1 : 0
        const lineBytes = utf8ByteLength(line) + prefixNewline
        if (headBytesCount + lineBytes > headBytes) {
            truncatedBy = 'bytes'
            const remainingBytes = headBytes - headBytesCount - prefixNewline
            if (remainingBytes > 0 && headLinesArr.length < headLines) {
                const truncatedLine = truncateStringToBytesFromStart(line, remainingBytes)
                if (truncatedLine.length > 0) {
                    headLinesArr.push(truncatedLine)
                    headBytesCount += prefixNewline + utf8ByteLength(truncatedLine)
                    lastHeadLinePartial = true
                } else if (headLinesArr.length === 0) {
                    firstLineExceedsLimit = true
                }
            } else if (headLinesArr.length === 0) {
                firstLineExceedsLimit = true
            }
            break
        }
        headLinesArr.push(line)
        headBytesCount += lineBytes
    }

    // 2. Collect tail lines
    const tailLinesArr: string[] = []
    let tailBytesCount = 0
    let lastLinePartial = false

    if (lines.length === 1) {
        const singleLine = lines[0]!
        if (tailLines > 0 && tailBytes > 0) {
            const tailSlice = truncateStringToBytesFromEnd(singleLine, tailBytes)
            if (tailSlice.length > 0) {
                tailLinesArr.push(tailSlice)
                tailBytesCount = utf8ByteLength(tailSlice)
                lastLinePartial = true
            }
        }
    } else {
        const minTailIndex = lastHeadLinePartial
            ? Math.max(0, headLinesArr.length - 1)
            : headLinesArr.length

        for (let i = lines.length - 1; i >= minTailIndex && tailLinesArr.length < tailLines; i -= 1) {
            const line = lines[i]!
            const isSharedLine = lastHeadLinePartial && i === minTailIndex
            const availableLineBytes = isSharedLine
                ? Math.max(0, utf8ByteLength(line) - utf8ByteLength(headLinesArr[i]!))
                : utf8ByteLength(line)
            const prefixNewline = tailLinesArr.length > 0 ? 1 : 0
            const lineBytes = availableLineBytes + prefixNewline

            if (tailBytesCount + lineBytes > tailBytes || isSharedLine) {
                truncatedBy = 'bytes'
                const remainingBytes = tailBytes - tailBytesCount - prefixNewline
                if (remainingBytes > 0 && (tailLinesArr.length === 0 || isSharedLine)) {
                    const maxTake = Math.min(remainingBytes, availableLineBytes)
                    if (maxTake > 0) {
                        const truncatedLine = truncateStringToBytesFromEnd(line, maxTake)
                        tailLinesArr.unshift(truncatedLine)
                        tailBytesCount += prefixNewline + utf8ByteLength(truncatedLine)
                        lastLinePartial = true
                    }
                }
                break
            }
            tailLinesArr.unshift(line)
            tailBytesCount += lineBytes
        }
    }

    const headContent = headLinesArr.join('\n')
    const tailContent = tailLinesArr.join('\n')
    const headOutputBytes = utf8ByteLength(headContent)
    const tailOutputBytes = utf8ByteLength(tailContent)

    const omittedLines = lines.length === 1
        ? 0
        : Math.max(0, totalLines - (headLinesArr.length + tailLinesArr.length))
    const omittedBytes = Math.max(0, totalBytes - (headOutputBytes + tailOutputBytes))

    const lineWord = omittedLines === 1 ? 'line' : 'lines'
    const fullPathNote = options.fullOutputPath ? `. Full output: ${options.fullOutputPath}` : ''
    let marker: string
    if (omittedLines > 0) {
        marker = `[... ${omittedLines} ${lineWord} truncated (${formatSize(omittedBytes)})${fullPathNote} ...]`
    } else {
        marker = `[... ${formatSize(omittedBytes)} truncated${fullPathNote} ...]`
    }

    let combinedContent = ''
    if (headContent && tailContent) {
        combinedContent = `${headContent}\n\n${marker}\n\n${tailContent}`
    } else if (headContent) {
        combinedContent = `${headContent}\n\n${marker}`
    } else if (tailContent) {
        combinedContent = `${marker}\n\n${tailContent}`
    } else {
        combinedContent = marker
    }

    return {
        content: combinedContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: headLinesArr.length + tailLinesArr.length,
        outputBytes: utf8ByteLength(combinedContent),
        headLines: headLinesArr.length,
        tailLines: tailLinesArr.length,
        omittedLines,
        omittedBytes,
        headContent,
        tailContent,
        lastLinePartial,
        firstLineExceedsLimit,
        maxLines,
        maxBytes,
        fullOutputPath: options.fullOutputPath,
    }
}
