/**
 * macOS-Style Non-System Overlay Scrollbar Manager.
 *
 * Implements macOS overlay scrollbar behavior globally:
 * - Appears smoothly ONLY when scrolling.
 * - Stays hidden when idle, even when mouse moves over the scrollbar location.
 * - Hides smoothly with a fade-out transition after scrolling stops.
 * - Expands and darkens when mouse hovers or drags the thumb while visible.
 * - Does not displace or reflow container layout.
 * - Replaces native browser scrollbars on all platforms.
 */

const TRACK_SIZE = 12
const THUMB_MIN_SIZE = 24
const HIDE_DELAY_MS = 800
const FADE_OUT_DURATION_MS = 350
const PADDING_INTERSECT = 12

export interface ScrollbarOptions {
    hideDelay?: number
    onActiveChange?: (active: boolean) => void
}

/**
 * Computes the visible bounding rect of an element, clipped by all overflow-hidden/scroll ancestors.
 */
export function getVisibleClippedRect(element: HTMLElement): DOMRect | null {
    if (!element.isConnected) {
        return null
    }

    let rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
        return null
    }

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight

    // Check against viewport
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) {
        return null
    }

    let currentLeft = Math.max(0, rect.left)
    let currentTop = Math.max(0, rect.top)
    let currentRight = Math.min(viewportWidth, rect.right)
    let currentBottom = Math.min(viewportHeight, rect.bottom)

    let parent = element.parentElement
    while (parent && parent !== document.body && parent !== document.documentElement) {
        const style = window.getComputedStyle(parent)
        const overflow = style.overflow
        const overflowY = style.overflowY || overflow
        const overflowX = style.overflowX || overflow

        const isClipping =
            overflow === 'hidden' ||
            overflow === 'auto' ||
            overflow === 'scroll' ||
            overflowY === 'hidden' ||
            overflowY === 'auto' ||
            overflowY === 'scroll' ||
            overflowX === 'hidden' ||
            overflowX === 'auto' ||
            overflowX === 'scroll'

        if (isClipping) {
            const parentRect = parent.getBoundingClientRect()
            currentLeft = Math.max(currentLeft, parentRect.left)
            currentTop = Math.max(currentTop, parentRect.top)
            currentRight = Math.min(currentRight, parentRect.right)
            currentBottom = Math.min(currentBottom, parentRect.bottom)

            if (currentBottom <= currentTop || currentRight <= currentLeft) {
                return null
            }
        }
        parent = parent.parentElement
    }

    return new DOMRect(currentLeft, currentTop, currentRight - currentLeft, currentBottom - currentTop)
}

/**
 * Determines whether a DOM element is a scrollable container that should have macOS scrollbars.
 */
export function isScrollableContainer(target: Element): target is HTMLElement {
    if (!(target instanceof HTMLElement)) {
        return false
    }

    // Skip form inputs that handle single-line text or custom-suppressed scrollbars
    if (
        target instanceof HTMLInputElement ||
        target.tagName === 'INPUT' ||
        target.classList.contains('no-scrollbar') ||
        target.classList.contains('scrollbar-none')
    ) {
        return false
    }

    // Check if target is part of our custom scrollbars overlay host
    if (target.closest('#cpa-mac-scrollbars-host')) {
        return false
    }

    const style = window.getComputedStyle(target)
    const overflow = style.overflow
    const overflowY = style.overflowY || overflow
    const overflowX = style.overflowX || overflow

    const canScrollY =
        (overflowY === 'auto' || overflowY === 'scroll' || overflow === 'auto' || overflow === 'scroll') &&
        target.scrollHeight > target.clientHeight + 1
    const canScrollX =
        (overflowX === 'auto' || overflowX === 'scroll' || overflow === 'auto' || overflow === 'scroll') &&
        target.scrollWidth > target.clientWidth + 1

    return canScrollY || canScrollX
}

export class MacScrollbarInstance {
    private readonly target: HTMLElement
    private readonly host: HTMLElement
    private readonly hideDelay: number
    private readonly onActiveChange?: (active: boolean) => void

    private trackY: HTMLDivElement | null = null
    private thumbY: HTMLDivElement | null = null
    private trackX: HTMLDivElement | null = null
    private thumbX: HTMLDivElement | null = null

    private isVisible = false
    private isActive = false
    private isHoveredY = false
    private isHoveredX = false
    private isDraggingY = false
    private isDraggingX = false

    private hideTimer: ReturnType<typeof setTimeout> | null = null
    private fadeTimer: ReturnType<typeof setTimeout> | null = null
    private dragMoveCleanup: (() => void) | null = null

