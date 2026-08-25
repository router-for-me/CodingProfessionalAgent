import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { ThemeImportDialog } from './ThemeImportDialog.js'

beforeEach(async () => {
    await i18n.changeLanguage('en')
})

describe('ThemeImportDialog', () => {
    it('does not render when open is false', () => {
        render(
            <ThemeImportDialog
                open={false}
                onClose={vi.fn()}
                onImport={vi.fn()}
            />,
        )
        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('renders modal and imports valid JSON config', async () => {
        const user = userEvent.setup()
        const onImport = vi.fn()
        const onClose = vi.fn()

        render(
            <ThemeImportDialog
                open={true}
                onClose={onClose}
                onImport={onImport}
            />,
        )

        expect(
            screen.getByRole('dialog', { name: 'Import Theme Configuration' }),
        ).toBeInTheDocument()

        const textarea = screen.getByPlaceholderText(/Paste JSON theme configuration/i)
        fireEvent.change(textarea, {
            target: {
                value: JSON.stringify({
                    accentColor: '#bd93f9',
                    backgroundColor: '#282a36',
                    contrast: 65,
                }),
            },
        })

        const confirmBtn = screen.getByRole('button', { name: 'Import' })
        await user.click(confirmBtn)

        expect(onImport).toHaveBeenCalledWith({
            accentColor: '#bd93f9',
            backgroundColor: '#282a36',
            contrast: 65,
        })
        expect(onClose).toHaveBeenCalled()
    })

    it('shows error message on malformed JSON', async () => {
        const user = userEvent.setup()
        const onImport = vi.fn()

        render(
            <ThemeImportDialog
                open={true}
                onClose={vi.fn()}
                onImport={onImport}
            />,
        )

        const textarea = screen.getByPlaceholderText(/Paste JSON theme configuration/i)
        fireEvent.change(textarea, { target: { value: '{ broken json' } })

        const confirmBtn = screen.getByRole('button', { name: 'Import' })
        await user.click(confirmBtn)

        expect(screen.getByText('Invalid theme configuration format')).toBeInTheDocument()
        expect(onImport).not.toHaveBeenCalled()
    })
})
