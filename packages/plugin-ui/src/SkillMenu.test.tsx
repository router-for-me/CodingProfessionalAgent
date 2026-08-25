import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, opts?: { defaultValue?: string }) =>
            opts?.defaultValue ?? _key,
        i18n: { language: 'zh-CN' },
    }),
}))

import {
    buildSkillSuggestions,
    composeSkillDraft,
    flattenSkillDescription,
    foldSkillInputPaste,
    getSkillUsageCount,
    isSkillChipSelected,
    isTypingReplacementKey,
    matchPastedSkillChip,
    resolveVerticalMenuPlacement,
    skillInputClipboardText,
    writeSkillInputClipboard,
    scrollOptionIntoView,
    skillOptionId,
    skillSourceFromPath,
    SkillMenu,
    type SkillSuggestion,
} from './SkillMenu.js'

const skills = [
    {
        name: 'zeta',
        description: 'Z skill',
        filePath: '/config/coding-professional-agent/agent/skills/zeta/SKILL.md',
    },
    {
        name: 'alpha',
        description: 'A skill',
        filePath: '/repo/.cpa/skills/alpha/SKILL.md',
    },
    {
        name: 'capacity',
        description: 'Discovers available model capacity',
        filePath: '/config/coding-professional-agent/agent/skills/capacity/SKILL.md',
    },
] as const

describe('flattenSkillDescription', () => {
    it('collapses multiline skill descriptions onto one line', () => {
        expect(flattenSkillDescription('  Audit PRs\n\nUse when reviewing  ')).toBe(
            'Audit PRs Use when reviewing',
        )
    })
})

describe('composeSkillDraft', () => {
    it('rebuilds $name plus leftover args for expansion', () => {
        expect(composeSkillDraft(null, 'plain')).toBe('plain')
        expect(composeSkillDraft({ name: 'demo' }, '')).toBe('$demo')
        expect(composeSkillDraft({ name: 'demo' }, ' extra ')).toBe('$demo extra')
    })
})

describe('matchPastedSkillChip', () => {
    const pastedSkills = [
        { name: 'gh-issue' },
        { name: 'demo' },
    ] as const

    it('folds an exact $skill token and keeps the remaining args', () => {
        expect(
            matchPastedSkillChip(
                '$gh-issue 4937 dispatch gpt-5.6-luna:max subagent, describe what the issue is',
                pastedSkills as any,
            ),
        ).toEqual({
            name: 'gh-issue',
            displayName: 'Gh Issue',
            args: '4937 dispatch gpt-5.6-luna:max subagent, describe what the issue is',
        })
    })

    it('accepts a bare $skill token and trims surrounding whitespace', () => {
        expect(matchPastedSkillChip('  $Demo  extra line  ', pastedSkills as any)).toEqual({
            name: 'demo',
            displayName: 'Demo',
            args: 'extra line',
        })
        expect(matchPastedSkillChip('$gh-issue', pastedSkills as any)).toEqual({
            name: 'gh-issue',
            displayName: 'Gh Issue',
            args: '',
        })
    })

    it('ignores prefix-only, unknown, and mid-text $ tokens', () => {
        expect(matchPastedSkillChip('$gh', pastedSkills as any)).toBeNull()
        expect(matchPastedSkillChip('$unknown 4937', pastedSkills as any)).toBeNull()
        expect(matchPastedSkillChip('please $gh-issue 4937', pastedSkills as any)).toBeNull()
        expect(matchPastedSkillChip('/skill:gh-issue 4937', pastedSkills as any)).toBeNull()
    })
})

