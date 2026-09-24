import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    buildSlashSuggestions,
    buildSlashSuggestionsWithDiagnostics,
    slashOptionId,
    SlashMenu,
    type SlashSuggestion,
} from './SlashMenu.js'

const skills = [
    {
        name: 'zeta',
        description: 'Z skill',
        filePath: '/a/skills/zeta/SKILL.md',
        baseDir: '/a/skills/zeta',
        disableModelInvocation: false,
        body: 'zeta body',
    },
    {
        name: 'alpha',
        description: 'A skill',
        filePath: '/a/skills/alpha/SKILL.md',
        baseDir: '/a/skills/alpha',
        disableModelInvocation: true,
        body: 'alpha body',
    },
] as const

const prompts = [
    {
        name: 'review',
        description: 'Review template',
        content: 'Review $1',
        filePath: '/a/prompts/review.md',
    },
    {
        name: 'draft',
        description: 'Draft template',
        content: 'Draft',
        filePath: '/a/prompts/draft.md',
    },
] as const

describe('buildSlashSuggestions', () => {
    it('includes compact, model, and templates in deterministic order, without skills', () => {
        const items = buildSlashSuggestions({
            query: '',
            skills: skills as any,
            prompts: prompts as any,
            compactDescription: 'Compact context',
        })

        expect(items.map((item) => item.command)).toEqual([
            '/compact',
            '/model',
            '/draft',
            '/review',
        ])
        expect(items.some((item) => item.group === 'skill')).toBe(false)
        expect(items.some((item) => item.command.startsWith('/skill:'))).toBe(false)
    })

    it('filters by the current slash token and keeps group order', () => {
        const items = buildSlashSuggestions({
            query: 'c',
            skills: skills as any,
            prompts: prompts as any,
            compactDescription: 'Compact context',
        })
        expect(items.map((item) => item.command)).toEqual(['/compact'])

        const draftItems = buildSlashSuggestions({
            query: 'd',
            skills: skills as any,
            prompts: prompts as any,
            compactDescription: 'Compact context',
        })
        expect(draftItems.map((item) => item.command)).toEqual(['/draft'])
    })

    it('does not list skills for skill: prefix queries', () => {
        const items = buildSlashSuggestions({
            query: 'skill:z',
            skills: skills as any,
            prompts: prompts as any,
            compactDescription: 'Compact context',
        })
        expect(items).toEqual([])
    })

    it('first-wins: builtin /compact hides same-name template', () => {
        const { suggestions, diagnostics } = buildSlashSuggestionsWithDiagnostics({
            query: '',
            skills: [
                {
                    name: 'ship',
                    description: 'skill ship',
                    disableModelInvocation: false,
                },
            ] as any,
            prompts: [
                { name: 'compact', description: 'template compact' },
                { name: 'ship', description: 'template ship' },
            ],
            compactDescription: 'Compact context',
        })
        const commands = suggestions.map((item) => item.command)
        expect(commands).toEqual(['/compact', '/model', '/ship'])
        expect(commands).not.toContain('/skill:ship')
        expect(commands.filter((c) => c === '/compact')).toHaveLength(1)
        expect(diagnostics.some((d) => d.includes('compact') && d.includes('template'))).toBe(
            true,
        )
    })

    it('uses stable escaped option ids with group+index', () => {
        const items = buildSlashSuggestions({
            query: '',
            skills: [{ name: 'Foo Bar', description: 'x', disableModelInvocation: false }] as any,
            prompts: [{ name: 'Foo Bar', description: 'template' }],
            compactDescription: 'c',
        })
        expect(items[0]?.id).toBe(slashOptionId('builtin', 'compact', 0))
        expect(items[1]?.id).toBe(slashOptionId('builtin', 'model', 1))
        expect(items[2]?.id).toBe(slashOptionId('template', 'Foo Bar', 2))
        expect(items[2]?.id).toMatch(/^slash-option-template-2-/)
        expect(items[2]?.id).not.toMatch(/\s/)
        expect(items[0]?.id).not.toBe(items[1]?.id)
    })

    it('supports localized command names and cross-language alias queries', () => {
        const zhItems = buildSlashSuggestions({
            query: '',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })

        expect(zhItems.map((item) => item.command)).toEqual(['/压缩', '/模型'])

        // Querying with Chinese prefix
        const matchZhCompact = buildSlashSuggestions({
            query: '压',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchZhCompact.map((item) => item.command)).toEqual(['/压缩'])

        // Querying with English alias "compact" in Chinese locale
        const matchEnCompactInZh = buildSlashSuggestions({
            query: 'compact',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchEnCompactInZh.map((item) => item.command)).toEqual(['/压缩'])

        // Querying with English prefix "comp"
        const matchEnPrefixInZh = buildSlashSuggestions({
            query: 'comp',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchEnPrefixInZh.map((item) => item.command)).toEqual(['/压缩'])

        // Querying with Chinese prefix "模" for model
        const matchZhModel = buildSlashSuggestions({
            query: '模',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchZhModel.map((item) => item.command)).toEqual(['/模型'])

        // Querying with English alias "model" for model in Chinese locale
        const matchEnModelInZh = buildSlashSuggestions({
            query: 'model',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchEnModelInZh.map((item) => item.command)).toEqual(['/模型'])

        // Querying with English prefix "mod"
        const matchEnModPrefixInZh = buildSlashSuggestions({
            query: 'mod',
            skills: [],
            prompts: [],
            compactName: '压缩',
            compactDescription: '压缩对话上下文',
            modelName: '模型',
            modelDescription: '打开模型选择器',
        })
        expect(matchEnModPrefixInZh.map((item) => item.command)).toEqual(['/模型'])
    })
})

describe('SlashMenu', () => {
    const suggestions: SlashSuggestion[] = buildSlashSuggestions({
        query: '',
        skills: skills as any,
        prompts: prompts as any,
        compactDescription: 'Compact context',
    })

    it('exposes listbox ARIA with active descendant', () => {
        render(
            <SlashMenu
                suggestions={suggestions}
                activeIndex={1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const listbox = screen.getByRole('listbox')
        expect(listbox).toHaveAttribute(
            'aria-activedescendant',
            suggestions[1]!.id,
        )
        expect(screen.getAllByRole('option')).toHaveLength(suggestions.length)
    })

    it('wraps Up/Down and selects with Enter; Escape closes', () => {
        const onActiveIndexChange = vi.fn()
        const onSelect = vi.fn()
        const onClose = vi.fn()

        render(
            <SlashMenu
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

    it('selects on mousedown without requiring focus (no blur loss)', () => {
        const onSelect = vi.fn()
        render(
            <SlashMenu
                suggestions={suggestions}
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={onSelect}
                onClose={() => undefined}
            />,
        )

        const option = screen.getByRole('option', { name: /\/compact/i })
        fireEvent.mouseDown(option)
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ command: '/compact' }),
        )
    })

    it('supports Tab to select the active suggestion when enabled', () => {
        const onSelect = vi.fn()
        render(
            <SlashMenu
                suggestions={suggestions}
                activeIndex={2}
                onActiveIndexChange={() => undefined}
                onSelect={onSelect}
                onClose={() => undefined}
            />,
        )
        fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Tab' })
        expect(onSelect).toHaveBeenCalledWith(suggestions[2])
    })
})
