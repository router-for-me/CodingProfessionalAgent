import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useElapsedMs } from './useElapsedMs.js'

describe('useElapsedMs (bundled plugin)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('returns frozen elapsed time when completed and not running', () => {
        const { result } = renderHook(() =>
            useElapsedMs(1000, 5000, false),
        )
        expect(result.current).toBe(4000)
    })

    it('subtracts pausedMs when completed', () => {
        // startedAt = 1000, completedAt = 10_000 (total 9000ms), pausedMs = 4000ms -> net 5000ms
        const { result } = renderHook(() =>
            useElapsedMs(1000, 10_000, false, 4000),
        )
        expect(result.current).toBe(5000)
    })

    it('clamps elapsed time to 0 if pausedMs exceeds duration', () => {
        const { result } = renderHook(() =>
            useElapsedMs(1000, 2000, false, 5000),
        )
        expect(result.current).toBe(0)
    })

    it('ticks live clock while running and deducts pausedMs', () => {
        vi.setSystemTime(10_000)
        const startedAt = 5000
        const pausedMs = 2000 // 5s calendar time - 2s pause = 3s net

        const { result } = renderHook(() =>
            useElapsedMs(startedAt, undefined, true, pausedMs),
        )
        expect(result.current).toBe(3000)

        act(() => {
            vi.advanceTimersByTime(3000)
        })

        expect(result.current).toBe(6000)
    })

    it('immediately reflects correct resumed duration on resume without dropping by paused duration', () => {
        vi.setSystemTime(0)
        const startedAt = 0

        // 1. Run for 15 seconds
        const { result, rerender } = renderHook(
            ({ running, completedAt, pausedMs }) =>
                useElapsedMs(startedAt, completedAt, running, pausedMs),
            {
                initialProps: {
                    running: true,
                    completedAt: undefined as number | undefined,
                    pausedMs: 0,
                },
            },
        )

        act(() => {
            vi.advanceTimersByTime(15000)
        })
        expect(result.current).toBe(15000)

        // 2. Pause at 15s for 10 seconds (time advances to 25000)
        rerender({
            running: false,
            completedAt: 15000,
            pausedMs: 0,
        })
        act(() => {
            vi.advanceTimersByTime(10000) // now at 25000
        })
        expect(result.current).toBe(15000)

        // 3. Resume at 25000 with pausedMs = 10000
        // Immediately upon rerender (before any 1s timer ticks), it MUST be 15000, NOT 5000!
        rerender({
            running: true,
            completedAt: undefined,
            pausedMs: 10000,
        })
        expect(result.current).toBe(15000)

        // 4. Advance 1 second -> should be 16000
        act(() => {
            vi.advanceTimersByTime(1000)
        })
        expect(result.current).toBe(16000)

        // 5. Advance another 2 seconds -> should be 18000
        act(() => {
            vi.advanceTimersByTime(2000)
        })
        expect(result.current).toBe(18000)
    })
})
