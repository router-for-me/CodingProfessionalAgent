import { describe, expect, it } from 'vitest'
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    splitLinesForCounting,
    truncateHead,
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
})
