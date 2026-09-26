import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CustomSelect } from './CustomSelect.js'
import { WorkspaceVisibilityProvider } from './WorkspaceVisibility.js'

describe('workspace visibility', () => {
    it('hides a portaled select menu without closing it or hiding settings menus', () => {
        const renderWorkspace = (visible: boolean) => (
            <>
                <WorkspaceVisibilityProvider visible={visible}>
                    <div style={{ display: visible ? undefined : 'none' }}>
                        <CustomSelect
                            value="first"
                            options={[{ value: 'first', label: 'First' }]}
                            onChange={() => undefined}
                            ariaLabel="Workspace select"
                        />
                    </div>
                </WorkspaceVisibilityProvider>
                <CustomSelect
                    value="other"
                    options={[{ value: 'other', label: 'Other' }]}
                    onChange={() => undefined}
                    ariaLabel="Settings select"
                />
            </>
        )
        const { rerender } = render(renderWorkspace(true))
        fireEvent.click(screen.getByRole('combobox', { name: 'Workspace select' }))
        fireEvent.click(screen.getByRole('combobox', { name: 'Settings select' }))
        expect(screen.getByRole('listbox', { name: 'Workspace select' })).toBeVisible()
        expect(screen.getByRole('listbox', { name: 'Settings select' })).toBeVisible()

        rerender(renderWorkspace(false))
        expect(screen.queryByRole('listbox', { name: 'Workspace select' })).not.toBeInTheDocument()
        expect(screen.getByRole('listbox', { name: 'Settings select' })).toBeVisible()

        rerender(renderWorkspace(true))
        expect(screen.getByRole('listbox', { name: 'Workspace select' })).toBeVisible()
    })
})
