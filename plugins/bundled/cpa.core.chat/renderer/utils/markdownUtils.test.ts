import { describe, expect, it } from 'vitest'
import {
    balanceMarkdownCodeFences,
    extractMarkdownNodeText,
    isMarkdownPreEmpty,
} from './markdownUtils.js'

describe('markdownUtils', () => {
    describe('extractMarkdownNodeText', () => {
        it('handles null and undefined', () => {
            expect(extractMarkdownNodeText(null)).toBe('')
            expect(extractMarkdownNodeText(undefined)).toBe('')
        })

        it('extracts string and number primitives', () => {
            expect(extractMarkdownNodeText('hello world')).toBe('hello world')
            expect(extractMarkdownNodeText(42)).toBe('42')
        })

        it('extracts text from hast nodes with value', () => {
            expect(extractMarkdownNodeText({ type: 'text', value: 'echo hi' })).toBe('echo hi')
        })

        it('extracts text recursively from hast element trees', () => {
            const tree = {
                type: 'element',
                tagName: 'pre',
                children: [
                    {
                        type: 'element',
                        tagName: 'code',
                        children: [
                            { type: 'text', value: 'const x = 1;' },
                            { type: 'text', value: '\nconsole.log(x);' },
                        ],
                    },
                ],
            }
            expect(extractMarkdownNodeText(tree)).toBe('const x = 1;\nconsole.log(x);')
        })

        it('extracts text from React element props', () => {
            const reactElem = {
                props: {
                    children: [
                        { props: { children: 'first part' } },
                        ' and second part',
                    ],
                },
            }
            expect(extractMarkdownNodeText(reactElem)).toBe('first part and second part')
        })
    })

    describe('isMarkdownPreEmpty', () => {
        it('returns true for empty string or null values', () => {
            expect(isMarkdownPreEmpty(null, null)).toBe(true)
            expect(isMarkdownPreEmpty('', '')).toBe(true)
        })

        it('returns true for whitespace-only nodes', () => {
            const node = {
                type: 'element',
                tagName: 'pre',
                children: [
                    {
                        type: 'element',
                        tagName: 'code',
                        children: [{ type: 'text', value: '   \n\t  ' }],
                    },
                ],
            }
            expect(isMarkdownPreEmpty(node, null)).toBe(true)
        })

        it('returns false when node contains non-whitespace code', () => {
            const node = {
                type: 'element',
                tagName: 'pre',
                children: [
                    {
                        type: 'element',
                        tagName: 'code',
                        children: [{ type: 'text', value: 'export CLAUDE_CODE_AUTO_MODE_SERVER=0' }],
                    },
                ],
            }
            expect(isMarkdownPreEmpty(node, null)).toBe(false)
        })

        it('falls back to children when node text is empty', () => {
            expect(isMarkdownPreEmpty(null, 'ls -la')).toBe(false)
            expect(isMarkdownPreEmpty(null, '   ')).toBe(true)
        })
    })

    describe('balanceMarkdownCodeFences', () => {
        it('returns plain text unchanged without fences', () => {
            expect(balanceMarkdownCodeFences('hello world')).toBe('hello world')
            expect(balanceMarkdownCodeFences('')).toBe('')
        })

        it('leaves well-formed non-nested code blocks unchanged', () => {
            const code = '```typescript\nconst a: number = 1;\n```'
            expect(balanceMarkdownCodeFences(code)).toBe(code)
        })

        it('promotes outer fence to 4 backticks when enclosing inner code block', () => {
            const input = [
                '```markdown',
                '# Issue Template',
                '   ```bash',
                '   export CLAUDE_CODE_AUTO_MODE_SERVER=0',
                '   ```',
                '```',
            ].join('\n')

            const expected = [
                '````markdown',
                '# Issue Template',
                '   ```bash',
                '   export CLAUDE_CODE_AUTO_MODE_SERVER=0',
                '   ```',
                '````',
            ].join('\n')

            expect(balanceMarkdownCodeFences(input)).toBe(expected)
        })

        it('automatically closes unclosed code blocks at EOF', () => {
            const streaming = '```python\ndef run():\n    return True'
            expect(balanceMarkdownCodeFences(streaming)).toBe('```python\ndef run():\n    return True\n```')
        })

        it('handles multi-level nesting by incrementing required backticks', () => {
            const input = [
                '```text',
                'outer',
                '```markdown',
                'inner',
                '```bash',
                'innermost',
                '```',
                '```',
                '```',
            ].join('\n')

            const output = balanceMarkdownCodeFences(input)
            const lines = output.split('\n')
            // Outermost fence should be 5 backticks
            expect(lines[0]).toBe('`````text')
            expect(lines[lines.length - 1]).toBe('`````')
            // Middle fence should be 4 backticks
            expect(lines[2]).toBe('````markdown')
            expect(lines[7]).toBe('````')
            // Innermost fence remains 3 backticks
            expect(lines[4]).toBe('```bash')
            expect(lines[6]).toBe('```')
        })
    })
})
