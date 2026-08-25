import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { getHostServices } from '@/application/services/createHostServices'
import { ColorPickerPill } from './ColorPickerPill.js'

beforeEach(async () => {
    getHostServices()
    await i18n.changeLanguage('en')
})

describe('ColorPickerPill', () => {
    it('renders pill with color circle and hex text', () => {
        render(
            <ColorPickerPill
                value="#339CFF"
                ariaLabel="Accent Color"
                onChange={vi.fn()}
            />,
        )

        expect(screen.getByRole('button', { name: 'Accent Color' })).toBeInTheDocument()
        expect(screen.getByText('#339CFF')).toBeInTheDocument()
    })

    it('opens color palette popover and selects a preset color', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(
            <ColorPickerPill
                value="#339CFF"
                ariaLabel="Accent Color"
                onChange={onChange}
            />,
        )

        const trigger = screen.getByRole('button', { name: 'Accent Color' })
        await user.click(trigger)

        expect(screen.getByRole('dialog', { name: 'Accent Color' })).toBeInTheDocument()

        const greenSwatch = screen.getByRole('button', { name: '#22C55E' })
        await user.click(greenSwatch)

        expect(onChange).toHaveBeenCalledWith('#22C55E')
    })

    it('resets color to default when clicking reset button', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(
            <ColorPickerPill
                value="#10B981"
                defaultColor="#339CFF"
                ariaLabel="Accent Color"
                onChange={onChange}
            />,
        )

        await user.click(screen.getByRole('button', { name: 'Accent Color' }))
        const resetBtn = screen.getByTitle('Reset')
        await user.click(resetBtn)

        expect(onChange).toHaveBeenCalledWith('#339CFF')
    })

    it('closes popover on pressing Escape', async () => {
        const user = userEvent.setup()
        render(
            <ColorPickerPill
                value="#339CFF"
                ariaLabel="Accent Color"
                onChange={vi.fn()}
            />,
        )

        await user.click(screen.getByRole('button', { name: 'Accent Color' }))
        expect(screen.getByRole('dialog', { name: 'Accent Color' })).toBeInTheDocument()

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: 'Accent Color' })).toBeNull()
    })
})
