import {
    forwardRef,
    type HTMLAttributes,
    type ReactElement,
    type ReactNode,
} from 'react'
import { cn } from './cn.js'

export interface UsageRingProps extends HTMLAttributes<HTMLSpanElement> {
    /** Usage percentage between 0 and 100 */
    percent: number
    /** Pixel size (diameter) of the ring */
    size?: number
    /** Stroke width in pixels */
    strokeWidth?: number
    /** Optional stroke color override for the active progress arc */
    color?: string
    /** Optional track background stroke color */
    trackColor?: string
    /** Optional data-testid */
    testId?: string
    /** Optional popover or anchor children */
    children?: ReactNode
}

function getProgressColor(percent: number): string {
    if (percent >= 95) return 'var(--accent-red, #ef4444)'
    if (percent >= 80) return 'var(--accent-amber, #f59e0b)'
    return 'var(--accent-blue, #3b82f6)'
}

export const UsageRing = forwardRef<HTMLSpanElement, UsageRingProps>(
    function UsageRing(
        {
            percent,
            size = 16,
            strokeWidth = 2,
            color,
            trackColor = 'var(--border-subtle, rgba(255, 255, 255, 0.15))',
            className,
            testId = 'usage-ring',
            children,
            title,
            ...rest
        },
        ref,
    ): ReactElement {
        const clamped = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)))
        const radius = (size - strokeWidth) / 2
        const circumference = 2 * Math.PI * radius
        const strokeDashoffset = circumference - (clamped / 100) * circumference
        const strokeColor = color ?? getProgressColor(clamped)

        return (
            <span
                ref={ref}
                data-testid={testId}
                title={title}
                className={cn('inline-flex items-center justify-center relative shrink-0', className)}
                {...rest}
            >
                <svg
                    width={size}
                    height={size}
                    viewBox={`0 0 ${size} ${size}`}
                    className="rotate-[-90deg] overflow-visible"
                    aria-hidden
                >
                    {/* Background track circle */}
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        stroke={trackColor}
                        strokeWidth={strokeWidth}
                    />
                    {/* Progress arc */}
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={radius}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeDashoffset}
                        strokeLinecap="round"
                        style={{
                            transition: 'stroke-dashoffset 0.25s ease, stroke 0.25s ease',
                        }}
                    />
                </svg>
                {children}
            </span>
        )
    },
)
