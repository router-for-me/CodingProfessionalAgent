import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor, renderHook } from '@testing-library/react'
import React from 'react'
import { RendererRegistry } from '../platform/rendererRegistry'
import {
    FloatingOverlayHost,
    computeFloatingCoords,
    isAnchorVisible,
    useFloatings,
} from './FloatingOverlayHost'
import type { FloatingContribution } from '@cpa/plugin-api'

describe('FloatingOverlayHost & computeFloatingCoords', () => {
    let registry: RendererRegistry
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    const sampleRect: DOMRect = {
        top: 100,
        left: 200,
        right: 300,
        bottom: 150,
        width: 100,
        height: 50,
        x: 200,
        y: 100,
        toJSON: () => ({}),
    }

    beforeEach(() => {
        registry = new RendererRegistry()
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        registry.clear()
        consoleErrorSpy.mockRestore()
        document.body.innerHTML = ''
    })

    describe('computeFloatingCoords positioning math', () => {
        it('calculates top-center correctly (default)', () => {
            const coords = computeFloatingCoords(sampleRect, 'top-center')
            expect(coords).toEqual({
                top: 100,
                left: 250, // 200 + 100/2
                transform: 'translate(-50%, -100%)',
            })
        })

        it('calculates top-start correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'top-start')
            expect(coords).toEqual({
                top: 100,
                left: 200,
                transform: 'translateY(-100%)',
            })
        })

        it('calculates top-end correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'top-end')
            expect(coords).toEqual({
                top: 100,
                left: 300,
                transform: 'translate(-100%, -100%)',
            })
        })

        it('calculates bottom-center correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'bottom-center')
            expect(coords).toEqual({
                top: 150,
                left: 250,
                transform: 'translateX(-50%)',
            })
        })

        it('calculates bottom-start correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'bottom-start')
            expect(coords).toEqual({
                top: 150,
                left: 200,
                transform: 'none',
            })
        })

        it('calculates bottom-end correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'bottom-end')
            expect(coords).toEqual({
                top: 150,
                left: 300,
                transform: 'translateX(-100%)',
            })
        })

        it('calculates left-center correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'left-center')
            expect(coords).toEqual({
                top: 125, // 100 + 50/2
                left: 200,
                transform: 'translate(-100%, -50%)',
            })
        })

        it('calculates right-center correctly', () => {
            const coords = computeFloatingCoords(sampleRect, 'right-center')
            expect(coords).toEqual({
                top: 125, // 100 + 50/2
                left: 300,
                transform: 'translateY(-50%)',
            })
        })

        it('applies custom x and y offsets to coordinates', () => {
            const coords = computeFloatingCoords(sampleRect, 'top-center', {
                x: 15,
                y: -10,
            })
            expect(coords).toEqual({
                top: 90, // 100 - 10
                left: 265, // 250 + 15
                transform: 'translate(-50%, -100%)',
            })
        })

        it('falls back to top-center when placement is undefined or invalid', () => {
            const coords = computeFloatingCoords(
                sampleRect,
                undefined as unknown as 'top-center'
            )
            expect(coords).toEqual({
                top: 100,
                left: 250,
                transform: 'translate(-50%, -100%)',
            })
        })
    })

    describe('isAnchorVisible helper', () => {
        it('returns false when element is not connected to DOM', () => {
            const el = document.createElement('div')
            expect(isAnchorVisible(el)).toBe(false)
        })

        it('returns true when element is connected and visible', () => {
            const el = document.createElement('div')
            document.body.appendChild(el)
            expect(isAnchorVisible(el)).toBe(true)
        })

        it('returns false when element has hidden attribute', () => {
            const el = document.createElement('div')
            el.setAttribute('hidden', '')
            document.body.appendChild(el)
            expect(isAnchorVisible(el)).toBe(false)
        })

        it('returns false when element has style display: none', () => {
            const el = document.createElement('div')
            el.style.display = 'none'
            document.body.appendChild(el)
            expect(isAnchorVisible(el)).toBe(false)
        })

        it('returns false when element has style visibility: hidden', () => {
            const el = document.createElement('div')
            el.style.visibility = 'hidden'
            document.body.appendChild(el)
            expect(isAnchorVisible(el)).toBe(false)
        })

        it('returns false when checkVisibility returns false', () => {
            const el = document.createElement('div')
            document.body.appendChild(el)
            el.checkVisibility = vi.fn(() => false)
            expect(isAnchorVisible(el)).toBe(false)
        })

        it('returns true when checkVisibility returns true', () => {
            const el = document.createElement('div')
            document.body.appendChild(el)
            el.checkVisibility = vi.fn(() => true)
            expect(isAnchorVisible(el)).toBe(true)
        })

        it('returns false when checkVisibility returns true but ancestor has inert or aria-hidden="true"', () => {
            const parent = document.createElement('div')
            parent.setAttribute('inert', '')
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            child.checkVisibility = vi.fn(() => true)
            expect(isAnchorVisible(child)).toBe(false)

            parent.removeAttribute('inert')
            parent.setAttribute('aria-hidden', 'true')
            expect(isAnchorVisible(child)).toBe(false)
        })

        it('returns false when ancestor element is hidden', () => {
            const parent = document.createElement('div')
            parent.style.display = 'none'
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            expect(isAnchorVisible(child)).toBe(false)
        })

        it('returns false when ancestor element has hidden attribute', () => {
            const parent = document.createElement('div')
            parent.setAttribute('hidden', '')
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            expect(isAnchorVisible(child)).toBe(false)
        })

        it('returns false when ancestor element has inert attribute', () => {
            const parent = document.createElement('div')
            parent.setAttribute('inert', '')
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            expect(isAnchorVisible(child)).toBe(false)
        })

        it('returns false when ancestor element has aria-hidden="true"', () => {
            const parent = document.createElement('div')
            parent.setAttribute('aria-hidden', 'true')
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            expect(isAnchorVisible(child)).toBe(false)
        })

        it('returns false when ancestor element has opacity: 0 style', () => {
            const parent = document.createElement('div')
            parent.style.opacity = '0'
            const child = document.createElement('div')
            parent.appendChild(child)
            document.body.appendChild(parent)

            expect(isAnchorVisible(child)).toBe(false)
        })
    })

    describe('useFloatings hook', () => {
        it('reactively updates when floatings are registered and unregistered', () => {
            const { result } = renderHook(() => useFloatings(registry))
            expect(result.current).toEqual([])

            const item: FloatingContribution = {
                id: 'hook-float',
                pluginId: 'hook-plugin',
                anchor: '#anchor',
                component: () => null,
            }

            let unregister: () => void = () => {}
            act(() => {
                unregister = registry.registerFloating(item)
            })
            expect(result.current).toHaveLength(1)
            expect(result.current[0].id).toBe('hook-float')

            act(() => {
                unregister()
            })
            expect(result.current).toEqual([])
        })
    })

    describe('FloatingOverlayHost component rendering', () => {
        it('renders empty when no floatings are registered', () => {
            const { container } = render(<FloatingOverlayHost registry={registry} />)
            expect(container).toBeEmptyDOMElement()
        })

        it('renders floating item anchored to DOM element with calculated coordinates', () => {
            const anchor = document.createElement('div')
            anchor.id = 'target-btn'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const FloatingContent: React.FC = () => (
                <div data-testid="floating-tooltip">Tooltip Content</div>
            )

            registry.registerFloating({
                id: 'tooltip',
                pluginId: 'test-plugin',
                anchor: '#target-btn',
                placement: 'top-center',
                offset: { x: 5, y: -8 },
                component: FloatingContent,
            })

            render(<FloatingOverlayHost registry={registry} />)

            const tooltip = screen.getByTestId('floating-tooltip')
            expect(tooltip).toBeInTheDocument()

            const wrapper = tooltip.closest('[data-floating-id="tooltip"]') as HTMLElement
            expect(wrapper).toBeInTheDocument()
            expect(wrapper.style.position).toBe('fixed')
            expect(wrapper.style.top).toBe('92px') // 100 - 8
            expect(wrapper.style.left).toBe('255px') // 200 + 50 + 5
            expect(wrapper.style.transform).toBe('translate(-50%, -100%)')
            expect(wrapper.style.zIndex).toBe('50')
            expect(wrapper.style.pointerEvents).toBe('auto')
        })

        it('supports various placements and custom offsets', () => {
            const anchor = document.createElement('div')
            anchor.id = 'bottom-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const BottomItem: React.FC = () => (
                <div data-testid="bottom-content">Bottom Item</div>
            )

            registry.registerFloating({
                id: 'bottom-floating',
                pluginId: 'test-plugin',
                anchor: '#bottom-anchor',
                placement: 'bottom-start',
                offset: { x: 10, y: 20 },
                component: BottomItem,
            })

            render(<FloatingOverlayHost registry={registry} />)

            const wrapper = screen
                .getByTestId('bottom-content')
                .closest('[data-floating-id="bottom-floating"]') as HTMLElement
            expect(wrapper).toBeInTheDocument()
            expect(wrapper.style.top).toBe('170px') // 150 + 20
            expect(wrapper.style.left).toBe('210px') // 200 + 10
            expect(wrapper.style.transform).toBe('none')
        })

        it('hides floating item when anchor element is missing or removed from DOM', () => {
            // Anchor element not added to document
            const MissingItem: React.FC = () => (
                <div data-testid="missing-content">Should not show</div>
            )

            registry.registerFloating({
                id: 'missing-anchor-item',
                pluginId: 'test-plugin',
                anchor: '#does-not-exist',
                component: MissingItem,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.queryByTestId('missing-content')).not.toBeInTheDocument()
        })

        it('renders nothing when anchor has display: none or hidden attribute, and appears when visible', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'hidden-anchor-toggle'
            anchor.style.display = 'none'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            registry.registerFloating({
                id: 'hidden-float-item',
                pluginId: 'test-plugin',
                anchor: '#hidden-anchor-toggle',
                component: () => <div data-testid="hidden-toggle-content">Hidden Toggle</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.queryByTestId('hidden-toggle-content')).not.toBeInTheDocument()

            // Make anchor visible
            anchor.style.display = 'block'
            anchor.setAttribute('data-updated', '1')

            await waitFor(() => {
                expect(screen.getByTestId('hidden-toggle-content')).toBeInTheDocument()
            })

            // Set hidden attribute
            anchor.setAttribute('hidden', '')

            await waitFor(() => {
                expect(screen.queryByTestId('hidden-toggle-content')).not.toBeInTheDocument()
            })
        })

        it('renders nothing when anchor ancestor is hidden and appears when unhidden', async () => {
            const parent = document.createElement('div')
            parent.style.display = 'none'
            const anchor = document.createElement('div')
            anchor.id = 'ancestor-anchor'
            parent.appendChild(anchor)
            document.body.appendChild(parent)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            registry.registerFloating({
                id: 'ancestor-float-item',
                pluginId: 'test-plugin',
                anchor: '#ancestor-anchor',
                component: () => <div data-testid="ancestor-content">Ancestor Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.queryByTestId('ancestor-content')).not.toBeInTheDocument()

            // Make parent visible
            parent.style.display = 'block'
            parent.setAttribute('data-visible', 'true')

            await waitFor(() => {
                expect(screen.getByTestId('ancestor-content')).toBeInTheDocument()
            })
        })

        it('appears when anchor element is dynamically added to DOM and disappears when removed', async () => {
            registry.registerFloating({
                id: 'dyn-add-remove',
                pluginId: 'p1',
                anchor: '#dyn-anchor',
                component: () => <div data-testid="dyn-content">Dynamic Anchor Item</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.queryByTestId('dyn-content')).not.toBeInTheDocument()

            // Dynamically append anchor to DOM
            const anchor = document.createElement('div')
            anchor.id = 'dyn-anchor'
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)
            document.body.appendChild(anchor)

            await waitFor(() => {
                expect(screen.getByTestId('dyn-content')).toBeInTheDocument()
            })

            // Dynamically remove anchor from DOM
            anchor.remove()

            await waitFor(() => {
                expect(screen.queryByTestId('dyn-content')).not.toBeInTheDocument()
            })
        })

        it('filters out contributions when visible predicate returns false', () => {
            const anchor = document.createElement('div')
            anchor.id = 'visible-test-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const HiddenItem: React.FC = () => (
                <div data-testid="hidden-floating">Hidden</div>
            )
            const ShownItem: React.FC = () => (
                <div data-testid="shown-floating">Shown</div>
            )

            registry.registerFloating({
                id: 'hidden-float',
                pluginId: 'test-plugin',
                anchor: '#visible-test-anchor',
                component: HiddenItem,
                visible: (ctx) => ctx.showHidden === true,
            })
            registry.registerFloating({
                id: 'shown-float',
                pluginId: 'test-plugin',
                anchor: '#visible-test-anchor',
                component: ShownItem,
                visible: (ctx) => ctx.showHidden !== true,
            })

            const { rerender } = render(
                <FloatingOverlayHost registry={registry} context={{ showHidden: false }} />
            )

            expect(screen.queryByTestId('hidden-floating')).not.toBeInTheDocument()
            expect(screen.getByTestId('shown-floating')).toBeInTheDocument()

            rerender(
                <FloatingOverlayHost registry={registry} context={{ showHidden: true }} />
            )

            expect(screen.getByTestId('hidden-floating')).toBeInTheDocument()
            expect(screen.queryByTestId('shown-floating')).not.toBeInTheDocument()
        })

        it('filters out session-dependent floating components when context has null sessionId (new chat window)', () => {
            const anchor = document.createElement('div')
            anchor.id = 'session-test-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const SessionFloating: React.FC = () => (
                <div data-testid="session-floating">Session Active Floating</div>
            )

            registry.registerFloating({
                id: 'session-float',
                pluginId: 'session-plugin',
                anchor: '#session-test-anchor',
                component: SessionFloating,
                visible: (ctx) => {
                    if (ctx && 'sessionId' in ctx) {
                        return Boolean(ctx.sessionId)
                    }
                    return true
                },
            })

            // In new chat window, context is { sessionId: null }
            const { rerender } = render(
                <FloatingOverlayHost registry={registry} context={{ sessionId: null }} />
            )
            expect(screen.queryByTestId('session-floating')).not.toBeInTheDocument()

            // When navigating into a chat session, context is { sessionId: 's1' }
            rerender(
                <FloatingOverlayHost registry={registry} context={{ sessionId: 's1' }} />
            )
            expect(screen.getByTestId('session-floating')).toBeInTheDocument()
        })

        it('catches errors in floating component with SlotErrorBoundary fallback without crashing the host', () => {
            const anchor = document.createElement('div')
            anchor.id = 'crash-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const CrashingItem: React.FC = () => {
                throw new Error('Floating render boom!')
            }
            const HealthyItem: React.FC = () => (
                <div data-testid="healthy-floating">Healthy Floating</div>
            )

            registry.registerFloating({
                id: 'crash-float',
                pluginId: 'buggy-plugin',
                anchor: '#crash-anchor',
                component: CrashingItem,
            })
            registry.registerFloating({
                id: 'healthy-float',
                pluginId: 'good-plugin',
                anchor: '#crash-anchor',
                component: HealthyItem,
            })

            render(<FloatingOverlayHost registry={registry} />)

            // Healthy floating continues to render
            expect(screen.getByTestId('healthy-floating')).toBeInTheDocument()

            // Crashing floating falls back to error UI
            const errorBoundaryFallback = screen.getByTestId(
                'slot-error-floating-crash-float'
            )
            expect(errorBoundaryFallback).toBeInTheDocument()
            expect(errorBoundaryFallback).toHaveTextContent('floating-crash-float')
        })

        it('reacts dynamically when new floating contribution is registered or unregistered', () => {
            const anchor = document.createElement('div')
            anchor.id = 'dynamic-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const DynamicContent: React.FC = () => (
                <div data-testid="dynamic-floating">Dynamic Floating Item</div>
            )

            const { container } = render(<FloatingOverlayHost registry={registry} />)
            expect(container).toBeEmptyDOMElement()

            let unregister: () => void = () => {}
            act(() => {
                unregister = registry.registerFloating({
                    id: 'dynamic-float',
                    pluginId: 'dynamic-plugin',
                    anchor: '#dynamic-anchor',
                    component: DynamicContent,
                })
            })

            expect(screen.getByTestId('dynamic-floating')).toBeInTheDocument()

            act(() => {
                unregister()
            })

            expect(screen.queryByTestId('dynamic-floating')).not.toBeInTheDocument()
            expect(container).toBeEmptyDOMElement()
        })

        it('applies custom className to outer container', () => {
            const anchor = document.createElement('div')
            anchor.id = 'custom-class-anchor'
            document.body.appendChild(anchor)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            registry.registerFloating({
                id: 'item-1',
                pluginId: 'p1',
                anchor: '#custom-class-anchor',
                component: () => <div data-testid="content">Content</div>,
            })

            const { container } = render(
                <FloatingOverlayHost
                    registry={registry}
                    className="custom-overlay-class"
                />
            )

            expect(container.firstChild).toHaveClass('custom-overlay-class')
            expect(container.firstChild).toHaveClass('pointer-events-none')
            expect(container.firstChild).toHaveClass('fixed')
            expect(container.firstChild).toHaveClass('inset-0')
        })

        it('hides overlay with visibility hidden when anchor width is insufficient to show the overlay', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'narrow-anchor'
            document.body.appendChild(anchor)

            // Mock wide anchor first
            let rect = { ...sampleRect, width: 300 }
            vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect)

            const WideItem: React.FC = () => (
                <div data-testid="wide-content" style={{ width: '200px' }}>
                    Wide Content
                </div>
            )

            registry.registerFloating({
                id: 'wide-float',
                pluginId: 'p1',
                anchor: '#narrow-anchor',
                component: WideItem,
            })

            render(<FloatingOverlayHost registry={registry} />)

            const wrapper = screen
                .getByTestId('wide-content')
                .closest('[data-floating-id="wide-float"]') as HTMLElement

            // Mock the overlay element offsetWidth
            Object.defineProperty(wrapper, 'offsetWidth', {
                configurable: true,
                value: 200,
            })

            // Trigger resize to narrow width
            rect = { ...sampleRect, width: 100 }
            window.dispatchEvent(new Event('resize'))

            await waitFor(() => {
                expect(wrapper.style.visibility).toBe('hidden')
                expect(wrapper.style.opacity).toBe('0')
            })

            // Restore width to 300
            rect = { ...sampleRect, width: 300 }
            window.dispatchEvent(new Event('resize'))

            await waitFor(() => {
                expect(wrapper.style.visibility).toBe('visible')
                expect(wrapper.style.opacity).toBe('1')
            })
        })

        it('handles transitionstart and transitionend events to update position during layout animations', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'transition-anchor'
            document.body.appendChild(anchor)

            let rect = { ...sampleRect, left: 100 }
            vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => rect)

            registry.registerFloating({
                id: 'transition-float',
                pluginId: 'p1',
                anchor: '#transition-anchor',
                component: () => <div data-testid="transition-content">Transition Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)

            const wrapper = screen
                .getByTestId('transition-content')
                .closest('[data-floating-id="transition-float"]') as HTMLElement
            expect(wrapper.style.left).toBe('150px') // 100 + 50

            // Simulate transition to left: 400
            rect = { ...sampleRect, left: 400 }
            window.dispatchEvent(new Event('transitionstart'))

            await waitFor(() => {
                expect(wrapper.style.left).toBe('450px')
            })

            rect = { ...sampleRect, left: 500 }
            window.dispatchEvent(new Event('transitionend'))

            await waitFor(() => {
                expect(wrapper.style.left).toBe('550px')
            })
        })

        it('updates coordinates on window scroll and resize events', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'event-anchor'
            document.body.appendChild(anchor)

            let currentRect = { ...sampleRect }
            vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => currentRect)

            registry.registerFloating({
                id: 'event-float',
                pluginId: 'p1',
                anchor: '#event-anchor',
                placement: 'top-center',
                component: () => <div data-testid="event-content">Event Float</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)

            const wrapper = screen
                .getByTestId('event-content')
                .closest('[data-floating-id="event-float"]') as HTMLElement
            expect(wrapper.style.top).toBe('100px')
            expect(wrapper.style.left).toBe('250px')

            // Simulate scroll / position change
            currentRect = {
                ...sampleRect,
                top: 50,
                left: 100,
            }

            window.dispatchEvent(new Event('scroll'))

            await waitFor(() => {
                expect(wrapper.style.top).toBe('50px')
                expect(wrapper.style.left).toBe('150px') // 100 + 50
            })

            // Simulate resize
            currentRect = {
                ...sampleRect,
                top: 80,
                left: 120,
            }

            window.dispatchEvent(new Event('resize'))

            await waitFor(() => {
                expect(wrapper.style.top).toBe('80px')
                expect(wrapper.style.left).toBe('170px') // 120 + 50
            })
        })

        it('updates position when ResizeObserver fires and unobserves previous element when anchor changes', async () => {
            const observedList: Element[] = []
            const unobservedList: Element[] = []
            let triggerResizeCallback: () => void = () => {}

            class TestResizeObserver {
                constructor(callback: () => void) {
                    triggerResizeCallback = callback
                }
                observe = vi.fn((el: Element) => {
                    observedList.push(el)
                })
                unobserve = vi.fn((el: Element) => {
                    unobservedList.push(el)
                })
                disconnect = vi.fn()
            }

            const origResizeObserver = window.ResizeObserver
            window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

            try {
                const anchor1 = document.createElement('div')
                anchor1.id = 'ro-anchor'
                document.body.appendChild(anchor1)

                let currentRect = { ...sampleRect }
                vi.spyOn(anchor1, 'getBoundingClientRect').mockImplementation(() => currentRect)

                registry.registerFloating({
                    id: 'ro-float',
                    pluginId: 'p1',
                    anchor: '#ro-anchor',
                    component: () => <div data-testid="ro-content">RO Content</div>,
                })

                render(<FloatingOverlayHost registry={registry} />)

                expect(screen.getByTestId('ro-content')).toBeInTheDocument()
                expect(observedList).toContain(anchor1)

                const wrapper = screen
                    .getByTestId('ro-content')
                    .closest('[data-floating-id="ro-float"]') as HTMLElement
                expect(wrapper.style.top).toBe('100px')

                // Simulate resize from ResizeObserver
                currentRect = { ...sampleRect, top: 130 }
                triggerResizeCallback()

                await waitFor(() => {
                    expect(wrapper.style.top).toBe('130px')
                })

                // Replace anchor element with a new element
                const anchor2 = document.createElement('div')
                anchor2.id = 'ro-anchor'
                vi.spyOn(anchor2, 'getBoundingClientRect').mockImplementation(() => currentRect)
                anchor1.remove()
                document.body.appendChild(anchor2)

                await waitFor(() => {
                    expect(unobservedList).toContain(anchor1)
                    expect(observedList).toContain(anchor2)
                })
            } finally {
                window.ResizeObserver = origResizeObserver
            }
        })

        it('MutationObserver ignores mutations occurring inside the floating overlay itself', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'mutation-scope-anchor'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

            registry.registerFloating({
                id: 'mo-float',
                pluginId: 'p1',
                anchor: '#mutation-scope-anchor',
                component: () => <div data-testid="mo-content">Mutation Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.getByTestId('mo-content')).toBeInTheDocument()

            // Clear any initial frame requests
            rafSpy.mockClear()

            // Mutate style/class or appendChild inside the overlay container
            const overlayWrapper = screen
                .getByTestId('mo-content')
                .closest('[data-floating-id="mo-float"]') as HTMLElement
            overlayWrapper.className = 'inner-overlay-mutated'
            overlayWrapper.style.opacity = '0.8'

            // Wait a moment for MutationObserver to flush microtasks
            await new Promise((resolve) => setTimeout(resolve, 50))

            // Assert that mutating inside the overlay did NOT schedule requestAnimationFrame
            expect(rafSpy).not.toHaveBeenCalled()

            // Counter-check: mutating style/class on the anchor element DOES schedule requestAnimationFrame
            anchor.className = 'anchor-mutated'

            await waitFor(() => {
                expect(rafSpy).toHaveBeenCalled()
            })

            rafSpy.mockRestore()
        })

        it('throttles position updates using requestAnimationFrame', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'raf-anchor'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            let rafCallCount = 0
            const origRaf = window.requestAnimationFrame
            vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
                rafCallCount++
                return origRaf(cb)
            })

            registry.registerFloating({
                id: 'raf-float',
                pluginId: 'p1',
                anchor: '#raf-anchor',
                component: () => <div data-testid="raf-content">RAF Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.getByTestId('raf-content')).toBeInTheDocument()

            const countBefore = rafCallCount

            // Trigger multiple events in the same frame tick
            window.dispatchEvent(new Event('scroll'))
            window.dispatchEvent(new Event('scroll'))
            window.dispatchEvent(new Event('resize'))
            window.dispatchEvent(new Event('scroll'))

            // Should have scheduled only 1 rAF request
            expect(rafCallCount).toBe(countBefore + 1)
        })

        it('MutationObserver ignores mutations occurring inside other floating overlays and custom mac scrollbar host', async () => {
            const anchor = document.createElement('div')
            anchor.id = 'isolate-anchor'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            const scrollbarHost = document.createElement('div')
            scrollbarHost.id = 'cpa-mac-scrollbars-host'
            document.body.appendChild(scrollbarHost)

            const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

            registry.registerFloating({
                id: 'float-a',
                pluginId: 'p1',
                anchor: '#isolate-anchor',
                component: () => <div data-testid="float-a-content">Float A</div>,
            })
            registry.registerFloating({
                id: 'float-b',
                pluginId: 'p2',
                anchor: '#isolate-anchor',
                component: () => <div data-testid="float-b-content">Float B</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            expect(screen.getByTestId('float-a-content')).toBeInTheDocument()
            expect(screen.getByTestId('float-b-content')).toBeInTheDocument()

            rafSpy.mockClear()

            // Mutate float-a's wrapper
            const floatAWrapper = screen
                .getByTestId('float-a-content')
                .closest('[data-floating-id="float-a"]') as HTMLElement
            floatAWrapper.style.opacity = '0.5'

            // Mutate scrollbar host
            scrollbarHost.style.top = '10px'

            // Wait for MutationObserver to flush microtasks
            await new Promise((resolve) => setTimeout(resolve, 50))

            // Mutating float-a or scrollbars host must not trigger rAF on float-b or float-a
            expect(rafSpy).not.toHaveBeenCalled()

            // Discard transition/animation inside overlay without scheduling tracking
            const floatAContent = screen.getByTestId('float-a-content')
            floatAContent.dispatchEvent(new Event('animationstart', { bubbles: true }))
            expect(rafSpy).not.toHaveBeenCalled()

            rafSpy.mockRestore()
            scrollbarHost.remove()
        })

        it('cleans up all observers, listeners, and pending rAF on unmount without warnings', () => {
            const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
            const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame')

            const anchor = document.createElement('div')
            anchor.id = 'cleanup-anchor'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            registry.registerFloating({
                id: 'cleanup-float',
                pluginId: 'p1',
                anchor: '#cleanup-anchor',
                component: () => <div data-testid="cleanup-content">Cleanup</div>,
            })

            const { unmount } = render(<FloatingOverlayHost registry={registry} />)
            expect(screen.getByTestId('cleanup-content')).toBeInTheDocument()

            // Trigger an event that schedules a rAF
            window.dispatchEvent(new Event('scroll'))

            unmount()

            expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function))
            expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), {
                capture: true,
            })
            expect(cancelAnimationFrameSpy).toHaveBeenCalled()

            removeEventListenerSpy.mockRestore()
            cancelAnimationFrameSpy.mockRestore()
        })

        it('tracks sibling sidebar collapse transitions and immediately updates floating overlay position', async () => {
            const container = document.createElement('div')
            container.id = 'app-root'
            const sidebar = document.createElement('aside')
            sidebar.id = 'right-sidebar'
            sidebar.setAttribute('data-testid', 'subagent-panel')
            sidebar.style.width = '380px'

            const main = document.createElement('main')
            const anchor = document.createElement('div')
            anchor.setAttribute('data-element', 'composer-container')
            main.appendChild(anchor)
            container.appendChild(main)
            container.appendChild(sidebar)
            document.body.appendChild(container)

            // Initial state: sidebar is open, anchor is shifted to left: 200
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
                ...sampleRect,
                left: 200,
            })

            registry.registerFloating({
                id: 'todo-progress-bar',
                pluginId: 'cpa.core.manage-todo-list',
                anchor: '[data-element="composer-container"]',
                component: () => <div data-testid="todo-bar-content">Todo Bar</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            const overlay = screen
                .getByTestId('todo-bar-content')
                .closest('[data-floating-id="todo-progress-bar"]') as HTMLElement
            expect(overlay.style.left).toBe('250px') // 200 + 100/2

            // Simulate closing sidebar: anchor shifts rightward to left: 350
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
                ...sampleRect,
                left: 350,
            })

            // Dispatch transitionstart on the sibling sidebar element
            const transitionStartEvent = new Event('transitionstart', { bubbles: true })
            sidebar.dispatchEvent(transitionStartEvent)

            await waitFor(() => {
                expect(overlay.style.left).toBe('400px') // 350 + 100/2
            })

            // Further simulate sidebar finishing transition
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
                ...sampleRect,
                left: 400,
            })
            const transitionEndEvent = new Event('transitionend', { bubbles: true })
            sidebar.dispatchEvent(transitionEndEvent)

            await waitFor(() => {
                expect(overlay.style.left).toBe('450px') // 400 + 100/2
            })

            container.remove()
        })

        it('discards non-layout transitions (e.g. background color change) and loader animations', async () => {
            const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

            const anchor = document.createElement('div')
            anchor.id = 'filter-anchor'
            document.body.appendChild(anchor)
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(sampleRect)

            registry.registerFloating({
                id: 'filter-float',
                pluginId: 'p1',
                anchor: '#filter-anchor',
                component: () => <div data-testid="filter-content">Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            rafSpy.mockClear()

            // Non-layout transition property
            const colorTransition = new Event('transitionstart', { bubbles: true })
            Object.defineProperty(colorTransition, 'propertyName', { value: 'background-color' })
            document.body.dispatchEvent(colorTransition)

            expect(rafSpy).not.toHaveBeenCalled()

            // Loader spinner animation
            const spinner = document.createElement('div')
            spinner.className = 'animate-spin'
            document.body.appendChild(spinner)
            spinner.dispatchEvent(new Event('animationstart', { bubbles: true }))

            expect(rafSpy).not.toHaveBeenCalled()

            spinner.remove()
            anchor.remove()
            rafSpy.mockRestore()
        })

        it('triggers tracking when sibling layout attributes change via MutationObserver', async () => {
            const container = document.createElement('div')
            const sidebar = document.createElement('aside')
            sidebar.setAttribute('data-state', 'open')
            sidebar.style.width = '380px'

            const anchor = document.createElement('div')
            anchor.id = 'layout-attr-anchor'
            container.appendChild(anchor)
            container.appendChild(sidebar)
            document.body.appendChild(container)

            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
                ...sampleRect,
                left: 200,
            })

            registry.registerFloating({
                id: 'attr-float',
                pluginId: 'p1',
                anchor: '#layout-attr-anchor',
                component: () => <div data-testid="attr-content">Attr Content</div>,
            })

            render(<FloatingOverlayHost registry={registry} />)
            const overlay = screen
                .getByTestId('attr-content')
                .closest('[data-floating-id="attr-float"]') as HTMLElement
            expect(overlay.style.left).toBe('250px')

            // Simulate closing sidebar: style and data-state change
            vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
                ...sampleRect,
                left: 380,
            })

            sidebar.setAttribute('data-state', 'closed')
            sidebar.style.width = '0px'

            await waitFor(() => {
                expect(overlay.style.left).toBe('430px') // 380 + 100/2
            })

            container.remove()
        })
    })
})
