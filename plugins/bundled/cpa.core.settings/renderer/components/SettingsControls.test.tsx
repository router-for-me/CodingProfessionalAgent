import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    SettingsPasswordInput,
    SettingsPortInput,
    SettingsTextInput,
    ToggleSwitch,
} from './SettingsControls.js'

describe('SettingsControls', () => {
    describe('SettingsTextInput', () => {
        it('handles non-confirmable input with immediate onChange', () => {
            const onChange = vi.fn()
            render(
                <SettingsTextInput
                    value="initial"
                    onChange={onChange}
                    ariaLabel="Test Input"
                    placeholder="placeholder"
                    autoComplete="off"
                />,
            )

            const input = screen.getByRole('textbox', { name: 'Test Input' })
            expect(input).toHaveValue('initial')
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()

            fireEvent.change(input, { target: { value: 'new value' } })
            expect(onChange).toHaveBeenCalledWith('new value')
        })

        it('handles confirmable input with check and cross buttons', () => {
            const onChange = vi.fn()
            const onCancel = vi.fn()
            const { rerender } = render(
                <SettingsTextInput
                    confirmable
                    value="127.0.0.1"
                    onChange={onChange}
                    onCancel={onCancel}
                    ariaLabel="IP Input"
                    placeholder="127.0.0.1"
                    autoComplete="off"
                />,
            )

            const input = screen.getByRole('textbox', { name: 'IP Input' })
            expect(input).toHaveValue('127.0.0.1')
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

            // Change draft
            fireEvent.change(input, { target: { value: '0.0.0.0' } })
            expect(onChange).not.toHaveBeenCalled()

            const confirmBtn = screen.getByRole('button', { name: 'Confirm' })
            const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
            expect(confirmBtn).toBeInTheDocument()
            expect(cancelBtn).toBeInTheDocument()

            // Cancel
            fireEvent.click(cancelBtn)
            expect(input).toHaveValue('127.0.0.1')
            expect(onCancel).toHaveBeenCalled()
            expect(onChange).not.toHaveBeenCalled()
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()

            // Change again and confirm
            fireEvent.change(input, { target: { value: '  192.168.1.1  ' } })
            fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
            expect(onChange).toHaveBeenCalledWith('192.168.1.1')

            // Rerender with new committed value
            rerender(
                <SettingsTextInput
                    confirmable
                    value="192.168.1.1"
                    onChange={onChange}
                    onCancel={onCancel}
                    ariaLabel="IP Input"
                    placeholder="127.0.0.1"
                    autoComplete="off"
                />,
            )
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
        })

        it('does not commit empty string on confirmable input', () => {
            const onChange = vi.fn()
            render(
                <SettingsTextInput
                    confirmable
                    value="127.0.0.1"
                    onChange={onChange}
                    ariaLabel="IP Input"
                    placeholder="127.0.0.1"
                    autoComplete="off"
                />,
            )

            const input = screen.getByRole('textbox', { name: 'IP Input' })
            fireEvent.change(input, { target: { value: '   ' } })
            fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

            expect(onChange).not.toHaveBeenCalled()
            expect(input).toHaveValue('127.0.0.1')
        })
    })

    describe('SettingsPortInput', () => {
        it('handles non-confirmable port input with blur commit', () => {
            const onChange = vi.fn()
            render(
                <SettingsPortInput
                    value={18080}
                    onChange={onChange}
                    ariaLabel="Port Input"
                />,
            )

            const input = screen.getByRole('spinbutton', { name: 'Port Input' })
            expect(input).toHaveValue(18080)

            fireEvent.change(input, { target: { value: '8080' } })
            fireEvent.blur(input)
            expect(onChange).toHaveBeenCalledWith(8080)
        })

        it('handles confirmable port input with check and cross buttons', () => {
            const onChange = vi.fn()
            const onCancel = vi.fn()
            render(
                <SettingsPortInput
                    confirmable
                    value={18080}
                    onChange={onChange}
                    onCancel={onCancel}
                    ariaLabel="Port Input"
                />,
            )

            const input = screen.getByRole('spinbutton', { name: 'Port Input' })
            fireEvent.change(input, { target: { value: '9000' } })
            expect(onChange).not.toHaveBeenCalled()

            expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
            const cancelBtn = screen.getByRole('button', { name: 'Cancel' })

            fireEvent.click(cancelBtn)
            expect(input).toHaveValue(18080)
            expect(onCancel).toHaveBeenCalled()

            fireEvent.change(input, { target: { value: '9000' } })
            fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
            expect(onChange).toHaveBeenCalledWith(9000)
        })
    })

    describe('SettingsPasswordInput', () => {
        it('handles non-confirmable password input with live saving and no confirm/cancel buttons', () => {
            const onChange = vi.fn()
            render(
                <SettingsPasswordInput
                    value="my-password"
                    onChange={onChange}
                    ariaLabel="Password Input"
                    placeholder="Enter password"
                    showLabel="Show password"
                    hideLabel="Hide password"
                />,
            )

            const input = screen.getByLabelText('Password Input')
            expect(input).toHaveAttribute('type', 'password')
            expect(input).toHaveValue('my-password')
            expect(input.className).toContain('pr-[32px]')

            // Confirm/Cancel buttons should not exist
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

            // Eye toggle works
            const eyeBtn = screen.getByRole('button', { name: 'Show password' })
            fireEvent.click(eyeBtn)
            expect(input).toHaveAttribute('type', 'text')

            // Live change triggers onChange immediately
            fireEvent.change(input, { target: { value: 'changed-password' } })
            expect(onChange).toHaveBeenCalledWith('changed-password')
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
            expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
        })

        it('ensures Eye, Confirm, and Cancel buttons have minimum 24x24px click target and non-overlapping offsets', () => {
            const onConfirm = vi.fn()
            render(
                <SettingsPasswordInput
                    confirmable
                    value="my-password"
                    onConfirm={onConfirm}
                    ariaLabel="Password Input"
                    placeholder="Enter password"
                    showLabel="Show password"
                    hideLabel="Hide password"
                />,
            )

            const input = screen.getByLabelText('Password Input')
            expect(input).toHaveAttribute('type', 'password')
            // Non-dirty right padding
            expect(input.className).toContain('pr-[32px]')

            const eyeBtn = screen.getByRole('button', { name: 'Show password' })
            expect(eyeBtn).toBeInTheDocument()
            // Size 6 = 24x24px
            expect(eyeBtn.className).toContain('size-6')
            expect(eyeBtn.className).toContain('right-1')

            // Toggle visibility
            fireEvent.click(eyeBtn)
            expect(input).toHaveAttribute('type', 'text')
            expect(screen.getByRole('button', { name: 'Hide password' })).toBeInTheDocument()

            // Edit to make dirty
            fireEvent.change(input, { target: { value: 'changed-password' } })

            // Dirty right padding accommodates eye button and action buttons without overlap
            expect(input.className).toContain('pr-[86px]')

            const confirmBtn = screen.getByRole('button', { name: 'Confirm' })
            const cancelBtn = screen.getByRole('button', { name: 'Cancel' })
            expect(confirmBtn.className).toContain('size-6')
            expect(cancelBtn.className).toContain('size-6')

            // Confirm button container positioned to the left of eye button
            const actionsContainer = confirmBtn.parentElement
            expect(actionsContainer?.className).toContain('right-[30px]')

            // Cancel resets draft
            fireEvent.click(cancelBtn)
            expect(input).toHaveValue('my-password')
            expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()

            // Edit and confirm
            fireEvent.change(input, { target: { value: 'new-pass' } })
            fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
            expect(onConfirm).toHaveBeenCalledWith('new-pass')
        })
    })

    describe('ToggleSwitch', () => {
        it('toggles when clicked', () => {
            const onChange = vi.fn()
            render(
                <ToggleSwitch
                    checked={false}
                    onChange={onChange}
                    label="Test Switch"
                />,
            )

            const toggle = screen.getByRole('switch', { name: 'Test Switch' })
            expect(toggle).toHaveAttribute('aria-checked', 'false')

            fireEvent.click(toggle)
            expect(onChange).toHaveBeenCalledWith(true)
        })

        it('handles disabled state', () => {
            const onChange = vi.fn()
            const { rerender } = render(
                <ToggleSwitch
                    checked={false}
                    disabled={true}
                    onChange={onChange}
                    label="Disabled Switch"
                />,
            )

            const toggle = screen.getByRole('switch', { name: 'Disabled Switch' })
            expect(toggle).toBeDisabled()
            fireEvent.click(toggle)
            expect(onChange).not.toHaveBeenCalled()

            rerender(
                <ToggleSwitch
                    checked={true}
                    disabled={false}
                    onChange={onChange}
                    label="Enabled Switch"
                />,
            )
            expect(toggle).not.toBeDisabled()
            fireEvent.click(toggle)
            expect(onChange).toHaveBeenCalledWith(false)
        })
    })
})
