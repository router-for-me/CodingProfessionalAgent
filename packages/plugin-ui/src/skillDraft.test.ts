import { describe, expect, it } from 'vitest'
import {
    formatSkillDisplayName,
    getSkillQuery,
    formatSkillDraftForClipboard,
    insertSkillInParts,
    normalizeSkillDraft,
    parseReferencedSkillDraft,
    insertSkillAtCaret,
    parseSkillDraft,
    replaceSkillToken,
    serializeSkillDraft,
    skillDraftHasChip,
} from './skillDraft.js'

const skills = [{ name: 'gh-issue' }, { name: 'fix-issue' }, { name: 'demo' }]

describe('formatSkillDisplayName', () => {
    it('title-cases kebab-case and snake_case skill names', () => {
        expect(formatSkillDisplayName('cpa-plugin-pr-audit')).toBe(
            'Cpa Plugin Pr Audit',
        )
        expect(formatSkillDisplayName('demo_skill')).toBe('Demo Skill')
        expect(formatSkillDisplayName('demo')).toBe('Demo')
        expect(formatSkillDisplayName('')).toBe('')
    })
})

describe('parseSkillDraft', () => {
    it('folds every exact $skill token and keeps surrounding text', () => {
        expect(
            parseSkillDraft('hello $gh-issue 4937 then $fix-issue please', skills),
        ).toEqual([
            { type: 'text', text: 'hello ' },
            { type: 'skill', name: 'gh-issue', displayName: 'Gh Issue' },
            { type: 'text', text: ' 4937 then ' },
            { type: 'skill', name: 'fix-issue', displayName: 'Fix Issue' },
            { type: 'text', text: ' please' },
        ])
    })

    it('does not fold unknown or mid-word $ tokens', () => {
        expect(parseSkillDraft('price$100 and $unknown 1', skills)).toEqual([
            { type: 'text', text: 'price$100 and $unknown 1' },
        ])
    })

    it('keeps the live $query at the caret so typing is not folded early', () => {
        const text = 'see $gh-issue'
        expect(parseSkillDraft(text, skills, text.length)).toEqual([
            { type: 'text', text },
        ])
        expect(parseSkillDraft(`${text} `, skills, text.length + 1)).toEqual([
            { type: 'text', text: 'see ' },
            { type: 'skill', name: 'gh-issue', displayName: 'Gh Issue' },
            { type: 'text', text: ' ' },
        ])
    })
})

describe('serializeSkillDraft', () => {
    it('round-trips folded parts back to $name commands', () => {
        const text = 'hello $gh-issue 4937 then $fix-issue please'
        expect(serializeSkillDraft(parseSkillDraft(text, skills))).toBe(text)
    })
})

describe('skillDraftHasChip', () => {
    it('detects whether any skill chip parts are present', () => {
        expect(skillDraftHasChip(parseSkillDraft('plain', skills))).toBe(false)
        expect(skillDraftHasChip(parseSkillDraft('$demo', skills))).toBe(true)
    })
})

describe('configured skill triggers and stored references', () => {
    const loaded = [{ name: 'demo' }]

    it('recognizes only the selected trigger and never treats Markdown headings as tokens', () => {
        expect(getSkillQuery('use #de', undefined, '#')).toBe('de')
        expect(getSkillQuery('use $de', undefined, '#')).toBeNull()
        expect(getSkillQuery('# title', undefined, '#')).toBeNull()
        expect(getSkillQuery('##demo', undefined, '#')).toBeNull()
        expect(parseSkillDraft('#demo $demo /skill:demo', loaded, undefined, '#', false, [], false)).toEqual([
            { type: 'skill', name: 'demo', displayName: 'Demo' },
            { type: 'text', text: ' $demo /skill:demo' },
        ])
    })

    it('keeps literal dollar text separate from canonical chips in alternate modes', () => {
        const parts = [
            { type: 'text' as const, text: '$demo ' },
            { type: 'skill' as const, name: 'demo', displayName: 'Demo' },
        ]
        const result = normalizeSkillDraft(parts, loaded, '#')
        expect(result).toEqual({ text: '$demo $demo', references: [{ start: 6, name: 'demo' }] })
        expect(parseReferencedSkillDraft(result.text, result.references)).toEqual(parts)
        expect(formatSkillDraftForClipboard(parts, '#')).toBe('$demo #demo')
        expect(formatSkillDraftForClipboard(parts, '/')).toBe('$demo /skill:demo')
    })

    it('inserts at the caret without reinterpreting literal text or an existing chip', () => {
        const parts = [
            { type: 'text' as const, text: 'use #de tail ' },
            { type: 'skill' as const, name: 'demo', displayName: 'Demo' },
            { type: 'text' as const, text: ' $demo' },
        ]
        expect(insertSkillInParts(parts, 'model', 7, '#')).toEqual({
            text: 'use $model  tail $demo $demo', cursor: 11,
            references: [{ start: 4, name: 'model' }, { start: 17, name: 'demo' }],
        })
    })

    it('reserves slash controls after leading whitespace without blocking inline slash skills', () => {
        const commands = [{ name: 'model' }, { name: 'compact' }, { name: 'review' }]
        for (const text of [' /model hi', '\n/compact focus', '\t/review file']) {
            expect(parseSkillDraft(text, commands, undefined, '/', false, ['model', 'compact', 'review'], false))
                .toEqual([{ type: 'text', text }])
            expect(normalizeSkillDraft([{ type: 'text', text }], commands, '/', ['model', 'compact', 'review']))
                .toEqual({ text, references: [] })
        }
        expect(normalizeSkillDraft([
            { type: 'text', text: '\n' }, { type: 'text', text: '/compact focus' },
        ], commands, '/', ['model', 'compact']))
            .toEqual({ text: '\n/compact focus', references: [] })
        expect(normalizeSkillDraft([{ type: 'text', text: 'use /model hi' }], commands, '/', ['model']))
            .toEqual({ text: 'use $model hi', references: [{ start: 4, name: 'model' }] })
    })

    it('reserves direct slash commands while allowing explicit skill tokens', () => {
        expect(normalizeSkillDraft([{ type: 'text', text: '/model ' }], [{ name: 'model' }], '/', ['model']))
            .toEqual({ text: '/model ', references: [] })
        expect(parseSkillDraft('/skill:model ', [{ name: 'model' }], undefined, '/', false, [], true)).toEqual([
            { type: 'skill', name: 'model', displayName: 'Model' },
            { type: 'text', text: ' ' },
        ])
    })
})

