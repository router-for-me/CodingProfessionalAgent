import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLegacyMemoryFilename } from '../shared/legacyFilename.js'
import { buildSnippet, matchMemoryContent, SearchMatcher, splitLines } from '../shared/memorySearch.js'
import { approxTokenCount, truncateMiddleWithTokenBudget } from '../shared/tokenBudget.js'
import { validateAddRequest, validateReadRequest, validateSearchRequest } from '../shared/validation.js'
import type { ReadMemoriesRequest, SearchMatchMode, SearchMemoriesRequest } from '../shared/types.js'

const queriesError = 'queries must not be empty or contain empty strings'
const idsError = 'ids is required and must be an array of 1 to 20 positive integers'

describe('memory content matching', () => {
    const content = 'a sqlite\nb\nc SQLite memory'

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each(['any', 'all_on_same_line', 'all_within_lines'] as const)('does no preparation or line splitting for empty content in %s mode', (mode) => {
        const matcher = new SearchMatcher(['sqlite'], mode, false, false, 2)
        const prepare = vi.spyOn(matcher.comparison, 'prepare')
        const split = vi.spyOn(String.prototype, 'split')
        const result = matchMemoryContent('', matcher)
        const splitCalls = split.mock.calls.length
        split.mockRestore()
        expect(result).toBeNull()
        expect(prepare).not.toHaveBeenCalled()
        expect(splitCalls).toBe(0)
    })

    it.each([
        { mode: 'any', queries: ['missing', 'absent'] },
        { mode: 'all_on_same_line', queries: ['sqlite', 'absent'] },
        { mode: 'all_within_lines', queries: ['sqlite', 'absent'] },
    ] satisfies { mode: SearchMatchMode; queries: string[] }[])('rejects missing document queries without splitting lines in $mode mode', ({ mode, queries }) => {
        const matcher = new SearchMatcher(queries, mode, false, false, 2)
        const prepare = vi.spyOn(matcher.comparison, 'prepare')
        const flags = vi.spyOn(matcher, 'matchedQueryFlags')
        const split = vi.spyOn(String.prototype, 'split')
        const result = matchMemoryContent(content, matcher)
        const splitCalls = split.mock.calls.length
        split.mockRestore()
        expect(result).toBeNull()
        expect(prepare).toHaveBeenCalledExactlyOnceWith(content)
        expect(flags).not.toHaveBeenCalled()
        expect(splitCalls).toBe(0)
    })

    it.each(['any', 'all_on_same_line'] as const)('stops preparing lines after the first complete match in %s mode', (mode) => {
        const matcher = new SearchMatcher(['sqlite', 'memory'], mode, false, false)
        const prepare = vi.spyOn(matcher.comparison, 'prepare')
        const text = 'SQLite memory\nunused line\nanother unused line'
        expect(matchMemoryContent(text, matcher)).toEqual({
            matchedQueries: ['sqlite', 'memory'], firstMatchLine: 'SQLite memory',
        })
        expect(prepare.mock.calls).toEqual([[text], ['SQLite memory']])
    })

    it('stops any-mode scanning once all document candidates match, ignoring absent queries', () => {
        const matcher = new SearchMatcher(['missing', 'sqlite', 'memory'], 'any', false, false)
        const prepare = vi.spyOn(matcher.comparison, 'prepare')
        const text = 'SQLite memory\nunused line'
        expect(matchMemoryContent(text, matcher)).toEqual({
            matchedQueries: ['sqlite', 'memory'], firstMatchLine: 'SQLite memory',
        })
        expect(prepare.mock.calls).toEqual([[text], ['SQLite memory']])
    })

    it('only tests unmatched candidate queries on later lines in any mode', () => {
        const matcher = new SearchMatcher(['sqlite', 'memory', 'absent'], 'any', false, false)
        const text = 'sqlite\nsqlite again\nmemory\nunused'
        const includes = vi.spyOn(String.prototype, 'includes')
        const result = matchMemoryContent(text, matcher)
        const calls = includes.mock.calls.map((args, index) => [includes.mock.contexts[index], args[0]])
        includes.mockRestore()
        expect(result).toEqual({ matchedQueries: ['sqlite', 'memory'], firstMatchLine: 'sqlite' })
        expect(calls).toEqual([
            [text, 'sqlite'], [text, 'memory'], [text, 'absent'],
            ['sqlite', 'sqlite'], ['sqlite', 'memory'],
            ['sqlite again', 'memory'], ['memory', 'memory'],
        ])
    })

    it.each(['any', 'all_on_same_line', 'all_within_lines'] as const)('does not treat document pre-checks as line matches in %s mode', (mode) => {
        expect(matchMemoryContent('sql\nite', new SearchMatcher(['sqlite'], mode, false, true, 2))).toBeNull()
        expect(matchMemoryContent('sqlite\nmemory', new SearchMatcher(['sqlite\nmemory'], mode, false, false, 2))).toBeNull()
    })

    it.each([
        { upper: 'ÉCOLE', lower: 'école' },
        { upper: 'İSTANBUL', lower: 'i\u0307stanbul' },
        { upper: 'Kelvin', lower: 'kelvin' },
    ])('preserves Unicode matching for $upper / $lower with all options', ({ upper, lower }) => {
        for (const mode of ['any', 'all_on_same_line', 'all_within_lines'] as const) {
            for (const normalized of [false, true]) {
                for (const caseSensitive of [false, true]) {
                    const matcher = new SearchMatcher([lower], mode, caseSensitive, normalized, 2)
                    expect(matchMemoryContent(upper + '\n' + lower, matcher)).toEqual({
                        matchedQueries: [lower], firstMatchLine: caseSensitive ? lower : upper,
                    })
                }
            }
        }
    })

    it('unions all any-mode hits in query order and uses the first matching line', () => {
        expect(matchMemoryContent(content, new SearchMatcher(['sqlite', 'memory'], 'any', false, false))).toEqual({
            matchedQueries: ['sqlite', 'memory'],
            firstMatchLine: 'a sqlite',
        })
        expect(matchMemoryContent('memory\nsqlite\nmemory', new SearchMatcher(['sqlite', 'memory'], 'any', false, false))).toEqual({
            matchedQueries: ['sqlite', 'memory'],
            firstMatchLine: 'memory',
        })
    })

    it('requires all queries on the same line', () => {
        const matcher = new SearchMatcher(['sqlite', 'memory'], 'all_on_same_line', false, false)
        expect(matchMemoryContent(content, matcher)).toEqual({
            matchedQueries: ['sqlite', 'memory'],
            firstMatchLine: 'c SQLite memory',
        })
        expect(matchMemoryContent('sqlite\nmemory', matcher)).toBeNull()
    })

    it('matches queries within the requested window', () => {
        const matcher = new SearchMatcher(['foo', 'bar'], 'all_within_lines', false, false, 2)
        expect(matchMemoryContent('x\nfoo\nbar\ny', matcher)).toEqual({
            matchedQueries: ['foo', 'bar'],
            firstMatchLine: 'foo',
        })
        expect(matchMemoryContent('foo\nx\nbar', matcher)).toBeNull()
    })

    it('discards windows strictly containing another matching window', () => {
        expect(matchMemoryContent(
            'line 1: alpha\nline 2: alpha\nline 3: beta\nline 4: beta',
            new SearchMatcher(['alpha', 'beta'], 'all_within_lines', false, false, 4),
        )).toEqual({ matchedQueries: ['alpha', 'beta'], firstMatchLine: 'line 2: alpha' })
    })

    it('returns null when no line matches, including empty content', () => {
        const matcher = new SearchMatcher(['sqlite'], 'any', false, false)
        expect(matchMemoryContent('unrelated', matcher)).toBeNull()
        expect(matchMemoryContent('', matcher)).toBeNull()
    })

    it('honors case sensitivity', () => {
        expect(matchMemoryContent('SQLite', new SearchMatcher(['sqlite'], 'any', true, false))).toBeNull()
    })

    it('normalizes punctuation and preserves Unicode letters and numbers', () => {
        expect(matchMemoryContent('session-manager', new SearchMatcher(['sessionmanager'], 'any', false, true))).toEqual({
            matchedQueries: ['sessionmanager'], firstMatchLine: 'session-manager',
        })
        expect(matchMemoryContent('记忆-１２', new SearchMatcher(['记忆１２'], 'any', false, true))).not.toBeNull()
    })

    it('rejects queries that normalize to empty in the matcher', () => {
        expect(() => new SearchMatcher(['---'], 'any', false, true)).toThrow(queriesError)
    })
})

