/**
 * Platform and runtime environment detection utilities.
 */

/**
 * Checks whether the frontend is running inside a web browser rather than Electron desktop window.
 */
export function isBrowserEnvironment(): boolean {
    if (typeof window === 'undefined') return false
    return !navigator.userAgent.includes('Electron')
}
