/**
 * Guards against known browser DevTools-injected and extension script errors.
 *
 * Specific fix for Chromium 152 DevTools Live Metrics bug (Chromium Issue 543499029,
 * web-vitals Issue #792), where Chrome DevTools injects an anonymous VM script with
 * `reportAllChanges: true`. During short (<16ms) interactions like clicking badges
 * or fast state toggles, `interaction.entries` is empty, causing:
 *   "Uncaught TypeError: Cannot read properties of undefined (reading 'startTime')
 *      at et.reportAllChanges (<anonymous>:2:19429)
 *      at n.timeout (<anonymous>:2:5652)"
 *
 * Calling `event.preventDefault()` marks the error as handled so it does not pollute
 * the DevTools console as an uncaught exception or trigger unhandled rejection gates.
 */

export function isDevToolsInjectedStartTimeError(
    message: string | undefined,
    stack?: string,
    filename?: string,
): boolean {
    if (!message || typeof message !== 'string') {
        return false
    }

    const matchesStartTime =
        message.includes("reading 'startTime'") ||
        message.includes('reading "startTime"') ||
        message.includes("property 'startTime'") ||
        message.includes('property "startTime"')

    if (!matchesStartTime) {
        return false
    }

    const stackStr = typeof stack === 'string' ? stack : ''
    const fileStr = typeof filename === 'string' ? filename : ''

    const isReportAllChanges = stackStr.includes('reportAllChanges')
    const isAnonymousVm =
        stackStr.includes('<anonymous>') ||
        stackStr.includes('VM') ||
        fileStr.includes('VM') ||
        fileStr === '' ||
        fileStr === '<anonymous>'

    return isReportAllChanges || isAnonymousVm
}

export function initInjectedErrorGuard(): () => void {
    if (typeof window === 'undefined') {
        return () => {}
    }

    const errorHandler = (event: ErrorEvent) => {
        if (
            isDevToolsInjectedStartTimeError(
                event.message,
                event.error?.stack,
                event.filename,
            )
        ) {
            event.preventDefault()
            event.stopImmediatePropagation()
        }
    }

    window.addEventListener('error', errorHandler, true)

    return () => {
        window.removeEventListener('error', errorHandler, true)
    }
}
