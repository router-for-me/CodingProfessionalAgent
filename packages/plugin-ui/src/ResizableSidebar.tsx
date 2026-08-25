import {
    useCallback,
    useRef,
    useState,
    type CSSProperties,
    type KeyboardEvent,
    type ReactNode,
} from 'react'
import { PanelResizeHandle } from './PanelResizeHandle.js'
import { cn } from './cn.js'

export interface ResizableSidebarProps {
    children: ReactNode
    /**
     * Position edge of the resize handle:
     * 'left': Right sidebar with resize handle on the left edge.
     * 'right': Left sidebar with resize handle on the right edge.
     */
    side?: 'left' | 'right'
    edge?: 'left' | 'right'
    /**
     * Whether the sidebar is expanded/visible.
     */
    open?: boolean
    /**
     * Controlled width. If omitted, internal state with defaultWidth is used.
     */
    width?: number
    onWidthChange?: (w: number) => void
    /**
     * Initial width when uncontrolled.
     */
    defaultWidth?: number
    /**
     * Minimum width limit in pixels.
     */
    minWidth?: number
    /**
     * Maximum width limit in pixels.
     */
    maxWidth?: number
    /**
     * Callback fired when resizing.
     */
    onResize?: (width: number) => void
    /**
     * Accessibility label for resize handle.
     */
    resizeHandleLabel?: string
    /**
     * Additional CSS classes on outer <aside> container.
     */
    className?: string
    /**
     * Additional CSS classes on inner content <div> container.
     */
    contentClassName?: string
    /**
     * Additional inline style on inner content <div> container.
     */
    contentStyle?: CSSProperties
    /**
     * Optional data-testid for testing.
     */
    dataTestId?: string
}

export function ResizableSidebar({
    children,
    side,
    edge = side === 'left' ? 'right' : 'left',
    open = true,
    width: controlledWidth,
    onWidthChange,
    defaultWidth = 360,
    minWidth = 280,
    maxWidth = 640,
    onResize,
    resizeHandleLabel = 'Resize sidebar',
    className,
    contentClassName,
    contentStyle,
    dataTestId,
}: ResizableSidebarProps) {
    const [uncontrolledWidth, setUncontrolledWidth] = useState(defaultWidth)
    const currentWidth = controlledWidth ?? uncontrolledWidth
    const [dragging, setDragging] = useState(false)
    const asideRef = useRef<HTMLElement>(null)

    const clampWidth = useCallback(
        (w: number) => Math.max(minWidth, Math.min(maxWidth, w)),
        [minWidth, maxWidth],
    )

    const handlePointerResize = useCallback(
        (clientX: number) => {
            if (!asideRef.current) return
            const rect = asideRef.current.getBoundingClientRect()
            let nextWidth: number
            if (edge === 'left') {
                nextWidth = rect.right - clientX
            } else {
                nextWidth = clientX - rect.left
            }
            const clamped = clampWidth(nextWidth)
            if (controlledWidth === undefined) {
                setUncontrolledWidth(clamped)
            }
            onResize?.(clamped)
            onWidthChange?.(clamped)
        },
        [clampWidth, controlledWidth, edge, onResize, onWidthChange],
    )

    if (!open) return null

    return (
        <aside
            ref={asideRef}
            data-testid={dataTestId}
            style={{ width: `${currentWidth}px` }}
            className={cn(
                'relative flex flex-none flex-col',
                dragging && 'select-none',
                className,
            )}
        >
            <PanelResizeHandle
                label={resizeHandleLabel}
                width={currentWidth}
                min={minWidth}
                max={maxWidth}
                edge={edge}
                onResize={handlePointerResize}
                onDraggingChange={setDragging}
            />
            <div
                style={contentStyle}
                className={cn('relative flex h-full w-full flex-col overflow-hidden', contentClassName)}
            >
                {children}
            </div>
        </aside>
    )
}
