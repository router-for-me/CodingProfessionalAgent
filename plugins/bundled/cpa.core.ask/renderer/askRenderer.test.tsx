import i18n from '@/i18n'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PluginEventBus } from '@cpa/plugin-kernel'
import { askRendererEntry } from './index.js'
import { AskOverlay } from './AskOverlay.js'
import {
    useAskStore,
    defaultAskController,
    __resetAskStoreForTests,
} from '../shared/askStore.js'
import type { AskRequest } from '../shared/types.js'
import manifest from '../manifest.json'

describe('cpa.core.ask renderer entry and AskOverlay', () => {
    const testSessionId = 'session-test-123'
    let eventBus: PluginEventBus

    beforeEach(async () => {
        await i18n.changeLanguage('en')
        __resetAskStoreForTests()
        eventBus = new PluginEventBus()
    })

    const sampleRequest: AskRequest = {
        id: 'ask-req-1',
        toolCallId: 'tool-call-1',
        sessionId: testSessionId,
        question: '8 × (5 + 3) - 12 ÷ 4 = ?',
        options: [
            { title: '61', description: 'Calculate parentheses first, then multiply/divide, finally subtract.' },
            { title: '52', description: 'Calculated 8 * 5 + 3 from left to right.' },
            { title: '50', description: 'Subtracted before dividing by 4.' },
        ],
        allowCustom: true,
        customPrompt: 'No, and tell CPA what to do differently',
        allowSkip: true,
        createdAt: Date.now(),
    }

    it('has valid manifest and registers floating overlay', async () => {
        const registeredFloatings: any[] = []
        const context: any = {
            manifest,
            generation: 1,
            capabilities: new Set(['ui.overlay']),
            events: eventBus,
            register: vi.fn((reg) => {
                if (reg.kind === 'floating') {
                    registeredFloatings.push(reg.value)
                }
                return () => {}
            }),
            getService: vi.fn(),
        }

        await askRendererEntry.activate(context)

        expect(registeredFloatings).toHaveLength(1)
        expect(registeredFloatings[0].id).toBe('ask-overlay')
        expect(registeredFloatings[0].pluginId).toBe('cpa.core.ask')
        expect(registeredFloatings[0].anchor).toBe('[data-element="composer-container"]')
        expect(registeredFloatings[0].placement).toBe('cover-bottom')
        expect(registeredFloatings[0].offset).toEqual({ y: 0 })
        expect(registeredFloatings[0].visible({ sessionId: testSessionId })).toBe(false)

        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        expect(registeredFloatings[0].visible({ sessionId: testSessionId })).toBe(true)
    })

    it('renders nothing when there is no active request for the session', () => {
        const { container } = render(<AskOverlay sessionId={testSessionId} />)
        expect(container.firstChild).toBeNull()
    })

    it('renders question and options when request is present', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)

        render(<AskOverlay sessionId={testSessionId} />)

        expect(screen.getByTestId('ask-question-text')).toHaveTextContent(
            '8 × (5 + 3) - 12 ÷ 4 = ?'
        )
        expect(screen.getByTestId('ask-option-1')).toHaveTextContent('61')
        expect(screen.getByTestId('ask-option-1')).toHaveTextContent('Calculate parentheses first, then multiply/divide, finally subtract.')
        expect(screen.getByTestId('ask-option-2')).toHaveTextContent('52')
        expect(screen.getByTestId('ask-option-3')).toHaveTextContent('50')

        expect(screen.getByTestId('ask-custom-inactive-row')).toHaveTextContent(
            'No, and tell CPA what to do differently'
        )
        expect(screen.getByTestId('ask-inactive-skip-button')).toHaveTextContent('Skip')
    })

    it('submits answer when an option is clicked', async () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const submitSpy = vi.spyOn(defaultAskController, 'submitAnswer')

        render(<AskOverlay sessionId={testSessionId} />)

        const option1 = screen.getByTestId('ask-option-1')
        fireEvent.click(option1)

        expect(submitSpy).toHaveBeenCalledWith(
            testSessionId,
            'tool-call-1',
            expect.objectContaining({
                type: 'selected',
                option: { title: '61', description: 'Calculate parentheses first, then multiply/divide, finally subtract.' },
                index: 0,
            })
        )
    })

    it('switches to active input mode when clicking custom prompt row', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)

        render(<AskOverlay sessionId={testSessionId} />)

        const inactiveRow = screen.getByTestId('ask-custom-inactive-row')
        fireEvent.click(inactiveRow)

        expect(screen.getByTestId('ask-custom-active-container')).toBeInTheDocument()
        const input = screen.getByTestId('ask-custom-input')
        expect(input).toBeInTheDocument()
    })

    it('submits custom answer when entering text and pressing enter or form submit', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const submitSpy = vi.spyOn(defaultAskController, 'submitAnswer')

        render(<AskOverlay sessionId={testSessionId} />)

        fireEvent.click(screen.getByTestId('ask-custom-inactive-row'))
        const input = screen.getByTestId('ask-custom-input')

        fireEvent.change(input, { target: { value: 'My custom answer here' } })
        fireEvent.submit(screen.getByTestId('ask-custom-active-container'))

        expect(submitSpy).toHaveBeenCalledWith(
            testSessionId,
            'tool-call-1',
            expect.objectContaining({
                type: 'custom',
                text: 'My custom answer here',
            })
        )
    })

    it('submits skipped answer when clicking skip button in inactive mode', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const submitSpy = vi.spyOn(defaultAskController, 'submitAnswer')

        render(<AskOverlay sessionId={testSessionId} />)

        const skipBtn = screen.getByTestId('ask-inactive-skip-button')
        fireEvent.click(skipBtn)

        expect(submitSpy).toHaveBeenCalledWith(
            testSessionId,
            'tool-call-1',
            expect.objectContaining({
                type: 'skipped',
            })
        )
    })

    it('submits skipped answer when clicking skip button in active custom mode', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const submitSpy = vi.spyOn(defaultAskController, 'submitAnswer')

        render(<AskOverlay sessionId={testSessionId} />)

        fireEvent.click(screen.getByTestId('ask-custom-inactive-row'))
        const skipBtn = screen.getByTestId('ask-custom-skip-button')
        fireEvent.click(skipBtn)

        expect(submitSpy).toHaveBeenCalledWith(
            testSessionId,
            'tool-call-1',
            expect.objectContaining({
                type: 'skipped',
            })
        )
    })

    it('cancels answer when close button is clicked', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const cancelSpy = vi.spyOn(defaultAskController, 'cancel')

        render(<AskOverlay sessionId={testSessionId} />)

        const closeBtn = screen.getByTestId('ask-close-button')
        fireEvent.click(closeBtn)

        expect(cancelSpy).toHaveBeenCalledWith(testSessionId, 'tool-call-1')
    })

    it('selects option via keyboard number shortcuts (1-9)', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const submitSpy = vi.spyOn(defaultAskController, 'submitAnswer')

        render(<AskOverlay sessionId={testSessionId} />)

        fireEvent.keyDown(window, { key: '2' })

        expect(submitSpy).toHaveBeenCalledWith(
            testSessionId,
            'tool-call-1',
            expect.objectContaining({
                type: 'selected',
                option: { title: '52', description: 'Calculated 8 * 5 + 3 from left to right.' },
                index: 1,
            })
        )
    })

    it('cancels via Escape shortcut when in inactive mode', () => {
        useAskStore.getState().setRequest(testSessionId, sampleRequest)
        const cancelSpy = vi.spyOn(defaultAskController, 'cancel')

        render(<AskOverlay sessionId={testSessionId} />)

        fireEvent.keyDown(window, { key: 'Escape' })

        expect(cancelSpy).toHaveBeenCalledWith(testSessionId, 'tool-call-1')
    })
})