    constructor(target: HTMLElement, host: HTMLElement, options?: ScrollbarOptions) {
        this.target = target
        this.host = host
        this.hideDelay = options?.hideDelay ?? HIDE_DELAY_MS
        this.onActiveChange = options?.onActiveChange
        this.createElements()
    }

    private createElements(): void {
        // Vertical track & thumb
        const trackY = document.createElement('div')
        trackY.className = 'cpa-mac-scrollbar cpa-mac-scrollbar--vertical'
        const thumbY = document.createElement('div')
        thumbY.className = 'cpa-mac-scrollbar-thumb'
        trackY.appendChild(thumbY)

        // Horizontal track & thumb
        const trackX = document.createElement('div')
        trackX.className = 'cpa-mac-scrollbar cpa-mac-scrollbar--horizontal'
        const thumbX = document.createElement('div')
        thumbX.className = 'cpa-mac-scrollbar-thumb'
        trackX.appendChild(thumbX)

        this.trackY = trackY
        this.thumbY = thumbY
        this.trackX = trackX
        this.thumbX = thumbX

        this.host.appendChild(trackY)
        this.host.appendChild(trackX)

        this.bindEvents()
    }

    private bindEvents(): void {
        if (!this.trackY || !this.thumbY || !this.trackX || !this.thumbX) {
            return
        }

        // Vertical hover events (only active when scrollbar is visible)
        this.trackY.addEventListener('pointerenter', () => {
            if (!this.isVisible) return
            this.isHoveredY = true
            this.trackY?.classList.add('cpa-mac-scrollbar--hover')
            this.clearHideTimer()
        })
        this.trackY.addEventListener('pointerleave', () => {
            this.isHoveredY = false
            this.trackY?.classList.remove('cpa-mac-scrollbar--hover')
            if (!this.isDraggingY && !this.isHoveredX && this.isVisible) {
                this.scheduleHide()
            }
        })

        // Horizontal hover events (only active when scrollbar is visible)
        this.trackX.addEventListener('pointerenter', () => {
            if (!this.isVisible) return
            this.isHoveredX = true
            this.trackX?.classList.add('cpa-mac-scrollbar--hover')
            this.clearHideTimer()
        })
        this.trackX.addEventListener('pointerleave', () => {
            this.isHoveredX = false
            this.trackX?.classList.remove('cpa-mac-scrollbar--hover')
            if (!this.isDraggingX && !this.isHoveredY && this.isVisible) {
                this.scheduleHide()
            }
        })

        // Vertical dragging
        this.thumbY.addEventListener('pointerdown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.startDraggingY(e)
        })

