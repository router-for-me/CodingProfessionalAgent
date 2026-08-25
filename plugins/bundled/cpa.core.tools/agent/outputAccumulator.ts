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
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    truncateTail,
    type TruncateResult,
    utf8ByteLength,
} from './truncate.js'

/** Fixed input byte window used when decoding incoming stream data. */
const DECODE_CHUNK_BYTES = 4096

export interface OutputAccumulatorOptions {
    maxLines?: number
    maxBytes?: number
}

export interface OutputAccumulatorSnapshot {
    content: string
    truncation: TruncateResult
}

interface TextChunk {
    text: string
    bytes: number
}

export class OutputAccumulator {
    private readonly maxLines: number
    private readonly maxBytes: number
    private readonly maxRollingBytes: number

    private readonly stdoutDecoder = new TextDecoder('utf-8')
    private readonly stderrDecoder = new TextDecoder('utf-8')
    private readonly textEncoder = new TextEncoder()
    private readonly trimDecoder = new TextDecoder('utf-8')

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
        const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
        const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
        if (!Number.isInteger(maxLines) || maxLines < 1) {
            throw new Error('maxLines must be a positive integer')
        }
        if (!Number.isInteger(maxBytes) || maxBytes < 1) {
            throw new Error('maxBytes must be a positive integer')
        }
        this.maxLines = maxLines
        this.maxBytes = maxBytes
        this.maxRollingBytes = Math.max(maxBytes * 2, 1)
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

    snapshot(): OutputAccumulatorSnapshot {
        const tailText = this.getSnapshotText()
        const tailTruncation = truncateTail(tailText, {
            maxLines: this.maxLines,
            maxBytes: this.maxBytes,
        })
        const truncated =
            this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes
        const truncatedBy = truncated
            ? (this.firstLimitCrossed ??
              (this.totalDecodedBytes > this.maxBytes ? 'bytes' : 'lines'))
            : null

        return {
            content: tailTruncation.content,
            truncation: {
                ...tailTruncation,
                truncated,
                truncatedBy,
                // Global stream metadata, not the rolling-tail-only view.
                totalLines: this.totalLines,
                totalBytes: this.totalDecodedBytes,
                maxLines: this.maxLines,
                maxBytes: this.maxBytes,
            },
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

        const pieceBytes = utf8ByteLength(text)
        this.chunks.push({ text, bytes: pieceBytes })
        this.retainedByteCount += pieceBytes
        // Peak may briefly exceed maxRollingBytes by O(DECODE_CHUNK) before trim.
        if (this.retainedByteCount > this.maxRollingBytes) {
            this.trimHead()
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
        return firstNewline === -1 ? text : text.slice(firstNewline + 1)
    }
}
