function isReactMeasure(entry: PerformanceEntry): boolean {
    const detail = (entry as PerformanceMeasure).detail as {
        devtools?: { track?: unknown; trackGroup?: unknown }
    } | null
    const devtools = detail?.devtools
    return [devtools?.track, devtools?.trackGroup].some(
        (track) => typeof track === 'string' && track.endsWith(' ⚛'),
    )
}

/**
 * React development builds retain component props in User Timing measures.
 * Release those entries after delivery instead of accumulating them for the
 * lifetime of the renderer. Trace recording and other observers still receive
 * the original measures; application marks and measures remain untouched.
 */
export function observeReactPerformanceMeasures(): () => void {
    if (
        !import.meta.env.DEV ||
        typeof PerformanceObserver === 'undefined' ||
        typeof performance === 'undefined' ||
        typeof performance.getEntriesByName !== 'function' ||
        typeof performance.clearMeasures !== 'function'
    ) {
        return () => {}
    }

    const observer = new PerformanceObserver((list) => {
        const names = new Set(list.getEntries().map((entry) => entry.name))
        for (const name of names) {
            // clearMeasures only supports names, so preserve mixed-name entries.
            const entries = performance.getEntriesByName(name, 'measure')
            if (entries.length > 0 && entries.every(isReactMeasure)) {
                performance.clearMeasures(name)
            }
        }
    })
    try {
        observer.observe({ type: 'measure', buffered: true })
    } catch {
        // Older web runtimes may expose the API without supporting this type.
        observer.disconnect()
        return () => {}
    }
    return () => observer.disconnect()
}