describe('getSkillQuery', () => {
    it('returns empty query for a lone $ token', () => {
        expect(getSkillQuery('$')).toBe('')
        expect(getSkillQuery('use $')).toBe('')
    })

    it('returns the trailing $ token and closes after a space', () => {
        expect(getSkillQuery('$cap')).toBe('cap')
        expect(getSkillQuery('please $alpha')).toBe('alpha')
        expect(getSkillQuery('$cap extra')).toBeNull()
        expect(getSkillQuery('hello')).toBeNull()
        expect(getSkillQuery('price$100')).toBeNull()
    })

    it('uses the caret so $ in front of existing text still opens', () => {
        expect(getSkillQuery('$hello world', 1)).toBe('')
        expect(getSkillQuery('$dehello world', 3)).toBe('de')
        expect(getSkillQuery('hello $world', 7)).toBe('')
        expect(getSkillQuery('hello $alworld', 9)).toBe('al')
        expect(getSkillQuery('$hello world', 12)).toBeNull()
    })
})

describe('punctuation-adjacent skill tokens', () => {
    it.each(['你是做什么的？', '请使用：', '你好，', 'Use (', 'Use!'])(
        'supports querying, inserting, and folding after %s',
        (prefix) => {
            expect(getSkillQuery(`${prefix}$`)).toBe('')
            expect(getSkillQuery(`${prefix}$de`)).toBe('de')
            const inserted = insertSkillAtCaret(`${prefix}$de suffix`, 'demo', prefix.length + 3)
            expect(inserted).toEqual({
                text: `${prefix}$demo  suffix`,
                cursor: prefix.length + 6,
            })
            expect(replaceSkillToken(`${prefix}$de`, '$demo ')).toBe(`${prefix}$demo `)
            const parts = parseSkillDraft(inserted.text, skills)
            expect(parts).toEqual([
                { type: 'text', text: prefix },
                { type: 'skill', name: 'demo', displayName: 'Demo' },
                { type: 'text', text: '  suffix' },
            ])
            expect(serializeSkillDraft(parts)).toBe(inserted.text)
        },
    )
})

describe('insertSkillAtCaret / replaceSkillToken', () => {
    it('replaces the trailing $ token including mid-text mentions', () => {
        expect(replaceSkillToken('$', '$alpha ')).toBe('$alpha ')
        expect(replaceSkillToken('$al', '$alpha ')).toBe('$alpha ')
        expect(replaceSkillToken('use $al', '$alpha ')).toBe('use $alpha ')
        expect(replaceSkillToken('$al', '')).toBe('')
        expect(replaceSkillToken('use $al', '')).toBe('use ')
    })

    it('replaces the $ token before the caret and keeps trailing text', () => {
        expect(replaceSkillToken('$hello world', '', 1)).toBe('hello world')
        expect(replaceSkillToken('$dehello world', '', 3)).toBe('hello world')
        expect(replaceSkillToken('hello $world', '', 7)).toBe('hello world')
    })

    it('inserts $name at the caret without dropping later text', () => {
        expect(insertSkillAtCaret('$dehello world', 'demo', 3)).toEqual({
            text: '$demo hello world',
            cursor: 6,
        })
        expect(insertSkillAtCaret('use $al', 'alpha')).toEqual({
            text: 'use $alpha ',
            cursor: 11,
        })
    })
})
