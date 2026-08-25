import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    PANEL_COLLAPSE_DURATION_MS,
    useCollapsibleOpen,
} from './useCollapsibleOpen'

async function flushAnimationFrame() {
    await act(async () => {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve())
        })
    })
}

function mockMatchMedia(matches: boolean) {
    window.matchMedia = ((query: string) =>
        ({
            matches: query.includes('prefers-reduced-motion') ? matches : false,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
            onchange: null,
        }) as MediaQueryList) as typeof window.matchMedia
}

afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
})

describe('useCollapsibleOpen', () => {
    it('keeps the initial open state without enabling a transition', () => {
        const { result } = renderHook(() => useCollapsibleOpen(true))
        expect(result.current).toEqual({ open: true, transition: false })
    })

    it('enables transition first, then flips the visual open state', async () => {
        const { result, rerender } = renderHook(
            ({ open }) => useCollapsibleOpen(open),
            { initialProps: { open: true } },
        )

        rerender({ open: false })
        expect(result.current).toEqual({ open: true, transition: true })

        await flushAnimationFrame()
        expect(result.current).toEqual({ open: false, transition: true })
    })

    it('animates first mount when animatePresent is set', async () => {
        const { result } = renderHook(() =>
            useCollapsibleOpen(true, { animatePresent: true }),
        )

        expect(result.current).toEqual({ open: false, transition: true })
        await flushAnimationFrame()
        expect(result.current).toEqual({ open: true, transition: true })
    })

    it('clears the transition flag after the collapse duration', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        const { result, rerender } = renderHook(
            ({ open }) => useCollapsibleOpen(open),
            { initialProps: { open: true } },
        )

        rerender({ open: false })
        await flushAnimationFrame()
        expect(result.current.transition).toBe(true)

        await act(async () => {
            vi.advanceTimersByTime(PANEL_COLLAPSE_DURATION_MS)
        })
        expect(result.current.transition).toBe(false)
    })

    it('skips animation when the user prefers reduced motion', async () => {
        mockMatchMedia(true)
        const { result, rerender } = renderHook(
            ({ open }) => useCollapsibleOpen(open),
            { initialProps: { open: true } },
        )

        rerender({ open: false })
        await flushAnimationFrame()
        expect(result.current).toEqual({ open: false, transition: false })
    })
})
