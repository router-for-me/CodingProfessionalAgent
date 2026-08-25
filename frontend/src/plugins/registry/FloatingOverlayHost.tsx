import React, { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/cn'
import type { FloatingContribution, FloatingOffset, FloatingPlacement } from '@cpa/plugin-api'
import { rendererRegistry, RendererRegistry } from '../platform/rendererRegistry'
import { safePluginVisible } from '../platform/safePluginSurface'
import { SlotErrorBoundary } from './SlotErrorBoundary'

export interface FloatingCoords {
    top: number
    left: number
    transform: string
}

export interface FloatingOverlayHostProps {
    registry?: RendererRegistry
    context?: Record<string, unknown>
    className?: string
}

/**
 * Calculates top/left coordinates and CSS transform for a floating overlay given an anchor DOMRect.
 */
export function computeFloatingCoords(
    anchorRect: DOMRect,
    placement: FloatingPlacement = 'top-center',
    offset?: FloatingOffset
): FloatingCoords {
    const offsetX = offset?.x ?? 0
    const offsetY = offset?.y ?? 0

    switch (placement) {
        case 'top-center':
            return {
                top: anchorRect.top + offsetY,
                left: anchorRect.left + anchorRect.width / 2 + offsetX,
                transform: 'translate(-50%, -100%)',
            }
        case 'top-start':
            return {
                top: anchorRect.top + offsetY,
                left: anchorRect.left + offsetX,
                transform: 'translateY(-100%)',
            }
        case 'top-end':
            return {
                top: anchorRect.top + offsetY,
                left: anchorRect.right + offsetX,
                transform: 'translate(-100%, -100%)',
            }
        case 'bottom-center':
            return {
                top: anchorRect.bottom + offsetY,
                left: anchorRect.left + anchorRect.width / 2 + offsetX,
                transform: 'translateX(-50%)',
            }
        case 'bottom-start':
            return {
                top: anchorRect.bottom + offsetY,
                left: anchorRect.left + offsetX,
                transform: 'none',
            }
        case 'bottom-end':
            return {
                top: anchorRect.bottom + offsetY,
                left: anchorRect.right + offsetX,
                transform: 'translateX(-100%)',
            }
        case 'left-center':
            return {
                top: anchorRect.top + anchorRect.height / 2 + offsetY,
                left: anchorRect.left + offsetX,
                transform: 'translate(-100%, -50%)',
            }
        case 'right-center':
            return {
                top: anchorRect.top + anchorRect.height / 2 + offsetY,
                left: anchorRect.right + offsetX,
                transform: 'translateY(-50%)',
            }
        case 'cover':
            return {
                top: anchorRect.top + offsetY,
                left: anchorRect.left + anchorRect.width / 2 + offsetX,
                transform: 'translateX(-50%)',
            }
        case 'cover-bottom':
            return {
                top: anchorRect.bottom + offsetY,
                left: anchorRect.left + anchorRect.width / 2 + offsetX,
                transform: 'translate(-50%, -100%)',
            }
        default:
            return {
                top: anchorRect.top + offsetY,
                left: anchorRect.left + anchorRect.width / 2 + offsetX,
                transform: 'translate(-50%, -100%)',
            }
    }
}

/**
 * Determines whether an anchor element is currently visible in the DOM.
 */
export function isAnchorVisible(el: Element): boolean {
    if (!el.isConnected) {
        return false
    }

    if (typeof el.checkVisibility === 'function') {
        try {
            if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                return false
            }
        } catch {
            if (!el.checkVisibility()) {
                return false
            }
        }
    }

    // Check if element or any ancestor has hidden/inert/aria-hidden attribute or display: none / visibility: hidden / opacity: 0
    let curr: Element | null = el
    while (curr && curr !== document.body && curr !== document.documentElement) {
        if (
            curr.hasAttribute('hidden') ||
            curr.hasAttribute('inert') ||
            curr.getAttribute('aria-hidden') === 'true'
        ) {
            return false
        }
        if (curr instanceof HTMLElement) {
            if (
                curr.style.display === 'none' ||
                curr.style.visibility === 'hidden' ||
                curr.style.opacity === '0' ||
                curr.hidden
            ) {
                return false
            }
            if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                const style = window.getComputedStyle(curr)
                if (
                    style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.visibility === 'collapse' ||
                    style.opacity === '0'
                ) {
                    return false
                }
            }
        }
        curr = curr.parentElement
    }

    return true
}

