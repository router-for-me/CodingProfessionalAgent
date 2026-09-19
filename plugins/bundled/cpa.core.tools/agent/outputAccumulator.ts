/**
 * Bounded streaming output accumulator for the bash tool.
 *
 * Keeps only a rolling decoded tail (maxBytes * 2) in the WebView as a chunk
 * deque — never concatenates the full tail then re-encodes to trim.
 * Full process output lives on the native side (fullOutputPath).
 * stdout and stderr use independent streaming TextDecoders so multi-byte
 * UTF-8 sequences are not corrupted when streams interleave by sequence.
 */

import {
    resolveHeadAndTailLimits,
    truncateHead,
    truncateHeadAndTail,
    truncateStringToBytesFromStart,
    truncateTail,
    type TruncateResult,
    utf8ByteLength,
} from './truncate.js'

/** Fixed input byte window used when decoding incoming stream data. */
const DECODE_CHUNK_BYTES = 4096

export interface OutputAccumulatorOptions {
    maxLines?: number
    maxBytes?: number
    headLines?: number
    tailLines?: number
    headBytes?: number
    tailBytes?: number
    fullOutputPath?: string
}

export interface OutputAccumulatorSnapshot {
    content: string
    truncation: TruncateResult
    headContent?: string
    tailContent?: string
    headLines?: number
    tailLines?: number
    omittedLines?: number
    omittedBytes?: number
    fullOutputPath?: string
}

interface TextChunk {
    text: string
    bytes: number
}

export class OutputAccumulator {
    private readonly maxLines: number
    private readonly maxBytes: number
    private readonly maxRollingBytes: number
    private readonly headLines: number
    private readonly tailLines: number
    private readonly headBytes: number
    private readonly tailBytes: number
    private readonly fullOutputPath?: string

    private readonly stdoutDecoder = new TextDecoder('utf-8')
    private readonly stderrDecoder = new TextDecoder('utf-8')
    private readonly textEncoder = new TextEncoder()
    private readonly trimDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

    /** Retained head chunks (frozen once head limits are reached). */
    private readonly headChunks: TextChunk[] = []
    private headByteCount = 0
    private headLineCount = 0
    private headFrozen = false

    /** Rolling decoded tail as a deque of fixed-ish chunks. */
    private readonly chunks: TextChunk[] = []
    private retainedByteCount = 0
    private tailStartsAtLineBoundary = true

    private totalDecodedBytes = 0
    private completedLines = 0
    private totalLines = 0
    private currentLineBytes = 0
    private hasOpenLine = false
    private finished = false

    /**
     * First limit crossed on the full stream (not the rolling tail).
     * Captured at the global position that first exceeded lines or bytes.
     */
    private firstLimitCrossed: 'lines' | 'bytes' | null = null

    constructor(options: OutputAccumulatorOptions = {}) {
        const limits = resolveHeadAndTailLimits(options)
        this.maxLines = limits.maxLines
        this.maxBytes = limits.maxBytes
        this.headLines = limits.headLines
        this.tailLines = limits.tailLines
        this.headBytes = limits.headBytes
        this.tailBytes = limits.tailBytes
        this.maxRollingBytes = Math.max(this.maxBytes * 2, this.tailBytes * 2, 1)
        this.fullOutputPath = options.fullOutputPath
    }

    appendStdout(data: Uint8Array): void {
        this.assertNotFinished()
        if (data.byteLength === 0) {
            return
        }
        this.appendStreamBytes(this.stdoutDecoder, data)
    }

    appendStderr(data: Uint8Array): void {
        this.assertNotFinished()
        if (data.byteLength === 0) {
            return
        }
        this.appendStreamBytes(this.stderrDecoder, data)
    }

    finish(): void {
        if (this.finished) {
            return
        }
        this.finished = true
        // Flush both stream decoders (order independent: incomplete sequences are per-stream).
        this.appendDecodedText(this.stdoutDecoder.decode())
        this.appendDecodedText(this.stderrDecoder.decode())
    }

