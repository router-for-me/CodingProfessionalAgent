import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
    getVisibleClippedRect,
    isScrollableContainer,
    MacScrollbarInstance,
    initMacScrollbars,
    getMacScrollbarManager,
} from './macScrollbar'

describe('macScrollbar', () => {
    let container: HTMLDivElement

    beforeEach(() => {
        vi.useFakeTimers()
        container = document.createElement('div')
        document.body.appendChild(container)
    })

    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllTimers()
        const manager = getMacScrollbarManager()
        if (manager) {
            manager.destroy()
        }
        container.remove()
        const host = document.getElementById('cpa-mac-scrollbars-host')
        if (host) {
            host.remove()
        }
    })

    describe('getVisibleClippedRect', () => {
        it('returns null if element is not connected to DOM', () => {
            const disconnected = document.createElement('div')
            expect(getVisibleClippedRect(disconnected)).toBeNull()
        })

        it('returns bounding rect if element is visible and within viewport', () => {
            const target = document.createElement('div')
            container.appendChild(target)
            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(10, 20, 200, 300),
            )

            const rect = getVisibleClippedRect(target)
            expect(rect).not.toBeNull()
            expect(rect?.left).toBe(10)
            expect(rect?.top).toBe(20)
            expect(rect?.width).toBe(200)
            expect(rect?.height).toBe(300)
        })

        it('clips rect against parent overflow container', () => {
            const parent = document.createElement('div')
            parent.style.overflow = 'hidden'
            const target = document.createElement('div')
            parent.appendChild(target)
            container.appendChild(parent)

            vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(10, 10, 100, 100),
            )
            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 200, 200),
            )

            const rect = getVisibleClippedRect(target)
            expect(rect).not.toBeNull()
            expect(rect?.left).toBe(10)
            expect(rect?.top).toBe(10)
            expect(rect?.width).toBe(100)
            expect(rect?.height).toBe(100)
        })
    })

    describe('isScrollableContainer', () => {
        it('identifies scrollable element with overflow-y', () => {
            const scrollable = document.createElement('div')
            scrollable.style.overflowY = 'auto'
            Object.defineProperty(scrollable, 'scrollHeight', { value: 500, configurable: true })
            Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true })
            container.appendChild(scrollable)

            expect(isScrollableContainer(scrollable)).toBe(true)
        })

        it('ignores input elements', () => {
            const input = document.createElement('input')
            input.style.overflowY = 'auto'
            Object.defineProperty(input, 'scrollHeight', { value: 500, configurable: true })
            Object.defineProperty(input, 'clientHeight', { value: 200, configurable: true })
            container.appendChild(input)

            expect(isScrollableContainer(input)).toBe(false)
        })

        it('ignores elements marked with no-scrollbar or scrollbar-none', () => {
            const scrollable = document.createElement('div')
            scrollable.className = 'no-scrollbar'
            scrollable.style.overflowY = 'auto'
            Object.defineProperty(scrollable, 'scrollHeight', { value: 500, configurable: true })
            Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true })
            container.appendChild(scrollable)

            expect(isScrollableContainer(scrollable)).toBe(false)

            scrollable.className = 'scrollbar-none'
            expect(isScrollableContainer(scrollable)).toBe(false)
        })
    })

    describe('MacScrollbarInstance', () => {
        it('creates vertical and horizontal tracks and thumbs', () => {
            const host = document.createElement('div')
            document.body.appendChild(host)

            const target = document.createElement('div')
            target.style.overflow = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 600, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 200, configurable: true })
            Object.defineProperty(target, 'scrollWidth', { value: 800, configurable: true })
            Object.defineProperty(target, 'clientWidth', { value: 300, configurable: true })
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(50, 50, 300, 200),
            )

            const instance = new MacScrollbarInstance(target, host, { hideDelay: 500 })
            instance.show()

            expect(instance.getIsVisible()).toBe(true)
            const tracks = host.querySelectorAll('.cpa-mac-scrollbar')
            expect(tracks.length).toBe(2)

            // Test auto-hide after delay
            vi.advanceTimersByTime(600)
            expect(instance.getIsVisible()).toBe(false)

            instance.destroy()
            host.remove()
        })

        it('drags horizontal thumb and updates scrollLeft', () => {
            const host = document.createElement('div')
            document.body.appendChild(host)

            const target = document.createElement('div')
            target.style.overflowX = 'auto'
            Object.defineProperty(target, 'scrollWidth', { value: 1000, configurable: true })
            Object.defineProperty(target, 'clientWidth', { value: 200, configurable: true })
            target.scrollLeft = 0
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 200, 400),
            )

            const instance = new MacScrollbarInstance(target, host)
            instance.show()

            const trackX = host.querySelector('.cpa-mac-scrollbar--horizontal') as HTMLDivElement
            const thumbX = trackX.querySelector('.cpa-mac-scrollbar-thumb') as HTMLDivElement

            vi.spyOn(trackX, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 388, 200, 12),
            )
            vi.spyOn(thumbX, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 391, 40, 6),
            )

            // Simulate pointerdown on thumb
            const pointerDownEvent = new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                clientX: 10,
            })
            thumbX.dispatchEvent(pointerDownEvent)

            // Simulate pointermove on window
            const pointerMoveEvent = new PointerEvent('pointermove', {
                bubbles: true,
                cancelable: true,
                clientX: 50,
            })
            window.dispatchEvent(pointerMoveEvent)

            expect(target.scrollLeft).toBeGreaterThan(0)

            // Simulate pointerup
            const pointerUpEvent = new PointerEvent('pointerup', {
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(pointerUpEvent)

            instance.destroy()
            host.remove()
        })

        it('scrolls page up and down when clicking on track', () => {
            const host = document.createElement('div')
            document.body.appendChild(host)

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 1000, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 200, configurable: true })
            target.scrollTop = 300
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 400, 200),
            )

            const instance = new MacScrollbarInstance(target, host)
            instance.show()

            const trackY = host.querySelector('.cpa-mac-scrollbar--vertical') as HTMLDivElement
            const thumbY = trackY.querySelector('.cpa-mac-scrollbar-thumb') as HTMLDivElement

            vi.spyOn(trackY, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(388, 0, 12, 200),
            )
            vi.spyOn(thumbY, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(391, 80, 6, 40),
            )

            // Click above thumb -> scrolls up
            trackY.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                clientY: 20,
            }))
            expect(target.scrollTop).toBeLessThan(300)

            // Click below thumb -> scrolls down
            const previousScrollTop = target.scrollTop
            trackY.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                clientY: 150,
            }))
            expect(target.scrollTop).toBeGreaterThan(previousScrollTop)

            instance.destroy()
            host.remove()
        })

        it('stays visible on hover and hides when unhovered', () => {
            const host = document.createElement('div')
            document.body.appendChild(host)

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 600, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 200, configurable: true })
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 300, 200),
            )

            const instance = new MacScrollbarInstance(target, host, { hideDelay: 300 })
            instance.show()
            expect(instance.getIsVisible()).toBe(true)

            const trackY = host.querySelector('.cpa-mac-scrollbar--vertical') as HTMLDivElement

            // Hover over track
            trackY.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }))
            expect(trackY.classList.contains('cpa-mac-scrollbar--hover')).toBe(true)

            // Advance time past hide delay, should remain visible due to hover
            vi.advanceTimersByTime(400)
            expect(instance.getIsVisible()).toBe(true)

            // Leave hover
            trackY.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))
            expect(trackY.classList.contains('cpa-mac-scrollbar--hover')).toBe(false)

            // Now advance time, should hide
            vi.advanceTimersByTime(350)
            expect(instance.getIsVisible()).toBe(false)

            instance.destroy()
            host.remove()
        })

        it('drags vertical thumb and updates scrollTop', () => {
            const host = document.createElement('div')
            document.body.appendChild(host)

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 1000, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 200, configurable: true })
            target.scrollTop = 0
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 400, 200),
            )

            const instance = new MacScrollbarInstance(target, host)
            instance.show()

            const trackY = host.querySelector('.cpa-mac-scrollbar--vertical') as HTMLDivElement
            const thumbY = trackY.querySelector('.cpa-mac-scrollbar-thumb') as HTMLDivElement

            vi.spyOn(trackY, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(388, 0, 12, 200),
            )
            vi.spyOn(thumbY, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(391, 0, 6, 40),
            )

            // Simulate pointerdown on thumb
            const pointerDownEvent = new PointerEvent('pointerdown', {
                bubbles: true,
                cancelable: true,
                clientY: 10,
            })
            thumbY.dispatchEvent(pointerDownEvent)

            // Simulate pointermove on window
            const pointerMoveEvent = new PointerEvent('pointermove', {
                bubbles: true,
                cancelable: true,
                clientY: 50,
            })
            window.dispatchEvent(pointerMoveEvent)

            expect(target.scrollTop).toBeGreaterThan(0)

            // Simulate pointerup
            const pointerUpEvent = new PointerEvent('pointerup', {
                bubbles: true,
                cancelable: true,
            })
            window.dispatchEvent(pointerUpEvent)

            instance.destroy()
            host.remove()
        })
    })

    describe('MacScrollbarManager', () => {
        it('initializes and cleans up global overlay host', () => {
            const cleanup = initMacScrollbars()
            const host = document.getElementById('cpa-mac-scrollbars-host')
            expect(host).not.toBeNull()

            cleanup()
            expect(document.getElementById('cpa-mac-scrollbars-host')).toBeNull()
        })

        it('detects scroll event and creates scrollbar instance', () => {
            initMacScrollbars()
            const manager = getMacScrollbarManager()!

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 800, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 300, configurable: true })
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 400, 300),
            )

            target.dispatchEvent(new Event('scroll', { bubbles: true }))

            expect(manager.getInstanceCount()).toBe(1)
        })

        it('cleans up instance when element is removed from DOM', async () => {
            initMacScrollbars()
            const manager = getMacScrollbarManager()!

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 800, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 300, configurable: true })
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 400, 300),
            )

            target.dispatchEvent(new Event('scroll', { bubbles: true }))
            expect(manager.getInstanceCount()).toBe(1)

            // Remove target element from container
            target.remove()

            // Advance timers / wait for MutationObserver callback
            vi.advanceTimersByTime(50)
            await Promise.resolve()

            // Manager should clean up the disconnected instance
            expect(manager.getInstanceCount()).toBe(0)
        })

        it('does NOT wake scrollbar when pointer moves over element or edge when idle', () => {
            initMacScrollbars()
            const manager = getMacScrollbarManager()!

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 800, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 300, configurable: true })
            container.appendChild(target)

            vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(
                new DOMRect(0, 0, 400, 300),
            )

            // Moving pointer near edge when idle should NOT wake or create scrollbar
            target.dispatchEvent(
                new PointerEvent('pointermove', {
                    bubbles: true,
                    clientX: 395,
                    clientY: 100,
                }),
            )
            expect(manager.getInstanceCount()).toBe(0)

            // ONLY scrolling wakes the scrollbar
            target.dispatchEvent(new Event('scroll', { bubbles: true }))
            expect(manager.getInstanceCount()).toBe(1)
        })

        it('locks to edge and dynamically updates position when container is resized or dragged', () => {
            initMacScrollbars()

            const target = document.createElement('div')
            target.style.overflowY = 'auto'
            Object.defineProperty(target, 'scrollHeight', { value: 800, configurable: true })
            Object.defineProperty(target, 'clientHeight', { value: 300, configurable: true })
            container.appendChild(target)

            let targetRight = 280
            vi.spyOn(target, 'getBoundingClientRect').mockImplementation(
                () => new DOMRect(0, 0, targetRight, 300),
            )

            // Trigger scroll to show scrollbar
            target.dispatchEvent(new Event('scroll', { bubbles: true }))

            const host = document.getElementById('cpa-mac-scrollbars-host')!
            const trackY = host.querySelector('.cpa-mac-scrollbar--vertical') as HTMLDivElement
            expect(trackY).not.toBeNull()
            expect(trackY.style.left).toBe(`${280 - 12}px`)

            // User drags sidebar, resizing container width from 280 to 360
            targetRight = 360

            // Trigger animation frame tracking
            vi.advanceTimersByTime(16)

            // Scrollbar track should lock to new right edge (360 - 12 = 348px)
            expect(trackY.style.left).toBe(`${360 - 12}px`)

            // Drag sidebar again to 220px during hide countdown
            targetRight = 220
            vi.advanceTimersByTime(400)
            expect(trackY.style.left).toBe(`${220 - 12}px`)

            // Even during fade-out transition, it should stay locked to the right edge
            vi.advanceTimersByTime(500) // past 800ms hideDelay, into fade-out
            targetRight = 250
            vi.advanceTimersByTime(16)
            expect(trackY.style.left).toBe(`${250 - 12}px`)
        })
    })
})
