import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { ModelOptionsMenu } from './ModelOptionsMenu.js'

const testModels: ModelCatalogEntry[] = [
    {
        id: 'gpt-4o',
        label: 'GPT-4o',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
    {
        id: 'claude-3-7-sonnet',
        label: 'Claude 3.7 Sonnet',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
    {
        id: 'claude-3-5-sonnet',
        label: 'Claude 3.5 Sonnet',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
    {
        id: 'fallback-no-label',
        label: '',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
]

describe('ModelOptionsMenu', () => {
    it('renders models sorted by name with fallback to id', () => {
        render(
            <ModelOptionsMenu
                models={testModels}
                modelId="claude-3-7-sonnet"
                onSelect={vi.fn()}
            />,
        )

        const items = screen.getAllByRole('menuitemradio')
        expect(items.map((item) => item.textContent)).toEqual([
            'Claude 3.5 Sonnet',
            'Claude 3.7 Sonnet',
            'fallback-no-label',
            'GPT-4o',
        ])
    })

    it('calls onSelect when clicking a model item', () => {
        const onSelect = vi.fn()
        render(
            <ModelOptionsMenu
                models={testModels}
                modelId="claude-3-7-sonnet"
                onSelect={onSelect}
            />,
        )

        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Claude 3.5 Sonnet' }))
        expect(onSelect).toHaveBeenCalledWith('claude-3-5-sonnet')
    })

    it('renders empty message when no models provided', () => {
        render(
            <ModelOptionsMenu
                models={[]}
                modelId="claude-3-7-sonnet"
                onSelect={vi.fn()}
            />,
        )

        expect(screen.getByText(/No models/i)).toBeInTheDocument()
    })

    it('groups Gemini 4 models into a single Gemini 4 menuitem when enableGemini4Grouping is true and flattens when false', () => {
        const mixedModels: ModelCatalogEntry[] = [
            ...testModels,
            {
                id: 'gemini-4-argon-high',
                label: 'Gemini 4 Argon',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
            {
                id: 'gemini-4-carbon-high',
                label: 'Gemini 4 Carbon',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
        ]
        const onOpenGemini4Group = vi.fn()
        const { rerender } = render(
            <ModelOptionsMenu
                models={mixedModels}
                modelId="gemini-4-argon-high"
                enableGemini4Grouping
                onOpenGemini4Group={onOpenGemini4Group}
                onSelect={vi.fn()}
            />,
        )

        const gemini4GroupItem = screen.getByRole('menuitem', { name: /Gemini 4/i })
        expect(gemini4GroupItem).toBeInTheDocument()
        expect(screen.queryByRole('menuitemradio', { name: 'Gemini 4 Argon' })).not.toBeInTheDocument()
        expect(screen.queryByRole('menuitemradio', { name: 'Gemini 4 Carbon' })).not.toBeInTheDocument()

        fireEvent.click(gemini4GroupItem)
        expect(onOpenGemini4Group).toHaveBeenCalledTimes(1)

        rerender(
            <ModelOptionsMenu
                models={mixedModels}
                modelId="gemini-4-argon-high"
                enableGemini4Grouping={false}
                onOpenGemini4Group={onOpenGemini4Group}
                onSelect={vi.fn()}
            />,
        )

        expect(screen.queryByRole('menuitem', { name: /Gemini 4/i })).not.toBeInTheDocument()
        expect(screen.getByRole('menuitemradio', { name: 'Gemini 4 Argon' })).toBeInTheDocument()
        expect(screen.getByRole('menuitemradio', { name: 'Gemini 4 Carbon' })).toBeInTheDocument()
    })

    it('shows released element count badge and keeps numeric sorting position relative to Gemini 10', () => {
        const modelsWithTen: ModelCatalogEntry[] = [
            ...testModels,
            {
                id: 'gemini-10-pro',
                label: 'Gemini 10 Pro',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
            {
                id: 'gemini-4-argon-high',
                label: 'Gemini 4 Argon',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
            {
                id: 'gemini-4-carbon-high',
                label: 'Gemini 4 Carbon',
                supportsFast: false,
                reasoningLevels: [],
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 4096,
            },
        ]
        render(
            <ModelOptionsMenu
                models={modelsWithTen}
                modelId="gpt-4o"
                enableGemini4Grouping
                onOpenGemini4Group={vi.fn()}
                onSelect={vi.fn()}
            />,
        )

        const groupItem = screen.getByRole('menuitem', { name: /Gemini 4/i })
        expect(within(groupItem).getByTestId('gemini4-group-released-count')).toHaveTextContent('2')
        const allLabels = Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).map((el) => el.textContent)
        const idx4 = allLabels.findIndex((text) => text?.includes('Gemini 4'))
        const idx10 = allLabels.findIndex((text) => text?.includes('Gemini 10 Pro'))
        expect(idx4).toBeGreaterThan(-1)
        expect(idx10).toBeGreaterThan(idx4)
    })
})