        // Horizontal dragging
        this.thumbX.addEventListener('pointerdown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.startDraggingX(e)
        })

        // Vertical track click (page up/down)
        this.trackY.addEventListener('pointerdown', (e) => {
            if (e.target === this.thumbY) return
            e.preventDefault()
            e.stopPropagation()
            const trackRect = this.trackY?.getBoundingClientRect()
            const thumbRect = this.thumbY?.getBoundingClientRect()
            if (!trackRect || !thumbRect) return

            if (e.clientY < thumbRect.top) {
                this.target.scrollTop -= this.target.clientHeight * 0.9
            } else if (e.clientY > thumbRect.bottom) {
                this.target.scrollTop += this.target.clientHeight * 0.9
            }
            this.update()
            this.scheduleHide()
        })

        // Horizontal track click
        this.trackX.addEventListener('pointerdown', (e) => {
            if (e.target === this.thumbX) return
            e.preventDefault()
            e.stopPropagation()
            const trackRect = this.trackX?.getBoundingClientRect()
            const thumbRect = this.thumbX?.getBoundingClientRect()
            if (!trackRect || !thumbRect) return

            if (e.clientX < thumbRect.left) {
                this.target.scrollLeft -= this.target.clientWidth * 0.9
            } else if (e.clientX > thumbRect.right) {
                this.target.scrollLeft += this.target.clientWidth * 0.9
            }
            this.update()
            this.scheduleHide()
        })
    }

    private startDraggingY(e: PointerEvent): void {
        this.isDraggingY = true
        this.clearHideTimer()
        this.trackY?.classList.add('cpa-mac-scrollbar--dragging')

        const startMouseY = e.clientY
        const startScrollTop = this.target.scrollTop
        const maxScroll = this.target.scrollHeight - this.target.clientHeight

        const trackRect = this.trackY?.getBoundingClientRect()
        const thumbRect = this.thumbY?.getBoundingClientRect()
        const trackHeight = trackRect?.height ?? 1
        const thumbHeight = thumbRect?.height ?? THUMB_MIN_SIZE
        const trackAvailable = Math.max(1, trackHeight - thumbHeight - 6)

        const onPointerMove = (moveEvent: PointerEvent) => {
            const deltaY = moveEvent.clientY - startMouseY
            const scrollDelta = (deltaY / trackAvailable) * maxScroll
            this.target.scrollTop = Math.max(0, Math.min(maxScroll, startScrollTop + scrollDelta))
            this.update()
        }

        const onPointerUp = () => {
            this.isDraggingY = false
            this.trackY?.classList.remove('cpa-mac-scrollbar--dragging')
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
            this.dragMoveCleanup = null
            this.scheduleHide()
        }

        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)

        this.dragMoveCleanup = () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
        }
    }

    private startDraggingX(e: PointerEvent): void {
        this.isDraggingX = true
        this.clearHideTimer()
        this.trackX?.classList.add('cpa-mac-scrollbar--dragging')

        const startMouseX = e.clientX
        const startScrollLeft = this.target.scrollLeft
        const maxScroll = this.target.scrollWidth - this.target.clientWidth

        const trackRect = this.trackX?.getBoundingClientRect()
        const thumbRect = this.thumbX?.getBoundingClientRect()
        const trackWidth = trackRect?.width ?? 1
        const thumbWidth = thumbRect?.width ?? THUMB_MIN_SIZE
        const trackAvailable = Math.max(1, trackWidth - thumbWidth - 6)

        const onPointerMove = (moveEvent: PointerEvent) => {
            const deltaX = moveEvent.clientX - startMouseX
            const scrollDelta = (deltaX / trackAvailable) * maxScroll
            this.target.scrollLeft = Math.max(0, Math.min(maxScroll, startScrollLeft + scrollDelta))
            this.update()
        }

        const onPointerUp = () => {
            this.isDraggingX = false
            this.trackX?.classList.remove('cpa-mac-scrollbar--dragging')
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
            this.dragMoveCleanup = null
            this.scheduleHide()
        }

        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerUp)

        this.dragMoveCleanup = () => {
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('pointerup', onPointerUp)
            window.removeEventListener('pointercancel', onPointerUp)
        }
    }

    public update(): void {
        if (!this.trackY || !this.thumbY || !this.trackX || !this.thumbX) {
            return
        }

        if (!this.target.isConnected) {
            this.hide()
            return
        }

        const visibleRect = getVisibleClippedRect(this.target)
        if (!visibleRect) {
            this.hide()
            return
        }

        const canScrollY = this.target.scrollHeight > this.target.clientHeight + 1
        const canScrollX = this.target.scrollWidth > this.target.clientWidth + 1

        if (!canScrollY && !canScrollX) {
            this.hide()
            return
        }

        // Update vertical scrollbar
        if (canScrollY) {
            const trackHeight = Math.max(0, visibleRect.height - (canScrollX ? PADDING_INTERSECT : 0))
            const thumbHeight = Math.max(
                THUMB_MIN_SIZE,
                Math.round((this.target.clientHeight / this.target.scrollHeight) * trackHeight),
            )
            const maxScrollY = Math.max(1, this.target.scrollHeight - this.target.clientHeight)
            const ratioY = Math.max(0, Math.min(1, this.target.scrollTop / maxScrollY))
            const thumbY = Math.round(ratioY * Math.max(0, trackHeight - thumbHeight - 6))

            this.trackY.style.display = 'block'
            this.trackY.style.top = `${visibleRect.top}px`
            this.trackY.style.left = `${visibleRect.right - TRACK_SIZE}px`
            this.trackY.style.height = `${trackHeight}px`

            this.thumbY.style.height = `${thumbHeight}px`
            this.thumbY.style.transform = `translate3d(0, ${thumbY}px, 0)`
        } else {
            this.trackY.style.display = 'none'
        }

        // Update horizontal scrollbar
        if (canScrollX) {
            const trackWidth = Math.max(0, visibleRect.width - (canScrollY ? PADDING_INTERSECT : 0))
            const thumbWidth = Math.max(
                THUMB_MIN_SIZE,
                Math.round((this.target.clientWidth / this.target.scrollWidth) * trackWidth),
            )
            const maxScrollX = Math.max(1, this.target.scrollWidth - this.target.clientWidth)
            const ratioX = Math.max(0, Math.min(1, this.target.scrollLeft / maxScrollX))
            const thumbX = Math.round(ratioX * Math.max(0, trackWidth - thumbWidth - 6))

            this.trackX.style.display = 'block'
            this.trackX.style.top = `${visibleRect.bottom - TRACK_SIZE}px`
            this.trackX.style.left = `${visibleRect.left}px`
            this.trackX.style.width = `${trackWidth}px`

            this.thumbX.style.width = `${thumbWidth}px`
            this.thumbX.style.transform = `translate3d(${thumbX}px, 0, 0)`
        } else {
            this.trackX.style.display = 'none'
        }
    }

    public show(): void {
        this.clearHideTimer()
        this.clearFadeTimer()

        if (!this.isActive) {
            this.isActive = true
            this.onActiveChange?.(true)
        }

        this.update()

        if (!this.isVisible) {
            this.isVisible = true
            this.trackY?.classList.add('cpa-mac-scrollbar--visible')
            this.trackX?.classList.add('cpa-mac-scrollbar--visible')
        }

        this.scheduleHide()
    }

    public hide(immediate = false): void {
        this.clearHideTimer()
        this.clearFadeTimer()

        this.isVisible = false
        this.trackY?.classList.remove('cpa-mac-scrollbar--visible', 'cpa-mac-scrollbar--hover')
        this.trackX?.classList.remove('cpa-mac-scrollbar--visible', 'cpa-mac-scrollbar--hover')

        if (immediate) {
            if (this.isActive) {
                this.isActive = false
                this.onActiveChange?.(false)
            }
        } else {
            this.startFadeOut()
        }
    }

    private startFadeOut(): void {
        this.clearFadeTimer()

        // Keep active and tracking positions during the fade-out duration so it stays locked to edge
        this.fadeTimer = setTimeout(() => {
            this.fadeTimer = null
            if (!this.isVisible && this.isActive) {
                this.isActive = false
                this.onActiveChange?.(false)
            }
        }, FADE_OUT_DURATION_MS)
    }

    private clearHideTimer(): void {
        if (this.hideTimer !== null) {
            clearTimeout(this.hideTimer)
            this.hideTimer = null
        }
    }

    private clearFadeTimer(): void {
        if (this.fadeTimer !== null) {
            clearTimeout(this.fadeTimer)
            this.fadeTimer = null
        }
    }

    private scheduleHide(): void {
        this.clearHideTimer()
        if (this.isHoveredY || this.isHoveredX || this.isDraggingY || this.isDraggingX) {
            return
        }

        this.hideTimer = setTimeout(() => {
            this.hide(false)
        }, this.hideDelay)
    }

    public destroy(): void {
        this.clearHideTimer()
        this.clearFadeTimer()
        if (this.isActive) {
            this.isActive = false
            this.onActiveChange?.(false)
        }
        if (this.dragMoveCleanup) {
            this.dragMoveCleanup()
            this.dragMoveCleanup = null
        }
        this.trackY?.remove()
        this.trackX?.remove()
        this.trackY = null
        this.thumbY = null
        this.trackX = null
        this.thumbX = null
    }

    public getIsVisible(): boolean {
        return this.isVisible
    }

    public getIsActive(): boolean {
        return this.isActive
    }
}

