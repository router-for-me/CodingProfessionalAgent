import i18n from '@/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { AttachMenu, computeAttachMenuPosition } from './AttachMenu.js'

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

    it('computes position correctly above anchor', () => {
        const sampleRect = {
            top: 600,
            left: 200,
            bottom: 680,
            right: 800,
            width: 600,
            height: 80,
            x: 200,
            y: 600,
            toJSON: () => {},
        } as DOMRect
        const pos = computeAttachMenuPosition(sampleRect)
        expect(pos.bottom).toBe(window.innerHeight - 600 + 8)
        expect(pos.left).toBe(200)
    })

    it('renders inside a portal with fixed z-[70] when anchorRef is provided to prevent being covered', () => {
        const anchorEl = document.createElement('div')
        anchorEl.getBoundingClientRect = () =>
            ({
                top: 500,
                left: 150,
                bottom: 580,
                right: 750,
                width: 600,
                height: 80,
                x: 150,
                y: 500,
                toJSON: () => {},
            }) as DOMRect
        document.body.appendChild(anchorEl)

        const anchorRef = createRef<HTMLDivElement>()
        ;(anchorRef as any).current = anchorEl

        render(
            <AttachMenu
                anchorRef={anchorRef}
                activeIndex={0}
                onActiveIndexChange={() => undefined}
                onSelect={() => undefined}
                onClose={() => undefined}
            />,
        )

        const menu = screen.getByRole('listbox')
        expect(menu).toHaveAttribute('data-attach-menu-portal')
        expect(menu).toHaveClass('fixed', 'z-[70]')
        expect(menu.style.bottom).toBe(`${window.innerHeight - 500 + 8}px`)
        expect(menu.style.left).toBe('150px')
    })
})
