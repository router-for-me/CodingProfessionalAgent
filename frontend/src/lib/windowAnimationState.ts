/**
 * Manages global animation pause state based on window and document visibility.
 * Pauses infinite CSS animations when the window is hidden/minimized to eliminate background GPU/CPU drain.
 */

export const PAUSED_ANIMATIONS_CLASS = 'cpa-paused-animations'

/**
 * Updates the documentElement class to pause or resume CSS animations.
 */
export function updateAnimationPauseState(forcedHidden?: boolean): void {
    if (typeof document === 'undefined') {
        return
    }
    const isHidden = forcedHidden !== undefined ? forcedHidden : Boolean(document.hidden)
    if (isHidden) {
        document.documentElement.classList.add(PAUSED_ANIMATIONS_CLASS)
    } else {
        document.documentElement.classList.remove(PAUSED_ANIMATIONS_CLASS)
    }
}

/**
 * Initializes listeners for document visibility change to auto-pause CSS animations.
 * Returns a cleanup disposal function.
 */
export function initWindowAnimationState(): () => void {
    if (typeof document === 'undefined') {
        return () => {}
    }

    updateAnimationPauseState()

    const onVisibilityChange = (): void => {
        updateAnimationPauseState()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange)
        document.documentElement.classList.remove(PAUSED_ANIMATIONS_CLASS)
    }
}
