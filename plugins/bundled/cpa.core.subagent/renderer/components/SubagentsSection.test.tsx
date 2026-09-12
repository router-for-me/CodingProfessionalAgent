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

    it('renders Roles section with title, subtitle, and default roles', () => {
        render(<SubagentsSection />)

        expect(screen.getByText('Subagent Roles')).toBeInTheDocument()
        expect(
            screen.getByText(
                'Configure specialized subagent roles with dedicated prompts, models, and reasoning depth.'
            )
        ).toBeInTheDocument()

        const addRoleButton = screen.getByRole('button', { name: 'Add Role' })
        expect(addRoleButton).toBeInTheDocument()

        // Verify default roles are rendered
        expect(screen.getByDisplayValue('Code Reviewer')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Debugger')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Architect')).toBeInTheDocument()

        // Strict UI constraint: Never use native <select> element
        expect(document.querySelector('select')).toBeNull()
    })

    it('allows adding a new role to the list', () => {
        render(<SubagentsSection />)

        const addRoleButton = screen.getByRole('button', { name: 'Add Role' })
        const initialCards = screen.getAllByTestId(/^role-card-/)
        expect(initialCards).toHaveLength(3)

        fireEvent.click(addRoleButton)

        const cardsAfter = screen.getAllByTestId(/^role-card-/)
        expect(cardsAfter).toHaveLength(4)

        const stored = JSON.parse(window.localStorage.getItem('cpa.settings.subagents') || '{}')
        expect(stored.roles).toHaveLength(4)
    })

    it('allows editing role name and description and saves to localStorage', () => {
        render(<SubagentsSection />)

        const nameInput = screen.getByDisplayValue('Code Reviewer')
        fireEvent.change(nameInput, { target: { value: 'Senior Security Auditor' } })
        expect(nameInput).toHaveValue('Senior Security Auditor')

        const descTextarea = screen.getByDisplayValue(
            'Reviews code changes for security, logic defects, edge cases, and best practices.'
        )
        fireEvent.change(descTextarea, {
            target: { value: 'Audits vulnerabilities, tokens, and compliance.' },
        })
        expect(descTextarea).toHaveValue('Audits vulnerabilities, tokens, and compliance.')

        const stored = JSON.parse(window.localStorage.getItem('cpa.settings.subagents') || '{}')
        expect(stored.roles[0].name).toBe('Senior Security Auditor')
        expect(stored.roles[0].description).toBe(
            'Audits vulnerabilities, tokens, and compliance.'
        )
    })

    it('allows deleting roles and shows empty state when all roles are removed', () => {
        render(<SubagentsSection />)

        let deleteButtons = screen.getAllByRole('button', { name: 'Delete Role' })
        expect(deleteButtons).toHaveLength(3)

        // Delete all 3 roles
        fireEvent.click(deleteButtons[0])
        deleteButtons = screen.getAllByRole('button', { name: 'Delete Role' })
        expect(deleteButtons).toHaveLength(2)

        fireEvent.click(deleteButtons[0])
        deleteButtons = screen.getAllByRole('button', { name: 'Delete Role' })
        expect(deleteButtons).toHaveLength(1)

        fireEvent.click(deleteButtons[0])

        // Empty state should be visible
        expect(screen.getByTestId('roles-empty-state')).toBeInTheDocument()
        expect(screen.getByText('No Roles Configured')).toBeInTheDocument()

        const addRoleButton = screen.getByRole('button', { name: 'Add Role' })
        fireEvent.click(addRoleButton)

        expect(screen.queryByTestId('roles-empty-state')).toBeNull()
        expect(screen.getAllByTestId(/^role-card-/)).toHaveLength(1)
    })
})