export class MacScrollbarManager {
    private host: HTMLElement | null = null
    private readonly instances = new Map<HTMLElement, MacScrollbarInstance>()
    private readonly activeInstances = new Set<MacScrollbarInstance>()
    private mutationObserver: MutationObserver | null = null
    private resizeObserver: ResizeObserver | null = null
    private scheduledFrameId: number | null = null
    private trackingFrameId: number | null = null
    private dirtyInstances = new Set<MacScrollbarInstance>()

    public init(): () => void {
        if (typeof document === 'undefined' || typeof window === 'undefined') {
            return () => {}
        }

        this.ensureHost()
        this.initResizeObserver()
        this.bindGlobalListeners()
        this.observeDom()

        return () => {
            this.destroy()
        }
    }

    private initResizeObserver(): void {
        if (typeof ResizeObserver === 'undefined') {
            return
        }

        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const target = entry.target as HTMLElement
                const instance = this.instances.get(target)
                if (instance && instance.getIsActive()) {
                    instance.update()
                }
            }
        })
    }

    private ensureHost(): HTMLElement {
        if (!this.host || !this.host.isConnected) {
            let host = document.getElementById('cpa-mac-scrollbars-host')
            if (!host) {
                host = document.createElement('div')
                host.id = 'cpa-mac-scrollbars-host'
                host.setAttribute('data-cpa-isolated', 'true')
                host.setAttribute('aria-hidden', 'true')
                document.body.appendChild(host)
            }
            this.host = host
        }
        return this.host
    }

    private getOrCreateInstance(element: HTMLElement): MacScrollbarInstance {
        const existing = this.instances.get(element)
        if (existing) {
            return existing
        }

        const host = this.ensureHost()
        const newInstance: MacScrollbarInstance = new MacScrollbarInstance(element, host, {
            onActiveChange: (active) => {
                if (active) {
                    this.activeInstances.add(newInstance)
                    this.startTrackingLoop()
                } else {
                    this.activeInstances.delete(newInstance)
                }
            },
        })
        this.instances.set(element, newInstance)
        this.resizeObserver?.observe(element)
        return newInstance
    }

    private startTrackingLoop(): void {
        if (this.trackingFrameId !== null) {
            return
        }

        const step = () => {
            if (this.activeInstances.size === 0) {
                this.trackingFrameId = null
                return
            }

            for (const instance of this.activeInstances) {
                instance.update()
            }

            this.trackingFrameId = window.requestAnimationFrame(step)
        }

        this.trackingFrameId = window.requestAnimationFrame(step)
    }

    private bindGlobalListeners(): void {
        // Global capture of scroll events - scrollbars appear only upon scrolling
        document.addEventListener('scroll', this.handleScroll, { capture: true, passive: true })
        // Window resize
        window.addEventListener('resize', this.handleResize, { passive: true })
    }

    private readonly handleScroll = (event: Event): void => {
        const rawTarget = event.target as Element | Document | null
        const target: Element | null =
            rawTarget === document
                ? document.documentElement
                : rawTarget instanceof Element
                  ? rawTarget
                  : null

        if (!target || !isScrollableContainer(target)) {
            return
        }

        const instance = this.getOrCreateInstance(target)
        instance.show()

        this.dirtyInstances.add(instance)
        this.requestUpdateBatch()
    }

    private readonly handleResize = (): void => {
        for (const instance of this.instances.values()) {
            if (instance.getIsVisible()) {
                this.dirtyInstances.add(instance)
            }
        }
        this.requestUpdateBatch()
    }

    private requestUpdateBatch(): void {
        if (this.scheduledFrameId !== null) {
            return
        }

        this.scheduledFrameId = window.requestAnimationFrame(() => {
            this.scheduledFrameId = null
            for (const instance of this.dirtyInstances) {
                instance.update()
            }
            this.dirtyInstances.clear()
        })
    }

    private observeDom(): void {
        this.mutationObserver = new MutationObserver(() => {
            // Clean up instances whose target elements were removed from DOM
            for (const [element, instance] of this.instances.entries()) {
                if (!element.isConnected) {
                    this.resizeObserver?.unobserve(element)
                    instance.destroy()
                    this.instances.delete(element)
                    this.activeInstances.delete(instance)
                    this.dirtyInstances.delete(instance)
                }
            }
            if (this.activeInstances.size === 0 && this.trackingFrameId !== null) {
                window.cancelAnimationFrame(this.trackingFrameId)
                this.trackingFrameId = null
            }
        })

        this.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
        })
    }

    public destroy(): void {
        document.removeEventListener('scroll', this.handleScroll, { capture: true })
        window.removeEventListener('resize', this.handleResize)

        if (this.mutationObserver) {
            this.mutationObserver.disconnect()
            this.mutationObserver = null
        }

        if (this.resizeObserver) {
            this.resizeObserver.disconnect()
            this.resizeObserver = null
        }

        if (this.scheduledFrameId !== null) {
            window.cancelAnimationFrame(this.scheduledFrameId)
            this.scheduledFrameId = null
        }

        if (this.trackingFrameId !== null) {
            window.cancelAnimationFrame(this.trackingFrameId)
            this.trackingFrameId = null
        }

        for (const instance of this.instances.values()) {
            instance.destroy()
        }
        this.instances.clear()
        this.activeInstances.clear()
        this.dirtyInstances.clear()

        if (this.host && this.host.parentNode) {
            this.host.parentNode.removeChild(this.host)
            this.host = null
        }

        if (activeManager === this) {
            activeManager = null
        }
    }

    public getInstanceCount(): number {
        return this.instances.size
    }
}

let activeManager: MacScrollbarManager | null = null

/**
 * Initializes global macOS overlay scrollbars across the application.
 */
export function initMacScrollbars(): () => void {
    if (activeManager) {
        return () => {
            activeManager?.destroy()
            activeManager = null
        }
    }

    activeManager = new MacScrollbarManager()
    const cleanup = activeManager.init()

    return () => {
        cleanup()
        activeManager = null
    }
}

export function getMacScrollbarManager(): MacScrollbarManager | null {
    return activeManager
}
