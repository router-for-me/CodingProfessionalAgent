import { describe, expect, it } from 'vitest'
import { parseExecSource } from './pragma'

describe('Code Mode exec pragma', () => {
    it('preserves JavaScript without a pragma and uses CPA defaults', () => {
        const source = 'await tools.read({ path: "a.ts" });\ntext("done");'
        expect(parseExecSource(source)).toEqual({ source, yieldTimeMs: 30_000, maxOutputTokens: 10_000 })
    })

    it('overrides only supplied options and strips the first line', () => {
        expect(parseExecSource('// @exec: {"yield_time_ms":12}\ntext(1);')).toEqual({
            source: 'text(1);', yieldTimeMs: 12, maxOutputTokens: 10_000,
        })
        expect(parseExecSource('// @exec: {"max_output_tokens":0}\ntext(1);')).toEqual({
            source: 'text(1);', yieldTimeMs: 30_000, maxOutputTokens: 0,
        })
    })

    it('supports CRLF, indentation, empty options, and configurable defaults', () => {
        expect(parseExecSource('  // @exec: {}\r\ntext(1);', { yieldTimeMs: 1, maxOutputTokens: 2 })).toEqual({
            source: 'text(1);', yieldTimeMs: 1, maxOutputTokens: 2,
        })
    })

    it('accepts zero and the maximum safe integer', () => {
        expect(parseExecSource(`// @exec: {"yield_time_ms":0,"max_output_tokens":${Number.MAX_SAFE_INTEGER}}\ntext(1);`)).toMatchObject({
            yieldTimeMs: 0, maxOutputTokens: Number.MAX_SAFE_INTEGER,
        })
    })

    it.each([undefined, null, 12, '', ' \n\t'])('rejects empty or non-string source %j', (source) => {
        expect(() => parseExecSource(source)).toThrow('non-empty JavaScript string')
    })

    it.each(['// @exec: {}', '// @exec: {}\n  \r\n'])('rejects pragma-only source', (source) => {
        expect(() => parseExecSource(source)).toThrow('code after')
    })

    it.each(['', '{', 'null', '[]', 'true', '1', '"text"'])('rejects invalid pragma %s', (pragma) => {
        expect(() => parseExecSource(`// @exec: ${pragma}\ntext(1);`)).toThrow('expected a JSON object')
    })

    it('rejects unknown fields including prototype-like keys', () => {
        for (const key of ['yieldTimeMs', 'max_tokens', '__proto__']) {
            expect(() => parseExecSource(`// @exec: {"${key}":1}\ntext(1);`)).toThrow(`Unknown // @exec: pragma field: ${key}`)
        }
    })

    it.each([-1, 1.5, '1000', null, true, Number.MAX_SAFE_INTEGER + 1])('rejects invalid integer %j', (value) => {
        for (const field of ['yield_time_ms', 'max_output_tokens']) {
            expect(() => parseExecSource(`// @exec: ${JSON.stringify({ [field]: value })}\ntext(1);`)).toThrow(`${field} must be a non-negative safe integer`)
        }
    })

    it('validates defaults even without a pragma', () => {
        expect(() => parseExecSource('text(1);', { yieldTimeMs: Infinity, maxOutputTokens: 1 })).toThrow('defaultExecYieldMs')
    })

    it('does not interpret pragmas outside the first line or inside a string', () => {
        for (const source of ['\n// @exec: {"unknown":1}\ntext(1);', 'text("// @exec: {}");']) {
            expect(parseExecSource(source).source).toBe(source)
        }
    })
})
