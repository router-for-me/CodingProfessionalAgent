import type { SVGProps } from 'react'
import { cn } from './cn.js'

const SQUARE_GRID_CELLS = [
    { step: 0, x: 2.5, y: 0.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-0' },
    { step: 1, x: 6.5, y: 0.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-1' },
    { step: 2, x: 6.5, y: 4.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-2' },
    { step: 3, x: 6.5, y: 8.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-3' },
    { step: 4, x: 2.5, y: 8.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-4' },
    { step: 5, x: 2.5, y: 4.5, className: 'animate-square-grid-6-cell animate-square-grid-6-step-5' },
] as const

export type SquareGridLoaderProps = Omit<SVGProps<SVGSVGElement>, 'children'>

/** Vertical 2x3 rectangle of 6 squares that omits one square clockwise at 2 fps. */
export function SquareGridLoader({
    className,
    'aria-hidden': ariaHidden = true,
    ...rest
}: SquareGridLoaderProps) {
    return (
        <svg
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden={ariaHidden}
            className={cn('pointer-events-none shrink-0', className)}
            {...rest}
        >
            {SQUARE_GRID_CELLS.map(({ step, x, y, className: cellClassName }) => (
                <rect
                    key={step}
                    data-running-grid-step={step}
                    x={x}
                    y={y}
                    width={3}
                    height={3}
                    className={cellClassName}
                />
            ))}
        </svg>
    )
}
