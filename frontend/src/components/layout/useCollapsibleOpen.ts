import { useEffect, useLayoutEffect, useState } from 'react'

export const PANEL_COLLAPSE_DURATION_MS = 200

function prefersReducedMotion(): boolean {
    if (
        typeof window === 'undefined' ||
        typeof window.matchMedia !== 'function'
    ) {
        return false
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Two-phase open flag so width/height can transition.
 * Frame 1 enables `transition`, frame 2 flips the visual open state.
 */
export function useCollapsibleOpen(
    open: boolean,
    options?: { animatePresent?: boolean },
): { open: boolean; transition: boolean } {
    const [renderOpen, setRenderOpen] = useState(
        options?.animatePresent ? false : open,
    )
    const [transition, setTransition] = useState(false)

    useLayoutEffect(() => {
        if (open === renderOpen) return

        if (prefersReducedMotion()) {
            setRenderOpen(open)
            setTransition(false)
            return
        }

        setTransition(true)
        const frame = window.requestAnimationFrame(() => {
            setRenderOpen(open)
        })
        return () => window.cancelAnimationFrame(frame)
    }, [open, renderOpen])

    useEffect(() => {
        if (!transition) return
        const timer = window.setTimeout(() => {
            setTransition(false)
        }, PANEL_COLLAPSE_DURATION_MS)
        return () => window.clearTimeout(timer)
    }, [transition, renderOpen])

    return { open: renderOpen, transition }
}
