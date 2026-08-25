/**
 * Dismisses and smoothly removes the startup loading splash screen from the DOM.
 */
export function dismissSplashScreen(): void {
    if (typeof document === 'undefined') {
        return
    }

    const splash = document.getElementById('startup-splash')
    if (!splash) {
        return
    }

    if (splash.classList.contains('splash-fade-out')) {
        return
    }

    splash.classList.add('splash-fade-out')

    let cleanedUp = false
    const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        splash.removeEventListener('transitionend', cleanup)
        if (splash.parentNode) {
            splash.parentNode.removeChild(splash)
        }
    }

    splash.addEventListener('transitionend', cleanup)
    // Fallback timeout in case transitionend does not fire (e.g. reduced motion or background tab)
    setTimeout(cleanup, 500)
}