/**
 * Safely queries the DOM for an anchor element.
 */
function findAnchorElement(selector: string): Element | null {
    if (typeof document === 'undefined') {
        return null
    }
    try {
        return document.querySelector(selector)
    } catch {
        return null
    }
}

/**
 * React hook that subscribes to floating overlay contributions in ExtensionRegistry.
 */
export function useFloatings<P = Record<string, unknown>>(
    registry: RendererRegistry = rendererRegistry
): FloatingContribution<P>[] {
    const subscribe = useCallback(
        (listener: () => void) => registry.subscribe('floatings', listener),
        [registry]
    )
    const getSnapshot = useCallback(
        () => registry.getFloatings<P>(),
        [registry]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

interface FloatingOverlayItemProps<P = Record<string, unknown>> {
    item: FloatingContribution<P>
    context?: Record<string, unknown>
}

/**
 * Individual floating overlay item positioned relative to its anchor element.
 */
function FloatingOverlayItem<P = Record<string, unknown>>({
    item,
    context,
}: FloatingOverlayItemProps<P>): React.ReactNode {
    const overlayRef = useRef<HTMLDivElement>(null)
    const [isWidthSufficient, setIsWidthSufficient] = useState(true)

    const [coords, setCoords] = useState<FloatingCoords | null>(() => {
        const anchorEl = findAnchorElement(item.anchor)
        if (!anchorEl || !isAnchorVisible(anchorEl)) {
            return null
        }
        return computeFloatingCoords(
            anchorEl.getBoundingClientRect(),
            item.placement,
            item.offset
        )
    })

    const updatePosition = useCallback(() => {
        const anchorEl = findAnchorElement(item.anchor)
        if (!anchorEl || !isAnchorVisible(anchorEl)) {
            setCoords((prev) => (prev === null ? prev : null))
            return
        }
        const rect = anchorEl.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) {
            // Anchor has collapsed / zero size
            setCoords((prev) => (prev === null ? prev : null))
            return
        }

        const nextCoords = computeFloatingCoords(
            rect,
            item.placement,
            item.offset
        )

        const overlayWidth = overlayRef.current ? overlayRef.current.offsetWidth : 0
        const sufficient = overlayWidth === 0 || rect.width >= overlayWidth - 4
        setIsWidthSufficient(sufficient)

        setCoords((prev) => {
            if (
                prev &&
                prev.top === nextCoords.top &&
                prev.left === nextCoords.left &&
                prev.transform === nextCoords.transform
            ) {
                return prev
            }
            return nextCoords
        })
    }, [item.anchor, item.placement, item.offset])

    useLayoutEffect(() => {
        let rafId: number | null = null
        let trackingRafId: number | null = null
        let trackingEndTime = 0
        let observedElement: Element | null = null
        let resizeObserver: ResizeObserver | null = null
        let mutationObserver: MutationObserver | null = null

        const scheduleUpdate = () => {
            if (rafId !== null) {
                return
            }
            rafId = requestAnimationFrame(() => {
                rafId = null
                updatePosition()
            })
        }

        const startTracking = (duration = 400) => {
            trackingEndTime = performance.now() + duration
            if (trackingRafId !== null) {
                return
            }
            const tick = () => {
                updatePosition()
                if (performance.now() < trackingEndTime) {
                    trackingRafId = requestAnimationFrame(tick)
                } else {
                    trackingRafId = null
                    updatePosition()
                }
            }
            trackingRafId = requestAnimationFrame(tick)
        }

        // Perform initial synchronous update
        updatePosition()

        const updateObservedAnchor = () => {
            if (!resizeObserver) {
                return
            }
            const currentAnchor = findAnchorElement(item.anchor)
            if (observedElement !== currentAnchor) {
                if (observedElement) {
                    resizeObserver.unobserve(observedElement)
                }
                if (currentAnchor) {
                    resizeObserver.observe(currentAnchor)
                    observedElement = currentAnchor
                } else {
                    observedElement = null
                }
            }
        }

        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => {
                startTracking(350)
            })
            const initialAnchor = findAnchorElement(item.anchor)
            if (initialAnchor) {
                resizeObserver.observe(initialAnchor)
                observedElement = initialAnchor
            }
        }

        const handleScrollOrResize = () => {
            scheduleUpdate()
        }

        const handleTransitionEvent = () => {
            startTracking(400)
        }

        const handleTransitionEnd = () => {
            updatePosition()
            startTracking(100)
        }

        window.addEventListener('resize', handleScrollOrResize, { passive: true })
        window.addEventListener('scroll', handleScrollOrResize, {
            capture: true,
            passive: true,
        })
        window.addEventListener('transitionrun', handleTransitionEvent, { passive: true })
        window.addEventListener('transitionstart', handleTransitionEvent, { passive: true })
        window.addEventListener('transitionend', handleTransitionEnd, { passive: true })
        window.addEventListener('transitioncancel', handleTransitionEnd, { passive: true })
        window.addEventListener('animationstart', handleTransitionEvent, { passive: true })
        window.addEventListener('animationend', handleTransitionEnd, { passive: true })

        if (typeof MutationObserver !== 'undefined') {
            mutationObserver = new MutationObserver((mutations) => {
                // Ignore mutations occurring inside our own floating overlay
                const hasRelevantMutation = mutations.some((mutation) => {
                    const target =
                        mutation.target instanceof Element
                            ? mutation.target
                            : mutation.target.parentElement
                    if (target && target.closest(`[data-floating-id="${item.id}"]`)) {
                        return false
                    }
                    return true
                })

                if (!hasRelevantMutation) {
                    return
                }

                updateObservedAnchor()
                startTracking(350)
            })

            const root = document.body ?? document.documentElement
            if (root) {
                mutationObserver.observe(root, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['id', 'style', 'class', 'hidden', 'aria-hidden', 'inert'],
                })
            }
        }

        return () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId)
                rafId = null
            }
            if (trackingRafId !== null) {
                cancelAnimationFrame(trackingRafId)
                trackingRafId = null
            }
            window.removeEventListener('resize', handleScrollOrResize)
            window.removeEventListener('scroll', handleScrollOrResize, {
                capture: true,
            })
            window.removeEventListener('transitionrun', handleTransitionEvent)
            window.removeEventListener('transitionstart', handleTransitionEvent)
            window.removeEventListener('transitionend', handleTransitionEnd)
            window.removeEventListener('transitioncancel', handleTransitionEnd)
            window.removeEventListener('animationstart', handleTransitionEvent)
            window.removeEventListener('animationend', handleTransitionEnd)
            if (observedElement && resizeObserver) {
                resizeObserver.unobserve(observedElement)
                observedElement = null
            }
            resizeObserver?.disconnect()
            mutationObserver?.disconnect()
        }
    }, [updatePosition, item.anchor, item.id])

    if (!coords) {
        return null
    }

    const Component = item.component

    return (
        <div
            ref={overlayRef}
            key={item.id}
            data-floating-id={item.id}
            style={{
                position: 'fixed',
                top: `${coords.top}px`,
                left: `${coords.left}px`,
                transform: coords.transform,
                zIndex: 50,
                pointerEvents: isWidthSufficient ? 'auto' : 'none',
                opacity: isWidthSufficient ? 1 : 0,
                visibility: isWidthSufficient ? 'visible' : 'hidden',
            }}
        >
            <SlotErrorBoundary id={`floating-${item.id}`} pluginId={item.pluginId}>
                <Component {...((context ?? {}) as React.JSX.IntrinsicAttributes & P)} />
            </SlotErrorBoundary>
        </div>
    )
}

/**
 * Universal host container for floating overlay contributions anchored to UI elements.
 */
export function FloatingOverlayHost({
    registry = rendererRegistry,
    context,
    className,
}: FloatingOverlayHostProps): React.ReactNode {
    const floatings = useFloatings(registry)

    const visibleFloatings = floatings.filter((item) => {
        return safePluginVisible(
            item.visible,
            context ?? {},
            item.pluginId,
            true
        )
    })

    if (visibleFloatings.length === 0) {
        return null
    }

    return (
        <div
            className={cn(
                'pointer-events-none fixed inset-0 z-50 overflow-hidden',
                className
            )}
        >
            {visibleFloatings.map((item) => (
                <FloatingOverlayItem
                    key={`${item.pluginId}:${item.id}`}
                    item={item}
                    context={context}
                />
            ))}
        </div>
    )
}