describe('skill chip selection clipboard', () => {
    const chip = { name: 'gh-issue', displayName: 'Gh Issue' }

    it('treats a chip as selected only when the whole draft is selected', () => {
        expect(isSkillChipSelected(chip, '4937', 0, 4)).toBe(true)
        expect(isSkillChipSelected(chip, '', 0, 0)).toBe(false)
        expect(isSkillChipSelected(chip, '', 0, 0, true)).toBe(true)
        expect(isSkillChipSelected(chip, '4937', 0, 0)).toBe(false)
        expect(isSkillChipSelected(chip, '4937', 1, 4)).toBe(false)
        expect(isSkillChipSelected(null, '4937', 0, 4)).toBe(false)
    })

    it('serializes the chip command plus args for the clipboard', () => {
        expect(skillInputClipboardText(chip, '4937 describe this')).toBe(
            '$gh-issue 4937 describe this',
        )
    })

    it('writes the serialized command when clipboard data is available', () => {
        const setData = vi.fn()
        const preventDefault = vi.fn()
        expect(
            writeSkillInputClipboard(
                { preventDefault, clipboardData: { setData } as unknown as DataTransfer },
                chip,
                '4937',
            ),
        ).toBe(true)
        expect(preventDefault).toHaveBeenCalledTimes(1)
        expect(setData).toHaveBeenCalledWith('text/plain', '$gh-issue 4937')
    })

    it('folds a replacing $skill paste and clears the chip for plain text', () => {
        expect(
            foldSkillInputPaste({
                pasted: '$gh-issue 4937 describe this',
                skills: [{ name: 'gh-issue' }] as any,
                chip: null,
                draft: '',
                selectionStart: 0,
                selectionEnd: 0,
            }),
        ).toEqual({
            chip: { name: 'gh-issue', displayName: 'Gh Issue' },
            draft: '4937 describe this',
        })
        expect(
            foldSkillInputPaste({
                pasted: 'hello',
                skills: [{ name: 'gh-issue' }] as any,
                chip,
                draft: '4937',
                selectionStart: 0,
                selectionEnd: 4,
            }),
        ).toEqual({ chip: null, draft: 'hello' })
        expect(
            foldSkillInputPaste({
                pasted: 'hello',
                skills: [{ name: 'gh-issue' }] as any,
                chip,
                draft: '',
                selectionStart: 0,
                selectionEnd: 0,
                chipSelected: false,
            }),
        ).toBeNull()
        expect(
            foldSkillInputPaste({
                pasted: '$gh-issue extra',
                skills: [{ name: 'gh-issue' }] as any,
                chip,
                draft: 'keep me',
                selectionStart: 2,
                selectionEnd: 4,
            }),
        ).toBeNull()
    })

    it('treats printable keys without modifiers as replacements', () => {
        expect(isTypingReplacementKey({ key: 'a', metaKey: false, ctrlKey: false, altKey: false })).toBe(
            true,
        )
        expect(
            isTypingReplacementKey({ key: 'a', metaKey: true, ctrlKey: false, altKey: false }),
        ).toBe(false)
        expect(
            isTypingReplacementKey({
                key: 'Backspace',
                metaKey: false,
                ctrlKey: false,
                altKey: false,
            }),
        ).toBe(false)
    })
})

describe('skillSourceFromPath', () => {
    it('marks project skills under .cpa/skills and others as personal', () => {
        expect(skillSourceFromPath('/repo/.cpa/skills/alpha/SKILL.md')).toBe(
            'project',
        )
        expect(
            skillSourceFromPath('C:\\repo\\.cpa\\skills\\alpha\\SKILL.md'),
        ).toBe('project')
        expect(
            skillSourceFromPath(
                '/config/coding-professional-agent/agent/skills/zeta/SKILL.md',
            ),
        ).toBe('personal')
    })
})

