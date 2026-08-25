import { describe, expect, it } from 'vitest'
import {
    applyEditsToNormalizedContent,
    detectLineEnding,
    fuzzyFindText,
    generateDiffString,
    generateUnifiedPatch,
    normalizeForFuzzyMatch,
    normalizeToLF,
    restoreLineEndings,
} from './editDiff.js'

describe('line ending helpers', () => {
    it('detects CRLF when the first newline is CRLF', () => {
        expect(detectLineEnding('a\r\nb\n')).toBe('\r\n')
        expect(detectLineEnding('a\nb\r\n')).toBe('\n')
        expect(detectLineEnding('no-newline')).toBe('\n')
    })

    it('normalizes CRLF/CR to LF and restores CRLF', () => {
        expect(normalizeToLF('a\r\nb\rc\n')).toBe('a\nb\nc\n')
        expect(restoreLineEndings('a\nb\n', '\r\n')).toBe('a\r\nb\r\n')
        expect(restoreLineEndings('a\nb\n', '\n')).toBe('a\nb\n')
    })
})

describe('normalizeForFuzzyMatch', () => {
    it('applies NFKC, trims trailing whitespace, and maps quotes/dashes/spaces', () => {
        const input =
            'ﬁle\u2018x\u2019 \u201C y \u201D \u2013\u2014\u2212\t  \n' +
            'keep\u00A0\u2003\u3000spaces  '
        const normalized = normalizeForFuzzyMatch(input)
        // trimEnd removes trailing tab/spaces; space before mapped dashes is kept.
        expect(normalized).toBe("file'x' \" y \" ---\nkeep   spaces")
        // Idempotent for already-normalized text.
        expect(normalizeForFuzzyMatch(normalized)).toBe(normalized)
    })
})

describe('fuzzyFindText', () => {
    it('prefers exact match and falls back to fuzzy', () => {
        const exact = fuzzyFindText('hello world', 'world')
        expect(exact).toMatchObject({
            found: true,
            index: 6,
            matchLength: 5,
            usedFuzzyMatch: false,
            contentForReplacement: 'hello world',
        })

        // Exact fails because content has trailing spaces before the newline.
        const fuzzy = fuzzyFindText('hello world  \n', 'hello world\n')
        expect(fuzzy.found).toBe(true)
        expect(fuzzy.usedFuzzyMatch).toBe(true)
        expect(fuzzy.contentForReplacement).toBe(normalizeForFuzzyMatch('hello world  \n'))
        expect(fuzzy.matchLength).toBe('hello world\n'.length)
    })
})

