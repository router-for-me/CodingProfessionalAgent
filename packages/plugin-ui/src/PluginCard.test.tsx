import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
    PluginCard,
    PluginCardHeader,
    PluginCardTitle,
    PluginCardBody,
    PluginCardFooter,
    PluginCardBadge,
} from './PluginCard.js'

describe('PluginCard', () => {
    it('renders card primitives with default structure and styling', () => {
        render(
            <PluginCard data-testid="plugin-card">
                <PluginCardHeader>
                    <PluginCardTitle>Card Title</PluginCardTitle>
                    <PluginCardBadge>Status</PluginCardBadge>
                </PluginCardHeader>
                <PluginCardBody>Card Body Content</PluginCardBody>
                <PluginCardFooter>Card Footer</PluginCardFooter>
            </PluginCard>,
        )

        expect(screen.getByTestId('plugin-card')).toBeInTheDocument()
        expect(screen.getByText('Card Title')).toBeInTheDocument()
        expect(screen.getByText('Status')).toBeInTheDocument()
        expect(screen.getByText('Card Body Content')).toBeInTheDocument()
        expect(screen.getByText('Card Footer')).toBeInTheDocument()
    })

    it('supports elevated and subtle variants', () => {
        const { rerender } = render(
            <PluginCard variant="elevated" data-testid="card">Elevated</PluginCard>,
        )
        expect(screen.getByTestId('card').className).toContain('bg-[var(--bg-elevated)]')

        rerender(<PluginCard variant="subtle" data-testid="card">Subtle</PluginCard>)
        expect(screen.getByTestId('card').className).toContain('bg-[var(--bg-app)]')
    })
})
