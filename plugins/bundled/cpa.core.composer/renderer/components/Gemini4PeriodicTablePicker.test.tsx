import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ModelCatalogEntry } from '@cpa/plugin-api'
import { Gemini4PeriodicTablePicker } from './Gemini4PeriodicTablePicker.js'

const gemini4Models: readonly ModelCatalogEntry[] = [
    {
        id: 'gemini-4-hydrogen-xhigh',
        label: 'Gemini 4 Hydrogen',
        description: 'Frontier deep reasoning model',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
            { id: 'xhigh', requestValue: 'xhigh', labelKey: 'composer.reasoning.xhigh' },
        ],
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 1_048_576,
    },
    {
        id: 'gemini-4-carbon-high',
        label: 'Gemini 4 Carbon',
        description: 'Balanced coding model',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 1_048_576,
    },
    {
        id: 'gemini-4-argon-high',
        label: 'Gemini 4 Argon',
        description: 'Code and analysis',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 1_048_576,
    },
    {
        id: 'devin/gemini-4-argon',
        label: 'Gemini 4 Argon (Devin)',
        description: 'devin/gemini-4-argon',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 64_000,
    },
    {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon SU',
        description: 'gemini-4-argon',
        supportsFast: false,
        reasoningLevels: [
            { id: 'low', requestValue: 'low', labelKey: 'composer.reasoning.low' },
            { id: 'medium', requestValue: 'medium', labelKey: 'composer.reasoning.medium' },
            { id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' },
        ],
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 16_384,
    },
    {
        id: 'gemini-4-flash',
        label: 'Gemini 4 Flash',
        description: 'Fast experimental Gemini 4 model without reasoning levels',
        supportsFast: false,
        reasoningLevels: [],
        input: ['text'],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
    },
]

