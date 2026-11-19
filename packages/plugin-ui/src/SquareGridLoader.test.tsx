import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SquareGridLoader } from './SquareGridLoader.js'

describe('SquareGridLoader', () => {
    it('renders 6 equal squares arranged in a 2x3 vertical rectangle in clockwise order', () => {
        render(
            <SquareGridLoader
                data-testid="square-grid-loader"
                className="size-3.5 text-[var(--accent-blue)]"
            />
        )

        const svg = screen.getByTestId('square-grid-loader')
        expect(svg.tagName.toLowerCase()).toBe('svg')
        expect(svg).toHaveAttribute('viewBox', '0 0 12 12')
        expect(svg).toHaveAttribute('fill', 'currentColor')
        expect(svg).toHaveAttribute('aria-hidden', 'true')
        expect(svg).toHaveClass('pointer-events-none', 'shrink-0', 'size-3.5', 'text-[var(--accent-blue)]')

        const squares = Array.from(svg.querySelectorAll('rect'))
        expect(squares).toHaveLength(6)
        expect(
            squares.map((rect) => ({
                step: rect.getAttribute('data-running-grid-step'),
                x: rect.getAttribute('x'),
                y: rect.getAttribute('y'),
                width: rect.getAttribute('width'),
                height: rect.getAttribute('height'),
                className: rect.getAttribute('class'),
            }))
        ).toEqual([
            { step: '0', x: '2.5', y: '0.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-0' },
            { step: '1', x: '6.5', y: '0.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-1' },
            { step: '2', x: '6.5', y: '4.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-2' },
            { step: '3', x: '6.5', y: '8.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-3' },
            { step: '4', x: '2.5', y: '8.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-4' },
            { step: '5', x: '2.5', y: '4.5', width: '3', height: '3', className: 'animate-square-grid-6-cell animate-square-grid-6-step-5' },
        ])
    })
})
