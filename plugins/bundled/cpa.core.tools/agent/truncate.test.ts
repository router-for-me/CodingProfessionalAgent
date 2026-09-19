import { describe, expect, it } from 'vitest'
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    splitLinesForCounting,
    truncateHead,
    truncateHeadAndTail,
    truncateStringToBytesFromStart,
    truncateTail,
    utf8ByteLength,
} from './truncate'

describe('truncate utilities', () => {
    describe('splitLinesForCounting', () => {
        it('treats empty content as zero lines', () => {
            expect(splitLinesForCounting('')).toEqual([])
        })

        it('does not count a trailing newline as an extra empty line', () => {
            expect(splitLinesForCounting('a\n')).toEqual(['a'])
            expect(splitLinesForCounting('a\nb\n')).toEqual(['a', 'b'])
            expect(splitLinesForCounting('\n')).toEqual([''])
        })

        it('keeps interior empty lines', () => {
            expect(splitLinesForCounting('a\n\nb')).toEqual(['a', '', 'b'])
        })
    })

    describe('truncateHead', () => {
        it('keeps complete UTF-8 lines within the byte limit', () => {
            // €€ = 6 bytes; €€\n€€ = 13 bytes → maxBytes 12 keeps only the first line
            const result = truncateHead('€€\n€€\n€€', { maxLines: 3, maxBytes: 12 })
            expect(result.content).toBe('€€')
            expect(result.truncatedBy).toBe('bytes')
            expect(result.truncated).toBe(true)
            expect(result.lastLinePartial).toBe(false)
            expect(result.firstLineExceedsLimit).toBe(false)
        })

        it('never splits a multi-byte character when dropping a line', () => {
            const result = truncateHead('α\nβ', { maxLines: 10, maxBytes: 3 })
            // α = 2 bytes; with newline + β would exceed 3 → keep α only
            expect(result.content).toBe('α')
            expect(result.truncatedBy).toBe('bytes')
            expect(utf8ByteLength(result.content)).toBeLessThanOrEqual(3)
        })

        it('returns firstLineExceedsLimit when the first line alone is over maxBytes', () => {
            const long = '€'.repeat(30) // 90 bytes
            const result = truncateHead(long, { maxLines: 10, maxBytes: 20 })
            expect(result.content).toBe('')
            expect(result.firstLineExceedsLimit).toBe(true)
            expect(result.truncatedBy).toBe('bytes')
            expect(result.outputLines).toBe(0)
        })

        it('truncates by line limit without partial lines', () => {
            const result = truncateHead('a\nb\nc\nd', { maxLines: 2, maxBytes: 10_000 })
            expect(result.content).toBe('a\nb')
            expect(result.truncatedBy).toBe('lines')
            expect(result.outputLines).toBe(2)
            expect(result.totalLines).toBe(4)
        })

        it('returns original content when within both limits', () => {
            const result = truncateHead('hello\nworld')
            expect(result.truncated).toBe(false)
            expect(result.truncatedBy).toBeNull()
            expect(result.content).toBe('hello\nworld')
            expect(result.maxLines).toBe(DEFAULT_MAX_LINES)
            expect(result.maxBytes).toBe(DEFAULT_MAX_BYTES)
        })

        it('rejects non-positive maxLines/maxBytes options', () => {
            expect(() => truncateHead('a', { maxLines: 0 })).toThrow(/maxLines/i)
            expect(() => truncateHead('a', { maxLines: 1.5 })).toThrow(/maxLines/i)
            expect(() => truncateHead('a', { maxBytes: -1 })).toThrow(/maxBytes/i)
            expect(() => truncateTail('a', { maxBytes: 0 })).toThrow(/maxBytes/i)
            expect(() => truncateTail('a', { maxLines: Number.NaN })).toThrow(/maxLines/i)
        })
    })

    describe('truncateTail', () => {
        it('keeps complete trailing UTF-8 lines within the byte limit', () => {
            const result = truncateTail('€€\n€€\n€€', { maxLines: 3, maxBytes: 12 })
            // €€ = 6 bytes; €€\n€€ = 13 > 12 → only last €€
            expect(result.content).toBe('€€')
            expect(result.truncatedBy).toBe('bytes')
            expect(result.lastLinePartial).toBe(false)
        })

        it('allows a UTF-8-safe partial only for an oversized final line', () => {
            // Each € is 3 bytes; take last 5 bytes → should skip incomplete leading byte(s)
            const line = '€€€€' // 12 bytes
            const result = truncateTail(line, { maxLines: 1, maxBytes: 5 })
            expect(result.truncated).toBe(true)
            expect(result.lastLinePartial).toBe(true)
            expect(result.truncatedBy).toBe('bytes')
            expect(utf8ByteLength(result.content)).toBeLessThanOrEqual(5)
            // Must be valid UTF-8 (no replacement char from a torn codepoint)
            expect(result.content.includes('\uFFFD')).toBe(false)
            expect(result.content.length).toBeGreaterThan(0)
        })

        it('truncates by line limit from the end', () => {
            const result = truncateTail('a\nb\nc\nd', { maxLines: 2, maxBytes: 10_000 })
            expect(result.content).toBe('c\nd')
            expect(result.truncatedBy).toBe('lines')
        })
    })

    describe('formatSize', () => {
        it('formats B / KB / MB', () => {
            expect(formatSize(100)).toBe('100B')
            expect(formatSize(2048)).toBe('2.0KB')
            expect(formatSize(2 * 1024 * 1024)).toBe('2.0MB')
        })
    })

    describe('truncateStringToBytesFromStart', () => {
        it('returns empty string when maxBytes <= 0', () => {
            expect(truncateStringToBytesFromStart('hello', 0)).toBe('')
            expect(truncateStringToBytesFromStart('hello', -5)).toBe('')
        })

        it('returns original string when within byte limit', () => {
            expect(truncateStringToBytesFromStart('hello', 10)).toBe('hello')
        })

        it('does not split multi-byte characters', () => {
            // '你' is 3 bytes (0xE4, 0xBD, 0xA0)
            expect(truncateStringToBytesFromStart('a你好', 2)).toBe('a')
            expect(truncateStringToBytesFromStart('a你好', 4)).toBe('a你')
        })
    })

    describe('truncateHeadAndTail', () => {
        it('returns original content when within both limits', () => {
            const content = 'line 1\nline 2\nline 3'
            const result = truncateHeadAndTail(content, { maxLines: 10, maxBytes: 1000 })
            expect(result.truncated).toBe(false)
            expect(result.content).toBe(content)
            expect(result.headLines).toBe(3)
            expect(result.tailLines).toBe(0)
            expect(result.omittedLines).toBe(0)
            expect(result.omittedBytes).toBe(0)
        })

        it('truncates middle when line limit is exceeded', () => {
            const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
            const result = truncateHeadAndTail(lines, {
                maxLines: 4,
                headLines: 2,
                tailLines: 2,
                maxBytes: 10_000,
                fullOutputPath: '/tmp/test.log',
            })
            expect(result.truncated).toBe(true)
            expect(result.truncatedBy).toBe('lines')
            expect(result.headLines).toBe(2)
            expect(result.tailLines).toBe(2)
            expect(result.omittedLines).toBe(16)
            expect(result.headContent).toBe('line 1\nline 2')
            expect(result.tailContent).toBe('line 19\nline 20')
            expect(result.content).toContain('line 1\nline 2')
            expect(result.content).toContain('line 19\nline 20')
            expect(result.content).toContain('16 lines truncated')
            expect(result.content).toContain('Full output: /tmp/test.log')
        })

        it('truncates middle when byte limit is exceeded', () => {
            const lineA = 'a'.repeat(30)
            const lineB = 'b'.repeat(30)
            const lineC = 'c'.repeat(30)
            const content = `${lineA}\n${lineB}\n${lineC}`
            const result = truncateHeadAndTail(content, {
                maxLines: 10,
                maxBytes: 50,
                headBytes: 25,
                tailBytes: 25,
            })
            expect(result.truncated).toBe(true)
            expect(result.truncatedBy).toBe('bytes')
            expect(result.omittedBytes).toBeGreaterThan(0)
            expect(result.content).toContain('truncated')
        })

        it('rejects negative headLines or tailLines', () => {
            expect(() => truncateHeadAndTail('a', { headLines: -1 })).toThrow(/headLines/i)
            expect(() => truncateHeadAndTail('a', { headBytes: -1 })).toThrow(/headBytes/i)
            expect(() => truncateHeadAndTail('a', { maxLines: 5, headLines: 3, tailLines: 3 })).toThrow(/exceed maxLines/i)
            expect(() => truncateHeadAndTail('a', { maxBytes: 10, headBytes: 6, tailBytes: 6 })).toThrow(/exceed maxBytes/i)
        })

        it('retains both head and tail when their text contents are identical', () => {
            const content = 'OK\nline 2\nline 3\nline 4\nOK'
            const result = truncateHeadAndTail(content, {
                maxLines: 2,
                headLines: 1,
                tailLines: 1,
            })
            expect(result.truncated).toBe(true)
            expect(result.headContent).toBe('OK')
            expect(result.tailContent).toBe('OK')
            expect(result.omittedLines).toBe(3)
            // Both head and tail must be rendered with marker between them
            expect(result.content).toBe('OK\n\n[... 3 lines truncated (22B) ...]\n\nOK')
        })

        it('retains both head and tail for single long line exceeding byte limit', () => {
            const content = '0123456789ABCDEFGHIJ' // 20 bytes
            const result = truncateHeadAndTail(content, {
                maxLines: 10,
                maxBytes: 10,
                headBytes: 5,
                tailBytes: 5,
                fullOutputPath: '/tmp/single.log',
            })
            expect(result.truncated).toBe(true)
            expect(result.headContent).toBe('01234')
            expect(result.tailContent).toBe('FGHIJ')
            expect(result.omittedBytes).toBe(10)
            expect(result.content).toContain('01234')
            expect(result.content).toContain('FGHIJ')
            expect(result.content).toContain('10B truncated. Full output: /tmp/single.log')
        })

        it('does not exceed maxLines=1 or maxBytes=1 budget', () => {
            const lines = 'line1\nline2\nline3'
            const lineResult = truncateHeadAndTail(lines, { maxLines: 1 })
            expect(lineResult.truncated).toBe(true)
            expect(lineResult.outputLines).toBeLessThanOrEqual(1)

            const bytes = 'abcdefghij'
            const byteResult = truncateHeadAndTail(bytes, { maxBytes: 1 })
            expect(byteResult.truncated).toBe(true)
            expect(byteResult.headContent.length + byteResult.tailContent.length).toBeLessThanOrEqual(1)
        })

        it('accurately accounts for newline bytes when filling partial head line', () => {
            const content = 'a\n' + 'b'.repeat(30) + 'END'
            const result = truncateHeadAndTail(content, {
                maxBytes: 10,
                headBytes: 5,
                tailBytes: 5,
            })
            // Head must be exactly 5 bytes including '\n' ('a\nbbb')
            expect(utf8ByteLength(result.headContent)).toBe(5)
            expect(result.headContent).toBe('a\nbbb')
        })

        it('extracts non-overlapping tail when second line is partially included in head', () => {
            const content = 'a\n' + 'b'.repeat(10) + 'END'
            const result = truncateHeadAndTail(content, {
                maxBytes: 10,
                headBytes: 5,
                tailBytes: 5,
            })
            expect(result.headContent).toBe('a\nbbb')
            expect(result.tailContent).toContain('END')
            expect(utf8ByteLength(result.tailContent)).toBeLessThanOrEqual(5)
        })
    })
})
