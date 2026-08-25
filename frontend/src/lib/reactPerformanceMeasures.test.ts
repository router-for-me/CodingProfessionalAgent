// @vitest-environment node

import { PerformanceObserver, performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeReactPerformanceMeasures } from './reactPerformanceMeasures'

function measure(name: string, detail: unknown): void {
    performance.measure(name, { start: 0, end: 1, detail })
}

const componentDetail = {
    devtools: {
        track: 'Components ⚛',
        properties: [['Changed Props', 'streamed message']],
    },
}

const schedulerDetail = {
    devtools: { track: 'Blocking', trackGroup: 'Scheduler ⚛' },
}

describe('React performance measure cleanup', () => {
    const disposers: Array<() => void> = []

    beforeEach(() => {
        vi.stubEnv('DEV', true)
        vi.stubGlobal('PerformanceObserver', PerformanceObserver)
        vi.stubGlobal('performance', performance)
        performance.clearMeasures()
        performance.clearMarks()
    })

    afterEach(() => {
        for (const dispose of disposers.splice(0)) dispose()
        performance.clearMeasures()
        performance.clearMarks()
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    function startCleanup(): void {
        disposers.push(observeReactPerformanceMeasures())
    }

    it('releases buffered React measures, including duplicate component names', async () => {
        for (let index = 0; index < 3000; index += 1) {
            measure(`\u200bComponent${index % 10}`, componentDetail)
        }
        measure('Update', schedulerDetail)
        startCleanup()

        await vi.waitFor(() => {
            expect(performance.getEntriesByType('measure')).toHaveLength(0)
        })
    })

    it('preserves application timing, malformed details and non-React tracks', async () => {
        performance.mark('application-start')
        const preserved = [
            ['application-request', { request: 1 }],
            ['\u200bNotAReactMeasure', null],
            ['Render', { devtools: { track: 'Custom components' } }],
            ['unknown-track', { devtools: { track: 42, trackGroup: {} } }],
            ['string-detail', 'application detail'],
        ] as const
        for (const [name, detail] of preserved) measure(name, detail)
        measure('\u200bRealComponent', componentDetail)
        startCleanup()

        await vi.waitFor(() => {
            expect(performance.getEntriesByName('\u200bRealComponent')).toHaveLength(0)
        })
        expect(performance.getEntriesByType('measure').map((entry) => entry.name))
            .toEqual(preserved.map(([name]) => name))
        expect(performance.getEntriesByName('application-start', 'mark')).toHaveLength(1)
    })

    it('does not clear an application measure sharing a React measure name', async () => {
        measure('Update', { application: true })
        startCleanup()
        measure('Update', schedulerDetail)
        measure('\u200bComponent', componentDetail)

        await vi.waitFor(() => {
            expect(performance.getEntriesByName('\u200bComponent')).toHaveLength(0)
        })
        expect(performance.getEntriesByName('Update', 'measure')).toHaveLength(2)
    })

    it('keeps repeated render bursts bounded without hiding them from other observers', async () => {
        startCleanup()
        let recorded = 0
        const recorder = new PerformanceObserver((list) => {
            recorded += list.getEntries().length
        })
        recorder.observe({ type: 'measure' })
        disposers.push(() => recorder.disconnect())

        for (let burst = 0; burst < 6; burst += 1) {
            for (let index = 0; index < 500; index += 1) {
                measure(`\u200bComponent${index % 10}`, componentDetail)
                measure('Update', schedulerDetail)
            }
            await vi.waitFor(() => {
                expect(recorded).toBe((burst + 1) * 1000)
                expect(performance.getEntriesByType('measure')).toHaveLength(0)
            })
        }
    })

    it('disconnects on disposal and can be installed again after hot replacement', async () => {
        const stop = observeReactPerformanceMeasures()
        disposers.push(stop)
        measure('\u200bBeforeDispose', componentDetail)
        await vi.waitFor(() => {
            expect(performance.getEntriesByType('measure')).toHaveLength(0)
        })
        stop()
        measure('\u200bAfterDispose', componentDetail)
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(performance.getEntriesByType('measure')).toHaveLength(1)

        startCleanup()
        await vi.waitFor(() => {
            expect(performance.getEntriesByType('measure')).toHaveLength(0)
        })
    })

    it('does not observe or clear timing in production builds', () => {
        vi.stubEnv('DEV', false)
        const constructor = vi.fn()
        vi.stubGlobal('PerformanceObserver', constructor)
        measure('\u200bComponent', componentDetail)
        startCleanup()
        expect(constructor).not.toHaveBeenCalled()
        expect(performance.getEntriesByType('measure')).toHaveLength(1)
    })

    it('supports environments without PerformanceObserver or User Timing', () => {
        vi.stubGlobal('PerformanceObserver', undefined)
        expect(() => startCleanup()).not.toThrow()
        vi.stubGlobal('PerformanceObserver', PerformanceObserver)
        vi.stubGlobal('performance', {})
        expect(() => startCleanup()).not.toThrow()
        vi.stubGlobal('performance', undefined)
        expect(() => startCleanup()).not.toThrow()
    })

    it('disconnects if the runtime rejects measure observation', () => {
        const disconnect = vi.fn()
        vi.stubGlobal('PerformanceObserver', class {
            observe(): void {
                throw new Error('Unsupported entry type')
            }
            disconnect = disconnect
        })
        expect(() => startCleanup()).not.toThrow()
        expect(disconnect).toHaveBeenCalledOnce()
    })
})
