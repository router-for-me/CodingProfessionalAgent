import { describe, expect, it } from 'vitest'
import { expandPromptTemplateWithReferences, trimTextWithSkillReferences } from './promptTemplates.js'

describe('trimTextWithSkillReferences', () => {
    it('shifts references past leading whitespace and retains cards at the trimmed end', () => {
        const text = ' \n$test  $other \n'
        expect(trimTextWithSkillReferences(text, [
            { start: 9, name: 'other' }, { start: 2, name: 'test' },
        ])).toEqual({ text: '$test  $other', references: [
            { start: 0, name: 'test' }, { start: 7, name: 'other' },
        ] })
    })

    it('drops out-of-range, mismatched, and duplicate references without inferring plain text', () => {
        expect(trimTextWithSkillReferences(' \n$test \n', [
            { start: 0, name: 'test' }, { start: 2, name: 'test' },
            { start: 2, name: 'test' }, { start: 2, name: 'other' },
            { start: 8, name: 'test' },
        ])).toEqual({ text: '$test', references: [{ start: 0, name: 'test' }] })
        expect(trimTextWithSkillReferences(' $test ', [])).toEqual({ text: '$test', references: [] })
    })
})

describe('expandPromptTemplateWithReferences', () => {
    const templates = [
        { name: 'move', content: '$2 $1 $1', description: '', filePath: '' },
        { name: 'drop', content: '$2', description: '', filePath: '' },
        { name: 'literal', content: '$demo $1', description: '', filePath: '' },
    ]

    it('tracks repeated and reordered quoted arguments by origin, not by matching text', () => {
        expect(expandPromptTemplateWithReferences('/move "$demo" plain', [{ start: 7, name: 'demo' }], templates))
            .toEqual({ text: 'plain $demo $demo', references: [
                { start: 6, name: 'demo' }, { start: 12, name: 'demo' },
            ] })
    })

    it('drops deleted references and does not mark literal template content', () => {
        expect(expandPromptTemplateWithReferences('/drop $demo plain', [{ start: 6, name: 'demo' }], templates))
            .toEqual({ text: 'plain', references: [] })
        expect(expandPromptTemplateWithReferences('/literal $demo', [{ start: 9, name: 'demo' }], templates))
            .toEqual({ text: '$demo $demo', references: [{ start: 6, name: 'demo' }] })
    })
})
