import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelReasoningOption } from '@cpa/plugin-api'
import { AdvancedMenu } from '../components/AdvancedMenu.js'
import { resolveSubmenuSide } from './submenuPlacement.js'

const CANONICAL_REASONING_OPTIONS: readonly ModelReasoningOption[] = [
    { value: 'off', label: 'Off' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'extra-high', label: 'Very High' },
    { value: 'max', label: 'Max' },
    { value: 'auto', label: 'Auto' },
    { value: 'default', label: 'Default' },
]

const testReasoningOptions: readonly ModelReasoningOption[] = CANONICAL_REASONING_OPTIONS

describe('resolveSubmenuSide', () => {
    it('opens to the right when the submenu fits', () => {
        expect(
            resolveSubmenuSide({ left: 1100, right: 1334 }, 190, 1600),
        ).toBe('right')
    })

    it('opens to the left when the right edge would overflow', () => {
        expect(
            resolveSubmenuSide({ left: 100, right: 334 }, 190, 480),
        ).toBe('left')
    })

    it('clamps the rendered submenu when neither side has enough space', () => {
        const originalInnerWidth = window.innerWidth
        const originalInnerHeight = window.innerHeight
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 240,
        })
        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            value: 320,
        })
        const rectSpy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.getAttribute('aria-label') === 'Advanced') {
                    return {
                        left: 40,
                        right: 100,
                        top: 20,
                        bottom: 60,
                        width: 60,
                        height: 40,
                    } as DOMRect
                }
                return {
                    left: 0,
                    right: 190,
                    top: 0,
                    bottom: 240,
                    width: 190,
                    height: 240,
                } as DOMRect
            })

        render(
            createElement(AdvancedMenu, {
                modelId: 'test-model',
                reasoningOptions: testReasoningOptions,
                reasoningLevel: 'medium',
                speed: 'standard',
                activeSubmenu: 'reasoning',
                onModelChange: () => undefined,
                onReasoningLevelChange: () => undefined,
                onSpeedChange: () => undefined,
                onSubmenuChange: () => undefined,
                onBackToQuick: () => undefined,
            }),
        )

        const submenu = screen.getByRole('menu', { name: /Reasoning/i })
        const submenuPositioner = submenu.parentElement
        expect(submenuPositioner).toHaveAttribute('data-side', 'left')
        expect(submenuPositioner?.style.position).toBe('fixed')
        expect(submenuPositioner?.style.left).toBe('8px')
        expect(submenuPositioner?.style.width).toBe('190px')

        rectSpy.mockRestore()
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: originalInnerWidth,
        })
        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            value: originalInnerHeight,
        })
    })

    it('hides the speed submenu when fast capability is omitted', () => {
        render(
            createElement(AdvancedMenu, {
                modelId: 'test-model',
                reasoningOptions: testReasoningOptions,
                reasoningLevel: 'off',
                speed: 'standard',
                activeSubmenu: 'speed',
                onModelChange: () => undefined,
                onReasoningLevelChange: () => undefined,
                onSpeedChange: () => undefined,
                onSubmenuChange: () => undefined,
                onBackToQuick: () => undefined,
            }),
        )

        expect(screen.queryByRole('menu', { name: /Speed/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    })

    it('keeps the model menu container fixed while its options scroll', () => {
        render(
            createElement(AdvancedMenu, {
                modelId: 'test-model',
                reasoningOptions: testReasoningOptions,
                reasoningLevel: 'medium',
                speed: 'standard',
                activeSubmenu: 'model',
                onModelChange: () => undefined,
                onReasoningLevelChange: () => undefined,
                onSpeedChange: () => undefined,
                onSubmenuChange: () => undefined,
                onBackToQuick: () => undefined,
            }),
        )

        const modelMenu = screen.getByRole('menu', { name: /Model/i })
        const positioner = modelMenu.parentElement
        expect(modelMenu).toHaveClass('overflow-y-auto')
        expect(positioner?.style.overflow).toBe('')
    })

    it('portals the submenu to document.body and allows all fallback options to be selected', async () => {
        const user = userEvent.setup()
        const onReasoningLevelChange = vi.fn()

        render(
            createElement(AdvancedMenu, {
                modelId: 'test-model',
                reasoningOptions: testReasoningOptions,
                reasoningLevel: 'medium',
                speed: 'standard',
                activeSubmenu: 'reasoning',
                onModelChange: () => undefined,
                onReasoningLevelChange,
                onSpeedChange: () => undefined,
                onSubmenuChange: () => undefined,
                onBackToQuick: () => undefined,
            }),
        )

        const reasoningMenu = screen.getByRole('menu', { name: /Reasoning/i })
        expect(reasoningMenu.parentElement?.parentElement).toBe(document.body)

        const options = screen.getAllByRole('menuitemradio')
        expect(options).toHaveLength(8)
        for (const option of options) await user.click(option)
        expect(onReasoningLevelChange).toHaveBeenCalledTimes(8)
    })

    it('measures natural height before clamping a submenu on first render', () => {
        const originalInnerWidth = window.innerWidth
        const originalInnerHeight = window.innerHeight
        Object.defineProperty(window, 'innerWidth', {
            configurable: true,
            value: 150,
        })
        Object.defineProperty(window, 'innerHeight', {
            configurable: true,
            value: 320,
        })
        const rectSpy = vi
            .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
            .mockImplementation(function (this: HTMLElement) {
                if (this.id === 'composer-advanced-menu') {
                    return {
                        left: 50,
                        right: 100,
                        top: 260,
                        bottom: 296,
                        width: 50,
                        height: 36,
                    } as DOMRect
                }
                return {
                    left: 0,
                    right: 190,
                    top: 0,
                    bottom: 0,
                    width: 190,
                    height: 0,
                } as DOMRect
            })
        const scrollHeightSpy = vi
            .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
            .mockReturnValue(280)

        try {
            render(
                createElement(AdvancedMenu, {
                    modelId: 'test-model',
                    reasoningOptions: testReasoningOptions,
                    reasoningLevel: 'medium',
                    speed: 'standard',
                    activeSubmenu: 'reasoning',
                    onModelChange: () => undefined,
                    onReasoningLevelChange: () => undefined,
                    onSpeedChange: () => undefined,
                    onSubmenuChange: () => undefined,
                    onBackToQuick: () => undefined,
                }),
            )

            const submenu = screen.getByRole('menu', { name: /Reasoning/i })
            const submenuPositioner = submenu.parentElement
            expect(submenuPositioner?.style.left).toBe('8px')
            expect(submenuPositioner?.style.top).toBe('16px')
            expect(submenuPositioner?.style.width).toBe('134px')
            expect(submenuPositioner?.style.maxHeight).toBe('304px')
        } finally {
            rectSpy.mockRestore()
            scrollHeightSpy.mockRestore()
            Object.defineProperty(window, 'innerWidth', {
                configurable: true,
                value: originalInnerWidth,
            })
            Object.defineProperty(window, 'innerHeight', {
                configurable: true,
                value: originalInnerHeight,
            })
        }
    })
})