describe('line and snippet helpers', () => {
    it.each([
        ['', []],
        ['\n', ['']],
        ['a\nb\n', ['a', 'b']],
        ['a\r\nb\r\n', ['a', 'b']],
        ['a\n\n', ['a', '']],
    ])('splits %j with the legacy line semantics', (content, lines) => {
        expect(splitLines(content as string)).toEqual(lines)
    })

    it('trims short snippets without truncation', () => {
        expect(buildSnippet('  short line  ')).toBe('short line')
        expect(buildSnippet('x'.repeat(120))).toBe('x'.repeat(120))
    })

    it('keeps emoji intact at the 120-code-point boundary', () => {
        const boundary = 'x'.repeat(119) + '😀'
        expect(buildSnippet('  ' + boundary + '  ')).toBe(boundary)
        expect(buildSnippet(boundary + 'tail')).toBe(boundary + '…')
        expect(Array.from(buildSnippet('😀'.repeat(121)))).toHaveLength(121)
        expect(buildSnippet('😀'.repeat(121))).toBe('😀'.repeat(120) + '…')
    })

    it('limits snippets to 120 characters plus an ellipsis', () => {
        const snippet = buildSnippet('  ' + 'x'.repeat(130))
        expect(snippet).toHaveLength(121)
        expect(snippet).toBe('x'.repeat(120) + '…')
    })
})

