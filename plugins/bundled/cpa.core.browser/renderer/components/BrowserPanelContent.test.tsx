import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BrowserPanelContent, normalizeBrowserUrl } from './BrowserPanelContent.js'

describe('BrowserPanelContent', () => {
    it('normalizes URLs properly', () => {
        expect(normalizeBrowserUrl('')).toBe('http://localhost:3000')
        expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173')
        expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com')
        expect(normalizeBrowserUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    })

    it('renders navigation bar, url input, and iframe', () => {
        render(<BrowserPanelContent url="https://example.com" />)

        expect(screen.getByTestId('right-sidebar-browser-view')).toBeInTheDocument()
        expect(screen.getByTestId('browser-back-btn')).toBeInTheDocument()
        expect(screen.getByTestId('browser-forward-btn')).toBeInTheDocument()
        expect(screen.getByTestId('browser-reload-btn')).toBeInTheDocument()

        const input = screen.getByDisplayValue('https://example.com')
        expect(input).toBeInTheDocument()

        const iframe = screen.getByTitle('Browser View')
        expect(iframe).toHaveAttribute('src', 'https://example.com')
    })

    it('navigates to new URL on form submit', () => {
        render(<BrowserPanelContent url="http://localhost:3000" />)

        const input = screen.getByDisplayValue('http://localhost:3000')
        fireEvent.change(input, { target: { value: 'localhost:8080' } })
        fireEvent.submit(input.closest('form')!)

        const iframe = screen.getByTitle('Browser View')
        expect(iframe).toHaveAttribute('src', 'http://localhost:8080')
    })

    it('navigates history back and forward', () => {
        render(<BrowserPanelContent url="http://localhost:3000" />)

        const input = screen.getByDisplayValue('http://localhost:3000')
        const backBtn = screen.getByTestId('browser-back-btn')
        const forwardBtn = screen.getByTestId('browser-forward-btn')

        expect(backBtn).toBeDisabled()
        expect(forwardBtn).toBeDisabled()

        // Navigate to second page
        fireEvent.change(input, { target: { value: 'http://localhost:4000' } })
        fireEvent.submit(input.closest('form')!)

        expect(backBtn).not.toBeDisabled()
        expect(forwardBtn).toBeDisabled()

        // Go back
        fireEvent.click(backBtn)
        const iframe = screen.getByTitle('Browser View')
        expect(iframe).toHaveAttribute('src', 'http://localhost:3000')
        expect(forwardBtn).not.toBeDisabled()

        // Go forward
        fireEvent.click(forwardBtn)
        expect(iframe).toHaveAttribute('src', 'http://localhost:4000')
    })

    it('listens to external event bus events for reload, back, and forward', () => {
        const listeners: Record<string, () => void> = {}
        const events = {
            on: vi.fn((event: string, handler: () => void) => {
                listeners[event] = handler
                return () => {
                    delete listeners[event]
                }
            }),
        }

        render(<BrowserPanelContent url="http://localhost:3000" events={events} />)

        expect(events.on).toHaveBeenCalledWith('browser:reload', expect.any(Function))
        expect(events.on).toHaveBeenCalledWith('browser:force-reload', expect.any(Function))
        expect(events.on).toHaveBeenCalledWith('browser:back', expect.any(Function))
        expect(events.on).toHaveBeenCalledWith('browser:forward', expect.any(Function))
    })
})