describe('buildSkillSuggestions', () => {
    it('lists every loaded skill in name order when the query is empty', () => {
        const items = buildSkillSuggestions({ query: '', skills: skills as any })
        expect(items.map((item) => item.name)).toEqual([
            'alpha',
            'capacity',
            'zeta',
        ])
        expect(items[0]?.insertText).toBe('$alpha ')
        expect(items[0]?.displayName).toBe('Alpha')
        expect(items[0]?.source).toBe('project')
        expect(items[1]?.source).toBe('personal')
    })

    it('filters by name prefix and substring', () => {
        expect(
            buildSkillSuggestions({ query: 'al', skills: skills as any }).map((item) => item.name),
        ).toEqual(['alpha'])
        expect(
            buildSkillSuggestions({ query: 'eta', skills: skills as any }).map((item) => item.name),
        ).toEqual(['zeta'])
        expect(
            buildSkillSuggestions({ query: 'cap', skills: skills as any }).map((item) => item.name),
        ).toEqual(['capacity'])
        expect(
            buildSkillSuggestions({ query: 'model', skills: skills as any }).map((item) => item.name),
        ).toEqual([])
    })

    it('prioritizes most frequently used skills and falls back to alphabetical order', () => {
        const sampleSkills = [
            { name: 'fix-issue', description: 'Fix issue', filePath: '/skills/fix-issue/SKILL.md' },
            { name: 'gh-issue', description: 'GitHub issue', filePath: '/skills/gh-issue/SKILL.md' },
            { name: 'alpha-skill', description: 'Alpha', filePath: '/skills/alpha-skill/SKILL.md' },
            { name: 'zeta-skill', description: 'Zeta', filePath: '/skills/zeta-skill/SKILL.md' },
            { name: 'beta-skill', description: 'Beta', filePath: '/skills/beta-skill/SKILL.md' },
        ]

        // gh-issue: 100, fix-issue: 95, beta-skill: 10, alpha-skill & zeta-skill: 0
        const items = buildSkillSuggestions({
            query: '',
            skills: sampleSkills as any,
            usageCounts: {
                'gh-issue': 100,
                'fix-issue': 95,
                'beta-skill': 10,
            },
        })

        expect(items.map((item) => item.name)).toEqual([
            'gh-issue',
            'fix-issue',
            'beta-skill',
            'alpha-skill',
            'zeta-skill',
        ])
    })

    it('preserves usage frequency ranking when searching/filtering with a query', () => {
        const sampleSkills = [
            { name: 'fix-issue', description: 'Fix issue', filePath: '/skills/fix-issue/SKILL.md' },
            { name: 'gh-issue', description: 'GitHub issue', filePath: '/skills/gh-issue/SKILL.md' },
            { name: 'issue-creator', description: 'Issue creator', filePath: '/skills/issue-creator/SKILL.md' },
            { name: 'auto-issue', description: 'Auto issue', filePath: '/skills/auto-issue/SKILL.md' },
            { name: 'unrelated', description: 'Other', filePath: '/skills/unrelated/SKILL.md' },
        ]

        // gh-issue: 100, fix-issue: 95, others: 0
        const filtered = buildSkillSuggestions({
            query: 'issue',
            skills: sampleSkills as any,
            usageCounts: {
                'gh-issue': 100,
                'fix-issue': 95,
            },
        })

        expect(filtered.map((item) => item.name)).toEqual([
            'gh-issue',
            'fix-issue',
            'auto-issue',
            'issue-creator',
        ])
    })

    it('sorts alphabetically when usage counts are identical', () => {
        const sampleSkills = [
            { name: 'zebra', description: 'Zebra', filePath: '/skills/zebra/SKILL.md' },
            { name: 'apple', description: 'Apple', filePath: '/skills/apple/SKILL.md' },
            { name: 'mango', description: 'Mango', filePath: '/skills/mango/SKILL.md' },
            { name: 'banana', description: 'Banana', filePath: '/skills/banana/SKILL.md' },
        ]

        // apple and zebra have count 50, banana and mango have count 10
        const items = buildSkillSuggestions({
            query: '',
            skills: sampleSkills as any,
            usageCounts: {
                apple: 50,
                zebra: 50,
                mango: 10,
                banana: 10,
            },
        })

        expect(items.map((item) => item.name)).toEqual([
            'apple',
            'zebra',
            'banana',
            'mango',
        ])
    })

    it('accepts usageCounts as Map or Array format with case-insensitivity', () => {
        const sampleSkills = [
            { name: 'Skill-B', description: 'B', filePath: '/skills/b/SKILL.md' },
            { name: 'Skill-A', description: 'A', filePath: '/skills/a/SKILL.md' },
        ]

        const fromMap = buildSkillSuggestions({
            query: '',
            skills: sampleSkills as any,
            usageCounts: new Map([['skill-b', 42], ['skill-a', 10]]),
        })
        expect(fromMap.map((item) => item.name)).toEqual(['Skill-B', 'Skill-A'])

        const fromArray = buildSkillSuggestions({
            query: '',
            skills: sampleSkills as any,
            usageCounts: [{ name: 'SKILL-A', count: 99 }, { name: 'SKILL-B', count: 5 }],
        })
        expect(fromArray.map((item) => item.name)).toEqual(['Skill-A', 'Skill-B'])
    })

    it('keeps the first duplicate name and uses stable ids', () => {
        const items = buildSkillSuggestions({
            query: '',
            skills: [
                { name: 'alpha', description: 'first', filePath: '/a/SKILL.md' },
                { name: 'alpha', description: 'second', filePath: '/b/SKILL.md' },
            ] as any,
        })
        expect(items).toHaveLength(1)
        expect(items[0]?.id).toBe(skillOptionId('alpha', 0))
        expect(items[0]?.description).toBe('first')
    })
})

