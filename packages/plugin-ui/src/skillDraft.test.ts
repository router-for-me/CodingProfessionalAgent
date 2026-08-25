import { describe, expect, it } from 'vitest'
import {
    formatSkillDisplayName,
    getSkillQuery,
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