    snapshot(options: { fullOutputPath?: string } = {}): OutputAccumulatorSnapshot {
        const fullPath = options.fullOutputPath ?? this.fullOutputPath
        const truncated =
            this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes
        const truncatedBy = truncated
            ? (this.firstLimitCrossed ??
              (this.totalDecodedBytes > this.maxBytes ? 'bytes' : 'lines'))
            : null

        if (!truncated) {
            const fullText = this.getSnapshotText()
            return {
                content: fullText,
                truncation: {
                    content: fullText,
                    truncated: false,
                    truncatedBy: null,
                    totalLines: this.totalLines,
                    totalBytes: this.totalDecodedBytes,
                    outputLines: this.totalLines,
                    outputBytes: this.totalDecodedBytes,
                    lastLinePartial: false,
                    firstLineExceedsLimit: false,
                    maxLines: this.maxLines,
                    maxBytes: this.maxBytes,
                },
                headContent: fullText,
                tailContent: '',
                headLines: this.totalLines,
                tailLines: 0,
                omittedLines: 0,
                omittedBytes: 0,
                fullOutputPath: fullPath,
            }
        }

        // Truncated: If total decoded output is still retained in chunks without trim
        if (this.totalDecodedBytes <= this.maxRollingBytes) {
            let fullText = ''
            for (const chunk of this.chunks) {
                fullText += chunk.text
            }
            const htResult = truncateHeadAndTail(fullText, {
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
                headLines: this.headLines,
                tailLines: this.tailLines,
                headBytes: this.headBytes,
                tailBytes: this.tailBytes,
                fullOutputPath: fullPath,
            })
            const tailTruncation = truncateTail(this.getSnapshotText(), {
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
            })
            return {
                content: tailTruncation.content,
                truncation: {
                    ...tailTruncation,
                    truncated: true,
                    truncatedBy,
                    totalLines: this.totalLines,
                    totalBytes: this.totalDecodedBytes,
                    maxLines: this.maxLines,
                    maxBytes: this.maxBytes,
                },
                headContent: htResult.headContent,
                tailContent: htResult.tailContent,
                headLines: htResult.headLines,
                tailLines: htResult.tailLines,
                omittedLines: htResult.omittedLines,
                omittedBytes: htResult.omittedBytes,
                fullOutputPath: fullPath,
            }
        }

        // Truncated and rolling tail was trimmed:
        let headResult: TruncateResult
        if (this.headLines === 0 || this.headBytes === 0) {
            headResult = {
                content: '',
                truncated: true,
                truncatedBy,
                totalLines: this.totalLines,
                totalBytes: this.totalDecodedBytes,
                outputLines: 0,
                outputBytes: 0,
                lastLinePartial: false,
                firstLineExceedsLimit: false,
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
            }
        } else {
            let headRawText = ''
            for (const chunk of this.headChunks) {
                headRawText += chunk.text
            }
            headResult = truncateHead(headRawText, {
                maxLines: this.headLines,
                maxBytes: this.headBytes,
            })
        }

        let tailResult: TruncateResult
        if (this.tailLines === 0 || this.tailBytes === 0) {
            tailResult = {
                content: '',
                truncated: true,
                truncatedBy,
                totalLines: this.totalLines,
                totalBytes: this.totalDecodedBytes,
                outputLines: 0,
                outputBytes: 0,
                lastLinePartial: false,
                firstLineExceedsLimit: false,
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
            }
        } else {
            const tailRawText = this.getSnapshotText()
            tailResult = truncateTail(tailRawText, {
                maxLines: this.tailLines,
                maxBytes: this.tailBytes,
            })
        }

        const omittedLines = this.totalLines === 1
            ? 0
            : Math.max(0, this.totalLines - (headResult.outputLines + tailResult.outputLines))
        const omittedBytes = Math.max(0, this.totalDecodedBytes - (headResult.outputBytes + tailResult.outputBytes))

        return {
            content: tailResult.content,
            truncation: {
                ...tailResult,
                truncated: true,
                truncatedBy,
                totalLines: this.totalLines,
                totalBytes: this.totalDecodedBytes,
                outputLines: headResult.outputLines + tailResult.outputLines,
                outputBytes: headResult.outputBytes + tailResult.outputBytes,
                lastLinePartial: tailResult.lastLinePartial,
                firstLineExceedsLimit: headResult.firstLineExceedsLimit,
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
            },
            headContent: headResult.content,
            tailContent: tailResult.content,
            headLines: headResult.outputLines,
            tailLines: tailResult.outputLines,
            omittedLines,
            omittedBytes,
            fullOutputPath: fullPath,
        }
    }

    getLastLineBytes(): number {
        return this.currentLineBytes
    }

    /**
     * Debug/test: UTF-8 byte count retained in the rolling deque after trim.
     * Does not expose the full tail text.
     */
    get retainedBytes(): number {
        return this.retainedByteCount
    }

    /**
     * Debug/test: number of chunks currently held in the rolling deque.
     */
    get retainedChunks(): number {
        return this.chunks.length
    }

    private assertNotFinished(): void {
        if (this.finished) {
            throw new Error('Cannot append to a finished output accumulator')
        }
    }

    /**
     * Decode incoming bytes in fixed-size windows so a huge single append never
     * materializes a full concat of the historical tail before trimming.
     */
    private appendStreamBytes(decoder: TextDecoder, data: Uint8Array): void {
        let offset = 0
        while (offset < data.byteLength) {
            const end = Math.min(offset + DECODE_CHUNK_BYTES, data.byteLength)
            const slice = data.subarray(offset, end)
            const text = decoder.decode(slice, { stream: true })
            if (text.length > 0) {
                this.appendDecodedText(text)
            }
            offset = end
        }
    }

