import { fireEvent, render, screen } from '@testing-library/react'
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
})