describe('getSkillUsageCount', () => {
    it('returns 0 when usageCounts is undefined or null', () => {
        expect(getSkillUsageCount('test')).toBe(0)
        expect(getSkillUsageCount('test', undefined)).toBe(0)
    })

    it('handles record, map, and array structures with case-insensitivity', () => {
        expect(getSkillUsageCount('GH-Issue', { 'gh-issue': 100 })).toBe(100)
        expect(getSkillUsageCount('GH-Issue', new Map([['gh-issue', 100]]))).toBe(100)
        expect(getSkillUsageCount('GH-Issue', [{ name: 'gh-issue', count: 100 }])).toBe(100)
        expect(getSkillUsageCount('unknown', { 'gh-issue': 100 })).toBe(0)
    })
})

describe('scrollOptionIntoView', () => {
    function fakeBox(
        top: number,
        bottom: number,
        extras: Partial<HTMLElement> = {},
    ): HTMLElement {
        return {
            scrollTop: 0,
            getBoundingClientRect: () =>
                ({
                    top,
                    bottom,
                    left: 0,
                    right: 100,
                    width: 100,
                    height: bottom - top,
                    x: 0,
                    y: top,
                    toJSON: () => undefined,
                }) as DOMRect,
            ...extras,
        } as HTMLElement
    }

    it('scrolls down when the option is below the visible range', () => {
        const list = fakeBox(0, 80)
        const option = fakeBox(200, 232)
        scrollOptionIntoView(list, option)
        expect(list.scrollTop).toBe(152)
    })

    it('scrolls up when the option is above the visible range', () => {
        const list = fakeBox(0, 80, { scrollTop: 200 })
        const option = fakeBox(-40, -8)
        scrollOptionIntoView(list, option)
        expect(list.scrollTop).toBe(160)
    })

    it('does not move when the option is already visible', () => {
        const list = fakeBox(0, 80, { scrollTop: 40 })
        const option = fakeBox(20, 52)
        scrollOptionIntoView(list, option)
        expect(list.scrollTop).toBe(40)
    })
})

describe('SkillMenu', () => {
    const suggestions: SkillSuggestion[] = buildSkillSuggestions({
        query: '',
        skills: skills as any,
    })

    it('exposes listbox ARIA with active descendant', () => {
        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const listbox = screen.getByRole('listbox')
        expect(listbox).toHaveAttribute('aria-label', 'Skills')
        expect(listbox).toHaveAttribute(
            'aria-activedescendant',
            suggestions[1]!.id,
        )
        expect(screen.getAllByRole('option')).toHaveLength(suggestions.length)
        expect(screen.getByText('Alpha')).toBeInTheDocument()
        expect(screen.getByText('A skill')).toBeInTheDocument()
        expect(
            screen.getByText('Discovers available model capacity'),
        ).toBeInTheDocument()
        expect(screen.getAllByText('Personal').length).toBeGreaterThan(0)
        expect(screen.getByText('Project')).toBeInTheDocument()
    })

    it('wraps Up/Down and selects with Enter; Escape closes', () => {
        const onActiveIndexChange = vi.fn()
        const onSelect = vi.fn()
        const onClose = vi.fn()

        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={onSelect}
                onClose={onClose}
            />,
        )

        const listbox = screen.getByRole('listbox')
        fireEvent.keyDown(listbox, { key: 'ArrowUp' })
        expect(onActiveIndexChange).toHaveBeenCalledWith(suggestions.length - 1)

        fireEvent.keyDown(listbox, { key: 'ArrowDown' })
        expect(onActiveIndexChange).toHaveBeenCalledWith(1)

        fireEvent.keyDown(listbox, { key: 'Enter' })
        expect(onSelect).toHaveBeenCalledWith(suggestions[0])

        fireEvent.keyDown(listbox, { key: 'Escape' })
        expect(onClose).toHaveBeenCalled()
    })

    it('scrolls the active option into view when the highlight moves', () => {
        const manySkills = Array.from({ length: 20 }, (_, index) => ({
            name: `skill-${String(index).padStart(2, '0')}`,
            description: `Skill ${index}`,
            filePath: `/skills/skill-${index}/SKILL.md`,
        }))
        const many = buildSkillSuggestions({ query: '', skills: manySkills as any })
        const { rerender } = render(
            <SkillMenu
                suggestions={many}
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const listbox = screen.getByRole('listbox')
        const last = screen.getByRole('option', { name: /skill 19/i })
        Object.defineProperty(listbox, 'clientHeight', { configurable: true, value: 80 })
        vi.spyOn(listbox, 'getBoundingClientRect').mockReturnValue({
            top: 0,
            bottom: 80,
            left: 0,
            right: 100,
            width: 100,
            height: 80,
            x: 0,
            y: 0,
            toJSON: () => undefined,
        })
        vi.spyOn(last, 'getBoundingClientRect').mockReturnValue({
            top: 400,
            bottom: 432,
            left: 0,
            right: 100,
            width: 100,
            height: 32,
            x: 0,
            y: 400,
            toJSON: () => undefined,
        })

        rerender(
            <SkillMenu
                suggestions={many}
                activeIndex={many.length - 1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        expect(listbox.scrollTop).toBe(352)
    })

    it('selects on mousedown without requiring focus', () => {
        const onActiveIndexChange = vi.fn()
        const onSelect = vi.fn()
        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={onSelect}
                onClose={() => undefined}
            />,
        )

        fireEvent.mouseDown(screen.getByRole('option', { name: /alpha/i }))
        expect(onActiveIndexChange).toHaveBeenCalledWith(0)
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'alpha' }),
        )
    })

    it('does not change active index on mouse enter', () => {
        const onActiveIndexChange = vi.fn()
        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const options = screen.getAllByRole('option')
        fireEvent.mouseEnter(options[1]!)
        expect(onActiveIndexChange).not.toHaveBeenCalled()
    })
})

