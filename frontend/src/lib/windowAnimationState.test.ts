import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    initWindowAnimationState,
    updateAnimationPauseState,
    PAUSED_ANIMATIONS_CLASS,
} from './windowAnimationState'

describe('windowAnimationState', () => {
    beforeEach(() => {
        document.documentElement.classList.remove(PAUSED_ANIMATIONS_CLASS)
    })

    afterEach(() => {
        document.documentElement.classList.remove(PAUSED_ANIMATIONS_CLASS)
        vi.restoreAllMocks()
    })

    it('adds paused class when hidden and removes when visible', () => {
        updateAnimationPauseState(true)
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(true)

        updateAnimationPauseState(false)
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(false)
    })

    it('attaches visibilitychange listener and responds to document.hidden changes', () => {
        let isHidden = false
        vi.spyOn(document, 'hidden', 'get').mockImplementation(() => isHidden)

        const cleanup = initWindowAnimationState()
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(false)

        isHidden = true
        document.dispatchEvent(new Event('visibilitychange'))
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(true)

        isHidden = false
        document.dispatchEvent(new Event('visibilitychange'))
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(false)

        cleanup()
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(false)

        isHidden = true
        document.dispatchEvent(new Event('visibilitychange'))
        // Should not react after cleanup
        expect(document.documentElement.classList.contains(PAUSED_ANIMATIONS_CLASS)).toBe(false)
    })
})
