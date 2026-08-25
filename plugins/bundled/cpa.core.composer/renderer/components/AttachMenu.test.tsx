import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachMenu } from './AttachMenu.js'

describe('AttachMenu', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('en')
    })

    it('renders header and all three menu items with labels and descriptions', () => {
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
        expect(screen.getByText('Goal')).toBeInTheDocument()
        expect(screen.getByText('Set a goal to persistently pursue')).toBeInTheDocument()
        expect(screen.getByText('Plan mode')).toBeInTheDocument()
        expect(screen.getByText('Turn on plan mode')).toBeInTheDocument()
    })

    it('highlights active item based on activeIndex', () => {
        const { rerender } = render(
            <AttachMenu
                activeIndex={1}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const options = screen.getAllByRole('option')
        expect(options[0]).toHaveAttribute('aria-selected', 'false')
        expect(options[1]).toHaveAttribute('aria-selected', 'true')
        expect(options[2]).toHaveAttribute('aria-selected', 'false')

        rerender(
            <AttachMenu
                activeIndex={2}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )
        expect(options[2]).toHaveAttribute('aria-selected', 'true')
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

        const goalOption = screen.getByText('Goal').closest('button')!
        fireEvent.mouseDown(goalOption)
        expect(onSelect).toHaveBeenCalledWith('goal')

        const planOption = screen.getByText('Plan mode').closest('button')!
        fireEvent.mouseDown(planOption)
        expect(onSelect).toHaveBeenCalledWith('plan-mode')
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