describe('applyEditsToNormalizedContent', () => {
    it('rejects empty oldText with an index-aware message for multi-edit', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'abc',
                [
                    { oldText: 'a', newText: 'x' },
                    { oldText: '', newText: 'y' },
                ],
                'a.txt',
            ),
        ).toThrow(/edits\[1\]\.oldText must not be empty/)

        expect(() =>
            applyEditsToNormalizedContent('abc', [{ oldText: '', newText: 'y' }], 'a.txt'),
        ).toThrow(/oldText must not be empty in a\.txt/)
    })

    it('rejects edits that are not found and names the edit index', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'abcdef',
                [
                    { oldText: 'abc', newText: 'x' },
                    { oldText: 'zzz', newText: 'y' },
                ],
                'a.txt',
            ),
        ).toThrow(/Could not find edits\[1\] in a\.txt/)

        expect(() =>
            applyEditsToNormalizedContent('abcdef', [{ oldText: 'zzz', newText: 'y' }], 'a.txt'),
        ).toThrow(/Could not find the exact text in a\.txt/)
    })

    it('rejects non-unique oldText in the original content', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'foo bar foo',
                [{ oldText: 'foo', newText: 'baz' }],
                'dup.txt',
            ),
        ).toThrow(/Found 2 occurrences of the text in dup\.txt/)

        expect(() =>
            applyEditsToNormalizedContent(
                'aa aa',
                [
                    { oldText: 'aa', newText: 'b' },
                    { oldText: 'zz', newText: 'c' },
                ],
                'dup.txt',
            ),
        ).toThrow(/Found 2 occurrences of edits\[0\]/)
    })

    it('counts overlapping matches via indexOf+1 (aaa/aa is duplicate)', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'aaa',
                [{ oldText: 'aa', newText: 'b' }],
                'overlap-occ.txt',
            ),
        ).toThrow(/Found 2 occurrences of the text in overlap-occ\.txt/)
    })

    it('rejects non-empty oldText that fuzzy-normalizes to empty (no zero-length insert)', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'hello world',
                [{ oldText: '   ', newText: 'x' }],
                'empty-fuzzy.txt',
            ),
        ).toThrow(/oldText must not be empty/)
    })

    it('rejects edits that overlap in the original content', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'abcdef',
                [
                    { oldText: 'abcd', newText: 'x' },
                    { oldText: 'cdef', newText: 'y' },
                ],
                'a.txt',
            ),
        ).toThrow(/overlap/)
    })

    it('matches every edit against the same original content (not incremental)', () => {
        const { newContent } = applyEditsToNormalizedContent(
            'one two three',
            [
                { oldText: 'one', newText: '1' },
                { oldText: 'two', newText: '2' },
                { oldText: 'three', newText: '3' },
            ],
            'a.txt',
        )
        expect(newContent).toBe('1 2 3')

        // Second edit must not depend on the first replacement having been applied.
        expect(() =>
            applyEditsToNormalizedContent(
                'abc',
                [
                    { oldText: 'abc', newText: 'xyz' },
                    { oldText: 'xyz', newText: 'nope' },
                ],
                'a.txt',
            ),
        ).toThrow(/Could not find edits\[1\]/)
    })

    it('applies multiple exact edits in reverse so offsets stay stable', () => {
        const { baseContent, newContent } = applyEditsToNormalizedContent(
            'alpha beta gamma',
            [
                { oldText: 'alpha', newText: 'A' },
                { oldText: 'gamma', newText: 'G' },
            ],
            'a.txt',
        )
        expect(baseContent).toBe('alpha beta gamma')
        expect(newContent).toBe('A beta G')
    })

    it('rejects replacements that produce no content change', () => {
        expect(() =>
            applyEditsToNormalizedContent(
                'same',
                [{ oldText: 'same', newText: 'same' }],
                'a.txt',
            ),
        ).toThrow(/No changes made to a\.txt/)

        expect(() =>
            applyEditsToNormalizedContent(
                'ab',
                [
                    { oldText: 'a', newText: 'a' },
                    { oldText: 'b', newText: 'b' },
                ],
                'a.txt',
            ),
        ).toThrow(/No changes made to a\.txt/)
    })

    it('fuzzy-matches trailing whitespace while preserving untouched lines', () => {
        // oldText includes the newline so exact match fails against trailing spaces.
        const original = 'keep-trail  \nchange-me  \nkeep-trail  \n'
        const { newContent } = applyEditsToNormalizedContent(
            original,
            [{ oldText: 'change-me\n', newText: 'changed\n' }],
            'ws.txt',
        )
        expect(newContent).toBe('keep-trail  \nchanged\nkeep-trail  \n')
    })

    it('fuzzy-matches smart quotes, dashes, and special spaces', () => {
        const original = 'say \u201Chello\u201D \u2013 world\u00A0!\n'
        const { newContent } = applyEditsToNormalizedContent(
            original,
            [{ oldText: 'say "hello" - world !', newText: 'greet' }],
            'q.txt',
        )
        expect(newContent).toBe('greet\n')
    })

    it('handles NFKC ligature expansion without losing uniqueness of the real occurrence', () => {
        // U+FB01 LATIN SMALL LIGATURE FI → "fi" under NFKC (length expands).
        // Multi-line so the untouched first line keeps its original ligature bytes.
        const original = 'pre ﬁsh\nmid ﬁsh post\n'
        const { newContent } = applyEditsToNormalizedContent(
            original,
            [{ oldText: 'mid fish post', newText: 'mid FISH post' }],
            'lig.txt',
        )
        expect(newContent).toBe('pre ﬁsh\nmid FISH post\n')
    })

    it('rejects duplicate normalized lines in fuzzy space', () => {
        const original = 'row  \nrow  \n'
        expect(() =>
            applyEditsToNormalizedContent(
                original,
                [{ oldText: 'row', newText: 'x' }],
                'dup-fuzzy.txt',
            ),
        ).toThrow(/Found 2 occurrences/)
    })

    it('supports multi-line exact and fuzzy edits spanning lines', () => {
        const original = 'a\nb\nc\n'
        const exact = applyEditsToNormalizedContent(
            original,
            [{ oldText: 'a\nb', newText: 'AB' }],
            'ml.txt',
        )
        expect(exact.newContent).toBe('AB\nc\n')

        const fuzzy = applyEditsToNormalizedContent(
            'a  \nb  \nc\n',
            [{ oldText: 'a\nb', newText: 'AB' }],
            'mlf.txt',
        )
        expect(fuzzy.newContent).toBe('AB\nc\n')
    })

    it('runs the whole batch in fuzzy space when any edit needs fuzzy, mixed with exact', () => {
        const original = 'exact-here\ntrail  \nexact-two\n'
        const { newContent } = applyEditsToNormalizedContent(
            original,
            [
                { oldText: 'exact-here', newText: 'EXACT' },
                // Force fuzzy via trailing-space mismatch around the newline.
                { oldText: 'trail\n', newText: 'TRAIL\n' },
                { oldText: 'exact-two', newText: 'TWO' },
            ],
            'mix.txt',
        )
        expect(newContent).toBe('EXACT\nTRAIL\nTWO\n')
    })

    it('preserves original Unicode on untouched lines when fuzzy rewriting a touched group', () => {
        const original = 'untouched \u201Cline\u201D  \ntarget \u2013 value  \nalso \uFB01ne  \n'
        const { newContent } = applyEditsToNormalizedContent(
            original,
            [{ oldText: 'target - value', newText: 'done' }],
            'preserve.txt',
        )
        expect(newContent).toBe('untouched \u201Cline\u201D  \ndone\nalso \uFB01ne  \n')
    })
})

