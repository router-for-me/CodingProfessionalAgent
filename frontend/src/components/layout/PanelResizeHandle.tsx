import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'

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
        draggingRef.current = true
        setDragging(true)
        onDraggingChangeRef.current?.(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
    />
  )
}

export function HorizontalPanelResizeHandle({
  label,
  height,
  min,
  max,
  onResize,
  onDraggingChange,
}: {
  label: string
  height: number
  min: number
  max: number
  onResize: (clientY: number) => void
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
      onResize(event.clientY)
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
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={height}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cn(
        'absolute inset-x-0 top-0 z-30 h-3 cursor-row-resize touch-none -translate-y-1.5',
        'after:absolute after:inset-x-0 after:top-1/2 after:-translate-y-1/2 after:h-px',
        'after:transition-colors after:duration-150',
        dragging
          ? 'after:bg-[var(--accent-blue)]'
          : 'hover:after:bg-[var(--accent-blue)]',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        draggingRef.current = true
        setDragging(true)
        onDraggingChangeRef.current?.(true)
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
      }}
    />
  )
}
