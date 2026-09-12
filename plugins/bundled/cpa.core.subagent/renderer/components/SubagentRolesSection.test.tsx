import i18n from '@/i18n'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentRolesSection } from './SubagentRolesSection.js'
import type { SubagentRole } from '@cpa/plugin-api'

const sampleRoles: SubagentRole[] = [
    {
        id: 'r1',
        name: 'Reviewer',
        description: 'Performs deep code reviews',
        modelId: 'claude-sonnet-4-6',
        reasoningEffort: 'high',
    },
    {
        id: 'r2',
        name: 'Planner',
        description: 'Drafts technical execution plans',
        modelId: 'gpt-5.5',
        reasoningEffort: 'low',
    },
]

describe('SubagentRolesSection', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('renders role section header, subtitle, and existing role cards', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        expect(screen.getByText('Subagent Roles')).toBeInTheDocument()
        expect(
            screen.getByText(
                'Configure specialized subagent roles with dedicated prompts, models, and reasoning depth.'
            )
        ).toBeInTheDocument()

        // Verify that Bot icon is removed from the role cards
        expect(screen.queryByTestId('role-bot-icon')).toBeNull()

        expect(screen.getByDisplayValue('Reviewer')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Performs deep code reviews')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Planner')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Drafts technical execution plans')).toBeInTheDocument()

        // Verify that native <select> elements are never used
        expect(document.querySelector('select')).toBeNull()
    })

    it('renders empty state when role list is empty and allows adding first role', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={[]} onChange={onChange} />)

        expect(screen.getByTestId('roles-empty-state')).toBeInTheDocument()
        expect(screen.getByText('No Roles Configured')).toBeInTheDocument()

        const addButton = screen.getByRole('button', { name: 'Add Role' })
        fireEvent.click(addButton)

        expect(onChange).toHaveBeenCalledTimes(1)
        const updatedRoles: SubagentRole[] = onChange.mock.calls[0][0]
        expect(updatedRoles).toHaveLength(1)
        expect(updatedRoles[0].name).toBe('')
        expect(updatedRoles[0].reasoningEffort).toBe('default')
    })

    it('allows updating role name and description', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        const nameInput = screen.getByDisplayValue('Reviewer')
        fireEvent.change(nameInput, { target: { value: 'Security Specialist' } })

        expect(onChange).toHaveBeenCalledWith([
            { ...sampleRoles[0], name: 'Security Specialist' },
            sampleRoles[1],
        ])

        const descTextarea = screen.getByDisplayValue('Performs deep code reviews')
        fireEvent.change(descTextarea, {
            target: { value: 'Audits vulnerabilities and tokens' },
        })

        expect(onChange).toHaveBeenCalledWith([
            { ...sampleRoles[0], description: 'Audits vulnerabilities and tokens' },
            sampleRoles[1],
        ])
    })

    it('allows deleting a specific role by id', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        const deleteButtons = screen.getAllByRole('button', { name: 'Delete Role' })
        expect(deleteButtons).toHaveLength(2)

        fireEvent.click(deleteButtons[0])

        expect(onChange).toHaveBeenCalledWith([sampleRoles[1]])
    })

    it('allows adding a new role when existing roles are present', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        const addRoleButton = screen.getByRole('button', { name: 'Add Role' })
        fireEvent.click(addRoleButton)

        expect(onChange).toHaveBeenCalledTimes(1)
        const updated = onChange.mock.calls[0][0]
        expect(updated).toHaveLength(3)
        expect(updated[0]).toEqual(sampleRoles[0])
        expect(updated[1]).toEqual(sampleRoles[1])
        expect(updated[2].id).toBeDefined()
    })

    it('opens searchable model dropdown and filters options based on search query', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        const modelComboboxes = screen.getAllByRole('combobox', { name: 'Model' })
        expect(modelComboboxes.length).toBeGreaterThan(0)

        // Open model dropdown
        fireEvent.click(modelComboboxes[0])

        // Search input should be present in the dropdown menu
        const searchInput = screen.getByPlaceholderText('Search model...')
        expect(searchInput).toBeInTheDocument()

        // Type to search
        fireEvent.change(searchInput, { target: { value: 'Claude' } })
        const listbox = screen.getByRole('listbox')
        expect(within(listbox).getByText('Claude Sonnet 4.6')).toBeInTheDocument()

        // Unmatched options should be filtered out
        expect(within(listbox).queryByText('GPT 5.5')).toBeNull()
    })

    it('dynamically computes reasoning effort options based on model configuration', () => {
        const onChange = vi.fn()
        render(<SubagentRolesSection roles={sampleRoles} onChange={onChange} />)

        const reasoningComboboxes = screen.getAllByRole('combobox', { name: 'Reasoning Effort' })
        expect(reasoningComboboxes.length).toBeGreaterThan(0)

        // Click reasoning dropdown for role 1
        fireEvent.click(reasoningComboboxes[0])

        // Options should include Determined by model and standard levels
        expect(screen.getByRole('option', { name: 'Determined by model' })).toBeInTheDocument()
        expect(screen.getByRole('option', { name: 'High' })).toBeInTheDocument()
    })
})
