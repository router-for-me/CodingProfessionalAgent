import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry, ModelReasoningOption } from '@cpa/plugin-api'
import { QuickModelPicker } from './QuickModelPicker.js'

const mockModels: ModelCatalogEntry[] = [
    {
        id: 'gpt-5.6-sol',
        label: 'GPT 5.6 Sol',
        description: 'Latest frontier agentic coding model.',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
    {
        id: 'gpt-5.6-terra',
        label: 'GPT 5.6 Terra',
        description: 'Balanced agentic coding model for everyday work.',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
    {
        id: 'claude-opus-4.6',
        label: 'Claude Opus 4.6 (Thinking)',
        description: 'Claude Opus 4.6 (Thinking)',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
    },
]

describe('QuickModelPicker', () => {
    it('renders list of models with names and descriptions', () => {
        render(
            <QuickModelPicker
                models={mockModels}
                currentModelId="gpt-5.6-terra"
                activeIndex={0}
                onActiveIndexChange={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />,
        )

        expect(screen.getByText('GPT 5.6 Sol')).toBeInTheDocument()
        expect(
            screen.getByText('Latest frontier agentic coding model.'),
        ).toBeInTheDocument()
        expect(screen.getByText('GPT 5.6 Terra')).toBeInTheDocument()
        expect(
            screen.getByText('Balanced agentic coding model for everyday work.'),
        ).toBeInTheDocument()
        expect(
            screen.getAllByText('Claude Opus 4.6 (Thinking)')[0],
        ).toBeInTheDocument()
    })

    it('shows empty state when no models match filter', () => {
        render(
            <QuickModelPicker
                models={[]}
                currentModelId="gpt-5.6-terra"
                activeIndex={0}
                onActiveIndexChange={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />,
        )

        expect(screen.getByText(/No matching models found/i)).toBeInTheDocument()
    })

    it('calls onSelect when clicking a model row', () => {
        const onSelect = vi.fn()
        render(
            <QuickModelPicker
                models={mockModels}
                currentModelId="gpt-5.6-terra"
                activeIndex={0}
                onActiveIndexChange={vi.fn()}
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const option = screen.getByRole('option', { name: /GPT 5\.6 Sol/ })
        fireEvent.mouseDown(option)

        expect(onSelect).toHaveBeenCalledWith(mockModels[0])
    })

    it('calls onActiveIndexChange when hovering over a model row', () => {
        const onActiveIndexChange = vi.fn()
        render(
            <QuickModelPicker
                models={mockModels}
                currentModelId="gpt-5.6-terra"
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />,
        )

        const secondOption = screen.getByRole('option', {
            name: /GPT 5\.6 Terra/,
        })
        fireEvent.mouseEnter(secondOption)

        expect(onActiveIndexChange).toHaveBeenCalledWith(2)
    })

    it('renders models sorted alphabetically by name', () => {
        render(
            <QuickModelPicker
                models={mockModels}
                currentModelId="gpt-5.6-terra"
                activeIndex={0}
                onActiveIndexChange={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />,
        )

        const options = screen.getAllByRole('option')
        expect(options.map((opt) => opt.textContent)).toEqual([
            expect.stringContaining('Claude Opus 4.6 (Thinking)'),
            expect.stringContaining('GPT 5.6 Sol'),
            expect.stringContaining('GPT 5.6 Terra'),
        ])
    })

    it('groups Gemini 4 models into a single Gemini 4 option when enableGemini4Grouping is true', () => {
        const onOpenGemini4Group = vi.fn()
        const withGemini4: ModelCatalogEntry[] = [
            ...mockModels,
            {
                id: 'gemini-4-argon-high',
                label: 'Gemini 4 Argon',
                supportsFast: false,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                    { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
                    { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
                ] satisfies ModelReasoningOption[],
                input: ['text'],
                contextWindow: 1_000_000,
                maxTokens: 65_536,
            },
            {
                id: 'gemini-4-carbon-high',
                label: 'Gemini 4 Carbon',
                supportsFast: false,
                reasoningLevels: [
                    { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
                    { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
                    { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
                ] satisfies ModelReasoningOption[],
                input: ['text'],
                contextWindow: 1_000_000,
                maxTokens: 65_536,
            },
        ]

        render(
            <QuickModelPicker
                models={withGemini4}
                currentModelId="gemini-4-argon-high"
                activeIndex={0}
                onActiveIndexChange={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                enableGemini4Grouping
                onOpenGemini4Group={onOpenGemini4Group}
            />,
        )

        const geminiOption = screen.getByRole('option', { name: /Gemini 4/i })
        expect(geminiOption).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Gemini 4 Argon' })).not.toBeInTheDocument()
        expect(screen.queryByRole('option', { name: 'Gemini 4 Carbon' })).not.toBeInTheDocument()

        fireEvent.mouseDown(geminiOption)
        expect(onOpenGemini4Group).toHaveBeenCalledTimes(1)
    })
})
