import { describe, expect, it } from 'vitest'
import {
    balanceMarkdownCodeFences,
    extractMarkdownNodeText,
    isMarkdownPreEmpty,
    normalizeMarkdownMath,
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

    describe('normalizeMarkdownMath', () => {
        it('normalizes inline single-dollar LaTeX such as $\\rightarrow$', () => {
            expect(normalizeMarkdownMath('Step A $\\rightarrow$ Step B')).toBe(
                'Step A $$\\rightarrow$$ Step B',
            )
            expect(normalizeMarkdownMath('模型输出$\\rightarrow$符号')).toBe(
                '模型输出$$\\rightarrow$$符号',
            )
        })

        it('normalizes inline \\( ... \\) and display \\[ ... \\] delimiters', () => {
            expect(normalizeMarkdownMath('Inline \\( E = mc^2 \\) formula')).toBe(
                'Inline $$E = mc^2$$ formula',
            )
            expect(normalizeMarkdownMath('\\[ \\int_0^1 x^2 dx = \\frac{1}{3} \\]')).toBe(
                '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$',
            )
            expect(
                normalizeMarkdownMath('Before\n\\[\na^2 + b^2 = c^2\n\\]\nAfter'),
            ).toBe('Before\n$$\na^2 + b^2 = c^2\n$$\nAfter')
        })

        it('does not treat currency values or shell variables as math', () => {
            expect(normalizeMarkdownMath('Price is $100 and $200.')).toBe(
                'Price is $100 and $200.',
            )
            expect(normalizeMarkdownMath('价格从$100涨到了$200，符号是$\\rightarrow$')).toBe(
                '价格从$100涨到了$200，符号是$$\\rightarrow$$',
            )
            expect(
                normalizeMarkdownMath('In bash, $HOME is used; in math, $x + y = z$ is used.'),
            ).toBe('In bash, $HOME is used; in math, $$x + y = z$$ is used.')
        })

        it('leaves inline code spans and fenced code blocks untouched', () => {
            const input = [
                'Inline `$\\rightarrow$` vs real $\\rightarrow$',
                '```ts',
                'const arrow = "$\\rightarrow$"',
                '```',
            ].join('\n')

            const expected = [
                'Inline `$\\rightarrow$` vs real $$\\rightarrow$$',
                '```ts',
                'const arrow = "$\\rightarrow$"',
                '```',
            ].join('\n')

            expect(normalizeMarkdownMath(input)).toBe(expected)
        })

        it('protects indented code blocks, blockquoted code fences, and multi-line inline code', () => {
            const indented = 'Paragraph before\n\n    echo $HOME$\n\nParagraph $x$'
            expect(normalizeMarkdownMath(indented)).toBe(
                'Paragraph before\n\n    echo $HOME$\n\nParagraph $$x$$',
            )

            const blockquotedIndented = '>     echo $HOME$'
            expect(normalizeMarkdownMath(blockquotedIndented)).toBe('>     echo $HOME$')

            const blockquotedFence = ['> ```bash', '> echo $HOME$', '> ```', '> Math $y$'].join(
                '\n',
            )
            expect(normalizeMarkdownMath(blockquotedFence)).toBe(
                ['> ```bash', '> echo $HOME$', '> ```', '> Math $$y$$'].join('\n'),
            )

            const multilineInlineCode = 'Start `line1\n$HOME$\nline2` and $z$'
            expect(normalizeMarkdownMath(multilineInlineCode)).toBe(
                'Start `line1\n$HOME$\nline2` and $$z$$',
            )

            const multilineInlineCodeWithBlockMath = 'Start `line1\n\\[x\\]\nline2` and $z$'
            expect(normalizeMarkdownMath(multilineInlineCodeWithBlockMath)).toBe(
                'Start `line1\n\\[x\\]\nline2` and $$z$$',
            )

            const multilineInlineCodeWithDoubleDollar = 'Start `line1\n$$\nline2` and $z$'
            expect(normalizeMarkdownMath(multilineInlineCodeWithDoubleDollar)).toBe(
                'Start `line1 $$\nline2` and $$z$$',
            )

            const bqMultilineInlineCodeWithDoubleDollar =
                '> Start `line1\n> $$\n> line2` and $z$'
            expect(normalizeMarkdownMath(bqMultilineInlineCodeWithDoubleDollar)).toBe(
                '> Start `line1 $$\n> line2` and $$z$$',
            )
        })

        it('processes large 4000-line documents with inline code and math in linear time', () => {
            const largeDoc = Array.from(
                { length: 4000 },
                (_, idx) => `- Item \`code_${idx}\` with formula $x_${idx} \\rightarrow y_${idx}$`,
            ).join('\n')
            const start = performance.now()
            const output = normalizeMarkdownMath(largeDoc)
            const elapsedMs = performance.now() - start
            expect(output).toContain('$$x_0 \\rightarrow y_0$$')
            expect(output).toContain('$$x_3999 \\rightarrow y_3999$$')
            expect(elapsedMs).toBeLessThan(200)
        })

        it('preserves URLs in markdown links, images, and reference definitions while allowing math in link labels', () => {
            expect(
                normalizeMarkdownMath(
                    '[See $\\rightarrow$ report](https://example.com/$file$/report)',
                ),
            ).toBe('[See $$\\rightarrow$$ report](https://example.com/$file$/report)')

            expect(
                normalizeMarkdownMath('[download](\n/$file$/report\n)'),
            ).toBe('[download](\n/$file$/report\n)')

            expect(
                normalizeMarkdownMath('![diagram](https://example.com/$img$/a.png)'),
            ).toBe('![diagram](https://example.com/$img$/a.png)')

            expect(
                normalizeMarkdownMath('[ref]: https://example.com/$path$/doc\nText $x$'),
            ).toBe('[ref]: https://example.com/$path$/doc\nText $$x$$')

            expect(
                normalizeMarkdownMath('[ref $x$]\n\n[ref $x$]: /target'),
            ).toBe('[ref $x$]\n\n[ref $x$]: /target')

            expect(
                normalizeMarkdownMath('[See $\\rightarrow$][ref $x$]\n\n[ref $x$]: /target'),
            ).toBe('[See $$\\rightarrow$$][ref $x$]\n\n[ref $x$]: /target')
        })

        it('normalizes multi-line $$...$$ blocks with content on delimiter lines without swallowing following text', () => {
            const input = '$$x +\ny$$\n\nAfter $z$'
            expect(normalizeMarkdownMath(input)).toBe('$$\nx +\ny\n$$\n\nAfter $$z$$')

            const streamingUnclosed = '$$x +'
            expect(normalizeMarkdownMath(streamingUnclosed)).toBe('$$\nx +\n$$')
        })
    })
})
