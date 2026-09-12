import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachMenu } from './AttachMenu.js'

describe('AttachMenu', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('renders header and menu items with labels and descriptions', () => {
        render(
            <AttachMenu
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        expect(screen.getByText('Add')).toBeInTheDocument()
        expect(screen.getByText('Files & folders')).toBeInTheDocument()
        expect(screen.getAllByRole('option')).toHaveLength(1)
        expect(screen.queryByText('Goal')).not.toBeInTheDocument()
        expect(screen.queryByText('Plan mode')).not.toBeInTheDocument()
    })

    it('highlights active item based on activeIndex', () => {
        const customProviders = [
            { id: 'files', label: 'Files & folders' },
            { id: 'custom', label: 'Custom item' },
        ]
        const { rerender } = render(
            <AttachMenu
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
                providers={customProviders}
            />,
        )

        const options = screen.getAllByRole('option')
        expect(options[0]).toHaveAttribute('aria-selected', 'true')
        expect(options[1]).toHaveAttribute('aria-selected', 'false')

        rerender(
            <AttachMenu
                activeIndex={1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
                providers={customProviders}
            />,
        )
        expect(options[0]).toHaveAttribute('aria-selected', 'false')
        expect(options[1]).toHaveAttribute('aria-selected', 'true')
    })

    it('triggers onSelect when an option is clicked', async () => {
        const onSelect = vi.fn()
        render(
            <AttachMenu
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={onSelect}
                onClose={() => undefined}
            />,
        )

        const filesOption = screen.getByText('Files & folders').closest('button')!
        fireEvent.mouseDown(filesOption)
        expect(onSelect).toHaveBeenCalledWith('files')
    })

    it('triggers onActiveIndexChange on mouse enter', () => {
        const onActiveIndexChange = vi.fn()
        const customProviders = [
            { id: 'files', label: 'Files & folders' },
            { id: 'custom', label: 'Custom item' },
        ]
        render(
            <AttachMenu
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={() => undefined}
                onClose={() => undefined}
                providers={customProviders}
            />,
        )

        const options = screen.getAllByRole('option')
        fireEvent.mouseEnter(options[1]!)
        expect(onActiveIndexChange).toHaveBeenCalledWith(1)
    })

    it('closes when clicking outside of composer', async () => {
        const onClose = vi.fn()
        render(
            <div>
                <div data-testid="outside-area">Outside</div>
                <AttachMenu
                    activeIndex={0}
                    onActiveIndexChange={() => undefined}
                    onSelect={() => undefined}
                    onClose={onClose}
                />
            </div>,
        )

        fireEvent.pointerDown(screen.getByTestId('outside-area'))
        expect(onClose).toHaveBeenCalled()
    })
})