describe('generateDiffString / generateUnifiedPatch', () => {
    it('builds a numbered context diff and reports the first changed line in the new file', () => {
        const oldContent = 'one\ntwo\nthree\nfour\nfive\n'
        const newContent = 'one\nTWO\nthree\nfour\nfive\n'
        const { diff, firstChangedLine } = generateDiffString(oldContent, newContent, 1)
        expect(firstChangedLine).toBe(2)
        expect(diff).toContain('-2 two')
        expect(diff).toContain('+2 TWO')
        expect(diff).toContain(' 1 one')
        expect(diff).toContain(' 3 three')
    })

    it('numbers context lines from the new/current file after inserts and deletes', () => {
        // Insert a line: context after the insert must use new-file line numbers.
        const inserted = generateDiffString('a\nc\n', 'a\nb\nc\n', 1)
        expect(inserted.firstChangedLine).toBe(2)
        expect(inserted.diff).toContain('+2 b')
        expect(inserted.diff).toContain(' 1 a')
        expect(inserted.diff).toContain(' 3 c')

        // Delete a line: remaining context uses new-file line numbers; removed uses old.
        const deleted = generateDiffString('a\nb\nc\n', 'a\nc\n', 1)
        expect(deleted.firstChangedLine).toBe(2)
        expect(deleted.diff).toContain('-2 b')
        expect(deleted.diff).toContain(' 1 a')
        expect(deleted.diff).toContain(' 2 c')
    })

    it('generates a unified patch without undefined timestamps that describes the change', () => {
        const patch = generateUnifiedPatch('a.txt', 'hello\n', 'hello world\n', 2)
        expect(patch).not.toMatch(/undefined/)
        expect(patch).toContain('--- a.txt')
        expect(patch).toContain('+++ a.txt')
        expect(patch).toContain('-hello')
        expect(patch).toContain('+hello world')
    })

    it('diffs LF-normalized content only (callers normalize first)', () => {
        const { diff, firstChangedLine } = generateDiffString('a\nb\n', 'a\nB\n')
        expect(firstChangedLine).toBe(2)
        expect(diff).toContain('-2 b')
        expect(diff).toContain('+2 B')
    })
})