describe('resolveVerticalMenuPlacement', () => {
    it('prefers below when there is enough space under the anchor', () => {
        expect(
            resolveVerticalMenuPlacement(
                { top: 80, bottom: 140 },
                800,
                { preferred: 'below' },
            ),
        ).toEqual({
            placement: 'below',
            maxHeight: 288,
        })
    })

    it('flips above when below space is tight and above has more room', () => {
        expect(
            resolveVerticalMenuPlacement(
                { top: 520, bottom: 760 },
                800,
                { preferred: 'below' },
            ),
        ).toEqual({
            placement: 'above',
            maxHeight: 288,
        })
    })

    it('caps maxHeight to the available viewport side', () => {
        expect(
            resolveVerticalMenuPlacement(
                { top: 40, bottom: 100 },
                180,
                { preferred: 'below' },
            ).maxHeight,
        ).toBe(96)
    })
})

describe('SkillMenu placement', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const suggestions: SkillSuggestion[] = [
        {
            id: 'opt-0-gh-issue',
            name: 'gh-issue',
            displayName: 'Gh Issue',
            description: 'Triage GitHub issues',
            insertText: '$gh-issue ',
            source: 'personal',
        },
    ]

    it('opens below when the anchor sits near the top of the viewport', () => {
        const parent = document.createElement('div')
        parent.style.position = 'relative'
        document.body.appendChild(parent)
        vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
            top: 40,
            bottom: 120,
            left: 0,
            right: 400,
            width: 400,
            height: 80,
            x: 0,
            y: 40,
            toJSON: () => ({}),
        })

        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
            { container: parent },
        )

        const menu = screen.getByTestId('skill-menu')
        expect(menu).toHaveAttribute('data-placement', 'below')
        expect(menu.className).toContain('top-full')
        parent.remove()
    })

    it('opens above when the anchor sits near the bottom of the viewport', () => {
        const parent = document.createElement('div')
        parent.style.position = 'relative'
        document.body.appendChild(parent)
        vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
        vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
            top: 640,
            bottom: 760,
            left: 0,
            right: 400,
            width: 400,
            height: 120,
            x: 0,
            y: 640,
            toJSON: () => ({}),
        })

        render(
            <SkillMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
            { container: parent },
        )

        const menu = screen.getByTestId('skill-menu')
        expect(menu).toHaveAttribute('data-placement', 'above')
        expect(menu.className).toContain('bottom-full')
        parent.remove()
    })
})
