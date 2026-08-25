import { describe, expect, it } from 'vitest'
import { OutputAccumulator } from './outputAccumulator.js'
import { utf8ByteLength } from './truncate.js'

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text)
}

describe('OutputAccumulator', () => {
    it('rejects non-positive maxLines/maxBytes options', () => {
        expect(() => new OutputAccumulator({ maxLines: 0 })).toThrow(/maxLines/i)
        expect(() => new OutputAccumulator({ maxLines: 1.5 })).toThrow(/maxLines/i)
        expect(() => new OutputAccumulator({ maxBytes: -1 })).toThrow(/maxBytes/i)
        expect(() => new OutputAccumulator({ maxBytes: Number.NaN })).toThrow(/maxBytes/i)
    })

    it('tracks total lines, bytes, and last line bytes across appends', () => {
        const acc = new OutputAccumulator({ maxLines: 100, maxBytes: 10_000 })
        acc.appendStdout(encode('line1\nline2'))
        expect(acc.getLastLineBytes()).toBe(utf8ByteLength('line2'))
        acc.appendStdout(encode('\nline3\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.content).toBe('line1\nline2\nline3\n')
        expect(snap.truncation.truncated).toBe(false)
        expect(snap.truncation.totalLines).toBe(3)
        expect(snap.truncation.totalBytes).toBe(utf8ByteLength('line1\nline2\nline3\n'))
        expect(acc.getLastLineBytes()).toBe(0)
    })

    it('keeps a rolling UTF-8-safe tail bounded by maxBytes*2', () => {
        const maxBytes = 20
        const acc = new OutputAccumulator({ maxLines: 100, maxBytes })
        // Build more than maxBytes*2 of decoded text so the rolling window trims.
        const chunk = 'abcdefghij\n' // 11 bytes
        for (let i = 0; i < 8; i += 1) {
            acc.appendStdout(encode(chunk))
        }
        acc.finish()
        // Internal tail must stay within maxBytes*2 after trim.
        expect(acc.retainedBytes).toBeLessThanOrEqual(maxBytes * 2)
        const snap = acc.snapshot()
        expect(utf8ByteLength(snap.content)).toBeLessThanOrEqual(maxBytes)
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.totalBytes).toBeGreaterThan(maxBytes * 2)
        expect(snap.truncation.totalLines).toBe(8)
    })

    it('bounds retainedBytes for a huge single append without holding the full text', () => {
        const maxBytes = 64
        const acc = new OutputAccumulator({ maxLines: 1000, maxBytes })
        // One append far larger than maxBytes*2 — retained must stay near the bound.
        const huge = 'x'.repeat(maxBytes * 20)
        acc.appendStdout(encode(huge))
        // Transient overshoot of at most one fixed decode window is allowed mid-append;
        // after finish/trim the retained deque must sit at the rolling bound.
        expect(acc.retainedBytes).toBeLessThanOrEqual(maxBytes * 2)
        acc.finish()
        expect(acc.retainedBytes).toBeLessThanOrEqual(maxBytes * 2)
        expect(acc.retainedChunks).toBeGreaterThan(0)
        // Debug accessors must not expose the full output.
        expect(Object.keys(acc)).not.toContain('tailText')
        const snap = acc.snapshot()
        expect(snap.truncation.totalBytes).toBe(huge.length)
        expect(utf8ByteLength(snap.content)).toBeLessThanOrEqual(maxBytes)
    })

    it('does not split multi-byte UTF-8 characters across stdout chunks', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 1024 })
        // € = E2 82 AC
        acc.appendStdout(new Uint8Array([0xe2]))
        acc.appendStdout(new Uint8Array([0x82, 0xac, 0x0a])) // €\n
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.content).toBe('€\n')
        expect(snap.truncation.totalLines).toBe(1)
        expect(snap.truncation.totalBytes).toBe(utf8ByteLength('€\n'))
    })

    it('keeps independent decoders for stdout and stderr so interleaved chunks stay valid', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 1024 })
        // stdout: € = E2 82 AC split around a stderr chunk
        acc.appendStdout(new Uint8Array([0xe2]))
        acc.appendStderr(encode('err\n'))
        acc.appendStdout(new Uint8Array([0x82, 0xac, 0x0a]))
        acc.finish()
        const snap = acc.snapshot()
        // Sequence-ordered display: partial stdout waits, stderr text, then completed stdout
        expect(snap.content).toBe('err\n€\n')
        expect(snap.truncation.totalLines).toBe(2)
    })

    it('flushes pending decoder bytes on finish', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 1024 })
        // Incomplete multi-byte sequence becomes replacement on final flush
        acc.appendStdout(new Uint8Array([0xe4]))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.content.length).toBeGreaterThan(0)
        expect(snap.truncation.totalBytes).toBeGreaterThan(0)
    })

    it('uses global line/byte metadata when the rolling tail is shorter than full output', () => {
        const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 20 })
        acc.appendStdout(encode('line1\nline2\nline3\nline4\nline5\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.content).toContain('line')
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.totalLines).toBe(5)
        expect(snap.truncation.totalBytes).toBe(utf8ByteLength('line1\nline2\nline3\nline4\nline5\n'))
        expect(snap.truncation.outputLines).toBeLessThanOrEqual(2)
    })

    it('supports last-line partial truncation via truncateTail metadata', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 8 })
        acc.appendStdout(encode('abcdefghijklmnop')) // single line > maxBytes
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('bytes')
        expect(snap.truncation.lastLinePartial).toBe(true)
        expect(acc.getLastLineBytes()).toBe(utf8ByteLength('abcdefghijklmnop'))
        expect(utf8ByteLength(snap.content)).toBeLessThanOrEqual(8)
    })

    it('tracks truncatedBy by the first global limit crossed: lines then bytes', () => {
        // Cross maxLines first with small lines, then exceed maxBytes later.
        const acc = new OutputAccumulator({ maxLines: 2, maxBytes: 100 })
        acc.appendStdout(encode('a\nb\n')) // 2 lines completed → still == maxLines, not yet over
        acc.appendStdout(encode('c\n')) // totalLines=3 > maxLines first
        expect(acc.snapshot().truncation.truncatedBy).toBe('lines')
        // Later push large content past maxBytes — truncatedBy must stay lines.
        acc.appendStdout(encode('x'.repeat(200) + '\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('lines')
        expect(snap.truncation.totalLines).toBeGreaterThan(2)
        expect(snap.truncation.totalBytes).toBeGreaterThan(100)
    })

    it('tracks truncatedBy by the first global limit crossed: bytes then lines', () => {
        // One long line exceeds maxBytes first; later more lines arrive.
        const acc = new OutputAccumulator({ maxLines: 50, maxBytes: 10 })
        acc.appendStdout(encode('abcdefghijklmnop')) // single line > maxBytes
        expect(acc.snapshot().truncation.truncatedBy).toBe('bytes')
        acc.appendStdout(encode('\nline2\nline3\nline4\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('bytes')
        expect(snap.truncation.totalLines).toBeGreaterThan(1)
    })

    it('byte-steps first-crossing within one append: line-first then later bytes stays lines', () => {
        // maxLines=1, maxBytes=10. Piece "a\nbxxxxxxxx" crosses lines at 'b' (byte 3),
        // then bytes later in the same append — first crossing is lines.
        const acc = new OutputAccumulator({ maxLines: 1, maxBytes: 10 })
        acc.appendStdout(encode('a\nbxxxxxxxx'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('lines')
        expect(snap.truncation.totalLines).toBe(2)
        expect(snap.truncation.totalBytes).toBe(utf8ByteLength('a\nbxxxxxxxx'))
        expect(acc.getLastLineBytes()).toBe(utf8ByteLength('bxxxxxxxx'))
    })

    it('byte-steps first-crossing within one append: byte-first then later lines stays bytes', () => {
        // maxLines=5, maxBytes=3. Piece "abcd\ne" crosses bytes at 'd' before any new line tip.
        const acc = new OutputAccumulator({ maxLines: 5, maxBytes: 3 })
        acc.appendStdout(encode('abcd\ne'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('bytes')
        expect(snap.truncation.totalLines).toBe(2)
        expect(snap.truncation.totalBytes).toBe(utf8ByteLength('abcd\ne'))
        expect(acc.getLastLineBytes()).toBe(utf8ByteLength('e'))
    })

    it('byte-steps first-crossing within one append: same byte tips lines and bytes prefers bytes', () => {
        // After "a\n" (bytes=2, lines=1), piece "b\n" with maxLines=1,maxBytes=2:
        // byte 'b' tips lines (1→2) and bytes (2→3) together → bytes wins.
        // Piece-level "hasNewline ⇒ lines" would be wrong here.
        const acc = new OutputAccumulator({ maxLines: 1, maxBytes: 2 })
        acc.appendStdout(encode('a\nb\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.truncated).toBe(true)
        expect(snap.truncation.truncatedBy).toBe('bytes')
        expect(snap.truncation.totalLines).toBe(2)
        expect(snap.truncation.totalBytes).toBe(4)
        expect(acc.getLastLineBytes()).toBe(0)
    })

    it('byte-steps first-crossing is stable across chunk boundaries (same as one piece)', () => {
        // Same logical stream as the same-byte case, split across chunk boundaries.
        const oneShot = new OutputAccumulator({ maxLines: 1, maxBytes: 2 })
        oneShot.appendStdout(encode('a\nb\n'))
        oneShot.finish()

        const split = new OutputAccumulator({ maxLines: 1, maxBytes: 2 })
        split.appendStdout(encode('a'))
        split.appendStdout(encode('\n'))
        split.appendStdout(encode('b'))
        split.appendStdout(encode('\n'))
        split.finish()

        expect(split.snapshot().truncation.truncatedBy).toBe(oneShot.snapshot().truncation.truncatedBy)
        expect(split.snapshot().truncation.truncatedBy).toBe('bytes')
        expect(split.snapshot().truncation.totalLines).toBe(oneShot.snapshot().truncation.totalLines)
        expect(split.snapshot().truncation.totalBytes).toBe(oneShot.snapshot().truncation.totalBytes)
        expect(split.getLastLineBytes()).toBe(oneShot.getLastLineBytes())

        // Line-first case also matches across boundaries.
        const lineOne = new OutputAccumulator({ maxLines: 1, maxBytes: 10 })
        lineOne.appendStdout(encode('a\nbxxxxxxxx'))
        lineOne.finish()
        const lineSplit = new OutputAccumulator({ maxLines: 1, maxBytes: 10 })
        lineSplit.appendStdout(encode('a\n'))
        lineSplit.appendStdout(encode('bxxxxxxxx'))
        lineSplit.finish()
        expect(lineSplit.snapshot().truncation.truncatedBy).toBe(lineOne.snapshot().truncation.truncatedBy)
        expect(lineSplit.snapshot().truncation.truncatedBy).toBe('lines')
    })

    it('rejects append after finish', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 100 })
        acc.finish()
        expect(() => acc.appendStdout(encode('x'))).toThrow(/finished/i)
        expect(() => acc.appendStderr(encode('y'))).toThrow(/finished/i)
    })

    it('treats empty content as zero lines and zero last-line bytes', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 100 })
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.content).toBe('')
        expect(snap.truncation.totalLines).toBe(0)
        expect(snap.truncation.totalBytes).toBe(0)
        expect(acc.getLastLineBytes()).toBe(0)
    })

    it('counts trailing newline without a phantom empty line', () => {
        const acc = new OutputAccumulator({ maxLines: 10, maxBytes: 100 })
        acc.appendStdout(encode('a\nb\n'))
        acc.finish()
        const snap = acc.snapshot()
        expect(snap.truncation.totalLines).toBe(2)
        expect(acc.getLastLineBytes()).toBe(0)
    })
})