describe('request object validation', () => {
    it.each([undefined, null, 'request', 42, true, [], () => {}].map((request) => ({ request })))('rejects missing or non-object requests $request', ({ request }) => {
        for (const validate of [validateSearchRequest, validateReadRequest, validateAddRequest]) {
            expect(() => validate(request as never)).toThrow('request must be an object')
        }
    })
})

describe('search request validation', () => {
    it('trims queries and supplies defaults', () => {
        expect(validateSearchRequest({ queries: [' sqlite ', 'memory'] })).toEqual({
            queries: ['sqlite', 'memory'], matchMode: 'any', caseSensitive: false,
            normalized: false, lineCount: undefined, startIndex: 0, maxResults: 20,
        })
    })

    it('caps maxResults and parses cursors', () => {
        expect(validateSearchRequest({ queries: ['x'], maxResults: 500, cursor: '12' })).toMatchObject({
            maxResults: 100, startIndex: 12,
        })
    })

    it.each([0.5, 0, -1, NaN, Infinity, '2', null])('rejects invalid maxResults %s', (maxResults) => {
        expect(() => validateSearchRequest({ queries: ['x'], maxResults } as unknown as SearchMemoriesRequest))
            .toThrow('max_results must be a positive integer')
    })

    it('floors valid result limits without producing zero-sized pages', () => {
        expect(validateSearchRequest({ queries: ['x'], maxResults: 1.9 }).maxResults).toBe(1)
    })

    it.each(['fuzzy', '', null, false])('rejects invalid runtime matchMode %s', (matchMode) => {
        expect(() => validateSearchRequest({ queries: ['x'], matchMode } as unknown as SearchMemoriesRequest))
            .toThrow("match_mode must be one of 'any', 'all_on_same_line', 'all_within_lines'")
    })

    it.each([[], [''], ['  '], ['valid', ' ']].map((queries) => [queries]))('rejects empty queries %j', (queries) => {
        expect(() => validateSearchRequest({ queries })).toThrow(queriesError)
    })

    it('rejects queries that normalize to empty', () => {
        expect(() => validateSearchRequest({ queries: ['---'], normalized: true })).toThrow(queriesError)
        expect(() => validateSearchRequest({ queries: ['valid', '---'], normalized: true })).toThrow(queriesError)
    })

    it('accepts punctuation when normalization is disabled', () => {
        expect(validateSearchRequest({ queries: ['---'] }).queries).toEqual(['---'])
    })

    it.each([undefined, 0, -1, 1.5, NaN, Infinity])('rejects invalid window lineCount %s', (lineCount) => {
        expect(() => validateSearchRequest({ queries: ['x'], matchMode: 'all_within_lines', lineCount }))
            .toThrow('all_within_lines.line_count must be a positive integer')
    })

    it('preserves matching options', () => {
        expect(validateSearchRequest({
            queries: ['SQLite'], matchMode: 'all_within_lines', lineCount: 2,
            caseSensitive: true, normalized: true,
        })).toMatchObject({ matchMode: 'all_within_lines', lineCount: 2, caseSensitive: true, normalized: true })
    })

    it.each(['-1', '1.5', 'invalid'])('rejects invalid cursor %s', (cursor) => {
        expect(() => validateSearchRequest({ queries: ['x'], cursor })).toThrow('must be a non-negative integer')
    })

    it('rejects malformed queries at the runtime boundary', () => {
        for (const queries of [undefined, 'x', [1]]) {
            expect(() => validateSearchRequest({ queries } as unknown as SearchMemoriesRequest)).toThrow(queriesError)
        }
    })
})