    private appendDecodedText(text: string): void {
        if (text.length === 0) {
            return
        }

        // Keep the rolling deque as coarse text pieces, but first-limit crossing
        // is decided by raw UTF-8 bytes so same-byte ties prefer bytes and
        // chunk boundaries cannot change the outcome.
        this.recordGlobalProgress(text)

        // Accumulate head text until head limits are met.
        if (!this.headFrozen) {
            this.appendHeadText(text)
        }

        const pieceBytes = utf8ByteLength(text)
        this.chunks.push({ text, bytes: pieceBytes })
        this.retainedByteCount += pieceBytes
        // Peak may briefly exceed maxRollingBytes by O(DECODE_CHUNK) before trim.
        if (this.retainedByteCount > this.maxRollingBytes) {
            this.trimHead()
        }
    }

    private appendHeadText(text: string): void {
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i += 1) {
            const linePiece = lines[i]!
            const isLast = i === lines.length - 1
            const suffix = isLast ? '' : '\n'
            const piece = linePiece + suffix
            const pieceBytes = utf8ByteLength(piece)

            if (this.headByteCount + pieceBytes > this.headBytes || this.headLineCount >= this.headLines) {
                const remainingBytes = this.headBytes - this.headByteCount
                if (remainingBytes > 0 && this.headLineCount < this.headLines) {
                    const truncatedStart = truncateStringToBytesFromStart(piece, remainingBytes)
                    if (truncatedStart.length > 0) {
                        const bytes = utf8ByteLength(truncatedStart)
                        this.headChunks.push({ text: truncatedStart, bytes })
                        this.headByteCount += bytes
                    }
                }
                this.headFrozen = true
                return
            }

            this.headChunks.push({ text: piece, bytes: pieceBytes })
            this.headByteCount += pieceBytes
            if (!isLast) {
                this.headLineCount += 1
                if (this.headLineCount >= this.headLines) {
                    this.headFrozen = true
                    return
                }
            }
        }
    }

    /**
     * Walk every UTF-8 byte of `text` in order:
     * - update totalBytes / newline / totalLines / lastLineBytes
     * - capture the first limit crossing
     * - when lines and bytes first exceed on the same byte, prefer bytes
     */
    private recordGlobalProgress(text: string): void {
        const encoded = this.textEncoder.encode(text)
        for (let index = 0; index < encoded.byteLength; index += 1) {
            const byte = encoded[index]!
            this.totalDecodedBytes += 1

            if (byte === 0x0a) {
                this.completedLines += 1
                this.currentLineBytes = 0
                this.hasOpenLine = false
            } else {
                this.currentLineBytes += 1
                this.hasOpenLine = true
            }
            this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0)

            if (this.firstLimitCrossed === null) {
                const crossedLines = this.totalLines > this.maxLines
                const crossedBytes = this.totalDecodedBytes > this.maxBytes
                if (crossedBytes && crossedLines) {
                    // Same raw byte tips both limits → bytes (matches truncate byte check).
                    this.firstLimitCrossed = 'bytes'
                } else if (crossedBytes) {
                    this.firstLimitCrossed = 'bytes'
                } else if (crossedLines) {
                    this.firstLimitCrossed = 'lines'
                }
            }
        }
    }

    /**
     * Drop oldest bytes from the deque head until retainedBytes <= maxBytes*2.
     * Never re-encodes the full tail; only the head chunk may be partially sliced.
     */
    private trimHead(): void {
        while (this.retainedByteCount > this.maxRollingBytes && this.chunks.length > 0) {
            const excess = this.retainedByteCount - this.maxRollingBytes
            const head = this.chunks[0]!
            if (head.bytes <= excess) {
                this.chunks.shift()
                this.retainedByteCount -= head.bytes
                this.tailStartsAtLineBoundary = head.text.endsWith('\n')
                continue
            }

            // Partial trim of the head chunk only.
            const encoded = this.textEncoder.encode(head.text)
            let start = excess
            // Skip UTF-8 continuation bytes so we start on a codepoint boundary.
            while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) {
                start += 1
            }
            this.tailStartsAtLineBoundary =
                start === 0
                    ? this.tailStartsAtLineBoundary
                    : encoded[start - 1] === 0x0a
            const newText = this.trimDecoder.decode(encoded.subarray(start))
            const newBytes = encoded.byteLength - start
            this.retainedByteCount -= head.bytes - newBytes
            head.text = newText
            head.bytes = newBytes
            if (head.bytes === 0) {
                this.chunks.shift()
            }
            break
        }
    }

    /**
     * Prefer starting the snapshot at a line boundary when the rolling window
     * was trimmed mid-line.
     */
    private getSnapshotText(): string {
        if (this.chunks.length === 0) {
            return ''
        }
        let text = ''
        for (const chunk of this.chunks) {
            text += chunk.text
        }
        if (this.tailStartsAtLineBoundary) {
            return text
        }
        const firstNewline = text.indexOf('\n')
        if (firstNewline === -1) {
            return text
        }
        if (firstNewline === text.length - 1) {
            return text.slice(0, -1)
        }
        return text.slice(firstNewline + 1)
    }
}
