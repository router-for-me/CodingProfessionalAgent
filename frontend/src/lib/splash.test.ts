import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissSplashScreen } from './splash'

describe('dismissSplashScreen', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        document.body.innerHTML = ''
    })

    afterEach(() => {
        vi.useRealTimers()
        document.body.innerHTML = ''
    })

    it('does nothing when splash element is not present', () => {
        expect(() => dismissSplashScreen()).not.toThrow()
    })

    it('adds splash-fade-out class and removes element on transitionend', () => {
        const splash = document.createElement('div')
        splash.id = 'startup-splash'
        document.body.appendChild(splash)

        dismissSplashScreen()

        expect(splash.classList.contains('splash-fade-out')).toBe(true)
        expect(document.getElementById('startup-splash')).toBe(splash)

        splash.dispatchEvent(new Event('transitionend'))

        expect(document.getElementById('startup-splash')).toBeNull()
    })

    it('removes splash element via fallback timer if transitionend does not fire', () => {
        const splash = document.createElement('div')
        splash.id = 'startup-splash'
        document.body.appendChild(splash)

        dismissSplashScreen()

        expect(document.getElementById('startup-splash')).toBe(splash)

        vi.advanceTimersByTime(550)

        expect(document.getElementById('startup-splash')).toBeNull()
    })

    it('is idempotent when called multiple times', () => {
        const splash = document.createElement('div')
        splash.id = 'startup-splash'
        document.body.appendChild(splash)

        dismissSplashScreen()
        dismissSplashScreen()

        expect(splash.classList.contains('splash-fade-out')).toBe(true)
        splash.dispatchEvent(new Event('transitionend'))
        expect(document.getElementById('startup-splash')).toBeNull()
    })
})