describe('Gemini4PeriodicTablePicker', () => {
    it('renders in a z-[70] body portal with all 118 elements and released/coming-soon legend', () => {
        const { container } = render(
            <Gemini4PeriodicTablePicker
                models={gemini4Models}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />,
        )

        const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
        expect(dialog).toBeInTheDocument()
        expect(container.contains(dialog)).toBe(false)
        expect(dialog.closest('[data-model-menu-portal]')).toHaveClass('fixed', 'z-[70]')
        expect(dialog.querySelector('select')).toBeNull()

        expect(screen.getByText('3 released')).toBeInTheDocument()
        expect(screen.getByText('Coming soon')).toBeInTheDocument()

        const elementButtons = dialog.querySelectorAll('[data-periodic-element]')
        expect(elementButtons).toHaveLength(118)

        const helium = dialog.querySelector('[data-periodic-element="2"]') as HTMLButtonElement
        expect(helium).toBeDisabled()
        expect(helium).toHaveAttribute('aria-disabled', 'true')
    })

    it('lets user switch element, switch variant, and pick a thinking level', () => {
        const onSelect = vi.fn()
        render(
            <Gemini4PeriodicTablePicker
                models={gemini4Models}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const argonBtn = document.querySelector('[data-periodic-element="18"]') as HTMLButtonElement
        expect(argonBtn).not.toBeDisabled()
        fireEvent.click(argonBtn)

        const inspector = screen.getByTestId('gemini4-periodic-inspector')
        expect(within(inspector).getByText('Gemini 4 Argon')).toBeInTheDocument()
        expect(within(inspector).getByRole('button', { name: 'Devin' })).toBeInTheDocument()
        expect(within(inspector).getByRole('button', { name: 'SU' })).toBeInTheDocument()

        fireEvent.click(within(inspector).getByRole('button', { name: 'Devin' }))
        expect(within(inspector).getByText('Gemini 4 Argon (Devin)')).toBeInTheDocument()

        fireEvent.click(within(inspector).getByRole('button', { name: /Medium/i }))
        expect(onSelect).toHaveBeenCalledWith({
            model: gemini4Models[3],
            reasoningLevel: 'medium',
        })
    })

    it('respects filtered reasoning levels when enableAll is false', () => {
        const onSelect = vi.fn()
        render(
            <Gemini4PeriodicTablePicker
                models={gemini4Models}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="low"
                modelSettings={{
                    enableAll: false,
                    models: {
                        'gemini-4-hydrogen-xhigh': {
                            enabled: true,
                            enabledReasoningLevels: ['low', 'xhigh'],
                        },
                    },
                }}
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const inspector = screen.getByTestId('gemini4-periodic-inspector')
        expect(within(inspector).getByRole('button', { name: /Low/i })).toBeInTheDocument()
        expect(within(inspector).getByRole('button', { name: /Extra high/i })).toBeInTheDocument()
        expect(within(inspector).queryByRole('button', { name: /Medium/i })).toBeNull()
        expect(within(inspector).queryByRole('button', { name: /^High$/i })).toBeNull()
    })

    it('renders unmapped Gemini 4 models in Other models bar and applies zero-reasoning Other models immediately on click', () => {
        const onSelect = vi.fn()
        render(
            <Gemini4PeriodicTablePicker
                models={gemini4Models}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const otherBtn = screen.getByRole('button', { name: 'Gemini 4 Flash' })
        expect(otherBtn).toBeInTheDocument()
        fireEvent.click(otherBtn)

        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(onSelect).toHaveBeenCalledWith({
            model: gemini4Models[5],
            reasoningLevel: 'off',
        })
    })

    it('previews released elements on hover and focus while keeping click lock stable, and exposes Use this model for zero-reasoning elements', () => {
        const onSelect = vi.fn()
        const modelsWithZeroReasoningElement: readonly ModelCatalogEntry[] = [
            gemini4Models[0]!,
            {
                ...gemini4Models[1]!,
                reasoningLevels: [],
            },
            gemini4Models[2]!,
        ]
        render(
            <Gemini4PeriodicTablePicker
                models={modelsWithZeroReasoningElement}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const inspector = screen.getByTestId('gemini4-periodic-inspector')
        expect(inspector).toHaveClass('z-[71]')

        const carbonBtn = document.querySelector('[data-periodic-element="6"]') as HTMLButtonElement
        const argonBtn = document.querySelector('[data-periodic-element="18"]') as HTMLButtonElement

        fireEvent.mouseEnter(carbonBtn)
        expect(within(inspector).getByText('Gemini 4 Carbon')).toBeInTheDocument()
        fireEvent.click(within(inspector).getByRole('button', { name: /Use this model/i }))
        expect(onSelect).toHaveBeenCalledWith({
            model: modelsWithZeroReasoningElement[1],
            reasoningLevel: 'off',
        })

        fireEvent.click(argonBtn)
        expect(within(inspector).getByText('Gemini 4 Argon')).toBeInTheDocument()
        fireEvent.mouseEnter(carbonBtn)
        expect(within(inspector).getByText('Gemini 4 Argon')).toBeInTheDocument()

        fireEvent.focus(carbonBtn)
        expect(within(inspector).getByText('Gemini 4 Carbon')).toBeInTheDocument()
    })

    it('ignores pointerdown on custom mac scrollbars and clamps position inside small viewports', () => {
        const originalWidth = window.innerWidth
        const originalHeight = window.innerHeight
        Object.defineProperty(window, 'innerWidth', { value: 240, configurable: true })
        Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true })

        const scrollbar = document.createElement('div')
        scrollbar.className = 'cpa-mac-scrollbar cpa-mac-scrollbar--horizontal'
        document.body.appendChild(scrollbar)

        const anchor = document.createElement('div')
        anchor.getBoundingClientRect = () =>
            ({ top: 90, bottom: 120, left: 20, right: 200, width: 180, height: 30, x: 20, y: 90, toJSON: () => ({}) }) as DOMRect

        const onClose = vi.fn()
        try {
            render(
                <Gemini4PeriodicTablePicker
                    models={gemini4Models}
                    currentModelId="gemini-4-hydrogen-xhigh"
                    currentReasoningLevel="xhigh"
                    anchorElement={anchor}
                    closeOnOutsideClick
                    onSelect={vi.fn()}
                    onClose={onClose}
                />,
            )

            const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
            const portal = dialog.closest('[data-model-menu-portal]') as HTMLElement
            expect(parseInt(portal.style.maxWidth, 10)).toBeLessThanOrEqual(240 - 16)
            expect(parseInt(dialog.style.maxHeight, 10)).toBeLessThanOrEqual(200 - 16)

            fireEvent.pointerDown(scrollbar)
            expect(onClose).not.toHaveBeenCalled()

            fireEvent.pointerDown(document.body)
            expect(onClose).toHaveBeenCalledTimes(1)
        } finally {
            scrollbar.remove()
            Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
            Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
        }
    })

    it('closes when pressing Escape or clicking close button', () => {
        const onClose = vi.fn()
        render(
            <Gemini4PeriodicTablePicker
                models={gemini4Models}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={vi.fn()}
                onClose={onClose}
            />,
        )

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByRole('button', { name: /Close/i }))
        expect(onClose).toHaveBeenCalledTimes(2)
    })

    it('keeps locked Hydrogen selected through keyboard Enter -> Tab -> Tab -> Enter and uses theme-safe active pill text', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        const subsetModels: readonly ModelCatalogEntry[] = [
            gemini4Models[0]!, // Hydrogen (low, medium, high, xhigh)
            gemini4Models[2]!, // Argon
            gemini4Models[5]!, // Flash (Other models)
        ]

        render(
            <Gemini4PeriodicTablePicker
                models={subsetModels}
                currentModelId="gemini-4-hydrogen-xhigh"
                currentReasoningLevel="xhigh"
                onSelect={onSelect}
                onClose={vi.fn()}
            />,
        )

        const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
        const hydrogenBtn = dialog.querySelector('[data-periodic-element="1"]') as HTMLButtonElement
        const argonBtn = dialog.querySelector('[data-periodic-element="18"]') as HTMLButtonElement
        expect(hydrogenBtn).toHaveFocus()
        expect(hydrogenBtn).toHaveAttribute('tabIndex', '0')
        expect(argonBtn).toHaveAttribute('tabIndex', '-1')

        // Active reasoning pill must not hardcode text-white over theme colors
        const inspector = screen.getByTestId('gemini4-periodic-inspector')
        const activeThinkingBtn = within(inspector).getByRole('button', { name: /Extra high/i })
        expect(activeThinkingBtn).not.toHaveClass('text-white')

        // Activate Hydrogen via keyboard Enter, tab within inspector, and confirm via Enter
        await user.keyboard('{Enter}')
        await user.keyboard('{Tab}{Tab}{Enter}')

        expect(onSelect).toHaveBeenCalledTimes(1)
        expect(onSelect.mock.calls[0]?.[0]?.model.id).toBe('gemini-4-hydrogen-xhigh')
    })

    it('switches to whole-dialog vertical scrolling on compact viewports so thinking level buttons remain reachable and clickable', () => {
        const originalWidth = window.innerWidth
        const originalHeight = window.innerHeight
        Object.defineProperty(window, 'innerWidth', { value: 240, configurable: true })
        Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true })

        const anchor = document.createElement('div')
        anchor.getBoundingClientRect = () =>
            ({ top: 90, bottom: 120, left: 20, right: 200, width: 180, height: 30, x: 20, y: 90, toJSON: () => ({}) }) as DOMRect

        const onSelect = vi.fn()
        try {
            render(
                <Gemini4PeriodicTablePicker
                    models={gemini4Models}
                    currentModelId="gemini-4-hydrogen-xhigh"
                    currentReasoningLevel="xhigh"
                    anchorElement={anchor}
                    onSelect={onSelect}
                    onClose={vi.fn()}
                />,
            )

            const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
            expect(dialog).toHaveClass('overflow-y-auto')
            expect(dialog).not.toHaveClass('overflow-hidden')

            const inspector = screen.getByTestId('gemini4-periodic-inspector')
            const lowBtn = within(inspector).getByRole('button', { name: /^Low$/i })
            const scrollIntoViewMock = vi.fn()
            lowBtn.scrollIntoView = scrollIntoViewMock
            fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' })
            fireEvent.click(dialog.querySelector('[data-periodic-element="1"]') as HTMLButtonElement)
            expect(lowBtn).toHaveFocus()
            expect(scrollIntoViewMock).toHaveBeenCalled()

            const highBtn = within(inspector).getByRole('button', { name: /^High$/i })
            expect(highBtn).toBeVisible()
            fireEvent.click(highBtn)
            expect(onSelect).toHaveBeenCalledWith({
                model: gemini4Models[0],
                reasoningLevel: 'high',
            })
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
            Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
        }
    })

    it('switches to whole-dialog scroll even when maxHeight >= 360 if header + inspector overflow available height (many variants)', () => {
        const originalWidth = window.innerWidth
        const originalHeight = window.innerHeight
        Object.defineProperty(window, 'innerWidth', { value: 320, configurable: true })
        Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })

        const anchor = document.createElement('div')
        anchor.getBoundingClientRect = () =>
            ({ top: 405, bottom: 440, left: 20, right: 300, width: 280, height: 35, x: 20, y: 405, toJSON: () => ({}) }) as DOMRect

        const manyVariants: ModelCatalogEntry[] = Array.from({ length: 24 }, (_, idx) => ({
            id: `vendor-${idx}/gemini-4-argon`,
            label: `Gemini 4 Argon Variant ${idx}`,
            supportsFast: false,
            reasoningLevels: [{ id: 'high', requestValue: 'high', labelKey: 'composer.reasoning.high' }],
            input: ['text'],
            contextWindow: 1_048_576,
            maxTokens: 64_000,
        }))

        const origGetBCR = HTMLElement.prototype.getBoundingClientRect
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (this.getAttribute('data-testid') === 'gemini4-periodic-inspector') {
                return { top: 0, bottom: 423, left: 0, right: 304, width: 304, height: 423, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
            }
            if (this.getAttribute('data-testid') === 'gemini4-periodic-header') {
                return { top: 0, bottom: 44, left: 0, right: 304, width: 304, height: 44, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
            }
            return origGetBCR.call(this)
        })

        try {
            render(
                <Gemini4PeriodicTablePicker
                    models={manyVariants}
                    currentModelId={manyVariants[0]!.id}
                    currentReasoningLevel="high"
                    anchorElement={anchor}
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />,
            )

            const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
            expect(parseInt(dialog.style.maxHeight, 10)).toBe(389)
            expect(dialog).toHaveClass('overflow-y-auto')
            expect(dialog).not.toHaveClass('overflow-hidden')
        } finally {
            vi.restoreAllMocks()
            Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
            Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
        }
    })

    it('renders 57-71 and 89-103 series range placeholders with compact single-line non-overflowing styling and wider grid tracks', () => {
        const originalWidth = window.innerWidth
        Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true })

        try {
            render(
                <Gemini4PeriodicTablePicker
                    models={gemini4Models}
                    currentModelId="gemini-4-hydrogen-xhigh"
                    currentReasoningLevel="xhigh"
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />,
            )

            const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
            const portal = dialog.closest('[data-model-menu-portal]') as HTMLElement
            expect(parseInt(portal.style.width, 10)).toBeGreaterThanOrEqual(760)

            const range57 = screen.getByText('57-71')
            const range89 = screen.getByText('89-103')
            const lnLabel = screen.getByText('Ln')
            const anLabel = screen.getByText('An')

            for (const rangeEl of [range57, range89]) {
                expect(rangeEl).toHaveClass('text-[8px]', 'leading-none', 'whitespace-nowrap')
                expect(rangeEl).not.toHaveClass('text-[10px]')
            }

            expect(lnLabel).toHaveClass('leading-none', 'whitespace-nowrap')
            expect(anLabel).toHaveClass('leading-none', 'whitespace-nowrap')

            const lnTile = range57.parentElement as HTMLElement
            const anTile = range89.parentElement as HTMLElement
            expect(lnTile).toContainElement(lnLabel)
            expect(anTile).toContainElement(anLabel)
            expect(lnTile).toHaveClass('overflow-hidden')
            expect(anTile).toHaveClass('overflow-hidden')
            expect(lnTile.style.gridRow).toBe('6')
            expect(lnTile.style.gridColumn).toBe('3')
            expect(anTile.style.gridRow).toBe('7')
            expect(anTile.style.gridColumn).toBe('3')

            const grid = lnTile.parentElement as HTMLElement
            expect(grid).toHaveClass('min-w-[720px]')

            const hydrogenBtn = dialog.querySelector('[data-periodic-element="1"]') as HTMLButtonElement
            expect(hydrogenBtn).toHaveClass('overflow-hidden')
        } finally {
            Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
        }
    })

    it('centers horizontally within the conversation workspace container even when anchorElement is on the side, and updates on workspace resize', () => {
        const originalWidth = window.innerWidth
        const originalHeight = window.innerHeight
        const OriginalResizeObserver = globalThis.ResizeObserver
        Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
        Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })

        let workspaceWidth = 1180
        const observerCallbacks: ResizeObserverCallback[] = []
        class MockResizeObserver {
            private cb: ResizeObserverCallback
            constructor(cb: ResizeObserverCallback) {
                this.cb = cb
                observerCallbacks.push(cb)
            }
            observe = vi.fn()
            unobserve = vi.fn()
            disconnect = vi.fn()
        }
        ;(globalThis as any).ResizeObserver = MockResizeObserver

        const workspace = document.createElement('div')
        workspace.setAttribute('data-testid', 'workspace-content-container')
        workspace.getBoundingClientRect = () =>
            ({ top: 40, bottom: 900, left: 260, right: 260 + workspaceWidth, width: workspaceWidth, height: 860, x: 260, y: 40, toJSON: () => ({}) }) as DOMRect

        const composerContainer = document.createElement('div')
        composerContainer.setAttribute('data-element', 'composer-container')
        composerContainer.getBoundingClientRect = () =>
            ({ top: 750, bottom: 860, left: 466, right: 1234, width: 768, height: 110, x: 466, y: 750, toJSON: () => ({}) }) as DOMRect

        const rightAnchor = document.createElement('button')
        rightAnchor.getBoundingClientRect = () =>
            ({ top: 820, bottom: 850, left: 1080, right: 1220, width: 140, height: 30, x: 1080, y: 820, toJSON: () => ({}) }) as DOMRect

        composerContainer.appendChild(rightAnchor)
        workspace.appendChild(composerContainer)
        document.body.appendChild(workspace)

        try {
            render(
                <Gemini4PeriodicTablePicker
                    models={gemini4Models}
                    currentModelId="gemini-4-hydrogen-xhigh"
                    currentReasoningLevel="xhigh"
                    anchorElement={rightAnchor}
                    onSelect={vi.fn()}
                    onClose={vi.fn()}
                />,
            )

            const dialog = screen.getByRole('dialog', { name: /Model periodic table/i })
            const portal = dialog.closest('[data-model-menu-portal]') as HTMLElement
            // Workspace center = 260 + 1180/2 = 850 -> 850 - 760/2 = 470px
            expect(portal.style.left).toBe('470px')

            // Simulate opening right SubAgentPanel (workspace narrows from 1180 to 820)
            workspaceWidth = 820
            act(() => {
                for (const cb of observerCallbacks) {
                    cb([], {} as ResizeObserver)
                }
            })
            expect(portal.style.left).toBe('290px')
        } finally {
            workspace.remove()
            ;(globalThis as any).ResizeObserver = OriginalResizeObserver
            Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
            Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
        }
    })
})
