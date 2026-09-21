import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    initInjectedErrorGuard,
    isDevToolsInjectedStartTimeError,
} from './injectedErrorGuard'

describe('injectedErrorGuard', () => {
    describe('isDevToolsInjectedStartTimeError', () => {
        it('identifies Chromium 152 DevTools Live Metrics web-vitals crash stack', () => {
            const message = "Uncaught TypeError: Cannot read properties of undefined (reading 'startTime')"
            const stack = `TypeError: Cannot read properties of undefined (reading 'startTime')
    at et.reportAllChanges (<anonymous>:2:19429)
    at <anonymous>:2:13070
    at <anonymous>:2:331
    at d (<anonymous>:2:6141)
    at <anonymous>:2:6326
    at <anonymous>:2:2895
    at n.timeout (<anonymous>:2:5652)`
            const filename = '<anonymous>'

            expect(isDevToolsInjectedStartTimeError(message, stack, filename)).toBe(true)
        })

        it('identifies VM source filename with startTime reading error', () => {
            const message = "Cannot read properties of undefined (reading 'startTime')"
            const filename = 'VM309'

            expect(isDevToolsInjectedStartTimeError(message, undefined, filename)).toBe(true)
        })

        it('identifies stack with reportAllChanges regardless of filename', () => {
            const message = "Cannot read property 'startTime' of undefined"
            const stack = 'at reportAllChanges (bundle.js:10:20)'

            expect(isDevToolsInjectedStartTimeError(message, stack, 'bundle.js')).toBe(true)
        })

        it('returns false for unrelated errors', () => {
            expect(isDevToolsInjectedStartTimeError("Cannot read properties of undefined (reading 'name')")).toBe(false)
            expect(isDevToolsInjectedStartTimeError(undefined)).toBe(false)
            expect(isDevToolsInjectedStartTimeError('')).toBe(false)
        })

        it('returns false for startTime error from application code without VM or reportAllChanges', () => {
            const message = "Cannot read properties of undefined (reading 'startTime')"
            const stack = 'at myFunction (src/utils/myModule.ts:15:10)'
            const filename = 'src/utils/myModule.ts'

            expect(isDevToolsInjectedStartTimeError(message, stack, filename)).toBe(false)
        })
    })

    describe('initInjectedErrorGuard', () => {
        let cleanup: (() => void) | undefined

        beforeEach(() => {
            cleanup = initInjectedErrorGuard()
        })

        afterEach(() => {
            if (cleanup) {
                cleanup()
                cleanup = undefined
            }
        })

        it('intercepts and prevents default on DevTools injected startTime errors', () => {
            const error = new TypeError("Cannot read properties of undefined (reading 'startTime')")
            error.stack = `TypeError: Cannot read properties of undefined (reading 'startTime')
    at et.reportAllChanges (<anonymous>:2:19429)
    at n.timeout (<anonymous>:2:5652)`

            const event = new ErrorEvent('error', {
                cancelable: true,
                message: error.message,
                filename: 'VM309',
                error,
            })

            const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
            const stopPropagationSpy = vi.spyOn(event, 'stopImmediatePropagation')

            window.dispatchEvent(event)

            expect(preventDefaultSpy).toHaveBeenCalled()
            expect(stopPropagationSpy).toHaveBeenCalled()
        })

        it('allows unrelated application errors to pass through untouched', () => {
            const error = new Error('Application business logic error')
            const event = new ErrorEvent('error', {
                cancelable: true,
                message: error.message,
                filename: 'src/main.tsx',
                error,
            })

            const preventDefaultSpy = vi.spyOn(event, 'preventDefault')

            window.dispatchEvent(event)

            expect(preventDefaultSpy).not.toHaveBeenCalled()
        })

        it('properly removes event listener on cleanup', () => {
            const addSpy = vi.spyOn(window, 'addEventListener')
            const removeSpy = vi.spyOn(window, 'removeEventListener')

            const unregister = initInjectedErrorGuard()
            unregister()

            expect(removeSpy).toHaveBeenCalledWith('error', expect.any(Function), true)

            addSpy.mockRestore()
            removeSpy.mockRestore()
        })
    })
})
