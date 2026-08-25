import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SubagentsSection } from './SubagentsSection.js'

describe('SubagentsSection', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
        window.localStorage.clear()
    })

    it('renders header, description, and default controls', () => {
        render(<SubagentsSection />)

        expect(screen.getByRole('heading', { level: 1, name: 'Subagents' })).toBeInTheDocument()
        expect(
            screen.getByText('Configure subagent activation, maximum concurrency, and execution depth.')
        ).toBeInTheDocument()

        const toggle = screen.getByRole('switch', { name: 'Subagents' })
        expect(toggle).toBeInTheDocument()
        expect(toggle).toHaveAttribute('aria-checked', 'true')

        const concurrencyInput = screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })
        expect(concurrencyInput).toBeInTheDocument()
        expect(concurrencyInput).toHaveValue(10)

        const maxPerSessionInput = screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })
        expect(maxPerSessionInput).toBeInTheDocument()
        expect(maxPerSessionInput).toHaveValue(3)

        const maxDepthInput = screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })
        expect(maxDepthInput).toBeInTheDocument()
        expect(maxDepthInput).toHaveValue(1)
    })

    it('hides child inputs when toggle is switched off and shows them when switched back on', () => {
        render(<SubagentsSection />)

        const toggle = screen.getByRole('switch', { name: 'Subagents' })
        expect(toggle).toHaveAttribute('aria-checked', 'true')

        // Click toggle to disable
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-checked', 'false')

        // Child inputs should be hidden
        expect(screen.queryByRole('spinbutton', { name: 'Global Concurrent Subagents' })).toBeNull()
        expect(screen.queryByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })).toBeNull()
        expect(screen.queryByRole('spinbutton', { name: 'Maximum Subagent Depth' })).toBeNull()

        // Click toggle to re-enable
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })).toBeInTheDocument()
    })

    it('updates concurrency, maxPerSession, and maxDepth values and persists to localStorage', () => {
        render(<SubagentsSection />)

        const concurrencyInput = screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })
        fireEvent.change(concurrencyInput, { target: { value: '15' } })
        fireEvent.blur(concurrencyInput)
        expect(concurrencyInput).toHaveValue(15)

        const maxPerSessionInput = screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })
        fireEvent.change(maxPerSessionInput, { target: { value: '5' } })
        fireEvent.blur(maxPerSessionInput)
        expect(maxPerSessionInput).toHaveValue(5)

        const maxDepthInput = screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })
        fireEvent.change(maxDepthInput, { target: { value: '2' } })
        fireEvent.blur(maxDepthInput)
        expect(maxDepthInput).toHaveValue(2)

        const stored = JSON.parse(window.localStorage.getItem('cpa.settings.subagents') || '{}')
        expect(stored.enabled).toBe(true)
        expect(stored.concurrency).toBe(15)
        expect(stored.maxPerSession).toBe(5)
        expect(stored.maxDepth).toBe(2)
    })

    it('clamps concurrency and maxDepth within valid bounds', () => {
        render(<SubagentsSection />)

        const concurrencyInput = screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })
        fireEvent.change(concurrencyInput, { target: { value: '999' } })
        fireEvent.blur(concurrencyInput)
        expect(concurrencyInput).toHaveValue(50)

        fireEvent.change(concurrencyInput, { target: { value: '-5' } })
        fireEvent.blur(concurrencyInput)
        expect(concurrencyInput).toHaveValue(1)

        const maxDepthInput = screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })
        fireEvent.change(maxDepthInput, { target: { value: '50' } })
        fireEvent.blur(maxDepthInput)
        expect(maxDepthInput).toHaveValue(10)

        fireEvent.change(maxDepthInput, { target: { value: '0' } })
        fireEvent.blur(maxDepthInput)
        expect(maxDepthInput).toHaveValue(1)
    })

    it('restores initial values from localStorage if available', () => {
        window.localStorage.setItem(
            'cpa.settings.subagents',
            JSON.stringify({
                enabled: true,
                concurrency: 18,
                maxPerSession: 6,
                maxDepth: 4,
            })
        )

        render(<SubagentsSection />)

        expect(screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })).toHaveValue(18)
        expect(screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })).toHaveValue(6)
        expect(screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })).toHaveValue(4)
    })

    it('increments and decrements values via keyboard ArrowUp and ArrowDown keys without spinner buttons', () => {
        render(<SubagentsSection />)

        const concurrencyInput = screen.getByRole('spinbutton', { name: 'Global Concurrent Subagents' })
        expect(concurrencyInput).toHaveValue(10)
        // Verify spinner hiding classes
        expect(concurrencyInput.className).toContain('[appearance:textfield]')
        expect(concurrencyInput.className).toContain('[&::-webkit-inner-spin-button]:appearance-none')
        expect(concurrencyInput.className).toContain('w-[72px]')

        // ArrowUp increments
        fireEvent.keyDown(concurrencyInput, { key: 'ArrowUp' })
        expect(concurrencyInput).toHaveValue(11)

        fireEvent.keyDown(concurrencyInput, { key: 'ArrowUp' })
        expect(concurrencyInput).toHaveValue(12)

        // ArrowDown decrements
        fireEvent.keyDown(concurrencyInput, { key: 'ArrowDown' })
        expect(concurrencyInput).toHaveValue(11)

        // Enter key blurs input
        fireEvent.keyDown(concurrencyInput, { key: 'Enter' })

        // Check maxPerSession with arrow keys
        const maxPerSessionInput = screen.getByRole('spinbutton', { name: 'Maximum Concurrent Subagents per Session' })
        expect(maxPerSessionInput).toHaveValue(3)
        fireEvent.keyDown(maxPerSessionInput, { key: 'ArrowUp' })
        expect(maxPerSessionInput).toHaveValue(4)
        fireEvent.keyDown(maxPerSessionInput, { key: 'ArrowDown' })
        expect(maxPerSessionInput).toHaveValue(3)

        // Check maxDepth with arrow keys
        const maxDepthInput = screen.getByRole('spinbutton', { name: 'Maximum Subagent Depth' })
        expect(maxDepthInput).toHaveValue(1)
        fireEvent.keyDown(maxDepthInput, { key: 'ArrowUp' })
        expect(maxDepthInput).toHaveValue(2)
        fireEvent.keyDown(maxDepthInput, { key: 'ArrowDown' })
        expect(maxDepthInput).toHaveValue(1)
        // Below min should remain 1
        fireEvent.keyDown(maxDepthInput, { key: 'ArrowDown' })
        expect(maxDepthInput).toHaveValue(1)
    })
})
