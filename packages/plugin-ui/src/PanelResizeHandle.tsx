import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from './cn.js'

export function PanelResizeHandle({
    label,
    width,
    min,
    max,
    edge,
    onResize,
    onDraggingChange,
}: {
    label: string
    width: number
    min: number
    max: number
    edge: 'left' | 'right'
    onResize: (clientX: number) => void
    onDraggingChange?: (dragging: boolean) => void
}) {
    const draggingRef = useRef(false)
    const [dragging, setDragging] = useState(false)
    const onDraggingChangeRef = useRef(onDraggingChange)

    useEffect(() => {
        onDraggingChangeRef.current = onDraggingChange
    }, [onDraggingChange])

    useEffect(() => {
        const onMove = (event: PointerEvent) => {
            if (!draggingRef.current) return
            onResize(event.clientX)
        }
        const stopDrag = () => {
            if (!draggingRef.current) return
            draggingRef.current = false
            setDragging(false)
            onDraggingChangeRef.current?.(false)
            document.body.style.removeProperty('cursor')
            document.body.style.removeProperty('user-select')
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', stopDrag)
        window.addEventListener('pointercancel', stopDrag)
        return () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', stopDrag)
            window.removeEventListener('pointercancel', stopDrag)
            if (draggingRef.current) {
                draggingRef.current = false
                onDraggingChangeRef.current?.(false)
            }
            document.body.style.removeProperty('cursor')
            document.body.style.removeProperty('user-select')
        }
    }, [onResize])

    return (
        <div
            role="separator"
            data-no-drag
            aria-orientation="vertical"
            aria-label={label}
            aria-valuenow={width}
            aria-valuemin={min}
            aria-valuemax={max}
            tabIndex={0}
            className={cn(
                'absolute inset-y-0 z-30 w-3 cursor-col-resize touch-none',
                edge === 'right' ? '-right-1.5' : '-left-1.5',
                'after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-px',
                'after:transition-colors after:duration-150',
                dragging
                    ? 'after:bg-[var(--accent-blue)]'
                    : 'hover:after:bg-[var(--accent-blue)]',
            )}
            onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                draggingRef.current = true
                setDragging(true)
                onDraggingChangeRef.current?.(true)
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
            }}
            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                const step = event.shiftKey ? 20 : 8
                if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    const next = edge === 'left' ? width + step : width - step
                    onResize(next)
                } else if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    const next = edge === 'left' ? width - step : width + step
                    onResize(next)
                } else if (event.key === 'Home') {
                    event.preventDefault()
                    onResize(min)
                } else if (event.key === 'End') {
                    event.preventDefault()
                    onResize(max)
                }
            }}
        />
    )
}
