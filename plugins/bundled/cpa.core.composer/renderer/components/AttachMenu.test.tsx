import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachMenu } from './AttachMenu.js'

describe('AttachMenu', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('renders the files and folders menu item', () => {
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
    })

    it('highlights active item based on activeIndex', () => {
        render(
            <AttachMenu
                activeIndex={1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true')
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
        render(
            <AttachMenu
                activeIndex={0}
                onActiveIndexChange={onActiveIndexChange}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        fireEvent.mouseEnter(screen.getByRole('option'))
        expect(onActiveIndexChange).toHaveBeenCalledWith(0)
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