describe('read request validation', () => {
    it('validateReadRequest rejects invalid ids', () => {
        for (const ids of [[], [1.5], [-1], [0], ['1'], [NaN], [Infinity], Array.from({ length: 21 }, (_, i) => i + 1), undefined]) {
            expect(() => validateReadRequest({ ids } as unknown as ReadMemoriesRequest)).toThrow(idsError)
        }
    })

    it('deduplicates ids in request order and supplies the default budget', () => {
        expect(validateReadRequest({ ids: [3, 3, 1] })).toEqual({ ids: [3, 1], maxTokens: 20000 })
        expect(validateReadRequest({ ids: Array(21).fill(3) }).ids).toEqual([3])
        expect(validateReadRequest({ ids: [1], maxTokens: 10 }).maxTokens).toBe(10)
    })
})

describe('add request validation', () => {
    it.each(['line\nbreak', 'line\rbreak', 'x'.repeat(121), '   '])('rejects invalid title %j', (title) => {
        expect(() => validateAddRequest({ title, note: 'note' })).toThrow()
    })

    it('rejects blank notes', () => {
        expect(() => validateAddRequest({ title: 'title', note: '  \n  ' })).toThrow()
    })

    it('trims the title and preserves the Markdown body', () => {
        expect(validateAddRequest({ title: '  title  ', note: '  # Note\nbody\n' })).toEqual({
            title: 'title', note: '  # Note\nbody\n',
        })
        expect(validateAddRequest({ title: 'x'.repeat(120), note: 'note' }).title).toHaveLength(120)
    })
})

describe('legacy filename parsing', () => {
    it('extracts the slug and parses the timestamp as local time', () => {
        expect(parseLegacyMemoryFilename('2026-09-18T00-30-00-fix-session-append-history-loss.md')).toEqual({
            title: 'fix-session-append-history-loss',
            createdAt: new Date(2026, 8, 18, 0, 30, 0).getTime(),
        })
    })

    it.each(['notes', '记忆', 'Notes'])('falls back to the stem for %s.md', (title) => {
        expect(parseLegacyMemoryFilename(title + '.md')).toEqual({ title, createdAt: undefined })
    })
})

describe('token budget helpers', () => {
    it('counts UTF-8 bytes with rounding up', () => {
        expect(approxTokenCount('')).toBe(0)
        expect(approxTokenCount('abcde')).toBe(2)
        expect(approxTokenCount('记忆')).toBe(2)
        expect(approxTokenCount('😀')).toBe(1)
    })

    it('truncates the middle with the legacy marker', () => {
        const result = truncateMiddleWithTokenBudget('a'.repeat(100), 10)
        expect(result.truncated).toBe(true)
        expect(result.content).toBe('a'.repeat(20) + '…15 tokens truncated…' + 'a'.repeat(20))
        expect(result.content).toContain('tokens truncated')
    })

    it('preserves text within budget and empty text', () => {
        expect(truncateMiddleWithTokenBudget('abcd', 1)).toEqual({ content: 'abcd', truncated: false })
        expect(truncateMiddleWithTokenBudget('', 0)).toEqual({ content: '', truncated: false })
    })

    it('handles zero budgets and keeps Unicode code points intact', () => {
        expect(truncateMiddleWithTokenBudget('abcdefgh', 0)).toEqual({ content: '…2 tokens truncated…', truncated: true })
        expect(truncateMiddleWithTokenBudget('😀'.repeat(10), 2)).toEqual({
            content: '😀…8 tokens truncated…😀', truncated: true,
        })
    })
})
